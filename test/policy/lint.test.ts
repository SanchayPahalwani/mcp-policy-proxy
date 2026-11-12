import { describe, expect, it } from 'vitest';
import { lintPolicy } from '../../src/policy/lint.js';
import { loadPolicy, parsePolicy } from '../../src/policy/load.js';

const rule = (extra: string) => `
version: 1
rules:
  - id: r1
    identities: [writer]
    server: docs
    tools: [create_draft]
    effect: allow
${extra}`;

describe('lintPolicy', () => {
  it('errors on a constraint over a redacted key, naming the rule', () => {
    const p = parsePolicy(rule(`    when:\n      - arg: credentials.Token\n        equals: abc\n`));
    const issues = lintPolicy(p);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ level: 'error', rule: 'r1' });
    expect(issues[0]?.message).toContain('credentials.Token');
    expect(issues[0]?.message).not.toContain('r1');
  });

  it.each(['secret.kind', 'auth.Token.value', 'a.password'])(
    'errors on a constraint under a redacted key anywhere in its path: %s',
    (arg) => {
      const p = parsePolicy(rule(`    when:\n      - arg: ${arg}\n        equals: abc\n`));
      expect(lintPolicy(p)).toEqual([
        expect.objectContaining({
          level: 'error',
          rule: 'r1',
          message: expect.stringContaining(arg),
        }),
      ]);
    },
  );

  it('leaves a path that only contains a redacted word inside a segment alone', () => {
    const p = parsePolicy(rule(`    when:\n      - arg: secrets_list.kind\n        equals: abc\n`));
    expect(lintPolicy(p)).toEqual([]);
  });

  it('errors on an unknown identity only when a known set is given; an allow rule on an unknown server warns', () => {
    const p = parsePolicy(rule(''));
    expect(lintPolicy(p)).toEqual([]);
    const issues = lintPolicy(p, { identities: ['reader'], servers: ['web'] });
    expect(issues.map((i) => i.level)).toEqual(['error', 'warning']);
    expect(issues[0]?.message).toContain('writer');
    expect(issues[1]?.message).toContain('docs');
    expect(issues[1]?.message).not.toContain('r1');
  });

  it('errors on a deny rule naming an unknown server, since a typo disables the deny', () => {
    const p = parsePolicy(
      `version: 1\nrules:\n  - { id: d1, identities: "*", server: dcos, tools: [x], effect: deny }\n`,
    );
    const issues = lintPolicy(p, { servers: ['docs'] });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ level: 'error', rule: 'd1' });
    expect(issues[0]?.message).toContain('dcos');
  });

  it('warns on a require_approval rule naming an unknown server', () => {
    const p = parsePolicy(
      `version: 1\nrules:\n  - { id: a1, identities: "*", server: dcos, tools: [x], effect: require_approval }\n`,
    );
    const issues = lintPolicy(p, { servers: ['docs'] });
    expect(issues.filter((i) => i.rule === 'a1' && i.message.includes('dcos'))[0]?.level).toBe(
      'warning',
    );
  });

  it('exempts "*" from the known-name check', () => {
    const p = parsePolicy(
      `version: 1\nrules:\n  - { id: r1, identities: "*", server: "*", tools: [x], effect: deny }\n`,
    );
    expect(lintPolicy(p, { identities: [], servers: [] })).toEqual([]);
  });

  it('warns on an allow rule for every tool on every server', () => {
    const p = parsePolicy(
      `version: 1\nrules:\n  - { id: all, identities: [writer], server: "*", tools: ["*"], effect: allow }\n`,
    );
    const issues = lintPolicy(p);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ level: 'warning', rule: 'all' });
  });

  it('warns on identity "*" with no when, for allow and require_approval but not deny', () => {
    const mk = (effect: string) =>
      parsePolicy(
        `version: 1\nrules:\n  - { id: any, identities: "*", server: docs, tools: [x], effect: ${effect} }\n`,
      );
    expect(lintPolicy(mk('allow'))).toHaveLength(1);
    expect(lintPolicy(mk('require_approval'))).toHaveLength(1);
    expect(lintPolicy(mk('deny'))).toEqual([]);
  });

  it('does not warn on identity "*" when the rule has constraints', () => {
    const p = parsePolicy(
      `version: 1\nrules:\n  - id: any\n    identities: "*"\n    server: docs\n    tools: [x]\n    effect: allow\n    when:\n      - { arg: id, equals: a }\n`,
    );
    expect(lintPolicy(p)).toEqual([]);
  });

  it('passes the example policy', () => {
    const p = loadPolicy('examples/policy.yaml');
    expect(
      lintPolicy(p, {
        identities: ['writer', 'release-manager'],
        servers: ['docs', 'web', 'mail'],
      }),
    ).toEqual([]);
  });
});
