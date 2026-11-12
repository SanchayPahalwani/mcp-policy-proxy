import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { Client, type JSONRPCMessage, type Transport } from '@modelcontextprotocol/client';
import { descendants, until } from './helpers/processes.js';
import { textOf } from './helpers/proxy-client.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'src', 'cli.ts');
const MOCK = join(ROOT, 'eval', 'servers', 'stdio.ts');

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * Speaks MCP over a child's stdin and stdout, and keeps every stdout line it saw, so the test can
 * check that nothing but JSON-RPC was written there.
 */
class ChildTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  readonly stdout: string[] = [];

  constructor(private readonly child: ChildProcessWithoutNullStreams) {}

  async start(): Promise<void> {
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', (line) => {
      this.stdout.push(line);
      try {
        this.onmessage?.(JSON.parse(line) as JSONRPCMessage);
      } catch (e) {
        this.onerror?.(e as Error);
      }
    });
    lines.on('close', () => this.onclose?.());
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async close(): Promise<void> {
    this.child.stdin.end();
  }
}

describe('serve over stdio, as a real process', () => {
  it('writes only JSON-RPC to stdout and exits 0 when stdin closes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-policy-stdio-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const audit = join(dir, 'audit.jsonl');
    const config = join(dir, 'proxy.config.yaml');
    writeFileSync(
      config,
      stringify({
        listen: { transport: 'stdio' },
        // The example policy names both identities and all three servers; lint needs them all.
        identities: [
          { name: 'writer', token_sha256: 'a'.repeat(64) },
          { name: 'release-manager', token_sha256: 'b'.repeat(64) },
        ],
        stdio_identity: 'writer',
        upstreams: Object.fromEntries(
          ['docs', 'web', 'mail'].map((name) => [
            name,
            {
              transport: 'stdio',
              command: process.execPath,
              args: ['--import', 'tsx', MOCK, name],
              cwd: ROOT,
            },
          ]),
        ),
        policy: join(ROOT, 'examples', 'policy.yaml'),
        audit: { path: audit },
        approval: { type: 'deny' },
      }),
    );

    const env = { ...process.env };
    delete env['ANTHROPIC_API_KEY'];
    delete env['ANTHROPIC_AUTH_TOKEN'];
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, 'serve', '--config', config], {
      cwd: ROOT,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
    cleanups.push(() => {
      if (child.exitCode === null) child.kill();
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => (stderr += chunk));

    const transport = new ChildTransport(child);
    const errors: Error[] = [];
    transport.onerror = (e) => void errors.push(e);
    const client = new Client(
      { name: 'test-agent', version: '0.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('mail__send');
    expect(tools.map((t) => t.name)).not.toContain('docs__publish');
    const sent = await client.callTool({
      name: 'mail__send',
      arguments: { to: 'team@example.test', subject: 's', body: 'b' },
    });
    expect(textOf(sent as Parameters<typeof textOf>[0])).toBe('Sent to team@example.test');

    await transport.close();
    expect(await exited).toBe(0);
    await until(() => descendants(MOCK).length === 0);

    expect(errors).toEqual([]);
    expect(transport.stdout.length).toBeGreaterThan(0);
    for (const line of transport.stdout) {
      expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });
    }
    // What the operator reads goes to stderr instead.
    expect(stderr).toContain('serving over stdio');
    const decisions = readFileSync(audit, 'utf8')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as { type: string; session?: string });
    expect(decisions.filter((e) => e.type === 'decision')).toEqual([
      expect.objectContaining({ session: 'stdio', tool: 'send', forwarded: true }),
    ]);
  }, 30_000);
});
