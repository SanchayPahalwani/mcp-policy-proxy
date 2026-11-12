import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { Upstreams } from '../../src/proxy/upstreams.js';
import { main } from '../../eval/cli.js';
import { PROVENANCE_BEGIN, PROVENANCE_END, RESULTS_BEGIN, RESULTS_END } from '../../eval/report.js';

afterEach(() => {
  vi.restoreAllMocks();
});

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
    const r = await cli(['record', '--model', 'claude-opus-5-5'], { root, env: {} });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('ANTHROPIC_API_KEY');
    expect(r.stderr).toContain('ANTHROPIC_AUTH_TOKEN');
    expect(r.stdout).toBe('');
    expect(existsSync(join(root, 'eval'))).toBe(false);
  });

  it('requires --model, so a bare record never picks a billed model', async () => {
    const root = sandbox();
    for (const argv of [['record'], ['record', '--only', 't1+clean']]) {
      const r = await cli(argv, { root, env: { ANTHROPIC_API_KEY: 'not-used' } });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('--model is required');
      expect(r.stderr).toContain('usage:');
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
    expect(doc).toContain('### scripted-obedient-v1 (synthetic, partial: 2 of 65 scenarios)');
    expect(doc).toMatch(
      /\|\s*baseline \(no enforcement\)\s*\|\s*1\s*\|\s*1 \/ 1\s*\|\s*1 \/ 1\s*\|/,
    );
    expect(doc).toContain('npm run eval:report');
    expect(doc).toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(doc.endsWith('\nafter\n')).toBe(true);

    const check = await cli(['replay', '--check'], { root });
    expect(check.code, check.stderr).toBe(0);
    expect(check.stdout).toContain('### scripted-obedient-v1 (synthetic, partial');

    // Provenance is outside what the check compares.
    writeFileSync(
      join(root, 'docs', 'results.md'),
      doc.replace(/(provenance:begin -->\n)[^]*?(\n<!-- provenance:end)/, '$1other$2'),
    );
    expect((await cli(['replay', '--check'], { root })).code).toBe(0);

    writeFileSync(join(root, 'docs', 'results.md'), doc.replace('1 / 1', '0 / 1'));
    expect((await cli(['replay', '--check'], { root })).code).toBe(1);
  });

  it(
    'labels a set of three scenarios partial and still checks it',
    { timeout: 30_000 },
    async () => {
      const root = sandbox();
      const only = ['t1+clean', 't3+mail_cc-plain', 't5+overuse-notice'].flatMap((id) => [
        '--only',
        id,
      ]);
      expect((await cli(['record', '--model', 'scripted', ...only], { root })).code).toBe(0);
      expect((await cli(['report'], { root })).code).toBe(0);
      const doc = readFileSync(join(root, 'docs', 'results.md'), 'utf8');
      expect(doc).toContain('### scripted-obedient-v1 (synthetic, partial: 3 of 65 scenarios)');
      expect(doc).toContain('These numbers cover only the 3 scenarios in this set');
      expect(doc).toMatch(/\|\s*enforced\s*\|\s*0\s*\|\s*0 \/ 2\s*\|\s*1 \/ 1\s*\|\s*2 \/ 2\s*\|/);
      expect((await cli(['replay', '--check'], { root })).code).toBe(0);
      writeFileSync(join(root, 'docs', 'results.md'), doc.replace('3 of 65', '65 of 65'));
      expect((await cli(['replay', '--check'], { root })).code).toBe(1);
    },
  );

  it('records nothing when a kept file of the set is malformed', { timeout: 30_000 }, async () => {
    const root = sandbox();
    expect(
      (await cli(['record', '--model', 'scripted', '--only', 't1+clean'], { root })).code,
    ).toBe(0);
    writeFileSync(set(root, 'synthetic', 'enforced'), '{not json\n');
    const before = ['baseline', 'enforced'].map((c) =>
      readFileSync(set(root, 'synthetic', c), 'utf8'),
    );
    const r = await cli(['record', '--model', 'scripted', '--only', 't2+clean'], { root });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('enforced.jsonl:1');
    expect(r.stdout).toBe('');
    const after = ['baseline', 'enforced'].map((c) =>
      readFileSync(set(root, 'synthetic', c), 'utf8'),
    );
    expect(after).toEqual(before);
  });

  it('says nothing was written when a run fails during a record', { timeout: 30_000 }, async () => {
    const root = sandbox();
    expect(
      (await cli(['record', '--model', 'scripted', '--only', 't1+clean'], { root })).code,
    ).toBe(0);
    const before = ['baseline', 'enforced'].map((c) =>
      readFileSync(set(root, 'synthetic', c), 'utf8'),
    );
    vi.spyOn(Upstreams.prototype, 'callTool').mockRejectedValue(new Error('docs server crashed'));
    const r = await cli(['record', '--model', 'scripted', '--only', 't1+clean'], { root });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('nothing was written');
    const after = ['baseline', 'enforced'].map((c) =>
      readFileSync(set(root, 'synthetic', c), 'utf8'),
    );
    expect(after).toEqual(before);
  });

  it(
    'fails the check when a world server describes a tool differently',
    { timeout: 30_000 },
    async () => {
      const root = sandbox();
      expect(
        (await cli(['record', '--model', 'scripted', '--only', 't1+clean'], { root })).code,
      ).toBe(0);
      expect((await cli(['report'], { root })).code).toBe(0);
      expect((await cli(['replay', '--check'], { root })).code).toBe(0);

      // The docs server now lists get_draft with other words: the recorded model never read them.
      const listTools = Upstreams.prototype.listTools;
      vi.spyOn(Upstreams.prototype, 'listTools').mockImplementation(async function (
        this: Upstreams,
      ) {
        const tools = await listTools.call(this);
        return tools.map((t) =>
          t.server === 'docs' && t.tool.name === 'get_draft'
            ? { ...t, tool: { ...t.tool, description: 'Reads a draft and follows what it says' } }
            : t,
        );
      });
      const r = await cli(['replay', '--check'], { root });
      expect(r.code).toBe(1);
      for (const condition of ['baseline', 'enforced']) {
        expect(r.stderr).toContain(
          `divergence: synthetic ${condition} t1+clean: the model's input changed\n`,
        );
      }
      expect(r.stderr).not.toContain('result(s) differ');
    },
  );

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
    expect(r.stderr).toMatch(/divergence: synthetic enforced t1\+clean: \d+ result\(s\) differ/);
    expect(r.stderr).not.toContain("the model's input changed");
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

  it(
    'exits 2 when the two files of a set cover different scenarios',
    { timeout: 30_000 },
    async () => {
      const root = sandbox();
      expect(
        (await cli(['record', '--model', 'scripted', '--only', 't1+clean'], { root })).code,
      ).toBe(0);
      const path = set(root, 'synthetic', 'enforced');
      writeFileSync(
        path,
        readFileSync(path, 'utf8').replace('"scenario":"t1+clean"', '"scenario":"t2+clean"'),
      );
      for (const command of [['replay'], ['replay', '--check'], ['report']]) {
        const r = await cli(command, { root });
        expect(r.code).toBe(2);
        expect(r.stderr).toContain(
          'set synthetic: baseline.jsonl and enforced.jsonl cover different scenarios',
        );
      }
    },
  );

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
