import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  createMcpHandler,
  InMemoryTransport,
  ProtocolError,
  ProtocolErrorCode,
  Server,
  type CallToolResult,
} from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { UpstreamSpec } from '../../src/proxy/upstreams.js';

export interface MockTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  handler?: (args: Record<string, unknown>) => CallToolResult | Promise<CallToolResult>;
}

export interface MockCall {
  tool: string;
  args: Record<string, unknown>;
}

export function mockServer(name: string, tools: MockTool[], calls?: MockCall[]): Server {
  const server = new Server({ name, version: '0.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler('tools/list', async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      ...(t.description !== undefined && { description: t.description }),
      inputSchema: { type: 'object' as const, ...t.inputSchema },
    })),
  }));
  server.setRequestHandler('tools/call', async (req) => {
    const { name: toolName } = req.params;
    const args = req.params.arguments ?? {};
    calls?.push({ tool: toolName, args });
    const tool = tools.find((t) => t.name === toolName);
    if (!tool) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Tool ${toolName} not found`);
    }
    if (tool.handler) return tool.handler(args);
    return { content: [{ type: 'text', text: JSON.stringify(args) }] };
  });
  return server;
}

export function inMemoryUpstream(
  name: string,
  tools: MockTool[],
  calls?: MockCall[],
): UpstreamSpec {
  return {
    name,
    transport: 'custom',
    connect: async () => {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await mockServer(name, tools, calls).connect(serverSide);
      return clientSide;
    },
  };
}

export async function httpUpstream(
  name: string,
  tools: MockTool[],
  calls?: MockCall[],
): Promise<{ spec: UpstreamSpec; close(): Promise<void> }> {
  const handler = createMcpHandler(() => mockServer(name, tools, calls));
  const nodeHandler = toNodeHandler(handler);
  const http = createServer((req, res) => void nodeHandler(req, res));
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  return {
    spec: { name, transport: 'http', url: `http://127.0.0.1:${port}/mcp` },
    close: async () => {
      await handler.close();
      // Open keep-alive sockets would otherwise hold close() until they time out.
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        http.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}

export function stdioUpstream(name: string): UpstreamSpec {
  return {
    name,
    transport: 'stdio',
    command: process.execPath,
    args: ['--import', 'tsx', fileURLToPath(new URL('./stdio-server.ts', import.meta.url))],
  };
}
