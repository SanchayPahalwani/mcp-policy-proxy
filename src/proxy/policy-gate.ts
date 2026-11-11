import { randomUUID } from 'node:crypto';
import {
  ProtocolError,
  ProtocolErrorCode,
  type CallToolResult,
} from '@modelcontextprotocol/server';
import {
  denyApprover,
  type ApprovalOutcome,
  type Approver,
  type PendingApproval,
} from '../approval/types.js';
import type { AuditEvent, AuditSink } from '../audit/log.js';
import { redact } from '../audit/redact.js';
import { commit, decide, visible, type Call, type Decision } from '../policy/engine.js';
import { LimitState, type Clock } from '../policy/limits.js';
import type { Policy } from '../policy/load.js';
import {
  decisionEvent,
  errorLabel,
  internalErrorEvent,
  iso,
  listEvent,
  outcomeEvent,
  refusal,
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

/**
 * Asks the approver, but never waits longer than `timeoutMs`: an approver that ignores
 * the abort signal is left behind, and whatever it answers later is dropped.
 */
async function awaitApproval(
  approver: Approver,
  pending: PendingApproval,
  timeoutMs: number,
): Promise<ApprovalOutcome> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<ApprovalOutcome>((resolve) => {
    timer = setTimeout(() => {
      // Settled before aborting, so an approver that rejects on abort cannot win the race.
      resolve({ kind: 'timeout', timeoutMs });
      controller.abort(new Error('approval timed out'));
    }, timeoutMs);
  });
  const answer = (async (): Promise<ApprovalOutcome> => {
    try {
      const result = await approver.request(pending, controller.signal);
      return result.approved === true ? { kind: 'approved', result } : { kind: 'refused', result };
    } catch (error) {
      return { kind: 'error', error };
    }
  })();
  try {
    return await Promise.race([answer, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

type Admission =
  | { kind: 'forward'; callId: string }
  | { kind: 'refuse'; result: CallToolResult }
  | { kind: 'hidden' };

/** How far one call got, so a refusal caused by a throw can still be logged truthfully. */
interface Trace {
  callId?: string;
  decisionWritten: boolean;
  forwardedWritten: boolean;
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
  const approvalTimeoutMs = deps.approvalTimeoutMs ?? 120_000;

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
  const record = (build: () => AuditEvent): void => {
    try {
      write(build());
    } catch (e) {
      console.error('mcp-policy-proxy: audit write failed', e);
    }
  };

  // Synchronous on purpose: no await between decide and commit, otherwise two concurrent
  // calls could both see the same remaining slot and both be forwarded.
  const admit = (
    call: Call,
    callId: string,
    trace: Trace,
    decision: Decision,
    approval?: ApprovalOutcome,
  ): Admission => {
    // Checked before the effect, so a hidden tool can never be forwarded whatever it says.
    const refused = decision.visible ? refusal(decision, approval) : decision;
    const event = decisionEvent(policy, call, callId, decision, refused, approval);
    if (refused) {
      record(() => event);
      trace.decisionWritten = true;
      if (!decision.visible) return { kind: 'hidden' };
      return { kind: 'refuse', result: deniedResult(refused.code, refused.reason) };
    }
    try {
      write(event);
    } catch (e) {
      console.error('mcp-policy-proxy: audit write failed, call refused', e);
      return {
        kind: 'refuse',
        result: deniedResult('audit_failed', 'the decision could not be recorded'),
      };
    }
    trace.decisionWritten = true;
    trace.forwardedWritten = true;
    commit(state, call, decision);
    return { kind: 'forward', callId };
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
    trace: Trace,
    decision: Decision,
    outcome: ApprovalOutcome,
  ): Admission => {
    if (outcome.kind === 'error') console.error('mcp-policy-proxy: approver failed', outcome.error);
    const answered: Call = { ...call, at: clock() };
    if (outcome.kind !== 'approved') return admit(answered, callId, trace, decision, outcome);
    // Decided again: other calls may have used up a limit while this one waited.
    return admit(answered, callId, trace, decide(policy, state, answered), outcome);
  };

  // Best effort, after a throw: the log should still show that this call was refused.
  const recordFailure = (
    caller: Caller,
    target: { server: string; tool: string },
    trace: Trace,
  ) => {
    const now = () => {
      try {
        return clock();
      } catch {
        return Date.now();
      }
    };
    const callId = trace.callId ?? randomUUID();
    if (!trace.decisionWritten) {
      record(() => internalErrorEvent(policy, caller, target, callId, now()));
    } else if (trace.forwardedWritten) {
      const at = now();
      record(() =>
        outcomeEvent(policy, callId, at, at, {
          ok: false,
          isError: false,
          error: 'internal_error',
        }),
      );
    }
  };

  const forwardAndRecord = async (
    callId: string,
    startedAt: number,
    forward: () => Promise<CallToolResult>,
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
      outcome(false, false, errorLabel(e));
      // An unknown tool already speaks to the client; anything else becomes a readable result.
      if (e instanceof ProtocolError && e.code === ProtocolErrorCode.InvalidParams) throw e;
      return upstreamError(messageOf(e));
    }
  };

  return {
    filterTools(caller, tools) {
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
    },

    async callTool(caller, { server, tool, args }, forward) {
      const trace: Trace = { decisionWritten: false, forwardedWritten: false };
      let admission: Admission;
      let startedAt = 0;
      try {
        const callId = newId();
        trace.callId = callId;
        const { identity, session } = caller;
        const call: Call = { identity, session, server, tool, args, at: clock() };
        const decision = decide(policy, state, call);
        if (decision.effect === 'require_approval' && decision.visible) {
          const pending = pendingApproval(call, callId, decision);
          const outcome = await awaitApproval(approver, pending, approvalTimeoutMs);
          admission = admitAnswered(call, callId, trace, decision, outcome);
        } else {
          admission = admit(call, callId, trace, decision);
        }
        // Read after the audit write, so the duration is the upstream's alone.
        if (admission.kind === 'forward') startedAt = clock();
      } catch (e) {
        // Fail closed: a bug in evaluation must never turn into an allow.
        console.error('mcp-policy-proxy: policy evaluation failed', e);
        recordFailure(caller, { server, tool }, trace);
        return deniedResult('internal_error', 'policy evaluation failed');
      }
      // Hidden tools answer exactly like missing ones, so a caller cannot probe the policy.
      if (admission.kind === 'hidden') throw toolNotFound(joinName(server, tool));
      if (admission.kind === 'refuse') return admission.result;
      return forwardAndRecord(admission.callId, startedAt, forward);
    },
  };
}
