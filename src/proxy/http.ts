import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isIP, type AddressInfo } from 'node:net';
import { createMcpHandler } from '@modelcontextprotocol/server';
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from '@modelcontextprotocol/node';
import { LOOPBACK_HOSTS } from '../util.js';
import type { Authenticator } from './auth.js';
import { buildServer, type ProxyOptions } from './server.js';

export interface HttpProxyOptions extends ProxyOptions {
  authenticator: Authenticator;
  host?: string;
  port?: number;
  path?: string;
  sessionHeader?: string;
}

export interface RunningProxy {
  url: string;
  port: number;
  close(): Promise<void>;
}

export const DEFAULT_SESSION = 'default';
export const SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function pathOf(target: string | undefined): string {
  // Not `new URL`: it throws on targets such as `//`, and this runs before any auth.
  const raw = target ?? '/';
  const query = raw.indexOf('?');
  return query < 0 ? raw : raw.slice(0, query);
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

export async function startHttpProxy(opts: HttpProxyOptions): Promise<RunningProxy> {
  const host = opts.host ?? '127.0.0.1';
  const path = opts.path ?? '/mcp';
  const sessionHeader = (opts.sessionHeader ?? 'x-agent-session').toLowerCase();
  // DNS rebinding only matters when a browser on this machine can reach us by a loopback name.
  // The guards accept only loopback names, so on any other bind they would refuse everything.
  const guards = LOOPBACK_HOSTS.includes(host)
    ? [localhostHostValidation(), localhostOriginValidation()]
    : [];

  const handler = createMcpHandler(
    (ctx) => {
      const auth = ctx.authInfo;
      if (!auth) throw new Error('Request reached the MCP handler without authentication');
      const session = auth.extra?.['session'];
      if (typeof session !== 'string')
        throw new Error('Request reached the MCP handler without a session');
      return buildServer(opts, { identity: auth.clientId, session });
    },
    opts.onError ? { onerror: opts.onError } : undefined,
  );
  const nodeHandler = toNodeHandler(handler, opts.onError ? { onerror: opts.onError } : undefined);

  const fail = (res: ServerResponse, e: unknown) => {
    opts.onError?.(e instanceof Error ? e : new Error(String(e)));
    if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
    else res.destroy();
  };

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    if (pathOf(req.url) !== path) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    for (const guard of guards) if (!guard(req, res)) return;

    const identity = opts.authenticator.authenticate(headerValue(req, 'authorization'));
    if (identity === undefined) {
      sendJson(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
      return;
    }
    const session = headerValue(req, sessionHeader) ?? DEFAULT_SESSION;
    if (!SESSION_ID.test(session)) {
      sendJson(res, 400, { error: 'invalid_session' });
      return;
    }

    // The token stops here: it is left out of authInfo and taken off the request itself, so
    // nothing downstream (the SDK handler, a server, a log) can see, log or forward it.
    delete req.headers.authorization;
    for (let i = req.rawHeaders.length - 2; i >= 0; i -= 2) {
      if (req.rawHeaders[i]?.toLowerCase() === 'authorization') req.rawHeaders.splice(i, 2);
    }
    (req as IncomingMessage & { auth?: unknown }).auth = {
      token: '',
      clientId: identity,
      scopes: [],
      extra: { session },
    };
    nodeHandler(req, res).catch((e: unknown) => fail(res, e));
  };

  // A throw escaping a request callback would take the whole process down.
  const http = createServer((req, res) => {
    try {
      handle(req, res);
    } catch (e) {
      fail(res, e);
    }
  });

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(opts.port ?? 0, host, () => {
      http.off('error', reject);
      resolve();
    });
  });
  const { port } = http.address() as AddressInfo;
  const urlHost = isIP(host) === 6 ? `[${host}]` : host;

  return {
    url: `http://${urlHost}:${port}${path}`,
    port,
    close: async () => {
      try {
        await handler.close();
      } finally {
        // Open keep-alive sockets would otherwise hold close() until they time out.
        http.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          http.close((err) => (err ? reject(err) : resolve())),
        );
      }
    },
  };
}
