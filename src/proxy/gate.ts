import {
  ProtocolError,
  ProtocolErrorCode,
  type CallToolResult,
} from '@modelcontextprotocol/server';
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

export function deniedResult(code: string, reason: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: `Denied by policy (${code}): ${reason}` }],
  };
}
