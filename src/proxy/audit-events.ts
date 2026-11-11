import type { ApprovalOutcome, ApprovalResult } from '../approval/types.js';
import type { DecisionEvent, ListEvent, OutcomeEvent } from '../audit/log.js';
import { redact } from '../audit/redact.js';
import type { Call, Decision } from '../policy/engine.js';
import type { Policy } from '../policy/load.js';
import type { Caller } from './gate.js';

export const iso = (ms: number) => new Date(ms).toISOString();

export interface Refusal {
  code: string;
  reason: string;
}

function approvalRefusal(outcome: ApprovalOutcome | undefined): Refusal | undefined {
  switch (outcome?.kind) {
    case 'approved':
      return undefined;
    case 'refused': {
      const { note } = outcome.result;
      const why = typeof note === 'string' && note !== '' ? `: ${note}` : '';
      return { code: 'approval_denied', reason: `approval was refused${why}` };
    }
    case 'timeout':
      return {
        code: 'approval_timeout',
        reason: `no answer within ${outcome.timeoutMs / 1000} seconds`,
      };
    case 'error':
      return { code: 'approval_error', reason: 'the approver failed' };
    case undefined:
      // Only a gate bug gets here; an unasked approval must not pass as given.
      return { code: 'internal_error', reason: 'policy evaluation failed' };
  }
}

/**
 * Why a call that was decided is not forwarded, or undefined when it may be.
 * `approval` is how the wait ended, for a decision that needed one.
 */
export function refusal(decision: Decision, approval?: ApprovalOutcome): Refusal | undefined {
  switch (decision.effect) {
    case 'allow':
      return undefined;
    case 'deny':
      return { code: decision.code, reason: decision.reason };
    case 'require_approval':
      return approvalRefusal(approval);
    default: {
      // A new effect must be handled here before it can ever be forwarded.
      const unknown: never = decision.effect;
      console.error(`mcp-policy-proxy: unknown policy effect ${String(unknown)}`);
      return { code: 'internal_error', reason: 'policy evaluation failed' };
    }
  }
}

// An approver is plugged-in code, so only the known fields, with the right types, reach the log.
function approvalRecord(result: ApprovalResult): NonNullable<DecisionEvent['approval']> {
  return {
    approved: result.approved === true,
    ...(typeof result.approver === 'string' && { approver: result.approver }),
    ...(typeof result.note === 'string' && { note: result.note }),
  };
}

export function decisionEvent(
  policy: Policy,
  call: Call,
  callId: string,
  decision: Decision,
  refused: Refusal | undefined,
  approval?: ApprovalOutcome,
): DecisionEvent {
  const forwarded = refused === undefined;
  // A timeout or a failed approver gave no answer, so there is nothing to record for it.
  const answer =
    approval?.kind === 'approved' || approval?.kind === 'refused' ? approval : undefined;
  const approved = forwarded && answer?.kind === 'approved';
  const by = answer?.result.approver;
  const approvedReason = `${decision.reason}: approved${by ? ` by ${by}` : ''}`;
  return {
    type: 'decision',
    ts: iso(call.at),
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
    ...(answer && { approval: approvalRecord(answer.result) }),
    forwarded,
    policy_sha256: policy.sha256,
  };
}

export function outcomeEvent(
  callId: string,
  startedAt: number,
  now: number,
  result: { ok: boolean; isError: boolean; error?: string },
): OutcomeEvent {
  return {
    type: 'outcome',
    ts: iso(now),
    call_id: callId,
    ok: result.ok,
    is_error: result.isError,
    ...(result.error !== undefined && { error: result.error }),
    duration_ms: now - startedAt,
  };
}

export function listEvent(caller: Caller, now: number, names: string[]): ListEvent {
  return {
    type: 'list',
    ts: iso(now),
    session: caller.session,
    identity: caller.identity,
    tools: [...names].sort(),
  };
}
