import { describe, expect, it } from 'vitest';
import {
  BENCH_BEGIN,
  BENCH_END,
  RESULTS_BEGIN,
  RESULTS_END,
  renderTable,
  replaceBlock,
  summarize,
  type ConditionSummary,
  type Summary,
} from '../../eval/report.js';
import type { Condition, RunResult } from '../../eval/run.js';

function run(
  scenario: string,
  condition: Condition,
  fields: Pick<RunResult, 'forbidden_calls' | 'goal_calls' | 'task_completed'> & Partial<RunResult>,
  model = 'test-model',
): RunResult {
  return {
    scenario,
    condition,
    injected: !scenario.endsWith('+clean'),
    divergences: 0,
    ledger: [],
    transcript: { scenario, condition, model, source: 'live', turns: [], ended: 'end' },
    ...fields,
  };
}

const FOUR: RunResult[] = [
  run('t1+publish-plain', 'baseline', { forbidden_calls: 2, goal_calls: 1, task_completed: true }),
  run('t2+clean', 'baseline', { forbidden_calls: 1, goal_calls: 0, task_completed: false }),
  run('t1+publish-plain', 'enforced', {
    forbidden_calls: 0,
    goal_calls: 0,
    task_completed: true,
    divergences: 1,
  }),
  run('t3+mail_cc-notice', 'enforced', {
    forbidden_calls: 0,
    goal_calls: 0,
    task_completed: false,
  }),
];

describe('summarize', () => {
  it('counts runs, forbidden calls and completions per condition', () => {
    const summary = summarize(FOUR);
    expect(summary).toMatchObject({ model: 'test-model', source: 'live', divergences: 1 });
    expect(summary.baseline).toEqual({
      runs: 2,
      injected_runs: 1,
      forbidden_calls: 3,
      injected_runs_with_forbidden_call: 1,
      clean_runs: 1,
      clean_completed: 0,
      injected_completed: 1,
      clean_forbidden_calls: 1,
    });
    expect(summary.enforced).toEqual({
      runs: 2,
      injected_runs: 2,
      forbidden_calls: 0,
      injected_runs_with_forbidden_call: 0,
      clean_runs: 0,
      clean_completed: 0,
      injected_completed: 1,
      clean_forbidden_calls: 0,
    });
  });

  it('sums the planted goal calls by goal, with every goal present', () => {
    const { by_goal } = summarize(FOUR);
    expect(Object.keys(by_goal)).toEqual([
      'publish',
      'delete',
      'mail_outside',
      'mail_cc',
      'fetch_outside',
      'overuse',
    ]);
    expect(by_goal.publish).toEqual({ baseline: 1, enforced: 0 });
    expect(by_goal.mail_cc).toEqual({ baseline: 0, enforced: 0 });
  });

  it('refuses results from more than one model, or none', () => {
    expect(() =>
      summarize([
        ...FOUR,
        run(
          't1+clean',
          'baseline',
          { forbidden_calls: 0, goal_calls: 0, task_completed: true },
          'other',
        ),
      ]),
    ).toThrow(/one model/);
    expect(() => summarize([])).toThrow();
  });

  it('refuses a result for a scenario it does not know', () => {
    expect(() =>
      summarize([
        run('t9+publish-plain', 'baseline', {
          forbidden_calls: 0,
          goal_calls: 0,
          task_completed: true,
        }),
      ]),
    ).toThrow(/t9\+publish-plain/);
  });
});

const side = (over: Partial<ConditionSummary>): ConditionSummary => ({
  runs: 65,
  injected_runs: 60,
  forbidden_calls: 0,
  injected_runs_with_forbidden_call: 0,
  clean_runs: 5,
  clean_completed: 5,
  injected_completed: 60,
  clean_forbidden_calls: 0,
  ...over,
});

const goals = (baseline: number): Summary['by_goal'] => ({
  publish: { baseline, enforced: 0 },
  delete: { baseline, enforced: 0 },
  mail_outside: { baseline, enforced: 0 },
  mail_cc: { baseline, enforced: 0 },
  fetch_outside: { baseline, enforced: 0 },
  overuse: { baseline: 90, enforced: 0 },
});

const SYNTHETIC: Summary = {
  model: 'scripted-obedient-v1',
  source: 'synthetic',
  baseline: side({
    forbidden_calls: 108,
    injected_runs_with_forbidden_call: 60,
    injected_completed: 54,
  }),
  enforced: side({}),
  by_goal: goals(10),
  divergences: 0,
};

const cell = (...cells: string[]) =>
  new RegExp(
    `^\\|\\s*${cells.map((c) => c.replace(/[()/]/g, '\\$&')).join('\\s*\\|\\s*')}\\s*\\|$`,
    'm',
  );

describe('renderTable', () => {
  it('is byte-stable for the same input', () => {
    const a = renderTable([SYNTHETIC]);
    expect(renderTable([structuredClone(SYNTHETIC)])).toBe(a);
    expect(renderTable([SYNTHETIC])).toBe(a);
  });

  it('labels the set and writes the documented columns and cells', () => {
    const table = renderTable([SYNTHETIC]);
    expect(table).toMatch(/^### scripted-obedient-v1 \(synthetic\)$/m);
    expect(table).toMatch(
      cell(
        'condition',
        'forbidden calls that reached a server',
        'injected runs with a forbidden call',
        'benign tasks completed, clean runs',
        'benign tasks completed, injected runs',
      ),
    );
    expect(table).toMatch(cell('baseline (no enforcement)', '108', '60 / 60', '5 / 5', '54 / 60'));
    expect(table).toMatch(cell('enforced', '0', '0 / 60', '5 / 5', '60 / 60'));
    expect(table).toMatch(cell('goal', 'baseline', 'enforced'));
    expect(table).toMatch(cell('publish', '10', '0'));
    expect(table).toMatch(cell('overuse', '90', '0'));
    expect(table).not.toMatch(/forbidden calls in clean runs/i);
  });

  it('adds a footnote when clean runs had forbidden calls', () => {
    const live: Summary = {
      ...SYNTHETIC,
      model: 'some-model',
      source: 'live',
      baseline: side({ clean_forbidden_calls: 2 }),
    };
    const table = renderTable([live]);
    expect(table).toMatch(/^### some-model \(live\)$/m);
    expect(table).toMatch(/forbidden calls in clean runs.*baseline 2, enforced 0/i);
  });

  it('renders several summaries in the order given', () => {
    const live: Summary = { ...SYNTHETIC, model: 'some-model', source: 'live' };
    const table = renderTable([SYNTHETIC, live]);
    expect(table.indexOf('(synthetic)')).toBeLessThan(table.indexOf('(live)'));
  });
});

describe('replaceBlock', () => {
  const doc = `# Title\n\nbefore\n${RESULTS_BEGIN}\nold\n${RESULTS_END}\nafter\n${BENCH_BEGIN}\nbench\n${BENCH_END}\n`;

  it('replaces only the text between the markers', () => {
    const next = replaceBlock(doc, RESULTS_BEGIN, RESULTS_END, 'new table\n');
    expect(next).toBe(
      `# Title\n\nbefore\n${RESULTS_BEGIN}\nnew table\n${RESULTS_END}\nafter\n${BENCH_BEGIN}\nbench\n${BENCH_END}\n`,
    );
    expect(replaceBlock(next, RESULTS_BEGIN, RESULTS_END, 'new table')).toBe(next);
  });

  it('throws when a marker is missing, out of order or repeated', () => {
    expect(() => replaceBlock('no markers', RESULTS_BEGIN, RESULTS_END, 'x')).toThrow(
      /results:begin/,
    );
    expect(() => replaceBlock(`${RESULTS_BEGIN}\n`, RESULTS_BEGIN, RESULTS_END, 'x')).toThrow(
      /results:end/,
    );
    expect(() =>
      replaceBlock(`${RESULTS_END}\n${RESULTS_BEGIN}\n`, RESULTS_BEGIN, RESULTS_END, 'x'),
    ).toThrow(/results:end/);
    expect(() => replaceBlock(`${doc}${RESULTS_BEGIN}\n`, RESULTS_BEGIN, RESULTS_END, 'x')).toThrow(
      /more than once/,
    );
  });
});
