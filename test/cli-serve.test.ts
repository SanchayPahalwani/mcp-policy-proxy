import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { main } from '../src/cli.js';
import { loadConfig, startFromConfig } from '../src/config.js';
import { call, connectAgent, textOf } from './helpers/proxy-client.js';

const EXAMPLES = fileURLToPath(new URL('../examples/', import.meta.url));
const ENV = { WRITER_TOKEN: 'tok-writer', RELEASE_MANAGER_TOKEN: 'tok-release' };

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Command lines of this process's descendants that run an eval mock server. */
function mockServers(): string[] {
  const rows = execFileSync('ps', ['-A', '-ww', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((m) => m !== null)
    .map(([, pid, ppid, command]) => ({ pid: Number(pid), ppid: Number(ppid), command: command! }));
  const mine = new Set([process.pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) {
      if (mine.has(row.ppid) && !mine.has(row.pid)) {
        mine.add(row.pid);
        grew = true;
      }
    }
  }
  return rows
    .filter((r) => mine.has(r.pid) && r.command.includes('eval/servers/stdio.ts'))
    .map((r) => r.command);
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function sink(): { stream: Writable; text: () => string } {
  let text = '';
  const stream = new Writable({
    write(chunk, _encoding, done) {
      text += String(chunk);
      done();
    },
  });
  return { stream, text: () => text };
}

describe('serve', () => {
  it('serves the mock servers from a copy of the example config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-policy-serve-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const example = parse(readFileSync(join(EXAMPLES, 'proxy.config.yaml'), 'utf8'));
    example.listen.port = 0;
    example.approval = { type: 'deny' };
    example.policy = join(EXAMPLES, 'policy.yaml');
    for (const upstream of Object.values<{ cwd?: string }>(example.upstreams)) {
      upstream.cwd = EXAMPLES;
    }
    const file = join(dir, 'proxy.config.yaml');
    writeFileSync(file, stringify(example));

    const running = await startFromConfig(loadConfig(file), { env: ENV, log: () => {} });
    let closed = false;
    cleanups.push(() => (closed ? undefined : running.close()));

    const proxy = { url: running.url!, port: 0, close: async () => {} };
    const client = await connectAgent(proxy, 'tok-writer', 's1');
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain('docs__create_draft');
      expect(tools.map((t) => t.name)).not.toContain('docs__publish');
      expect(tools.map((t) => t.name)).toEqual(
        expect.arrayContaining(['web__fetch_page', 'mail__send']),
      );
      const created = await call(client, 'docs__create_draft', { title: 'Notes', body: 'hello' });
      expect(textOf(created)).toBe('Created draft d1');
      const page = await call(client, 'web__fetch_page', {
        url: 'https://docs.example.test/release-notes',
      });
      expect(textOf(page)).toContain('Release notes');
      // The answers came from the docs, web and mail servers this process started.
      for (const name of ['docs', 'web', 'mail']) {
        expect(mockServers().some((c) => c.endsWith(`eval/servers/stdio.ts ${name}`))).toBe(true);
      }
    } finally {
      await client.close();
    }

    const events = readFileSync(join(dir, 'audit.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string });
    expect(events.map((e) => e.type)).toEqual([
      'list',
      'decision',
      'outcome',
      'decision',
      'outcome',
    ]);
    expect(events[1]).toMatchObject({ tool: 'create_draft', effect: 'allow', forwarded: true });

    await running.close();
    closed = true;
    await until(() => mockServers().length === 0);
  });
});

describe('main', () => {
  it.each([[['nope']], [[]], [['serve']], [['serve', '--config']], [['serve', '--port', '1']]])(
    'prints usage and returns 2 for %j',
    async (argv) => {
      const stdout = sink();
      const stderr = sink();
      expect(await main(argv, { stdout: stdout.stream, stderr: stderr.stream })).toBe(2);
      expect(stderr.text()).toContain('usage: mcp-policy-proxy serve --config <file>');
      expect(stdout.text()).toBe('');
    },
  );

  it('returns 1 with the reason when the config cannot be loaded', async () => {
    const stderr = sink();
    const code = await main(['serve', '--config', join(tmpdir(), 'no-such-config.yaml')], {
      stdout: sink().stream,
      stderr: stderr.stream,
    });
    expect(code).toBe(1);
    expect(stderr.text()).toContain('no-such-config.yaml');
  });
});
