import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scriptedModel } from '../../eval/agent/scripted.js';
import { main, transcriptLines } from '../../eval/cli.js';
import { runAll, type Condition } from '../../eval/run.js';

const SET = fileURLToPath(new URL('../../eval/transcripts/synthetic/', import.meta.url));

const linesOf = (text: string) => text.split('\n').filter((l) => l !== '');
const scenarioOf = (line: string | undefined) =>
  line === undefined ? '(missing)' : (JSON.parse(line) as { scenario: string }).scenario;

// Stale transcripts would let CI replay old behaviour and call it current, so npm test fails first.
describe('the committed synthetic transcripts', () => {
  it('equal a fresh scripted run, line for line', { timeout: 120_000 }, async () => {
    const runs = await runAll(['baseline', 'enforced'], scriptedModel);
    for (const condition of ['baseline', 'enforced'] as Condition[]) {
      const fresh = linesOf(
        transcriptLines(runs.filter((r) => r.condition === condition).map((r) => r.transcript)),
      );
      const committed = linesOf(readFileSync(`${SET}${condition}.jsonl`, 'utf8'));
      expect(committed.length, `${condition}.jsonl line count`).toBe(fresh.length);
      const stale = fresh
        .map((line, i) => (line === committed[i] ? undefined : scenarioOf(committed[i] ?? line)))
        .filter((s) => s !== undefined);
      expect(stale, `${condition}.jsonl: run npm run eval:record -- --model scripted`).toEqual([]);
    }
  });

  it('pass the replay check against docs/results.md', { timeout: 120_000 }, async () => {
    let stderr = '';
    const quiet = new Writable({ write: (_chunk, _enc, done) => done() });
    const errors = new Writable({
      write(chunk, _enc, done) {
        stderr += String(chunk);
        done();
      },
    });
    const code = await main(['replay', '--check'], { stdout: quiet, stderr: errors, env: {} });
    expect(code, stderr).toBe(0);
  });
});
