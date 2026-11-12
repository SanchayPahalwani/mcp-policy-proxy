import { randomUUID } from 'node:crypto';
import { ProtocolError } from '@modelcontextprotocol/server';
import type { ApprovalOutcome } from '../approval/wait.js';
import type { AuditEvent, DecisionEvent, ListEvent, OutcomeEvent } from '../audit/log.js';
import { redact } from '../audit/redact.js';
import type { Call, Decision } from '../policy/engine.js';
import type { Policy } from '../policy/load.js';
import type { Caller } from './gate.js';

export const iso = (ms: number) => new Date(ms).toISOString();

export interface Refusal {
  code: string;
  reason: string;
}

export const CLIENT_CANCELLED: Refusal = {
  code: 'client_cancelled',
  reason: 'the client gave up before the call was cleared',
};

/** The approver was asked at `requestedAt`; absent when the call never reached it. */
export interface ApprovalStep {
  outcome: ApprovalOutcome;
  requestedAt?: string;
}

const INTERNAL_ERROR: Refusal = { code: 'internal_error', reason: 'policy evaluation failed' };

function approvalRefusal(outcome: ApprovalOutcome | undefined): Refusal | undefined {
  switch (outcome?.kind) {
    case 'approved':
      return undefined;
    case 'refused': {
      const { note } = outcome.result;
      return { code: 'approval_denied', reason: `approval was refused${note ? `: ${note}` : ''}` };
    }
    case 'timeout':
      return {
        code: 'approval_timeout',
        reason: `no answer within ${outcome.timeoutMs / 1000} seconds`,
      };
    case 'error':
      return { code: 'approval_error', reason: 'the approver failed' };
    case 'cancelled':
      return CLIENT_CANCELLED;
    case undefined:
      // Only a gate bug gets here; an unasked approval must not pass as given.
      return INTERNAL_ERROR;
    default: {
      // A new outcome kind must be handled here before it can ever mean "forward".
      const unknown: never = outcome;
      console.error(`mcp-policy-proxy: unknown approval outcome ${String(unknown)}`);
      return INTERNAL_ERROR;
    }
  }
}

/**
 * Why a call that was decided is not forwarded, or undefined when it may be.
 * `approval` is how the wait ended, for a decision that needed one.
 */
export function refusal(decision: Decision, approval?: ApprovalStep): Refusal | undefined {
  switch (decision.effect) {
    case 'allow':
      return undefined;
    case 'deny':
      return { code: decision.code, reason: decision.reason };
    case 'require_approval':
      return approvalRefusal(approval?.outcome);
    default: {
      // A new effect must be handled here before it can ever be forwarded.
      const unknown: never = decision.effect;
      console.error(`mcp-policy-proxy: unknown policy effect ${String(unknown)}`);
      return { code: 'internal_error', reason: 'policy evaluation failed' };
    }
  }
}

export function decisionEvent(
  policy: Policy,
  run: string,
  call: Call,
  callId: string,
  decision: Decision,
  refused: Refusal | undefined,
  approval?: ApprovalStep,
): DecisionEvent {
  const forwarded = refused === undefined;
  // A timeout or a failed approver gave no answer, so there is nothing to record for it.
  const outcome = approval?.outcome;
  const answer = outcome?.kind === 'approved' || outcome?.kind === 'refused' ? outcome : undefined;
  const approved = forwarded && answer?.kind === 'approved';
  const by = answer?.result.approver;
  const approvedReason = `${decision.reason}: approved${by ? ` by ${by}` : ''}`;
  return {
    type: 'decision',
    ts: iso(call.at),
    run,
    call_id: callId,
    session: call.session,
    identity: call.identity,
    server: call.server,
    tool: call.tool,
    args: redact(call.args, policy.redactKeys),
    effect: forwarded ? 'allow' : 'deny',
    code: refused?.code ?? (approved ? 'approved' : decision.code),
    ...(decision.rule !== undefined && { rule: decision.rule }),
    reason: refused?.reason ?? (approved ? approvedReason : decision.reason),
    visible: decision.visible,
    ...(approval?.requestedAt !== undefined && { approval_requested_at: approval.requestedAt }),
    // Already normalised by the wait, so it is copied as is.
    ...(answer && { approval: { ...answer.result } }),
    forwarded,
    policy_sha256: policy.sha256,
  };
}

export function outcomeEvent(
  policy: Policy,
  run: string,
  callId: string,
  startedAt: number,
  now: number,
  result: { ok: boolean; isError: boolean; error?: string },
): OutcomeEvent {
  return {
    type: 'outcome',
    ts: iso(now),
    run,
    call_id: callId,
    ok: result.ok,
    is_error: result.isError,
    ...(result.error !== undefined && { error: result.error }),
    duration_ms: now - startedAt,
    policy_sha256: policy.sha256,
  };
}

/**
 * What a failed forward is logged as. Never the message, the class or a free-form code:
 * the upstream chooses all three and could make one carry a value redaction removed.
 * The JSON-RPC reserved range is small and fixed, so a code from it reveals nothing.
 */
export function errorLabel(e: unknown): string {
  if (
    e instanceof ProtocolError &&
    Number.isInteger(e.code) &&
    e.code >= -32768 &&
    e.code <= -32000
  ) {
    return `protocol_error ${e.code}`;
  }
  return 'error';
}

/** For a call refused because something threw; `args` are left out, as they may be the cause. */
export function internalErrorEvent(
  policy: Policy,
  run: string,
  caller: Caller,
  target: { server: string; tool: string },
  callId: string,
  now: number,
  approval?: ApprovalStep,
): DecisionEvent {
  const outcome = approval?.outcome;
  const answer = outcome?.kind === 'approved' || outcome?.kind === 'refused' ? outcome : undefined;
  return {
    type: 'decision',
    ts: iso(now),
    run,
    call_id: callId,
    session: caller.session,
    identity: caller.identity,
    server: target.server,
    tool: target.tool,
    args: null,
    effect: 'deny',
    code: 'internal_error',
    reason: 'policy evaluation failed',
    visible: false,
    ...(approval?.requestedAt !== undefined && { approval_requested_at: approval.requestedAt }),
    ...(answer && { approval: { ...answer.result } }),
    forwarded: false,
    policy_sha256: policy.sha256,
  };
}

/** How far one call got, so a refusal caused by a throw can still be logged truthfully. */
export interface CallProgress {
  callId?: string;
  decisionWritten: boolean;
  forwardedWritten: boolean;
  /** Set once the approver has been asked, so a later throw still logs that it was. */
  approval?: ApprovalStep;
}

/**
 * The event still owed for a call that ended in a throw: a refusal if no decision was
 * written, a failed outcome if the call was cleared, and nothing if the refusal is logged.
 */
export function failureEvent(
  policy: Policy,
  run: string,
  caller: Caller,
  target: { server: string; tool: string },
  progress: CallProgress,
  clock: () => number,
): AuditEvent | undefined {
  let now: number;
  try {
    now = clock();
  } catch {
    // The clock may be what threw; the event is worth more than its timestamp.
    now = Date.now();
  }
  const callId = progress.callId ?? randomUUID();
  if (!progress.decisionWritten) {
    return internalErrorEvent(policy, run, caller, target, callId, now, progress.approval);
  }
  if (!progress.forwardedWritten) return undefined;
  return outcomeEvent(policy, run, callId, now, now, {
    ok: false,
    isError: false,
    error: 'internal_error',
  });
}

/** `code` is set only for a listing that failed closed, which shows no tools. */
export function listEvent(
  policy: Policy,
  run: string,
  caller: Caller,
  now: number,
  names: string[],
  code?: string,
): ListEvent {
  return {
    type: 'list',
    ts: iso(now),
    run,
    session: caller.session,
    identity: caller.identity,
    tools: [...names].sort(),
    ...(code !== undefined && { code }),
    policy_sha256: policy.sha256,
  };
}
