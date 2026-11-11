import type { LimitState } from './limits.js';
import type { CompiledRule, Policy } from './load.js';
import type { Effect } from './schema.js';

export interface Call {
  identity: string;
  session: string;
  server: string;
  tool: string;
  args: Record<string, unknown>;
  at: number;
}

export type DecisionCode =
  | 'allowed'
  | 'approval_required'
  | 'denied_by_rule'
  | 'no_matching_rule'
  | 'constraint_failed'
  | 'limit_exceeded';

export interface Decision {
  effect: Effect;
  code: DecisionCode;
  rule?: string;
  reason: string;
  applied: string[];
  visible: boolean;
}

function denyRule(policy: Policy, identity: string, server: string, tool: string) {
  return policy.rules.find((r) => r.spec.effect === 'deny' && r.matches(identity, server, tool));
}

function permittingRules(policy: Policy, identity: string, server: string, tool: string) {
  return policy.rules.filter((r) => r.spec.effect !== 'deny' && r.matches(identity, server, tool));
}

export function visible(policy: Policy, identity: string, server: string, tool: string): boolean {
  return (
    denyRule(policy, identity, server, tool) === undefined &&
    permittingRules(policy, identity, server, tool).length > 0
  );
}

function exhaustion(rule: CompiledRule, state: LimitState, call: Call): string | undefined {
  const { per_session, per_minute } = rule.spec.limits ?? {};
  const id = rule.spec.id;
  if (
    per_session !== undefined &&
    state.sessionCount(id, call.identity, call.session) >= per_session
  ) {
    return `rule "${id}": limit of ${per_session} calls per session reached`;
  }
  if (per_minute !== undefined && state.minuteCount(id, call.identity, call.at) >= per_minute) {
    return `rule "${id}": limit of ${per_minute} calls per minute reached`;
  }
  return undefined;
}

export function decide(policy: Policy, state: LimitState, call: Call): Decision {
  const { identity, server, tool } = call;
  const deny = (
    code: DecisionCode,
    reason: string,
    isVisible: boolean,
    rule?: string,
  ): Decision => ({
    effect: 'deny',
    code,
    ...(rule === undefined ? {} : { rule }),
    reason,
    applied: [],
    visible: isVisible,
  });

  // 1. Deny is checked first so that no allow rule, however broad, can weaken it.
  const denied = denyRule(policy, identity, server, tool);
  if (denied) {
    const why = denied.spec.reason === undefined ? '' : `: ${denied.spec.reason}`;
    return deny(
      'denied_by_rule',
      `rule "${denied.spec.id}" denies ${server}.${tool} for "${identity}"${why}`,
      false,
      denied.spec.id,
    );
  }

  // 2. Default deny: with no permitting rule the tool stays hidden too.
  const candidates = permittingRules(policy, identity, server, tool);
  if (candidates.length === 0) {
    return deny(
      'no_matching_rule',
      `no rule allows "${identity}" to call ${server}.${tool}`,
      false,
    );
  }

  // 3. A rule whose constraints fail is dropped, not fatal: another may still permit the call.
  const kept: CompiledRule[] = [];
  const failures: string[] = [];
  for (const rule of candidates) {
    const failed = rule.constraints.map((c) => c.test(call.args)).find((r) => !r.pass);
    if (failed && !failed.pass) failures.push(`rule "${rule.spec.id}": ${failed.why}`);
    else kept.push(rule);
  }
  if (kept.length === 0) {
    return deny('constraint_failed', `arguments rejected: ${failures.join('; ')}`, true);
  }

  // 4. Every kept rule's limit must hold, so a narrow rule can tighten a broad one.
  for (const rule of kept) {
    const reason = exhaustion(rule, state, call);
    if (reason !== undefined) return deny('limit_exceeded', reason, true, rule.spec.id);
  }

  // 5. The stricter effect wins: any require_approval beats allow.
  const applied = kept.map((r) => r.spec.id);
  const approval = kept.find((r) => r.spec.effect === 'require_approval');
  if (approval) {
    return {
      effect: 'require_approval',
      code: 'approval_required',
      rule: approval.spec.id,
      reason: `rule "${approval.spec.id}" requires approval`,
      applied,
      visible: true,
    };
  }
  const first = applied[0] as string;
  return {
    effect: 'allow',
    code: 'allowed',
    rule: first,
    reason: `allowed by rule "${first}"`,
    applied,
    visible: true,
  };
}

export function commit(state: LimitState, call: Call, decision: Decision): void {
  for (const id of decision.applied) state.record(id, call.identity, call.session, call.at);
}
