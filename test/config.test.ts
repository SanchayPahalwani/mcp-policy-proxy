import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { loadConfig, type ProxyConfig } from '../src/config/schema.js';
import { startFromConfig } from '../src/config/start.js';
import { PolicyError } from '../src/policy/load.js';

const EXAMPLES = fileURLToPath(new URL('../examples/', import.meta.url)).replace(/\/$/, '');
const EXAMPLE = join(EXAMPLES, 'proxy.config.yaml');
const POLICY = join(EXAMPLES, 'policy.yaml');
const ENV = { WRITER_TOKEN: 'a', RELEASE_MANAGER_TOKEN: 'b' };

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-policy-config-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const BASE = {
  listen: { transport: 'http', port: 0 },
  identities: [{ name: 'writer', token_env: 'WRITER_TOKEN' }],
  upstreams: { docs: { transport: 'http', url: 'http://127.0.0.1:1/mcp' } },
  policy: POLICY,
  audit: { path: './audit.jsonl' },
  approval: { type: 'deny' },
};

/** Writes `BASE` with `change` applied to a temp file and returns its path. */
function configFile(change: (config: Record<string, any>) => void = () => {}): string {
  const config = structuredClone(BASE) as Record<string, any>;
  change(config);
  const path = join(tempDir(), 'proxy.config.yaml');
  writeFileSync(path, stringify(config));
  return path;
}

function loadError(path: string): PolicyError {
  try {
    loadConfig(path);
  } catch (e) {
    expect(e).toBeInstanceOf(PolicyError);
    return e as PolicyError;
  }
  throw new Error('loadConfig did not throw');
}

async function startError(config: ProxyConfig, env: NodeJS.ProcessEnv): Promise<PolicyError> {
  const error = await startFromConfig(config, { env, log: () => {} }).then(
    async (running) => {
      await running.close();
      throw new Error('startFromConfig did not throw');
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PolicyError);
  return error as PolicyError;
}

describe('loadConfig', () => {
  it('loads the example and resolves its paths against the examples directory', () => {
    const config = loadConfig(EXAMPLE);
    expect(config.dir).toBe(EXAMPLES);
    expect(config.policy).toBe(POLICY);
    expect(config.audit.path).toBe(join(EXAMPLES, 'audit.jsonl'));
    expect(config.listen).toMatchObject({ transport: 'http', host: '127.0.0.1', port: 8787 });
    expect(config.approval).toEqual({ type: 'cli', timeout_seconds: 55 });
    expect(config.upstreams['docs']).toMatchObject({
      transport: 'stdio',
      command: 'npx',
      args: ['tsx', '../eval/servers/stdio.ts', 'docs'],
      cwd: EXAMPLES,
    });
    for (const name of ['web', 'mail']) {
      expect(config.upstreams[name]).toMatchObject({
        transport: 'stdio',
        args: ['tsx', '../eval/servers/stdio.ts', name],
        cwd: EXAMPLES,
      });
    }
  });

  it('resolves a relative upstream cwd against the config directory', () => {
    const path = configFile((c) => {
      c['upstreams'] = { docs: { transport: 'stdio', command: 'node', cwd: 'servers' } };
    });
    expect(loadConfig(path).upstreams['docs']).toMatchObject({
      cwd: join(dirname(path), 'servers'),
    });
  });

  it('rejects unknown keys at the top level and inside sections', () => {
    expect(loadError(configFile((c) => (c['listn'] = {}))).issues.join('\n')).toContain('listn');
    expect(loadError(configFile((c) => (c['audit'].rotate = true))).issues.join('\n')).toContain(
      'rotate',
    );
    expect(
      loadError(
        configFile((c) => (c['upstreams'].docs.headers = { Authorization: 'x' })),
      ).issues.join('\n'),
    ).toContain('headers');
  });

  it('rejects the cli approver when the proxy speaks MCP over stdio', () => {
    const error = loadError(
      configFile((c) => {
        c['listen'] = { transport: 'stdio' };
        c['stdio_identity'] = 'writer';
        c['approval'] = { type: 'cli' };
      }),
    );
    expect(error.issues.join('\n')).toMatch(/cli approval .*stdio/);
  });

  it('requires stdio_identity for the stdio transport', () => {
    const error = loadError(configFile((c) => (c['listen'] = { transport: 'stdio' })));
    expect(error.issues.join('\n')).toContain('stdio_identity');
  });

  it('requires stdio_identity to name a configured identity', () => {
    const error = loadError(
      configFile((c) => {
        c['listen'] = { transport: 'stdio' };
        c['stdio_identity'] = 'editor';
      }),
    );
    expect(error.issues.join('\n')).toContain('"editor"');
  });

  it('rejects an upstream name that cannot be joined to a tool name', () => {
    const error = loadError(
      configFile((c) => (c['upstreams'] = { my_docs: { transport: 'http', url: 'http://x/' } })),
    );
    expect(error.issues.join('\n')).toContain('my_docs');
  });

  it('needs exactly one of token_sha256 and token_env per identity', () => {
    const both = loadError(configFile((c) => (c['identities'][0].token_sha256 = 'a'.repeat(64))));
    expect(both.issues.join('\n')).toContain('exactly one of token_sha256 or token_env');
    const neither = loadError(configFile((c) => (c['identities'] = [{ name: 'writer' }])));
    expect(neither.issues.join('\n')).toContain('exactly one of token_sha256 or token_env');
  });

  it('reports a file that is not YAML', () => {
    const path = join(tempDir(), 'broken.yaml');
    writeFileSync(path, 'listen: [');
    expect(loadError(path).message).toContain(path);
  });

  it('does not read the environment or the policy file', () => {
    const config = loadConfig(configFile((c) => (c['policy'] = './missing-policy.yaml')));
    expect(config.policy).toMatch(/missing-policy\.yaml$/);
  });
});

describe('startFromConfig', () => {
  it('starts the example, spawning the docs, web and mail servers over stdio', async () => {
    const config = loadConfig(EXAMPLE);
    if (config.listen.transport !== 'http') throw new Error('the example listens on HTTP');
    const audit = join(tempDir(), 'audit.jsonl');
    const lines: string[] = [];
    const running = await startFromConfig(
      { ...config, listen: { ...config.listen, port: 0 }, audit: { path: audit } },
      { env: ENV, log: (line) => lines.push(line) },
    );
    cleanups.push(() => running.close());
    expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    // Every server the example policy names is configured, so no rule is dead.
    expect(lines.filter((l) => l.includes('is not configured'))).toEqual([]);
  });

  it('names an unset or empty token variable without printing any token', async () => {
    const config = loadConfig(configFile());
    for (const env of [{}, { WRITER_TOKEN: '' }]) {
      const error = await startError(config, env);
      expect(error.message).toContain('WRITER_TOKEN');
    }
  });

  it('names an unset webhook secret variable', async () => {
    const config = loadConfig(
      configFile((c) => {
        c['approval'] = { type: 'webhook', url: 'http://127.0.0.1:1/', secret_env: 'HOOK_SECRET' };
      }),
    );
    const error = await startError(config, { WRITER_TOKEN: 'tok-a' });
    expect(error.message).toContain('HOOK_SECRET');
    expect(error.message).not.toContain('tok-a');
  });

  it('names an unset upstream header variable', async () => {
    const config = loadConfig(
      configFile((c) => (c['upstreams'].docs.headers_env = { Authorization: 'DOCS_AUTH' })),
    );
    const error = await startError(config, { WRITER_TOKEN: 'tok-a' });
    expect(error.message).toContain('DOCS_AUTH');
  });

  it('refuses a policy with lint errors and prints its warnings', async () => {
    const dir = tempDir();
    const policy = join(dir, 'policy.yaml');
    writeFileSync(
      policy,
      stringify({
        version: 1,
        rules: [
          { id: 'any-docs', identities: '*', server: 'docs', tools: ['*'], effect: 'allow' },
          {
            id: 'editor-docs',
            identities: ['editor'],
            server: 'docs',
            tools: ['*'],
            effect: 'allow',
          },
        ],
      }),
    );
    const config = loadConfig(configFile((c) => (c['policy'] = policy)));
    const lines: string[] = [];
    const error = await startFromConfig(config, {
      env: { WRITER_TOKEN: 'tok-a' },
      log: (line) => lines.push(line),
    }).then(
      () => undefined,
      (e: unknown) => e as PolicyError,
    );
    expect(error).toBeInstanceOf(PolicyError);
    expect(error?.issues).toEqual([
      'rule "editor-docs": identity "editor" is not in the configuration',
    ]);
    expect(lines).toContain(
      'warning: rule "any-docs": permits any identity with no argument constraints',
    );
  });

  it('reports a policy file that does not parse', async () => {
    const dir = tempDir();
    const policy = join(dir, 'policy.yaml');
    writeFileSync(policy, 'version: 2\nrules: []\n');
    const config = loadConfig(configFile((c) => (c['policy'] = policy)));
    const error = await startError(config, { WRITER_TOKEN: 'tok-a' });
    expect(error.message).toContain(policy);
  });
});
