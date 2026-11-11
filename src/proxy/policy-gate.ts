import { randomUUID } from 'node:crypto';
import {
  ProtocolError,
  ProtocolErrorCode,
  type CallToolResult,
} from '@modelcontextprotocol/server';
import { denyApprover, type Approver, type PendingApproval } from '../approval/types.js';
import { awaitApproval } from '../approval/wait.js';
import type { AuditEvent, AuditSink } from '../audit/log.js';
import { withSpan } from '../audit/otel.js';
import { redact } from '../audit/redact.js';
import { commit, decide, visible, type Call, type Decision } from '../policy/engine.js';
import { LimitState, type Clock } from '../policy/limits.js';
import type { Policy } from '../policy/load.js';
import {
  CLIENT_CANCELLED,
  decisionEvent,
  errorLabel,
  failureEvent,
  iso,
  listEvent,
  outcomeEvent,
  refusal,
  type ApprovalStep,
  type CallProgress,
} from './audit-events.js';
import { deniedResult, toolNotFound, type Caller, type Gate } from './gate.js';
import { joinName } from './names.js';
import type { UpstreamTool } from './upstreams.js';

export interface PolicyGateDeps {
  policy: Policy;
  state?: LimitState;
  clock?: Clock;
  audit?: AuditSink;
  newId?: () => string;
  /** Asked about every `require_approval` call; the default refuses them all. */
  approver?: Approver;
  approvalTimeoutMs?: number;
}

function upstreamError(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: `Upstream error: ${message}` }] };
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** `code` and `rule` are the call's final label, as its decision event records it. */
type Admission = (
  | { kind: 'forward'; callId: string }
  | { kind: 'refuse'; result: CallToolResult }
  | { kind: 'hidden' }
) & { code: string; rule?: string };

/** What a call's span reports, filled in as the call goes and read when it settles. */
interface CallEnding {
  code: string;
  rule?: string;
  forwarded: boolean;
  upstreamFailed: boolean;
}

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof (value as { then?: unknown } | null | undefined)?.then === 'function';

export function policyGate(deps: PolicyGateDeps): Gate {
  const { policy } = deps;
  const state = deps.state ?? new LimitState();
  const clock = deps.clock ?? Date.now;
  const audit = deps.audit;
  const newId = deps.newId ?? randomUUID;
  const approver = deps.approver ?? denyApprover;
  // Under the MCP SDK client's default request timeout of 60 s, so that with default
  // settings the agent hears the refusal instead of giving up first.
  const approvalTimeoutMs = deps.approvalTimeoutMs ?? 55_000;
  // setTimeout's ceiling: a longer delay would silently fire at once, which is no wait at all.
  if (
    !Number.isFinite(approvalTimeoutMs) ||
    approvalTimeoutMs <= 0 ||
    approvalTimeoutMs > 2_147_483_647
  ) {
    throw new RangeError('approvalTimeoutMs must be a number in (0, 2147483647]');
  }

  const write = (event: AuditEvent): void => {
    if (!audit) return;
    const returned: unknown = audit.write(event);
    if (isThenable(returned)) {
      // The write may still fail later; nothing would be listening for it.
      returned.then(undefined, () => {});
      throw new Error('audit sink returned a promise: writes must be synchronous');
    }
  };

  // For events whose loss must not change the answer: the call was refused or already made.
  const record = (build: () => AuditEvent | undefined): void => {
    try {
      const event = build();
      if (event) write(event);
    } catch (e) {
      console.error('mcp-policy-proxy: audit write failed', e);
    }
  };

  // Synchronous on purpose: no await between decide and commit, otherwise two concurrent
  // calls could both see the same remaining slot and both be forwarded.
  const admit = (
    call: Call,
    callId: string,
    progress: CallProgress,
    decision: Decision,
    signal: AbortSignal | undefined,
    approval?: ApprovalStep,
  ): Admission => {
    const cancelled = signal?.aborted === true;
    // Checked before the effect, so a hidden tool can never be forwarded whatever it says.
    // After an approval wait a gone client overrides every answer; otherwise a deny keeps
    // its own code and only a call that would be forwarded is recorded as cancelled.
    const refused = !decision.visible
      ? decision
      : cancelled && approval !== undefined
        ? CLIENT_CANCELLED
        : (refusal(decision, approval) ?? (cancelled ? CLIENT_CANCELLED : undefined));
    const event = decisionEvent(policy, call, callId, decision, refused, approval);
    const label = { code: event.code, ...(event.rule !== undefined && { rule: event.rule }) };
    if (refused) {
      record(() => event);
      progress.decisionWritten = true;
      if (!decision.visible) return { kind: 'hidden', ...label };
      return { kind: 'refuse', result: deniedResult(refused.code, refused.reason), ...label };
    }
    try {
      write(event);
    } catch (e) {
      console.error('mcp-policy-proxy: audit write failed, call refused', e);
      return {
        kind: 'refuse',
        result: deniedResult('audit_failed', 'the decision could not be recorded'),
        ...label,
        code: 'audit_failed',
      };
    }
    progress.decisionWritten = true;
    progress.forwardedWritten = true;
    commit(state, call, decision);
    return { kind: 'forward', callId, ...label };
  };

  const pendingApproval = (call: Call, callId: string, decision: Decision): PendingApproval => ({
    call_id: callId,
    identity: call.identity,
    session: call.session,
    server: call.server,
    tool: call.tool,
    args: redact(call.args, policy.redactKeys),
    rule: decision.rule ?? '',
    reason: decision.reason,
    requested_at: iso(call.at),
  });

  // Synchronous, like admit: limits are checked again and committed in the same tick.
  const admitAnswered = (
    call: Call,
    callId: string,
    progress: CallProgress,
    decision: Decision,
    signal: AbortSignal | undefined,
    approval: ApprovalStep,
  ): Admission => {
    const { outcome } = approval;
    if (outcome.kind === 'error') console.error('mcp-policy-proxy: approver failed', outcome.error);
    const answered: Call = { ...call, at: clock() };
    if (outcome.kind !== 'approved' || signal?.aborted) {
      return admit(answered, callId, progress, decision, signal, approval);
    }
    // Decided again: other calls may have used up a limit while this one waited.
    return admit(answered, callId, progress, decide(policy, state, answered), signal, approval);
  };

  const forwardAndRecord = async (
    callId: string,
    startedAt: number,
    forward: () => Promise<CallToolResult>,
    ending: CallEnding,
  ): Promise<CallToolResult> => {
    const outcome = (ok: boolean, isError: boolean, error?: string) =>
      record(() =>
        outcomeEvent(policy, callId, startedAt, clock(), {
          ok,
          isError,
          ...(error !== undefined && { error }),
        }),
      );
    try {
      const result = await forward();
      outcome(true, result.isError === true);
      return result;
    } catch (e) {
      ending.upstreamFailed = true;
      outcome(false, false, errorLabel(e));
      // An unknown tool already speaks to the client; anything else becomes a readable result.
      if (e instanceof ProtocolError && e.code === ProtocolErrorCode.InvalidParams) throw e;
      return upstreamError(messageOf(e));
    }
  };

  const listVisible = (caller: Caller, tools: UpstreamTool[]): UpstreamTool[] => {
    let shown: UpstreamTool[];
    try {
      shown = tools.filter((t) => visible(policy, caller.identity, t.server, t.tool.name));
    } catch (e) {
      console.error('mcp-policy-proxy: policy evaluation failed while listing', e);
      return [];
    }
    record(() =>
      listEvent(
        policy,
        caller,
        clock(),
        shown.map((t) => joinName(t.server, t.tool.name)),
      ),
    );
    return shown;
  };

  const gatedCall = async (
    caller: Caller,
    { server, tool, args }: { server: string; tool: string; args: Record<string, unknown> },
    forward: () => Promise<CallToolResult>,
    signal: AbortSignal | undefined,
    ending: CallEnding,
  ): Promise<CallToolResult> => {
    const progress: CallProgress = { decisionWritten: false, forwardedWritten: false };
    let admission: Admission;
    let startedAt = 0;
    try {
      const callId = newId();
      progress.callId = callId;
      const { identity, session } = caller;
      const call: Call = { identity, session, server, tool, args, at: clock() };
      const decision = decide(policy, state, call);
      if (decision.effect === 'require_approval' && decision.visible) {
        const pending = pendingApproval(call, callId, decision);
        const outcome = await awaitApproval(approver, pending, approvalTimeoutMs, signal);
        admission = admitAnswered(call, callId, progress, decision, signal, {
          outcome,
          requestedAt: pending.requested_at,
        });
      } else {
        admission = admit(call, callId, progress, decision, signal);
      }
      // Read after the audit write, so the duration is the upstream's alone.
      if (admission.kind === 'forward') startedAt = clock();
    } catch (e) {
      // Fail closed: a bug in evaluation must never turn into an allow.
      console.error('mcp-policy-proxy: policy evaluation failed', e);
      // Best effort: the log should still show that this call was refused.
      record(() => failureEvent(policy, caller, { server, tool }, progress, clock));
      return deniedResult('internal_error', 'policy evaluation failed');
    }
    ending.code = admission.code;
    if (admission.rule !== undefined) ending.rule = admission.rule;
    // Hidden tools answer exactly like missing ones, so a caller cannot probe the policy.
    if (admission.kind === 'hidden') throw toolNotFound(joinName(server, tool));
    if (admission.kind === 'refuse') return admission.result;
    ending.forwarded = true;
    return forwardAndRecord(admission.callId, startedAt, forward, ending);
  };

  // Spans carry names and decision labels only: argument values and upstream text stay out.
  return {
    filterTools: (caller, tools) => {
      let shown: UpstreamTool[] = [];
      return withSpan(
        'tools_list',
        { identity: caller.identity, session: caller.session },
        () => (shown = listVisible(caller, tools)),
        () => ({
          fields: { tools_listed: shown.length, tools_hidden: tools.length - shown.length },
        }),
      );
    },

    callTool: (caller, target, forward, opts) => {
      const ending: CallEnding = {
        code: 'internal_error',
        forwarded: false,
        upstreamFailed: false,
      };
      const { identity, session } = caller;
      return withSpan(
        'tool_call',
        { identity, session, server: target.server, tool: target.tool },
        () => gatedCall(caller, target, forward, opts?.signal, ending),
        () => ({
          fields: {
            effect: ending.forwarded ? 'allow' : 'deny',
            code: ending.code,
            rule: ending.rule,
            forwarded: ending.forwarded,
          },
          failed: ending.upstreamFailed,
        }),
      );
    },
  };
}
