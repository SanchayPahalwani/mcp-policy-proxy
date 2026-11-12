import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPolicy, parsePolicy, PolicyError } from '../../src/policy/load.js';
import { DEFAULT_REDACT_KEYS } from '../../src/policy/schema.js';
import { compileGlob, MAX_NAME_LENGTH } from '../../src/policy/match.js';

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

describe('compileGlob', () => {
  it('treats everything but * literally and anchors', () => {
    const m = compileGlob('a.b*(c)');
    expect(m('a.bXYZ(c)')).toBe(true);
    expect(m('a.b(c)')).toBe(true);
    expect(m('aXbXYZ(c)')).toBe(false);
    expect(m('xa.b(c)')).toBe(false);
    expect(m('a.b(c)x')).toBe(false);
  });
  it.each([
    ['*', '', true],
    ['*', 'anything', true],
    ['a*b*c', 'aXbYc', true],
    ['a*b*c', 'abc', true],
    ['a*b*c', 'acb', false],
    ['*end', 'the end', true],
    ['*end', 'ending', false],
    ['', '', true],
    ['', 'x', false],
    ['a**b', 'ab', true],
    ['get_*', 'forget_x', false],
  ])('glob %j against %j is %s', (glob, name, expected) => {
    expect(compileGlob(glob)(name)).toBe(expected);
  });
  it('does not blow up on a pathological glob', () => {
    const start = performance.now();
    expect(compileGlob('*a*a*a*a*b')('a'.repeat(5000))).toBe(false);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe('tool name length', () => {
  it('matches no rule above the cap, not even "*"', () => {
    const policy = parsePolicy(rule({ identities: '*', server: '*', tools: ['*'] }));
    const r = policy.rules[0]!;
    expect(MAX_NAME_LENGTH).toBe(256);
    expect(r.matches('a', 's', 'x'.repeat(256))).toBe(true);
    expect(r.matches('a', 's', 'x'.repeat(257))).toBe(false);
  });
});

describe('schema rules', () => {
  const cases: Array<[string, string, string]> = [
    ['unknown key on a rule', rule({ extra: 1 }), 'extra'],
    ['unknown key in a constraint', rule({ when: [{ arg: 'a', equals: 1, nope: 1 }] }), 'nope'],
    ['unknown key in limits', rule({ limits: { per_hour: 1 } }), 'per_hour'],
    ['bad rule id', rule({ id: 'Bad Id' }), 'must match'],
    ['empty identities list', rule({ identities: [] }), 'non-empty list of names'],
    ['identities not * or a list', rule({ identities: 'writer' }), 'non-empty list of names'],
    ['"*" inside identities', rule({ identities: ['*'] }), 'write identities: "*" instead'],
    ['"*" among other identities', rule({ identities: ['a', '*'] }), 'cannot contain "*"'],
    ['bad identity name', rule({ identities: ['Bad Name'] }), 'identity "Bad Name" must match'],
    ['non-string identity', rule({ identities: [5] }), 'identity 5 must match'],
    ['empty tools', rule({ tools: [] }), 'tools must not be empty'],
    ['bad server', rule({ server: 'Docs_1' }), 'server must be "*" or match'],
    ['bad effect', rule({ effect: 'permit' }), 'effect'],
    ['constraint with no operator', rule({ when: [{ arg: 'a' }] }), 'exactly one of'],
    [
      'constraint with optional but no operator',
      rule({ when: [{ arg: 'a', optional: true }] }),
      '(found 0)',
    ],
    ['constraint with two operators', rule({ when: [{ arg: 'a', min: 1, max: 2 }] }), '(found 2)'],
    [
      'absent with optional',
      rule({ when: [{ arg: 'a', absent: true, optional: true }] }),
      'cannot combine absent with optional',
    ],
    ['absent: false', rule({ when: [{ arg: 'a', absent: false }] }), 'when.0.absent'],
    ['empty arg', rule({ when: [{ arg: '', min: 1 }] }), 'when.0.arg'],
    ['arg with trailing dot', rule({ when: [{ arg: 'a.', min: 1 }] }), 'empty path segments'],
    ['arg with leading dot', rule({ when: [{ arg: '.a', min: 1 }] }), 'empty path segments'],
    ['arg with double dot', rule({ when: [{ arg: 'a..b', min: 1 }] }), 'empty path segments'],
    ['arg with a space', rule({ when: [{ arg: 'to address', min: 1 }] }), 'whitespace'],
    ['arg with a padded segment', rule({ when: [{ arg: 'to. address', min: 1 }] }), 'whitespace'],
    ['arg with a tab', rule({ when: [{ arg: 'to\taddress', min: 1 }] }), 'whitespace'],
    ['arg that is only a space', rule({ when: [{ arg: ' ', min: 1 }] }), 'whitespace'],
    [
      'matches that does not compile',
      rule({ when: [{ arg: 'a', matches: '(' }] }),
      'pattern does not compile',
    ],
    [
      'matches that escapes the anchors',
      rule({ when: [{ arg: 'a', matches: 'a)|(?:b' }] }),
      'pattern does not compile',
    ],
    [
      'deny with when',
      rule({ effect: 'deny', when: [{ arg: 'a', equals: 1 }] }),
      'deny rules must not have when',
    ],
    [
      'deny with limits',
      rule({ effect: 'deny', limits: { per_minute: 1 } }),
      'deny rules must not have limits',
    ],
    ['reason on allow', rule({ reason: 'because' }), 'reason is only allowed on deny rules'],
    [
      'reason on require_approval',
      rule({ effect: 'require_approval', reason: 'x' }),
      'reason is only allowed on deny rules',
    ],
    ['zero limit', rule({ limits: { per_minute: 0 } }), 'limits.per_minute'],
    ['negative limit', rule({ limits: { per_session: -1 } }), 'limits.per_session'],
    ['fractional limit', rule({ limits: { per_minute: 1.5 } }), 'limits.per_minute'],
    ['string limit', rule({ limits: { per_minute: '5' } }), 'limits.per_minute'],
    ['negative max_length', rule({ when: [{ arg: 'a', max_length: -1 }] }), 'when.0.max_length'],
    ['non-array in', rule({ when: [{ arg: 'a', in: 'x' }] }), 'when.0.in'],
  ];
  it.each(cases)('%s', (_name, text, needle) => {
    const issues = issuesOf(text);
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) expect(issue).toMatch(/^rule ("r1"|at index 0): /);
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
