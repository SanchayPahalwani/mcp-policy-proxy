import { describe, expect, it } from 'vitest';
import { ProtocolError, ProtocolErrorCode, type Client } from '@modelcontextprotocol/client';
import { inputSha256, MAX_TURNS, runAgent } from '../../eval/agent/loop.js';
import type { AssistantTurn, Model, ToolDef, ToolResult } from '../../eval/agent/model.js';

/** Only the two client methods the loop uses; no network. */
function fakeClient(callTool: () => Promise<unknown>): Client {
  return {
    listTools: async () => ({
      tools: [{ name: 'docs__get_draft', inputSchema: { type: 'object' } }],
    }),
    callTool,
  } as unknown as Client;
}

const ok = () => Promise.resolve({ content: [{ type: 'text', text: 'fine' }] });

function fakeModel(turn: (index: number) => AssistantTurn) {
  const seen: { tools?: ToolDef[]; results: ToolResult[][] } = { results: [] };
  const model: Model = {
    id: 'fake',
    source: 'synthetic',
    start: async ({ tools }) => void (seen.tools = tools),
    next: async (results) => turn(seen.results.push(results) - 1),
  };
  return { model, seen };
}

const toolTurn = (i: number): AssistantTurn => ({
  text: '',
  stop: 'tool_use',
  tool_calls: [{ id: `c${i}`, name: 'docs__get_draft', arguments: { id: 'd1' } }],
});

const opts = { system: 's', prompt: 'p', now: () => 0 };

describe('runAgent', () => {
  it('stops with max_turns after MAX_TURNS turns that still ask for tools', async () => {
    const { model, seen } = fakeModel(toolTurn);
    const run = await runAgent(model, fakeClient(ok), opts);
    expect(run.ended).toBe('max_turns');
    expect(run.turns).toHaveLength(MAX_TURNS);
    expect(seen.results).toHaveLength(MAX_TURNS);
    expect(seen.tools).toEqual([
      { name: 'docs__get_draft', description: undefined, input_schema: { type: 'object' } },
    ]);
  });

  it('records a refusal as the final turn', async () => {
    const refusal: AssistantTurn = { text: 'No.', tool_calls: [], stop: 'refusal' };
    const { model } = fakeModel((i) => (i === 0 ? toolTurn(i) : refusal));
    const run = await runAgent(model, fakeClient(ok), opts);
    expect(run.ended).toBe('refusal');
    expect(run.turns.at(-1)).toEqual({ ts: 0, assistant: refusal, results: [] });
  });

  it('records a turn cut off at max_tokens as the end of the run', async () => {
    const cut: AssistantTurn = { text: 'Then I will', tool_calls: [], stop: 'max_tokens' };
    const { model } = fakeModel((i) => (i === 0 ? toolTurn(i) : cut));
    const run = await runAgent(model, fakeClient(ok), opts);
    expect(run.ended).toBe('max_tokens');
    expect(run.turns.at(-1)).toEqual({ ts: 0, assistant: cut, results: [] });
  });

  it('hashes the input it gives the model, and lets onTools stop the run first', async () => {
    const { model, seen } = fakeModel(() => ({ text: '', tool_calls: [], stop: 'end' }));
    const run = await runAgent(model, fakeClient(ok), opts);
    expect(run.input_sha256).toBe(
      inputSha256({ system: 's', prompt: 'p', tools: seen.tools ?? [] }),
    );
    const stopped = fakeModel(() => ({ text: '', tool_calls: [], stop: 'end' }));
    const refuse = () => {
      throw new Error('no tools listed');
    };
    await expect(
      runAgent(stopped.model, fakeClient(ok), { ...opts, onTools: refuse }),
    ).rejects.toThrow('no tools listed');
    expect(stopped.seen.tools).toBeUndefined();
  });

  it('turns an invalid-params rejection into a result the model reads', async () => {
    const { model, seen } = fakeModel((i) =>
      i === 0 ? toolTurn(i) : { text: '', tool_calls: [], stop: 'end' },
    );
    const hidden = () =>
      Promise.reject(new ProtocolError(ProtocolErrorCode.InvalidParams, 'Tool x not found'));
    const run = await runAgent(model, fakeClient(hidden), opts);
    expect(run.ended).toBe('end');
    expect(seen.results[1]).toEqual([
      {
        tool_call_id: 'c0',
        content: expect.stringMatching(/^Error: .*Tool x not found/),
        is_error: true,
      },
    ]);
  });

  it('rethrows any other protocol error', async () => {
    const { model } = fakeModel(toolTurn);
    const broken = () =>
      Promise.reject(new ProtocolError(ProtocolErrorCode.InternalError, 'upstream fell over'));
    await expect(runAgent(model, fakeClient(broken), opts)).rejects.toThrow('upstream fell over');
  });

  it('rethrows a rejection that is not a protocol error', async () => {
    const { model } = fakeModel(toolTurn);
    const broken = () => Promise.reject(new TypeError('fetch failed'));
    await expect(runAgent(model, fakeClient(broken), opts)).rejects.toThrow(TypeError);
  });
});
