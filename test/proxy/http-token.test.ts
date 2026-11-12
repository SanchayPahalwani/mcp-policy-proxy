import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex, staticTokenAuthenticator } from '../../src/proxy/auth.js';
import { passthroughGate } from '../../src/proxy/gate.js';
import { startHttpProxy } from '../../src/proxy/http.js';
import { Upstreams } from '../../src/proxy/upstreams.js';
import { inMemoryUpstream } from '../helpers/mock-upstream.js';
import { connectAgent } from '../helpers/proxy-client.js';

// What the SDK handler is handed for each request, seen from inside its server factory.
const seen = vi.hoisted(
  () => [] as Array<{ authorization: string | null; session: string | null }>,
);

vi.mock('@modelcontextprotocol/server', async (importOriginal) => {
  const sdk = await importOriginal<typeof import('@modelcontextprotocol/server')>();
  return {
    ...sdk,
    createMcpHandler: ((factory, options) =>
      sdk.createMcpHandler((ctx) => {
        const headers = ctx.requestInfo?.headers;
        seen.push({
          authorization: headers?.get('authorization') ?? null,
          session: headers?.get('x-agent-session') ?? null,
        });
        return factory(ctx);
      }, options)) as typeof sdk.createMcpHandler,
  };
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('the bearer token', () => {
  it('stops at the HTTP layer and never reaches the SDK handler', async () => {
    const upstreams = await Upstreams.connect([inMemoryUpstream('docs', [{ name: 'list' }])]);
    cleanups.push(() => upstreams.close());
    const proxy = await startHttpProxy({
      upstreams,
      gate: passthroughGate,
      authenticator: staticTokenAuthenticator([
        { name: 'writer', token_sha256: sha256Hex('tok-writer') },
      ]),
    });
    cleanups.push(() => proxy.close());
    const client = await connectAgent(proxy, 'tok-writer', 's1');
    cleanups.push(() => client.close());
    await client.listTools();

    expect(seen.length).toBeGreaterThan(0);
    // Other headers still arrive, so an absent token is not just an empty request.
    for (const request of seen) expect(request).toEqual({ authorization: null, session: 's1' });
  });
});
