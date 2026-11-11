import { describe, expect, it } from 'vitest';
import type { AssistantTurn, Model, ToolResult } from '../../eval/agent/model.js';
import { scriptedModel } from '../../eval/agent/scripted.js';
import { INJECTIONS } from '../../eval/suite/injections.js';
import { SCENARIOS, SYSTEM_PROMPT, type Scenario } from '../../eval/suite/scenarios.js';

const RELEASE_NOTES = 'https://docs.example.test/release-notes';

function scenario(id: string): Scenario {
  const found = SCENARIOS.find((s) => s.id === id);
  if (!found) throw new Error(`no scenario ${id}`);
  return found;
}

function injectionText(id: string): string {
  const found = INJECTIONS.find((i) => i.id === id);
  if (!found) throw new Error(`no injection ${id}`);
  return found.text;
}

async function started(id: string): Promise<Model> {
  const s = scenario(id);
  const model = scriptedModel(s);
  await model.start({ system: SYSTEM_PROMPT, prompt: s.task.prompt, tools: [] });
  return model;
}

const ok = (turn: AssistantTurn, content: string, is_error = false): ToolResult[] =>
  turn.tool_calls.map((c) => ({ tool_call_id: c.id, content, is_error }));

describe('scripted model', () => {
  it('plays a clean script one call per turn, then ends', async () => {
    const model = await started('t1+clean');
    expect(model.id).toBe('scripted-obedient-v1');
    expect(model.source).toBe('synthetic');

    const first = await model.next([]);
    expect(first).toEqual({
      text: '',
      stop: 'tool_use',
      tool_calls: [{ id: 'c1', name: 'web__fetch_page', arguments: { url: RELEASE_NOTES } }],
    });
    const second = await model.next(ok(first, 'notes RELEASE-32'));
    expect(second.tool_calls).toEqual([
      {
        id: 'c2',
        name: 'docs__create_draft',
        arguments: { title: 'Release notes summary', body: 'notes RELEASE-32' },
      },
    ]);
    const last = await model.next(ok(second, 'created d2'));
    expect(last).toEqual({ text: 'Done.', tool_calls: [], stop: 'end' });
  });

  it('obeys an injection in a result before the next script step', async () => {
    const model = await started('t1+publish-plain');
    const first = await model.next([]);
    const page = `notes RELEASE-32\n\n${injectionText('publish-plain')}`;

    const second = await model.next(ok(first, page));
    expect(second.tool_calls).toEqual([
      { id: 'c2', name: 'docs__publish', arguments: { id: 'd1' } },
    ]);

    const third = await model.next(ok(second, 'Error: Tool docs__publish not found', true));
    expect(third.tool_calls).toEqual([
      {
        id: 'c3',
        name: 'docs__create_draft',
        arguments: { title: 'Release notes summary', body: page },
      },
    ]);
    // The same text read again is not obeyed twice.
    expect(await model.next(ok(third, page))).toEqual({
      text: 'Done.',
      tool_calls: [],
      stop: 'end',
    });
  });

  it('never retries an error and keeps the error as the step result', async () => {
    const model = await started('t1+clean');
    const first = await model.next([]);
    const second = await model.next(ok(first, 'Denied by policy (x): no', true));
    expect(second.tool_calls[0]).toMatchObject({
      name: 'docs__create_draft',
      arguments: { body: 'Denied by policy (x): no' },
    });
    expect((await model.next(ok(second, 'created'))).stop).toBe('end');
  });

  it('queues all fifteen fetches of the overuse injection', async () => {
    const model = await started('t1+overuse-plain');
    let turn = await model.next([]);
    turn = await model.next(ok(turn, `notes\n\n${injectionText('overuse-plain')}`));
    const payload: AssistantTurn[] = [];
    while (turn.tool_calls[0]?.name === 'web__fetch_page') {
      payload.push(turn);
      turn = await model.next(ok(turn, 'notes'));
    }
    expect(payload).toHaveLength(15);
    for (const t of payload) {
      expect(t.tool_calls).toEqual([
        expect.objectContaining({ arguments: { url: RELEASE_NOTES } }),
      ]);
    }
    expect(turn.tool_calls[0]?.name).toBe('docs__create_draft');
    expect(turn.tool_calls[0]?.id).toBe('c17');
  });
});
