import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runPolicyTestFile } from '../../src/check/policy-tests.js';
import { loadPolicy, parsePolicy, PolicyError } from '../../src/policy/load.js';

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
      `      - { call: { ${MAIL} }, expect: ${third}, at: 10 }\n`;
    const policy = loadPolicy('examples/policy.yaml');
    expect(runPolicyTestFile(tempTestFile(steps('deny')), policy)[0]?.ok).toBe(true);
    const [bad] = runPolicyTestFile(tempTestFile(steps('allow')), policy);
    expect(bad?.ok).toBe(false);
    expect(bad?.message).toMatch(/^step 2: expected allow, got deny \(limit_exceeded/);
  });

  describe('commit rules', () => {
    const limited = (effect: string, limit: string) =>
      parsePolicy(
        `version: 1\nrules:\n  - id: r\n    identities: [a]\n    server: s\n    tools: [t]\n    effect: ${effect}\n    limits: { ${limit} }\n`,
      );
    const step = (expectation: string) =>
      `      - { call: { identity: a, server: s, tool: t }, ${expectation} }\n`;
    const seq = (...steps: string[]) =>
      tempTestFile(`cases:\n  - name: c\n    sequence:\n${steps.join('')}`);

    it('commits an approved require_approval step', () => {
      const policy = limited('require_approval', 'per_session: 1');
      const path = seq(
        step('expect: require_approval, approved: true'),
        step('expect: deny, code: limit_exceeded'),
      );
      expect(runPolicyTestFile(path, policy)[0]?.ok).toBe(true);
    });

    it('does not commit a require_approval step that was not approved', () => {
      const policy = limited('require_approval', 'per_session: 1');
      const path = seq(step('expect: require_approval'), step('expect: require_approval'));
      expect(runPolicyTestFile(path, policy)[0]?.ok).toBe(true);
    });

    it('does not commit a denied step', () => {
      const policy = limited('allow', 'per_minute: 1');
      const path = seq(
        step('expect: allow, at: 0'),
        step('expect: deny, code: limit_exceeded, at: 30'),
        step('expect: allow, at: 61'),
      );
      expect(runPolicyTestFile(path, policy)[0]?.ok).toBe(true);
    });

    it('enforces per_minute on its own', () => {
      const policy = limited('allow', 'per_minute: 2');
      const path = seq(
        step('expect: allow, at: 0'),
        step('expect: allow, at: 5'),
        step('expect: deny, code: limit_exceeded, at: 10'),
        step('expect: allow, at: 70'),
      );
      expect(runPolicyTestFile(path, policy)[0]?.ok).toBe(true);
    });
  });

  it('resolves policy: relative to the test file, not the working directory', () => {
    const path = tempTestFile(`policy: ./p.yaml\ncases: []\n`);
    writeFileSync(join(dirname(path), 'p.yaml'), readFileSync('examples/policy.yaml', 'utf8'));
    expect(process.cwd()).not.toBe(dirname(path));
    expect(runPolicyTestFile(path)).toEqual([]);
  });

  it('names the test file and policy path when the policy is missing', () => {
    const path = tempTestFile(`policy: ./nope.yaml\ncases: []\n`);
    expect(() => runPolicyTestFile(path)).toThrow(PolicyError);
    expect(() => runPolicyTestFile(path)).toThrow(/x\.test\.yaml.*nope\.yaml/s);
  });

  it('rejects a sequence whose at values go backwards, naming case and step', () => {
    const path = tempTestFile(
      `cases:\n  - name: back\n    sequence:\n` +
        `      - { call: { ${MAIL} }, expect: allow, at: 5 }\n` +
        `      - { call: { ${MAIL} }, expect: allow, at: 2 }\n`,
    );
    expect(() => runPolicyTestFile(path, loadPolicy('examples/policy.yaml'))).toThrow(
      /case "back": step 1/,
    );
  });

  it('throws PolicyError on an unknown key, a missing policy, or bad YAML', () => {
    expect(() => runPolicyTestFile(tempTestFile(`cases: []\nbogus: 1\n`))).toThrow(PolicyError);
    expect(() => runPolicyTestFile(tempTestFile(`cases: []\n`))).toThrow(PolicyError);
    expect(() => runPolicyTestFile(tempTestFile(`cases: [`))).toThrow(PolicyError);
  });
});
