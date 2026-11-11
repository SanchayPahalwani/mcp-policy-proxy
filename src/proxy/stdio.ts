import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { Transport } from '@modelcontextprotocol/server';
import { buildServer, type ProxyOptions } from './server.js';

export function startStdioProxy(opts: ProxyOptions & { identity: string; transport?: Transport }): {
  close(): Promise<void>;
} {
  // A stdio connection is one agent process, so it gets one fixed session.
  const caller = { identity: opts.identity, session: 'stdio' };
  return serveStdio(() => buildServer(opts, caller), {
    ...(opts.transport && { transport: opts.transport }),
    ...(opts.onError && { onerror: opts.onError }),
  });
}
