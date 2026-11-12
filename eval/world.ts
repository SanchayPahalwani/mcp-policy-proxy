import { InMemoryTransport, type McpServer } from '@modelcontextprotocol/server';
import type { UpstreamSpec } from '../src/proxy/upstreams.js';
import { Ledger } from './ledger.js';
import { createDocsServer, type Draft } from './servers/docs.js';
import { createMailServer, type SentMail } from './servers/mail.js';
import { createWebServer } from './servers/web.js';

export interface World {
  /** What the world started from, so a success check can tell what a run changed. */
  seed: { drafts: Draft[]; pages: Record<string, string> };
  ledger: Ledger;
  drafts: Map<string, Draft>;
  pages: Map<string, string>;
  sent: SentMail[];
  upstreams(): UpstreamSpec[];
}

function inMemory(name: string, server: McpServer): UpstreamSpec {
  return {
    name,
    transport: 'custom',
    connect: async () => {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await server.connect(serverSide);
      return clientSide;
    },
  };
}

/**
 * One world per run: its servers share one ledger, so the eval scores every side effect of the
 * run in one place. Each server takes a single connection, so connect the upstreams once.
 */
export function createWorld(
  clock: () => number,
  seed: { drafts: Draft[]; pages: Record<string, string> },
): World {
  const ledger = new Ledger(clock);
  const docs = createDocsServer(ledger, seed.drafts);
  const pages = new Map(Object.entries(seed.pages));
  const web = createWebServer(ledger, pages);
  const mail = createMailServer(ledger);
  return {
    seed: structuredClone(seed),
    ledger,
    drafts: docs.state.drafts,
    pages,
    sent: mail.sent,
    upstreams: () => [
      inMemory('docs', docs.server),
      inMemory('web', web.server),
      inMemory('mail', mail.server),
    ],
  };
}
