import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { mockServer } from './mock-upstream.js';

serveStdio(() =>
  mockServer('stdio', [
    { name: 'echo', description: 'Returns its arguments as JSON text' },
    {
      name: 'add',
      description: 'Adds a and b',
      inputSchema: {
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'],
      },
      handler: ({ a, b }) => ({ content: [{ type: 'text', text: String(Number(a) + Number(b)) }] }),
    },
  ]),
);
