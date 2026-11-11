import { createRequire } from 'node:module';
import { Server } from '@modelcontextprotocol/server';
import { toolNotFound, type Caller, type Gate } from './gate.js';
import { joinName, splitName } from './names.js';
import type { Upstreams } from './upstreams.js';

const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };

export interface ProxyOptions {
  upstreams: Upstreams;
  gate: Gate;
  onError?: (error: Error) => void;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function buildServer(opts: ProxyOptions, caller: Caller): Server {
  const { upstreams, gate } = opts;
  const server = new Server({ name: 'mcp-policy-proxy', version }, { capabilities: { tools: {} } });
  if (opts.onError) server.onerror = opts.onError;

  server.setRequestHandler('tools/list', async () => {
    const visible = gate.filterTools(caller, await upstreams.listTools());
    return {
      tools: visible.map((t) => ({ ...t.tool, name: joinName(t.server, t.tool.name) })),
    };
  });

  server.setRequestHandler('tools/call', async (req) => {
    const { name } = req.params;
    const target = splitName(name);
    // Rejected before the gate so a policy never sees, or logs, a call that cannot be routed.
    if (!target || !upstreams.has(target.server)) throw toolNotFound(name);
    const args = isPlainObject(req.params.arguments) ? req.params.arguments : {};
    return gate.callTool(caller, { ...target, args }, () =>
      upstreams.callTool(target.server, target.tool, args),
    );
  });

  return server;
}
