import { createRequire } from 'node:module';
import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type Tool,
  type Transport,
} from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { SERVER_NAME } from './names.js';

const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };

export type UpstreamSpec =
  | {
      name: string;
      transport: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
    }
  | { name: string; transport: 'http'; url: string; headers?: Record<string, string> }
  | { name: string; transport: 'custom'; connect: () => Transport | Promise<Transport> };

export interface UpstreamTool {
  server: string;
  tool: Tool;
}

interface ConnectOptions {
  onError?: (server: string, error: Error) => void;
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

async function openTransport(spec: UpstreamSpec): Promise<Transport> {
  switch (spec.transport) {
    case 'stdio':
      return new StdioClientTransport({
        command: spec.command,
        ...(spec.args && { args: spec.args }),
        // The SDK uses `env` as the whole environment; merge so PATH and friends survive.
        ...(spec.env && { env: { ...getDefaultEnvironment(), ...spec.env } }),
        ...(spec.cwd !== undefined && { cwd: spec.cwd }),
      });
    case 'http':
      return new StreamableHTTPClientTransport(
        new URL(spec.url),
        spec.headers ? { requestInit: { headers: spec.headers } } : undefined,
      );
    case 'custom':
      return spec.connect();
  }
}

async function connectOne(spec: UpstreamSpec): Promise<Client> {
  const client = new Client(
    { name: 'mcp-policy-proxy', version },
    { versionNegotiation: { mode: 'auto' } },
  );
  await client.connect(await openTransport(spec));
  return client;
}

/** Which upstreams failed to connect, so a caller can report them without their messages. */
export class UpstreamConnectError extends Error {
  constructor(readonly failures: { name: string; error: Error }[]) {
    super(
      `Failed to connect upstream ${failures.map((f) => `${f.name}: ${f.error.message}`).join('; ')}`,
    );
    this.name = 'UpstreamConnectError';
  }
}

export class Upstreams {
  private constructor(
    private readonly clients: Map<string, Client>,
    private readonly onError: ConnectOptions['onError'],
  ) {}

  static async connect(specs: UpstreamSpec[], opts: ConnectOptions = {}): Promise<Upstreams> {
    const seen = new Set<string>();
    for (const { name } of specs) {
      if (!SERVER_NAME.test(name)) {
        throw new Error(`Invalid upstream name "${name}": must match ${SERVER_NAME}`);
      }
      if (seen.has(name)) throw new Error(`Duplicate upstream name "${name}"`);
      seen.add(name);
    }

    const results = await Promise.allSettled(specs.map(connectOne));
    const clients = new Map<string, Client>();
    const failures: { name: string; error: Error }[] = [];
    results.forEach((result, i) => {
      const name = specs[i]!.name;
      if (result.status === 'fulfilled') clients.set(name, result.value);
      else failures.push({ name, error: toError(result.reason) });
    });
    if (failures.length > 0) {
      await Promise.allSettled([...clients.values()].map((c) => c.close()));
      throw new UpstreamConnectError(failures);
    }
    return new Upstreams(clients, opts.onError);
  }

  names(): string[] {
    return [...this.clients.keys()];
  }

  has(server: string): boolean {
    return this.clients.has(server);
  }

  async listTools(): Promise<UpstreamTool[]> {
    const perServer = await Promise.all(
      [...this.clients].map(async ([server, client]) => {
        // The SDK logs a console.debug line to stdout when listing tools on a server without
        // the capability, which would corrupt the protocol channel when we serve over stdio.
        if (client.getServerCapabilities()?.tools === undefined) return [];
        try {
          // With no cursor the SDK walks every page itself, with a cap on runaway cursors.
          const { tools } = await client.listTools();
          return tools.map((tool) => ({ server, tool }));
        } catch (e) {
          this.onError?.(server, toError(e));
          return [];
        }
      }),
    );
    return perServer.flat();
  }

  async callTool(
    server: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const client = this.clients.get(server);
    if (!client) throw new Error(`Unknown upstream "${server}"`);
    return client.callTool({ name: tool, arguments: args });
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.clients.values()].map((c) => c.close()));
  }
}
