import { request } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Client, ProtocolError, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { sha256Hex, staticTokenAuthenticator } from '../../src/proxy/auth.js';
import { passthroughGate, type Caller, type Gate } from '../../src/proxy/gate.js';
import { startHttpProxy, type RunningProxy } from '../../src/proxy/http.js';
import { Upstreams } from '../../src/proxy/upstreams.js';
import { inMemoryUpstream, stdioUpstream, type MockCall } from '../helpers/mock-upstream.js';

const calls: MockCall[] = [];
const gateSaw: Array<{ caller: Caller; server: string; tool: string }> = [];
const recordingGate: Gate = {
  filterTools: passthroughGate.filterTools,
  callTool: (caller, target, forward) => {
    gateSaw.push({ caller, server: target.server, tool: target.tool });
    return forward();
  },
};
let upstreams: Upstreams;
let proxy: RunningProxy;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  upstreams = await Upstreams.connect([
    inMemoryUpstream('docs', [{ name: 'create_draft' }, { name: 'publish' }], calls),
    stdioUpstream('std'),
  ]);
  proxy = await startHttpProxy({
    upstreams,
    gate: recordingGate,
    authenticator: staticTokenAuthenticator([
      { name: 'writer', token_sha256: sha256Hex('tok-writer') },
    ]),
  });
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

afterAll(async () => {
  await proxy?.close();
  await upstreams?.close();
});

async function connect(
  token: string,
  opts: { mode: 'auto' | 'legacy'; session?: string },
): Promise<Client> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (opts.session !== undefined) headers['x-agent-session'] = opts.session;
  const client = new Client(
    { name: 'test-agent', version: '0.0.0' },
    { versionNegotiation: { mode: opts.mode } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(proxy.url), { requestInit: { headers } }),
  );
  cleanups.push(() => client.close());
  return client;
}

function textOf(result: { content: unknown[] }): string | undefined {
  const first = result.content[0] as { type: string; text?: string } | undefined;
  return first?.type === 'text' ? first.text : undefined;
}

const ALL_TOOLS = ['docs__create_draft', 'docs__publish', 'std__add', 'std__echo'];

function post(headers: Record<string, string>, path = '/mcp'): Promise<Response> {
  return fetch(new URL(path, proxy.url), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
}

function rawRequest(
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number | undefined }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: proxy.port, method: 'POST', path, headers },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode }));
      },
    );
    req.on('error', reject);
    req.end('{}');
  });
}

describe('HTTP proxy', () => {
  it('lists namespaced tools from every upstream (modern era)', async () => {
    const client = await connect('tok-writer', { mode: 'auto' });

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(ALL_TOOLS);
    expect(client.getProtocolEra()).toBe('modern');
  });

  it('works for a 2025-era client', async () => {
    const client = await connect('tok-writer', { mode: 'legacy', session: 's-1' });

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(ALL_TOOLS);
    expect(client.getProtocolEra()).toBe('legacy');
    const result = await client.callTool({ name: 'docs__create_draft', arguments: { t: 'x' } });
    expect(textOf(result as { content: unknown[] })).toBe('{"t":"x"}');
  });

  it('forwards a call and returns the upstream result', async () => {
    const client = await connect('tok-writer', { mode: 'auto' });

    const result = await client.callTool({ name: 'std__add', arguments: { a: 2, b: 3 } });
    expect(textOf(result as { content: unknown[] })).toBe('5');
  });

  it('passes missing arguments as an empty object', async () => {
    const client = await connect('tok-writer', { mode: 'auto' });
    const before = calls.length;

    await client.callTool({ name: 'docs__create_draft' });
    expect(calls.slice(before)).toEqual([{ tool: 'create_draft', args: {} }]);
  });

  it('returns tool-not-found for malformed or unknown names', async () => {
    const client = await connect('tok-writer', { mode: 'auto' });
    const before = calls.length;
    const gateBefore = gateSaw.length;

    for (const name of ['publish', 'nope__publish', 'docs__', 'Docs__publish']) {
      const error = await client.callTool({ name, arguments: {} }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error, name).toBeInstanceOf(ProtocolError);
      expect((error as ProtocolError).code, name).toBe(-32602);
      expect((error as ProtocolError).message, name).toContain('not found');
    }
    expect(calls.length).toBe(before);
    expect(gateSaw.slice(gateBefore)).toEqual([]);

    await client.callTool({ name: 'docs__publish', arguments: { id: 1 } });
    expect(calls.slice(before)).toEqual([{ tool: 'publish', args: { id: 1 } }]);
  });

  it('rejects requests without a valid token', async () => {
    const cases: Record<string, string>[] = [{}, { authorization: 'Bearer nope' }];
    for (const headers of cases) {
      const res = await post(headers);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    }
  });

  it('rejects a malformed session header', async () => {
    const res = await post({
      authorization: 'Bearer tok-writer',
      'x-agent-session': 'bad session!',
    });
    expect(res.status).toBe(400);
    await res.body?.cancel();
  });

  it('answers 404 off the MCP path', async () => {
    const res = await post({ authorization: 'Bearer tok-writer' }, '/other');
    expect(res.status).toBe(404);
    await res.body?.cancel();
  });

  it('answers 404 off the MCP path before checking the token', async () => {
    const res = await post({}, '/other');
    expect(res.status).toBe(404);
    await res.body?.cancel();
  });

  it('survives a request target that is not a valid URL path', async () => {
    const res = await fetch(`http://127.0.0.1:${proxy.port}//`, { method: 'POST' });
    expect(res.status).toBe(404);
    await res.body?.cancel();

    const client = await connect('tok-writer', { mode: 'auto' });
    const result = await client.callTool({ name: 'std__add', arguments: { a: 1, b: 1 } });
    expect(textOf(result as { content: unknown[] })).toBe('2');
  });

  it('rejects a foreign Host or Origin header', async () => {
    // No token: a 403 rather than a 401 shows the guards run before authentication.
    const json = { 'content-type': 'application/json' };
    expect((await rawRequest('/mcp', { ...json, host: 'evil.example' })).status).toBe(403);
    expect((await rawRequest('/mcp', { ...json, origin: 'http://evil.example' })).status).toBe(403);
  });

  it('passes identity and session to the gate', async () => {
    const cases: Array<{ mode: 'auto' | 'legacy'; session?: string; expected: string }> = [
      { mode: 'auto', session: 's-1', expected: 's-1' },
      { mode: 'auto', expected: 'default' },
      { mode: 'legacy', session: 's-2', expected: 's-2' },
    ];
    for (const { mode, session, expected } of cases) {
      const client = await connect(
        'tok-writer',
        session === undefined ? { mode } : { mode, session },
      );
      const before = gateSaw.length;
      await client.callTool({ name: 'docs__publish', arguments: {} });
      expect(gateSaw.slice(before)).toEqual([
        { caller: { identity: 'writer', session: expected }, server: 'docs', tool: 'publish' },
      ]);
    }
  });
});
