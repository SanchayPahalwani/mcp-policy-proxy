import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import type { PolicyGateDeps } from '../src/proxy/policy-gate.js';

// Records what the config hands the gate; the gate itself still runs.
const gateDeps: PolicyGateDeps[] = [];
vi.mock('../src/proxy/policy-gate.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/proxy/policy-gate.js')>();
  return {
    ...real,
    policyGate: (deps: PolicyGateDeps) => {
      gateDeps.push(deps);
      return real.policyGate(deps);
    },
  };
});

const { loadConfig } = await import('../src/config/schema.js');
const { startFromConfig } = await import('../src/config/start.js');

const POLICY = fileURLToPath(new URL('../examples/policy.yaml', import.meta.url));
const STDIO_UPSTREAM = {
  transport: 'stdio',
  command: process.execPath,
  args: ['--import', 'tsx', fileURLToPath(new URL('./helpers/stdio-server.ts', import.meta.url))],
  cwd: fileURLToPath(new URL('..', import.meta.url)),
};
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  gateDeps.length = 0;
});

async function timeoutFor(approval: Record<string, unknown> | undefined): Promise<unknown> {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-policy-timeout-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'proxy.config.yaml');
  writeFileSync(
    path,
    stringify({
      listen: { transport: 'http', port: 0 },
      identities: [
        { name: 'writer', token_env: 'WRITER_TOKEN' },
        { name: 'release-manager', token_env: 'RELEASE_MANAGER_TOKEN' },
      ],
      upstreams: { docs: STDIO_UPSTREAM },
      policy: POLICY,
      audit: { path: './audit.jsonl' },
      ...(approval && { approval }),
    }),
  );
  const running = await startFromConfig(loadConfig(path), {
    env: { WRITER_TOKEN: 'a', RELEASE_MANAGER_TOKEN: 'b' },
    log: () => {},
  });
  cleanups.push(() => running.close());
  expect(gateDeps).toHaveLength(1);
  return gateDeps[0]!.approvalTimeoutMs;
}

describe('approval timeout', () => {
  it('reaches the gate as 55 s by default', async () => {
    expect(await timeoutFor(undefined)).toBe(55_000);
    gateDeps.length = 0;
    expect(await timeoutFor({ type: 'deny' })).toBe(55_000);
  });

  it('follows timeout_seconds', async () => {
    expect(await timeoutFor({ type: 'deny', timeout_seconds: 7 })).toBe(7_000);
  });
});
