import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runPolicyTestFile } from '../../src/check/policy-tests.js';
import { loadPolicy, PolicyError } from '../../src/policy/load.js';

function tempTestFile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'policy-tests-'));
  const path = join(dir, 'x.test.yaml');
  writeFileSync(path, body);
  return path;
}

const MAIL = 'identity: writer, server: mail, tool: send, args: { to: team@example.test }';

describe('runPolicyTestFile', () => {
  it('passes every case in the example test file', () => {
    const results = runPolicyTestFile('examples/policy.test.yaml');
    expect(results.length).toBeGreaterThanOrEqual(14);
    expect(results.filter((r) => !r.ok)).toEqual([]);
  });

  it('reports a wrong expectation with expected and actual', () => {
    const path = tempTestFile(
      `cases:\n  - name: wrong\n    call: { identity: writer, server: docs, tool: publish }\n    expect: allow\n`,
    );
    const [r] = runPolicyTestFile(path, loadPolicy('examples/policy.yaml'));
    expect(r?.ok).toBe(false);
    expect(r?.message).toContain('expected allow');
    expect(r?.message).toContain('denied_by_rule');
    expect(r?.message).toContain('writers-never-publish');
  });

  it('reports a wrong visibility expectation', () => {
    const path = tempTestFile(
      `cases:\n  - name: v\n    visible: { identity: writer, server: docs, tool: publish }\n    expect: true\n`,
    );
    const [r] = runPolicyTestFile(path, loadPolicy('examples/policy.yaml'));
    expect(r?.message).toBe('expected visible=true, got false');
  });

  it('passes a sequence and names the failing step of a wrong one', () => {
    const steps = (third: string) =>
      `cases:\n  - name: seq\n    sequence:\n` +
      `      - { call: { ${MAIL} }, expect: allow }\n` +
      `      - { call: { ${MAIL} }, expect: allow, at: 5 }\n` +
      `      - { call: { ${MAIL} }, expect: ${third} }\n`;
    const policy = loadPolicy('examples/policy.yaml');
    expect(runPolicyTestFile(tempTestFile(steps('deny')), policy)[0]?.ok).toBe(true);
    const [bad] = runPolicyTestFile(tempTestFile(steps('allow')), policy);
    expect(bad?.ok).toBe(false);
    expect(bad?.message).toMatch(/^step 2: expected allow, got deny \(limit_exceeded/);
  });

  it('commits a require_approval step only when approved', () => {
    const body = (approved: string) =>
      `cases:\n  - name: a\n    sequence:\n` +
      `      - { call: { identity: release-manager, server: docs, tool: publish }, expect: require_approval${approved} }\n`;
    const policy = loadPolicy('examples/policy.yaml');
    expect(runPolicyTestFile(tempTestFile(body(', approved: true')), policy)[0]?.ok).toBe(true);
  });

  it('resolves policy: relative to the test file', () => {
    const path = tempTestFile(
      `policy: ${join(process.cwd(), 'examples/policy.yaml')}\ncases: []\n`,
    );
    expect(runPolicyTestFile(path)).toEqual([]);
  });

  it('throws PolicyError on an unknown key, a missing policy, or bad YAML', () => {
    expect(() => runPolicyTestFile(tempTestFile(`cases: []\nbogus: 1\n`))).toThrow(PolicyError);
    expect(() => runPolicyTestFile(tempTestFile(`cases: []\n`))).toThrow(PolicyError);
    expect(() => runPolicyTestFile(tempTestFile(`cases: [`))).toThrow(PolicyError);
  });
});
