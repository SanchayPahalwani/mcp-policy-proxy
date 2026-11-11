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

/** Why a call that was decided is not forwarded, or undefined when it may be. */
export function refusal(decision: Decision): Refusal | undefined {
  switch (decision.effect) {
    case 'allow':
      return undefined;
    case 'deny':
      return { code: decision.code, reason: decision.reason };
    case 'require_approval':
      return {
        code: 'approval_unavailable',
        reason: 'this call needs approval and no approver is configured',
      };
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
  call: Call,
  callId: string,
  decision: Decision,
  refused: Refusal | undefined,
): DecisionEvent {
  const forwarded = refused === undefined;
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
    code: refused?.code ?? decision.code,
    ...(decision.rule !== undefined && { rule: decision.rule }),
    reason: refused?.reason ?? decision.reason,
    visible: decision.visible,
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
