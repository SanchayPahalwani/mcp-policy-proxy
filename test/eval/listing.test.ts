import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/client';
import { Upstreams, type UpstreamSpec } from '../../src/proxy/upstreams.js';
import { scriptedModel } from '../../eval/agent/scripted.js';
import { HarnessError, runScenario } from '../../eval/run.js';
import { SCENARIOS } from '../../eval/suite/scenarios.js';

const T1 = SCENARIOS.find((s) => s.id === 't1+clean')!;

afterEach(() => {
  vi.restoreAllMocks();
});

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** The server side of the world server answers every `tools/list` with an internal error. */
function failingListing(transport: Transport): Transport {
  const send = transport.send.bind(transport);
  transport.send = async (message: JSONRPCMessage, options) => {
    if ('method' in message && message.method === 'tools/list' && 'id' in message) {
      const answer: JSONRPCMessage = {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32603, message: 'listing broke' },
      };
      queueMicrotask(() => transport.onmessage?.(answer));
      return;
    }
    return send(message, options);
  };
  return transport;
}

function breakListingOf(server: string): void {
  const connect = Upstreams.connect.bind(Upstreams);
  vi.spyOn(Upstreams, 'connect').mockImplementation((specs, opts) =>
    connect(
      specs.map((spec): UpstreamSpec => {
        if (spec.name !== server || spec.transport !== 'custom') return spec;
        return { ...spec, connect: async () => failingListing(await spec.connect()) };
      }),
      opts,
    ),
  );
}

describe('the tool listing a run starts from', () => {
  it('fails the run in both conditions when a world server cannot list its tools', async () => {
    breakListingOf('docs');
    for (const condition of ['baseline', 'enforced'] as const) {
      const run = runScenario(T1, condition, scriptedModel);
      await expect(run).rejects.toBeInstanceOf(HarnessError);
      await expect(run).rejects.toThrow(`t1+clean (${condition}): listing tools failed on docs`);
    }
  });

  it('never starts the model when the listing failed', async () => {
    breakListingOf('web');
    let started = false;
    const model = () => ({
      ...scriptedModel(T1),
      start: async () => {
        started = true;
      },
    });
    await expect(runScenario(T1, 'enforced', model)).rejects.toBeInstanceOf(HarnessError);
    expect(started).toBe(false);
  });

  it('fails an enforced run whose policy lists no tools at all', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'listing-policy-'));
    dirs.push(dir);
    const policyPath = join(dir, 'policy.yaml');
    writeFileSync(
      policyPath,
      [
        'version: 1',
        'rules:',
        '  - id: someone-else',
        '    identities: [reader]',
        '    server: docs',
        '    tools: [list_drafts]',
        '    effect: allow',
        '',
      ].join('\n'),
    );
    await expect(runScenario(T1, 'enforced', scriptedModel, { policyPath })).rejects.toThrow(
      new HarnessError('t1+clean (enforced): the proxy listed no tools'),
    );
  });
});
