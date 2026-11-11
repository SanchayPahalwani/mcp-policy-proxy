import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { passthroughGate } from '../../src/proxy/gate.js';
import { startStdioProxy } from '../../src/proxy/stdio.js';
import { Upstreams } from '../../src/proxy/upstreams.js';
import { inMemoryUpstream, type MockCall } from '../helpers/mock-upstream.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('stdio proxy', () => {
  it('lists and calls tools over a caller-supplied transport', async () => {
    const calls: MockCall[] = [];
    const upstreams = await Upstreams.connect([
      inMemoryUpstream('docs', [{ name: 'create_draft' }, { name: 'publish' }], calls),
    ]);
    cleanups.push(() => upstreams.close());
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const proxy = startStdioProxy({
      upstreams,
      gate: passthroughGate,
      identity: 'writer',
      transport: serverSide,
    });
    cleanups.push(() => proxy.close());
    const client = new Client(
      { name: 'test-agent', version: '0.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await client.connect(clientSide);
    cleanups.push(() => client.close());

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['docs__create_draft', 'docs__publish']);
    const result = await client.callTool({ name: 'docs__create_draft', arguments: { t: 'x' } });
    expect(result.content).toEqual([{ type: 'text', text: '{"t":"x"}' }]);
    expect(calls).toEqual([{ tool: 'create_draft', args: { t: 'x' } }]);
  });
});
