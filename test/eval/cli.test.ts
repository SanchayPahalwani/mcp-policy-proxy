import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { main } from '../../eval/cli.js';
import { PROVENANCE_BEGIN, PROVENANCE_END, RESULTS_BEGIN, RESULTS_END } from '../../eval/report.js';

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), 'eval-cli-'));
  roots.push(root);
  mkdirSync(join(root, 'docs'));
  writeFileSync(
    join(root, 'docs', 'results.md'),
    `# Results\n\n${PROVENANCE_BEGIN}\n${PROVENANCE_END}\n\n${RESULTS_BEGIN}\n${RESULTS_END}\n\nafter\n`,
  );
  return root;
}

async function cli(argv: string[], opts: { root?: string; env?: NodeJS.ProcessEnv } = {}) {
  let stdout = '';
  let stderr = '';
  const sink = (append: (s: string) => void) =>
    new Writable({
      write(chunk, _enc, done) {
        append(String(chunk));
        done();
      },
    });
  const code = await main(argv, {
    stdout: sink((s) => (stdout += s)),
    stderr: sink((s) => (stderr += s)),
    env: opts.env ?? {},
    ...(opts.root !== undefined && { root: opts.root }),
  });
  return { code, stdout, stderr };
}

const lines = (path: string) => readFileSync(path, 'utf8').trimEnd().split('\n');
const set = (root: string, name: string, condition: string) =>
  join(root, 'eval', 'transcripts', name, `${condition}.jsonl`);

describe('eval cli', () => {
  it('prints usage and exits 2 for an unknown command', async () => {
    const r = await cli(['frobnicate']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('usage:');
  });

  it('refuses to record a live model without a credential and never asks for one', async () => {
    const root = sandbox();
    for (const argv of [['record', '--model', 'claude-opus-5-5'], ['record']]) {
      const r = await cli(argv, { root, env: {} });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('ANTHROPIC_API_KEY');
      expect(r.stderr).toContain('ANTHROPIC_AUTH_TOKEN');
      expect(r.stdout).toBe('');
    }
    expect(existsSync(join(root, 'eval'))).toBe(false);
  });

  it('rejects a model id that cannot name a directory, and an unknown scenario', async () => {
    const root = sandbox();
    const env = { ANTHROPIC_API_KEY: 'not-used' };
    expect((await cli(['record', '--model', '../x'], { root, env })).code).toBe(2);
    const r = await cli(['record', '--model', 'scripted', '--only', 't9+clean'], { root });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('t9+clean');
    expect(existsSync(join(root, 'eval'))).toBe(false);
  });

  it('records, reports and checks a set', { timeout: 30_000 }, async () => {
    const root = sandbox();
    expect(
      (await cli(['record', '--model', 'scripted', '--only', 't2+clean'], { root })).code,
    ).toBe(0);
    expect(lines(set(root, 'synthetic', 'baseline'))).toHaveLength(1);

    // A second --only adds to the set and keeps the order of the scenario list.
    const recorded = await cli(
      ['record', '--model', 'scripted', '--only', 't1+publish-plain', '--only', 't2+clean'],
      { root },
    );
    expect(recorded.code, recorded.stderr).toBe(0);
    for (const condition of ['baseline', 'enforced']) {
      const scenarios = lines(set(root, 'synthetic', condition)).map(
        (l) => (JSON.parse(l) as { scenario: string }).scenario,
      );
      expect(scenarios).toEqual(['t1+publish-plain', 't2+clean']);
    }

    const stale = await cli(['replay', '--check'], { root });
    expect(stale.code).toBe(1);
    expect(stale.stderr).toContain('eval:report');

    const report = await cli(['report'], { root });
    expect(report.code, report.stderr).toBe(0);
    const doc = readFileSync(join(root, 'docs', 'results.md'), 'utf8');
    expect(doc).toContain('### scripted-obedient-v1 (synthetic)');
    expect(doc).toMatch(
      /\|\s*baseline \(no enforcement\)\s*\|\s*1\s*\|\s*1 \/ 1\s*\|\s*1 \/ 1\s*\|/,
    );
    expect(doc).toContain('npm run eval:report');
    expect(doc).toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(doc.endsWith('\nafter\n')).toBe(true);

    const check = await cli(['replay', '--check'], { root });
    expect(check.code, check.stderr).toBe(0);
    expect(check.stdout).toContain('### scripted-obedient-v1 (synthetic)');

    // Provenance is outside what the check compares.
    writeFileSync(
      join(root, 'docs', 'results.md'),
      doc.replace(/(provenance:begin -->\n)[^]*?(\n<!-- provenance:end)/, '$1other$2'),
    );
    expect((await cli(['replay', '--check'], { root })).code).toBe(0);

    writeFileSync(join(root, 'docs', 'results.md'), doc.replace('1 / 1', '0 / 1'));
    expect((await cli(['replay', '--check'], { root })).code).toBe(1);
  });

  it('fails the check when a replay diverges from its recording', { timeout: 30_000 }, async () => {
    const root = sandbox();
    expect(
      (await cli(['record', '--model', 'scripted', '--only', 't1+clean'], { root })).code,
    ).toBe(0);
    expect((await cli(['report'], { root })).code).toBe(0);
    const path = set(root, 'synthetic', 'enforced');
    writeFileSync(path, readFileSync(path, 'utf8').replace('RELEASE-32', 'RELEASE-99'));
    const r = await cli(['replay', '--check'], { root });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/divergence/);
    // A report from a diverging replay would publish numbers the recordings do not support.
    expect((await cli(['report'], { root })).code).toBe(1);
  });

  it('exits 2 when a set lists a scenario twice', { timeout: 30_000 }, async () => {
    const root = sandbox();
    expect(
      (await cli(['record', '--model', 'scripted', '--only', 't1+clean'], { root })).code,
    ).toBe(0);
    const path = set(root, 'synthetic', 'baseline');
    writeFileSync(path, readFileSync(path, 'utf8').repeat(2));
    const r = await cli(['replay'], { root });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('t1+clean appears twice');
  });

  it('prints usage and exits 0 for --help', async () => {
    const r = await cli(['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('usage:');
  });

  it('exits 2 on a malformed transcript file', async () => {
    const root = sandbox();
    mkdirSync(join(root, 'eval', 'transcripts', 'synthetic'), { recursive: true });
    writeFileSync(set(root, 'synthetic', 'baseline'), '{not json\n');
    writeFileSync(set(root, 'synthetic', 'enforced'), '');
    const r = await cli(['replay'], { root });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('baseline.jsonl');
  });
});
