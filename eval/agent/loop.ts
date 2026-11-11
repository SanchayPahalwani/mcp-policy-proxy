import { ProtocolError, type Client } from '@modelcontextprotocol/client';
import type { Condition } from '../run.js';
import type { AssistantTurn, Model, ToolCall, ToolDef, ToolResult } from './model.js';

export interface TranscriptTurn {
  ts: number;
  assistant: AssistantTurn;
  results: ToolResult[];
}

export interface Transcript {
  scenario: string;
  condition: Condition;
  model: string;
  source: 'synthetic' | 'live';
  turns: TranscriptTurn[];
  ended: 'end' | 'refusal' | 'max_turns';
}

export const MAX_TURNS = 40;

async function listTools(client: Client): Promise<ToolDef[]> {
  const tools: ToolDef[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor === undefined ? undefined : { cursor });
    for (const tool of page.tools) {
      tools.push({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      });
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return tools;
}

async function execute(client: Client, call: ToolCall): Promise<ToolResult> {
  try {
    const result = await client.callTool({ name: call.name, arguments: call.arguments });
    const blocks = Array.isArray(result.content) ? result.content : [];
    const content = blocks
      .filter((b): b is { type: 'text'; text: string } => b?.type === 'text')
      .map((b) => b.text)
      .join('\n');
    return { tool_call_id: call.id, content, is_error: result.isError === true };
  } catch (e) {
    // A refusal from the proxy (an unknown or hidden tool) is something the model gets to read;
    // anything else means the harness is broken, and scoring that run would hide it.
    if (!(e instanceof ProtocolError)) throw e;
    return { tool_call_id: call.id, content: `Error: ${e.message}`, is_error: true };
  }
}

export async function runAgent(
  model: Model,
  client: Client,
  opts: { system: string; prompt: string; now: () => number; beforeTurn?: (index: number) => void },
): Promise<Pick<Transcript, 'turns' | 'ended'>> {
  await model.start({ system: opts.system, prompt: opts.prompt, tools: await listTools(client) });
  const turns: TranscriptTurn[] = [];
  let results: ToolResult[] = [];
  for (let i = 0; i < MAX_TURNS; i++) {
    opts.beforeTurn?.(i);
    const ts = opts.now();
    const assistant = await model.next(results);
    if (assistant.stop !== 'tool_use' || assistant.tool_calls.length === 0) {
      turns.push({ ts, assistant, results: [] });
      return { turns, ended: assistant.stop === 'refusal' ? 'refusal' : 'end' };
    }
    results = [];
    // In order, one at a time: a later call may depend on the side effects of an earlier one.
    for (const call of assistant.tool_calls) results.push(await execute(client, call));
    turns.push({ ts, assistant, results });
  }
  return { turns, ended: 'max_turns' };
}
