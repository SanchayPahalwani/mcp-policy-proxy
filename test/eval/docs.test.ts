import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Ledger } from '../../eval/ledger.js';
import { createDocsServer, type Draft } from '../../eval/servers/docs.js';
import { call, textOf } from '../helpers/proxy-client.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function connect(seed?: Draft[], clock?: () => number) {
  const ledger = new Ledger(clock);
  const { server, state } = createDocsServer(ledger, seed);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client(
    { name: 'test', version: '0.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  await client.connect(clientSide);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, ledger, state };
}

const draft = (id: string, title = `title ${id}`): Draft => ({
  id,
  title,
  body: `body of ${id}`,
  published: false,
});

describe('docs mock server', () => {
  it('lists its six tools', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'create_draft',
      'delete_draft',
      'get_draft',
      'list_drafts',
      'publish',
      'update_draft',
    ]);
  });

  it('numbers new drafts after the highest seeded id', async () => {
    const { client, state } = await connect([draft('d1'), draft('d7'), draft('notes')]);
    expect(state.nextId).toBe(8);
    expect(textOf(await call(client, 'create_draft', { title: 't', body: 'b' }))).toBe(
      'Created draft d8',
    );
    expect(textOf(await call(client, 'create_draft', { title: 't', body: 'b' }))).toBe(
      'Created draft d9',
    );
  });

  it('starts at d1 with nothing seeded', async () => {
    const { client } = await connect();
    expect(textOf(await call(client, 'create_draft', { title: 't', body: 'b' }))).toBe(
      'Created draft d1',
    );
  });

  it('reads, updates, publishes and deletes a draft', async () => {
    const { client, state } = await connect([draft('d1', 'Old')]);
    expect(textOf(await call(client, 'get_draft', { id: 'd1' }))).toBe('Old\n\nbody of d1');
    expect(textOf(await call(client, 'update_draft', { id: 'd1', title: 'New' }))).toBe(
      'Updated draft d1',
    );
    expect(state.drafts.get('d1')).toMatchObject({ title: 'New', body: 'body of d1' });
    expect(textOf(await call(client, 'publish', { id: 'd1' }))).toBe('Published draft d1');
    expect(JSON.parse(textOf(await call(client, 'list_drafts', {})))).toEqual([
      { id: 'd1', title: 'New', published: true },
    ]);
    expect(textOf(await call(client, 'delete_draft', { id: 'd1' }))).toBe('Deleted draft d1');
    expect(state.drafts.size).toBe(0);
  });

  it('answers a missing draft with a tool error', async () => {
    const { client } = await connect();
    for (const tool of ['get_draft', 'update_draft', 'delete_draft', 'publish']) {
      const result = await call(client, tool, { id: 'd4' });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe('No draft d4');
    }
  });

  it('records every call in the ledger with the clock time', async () => {
    let now = 100;
    const { client, ledger } = await connect(undefined, () => now++);
    await call(client, 'list_drafts', {});
    await call(client, 'get_draft', { id: 'missing' });
    expect(ledger.entries).toEqual([
      { ts: 100, server: 'docs', tool: 'list_drafts', args: {} },
      { ts: 101, server: 'docs', tool: 'get_draft', args: { id: 'missing' } },
    ]);
  });
});
