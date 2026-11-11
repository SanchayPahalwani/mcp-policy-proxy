import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { RunningProxy } from '../../src/proxy/http.js';

/** The caller closes the client; test files keep their own cleanup registry. */
export async function connectAgent(
  proxy: RunningProxy,
  token: string,
  session?: string,
): Promise<Client> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (session !== undefined) headers['x-agent-session'] = session;
  const client = new Client(
    { name: 'test-agent', version: '0.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(proxy.url), { requestInit: { headers } }),
  );
  return client;
}

export async function call(
  client: Client,
  name: string,
  args?: Record<string, unknown>,
): Promise<CallToolResult> {
  return (await client.callTool(
    args === undefined ? { name } : { name, arguments: args },
  )) as CallToolResult;
}

export function textOf(result: CallToolResult): string {
  const first = result.content[0];
  return first?.type === 'text' ? first.text : '';
}
