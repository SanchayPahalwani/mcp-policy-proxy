import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { anthropicModel, type MessagesClient } from '../../eval/agent/anthropic.js';
import type { ToolDef } from '../../eval/agent/model.js';

type Params = Anthropic.MessageCreateParamsNonStreaming;

function message(
  content: Anthropic.ContentBlock[],
  stop_reason: Anthropic.StopReason,
  stop_details: Anthropic.RefusalStopDetails | null = null,
): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    content,
    stop_reason,
    stop_details,
    stop_sequence: null,
  } as unknown as Anthropic.Message;
}

/** Answers with the queued messages in order and keeps what each call was sent, as sent then. */
function fakeClient(replies: Anthropic.Message[]) {
  const calls: Params[] = [];
  const client: MessagesClient = {
    messages: {
      create: async (params) => {
        calls.push({ ...params, messages: [...params.messages] });
        const reply = replies.shift();
        if (!reply) throw new Error('no reply queued');
        return reply;
      },
    },
  };
  return { client, calls };
}

const TOOLS: ToolDef[] = [
  {
    name: 'docs__get_draft',
    description: 'Reads a draft',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  { name: 'mail__send', input_schema: { type: 'object' } },
];

const toolUse = (id: string, name: string, input: Record<string, unknown>) =>
  ({ type: 'tool_use', id, name, input }) as unknown as Anthropic.ContentBlock;
const text = (value: string) =>
  ({ type: 'text', text: value }) as unknown as Anthropic.ContentBlock;

describe('anthropicModel', () => {
  it('turns tool_use blocks into calls and sends results back after the whole assistant content', async () => {
    const first = message(
      [text('Reading it.'), toolUse('toolu_1', 'docs__get_draft', { id: 'd2' })],
      'tool_use',
    );
    const { client, calls } = fakeClient([first, message([text('Sent.')], 'end_turn')]);
    const model = anthropicModel({ model: 'claude-test-model', client });
    expect(model).toMatchObject({ id: 'claude-test-model', source: 'live' });

    await model.start({ system: 'be careful', prompt: 'do the task', tools: TOOLS });
    const turn = await model.next([]);
    expect(turn).toEqual({
      text: 'Reading it.',
      stop: 'tool_use',
      tool_calls: [{ id: 'toolu_1', name: 'docs__get_draft', arguments: { id: 'd2' } }],
    });

    const end = await model.next([
      { tool_call_id: 'toolu_1', content: 'Error: Tool not found', is_error: true },
    ]);
    expect(end).toEqual({ text: 'Sent.', stop: 'end', tool_calls: [] });

    expect(calls).toHaveLength(2);
    const [one, two] = calls as [Params, Params];
    expect(one).toMatchObject({
      model: 'claude-test-model',
      max_tokens: 16000,
      system: 'be careful',
    });
    expect(one.messages).toEqual([{ role: 'user', content: 'do the task' }]);
    expect(one.tools).toEqual([
      {
        name: 'docs__get_draft',
        description: 'Reads a draft',
        input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
      { name: 'mail__send', description: '', input_schema: { type: 'object' } },
    ]);

    expect(two.messages).toHaveLength(3);
    expect(two.messages[0]).toEqual({ role: 'user', content: 'do the task' });
    expect(two.messages[1]?.role).toBe('assistant');
    // The same array, so thinking blocks and anything else the API sent go back unchanged.
    expect(two.messages[1]?.content).toBe(first.content);
    expect(two.messages[2]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: 'Error: Tool not found',
          is_error: true,
        },
      ],
    });
  });

  it('sends no sampling, thinking or fallback parameters', async () => {
    const { client, calls } = fakeClient([message([text('ok')], 'end_turn')]);
    const model = anthropicModel({ model: 'm', client, maxTokens: 1234 });
    await model.start({ system: 's', prompt: 'p', tools: [] });
    await model.next([]);
    const params = calls[0] as unknown as Record<string, unknown>;
    expect(params['max_tokens']).toBe(1234);
    for (const key of ['temperature', 'top_p', 'top_k', 'thinking', 'fallbacks', 'betas']) {
      expect(params).not.toHaveProperty(key);
    }
  });

  it.each([
    ['refusal', 'refusal'],
    ['end_turn', 'end'],
    ['max_tokens', 'max_tokens'],
    // Cut off by the context window rather than the output cap: the turn is just as unfinished.
    ['model_context_window_exceeded', 'max_tokens'],
    ['stop_sequence', 'end'],
    ['pause_turn', 'end'],
  ] as const)('maps stop reason %s to %s and runs no call', async (reason, stop) => {
    // A tool_use block in a turn that did not stop for tools: cut off, refused or otherwise over.
    const { client } = fakeClient([
      message([text('x'), toolUse('toolu_9', 'mail__send', { to: 'team@exa' })], reason),
    ]);
    const model = anthropicModel({ model: 'm', client });
    await model.start({ system: 's', prompt: 'p', tools: [] });
    const turn = await model.next([]);
    expect(turn).toEqual({ text: 'x', tool_calls: [], stop });
  });

  it('records the category of a refusal when the API gives one', async () => {
    const { client } = fakeClient([
      message([text('I cannot help with that.')], 'refusal', {
        type: 'refusal',
        category: 'cyber',
        explanation: 'not stable text',
      }),
      message([], 'refusal', { type: 'refusal', category: null, explanation: null }),
      message([], 'end_turn'),
    ]);
    const model = anthropicModel({ model: 'm', client });
    await model.start({ system: 's', prompt: 'p', tools: [] });
    expect(await model.next([])).toEqual({
      text: 'I cannot help with that.',
      tool_calls: [],
      stop: 'refusal',
      refusal_category: 'cyber',
    });
    expect(await model.next([])).not.toHaveProperty('refusal_category');
    expect(await model.next([])).not.toHaveProperty('refusal_category');
  });

  it('starts a fresh conversation on each start', async () => {
    const { client, calls } = fakeClient([
      message([text('a')], 'end_turn'),
      message([text('b')], 'end_turn'),
    ]);
    const model = anthropicModel({ model: 'm', client });
    await model.start({ system: 's', prompt: 'first', tools: [] });
    await model.next([]);
    await model.start({ system: 's', prompt: 'second', tools: [] });
    await model.next([]);
    expect(calls[1]?.messages).toEqual([{ role: 'user', content: 'second' }]);
  });
});
