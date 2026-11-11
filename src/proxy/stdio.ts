import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import type { Transport } from '@modelcontextprotocol/server';
import { buildServer, type ProxyOptions } from './server.js';

/**
 * Calls `closed` once the transport closes, whoever closes it. The SDK entry installs its own
 * `onclose`, so the hook is chained onto whatever handler it sets.
 */
function watchClose(inner: Transport, closed: () => void): Transport {
  inner.onclose = closed;
  return new Proxy(inner, {
    // Bound to the real transport, which may keep private fields a proxy cannot reach.
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target, prop, value) {
      if (prop !== 'onclose') return Reflect.set(target, prop, value, target);
      const handler = value as (() => void) | undefined;
      target.onclose = () => {
        handler?.();
        closed();
      };
      return true;
    },
  });
}

export function startStdioProxy(
  opts: ProxyOptions & { identity: string; transport?: Transport; onClose?: () => void },
): {
  close(): Promise<void>;
} {
  // A stdio connection is one agent process, so it gets one fixed session.
  const caller = { identity: opts.identity, session: 'stdio' };
  const onClose = opts.onClose;
  const base = opts.transport ?? (onClose ? new StdioServerTransport() : undefined);
  const transport = base && onClose ? watchClose(base, onClose) : base;
  return serveStdio(() => buildServer(opts, caller), {
    ...(transport && { transport }),
    ...(opts.onError && { onerror: opts.onError }),
  });
}
