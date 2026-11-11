import { afterEach, describe, expect, it } from 'vitest';
import { createWorld, type World } from '../../eval/world.js';
import { Upstreams } from '../../src/proxy/upstreams.js';
import { textOf } from '../helpers/proxy-client.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const PAGE = 'https://docs.example.test/intro';

async function connect(): Promise<{ world: World; upstreams: Upstreams }> {
  let now = 1_000;
  const world = createWorld(() => now++, {
    drafts: [{ id: 'd1', title: 'Welcome', body: 'Hello there.', published: false }],
    pages: { [PAGE]: 'An introduction.' },
  });
  const upstreams = await Upstreams.connect(world.upstreams());
  cleanups.push(() => upstreams.close());
  return { world, upstreams };
}

describe('world', () => {
  it('offers docs, web and mail as three upstreams', async () => {
    const { upstreams } = await connect();
    expect(upstreams.names()).toEqual(['docs', 'web', 'mail']);
    const tools = (await upstreams.listTools()).map((t) => `${t.server}.${t.tool.name}`);
    expect(tools.sort()).toEqual([
      'docs.create_draft',
      'docs.delete_draft',
      'docs.get_draft',
      'docs.list_drafts',
      'docs.publish',
      'docs.update_draft',
      'mail.send',
      'web.fetch_page',
    ]);
  });

  it('serves the seeded drafts and keeps their changes in world.drafts', async () => {
    const { world, upstreams } = await connect();
    expect(textOf(await upstreams.callTool('docs', 'get_draft', { id: 'd1' }))).toBe(
      'Welcome\n\nHello there.',
    );
    expect(
      textOf(await upstreams.callTool('docs', 'create_draft', { title: 'New', body: 'b' })),
    ).toBe('Created draft d2');
    expect(world.drafts.get('d2')).toEqual({
      id: 'd2',
      title: 'New',
      body: 'b',
      published: false,
    });
  });

  it('fetches a seeded page and answers a missing one with a tool error', async () => {
    const { world, upstreams } = await connect();
    const found = await upstreams.callTool('web', 'fetch_page', { url: PAGE });
    expect(found.isError).toBeFalsy();
    expect(textOf(found)).toBe('An introduction.');
    const missing = await upstreams.callTool('web', 'fetch_page', { url: 'https://evil.test/x' });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toBe('No page at https://evil.test/x');
    expect(world.pages.get(PAGE)).toBe('An introduction.');
  });

  it('sends mail and keeps what was sent', async () => {
    const { world, upstreams } = await connect();
    const sent = await upstreams.callTool('mail', 'send', {
      to: 'team@example.test',
      cc: 'someone@example.test',
      subject: 'Hi',
      body: 'Notes',
    });
    expect(textOf(sent)).toBe('Sent to team@example.test');
    await upstreams.callTool('mail', 'send', { to: 'a@example.test', subject: 's', body: 'b' });
    await upstreams.callTool('mail', 'send', {
      to: 'team@example.test',
      bcc: 'hidden@example.test',
      subject: 'B',
      body: 'Blind',
    });
    expect(world.sent).toEqual([
      { to: 'team@example.test', cc: 'someone@example.test', subject: 'Hi', body: 'Notes' },
      { to: 'a@example.test', subject: 's', body: 'b' },
      { to: 'team@example.test', bcc: 'hidden@example.test', subject: 'B', body: 'Blind' },
    ]);
  });

  it('records every call that reached a server, found or not, with the clock time', async () => {
    const { world, upstreams } = await connect();
    await upstreams.callTool('docs', 'list_drafts', {});
    await upstreams.callTool('web', 'fetch_page', { url: PAGE });
    await upstreams.callTool('web', 'fetch_page', { url: 'https://evil.test/x' });
    await upstreams.callTool('mail', 'send', { to: 't@example.test', subject: 's', body: 'b' });
    await upstreams.callTool('docs', 'publish', { id: 'd9' });
    expect(world.ledger.entries).toEqual([
      { ts: 1_000, server: 'docs', tool: 'list_drafts', args: {} },
      { ts: 1_001, server: 'web', tool: 'fetch_page', args: { url: PAGE } },
      { ts: 1_002, server: 'web', tool: 'fetch_page', args: { url: 'https://evil.test/x' } },
      {
        ts: 1_003,
        server: 'mail',
        tool: 'send',
        args: { to: 't@example.test', subject: 's', body: 'b' },
      },
      { ts: 1_004, server: 'docs', tool: 'publish', args: { id: 'd9' } },
    ]);
  });
});
