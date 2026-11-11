import { randomUUID } from 'node:crypto';
import {
  ProtocolError,
  ProtocolErrorCode,
  type CallToolResult,
} from '@modelcontextprotocol/server';
import type { AuditEvent, AuditSink, DecisionEvent } from '../audit/log.js';
import { redact } from '../audit/redact.js';
import { commit, decide, visible, type Call, type Decision } from '../policy/engine.js';
import { LimitState, type Clock } from '../policy/limits.js';
import type { Policy } from '../policy/load.js';
import { joinName } from './names.js';
import type { UpstreamTool } from './upstreams.js';

export interface Caller {
  identity: string;
  session: string;
}

export interface Gate {
  filterTools(caller: Caller, tools: UpstreamTool[]): UpstreamTool[];
  callTool(
    caller: Caller,
    target: { server: string; tool: string; args: Record<string, unknown> },
    forward: () => Promise<CallToolResult>,
  ): Promise<CallToolResult>;
}

export const passthroughGate: Gate = {
  filterTools: (_caller, tools) => tools,
  callTool: (_caller, _target, forward) => forward(),
};

export function toolNotFound(name: string): ProtocolError {
  return new ProtocolError(ProtocolErrorCode.InvalidParams, `Tool ${name} not found`);
}

export interface PolicyGateDeps {
  policy: Policy;
  state?: LimitState;
  clock?: Clock;
  audit?: AuditSink;
  newId?: () => string;
}

export function deniedResult(code: string, reason: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: `Denied by policy (${code}): ${reason}` }],
  };
}

function upstreamError(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: `Upstream error: ${message}` }] };
}

const iso = (ms: number) => new Date(ms).toISOString();
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface Refusal {
  code: string;
  reason: string;
}

/** Why a call that was decided is not forwarded, or undefined when it may be. */
function refusal(decision: Decision): Refusal | undefined {
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

function decisionEvent(
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

type Admission =
  | { kind: 'forward'; call: Call; callId: string }
  | { kind: 'refuse'; result: CallToolResult }
  | { kind: 'hidden' };

export function policyGate(deps: PolicyGateDeps): Gate {
  const { policy } = deps;
  const state = deps.state ?? new LimitState();
  const clock = deps.clock ?? Date.now;
  const audit = deps.audit;
  const newId = deps.newId ?? randomUUID;

  // For events whose loss must not change the answer: the call was refused or already made.
  const record = (build: () => AuditEvent): void => {
    if (!audit) return;
    try {
      audit.write(build());
    } catch (e) {
      console.error('mcp-policy-proxy: audit write failed', e);
    }
  };

  // Synchronous on purpose: no await between decide and commit, otherwise two concurrent
  // calls could both see the same remaining slot and both be forwarded.
  const admit = (caller: Caller, target: Pick<Call, 'server' | 'tool' | 'args'>): Admission => {
    const { identity, session } = caller;
    const call: Call = { identity, session, ...target, at: clock() };
    const decision = decide(policy, state, call);
    // Checked before the effect, so a hidden tool can never be forwarded whatever it says.
    const refused = decision.visible ? refusal(decision) : decision;
    const event = decisionEvent(policy, call, newId(), decision, refused);
    if (refused) {
      record(() => event);
      if (!decision.visible) return { kind: 'hidden' };
      return { kind: 'refuse', result: deniedResult(refused.code, refused.reason) };
    }
    try {
      audit?.write(event);
    } catch (e) {
      console.error('mcp-policy-proxy: audit write failed, call refused', e);
      return {
        kind: 'refuse',
        result: deniedResult('audit_failed', 'the decision could not be recorded'),
      };
    }
    commit(state, call, decision);
    return { kind: 'forward', call, callId: event.call_id };
  };

  const forwardAndRecord = async (
    { call, callId }: { call: Call; callId: string },
    forward: () => Promise<CallToolResult>,
  ): Promise<CallToolResult> => {
    const outcome = (ok: boolean, isError: boolean, error?: string) =>
      record(() => {
        const now = clock();
        return {
          type: 'outcome',
          ts: iso(now),
          call_id: callId,
          ok,
          is_error: isError,
          ...(error !== undefined && { error }),
          // From the decision's clock reading: nothing is awaited between it and forward().
          duration_ms: now - call.at,
        };
      });
    try {
      const result = await forward();
      outcome(true, result.isError === true);
      return result;
    } catch (e) {
      outcome(false, false, messageOf(e));
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
      record(() => ({
        type: 'list',
        ts: iso(clock()),
        session: caller.session,
        identity: caller.identity,
        tools: shown.map((t) => joinName(t.server, t.tool.name)).sort(),
      }));
      return shown;
    },

    async callTool(caller, { server, tool, args }, forward) {
      let admission: Admission;
      try {
        admission = admit(caller, { server, tool, args });
      } catch (e) {
        // Fail closed: a bug in evaluation must never turn into an allow.
        console.error('mcp-policy-proxy: policy evaluation failed', e);
        return deniedResult('internal_error', 'policy evaluation failed');
      }
      // Hidden tools answer exactly like missing ones, so a caller cannot probe the policy.
      if (admission.kind === 'hidden') throw toolNotFound(joinName(server, tool));
      if (admission.kind === 'refuse') return admission.result;
      return forwardAndRecord(admission, forward);
    },
  };
}
