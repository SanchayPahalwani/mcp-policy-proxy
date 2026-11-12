import { createHash } from 'node:crypto';
import { ProtocolError, ProtocolErrorCode, type Client } from '@modelcontextprotocol/client';
import type { Condition } from '../run.js';
import type { AssistantTurn, Model, ModelInput, ToolCall, ToolDef, ToolResult } from './model.js';

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
  /** SHA-256 of the canonical JSON of what `model.start` was given; see `inputSha256`. */
  input_sha256: string;
  turns: TranscriptTurn[];
  /** The last turn's stop, or `max_turns` when the loop ran out of turns first. */
  ended: 'end' | 'refusal' | 'max_tokens' | 'max_turns';
}

export const MAX_TURNS = 40;

/** JSON with object keys sorted and undefined members left out, so equal values hash equal. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const members = Object.keys(value)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * A recorded turn is evidence of how the model reacted to one system prompt, task prompt and
 * tool list; a replay given anything else is no longer replaying that reaction.
 */
export function inputSha256(input: ModelInput): string {
  const { system, prompt, tools } = input;
  return createHash('sha256')
    .update(canonicalJson({ system, prompt, tools }), 'utf8')
    .digest('hex');
}

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
    // -32602 is a tool the proxy hides or cannot route, or one the upstream does not have or has
    // disabled: the model asked for it, so it gets to read the answer (bad arguments come back
    // as an isError result instead). Anything else means the harness is broken.
    if (!(e instanceof ProtocolError) || e.code !== ProtocolErrorCode.InvalidParams) throw e;
    return { tool_call_id: call.id, content: `Error: ${e.message}`, is_error: true };
  }
}

export async function runAgent(
  model: Model,
  client: Client,
  opts: {
    system: string;
    prompt: string;
    now: () => number;
    beforeTurn?: (index: number) => void;
    /** Sees the listed tools before the model starts, and may throw to stop the run unpaid. */
    onTools?: (tools: ToolDef[]) => void;
  },
): Promise<Pick<Transcript, 'input_sha256' | 'turns' | 'ended'>> {
  const tools = await listTools(client);
  opts.onTools?.(tools);
  const input: ModelInput = { system: opts.system, prompt: opts.prompt, tools };
  const input_sha256 = inputSha256(input);
  await model.start(input);
  const turns: TranscriptTurn[] = [];
  let results: ToolResult[] = [];
  for (let i = 0; i < MAX_TURNS; i++) {
    opts.beforeTurn?.(i);
    const ts = opts.now();
    const assistant = await model.next(results);
    if (assistant.stop !== 'tool_use' || assistant.tool_calls.length === 0) {
      turns.push({ ts, assistant, results: [] });
      return { input_sha256, turns, ended: assistant.stop === 'tool_use' ? 'end' : assistant.stop };
    }
    results = [];
    // In order, one at a time: a later call may depend on the side effects of an earlier one.
    for (const call of assistant.tool_calls) results.push(await execute(client, call));
    turns.push({ ts, assistant, results });
  }
  return { input_sha256, turns, ended: 'max_turns' };
}
