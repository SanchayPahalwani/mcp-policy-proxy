import Anthropic from '@anthropic-ai/sdk';
import type { AssistantTurn, Model, ToolCall } from './model.js';

/** The one call the adapter makes, so a test can stand in for the API without a key. */
export interface MessagesClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

const DEFAULT_MAX_TOKENS = 16000;

function stopOf(reason: Anthropic.StopReason | null): AssistantTurn['stop'] {
  if (reason === 'tool_use' || reason === 'refusal' || reason === 'max_tokens') return reason;
  // Cut off by the context window instead of the output cap: just as unfinished, and any
  // tool call in it may be incomplete.
  if (reason === 'model_context_window_exceeded') return 'max_tokens';
  return 'end';
}

/**
 * A live model through the Messages API. The loop is written out here rather than left to the
 * SDK's tool runner because every turn is recorded and every tool call has to go through the
 * proxy. Sampling and thinking are left at the API's defaults, so a recording reflects the
 * model as served.
 */
export function anthropicModel(opts: {
  model: string;
  client?: MessagesClient;
  maxTokens?: number;
}): Model {
  let client = opts.client;
  let system = '';
  let tools: Anthropic.Tool[] = [];
  let messages: Anthropic.MessageParam[] = [];

  return {
    id: opts.model,
    source: 'live',
    async start(input) {
      system = input.system;
      messages = [{ role: 'user', content: input.prompt }];
      tools = input.tools.map((t) => ({
        name: t.name,
        description: t.description ?? '',
        input_schema: t.input_schema as Anthropic.Tool.InputSchema,
      }));
    },
    async next(results) {
      if (results.length > 0) {
        messages.push({
          role: 'user',
          content: results.map((r): Anthropic.ToolResultBlockParam => ({
            type: 'tool_result',
            tool_use_id: r.tool_call_id,
            content: r.content,
            is_error: r.is_error,
          })),
        });
      }
      // Credentials come from the environment, read only when a live run actually starts.
      client ??= new Anthropic();
      // No `fallbacks`: a server-side fallback would silently change which model produced a
      // transcript, so a refusal is recorded as the run's outcome instead.
      const response = await client.messages.create({
        model: opts.model,
        max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
        system,
        tools,
        messages,
      });
      // The whole content goes back, so thinking blocks return to the API unchanged.
      messages.push({ role: 'assistant', content: response.content });

      const stop = stopOf(response.stop_reason);
      const text: string[] = [];
      const tool_calls: ToolCall[] = [];
      for (const block of response.content) {
        if (block.type === 'text') text.push(block.text);
        // Only a turn that stopped to use tools has calls to run: one cut off at max_tokens may
        // hold a call whose input is incomplete, and nothing after a refusal should run.
        else if (block.type === 'tool_use' && stop === 'tool_use') {
          tool_calls.push({
            id: block.id,
            name: block.name,
            arguments: block.input as Record<string, unknown>,
          });
        }
      }
      const category = stop === 'refusal' ? response.stop_details?.category : undefined;
      return {
        text: text.join('\n'),
        tool_calls,
        stop,
        ...(typeof category === 'string' && { refusal_category: category }),
      };
    },
  };
}
