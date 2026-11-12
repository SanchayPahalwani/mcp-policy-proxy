import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Transcript } from '../../eval/agent/loop.js';
import type { AssistantTurn, Model } from '../../eval/agent/model.js';
import { replayModel, replayRun } from '../../eval/agent/replay.js';
import { scriptedModel } from '../../eval/agent/scripted.js';
import { EVAL_EPOCH, runScenario } from '../../eval/run.js';
import { SCENARIOS, type Scenario } from '../../eval/suite/scenarios.js';

function scenario(id: string): Scenario {
  const found = SCENARIOS.find((s) => s.id === id);
  if (!found) throw new Error(`no scenario ${id}`);
  return found;
}

const timesOf = (t: Transcript) => t.turns.map((turn) => turn.ts);

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('replayModel', () => {
  it('reproduces a recorded enforced run with no divergence', async () => {
    const s = scenario('t1+publish-plain');
    const recorded = await runScenario(s, 'enforced', scriptedModel);
    const replayed = await runScenario(s, 'enforced', () => replayModel(recorded.transcript), {
      turnTimes: timesOf(recorded.transcript),
    });
    expect(replayed).toMatchObject({
      forbidden_calls: recorded.forbidden_calls,
      task_completed: recorded.task_completed,
      divergences: 0,
    });
    expect(replayed.transcript).toEqual(recorded.transcript);
    expect(replayed.ledger).toEqual(recorded.ledger);
  });

  it('diverges when a baseline transcript meets enforcement, and the publish is refused', async () => {
    const s = scenario('t1+publish-plain');
    const baseline = await runScenario(s, 'baseline', scriptedModel);
    expect(baseline.forbidden_calls).toBe(1);
    const replayed = await runScenario(s, 'enforced', () => replayModel(baseline.transcript), {
      turnTimes: timesOf(baseline.transcript),
    });
    expect(replayed.divergences).toBeGreaterThan(0);
    expect(replayed.forbidden_calls).toBe(0);
    expect(replayed.ledger.some((e) => e.tool === 'publish')).toBe(false);
  });

  it('counts each result that differs from the recording, in content or in is_error', async () => {
    const transcript: Transcript = {
      scenario: 't1+clean',
      condition: 'baseline',
      model: 'm',
      source: 'live',
      ended: 'end',
      turns: [
        {
          ts: 1,
          assistant: {
            text: '',
            stop: 'tool_use',
            tool_calls: [
              { id: 'a', name: 'x', arguments: {} },
              { id: 'b', name: 'y', arguments: {} },
            ],
          },
          results: [
            { tool_call_id: 'a', content: 'one', is_error: false },
            { tool_call_id: 'b', content: 'two', is_error: false },
          ],
        },
        { ts: 2, assistant: { text: 'Done.', tool_calls: [], stop: 'end' }, results: [] },
      ],
    };
    const model = replayModel(transcript);
    expect(model).toMatchObject({ id: 'm', source: 'live' });
    await model.start({ system: '', prompt: '', tools: [] });
    expect(await model.next([])).toEqual(transcript.turns[0]?.assistant);
    const done = await model.next([
      { tool_call_id: 'a', content: 'one', is_error: true },
      { tool_call_id: 'b', content: 'changed', is_error: false },
    ]);
    expect(done).toEqual({ text: 'Done.', tool_calls: [], stop: 'end' });
    expect(model.divergences()).toBe(2);
  });

  it('ends and counts a divergence when asked for more turns than were recorded', async () => {
    const transcript: Transcript = {
      scenario: 't1+clean',
      condition: 'baseline',
      model: 'm',
      source: 'synthetic',
      ended: 'max_turns',
      turns: [
        {
          ts: 1,
          assistant: {
            text: '',
            stop: 'tool_use',
            tool_calls: [{ id: 'a', name: 'x', arguments: {} }],
          },
          results: [{ tool_call_id: 'a', content: 'one', is_error: false }],
        },
      ],
    };
    const model = replayModel(transcript);
    await model.start({ system: '', prompt: '', tools: [] });
    await model.next([]);
    const extra = await model.next([{ tool_call_id: 'a', content: 'one', is_error: false }]);
    expect(extra.stop).toBe('end');
    expect(extra.tool_calls).toEqual([]);
    expect(model.divergences()).toBe(1);
  });

  it('returns copies, so a run cannot change the transcript it plays', async () => {
    const s = scenario('t1+clean');
    const recorded = await runScenario(s, 'baseline', scriptedModel);
    const before = structuredClone(recorded.transcript);
    const model = replayModel(recorded.transcript);
    await model.start({ system: '', prompt: '', tools: [] });
    const turn = await model.next([]);
    turn.tool_calls[0]!.arguments['url'] = 'changed';
    expect(recorded.transcript).toEqual(before);
  });
});

describe('replayRun', () => {
  // Two sends a minute apart are both allowed only if the replay keeps the recorded gap.
  const policyPath = () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-policy-'));
    dirs.push(dir);
    const path = join(dir, 'policy.yaml');
    writeFileSync(
      path,
      [
        'version: 1',
        'rules:',
        '  - id: mail-once-a-minute',
        '    identities: [writer]',
        '    server: mail',
        '    tools: [send]',
        '    effect: allow',
        '    limits:',
        '      per_minute: 1',
        '',
      ].join('\n'),
    );
    return path;
  };

  const send = (id: string): AssistantTurn => ({
    text: '',
    stop: 'tool_use',
    tool_calls: [
      {
        id,
        name: 'mail__send',
        arguments: { to: 'team@example.test', subject: 's', body: 'b' },
      },
    ],
  });

  function twoSends(): Model {
    const turns = [send('c1'), send('c2'), { text: 'Done.', tool_calls: [], stop: 'end' as const }];
    let i = 0;
    return {
      id: 'two-sends',
      source: 'synthetic',
      start: async () => {
        i = 0;
      },
      next: async () => turns[i++]!,
    };
  }

  it('sets the proxy clock from the recorded timestamps', async () => {
    const policy = policyPath();
    const turnTimes = [EVAL_EPOCH + 1_000, EVAL_EPOCH + 70_000, EVAL_EPOCH + 71_000];
    const recorded = await runScenario(scenario('t3+clean'), 'enforced', twoSends, {
      policyPath: policy,
      turnTimes,
    });
    expect(recorded.transcript.turns.flatMap((t) => t.results).map((r) => r.is_error)).toEqual([
      false,
      false,
    ]);

    const replayed = await replayRun(recorded.transcript, { policyPath: policy });
    expect(replayed.divergences).toBe(0);
    expect(replayed.ledger.map((e) => e.ts)).toEqual(turnTimes.slice(0, 2));
    expect(timesOf(replayed.transcript)).toEqual(turnTimes);

    // The same turns one second apart: the second send is over the limit, so the gap mattered.
    const squeezed = await runScenario(
      scenario('t3+clean'),
      'enforced',
      () => replayModel(recorded.transcript),
      { policyPath: policy },
    );
    expect(squeezed.divergences).toBe(1);
    expect(squeezed.ledger).toHaveLength(1);
  });

  it('refuses a transcript for a scenario that does not exist', async () => {
    const transcript: Transcript = {
      scenario: 't9+nothing',
      condition: 'baseline',
      model: 'm',
      source: 'synthetic',
      ended: 'end',
      turns: [],
    };
    await expect(replayRun(transcript)).rejects.toThrow(/t9\+nothing/);
  });
});
