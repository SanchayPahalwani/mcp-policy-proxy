import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { PAGES } from '../eval/servers/pages.js';
import { createWorld } from '../eval/world.js';
import { fixedApprover } from '../src/approval/types.js';
import {
  fileAuditSink,
  type AuditEvent,
  type DecisionEvent,
  type OutcomeEvent,
} from '../src/audit/log.js';
import { main as cli } from '../src/cli.js';
import { loadPolicy } from '../src/policy/load.js';
import { sha256Hex, staticTokenAuthenticator } from '../src/proxy/auth.js';
import { startHttpProxy } from '../src/proxy/http.js';
import { policyGate } from '../src/proxy/policy-gate.js';
import { Upstreams } from '../src/proxy/upstreams.js';

// The proxy, the mock servers and the approver all run in this process, so the demo needs no
// environment variables, no child processes and no network beyond 127.0.0.1.

const REPO = fileURLToPath(new URL('../', import.meta.url));
const POLICY = join(REPO, 'examples', 'policy.yaml');
const VIOLATION = join(REPO, 'examples', 'sessions', 'violation.jsonl');
const TEAM = 'team@example.test';

const textOf = (result: CallToolResult): string =>
  result.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join(' ');

async function connectAs(url: string, token: string, session: string): Promise<Client> {
  const client = new Client(
    { name: 'demo-agent', version: '0.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  const headers = { authorization: `Bearer ${token}`, 'x-agent-session': session };
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }),
  );
  return client;
}

/** A tool result as text, or the protocol error a hidden or unknown tool answers with. */
async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  try {
    return textOf((await client.callTool({ name, arguments: args })) as CallToolResult);
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    return `protocol error${typeof code === 'number' ? ` ${code}` : ''}: ${(e as Error).message}`;
  }
}

/** Runs one CLI command the way a shell would, with output captured instead of printed. */
async function runCli(argv: string[]): Promise<{ code: number; output: string }> {
  let output = '';
  const sink = () =>
    new Writable({
      write(chunk, _encoding, done) {
        output += String(chunk);
        done();
      },
    });
  const code = await cli(argv, { stdout: sink(), stderr: sink(), env: {} });
  return { code, output };
}

function readAudit(path: string): AuditEvent[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as AuditEvent);
}

export async function runDemo(out: (line: string) => void): Promise<void> {
  const say = (...lines: string[]) => lines.forEach((line) => out(line));
  const heading = (n: number, title: string) => say('', `${n}. ${title}`);
  const indent = (text: string) => text.split('\n').map((line) => `   ${line}`);

  const dir = mkdtempSync(join(tmpdir(), 'mcp-policy-demo-'));
  const auditPath = join(dir, 'audit.jsonl');
  const closers: Array<() => Promise<void> | void> = [() => rmSync(dir, { recursive: true })];
  try {
    const audit = fileAuditSink(auditPath);
    closers.push(() => audit.close());
    const world = createWorld(Date.now, { drafts: [], pages: PAGES });
    const upstreams = await Upstreams.connect(world.upstreams());
    closers.push(() => upstreams.close());

    // Fresh for every run and never printed: only their digests reach the authenticator.
    const tokens = {
      writer: randomBytes(24).toString('base64url'),
      release: randomBytes(24).toString('base64url'),
    };
    const approver = fixedApprover(({ identity, server, tool, args, rule }) => {
      say(
        `   approver: approved ${identity} ${server}.${tool} ${JSON.stringify(args)} (rule ${rule})`,
      );
      return { approved: true, approver: 'demo-script' };
    });
    const proxy = await startHttpProxy({
      upstreams,
      gate: policyGate({ policy: loadPolicy(POLICY), audit, approver }),
      authenticator: staticTokenAuthenticator([
        { name: 'writer', token_sha256: sha256Hex(tokens.writer) },
        { name: 'release-manager', token_sha256: sha256Hex(tokens.release) },
      ]),
      host: '127.0.0.1',
      port: 0,
    });
    closers.push(() => proxy.close());

    const writer = await connectAs(proxy.url, tokens.writer, 'demo-writer');
    closers.push(() => writer.close());
    const release = await connectAs(proxy.url, tokens.release, 'demo-release');
    closers.push(() => release.close());

    say(
      'MCP policy proxy demo',
      `Proxy at ${proxy.url} with examples/policy.yaml; docs, web and mail run in process.`,
      'The audit log goes to a temporary directory, removed when the demo ends.',
    );
    const show = (label: string, text: string) => say(`   ${label} -> ${text}`);
    const mail = (to: string, subject: string) =>
      callTool(writer, 'mail__send', { to, subject, body: 'Draft d1 is ready.' });

    heading(1, 'Tools each identity is shown (tools/list is filtered by the policy)');
    for (const [name, client] of [
      ['writer', writer],
      ['release-manager', release],
    ] as const) {
      const names = (await client.listTools()).tools.map((t) => t.name).sort();
      say(`   ${`${name}:`.padEnd(17)}${names.join(', ')}`);
    }

    heading(2, 'writer creates a draft');
    const draft = { title: 'Release notes', body: 'Sync is faster.' };
    show('docs__create_draft', await callTool(writer, 'docs__create_draft', draft));

    heading(3, 'writer calls docs__publish, which a deny rule hides from it');
    show('docs__publish', await callTool(writer, 'docs__publish', { id: 'd1' }));

    heading(4, 'writer mails an address outside the team');
    show('mail__send to someone@outside.test', await mail('someone@outside.test', 'Notes'));

    heading(5, 'writer mails the team three times (the rule allows 2 per session)');
    for (let i = 1; i <= 3; i++) show(`mail ${i}`, await mail(TEAM, `Update ${i}`));

    heading(6, 'release-manager publishes d1 (the rule requires approval)');
    show('docs__publish', await callTool(release, 'docs__publish', { id: 'd1' }));

    heading(7, 'The audit lines for steps 3 and 6 (a decision is on disk before any forward)');
    const events = readAudit(auditPath);
    const decisions = events.filter((e): e is DecisionEvent => e.type === 'decision');
    const publishBy = (identity: string) =>
      decisions.find((e) => e.tool === 'publish' && e.identity === identity);
    const approved = publishBy('release-manager');
    const outcome = events.find(
      (e): e is OutcomeEvent => e.type === 'outcome' && e.call_id === approved?.call_id,
    );
    for (const [label, event] of [
      ['step 3, decision', publishBy('writer')],
      ['step 6, decision', approved],
      ['step 6, outcome', outcome],
    ] as const) {
      if (event) say(`   ${label}:`, ...indent(JSON.stringify(event, null, 2)));
    }

    heading(8, 'The offline checker runs the same engine over recorded calls');
    for (const [label, file] of [
      ['<the demo audit log>', auditPath],
      ['examples/sessions/violation.jsonl', VIOLATION],
    ] as const) {
      const { code, output } = await runCli(['check', '--policy', POLICY, file]);
      say(`   $ mcp-policy-proxy check --policy examples/policy.yaml ${label}`);
      say(...indent(output.replaceAll(REPO, '').trimEnd()), `   exit code ${code}`);
    }
  } finally {
    for (const close of closers.reverse()) await close();
  }
}

function isEntryPoint(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(script)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  try {
    await runDemo((line) => process.stdout.write(`${line}\n`));
  } catch (e) {
    process.stderr.write(`demo failed: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  }
}
