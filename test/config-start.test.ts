import { createServer, type Server as HttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { Client } from '@modelcontextprotocol/client';
import { createMcpHandler, InMemoryTransport } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { SIGNATURE_HEADER, sign } from '../src/approval/webhook.js';
import { loadConfig, type ProxyConfig } from '../src/config/schema.js';
import { startFromConfig, type RunningFromConfig } from '../src/config/start.js';
import { PolicyError } from '../src/policy/load.js';
import { httpUpstream, mockServer } from './helpers/mock-upstream.js';
import { descendants, until } from './helpers/processes.js';
import { call, connectAgent, textOf } from './helpers/proxy-client.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENV_SERVER = fileURLToPath(new URL('./helpers/env-server.ts', import.meta.url));
const envServers = () => descendants('helpers/env-server.ts');

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-policy-start-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const POLICY = {
  version: 1,
  rules: [
    { id: 'env-tools', identities: ['writer'], server: 'env', tools: ['has_env'], effect: 'allow' },
    { id: 'hdr-tools', identities: ['writer'], server: 'hdr', tools: ['*'], effect: 'allow' },
    {
      id: 'std-approval',
      identities: ['writer'],
      server: 'std',
      tools: ['echo'],
      effect: 'require_approval',
    },
  ],
};

const ENV_UPSTREAM = {
  transport: 'stdio',
  command: process.execPath,
  args: ['--import', 'tsx', ENV_SERVER],
  cwd: ROOT,
};
const MISSING_UPSTREAM = { transport: 'stdio', command: 'mcp-policy-no-such-command' };

/** Writes a config (and the shared policy) to a temp dir and loads it. */
function config(change: (c: Record<string, any>) => void = () => {}): ProxyConfig {
  const dir = tempDir();
  writeFileSync(join(dir, 'policy.yaml'), stringify(POLICY));
  const c: Record<string, any> = {
    listen: { transport: 'http', port: 0 },
    identities: [{ name: 'writer', token_env: 'WRITER_TOKEN' }],
    upstreams: { env: ENV_UPSTREAM },
    policy: './policy.yaml',
    audit: { path: './audit.jsonl' },
    approval: { type: 'deny' },
  };
  change(c);
  const path = join(dir, 'proxy.config.yaml');
  writeFileSync(path, stringify(c));
  return loadConfig(path);
}

async function start(
  cfg: ProxyConfig,
  env: NodeJS.ProcessEnv,
  lines: string[] = [],
): Promise<RunningFromConfig> {
  const running = await startFromConfig(cfg, { env, log: (l) => lines.push(l) });
  cleanups.push(() => running.close());
  return running;
}

/** Starts, expecting a PolicyError; a proxy that starts anyway is closed. */
async function refused(cfg: ProxyConfig, env: NodeJS.ProcessEnv, lines: string[] = []) {
  const outcome = await startFromConfig(cfg, { env, log: (l) => lines.push(l) }).then(
    async (running) => {
      await running.close();
      return undefined;
    },
    (e: unknown) => e,
  );
  expect(outcome).toBeInstanceOf(PolicyError);
  return outcome as PolicyError;
}

async function listen(server: HttpServer): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return (server.address() as AddressInfo).port;
}

describe('startFromConfig keeps secrets out of what it prints', () => {
  const WITH_FAILING_UPSTREAM = (c: Record<string, any>) => {
    c['upstreams'] = { env: ENV_UPSTREAM, missing: MISSING_UPSTREAM };
  };

  it.each([
    ['a valid value', 'Bearer HEADER-MARK'],
    ['an interior newline', 'Bearer HEADER-MARK\n-444'],
  ])('never prints an upstream header with %s', async (_label, value) => {
    const cfg = config((c) => {
      WITH_FAILING_UPSTREAM(c);
      c['upstreams'].hdr = {
        transport: 'http',
        url: 'http://127.0.0.1:1/mcp',
        headers_env: { Authorization: 'HDR_AUTH' },
      };
    });
    const lines: string[] = [];
    const error = await refused(cfg, { WRITER_TOKEN: 'tok', HDR_AUTH: value }, lines);
    for (const text of [error.message, ...lines]) expect(text).not.toContain('HEADER-MARK');
    if (value.includes('\n')) {
      expect(error.issues).toEqual([
        'upstream "hdr" header Authorization: environment variable HDR_AUTH holds a character that cannot be sent in a header',
      ]);
    }
  });

  it.each([
    ['a valid value', 'SECRET-MARK'],
    ['an interior newline', 'SECRET\n-MARK'],
  ])('never prints a webhook secret with %s', async (_label, value) => {
    const cfg = config((c) => {
      WITH_FAILING_UPSTREAM(c);
      c['approval'] = { type: 'webhook', url: 'http://127.0.0.1:1/', secret_env: 'HOOK' };
    });
    const lines: string[] = [];
    const error = await refused(cfg, { WRITER_TOKEN: 'tok', HOOK: value }, lines);
    for (const text of [error.message, ...lines]) expect(text).not.toMatch(/SECRET|MARK/);
  });

  it('never prints a token', async () => {
    const lines: string[] = [];
    const error = await refused(
      config(WITH_FAILING_UPSTREAM),
      { WRITER_TOKEN: 'TOKEN-MARK' },
      lines,
    );
    for (const text of [error.message, ...lines]) expect(text).not.toContain('TOKEN-MARK');
  });

  it('names an upstream that cannot start, with its error code, and leaves no child behind', async () => {
    const error = await refused(config(WITH_FAILING_UPSTREAM), { WRITER_TOKEN: 'tok' });
    expect(error.issues).toEqual(['could not connect to upstream "missing" (ENOENT)']);
    expect(error.cause).toBeDefined();
    await until(() => envServers().length === 0);
  });

  it('names an audit log that cannot be opened', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'file'), '');
    const audit = join(dir, 'file', 'audit.jsonl');
    const error = await refused(
      config((c) => (c['audit'] = { path: audit })),
      { WRITER_TOKEN: 'tok' },
    );
    // mkdir reports a file in the way as EEXIST on some systems and ENOTDIR on others.
    expect(error.issues).toHaveLength(1);
    expect(error.issues[0]).toMatch(
      /^could not open the audit log .*audit\.jsonl \((EEXIST|ENOTDIR)\)$/,
    );
    await until(() => envServers().length === 0);
  });

  it('names a port it cannot listen on, after closing the upstreams it started', async () => {
    const taken = createNetServer();
    await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => taken.close(() => resolve())));
    const { port } = taken.address() as AddressInfo;
    const error = await refused(
      config((c) => (c['listen'].port = port)),
      { WRITER_TOKEN: 'tok' },
    );
    expect(error.issues).toEqual([`could not listen on 127.0.0.1:${port} (EADDRINUSE)`]);
    await until(() => envServers().length === 0);
  });

  it.each([
    ['a non-ASCII letter', 'Bearer caf\u00e9-HEADER-MARK'],
    ['a line separator', 'Bearer HEADER-MARK\u2028x'],
    ['a DEL', 'Bearer HEADER-MARK\u007f'],
  ])('refuses an upstream header with %s, naming only the variable', async (_label, value) => {
    const cfg = config((c) => {
      c['upstreams'].hdr = {
        transport: 'http',
        url: 'http://127.0.0.1:1/mcp',
        headers_env: { Authorization: 'HDR_AUTH' },
      };
    });
    const lines: string[] = [];
    const error = await refused(cfg, { WRITER_TOKEN: 'tok', HDR_AUTH: value }, lines);
    expect(error.issues).toEqual([
      'upstream "hdr" header Authorization: environment variable HDR_AUTH holds a character that cannot be sent in a header',
    ]);
    for (const text of [error.message, ...lines]) expect(text).not.toContain('HEADER-MARK');
  });

  it('refuses two identities that share a token', async () => {
    const cfg = config((c) => {
      c['identities'].push({ name: 'editor', token_env: 'EDITOR_TOKEN' });
    });
    const error = await refused(cfg, { WRITER_TOKEN: 'same', EDITOR_TOKEN: 'same' });
    expect(error.issues).toEqual(['identities "writer" and "editor" share a token']);
    expect(error.message).not.toContain('same\n');
  });
});

describe('startFromConfig', () => {
  it('warns once when told to listen beyond loopback', async () => {
    const lines: string[] = [];
    await start(
      config(
        (c) =>
          (c['listen'] = { transport: 'http', port: 0, host: '0.0.0.0', allow_non_loopback: true }),
      ),
      { WRITER_TOKEN: 'tok' },
      lines,
    );
    expect(lines.filter((l) => l.includes('listening on'))).toEqual([
      'warning: listening on 0.0.0.0: bearer tokens travel in clear text and Host/Origin checks are off; terminate TLS in front of the proxy',
    ]);
  });

  it('refuses a non-loopback host in a config not made by loadConfig', async () => {
    const cfg = config();
    if (cfg.listen.transport !== 'http') throw new Error('the config listens on HTTP');
    const lines: string[] = [];
    const hand: ProxyConfig = {
      ...cfg,
      listen: { ...cfg.listen, host: '0.0.0.0', allow_non_loopback: false },
    };
    const error = await refused(hand, { WRITER_TOKEN: 'tok' }, lines);
    expect(error.issues).toEqual([
      'listen.host "0.0.0.0" is not a loopback address; set listen.allow_non_loopback: true to listen on it',
    ]);
    expect(lines).toEqual([]);
    await until(() => envServers().length === 0);
  });

  it('closes once, however often close() is called', async () => {
    const running = await start(config(), { WRITER_TOKEN: 'tok' });
    await running.close();
    await expect(running.close()).resolves.toBeUndefined();
    await expect(running.closed).resolves.toBeUndefined();
  });

  it('checks the stdio identity again for a config not made by loadConfig', async () => {
    const cfg = config();
    const hand: ProxyConfig = { ...cfg, listen: { transport: 'stdio' } };
    const error = await refused(hand, { WRITER_TOKEN: 'tok' });
    expect(error.message).toContain('stdio_identity');
  });

  it('stops on its own when the stdio client goes away', async () => {
    const cfg = config((c) => {
      c['listen'] = { transport: 'stdio' };
      c['stdio_identity'] = 'writer';
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const running = await startFromConfig(cfg, {
      env: {},
      log: () => {},
      stdioTransport: serverSide,
    });
    cleanups.push(() => running.close());
    const client = new Client(
      { name: 't', version: '0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await client.connect(clientSide);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['env__has_env']);
    await client.close();
    await running.closed;
    await until(() => envServers().length === 0);
  });

  it('hands pass_env variables, and only those, to a stdio upstream', async () => {
    vi.stubEnv('MCP_POLICY_NOT_PASSED', 'present in the proxy');
    const cfg = config((c) => (c['upstreams'].env.pass_env = ['MCP_POLICY_PASSED']));
    const running = await start(cfg, { WRITER_TOKEN: 'tok', MCP_POLICY_PASSED: 'value' });
    const client = await connectAgent({ url: running.url!, port: 0, close: async () => {} }, 'tok');
    cleanups.push(() => client.close());
    const has = async (name: string) => textOf(await call(client, 'env__has_env', { name }));
    expect(await has('MCP_POLICY_PASSED')).toBe('yes');
    expect(await has('MCP_POLICY_NOT_PASSED')).toBe('no');
  });

  it('refuses a pass_env variable that is not set', async () => {
    const cfg = config((c) => (c['upstreams'].env.pass_env = ['MCP_POLICY_PASSED']));
    const error = await refused(cfg, { WRITER_TOKEN: 'tok' });
    expect(error.issues).toEqual([
      'upstream "env" pass_env: environment variable MCP_POLICY_PASSED is not set',
    ]);
  });

  it('sends the configured header to an HTTP upstream', async () => {
    const seen: Array<string | undefined> = [];
    const handler = createMcpHandler(() => mockServer('hdr', [{ name: 'ping' }]));
    const node = toNodeHandler(handler);
    cleanups.push(() => handler.close());
    const port = await listen(
      createServer((req, res) => {
        seen.push(req.headers.authorization);
        void node(req, res);
      }),
    );
    const cfg = config((c) => {
      c['upstreams'] = {
        hdr: {
          transport: 'http',
          url: `http://127.0.0.1:${port}/mcp`,
          headers_env: { Authorization: 'HDR_AUTH' },
        },
      };
    });
    const running = await start(cfg, { WRITER_TOKEN: 'tok', HDR_AUTH: 'Bearer upstream-cred' });
    const client = await connectAgent({ url: running.url!, port: 0, close: async () => {} }, 'tok');
    cleanups.push(() => client.close());
    await call(client, 'hdr__ping', {});
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set(['Bearer upstream-cred']));
  });

  it('signs webhook approval requests with the configured secret', async () => {
    const verified: boolean[] = [];
    const port = await listen(
      createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => (body += String(chunk)));
        req.on('end', () => {
          const ok = req.headers[SIGNATURE_HEADER] === sign('hook-secret', body);
          verified.push(ok);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ approved: ok, approver: 'hook' }));
        });
      }),
    );
    const std = await httpUpstream('std', [{ name: 'echo' }]);
    cleanups.push(() => std.close());
    const url = (std.spec as { url: string }).url;
    const cfg = config((c) => {
      c['upstreams'] = { std: { transport: 'http', url } };
      c['approval'] = {
        type: 'webhook',
        url: `http://127.0.0.1:${port}/approve`,
        secret_env: 'HOOK',
      };
    });
    const running = await start(cfg, { WRITER_TOKEN: 'tok', HOOK: 'hook-secret' });
    const client = await connectAgent({ url: running.url!, port: 0, close: async () => {} }, 'tok');
    cleanups.push(() => client.close());
    const result = await call(client, 'std__echo', { x: 1 });
    expect(verified).toEqual([true]);
    expect(result.isError).not.toBe(true);
  });
});
