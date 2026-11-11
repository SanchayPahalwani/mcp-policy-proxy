import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryTransport, Server } from '@modelcontextprotocol/server';
import { Upstreams, type UpstreamSpec } from '../../src/proxy/upstreams.js';
import {
  httpUpstream,
  inMemoryUpstream,
  stdioUpstream,
  type MockCall,
} from '../helpers/mock-upstream.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function connect(
  specs: UpstreamSpec[],
  opts?: Parameters<typeof Upstreams.connect>[1],
): Promise<Upstreams> {
  const upstreams = await Upstreams.connect(specs, opts);
  cleanups.push(() => upstreams.close());
  return upstreams;
}

async function startHttp(...args: Parameters<typeof httpUpstream>) {
  const http = await httpUpstream(...args);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await http.close();
  };
  cleanups.push(close);
  return { spec: http.spec, close };
}

function textOf(result: { content: unknown[] }): string | undefined {
  const first = result.content[0] as { type: string; text?: string } | undefined;
  return first?.type === 'text' ? first.text : undefined;
}

describe('Upstreams', () => {
  it('lists tools from in-memory, http and stdio upstreams with their server names', async () => {
    const web = await startHttp('web', [{ name: 'b' }]);
    const upstreams = await connect([
      inMemoryUpstream('mem', [{ name: 'a' }]),
      web.spec,
      stdioUpstream('std'),
    ]);

    expect(upstreams.names()).toEqual(['mem', 'web', 'std']);
    expect(upstreams.has('web')).toBe(true);
    expect(upstreams.has('nope')).toBe(false);
    const listed = (await upstreams.listTools()).map((t) => ({
      server: t.server,
      name: t.tool.name,
    }));
    expect(listed).toEqual(
      expect.arrayContaining([
        { server: 'mem', name: 'a' },
        { server: 'web', name: 'b' },
        { server: 'std', name: 'echo' },
        { server: 'std', name: 'add' },
      ]),
    );
  });

  it('calls a tool on the named upstream', async () => {
    const calls: MockCall[] = [];
    const upstreams = await connect([
      inMemoryUpstream('mem', [{ name: 'a' }], calls),
      stdioUpstream('std'),
    ]);

    expect(textOf(await upstreams.callTool('std', 'add', { a: 2, b: 3 }))).toBe('5');
    expect(textOf(await upstreams.callTool('mem', 'a', { x: 1 }))).toBe('{"x":1}');
    expect(calls).toEqual([{ tool: 'a', args: { x: 1 } }]);
  });

  it('follows pagination', async () => {
    const pages: Record<string, { tools: { name: string }[]; nextCursor?: string }> = {
      '': { tools: [{ name: 'first' }], nextCursor: 'page2' },
      page2: { tools: [{ name: 'second' }] },
    };
    const spec: UpstreamSpec = {
      name: 'paged',
      transport: 'custom',
      connect: async () => {
        const server = new Server(
          { name: 'paged', version: '0.0.0' },
          { capabilities: { tools: {} } },
        );
        server.setRequestHandler('tools/list', async (req) => {
          const page = pages[req.params?.cursor ?? ''];
          if (!page) throw new Error('unknown cursor');
          return {
            tools: page.tools.map((t) => ({ ...t, inputSchema: { type: 'object' as const } })),
            ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor }),
          };
        });
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        await server.connect(serverSide);
        return clientSide;
      },
    };
    const upstreams = await connect([spec]);

    expect((await upstreams.listTools()).map((t) => t.tool.name)).toEqual(['first', 'second']);
  });

  it('omits an upstream that fails to list and reports it', async () => {
    const web = await startHttp('web', [{ name: 'b' }]);
    const errors: Array<{ server: string; error: Error }> = [];
    const upstreams = await connect([inMemoryUpstream('mem', [{ name: 'a' }]), web.spec], {
      onError: (server, error) => errors.push({ server, error }),
    });
    await web.close();

    const listed = await upstreams.listTools();
    expect(listed.map((t) => t.server)).toEqual(['mem']);
    expect(errors.map((e) => e.server)).toEqual(['web']);
    expect(errors[0]?.error).toBeInstanceOf(Error);
  });

  it('rejects duplicate or invalid upstream names', async () => {
    await expect(
      Upstreams.connect([inMemoryUpstream('a', []), inMemoryUpstream('a', [])]),
    ).rejects.toThrow(/\ba\b/);
    await expect(Upstreams.connect([inMemoryUpstream('Bad_Name', [])])).rejects.toThrow(/Bad_Name/);
  });

  it('rejects a call to an unknown server', async () => {
    const upstreams = await connect([inMemoryUpstream('mem', [{ name: 'a' }])]);

    await expect(upstreams.callTool('nope', 'a', {})).rejects.toThrow(/nope/);
  });
});
