import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { mockServer } from './mock-upstream.js';

// A stdio upstream that reports which environment variables it was started with.
serveStdio(() =>
  mockServer('env', [
    {
      name: 'has_env',
      description: 'Says whether this process has the named environment variable',
      inputSchema: { properties: { name: { type: 'string' } }, required: ['name'] },
      handler: ({ name }) => ({
        content: [{ type: 'text', text: process.env[String(name)] ? 'yes' : 'no' }],
      }),
    },
  ]),
);
