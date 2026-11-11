import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
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

  it('asserts that the violating session is rejected with exit 1', () => {
    const negative = steps.find((s) => s.run?.includes('examples/sessions/violation.jsonl'));
    expect(negative).toBeDefined();
    expect(negative?.shell).toBe('bash');
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
