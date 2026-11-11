import { randomUUID } from 'node:crypto';
import {
  ProtocolError,
  ProtocolErrorCode,
  type CallToolResult,
} from '@modelcontextprotocol/server';
import type { AuditEvent, AuditSink } from '../audit/log.js';
import { commit, decide, visible, type Call } from '../policy/engine.js';
import { LimitState, type Clock } from '../policy/limits.js';
import type { Policy } from '../policy/load.js';
import { decisionEvent, listEvent, outcomeEvent, refusal } from './audit-events.js';
import { deniedResult, toolNotFound, type Caller, type Gate } from './gate.js';
import { joinName } from './names.js';
import type { UpstreamTool } from './upstreams.js';

export interface PolicyGateDeps {
  policy: Policy;
  state?: LimitState;
  clock?: Clock;
  audit?: AuditSink;
  newId?: () => string;
}

function upstreamError(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: `Upstream error: ${message}` }] };
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

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
    // From the decision's clock reading: nothing is awaited between it and forward().
    const outcome = (ok: boolean, isError: boolean, error?: string) =>
      record(() =>
        outcomeEvent(callId, call.at, clock(), {
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
      record(() =>
        listEvent(
          caller,
          clock(),
          shown.map((t) => joinName(t.server, t.tool.name)),
        ),
      );
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
