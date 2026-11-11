import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPolicy, parsePolicy, PolicyError } from '../../src/policy/load.js';
import { DEFAULT_REDACT_KEYS } from '../../src/policy/schema.js';
import { globToRegExp } from '../../src/policy/match.js';

const EXAMPLE = `
version: 1

audit:
  redact_keys: [Password, token, secret, api_key, authorization]

rules:
  - id: writer-drafts
    description: Writers work on drafts.
    identities: [writer]
    server: docs
    tools: [list_drafts, get_draft, create_draft, update_draft]
    effect: allow
    when:
      - arg: title
        max_length: 120
        optional: true
    limits:
      per_minute: 30
      per_session: 20

  - id: writers-never-publish
    identities: [writer]
    server: docs
    tools: [publish]
    effect: deny
    reason: Publishing needs a release manager.
`;

function rule(over: Record<string, unknown> = {}): string {
  const base: Record<string, unknown> = {
    id: 'r1',
    identities: ['writer'],
    server: 'docs',
    tools: ['get_*'],
    effect: 'allow',
    ...over,
  };
  return JSON.stringify({ version: 1, rules: [base] });
}

function issuesOf(text: string): string[] {
  try {
    parsePolicy(text);
  } catch (e) {
    expect(e).toBeInstanceOf(PolicyError);
    return (e as PolicyError).issues;
  }
  throw new Error('expected parsePolicy to throw');
}

describe('parsePolicy', () => {
  it('parses the example policy', () => {
    const policy = parsePolicy(EXAMPLE);
    expect(policy.rules.map((r) => r.spec.id)).toEqual(['writer-drafts', 'writers-never-publish']);
    expect(policy.rules.map((r) => r.index)).toEqual([0, 1]);
    expect(policy.rules[0]?.constraints).toHaveLength(1);
    expect(policy.rules[1]?.constraints).toHaveLength(0);
    expect(policy.spec.version).toBe(1);
  });

  it('hashes the exact text', () => {
    expect(parsePolicy(EXAMPLE).sha256).toBe(createHash('sha256').update(EXAMPLE).digest('hex'));
  });

  it('lower-cases redact keys and defaults them', () => {
    expect(parsePolicy(EXAMPLE).redactKeys).toEqual([
      'password',
      'token',
      'secret',
      'api_key',
      'authorization',
    ]);
    expect(parsePolicy(rule()).redactKeys).toEqual(DEFAULT_REDACT_KEYS);
    expect(DEFAULT_REDACT_KEYS).toEqual([
      'password',
      'token',
      'secret',
      'api_key',
      'authorization',
    ]);
  });

  it('accepts a policy with no rules', () => {
    expect(parsePolicy('version: 1\nrules: []\n').rules).toEqual([]);
  });

  it('builds a readable message from the issues', () => {
    try {
      parsePolicy(rule({ id: 'bad-one', tools: [] }));
      expect.unreachable();
    } catch (e) {
      const err = e as PolicyError;
      expect(err.name).toBe('PolicyError');
      expect(err.message).toBe(`Invalid policy:\n${err.issues.join('\n')}`);
    }
  });
});

describe('rule.matches', () => {
  const policy = parsePolicy(
    JSON.stringify({
      version: 1,
      rules: [
        { id: 'any', identities: '*', server: '*', tools: ['get_*', 'publish'], effect: 'allow' },
        {
          id: 'one',
          identities: ['writer', 'editor'],
          server: 'docs',
          tools: ['*'],
          effect: 'allow',
        },
      ],
    }),
  );
  const any = policy.rules[0]!;
  const one = policy.rules[1]!;

  it('honours wildcard identity and server', () => {
    expect(any.matches('anyone', 'mail', 'get_draft')).toBe(true);
    expect(any.matches('anyone', 'mail', 'publish')).toBe(true);
  });
  it('honours globs', () => {
    expect(any.matches('a', 's', 'get_draft')).toBe(true);
    expect(any.matches('a', 's', 'forget_x')).toBe(false);
    expect(any.matches('a', 's', 'publish_all')).toBe(false);
  });
  it('honours identity lists and exact servers', () => {
    expect(one.matches('editor', 'docs', 'anything')).toBe(true);
    expect(one.matches('reader', 'docs', 'anything')).toBe(false);
    expect(one.matches('writer', 'mail', 'anything')).toBe(false);
  });
});

describe('globToRegExp', () => {
  it('treats everything but * literally and anchors', () => {
    const re = globToRegExp('a.b*(c)');
    expect(re.test('a.bXYZ(c)')).toBe(true);
    expect(re.test('aXbXYZ(c)')).toBe(false);
    expect(re.test('xa.b(c)')).toBe(false);
    expect(re.test('a.b(c)x')).toBe(false);
  });
});

describe('schema rules', () => {
  const cases: Array<[string, string, string]> = [
    ['unknown key on a rule', rule({ extra: 1 }), 'extra'],
    ['unknown key in a constraint', rule({ when: [{ arg: 'a', equals: 1, nope: 1 }] }), 'nope'],
    ['unknown key in limits', rule({ limits: { per_hour: 1 } }), 'per_hour'],
    ['bad rule id', rule({ id: 'Bad Id' }), 'must match'],
    ['empty identities list', rule({ identities: [] }), 'r1'],
    ['identities not * or a list', rule({ identities: 'writer' }), 'r1'],
    ['empty tools', rule({ tools: [] }), 'r1'],
    ['bad server', rule({ server: 'Docs_1' }), 'r1'],
    ['bad effect', rule({ effect: 'permit' }), 'r1'],
    ['constraint with no operator', rule({ when: [{ arg: 'a' }] }), 'r1'],
    [
      'constraint with optional but no operator',
      rule({ when: [{ arg: 'a', optional: true }] }),
      'r1',
    ],
    ['constraint with two operators', rule({ when: [{ arg: 'a', min: 1, max: 2 }] }), 'r1'],
    ['absent with optional', rule({ when: [{ arg: 'a', absent: true, optional: true }] }), 'r1'],
    ['absent: false', rule({ when: [{ arg: 'a', absent: false }] }), 'r1'],
    ['empty arg', rule({ when: [{ arg: '', min: 1 }] }), 'r1'],
    ['matches that does not compile', rule({ when: [{ arg: 'a', matches: '(' }] }), 'r1'],
    ['deny with when', rule({ effect: 'deny', when: [{ arg: 'a', equals: 1 }] }), 'r1'],
    ['deny with limits', rule({ effect: 'deny', limits: { per_minute: 1 } }), 'r1'],
    ['reason on allow', rule({ reason: 'because' }), 'r1'],
    ['reason on require_approval', rule({ effect: 'require_approval', reason: 'x' }), 'r1'],
    ['zero limit', rule({ limits: { per_minute: 0 } }), 'r1'],
    ['negative limit', rule({ limits: { per_session: -1 } }), 'r1'],
    ['fractional limit', rule({ limits: { per_minute: 1.5 } }), 'r1'],
    ['string limit', rule({ limits: { per_minute: '5' } }), 'r1'],
    ['negative max_length', rule({ when: [{ arg: 'a', max_length: -1 }] }), 'r1'],
    ['non-array in', rule({ when: [{ arg: 'a', in: 'x' }] }), 'r1'],
  ];
  it.each(cases)('%s', (_name, text, needle) => {
    const issues = issuesOf(text);
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) expect(issue).toMatch(/^rule (")?(r1|at index 0)/);
    expect(issues.join('\n')).toContain(needle);
  });

  it('names the rule id on unknown keys too', () => {
    expect(issuesOf(rule({ extra: 1 })).join('\n')).toContain('"r1"');
  });

  it('names the index when the id is missing', () => {
    const issues = issuesOf(
      JSON.stringify({
        version: 1,
        rules: [{ identities: '*', server: '*', tools: ['*'], effect: 'allow' }],
      }),
    );
    expect(issues.join('\n')).toContain('rule at index 0');
  });

  it('names the index when the id is invalid', () => {
    expect(issuesOf(rule({ id: 'Bad Id' })).join('\n')).toContain('rule at index 0');
  });

  it('rejects duplicate rule ids and names them', () => {
    const one = { id: 'dup', identities: '*', server: '*', tools: ['*'], effect: 'allow' };
    const issues = issuesOf(JSON.stringify({ version: 1, rules: [one, one] }));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('"dup"');
    expect(issues[0]).toContain('duplicate');
  });

  it('accepts "*" server and "*" identities', () => {
    expect(() => parsePolicy(rule({ server: '*', identities: '*' }))).not.toThrow();
  });

  it('accepts a deny rule with a reason', () => {
    expect(() => parsePolicy(rule({ effect: 'deny', reason: 'no' }))).not.toThrow();
  });
});

describe('top-level schema rules', () => {
  it('rejects unknown top-level keys', () => {
    expect(issuesOf('version: 1\nrules: []\ndefault: allow\n').join('\n')).toContain('default');
  });
  it('rejects unknown keys under audit', () => {
    expect(issuesOf('version: 1\naudit: {oops: 1}\nrules: []\n').join('\n')).toContain('oops');
  });
  it('requires version 1', () => {
    expect(issuesOf('version: 2\nrules: []\n').join('\n')).toContain('version');
    expect(issuesOf('rules: []\n').join('\n')).toContain('version');
  });
  it('requires rules', () => {
    expect(issuesOf('version: 1\n').join('\n')).toContain('rules');
  });
  it('rejects an empty document', () => {
    expect(issuesOf('').length).toBeGreaterThan(0);
  });
  it('rejects YAML with a duplicated key', () => {
    const issues = issuesOf('version: 1\nrules: []\nrules: []\n');
    expect(issues.join('\n')).toContain('Map keys must be unique');
  });
  it('rejects YAML that does not parse', () => {
    expect(issuesOf('version: [1\n').length).toBeGreaterThan(0);
  });
});

describe('loadPolicy', () => {
  it('reads a file and hashes its text', () => {
    const dir = mkdtempSync(join(tmpdir(), 'policy-'));
    const path = join(dir, 'policy.yaml');
    writeFileSync(path, EXAMPLE);
    const policy = loadPolicy(path);
    expect(policy.sha256).toBe(createHash('sha256').update(EXAMPLE).digest('hex'));
    expect(policy.rules).toHaveLength(2);
  });
});
