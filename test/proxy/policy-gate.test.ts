import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProtocolError, type Client } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { loadPolicy, parsePolicy, type Policy } from '../../src/policy/load.js';
import { sha256Hex, staticTokenAuthenticator } from '../../src/proxy/auth.js';
import { policyGate } from '../../src/proxy/policy-gate.js';
import { startHttpProxy, type RunningProxy } from '../../src/proxy/http.js';
import { Upstreams } from '../../src/proxy/upstreams.js';
import { inMemoryUpstream, type MockCall, type MockTool } from '../helpers/mock-upstream.js';
import { call, connectAgent, textOf } from '../helpers/proxy-client.js';

const EXAMPLE = loadPolicy(fileURLToPath(new URL('../../examples/policy.yaml', import.meta.url)));
const DOCS_TOOLS = ['list_drafts', 'get_draft', 'create_draft', 'update_draft', 'delete_draft'];
const DRAFT_ERROR: CallToolResult = {
  isError: true,
  content: [{ type: 'text', text: 'draft 7 does not exist' }],
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

interface Harness {
  proxy: RunningProxy;
  calls: Record<'docs' | 'web' | 'mail', MockCall[]>;
  clock: { now: number };
}

async function start(
  opts: { policy?: Policy; mailHandler?: MockTool['handler']; clock?: () => number } = {},
): Promise<Harness> {
  const calls = { docs: [] as MockCall[], web: [] as MockCall[], mail: [] as MockCall[] };
  const clock = { now: 0 };
  const upstreams = await Upstreams.connect([
    inMemoryUpstream(
      'docs',
      [
        ...DOCS_TOOLS.map((name) =>
          name === 'get_draft' ? { name, handler: () => DRAFT_ERROR } : { name },
        ),
        { name: 'publish' },
      ],
      calls.docs,
    ),
    inMemoryUpstream('web', [{ name: 'fetch_page' }], calls.web),
    inMemoryUpstream(
      'mail',
      [opts.mailHandler ? { name: 'send', handler: opts.mailHandler } : { name: 'send' }],
      calls.mail,
    ),
  ]);
  cleanups.push(() => upstreams.close());
  const proxy = await startHttpProxy({
    upstreams,
    gate: policyGate({ policy: opts.policy ?? EXAMPLE, clock: opts.clock ?? (() => clock.now) }),
    authenticator: staticTokenAuthenticator([
      { name: 'writer', token_sha256: sha256Hex('tok-writer') },
      { name: 'release-manager', token_sha256: sha256Hex('tok-release') },
    ]),
  });
  cleanups.push(() => proxy.close());
  return { proxy, calls, clock };
}

async function connect(proxy: RunningProxy, token: string, session?: string): Promise<Client> {
  const client = await connectAgent(proxy, token, session);
  cleanups.push(() => client.close());
  return client;
}

const TEAM_MAIL = { to: 'team@example.test', body: 'hello' };

describe('policy gate', () => {
  it('lists only what the caller may call', async () => {
    const { proxy } = await start();
    const writer = await connect(proxy, 'tok-writer');
    const release = await connect(proxy, 'tok-release');

    const names = async (c: Client) => (await c.listTools()).tools.map((t) => t.name).sort();
    expect(await names(writer)).toEqual([
      'docs__create_draft',
      'docs__get_draft',
      'docs__list_drafts',
      'docs__update_draft',
      'mail__send',
      'web__fetch_page',
    ]);
    expect(await names(release)).toEqual([
      'docs__get_draft',
      'docs__list_drafts',
      'docs__publish',
      'web__fetch_page',
    ]);
  });

  it('a hidden tool is indistinguishable from a missing one', async () => {
    const { proxy, calls } = await start();
    const writer = await connect(proxy, 'tok-writer');

    const messages: string[] = [];
    for (const name of ['docs__publish', 'docs__delete_draft', 'docs__no_such_tool']) {
      const error = await writer.callTool({ name, arguments: {} }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error, name).toBeInstanceOf(ProtocolError);
      expect((error as ProtocolError).code, name).toBe(-32602);
      expect((error as ProtocolError).message, name).toBe(`Tool ${name} not found`);
      messages.push((error as ProtocolError).message.replace(name, '<name>'));
    }
    expect(new Set(messages).size).toBe(1);
    expect(calls.docs).toEqual([]);
  });

  it('refuses bad arguments with a readable result', async () => {
    const { proxy, calls } = await start();
    const writer = await connect(proxy, 'tok-writer');

    const wrongTo = await call(writer, 'mail__send', { to: 'attacker@evil.test', body: 'x' });
    expect(wrongTo.isError).toBe(true);
    expect(textOf(wrongTo)).toBe(
      'Denied by policy (constraint_failed): arguments rejected: rule "mail-team-only": to must equal "team@example.test"',
    );

    const withCc = await call(writer, 'mail__send', { ...TEAM_MAIL, cc: 'attacker@evil.test' });
    expect(withCc.isError).toBe(true);
    expect(textOf(withCc)).toContain('cc must be absent');
    expect(calls.mail).toEqual([]);
  });

  it('treats missing arguments as empty', async () => {
    const { proxy, calls } = await start();
    const writer = await connect(proxy, 'tok-writer');

    const result = await call(writer, 'web__fetch_page');
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('url is missing');
    expect(calls.web).toEqual([]);
  });

  it('enforces per-session limits per session header', async () => {
    const { proxy, calls, clock } = await start();
    const s1 = await connect(proxy, 'tok-writer', 's1');

    expect((await call(s1, 'mail__send', TEAM_MAIL)).isError).toBeFalsy();
    expect((await call(s1, 'mail__send', TEAM_MAIL)).isError).toBeFalsy();
    const third = await call(s1, 'mail__send', TEAM_MAIL);
    expect(textOf(third)).toMatch(/^Denied by policy \(limit_exceeded\): /);
    expect(textOf(third)).toContain('per session');

    clock.now += 61_000;
    const s2 = await connect(proxy, 'tok-writer', 's2');
    expect((await call(s2, 'mail__send', TEAM_MAIL)).isError).toBeFalsy();

    // Two separate header-less clients: if they did not share `default`, the third would pass.
    const first = await connect(proxy, 'tok-writer');
    const second = await connect(proxy, 'tok-writer');
    clock.now += 61_000;
    expect((await call(first, 'mail__send', TEAM_MAIL)).isError).toBeFalsy();
    clock.now += 61_000;
    expect((await call(second, 'mail__send', TEAM_MAIL)).isError).toBeFalsy();
    clock.now += 61_000;
    const shared = await call(first, 'mail__send', TEAM_MAIL);
    expect(textOf(shared)).toMatch(/^Denied by policy \(limit_exceeded\): /);
    expect(textOf(shared)).toContain('per session');
    expect(calls.mail).toHaveLength(5);
  });

  it('enforces per-minute limits by identity across sessions', async () => {
    const { proxy, calls, clock } = await start();
    const s1 = await connect(proxy, 'tok-writer', 's1');
    const s2 = await connect(proxy, 'tok-writer', 's2');

    expect((await call(s1, 'mail__send', TEAM_MAIL)).isError).toBeFalsy();
    clock.now += 1_000;
    expect((await call(s1, 'mail__send', TEAM_MAIL)).isError).toBeFalsy();
    clock.now += 1_000;
    const result = await call(s2, 'mail__send', TEAM_MAIL);
    expect(textOf(result)).toMatch(/^Denied by policy \(limit_exceeded\): /);
    expect(textOf(result)).toContain('per minute');
    expect(calls.mail).toHaveLength(2);
  });

  it('concurrent calls cannot exceed a limit', async () => {
    const policy = parsePolicy(`
version: 1
rules:
  - id: one-send
    identities: [writer]
    server: mail
    tools: [send]
    effect: allow
    limits:
      per_session: 1
`);
    const { proxy, calls } = await start({
      policy,
      mailHandler: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { content: [{ type: 'text', text: 'sent' }] };
      },
    });
    const writer = await connect(proxy, 'tok-writer', 's1');

    const results = await Promise.all(
      Array.from({ length: 5 }, () => call(writer, 'mail__send', TEAM_MAIL)),
    );
    expect(results.filter((r) => !r.isError).map(textOf)).toEqual(['sent']);
    const denied = results.filter((r) => r.isError).map(textOf);
    expect(denied).toHaveLength(4);
    for (const text of denied) expect(text).toMatch(/^Denied by policy \(limit_exceeded\): /);
    expect(calls.mail).toHaveLength(1);
  });

  it('passes upstream tool errors through', async () => {
    const { proxy } = await start();
    const writer = await connect(proxy, 'tok-writer');

    // The SDK stamps the proxy's own serverInfo into `_meta`; everything else must be untouched.
    const { _meta, ...result } = await call(writer, 'docs__get_draft', { id: 7 });
    expect(result).toEqual(DRAFT_ERROR);
  });

  it('requires approval when configured', async () => {
    const { proxy, calls } = await start();
    const release = await connect(proxy, 'tok-release');

    const result = await call(release, 'docs__publish', { id: 7 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      'Denied by policy (approval_unavailable): this call needs approval and no approver is configured',
    );
    expect(calls.docs).toEqual([]);
  });

  it('fails closed when policy evaluation throws', async () => {
    const broken = parsePolicy(`
version: 1
rules:
  - id: any-send
    identities: [writer]
    server: mail
    tools: [send]
    effect: allow
`);
    const rule = broken.rules[0];
    if (!rule) throw new Error('fixture has no rule');
    rule.matches = () => {
      throw new Error('boom');
    };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { proxy, calls } = await start({ policy: broken });
    const writer = await connect(proxy, 'tok-writer');

    const result = await call(writer, 'mail__send', TEAM_MAIL);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^Denied by policy \(internal_error\)/);
    expect(logged).toHaveBeenCalled();
    expect(calls.mail).toEqual([]);
  });

  it('fails closed when the clock throws', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { proxy, calls } = await start({
      clock: () => {
        throw new Error('clock is broken');
      },
    });
    const writer = await connect(proxy, 'tok-writer');

    const result = await call(writer, 'mail__send', TEAM_MAIL);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Denied by policy (internal_error): policy evaluation failed');
    expect(logged).toHaveBeenCalled();
    expect(calls.mail).toEqual([]);
  });

  it('lists nothing when policy evaluation throws during listing', async () => {
    const broken = parsePolicy(`
version: 1
rules:
  - id: any-send
    identities: [writer]
    server: mail
    tools: [send]
    effect: allow
`);
    const rule = broken.rules[0];
    if (!rule) throw new Error('fixture has no rule');
    rule.matches = () => {
      throw new Error('boom');
    };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { proxy } = await start({ policy: broken });
    const writer = await connect(proxy, 'tok-writer');

    expect((await writer.listTools()).tools).toEqual([]);
    expect(logged).toHaveBeenCalled();
  });

  it('forwards a glob-allowed tool the upstream lacks and returns its own error', async () => {
    const policy = parsePolicy(`
version: 1
rules:
  - id: all-docs
    identities: [writer]
    server: docs
    tools: ['*']
    effect: allow
`);
    const { proxy, calls } = await start({ policy });
    const writer = await connect(proxy, 'tok-writer');

    const error = await writer.callTool({ name: 'docs__no_such_tool', arguments: {} }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe(-32602);
    expect((error as ProtocolError).message).toBe('Tool no_such_tool not found');
    expect(calls.docs).toEqual([{ tool: 'no_such_tool', args: {} }]);
  });
});
