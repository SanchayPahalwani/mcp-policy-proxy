import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Ledger } from '../ledger.js';

export interface Draft {
  id: string;
  title: string;
  body: string;
  published: boolean;
}

export interface DocsState {
  drafts: Map<string, Draft>;
  nextId: number;
}

const text = (value: string): CallToolResult => ({ content: [{ type: 'text', text: value }] });
const missing = (id: string): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: `No draft ${id}` }],
});

// New ids continue after the seeded ones, so a created draft never replaces a seeded draft.
function firstFreeId(seed: Draft[]): number {
  let highest = 0;
  for (const { id } of seed) {
    const n = /^d(\d+)$/.exec(id)?.[1];
    if (n !== undefined) highest = Math.max(highest, Number(n));
  }
  return highest + 1;
}

export function createDocsServer(
  ledger: Ledger,
  seed: Draft[] = [],
): { server: McpServer; state: DocsState } {
  const state: DocsState = {
    drafts: new Map(seed.map((d) => [d.id, { ...d }])),
    nextId: firstFreeId(seed),
  };
  const server = new McpServer({ name: 'docs', version: '0.0.0' });

  // Recorded before acting, so a call that fails still shows up as attempted.
  const tool = <Shape extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: Shape,
    run: (args: z.infer<z.ZodObject<Shape>>) => CallToolResult,
  ) =>
    server.registerTool(name, { description, inputSchema: z.object(shape) }, async (args) => {
      ledger.record('docs', name, args as Record<string, unknown>);
      return run(args as z.infer<z.ZodObject<Shape>>);
    });

  const withDraft = (id: string, change: (draft: Draft) => string): CallToolResult => {
    const draft = state.drafts.get(id);
    return draft ? text(change(draft)) : missing(id);
  };

  tool('list_drafts', 'Lists every draft with its id, title and whether it is published', {}, () =>
    text(
      JSON.stringify(
        [...state.drafts.values()].map(({ id, title, published }) => ({ id, title, published })),
      ),
    ),
  );

  tool('get_draft', 'Returns the title and body of one draft', { id: z.string() }, ({ id }) =>
    withDraft(id, (d) => `${d.title}\n\n${d.body}`),
  );

  tool(
    'create_draft',
    'Creates a new unpublished draft',
    { title: z.string(), body: z.string() },
    ({ title, body }) => {
      const id = `d${state.nextId++}`;
      state.drafts.set(id, { id, title, body, published: false });
      return text(`Created draft ${id}`);
    },
  );

  tool(
    'update_draft',
    'Changes the title, the body or both of a draft',
    { id: z.string(), title: z.string().optional(), body: z.string().optional() },
    ({ id, title, body }) =>
      withDraft(id, (d) => {
        if (title !== undefined) d.title = title;
        if (body !== undefined) d.body = body;
        return `Updated draft ${id}`;
      }),
  );

  tool('delete_draft', 'Deletes a draft', { id: z.string() }, ({ id }) =>
    withDraft(id, () => {
      state.drafts.delete(id);
      return `Deleted draft ${id}`;
    }),
  );

  tool('publish', 'Publishes a draft', { id: z.string() }, ({ id }) =>
    withDraft(id, (d) => {
      d.published = true;
      return `Published draft ${id}`;
    }),
  );

  return { server, state };
}
