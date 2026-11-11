import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import {
  fixedApprover,
  type Approver,
  type ApprovalResult,
  type PendingApproval,
} from '../../src/approval/types.js';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { memoryAuditSink, type AuditEvent, type DecisionEvent } from '../../src/audit/log.js';
import type { Decision } from '../../src/policy/engine.js';
import { loadPolicy, parsePolicy, type Policy } from '../../src/policy/load.js';
import { sha256Hex, staticTokenAuthenticator } from '../../src/proxy/auth.js';
import { refusal } from '../../src/proxy/audit-events.js';
import { startHttpProxy, type RunningProxy } from '../../src/proxy/http.js';
import { policyGate } from '../../src/proxy/policy-gate.js';
import { Upstreams } from '../../src/proxy/upstreams.js';
import { inMemoryUpstream, type MockCall } from '../helpers/mock-upstream.js';
import { call, connectAgent, textOf } from '../helpers/proxy-client.js';

const EXAMPLE = loadPolicy(fileURLToPath(new URL('../../examples/policy.yaml', import.meta.url)));
const ISO = (ms: number) => new Date(ms).toISOString();
const TEAM_MAIL = { to: 'team@example.test', body: 'hello' };

// Approval is asked for while the limit still has room; it is counted only once approved.
const APPROVE_ONE_SEND = parsePolicy(`
version: 1
rules:
  - id: approve-send
    identities: [writer]
    server: mail
    tools: [send]
    effect: require_approval
    limits:
      per_session: 1
`);

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

interface Harness {
  proxy: RunningProxy;
  calls: Record<'docs' | 'mail', MockCall[]>;
  events: AuditEvent[];
  clock: { now: number };
}

async function start(
  opts: { policy?: Policy; approver?: Approver; approvalTimeoutMs?: number } = {},
): Promise<Harness> {
  const calls = { docs: [] as MockCall[], mail: [] as MockCall[] };
  const clock = { now: 1_000 };
  const sink = memoryAuditSink();
  const upstreams = await Upstreams.connect([
    inMemoryUpstream('docs', [{ name: 'publish' }, { name: 'get_draft' }], calls.docs),
    inMemoryUpstream('mail', [{ name: 'send' }], calls.mail),
  ]);
  cleanups.push(() => upstreams.close());
  let ids = 0;
  const proxy = await startHttpProxy({
    upstreams,
    gate: policyGate({
      policy: opts.policy ?? EXAMPLE,
      audit: sink,
      clock: () => clock.now,
      newId: () => `call-${++ids}`,
      ...(opts.approver && { approver: opts.approver }),
      ...(opts.approvalTimeoutMs !== undefined && { approvalTimeoutMs: opts.approvalTimeoutMs }),
    }),
    authenticator: staticTokenAuthenticator([
      { name: 'writer', token_sha256: sha256Hex('tok-writer') },
      { name: 'release-manager', token_sha256: sha256Hex('tok-release') },
    ]),
  });
  cleanups.push(() => proxy.close());
  return { proxy, calls, events: sink.events, clock };
}

async function connect(proxy: RunningProxy, token: string, session = 's1'): Promise<Client> {
  const client = await connectAgent(proxy, token, session);
  cleanups.push(() => client.close());
  return client;
}

function decisions(events: AuditEvent[]): DecisionEvent[] {
  return events.filter((e): e is DecisionEvent => e.type === 'decision');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('approval gate', () => {
  it('forwards an approved call and records the approval', async () => {
    const asked: PendingApproval[] = [];
    let harness: Harness | undefined;
    const approver = fixedApprover((pending) => {
      asked.push(pending);
      // Time passes while the human thinks; the decision is taken when they answer.
      if (harness) harness.clock.now += 5_000;
      return { approved: true, approver: 'test' };
    });
    harness = await start({ approver });
    const { proxy, calls, events } = harness;
    const release = await connect(proxy, 'tok-release');

    const result = await call(release, 'docs__publish', { id: 7, token: 'hunter2' });
    expect(result.isError).toBeFalsy();
    expect(calls.docs).toEqual([{ tool: 'publish', args: { id: 7, token: 'hunter2' } }]);

    expect(asked).toEqual([
      {
        call_id: 'call-1',
        identity: 'release-manager',
        session: 's1',
        server: 'docs',
        tool: 'publish',
        args: { id: 7, token: '[REDACTED]' },
        rule: 'release-publish',
        reason: 'rule "release-publish" requires approval',
        requested_at: ISO(1_000),
      },
    ]);
    expect(decisions(events)).toEqual([
      {
        type: 'decision',
        ts: ISO(6_000),
        call_id: 'call-1',
        session: 's1',
        identity: 'release-manager',
        server: 'docs',
        tool: 'publish',
        args: { id: 7, token: '[REDACTED]' },
        effect: 'allow',
        code: 'approved',
        rule: 'release-publish',
        reason: 'rule "release-publish" requires approval: approved by test',
        visible: true,
        approval_requested_at: ISO(1_000),
        approval: { approved: true, approver: 'test' },
        forwarded: true,
        policy_sha256: EXAMPLE.sha256,
      },
    ]);
    expect(events.at(-1)).toEqual(
      expect.objectContaining({ type: 'outcome', call_id: 'call-1', ok: true }),
    );
  });

  it('refuses when the approver says no', async () => {
    const { proxy, calls, events } = await start({
      approver: fixedApprover(() => ({ approved: false, approver: 'test', note: 'not today' })),
    });
    const release = await connect(proxy, 'tok-release');

    const result = await call(release, 'docs__publish', { id: 7 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      'Denied by policy (approval_denied): approval was refused: not today',
    );
    expect(calls.docs).toEqual([]);
    expect(decisions(events)).toEqual([
      expect.objectContaining({
        effect: 'deny',
        code: 'approval_denied',
        rule: 'release-publish',
        reason: 'approval was refused: not today',
        approval: { approved: false, approver: 'test', note: 'not today' },
        forwarded: false,
      }),
    ]);
  });

  it('refuses when no answer comes in time, and aborts the request', async () => {
    let seen: AbortSignal | undefined;
    const approver: Approver = {
      request: (_pending, signal) => {
        seen = signal;
        return new Promise<ApprovalResult>(() => {});
      },
    };
    const { proxy, calls, events } = await start({ approver, approvalTimeoutMs: 30 });
    const release = await connect(proxy, 'tok-release');

    const result = await call(release, 'docs__publish', { id: 7 });
    expect(textOf(result)).toBe(
      'Denied by policy (approval_timeout): no answer within 0.03 seconds',
    );
    expect(seen?.aborted).toBe(true);
    expect(calls.docs).toEqual([]);
    expect(decisions(events)).toEqual([
      expect.objectContaining({
        code: 'approval_timeout',
        approval_requested_at: ISO(1_000),
        forwarded: false,
      }),
    ]);
  });

  it('names the timeout in seconds without trailing zeros', () => {
    const decision: Decision = {
      effect: 'require_approval',
      code: 'approval_required',
      rule: 'release-publish',
      reason: 'rule "release-publish" requires approval',
      applied: ['release-publish'],
      visible: true,
    };
    expect(refusal(decision, { outcome: { kind: 'timeout', timeoutMs: 120_000 } })?.reason).toBe(
      'no answer within 120 seconds',
    );
    expect(refusal(decision, { outcome: { kind: 'timeout', timeoutMs: 1_500 } })?.reason).toBe(
      'no answer within 1.5 seconds',
    );
  });

  it('ignores an approval that arrives after the timeout', async () => {
    const approver = fixedApprover(async () => {
      await sleep(60);
      return { approved: true };
    });
    const { proxy, calls } = await start({ approver, approvalTimeoutMs: 30 });
    const release = await connect(proxy, 'tok-release');

    const result = await call(release, 'docs__publish', { id: 7 });
    expect(textOf(result)).toMatch(/^Denied by policy \(approval_timeout\): /);
    await sleep(60);
    expect(calls.docs).toEqual([]);
  });

  it('refuses when the approver fails', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const approver = fixedApprover(() => {
      throw new Error('webhook down');
    });
    const { proxy, calls, events } = await start({ approver });
    const release = await connect(proxy, 'tok-release');

    const result = await call(release, 'docs__publish', { id: 7 });
    expect(textOf(result)).toBe('Denied by policy (approval_error): the approver failed');
    expect(calls.docs).toEqual([]);
    expect(logged).toHaveBeenCalled();
    expect(decisions(events)).toEqual([
      expect.objectContaining({ code: 'approval_error', forwarded: false }),
    ]);
  });

  it('refuses by default, when no approver is configured', async () => {
    const { proxy, calls, events } = await start();
    const release = await connect(proxy, 'tok-release');

    const result = await call(release, 'docs__publish', { id: 7 });
    expect(textOf(result)).toBe(
      'Denied by policy (approval_denied): approval was refused: no approver configured',
    );
    expect(calls.docs).toEqual([]);
    expect(decisions(events)).toEqual([
      expect.objectContaining({
        code: 'approval_denied',
        approval: { approved: false, note: 'no approver configured' },
      }),
    ]);
  });

  it('never asks about a call the caller cannot see', async () => {
    const asked: PendingApproval[] = [];
    const approver = fixedApprover((pending) => {
      asked.push(pending);
      return { approved: true };
    });
    const { proxy, calls } = await start({ approver });
    const writer = await connect(proxy, 'tok-writer');

    const error = await writer.callTool({ name: 'docs__publish', arguments: {} }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((error as Error).message).toBe('Tool docs__publish not found');
    expect(asked).toEqual([]);
    expect(calls.docs).toEqual([]);
  });

  it('a limit used up while waiting still holds', async () => {
    const approver = fixedApprover(async () => {
      await sleep(20);
      return { approved: true, approver: 'test' };
    });
    const { proxy, calls, events } = await start({ policy: APPROVE_ONE_SEND, approver });
    const writer = await connect(proxy, 'tok-writer');

    const results = await Promise.all([
      call(writer, 'mail__send', TEAM_MAIL),
      call(writer, 'mail__send', TEAM_MAIL),
    ]);
    expect(calls.mail).toHaveLength(1);
    expect(results.filter((r) => !r.isError)).toHaveLength(1);
    const denied = results.filter((r) => r.isError).map(textOf);
    expect(denied).toEqual([expect.stringMatching(/^Denied by policy \(limit_exceeded\): /)]);
    expect(decisions(events)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'approved', forwarded: true }),
        expect.objectContaining({
          code: 'limit_exceeded',
          rule: 'approve-send',
          approval: { approved: true, approver: 'test' },
          forwarded: false,
        }),
      ]),
    );
  });

  it('limits are not consumed by a timeout or a failed approver', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const answers: Array<() => Promise<ApprovalResult>> = [
      () => new Promise<ApprovalResult>(() => {}),
      () => Promise.reject(new Error('webhook down')),
      async () => ({ approved: true }),
    ];
    const approver: Approver = {
      request: () => (answers.shift() ?? (async () => ({ approved: false })))(),
    };
    const { proxy, calls } = await start({
      policy: APPROVE_ONE_SEND,
      approver,
      approvalTimeoutMs: 30,
    });
    const writer = await connect(proxy, 'tok-writer');

    expect(textOf(await call(writer, 'mail__send', TEAM_MAIL))).toMatch(/\(approval_timeout\)/);
    expect(textOf(await call(writer, 'mail__send', TEAM_MAIL))).toMatch(/\(approval_error\)/);
    expect((await call(writer, 'mail__send', TEAM_MAIL)).isError).toBeFalsy();
    expect(calls.mail).toHaveLength(1);
  });

  it('treats a malformed answer as an approver error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const approver = {
      request: async () => ({ approved: 'yes' }),
    } as unknown as Approver;
    const { proxy, calls, events } = await start({ approver });
    const release = await connect(proxy, 'tok-release');

    const result = await call(release, 'docs__publish', { id: 7 });
    expect(textOf(result)).toBe('Denied by policy (approval_error): the approver failed');
    expect(calls.docs).toEqual([]);
    expect(decisions(events)[0]).not.toHaveProperty('approval');
  });

  it('treats an approver that throws synchronously as an approver error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const approver: Approver = {
      request: () => {
        throw new Error('not even a promise');
      },
    };
    const { proxy, calls } = await start({ approver });
    const release = await connect(proxy, 'tok-release');

    const result = await call(release, 'docs__publish', { id: 7 });
    expect(textOf(result)).toBe('Denied by policy (approval_error): the approver failed');
    expect(calls.docs).toEqual([]);
  });

  it('keeps only known answer fields, cut to length', async () => {
    const approver = {
      request: async () => ({
        approved: false,
        approver: 'a'.repeat(300),
        note: 'n'.repeat(900),
        extra: 'dropped',
      }),
    } as unknown as Approver;
    const { proxy, events } = await start({ approver });
    const release = await connect(proxy, 'tok-release');

    await call(release, 'docs__publish', { id: 7 });
    expect(decisions(events)[0]?.approval).toEqual({
      approved: false,
      approver: 'a'.repeat(100),
      note: 'n'.repeat(500),
    });
  });

  it('rejects an approval timeout that is not a usable delay', () => {
    for (const approvalTimeoutMs of [0, -1, Number.NaN, Infinity, 2_147_483_648]) {
      expect(
        () => policyGate({ policy: EXAMPLE, approvalTimeoutMs }),
        String(approvalTimeoutMs),
      ).toThrow(RangeError);
    }
    expect(() => policyGate({ policy: EXAMPLE, approvalTimeoutMs: 2_147_483_647 })).not.toThrow();
  });

  it('limits are not consumed by refused approvals', async () => {
    const answers = [false, false, true];
    const approver = fixedApprover(() => ({ approved: answers.shift() ?? false }));
    const { proxy, calls } = await start({ policy: APPROVE_ONE_SEND, approver });
    const writer = await connect(proxy, 'tok-writer');

    expect(textOf(await call(writer, 'mail__send', TEAM_MAIL))).toMatch(/\(approval_denied\)/);
    expect(textOf(await call(writer, 'mail__send', TEAM_MAIL))).toMatch(/\(approval_denied\)/);
    expect((await call(writer, 'mail__send', TEAM_MAIL)).isError).toBeFalsy();
    expect(calls.mail).toHaveLength(1);

    // The approved call used the one slot, so the next is refused before anyone is asked.
    const after = await call(writer, 'mail__send', TEAM_MAIL);
    expect(textOf(after)).toMatch(/^Denied by policy \(limit_exceeded\): /);
  });
});

describe('a client that gives up', () => {
  const writer = { identity: 'writer', session: 's1' };
  const send = { server: 'mail', tool: 'send', args: TEAM_MAIL };
  const sent: CallToolResult = { content: [{ type: 'text', text: 'sent' }] };
  const CANCELLED =
    'Denied by policy (client_cancelled): the client gave up before the call was cleared';

  it('is not forwarded once approved, and uses no limit', async () => {
    let seen: AbortSignal | undefined;
    const answers: Array<(result: ApprovalResult) => void> = [];
    const approver: Approver = {
      request: (_pending, signal) => {
        seen ??= signal;
        return new Promise((resolve) => answers.push(resolve));
      },
    };
    const sink = memoryAuditSink();
    const gate = policyGate({ policy: APPROVE_ONE_SEND, audit: sink, approver });
    const forward = vi.fn(async () => sent);
    const client = new AbortController();

    const pending = gate.callTool(writer, send, forward, { signal: client.signal });
    await expect.poll(() => seen).toBeDefined();
    client.abort();
    expect(seen?.aborted).toBe(true);
    answers[0]?.({ approved: true, approver: 'test' });

    expect(textOf(await pending)).toBe(CANCELLED);
    expect(forward).not.toHaveBeenCalled();
    expect(decisions(sink.events)).toEqual([
      expect.objectContaining({
        effect: 'deny',
        code: 'client_cancelled',
        reason: 'the client gave up before the call was cleared',
        forwarded: false,
      }),
    ]);

    // per_session is 1: had the cancelled call been committed, this one would hit the limit.
    const next = gate.callTool(writer, send, forward, { signal: new AbortController().signal });
    await expect.poll(() => answers.length).toBe(2);
    answers[1]?.({ approved: true });
    expect(await next).toEqual(sent);
    expect(forward).toHaveBeenCalledTimes(1);
  });

  it('a client leaving while the approver answers wins over the answer', async () => {
    const client = new AbortController();
    const approver = fixedApprover(() => {
      // The client leaves inside the approver's call: the wait sees it before the answer.
      client.abort();
      return { approved: true, approver: 'test' };
    });
    const sink = memoryAuditSink();
    const gate = policyGate({ policy: APPROVE_ONE_SEND, audit: sink, approver });
    const forward = vi.fn(async () => sent);

    expect(textOf(await gate.callTool(writer, send, forward, { signal: client.signal }))).toBe(
      CANCELLED,
    );
    expect(forward).not.toHaveBeenCalled();
    expect(decisions(sink.events)).toEqual([expect.objectContaining({ code: 'client_cancelled' })]);
  });

  it('records the answer when the client leaves after it, and uses no limit', async () => {
    const client = new AbortController();
    const approver = fixedApprover(() => ({ approved: true, approver: 'test' }));
    let reads = 0;
    // The second reading is the gate's, right after the wait: the answer has already won,
    // and the client leaves before the gate goes on.
    const clock = () => {
      if (++reads === 2) client.abort();
      return 1_000;
    };
    const sink = memoryAuditSink();
    const gate = policyGate({ policy: APPROVE_ONE_SEND, audit: sink, approver, clock });
    const forward = vi.fn(async () => sent);

    expect(textOf(await gate.callTool(writer, send, forward, { signal: client.signal }))).toBe(
      CANCELLED,
    );
    expect(forward).not.toHaveBeenCalled();
    expect(decisions(sink.events)).toEqual([
      expect.objectContaining({
        code: 'client_cancelled',
        approval_requested_at: ISO(1_000),
        approval: { approved: true, approver: 'test' },
        forwarded: false,
      }),
    ]);

    const next = await gate.callTool(writer, send, forward, {
      signal: new AbortController().signal,
    });
    expect(next).toEqual(sent);
    expect(forward).toHaveBeenCalledTimes(1);
  });

  it('does not ask about a call whose client already left', async () => {
    const asked: PendingApproval[] = [];
    const approver = fixedApprover((pending) => {
      asked.push(pending);
      return { approved: true };
    });
    const sink = memoryAuditSink();
    const gate = policyGate({ policy: APPROVE_ONE_SEND, audit: sink, approver });
    const forward = vi.fn(async () => sent);

    const result = await gate.callTool(writer, send, forward, { signal: AbortSignal.abort() });
    expect(textOf(result)).toBe(CANCELLED);
    expect(asked).toEqual([]);
    expect(forward).not.toHaveBeenCalled();
    expect(decisions(sink.events)).toEqual([
      expect.objectContaining({ code: 'client_cancelled', forwarded: false }),
    ]);
    expect(decisions(sink.events)[0]).not.toHaveProperty('approval_requested_at');
  });

  it('an allowed call from a client that already left is not forwarded', async () => {
    const sink = memoryAuditSink();
    const gate = policyGate({ policy: EXAMPLE, audit: sink });
    const forward = vi.fn(async () => sent);

    const result = await gate.callTool(writer, send, forward, { signal: AbortSignal.abort() });
    expect(textOf(result)).toBe(CANCELLED);
    expect(forward).not.toHaveBeenCalled();
    expect(decisions(sink.events)).toEqual([
      expect.objectContaining({
        code: 'client_cancelled',
        rule: 'mail-team-only',
        forwarded: false,
      }),
    ]);
  });

  it('a client still waiting gets the normal flow', async () => {
    const sink = memoryAuditSink();
    const gate = policyGate({ policy: EXAMPLE, audit: sink });
    const forward = vi.fn(async () => sent);

    const result = await gate.callTool(writer, send, forward, {
      signal: new AbortController().signal,
    });
    expect(result).toEqual(sent);
    expect(forward).toHaveBeenCalledTimes(1);
    expect(decisions(sink.events)).toEqual([
      expect.objectContaining({ code: 'allowed', forwarded: true }),
    ]);
  });
});
