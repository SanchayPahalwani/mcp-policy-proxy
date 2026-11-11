import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProtocolError, type Client, type Transport } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import {
  memoryAuditSink,
  type AuditEvent,
  type AuditSink,
  type DecisionEvent,
} from '../../src/audit/log.js';
import { loadPolicy, parsePolicy, type Policy } from '../../src/policy/load.js';
import { sha256Hex, staticTokenAuthenticator } from '../../src/proxy/auth.js';
import { policyGate } from '../../src/proxy/policy-gate.js';
import { startHttpProxy, type RunningProxy } from '../../src/proxy/http.js';
import { Upstreams, type UpstreamSpec } from '../../src/proxy/upstreams.js';
import { mockServer, type MockCall, type MockTool } from '../helpers/mock-upstream.js';
import { call, connectAgent, textOf } from '../helpers/proxy-client.js';

const EXAMPLE = loadPolicy(fileURLToPath(new URL('../../examples/policy.yaml', import.meta.url)));
const DOCS_TOOLS = ['list_drafts', 'get_draft', 'create_draft', 'update_draft', 'delete_draft'];
const TEAM_MAIL = { to: 'team@example.test', body: 'hello' };
const ISO = (ms: number) => new Date(ms).toISOString();

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

type Name = 'docs' | 'web' | 'mail';

interface Harness {
  proxy: RunningProxy;
  calls: Record<Name, MockCall[]>;
  clock: { now: number };
  /** Closes the proxy's side of one upstream connection, as if the upstream had gone away. */
  drop(server: Name): Promise<void>;
}

async function start(opts: {
  policy?: Policy;
  audit: AuditSink;
  handlers?: Partial<Record<string, MockTool['handler']>>;
}): Promise<Harness> {
  const calls = { docs: [] as MockCall[], web: [] as MockCall[], mail: [] as MockCall[] };
  const clock = { now: 1_000 };
  const transports = new Map<string, Transport>();
  const tool = (server: Name, name: string): MockTool => {
    const handler = opts.handlers?.[`${server}__${name}`];
    return handler ? { name, handler } : { name };
  };
  const upstream = (server: Name, names: string[]): UpstreamSpec => ({
    name: server,
    transport: 'custom',
    connect: async () => {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      const tools = names.map((n) => tool(server, n));
      await mockServer(server, tools, calls[server]).connect(serverSide);
      transports.set(server, clientSide);
      return clientSide;
    },
  });
  const upstreams = await Upstreams.connect([
    upstream('docs', [...DOCS_TOOLS, 'publish']),
    upstream('web', ['fetch_page']),
    upstream('mail', ['send']),
  ]);
  cleanups.push(() => upstreams.close());
  let ids = 0;
  const proxy = await startHttpProxy({
    upstreams,
    gate: policyGate({
      policy: opts.policy ?? EXAMPLE,
      audit: opts.audit,
      clock: () => clock.now,
      newId: () => `call-${++ids}`,
    }),
    authenticator: staticTokenAuthenticator([
      { name: 'writer', token_sha256: sha256Hex('tok-writer') },
    ]),
  });
  cleanups.push(() => proxy.close());
  return {
    proxy,
    calls,
    clock,
    drop: async (server) => {
      await transports.get(server)?.close();
    },
  };
}

async function connect(proxy: RunningProxy, session = 's1'): Promise<Client> {
  const client = await connectAgent(proxy, 'tok-writer', session);
  cleanups.push(() => client.close());
  return client;
}

function decisions(events: AuditEvent[]): DecisionEvent[] {
  return events.filter((e): e is DecisionEvent => e.type === 'decision');
}

const ONE_SEND = `
version: 1
audit:
  redact_keys: [body]
rules:
  - id: one-send
    identities: [writer]
    server: mail
    tools: [send]
    effect: allow
    limits:
      per_session: 1
`;

describe('audit', () => {
  it('writes the decision before the upstream sees the call', async () => {
    const sink = memoryAuditSink();
    let seenByUpstream: AuditEvent[] | undefined;
    const { proxy, clock } = await start({
      audit: sink,
      handlers: {
        docs__create_draft: () => {
          seenByUpstream = structuredClone(sink.events);
          clock.now += 4;
          return { content: [{ type: 'text', text: 'created' }] };
        },
      },
    });
    const writer = await connect(proxy);

    const result = await call(writer, 'docs__create_draft', { title: 'Notes' });
    expect(textOf(result)).toBe('created');

    const decision: DecisionEvent = {
      type: 'decision',
      ts: ISO(1_000),
      call_id: 'call-1',
      session: 's1',
      identity: 'writer',
      server: 'docs',
      tool: 'create_draft',
      args: { title: 'Notes' },
      effect: 'allow',
      code: 'allowed',
      rule: 'writer-drafts',
      reason: 'allowed by rule "writer-drafts"',
      visible: true,
      forwarded: true,
      policy_sha256: EXAMPLE.sha256,
    };
    expect(seenByUpstream).toEqual([decision]);
    expect(sink.events).toEqual([
      decision,
      {
        type: 'outcome',
        ts: ISO(1_004),
        call_id: 'call-1',
        ok: true,
        is_error: false,
        duration_ms: 4,
      },
    ]);
  });

  it('audits denials with the rule and reason', async () => {
    const sink = memoryAuditSink();
    const { proxy, calls } = await start({ audit: sink });
    const writer = await connect(proxy);

    const error = await writer.callTool({ name: 'docs__publish', arguments: { id: 'd1' } }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe(-32602);

    expect(sink.events).toEqual([
      {
        type: 'decision',
        ts: ISO(1_000),
        call_id: 'call-1',
        session: 's1',
        identity: 'writer',
        server: 'docs',
        tool: 'publish',
        args: { id: 'd1' },
        effect: 'deny',
        code: 'denied_by_rule',
        rule: 'writers-never-publish',
        reason:
          'rule "writers-never-publish" denies docs.publish for "writer": Publishing needs a release manager.',
        visible: false,
        forwarded: false,
        policy_sha256: EXAMPLE.sha256,
      },
    ]);
    expect(calls.docs).toEqual([]);
  });

  it('logs an approval-required call as a denial when no approver is configured', async () => {
    const sink = memoryAuditSink();
    const policy = parsePolicy(`
version: 1
rules:
  - id: approve-send
    identities: [writer]
    server: mail
    tools: [send]
    effect: require_approval
`);
    const { proxy, calls } = await start({ policy, audit: sink });
    const writer = await connect(proxy);

    await call(writer, 'mail__send', TEAM_MAIL);
    expect(sink.events).toEqual([
      expect.objectContaining({
        type: 'decision',
        effect: 'deny',
        code: 'approval_denied',
        rule: 'approve-send',
        visible: true,
        approval: { approved: false, note: 'no approver configured' },
        forwarded: false,
      }),
    ]);
    expect(calls.mail).toEqual([]);
  });

  it('redacts by key name', async () => {
    const sink = memoryAuditSink();
    const { proxy, calls } = await start({ policy: parsePolicy(ONE_SEND), audit: sink });
    const writer = await connect(proxy);

    await call(writer, 'mail__send', { to: 'team@example.test', body: 'the real body' });
    expect(decisions(sink.events)[0]?.args).toEqual({
      to: 'team@example.test',
      body: '[REDACTED]',
    });
    expect(calls.mail).toEqual([
      { tool: 'send', args: { to: 'team@example.test', body: 'the real body' } },
    ]);
  });

  it('refuses the call when the decision cannot be recorded', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const healthy = memoryAuditSink();
    let broken = true;
    const sink: AuditSink = {
      write(event) {
        if (broken && event.type === 'decision') throw new Error('disk full');
        healthy.write(event);
      },
    };
    const { proxy, calls } = await start({ policy: parsePolicy(ONE_SEND), audit: sink });
    const writer = await connect(proxy);

    const refused = await call(writer, 'mail__send', TEAM_MAIL);
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toBe(
      'Denied by policy (audit_failed): the decision could not be recorded',
    );
    expect(calls.mail).toEqual([]);
    expect(logged).toHaveBeenCalled();
    expect(healthy.events).toEqual([]);

    // per_session is 1: had the refused call been committed, this one would hit the limit.
    broken = false;
    const sent = await call(writer, 'mail__send', TEAM_MAIL);
    expect(sent.isError).toBeFalsy();
    expect(calls.mail).toHaveLength(1);
    expect(decisions(healthy.events)).toEqual([
      expect.objectContaining({ call_id: 'call-2', effect: 'allow', forwarded: true }),
    ]);
  });

  it('still answers a denied call when its decision cannot be recorded', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sink: AuditSink = {
      write() {
        throw new Error('disk full');
      },
    };
    const { proxy } = await start({ audit: sink });
    const writer = await connect(proxy);

    const result = await call(writer, 'mail__send', { to: 'attacker@evil.test', body: 'x' });
    expect(textOf(result)).toMatch(/^Denied by policy \(constraint_failed\): /);
    const hidden = await writer.callTool({ name: 'docs__publish', arguments: {} }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((hidden as ProtocolError).message).toBe('Tool docs__publish not found');
    expect(logged).toHaveBeenCalledTimes(2);
  });

  it('records upstream failures', async () => {
    const sink = memoryAuditSink();
    const { proxy, drop } = await start({
      audit: sink,
      handlers: {
        mail__send: () => {
          throw new Error('boom');
        },
      },
    });
    const writer = await connect(proxy);

    const failed = await call(writer, 'mail__send', TEAM_MAIL);
    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toMatch(/^Upstream error: /);
    expect(sink.events.at(-1)).toEqual({
      type: 'outcome',
      ts: ISO(1_000),
      call_id: 'call-1',
      ok: false,
      is_error: false,
      error: expect.stringContaining('boom'),
      duration_ms: 0,
    });

    await drop('web');
    const gone = await call(writer, 'web__fetch_page', { url: 'https://docs.example.test/a' });
    expect(gone.isError).toBe(true);
    expect(textOf(gone)).toMatch(/^Upstream error: /);
    expect(sink.events.at(-1)).toEqual(
      expect.objectContaining({ type: 'outcome', call_id: 'call-2', ok: false }),
    );
    expect((sink.events.at(-1) as { error?: string }).error).toBeTruthy();

    const other = await call(writer, 'docs__list_drafts', {});
    expect(other.isError).toBeFalsy();
    expect(sink.events.at(-1)).toEqual(
      expect.objectContaining({ type: 'outcome', call_id: 'call-3', ok: true }),
    );
  });

  it('logs what was listed', async () => {
    const sink = memoryAuditSink();
    const { proxy } = await start({ audit: sink });
    const writer = await connect(proxy);

    await writer.listTools();
    expect(sink.events).toEqual([
      {
        type: 'list',
        ts: ISO(1_000),
        session: 's1',
        identity: 'writer',
        tools: [
          'docs__create_draft',
          'docs__get_draft',
          'docs__list_drafts',
          'docs__update_draft',
          'mail__send',
          'web__fetch_page',
        ],
      },
    ]);
  });

  it('still lists when the list event cannot be recorded', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sink: AuditSink = {
      write() {
        throw new Error('disk full');
      },
    };
    const { proxy } = await start({ audit: sink });
    const writer = await connect(proxy);

    expect((await writer.listTools()).tools).toHaveLength(6);
    expect(logged).toHaveBeenCalledTimes(1);
  });
});
