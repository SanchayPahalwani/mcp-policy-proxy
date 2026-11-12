import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { main } from '../src/cli.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = (path: string) => readFileSync(`${ROOT}${path}`, 'utf8');

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  shell?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
}

const action = parse(read('action.yml')) as {
  runs: { using: string; steps: Step[] };
  inputs: Record<string, { required?: boolean; default?: string }>;
};
const workflow = parse(read('.github/workflows/ci.yml')) as {
  permissions: Record<string, string>;
  jobs: Record<string, { steps: Step[] }>;
};

describe('action.yml', () => {
  it('is a composite action with the documented inputs', () => {
    expect(action.runs.using).toBe('composite');
    expect(Object.keys(action.inputs).sort()).toEqual(
      ['config', 'identity', 'node-version', 'policy', 'sessions', 'tests'].sort(),
    );
    expect(action.inputs['policy']?.required).toBe(true);
    expect(action.inputs['node-version']?.default).toBe('22');
  });

  it('runs every shell step under bash and never interpolates inputs into a script', () => {
    const runs = action.runs.steps.filter((s) => s.run !== undefined);
    expect(runs.length).toBeGreaterThan(0);
    for (const step of runs) {
      expect(step.shell).toBe('bash');
      expect(step.run).not.toContain('${{');
    }
  });
});

describe('ci.yml', () => {
  const steps = workflow.jobs['test']?.steps ?? [];

  it('has read-only permissions and uses the local action', () => {
    expect(workflow.permissions['contents']).toBe('read');
    expect(steps.some((s) => s.uses === './')).toBe(true);
  });

  it('starts every run step with set -euo pipefail', () => {
    const runs = steps.filter((s) => s.run !== undefined);
    expect(runs.length).toBeGreaterThan(0);
    for (const step of runs) expect(step.run).toMatch(/^set -euo pipefail\n/);
  });

  it('passes the example paths, config included, to the action', () => {
    expect(steps.find((s) => s.uses === './')?.with).toEqual({
      policy: 'examples/policy.yaml',
      config: 'examples/proxy.config.yaml',
      tests: 'examples/policy.test.yaml',
      sessions: 'examples/sessions/ok.jsonl',
    });
  });

  it('requires exit code 1 and the violation count from the negative step', () => {
    const run = steps.find((s) => s.run?.includes('violation.jsonl'))?.run ?? '';
    expect(run).toContain('-ne 1');
    expect(run).toContain('3 violation(s)');
    expect(run).not.toContain('|| true');
  });

  it.skipIf(process.platform === 'win32')(
    'accepts only a line that starts with "3 violation(s) in "',
    () => {
      const run = steps.find((s) => s.run?.includes('violation.jsonl'))?.run ?? '';
      const dir = mkdtempSync(join(tmpdir(), 'ci-step-'));
      try {
        mkdirSync(join(dir, 'dist'));
        // Stands in for the CLI: prints what the test says and exits 1, as for violations.
        writeFileSync(
          join(dir, 'dist', 'cli.js'),
          'process.stdout.write(process.env.FAKE_REPORT ?? ""); process.exitCode = 1;\n',
        );
        writeFileSync(join(dir, 'step.sh'), run);
        const status = (report: string) =>
          spawnSync('bash', ['--noprofile', '--norc', 'step.sh'], {
            cwd: dir,
            encoding: 'utf8',
            env: { PATH: process.env['PATH'] ?? '', FAKE_REPORT: report },
          }).status;
        expect(status('a\n3 violation(s) in 5 call(s) across 1 file(s)\n')).toBe(0);
        expect(status('a\n13 violation(s) in 5 call(s) across 1 file(s)\n')).not.toBe(0);
        expect(status('a\nx 3 violation(s) in 5 call(s) across 1 file(s)\n')).not.toBe(0);
        expect(status('3 violation(s)\n')).not.toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('asserts that the violating session is rejected with exit 1', () => {
    const negative = steps.find((s) => s.run?.includes('examples/sessions/violation.jsonl'));
    expect(negative).toBeDefined();
    expect(negative?.shell).toBe('bash');
  });
});

describe('action.yml shell steps', () => {
  it('start with set -euo pipefail, and guard the optional steps', () => {
    for (const step of action.runs.steps.filter((s) => s.run !== undefined)) {
      expect(step.run).toMatch(/^set -euo pipefail\n/);
    }
    const named = (n: string) => action.runs.steps.find((s) => s.name === n);
    expect(named('Run policy tests')?.if).toBe("inputs.tests != ''");
    expect(named('Check recorded sessions')?.if).toBe("inputs.sessions != ''");
  });
});

const posix = process.platform !== 'win32';
const sandboxes: string[] = [];
afterAll(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

/** Runs one of the action's scripts as bash would, against a stand-in CLI that echoes its argv. */
function runStep(name: string, env: Record<string, string>, files: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'action-test-'));
  sandboxes.push(dir);
  mkdirSync(join(dir, 'dist'));
  writeFileSync(
    join(dir, 'dist', 'cli.js'),
    'console.log(JSON.stringify(process.argv.slice(2)));\n',
  );
  for (const f of files) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), '');
  }
  const script = action.runs.steps.find((s) => s.name === name)?.run ?? '';
  writeFileSync(join(dir, 'step.sh'), script);
  const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', 'step.sh'], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', GITHUB_ACTION_PATH: dir, POLICY: 'p.yaml', ...env },
  });
  const argv = r.status === 0 ? (JSON.parse(r.stdout.trim()) as string[]) : [];
  return { code: r.status, argv, stderr: r.stderr, dir };
}

const bashMajor = posix
  ? Number(/version (\d+)/.exec(spawnSync('bash', ['--version'], { encoding: 'utf8' }).stdout)?.[1])
  : 0;

describe.skipIf(!posix)('the action list inputs, run as bash runs them', () => {
  it('reads every line of a newline-separated list', () => {
    const r = runStep('Check recorded sessions', { SESSIONS: 'a.jsonl\nb.jsonl\n', IDENTITY: '' }, [
      'a.jsonl',
      'b.jsonl',
    ]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.argv).toEqual(['check', '--policy', 'p.yaml', '--', 'a.jsonl', 'b.jsonl']);
  });

  it('runs with the optional inputs absent from the environment, as under set -u', () => {
    const validate = runStep('Validate the policy', {});
    expect(validate.code, validate.stderr).toBe(0);
    expect(validate.argv).toEqual(['validate', '--policy', 'p.yaml']);
    const check = runStep('Check recorded sessions', { SESSIONS: 'a.jsonl' }, ['a.jsonl']);
    expect(check.code, check.stderr).toBe(0);
    expect(check.argv).toEqual(['check', '--policy', 'p.yaml', '--', 'a.jsonl']);
  });

  it('passes a config to validate when given', () => {
    const r = runStep('Validate the policy', { CONFIG: 'c.yaml' });
    expect(r.argv).toEqual(['validate', '--policy', 'p.yaml', '--config', 'c.yaml']);
  });

  it('passes an identity when given', () => {
    const r = runStep('Check recorded sessions', { SESSIONS: 'a.jsonl', IDENTITY: 'writer' }, [
      'a.jsonl',
    ]);
    expect(r.argv).toEqual([
      'check',
      '--policy',
      'p.yaml',
      '--identity',
      'writer',
      '--',
      'a.jsonl',
    ]);
  });

  it('keeps an option-like word after --', () => {
    const r = runStep(
      'Check recorded sessions',
      { SESSIONS: '--policy=permissive.yaml a.jsonl', IDENTITY: '' },
      ['a.jsonl', '--policy=permissive.yaml'],
    );
    const at = r.argv.indexOf('--policy=permissive.yaml');
    expect(at).toBeGreaterThan(r.argv.indexOf('--'));
    expect(r.argv.indexOf('--')).toBeGreaterThan(-1);
  });

  it.skipIf(bashMajor < 4)('expands ** at several depths', () => {
    const r = runStep('Run policy tests', { TESTS: 'deep/**/*.yaml' }, [
      'deep/a.yaml',
      'deep/x/b.yaml',
      'deep/x/y/c.yaml',
    ]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.argv.slice(r.argv.indexOf('--') + 1).sort()).toEqual([
      'deep/a.yaml',
      'deep/x/b.yaml',
      'deep/x/y/c.yaml',
    ]);
  });

  it('exits 2 naming the input when a glob matches nothing', () => {
    const r = runStep('Check recorded sessions', { SESSIONS: 'none/*.jsonl', IDENTITY: '' });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("'sessions'");
  });

  it('exits 2 naming the input when the list is only whitespace', () => {
    const r = runStep('Run policy tests', { TESTS: ' \n\t ' });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("'tests' is empty");
  });

  it('never executes shell syntax in an input', () => {
    const r = runStep(
      'Check recorded sessions',
      { SESSIONS: '$(touch pwned) a.jsonl', IDENTITY: '' },
      ['a.jsonl'],
    );
    // A literal word without glob characters is passed on as is; the CLI then
    // reports it unreadable. The point here is that nothing ran.
    expect(r.code, r.stderr).toBe(0);
    expect(r.argv).toContain('$(touch');
    expect(existsSync(join(r.dir, 'pwned'))).toBe(false);
  });
});

async function run(argv: string[]) {
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
    env: {},
  });
  return { code, stdout, stderr };
}

describe('the commands the action runs, on the example files', () => {
  const policy = `${ROOT}examples/policy.yaml`;

  it('validate passes', async () => {
    expect((await run(['validate', '--policy', policy])).code).toBe(0);
  });

  it('test passes', async () => {
    const r = await run(['test', '--policy', policy, `${ROOT}examples/policy.test.yaml`]);
    expect(r.code, r.stderr).toBe(0);
  });

  it('check passes on the clean session', async () => {
    const r = await run(['check', '--policy', policy, `${ROOT}examples/sessions/ok.jsonl`]);
    expect(r.code, r.stderr).toBe(0);
  });

  it('check exits 1 on the violating session', async () => {
    const r = await run(['check', '--policy', policy, `${ROOT}examples/sessions/violation.jsonl`]);
    expect(r.code, r.stderr).toBe(1);
  });
});
