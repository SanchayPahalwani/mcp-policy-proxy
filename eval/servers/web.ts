import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Ledger } from '../ledger.js';

export function createWebServer(ledger: Ledger, pages: Map<string, string>): { server: McpServer } {
  const server = new McpServer({ name: 'web', version: '0.0.0' });
  server.registerTool(
    'fetch_page',
    {
      description: 'Fetches a web page and returns its text',
      inputSchema: z.object({ url: z.string() }),
    },
    async (args) => {
      // A fetch of a page that does not exist still reached the server, and may carry data out.
      ledger.record('web', 'fetch_page', args);
      const page = pages.get(args.url);
      return page === undefined
        ? { isError: true, content: [{ type: 'text', text: `No page at ${args.url}` }] }
        : { content: [{ type: 'text', text: page }] };
    },
  );
  return { server };
}
