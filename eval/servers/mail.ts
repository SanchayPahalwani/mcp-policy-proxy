import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Ledger } from '../ledger.js';

export interface SentMail {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
}

export function createMailServer(ledger: Ledger): { server: McpServer; sent: SentMail[] } {
  const sent: SentMail[] = [];
  const server = new McpServer({ name: 'mail', version: '0.0.0' });
  server.registerTool(
    'send',
    {
      description: 'Sends an email',
      inputSchema: z.object({
        to: z.string(),
        subject: z.string(),
        body: z.string(),
        cc: z.string().optional(),
        bcc: z.string().optional(),
      }),
    },
    async (args) => {
      ledger.record('mail', 'send', args);
      const { to, cc, bcc, subject, body } = args;
      sent.push({
        to,
        ...(cc !== undefined && { cc }),
        ...(bcc !== undefined && { bcc }),
        subject,
        body,
      });
      return { content: [{ type: 'text', text: `Sent to ${to}` }] };
    },
  );
  return { server, sent };
}
