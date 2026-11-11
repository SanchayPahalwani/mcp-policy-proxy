import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { McpServer } from '@modelcontextprotocol/server';
import { Ledger } from '../ledger.js';
import { createDocsServer } from './docs.js';
import { createMailServer } from './mail.js';
import { PAGES } from './pages.js';
import { createWebServer } from './web.js';

// Run as a child process by the proxy, so the ledger lives and dies with this process.
const servers: Record<string, () => McpServer> = {
  docs: () => createDocsServer(new Ledger()).server,
  web: () => createWebServer(new Ledger(), new Map(Object.entries(PAGES))).server,
  mail: () => createMailServer(new Ledger()).server,
};

const name = process.argv[2];
const create = name === undefined ? undefined : servers[name];
if (create === undefined) {
  process.stderr.write(`usage: stdio.ts <${Object.keys(servers).join('|')}>\n`);
  process.exitCode = 2;
} else {
  serveStdio(create);
}
