import {
  ProtocolError,
  ProtocolErrorCode,
  type CallToolResult,
} from '@modelcontextprotocol/server';
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

async function forwardSafely(forward: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await forward();
  } catch (e) {
    // A protocol error from the upstream (an unknown tool, say) already speaks to the client.
    if (e instanceof ProtocolError) throw e;
    return upstreamError(e instanceof Error ? e.message : String(e));
  }
}

export function policyGate(deps: PolicyGateDeps): Gate {
  const { policy } = deps;
  const state = deps.state ?? new LimitState();
  const clock = deps.clock ?? Date.now;

  // Fail closed: a bug in evaluation must never turn into an allow.
  const evaluate = (call: Call): Decision | undefined => {
    try {
      return decide(policy, state, call);
    } catch (e) {
      console.error('mcp-policy-proxy: policy evaluation failed', e);
      return undefined;
    }
  };

  return {
    filterTools: (caller, tools) =>
      tools.filter((t) => visible(policy, caller.identity, t.server, t.tool.name)),

    async callTool(caller, { server, tool, args }, forward) {
      const { identity, session } = caller;
      const call: Call = { identity, session, server, tool, args, at: clock() };
      const decision = evaluate(call);
      if (!decision) return deniedResult('internal_error', 'policy evaluation failed');
      // Hidden tools answer exactly like missing ones, so a caller cannot probe the policy.
      if (!decision.visible) throw toolNotFound(joinName(server, tool));
      if (decision.effect === 'deny') return deniedResult(decision.code, decision.reason);
      if (decision.effect === 'require_approval') {
        return deniedResult(
          'approval_unavailable',
          'this call needs approval and no approver is configured',
        );
      }
      // No await between decide and commit: otherwise two concurrent calls could both
      // see the same remaining slot and both be forwarded.
      commit(state, call, decision);
      return forwardSafely(forward);
    },
  };
}
