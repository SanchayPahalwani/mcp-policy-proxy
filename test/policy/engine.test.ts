import { describe, expect, it } from 'vitest';
import { commit, decide, visible, type Call, type Decision } from '../../src/policy/engine.js';
import { LimitState } from '../../src/policy/limits.js';
import { parsePolicy } from '../../src/policy/load.js';

const WRITER_DRAFTS = `
  - id: writer-drafts
    identities: [writer]
    server: docs
    tools: [list_drafts, get_draft, create_draft, update_draft]
    effect: allow
    when:
      - arg: title
        max_length: 120
        optional: true
    limits:
      per_minute: 3
      per_session: 5
`;
const NEVER_PUBLISH = `
  - id: writers-never-publish
    identities: [writer]
    server: docs
    tools: [publish]
    effect: deny
    reason: Publishing needs a release manager.
`;
const RELEASE_PUBLISH = `
  - id: release-publish
    identities: [release-manager]
    server: docs
    tools: [publish]
    effect: require_approval
`;
const ANYONE_FETCH = `
  - id: anyone-fetch
    identities: "*"
    server: web
    tools: [fetch_page]
    effect: allow
    when:
      - arg: url
        matches: 'https://docs\\.example\\.test/.*'
`;
const BROAD_DOCS = `
  - id: broad-docs
    identities: [writer]
    server: docs
    tools: ["*"]
    effect: allow
    limits:
      per_session: 4
`;

const yamlOf = (blocks: string[]) => `version: 1\nrules:${blocks.join('')}`;
const ALL = [WRITER_DRAFTS, NEVER_PUBLISH, RELEASE_PUBLISH, ANYONE_FETCH, BROAD_DOCS];
const policy = parsePolicy(yamlOf(ALL));

const call = (over: Partial<Call> = {}): Call => ({
  identity: 'writer',
  session: 's1',
  server: 'docs',
  tool: 'get_draft',
  args: {},
  at: 0,
  ...over,
});

const run = (c: Call, p = policy, state = new LimitState()) => decide(p, state, c);

describe('decide', () => {
  it('allows a call and applies every kept permitting rule', () => {
    expect(run(call())).toEqual({
      effect: 'allow',
      code: 'allowed',
      rule: 'writer-drafts',
      reason: 'allowed by rule "writer-drafts"',
      applied: ['writer-drafts', 'broad-docs'],
      visible: true,
    });
  });

  it('lets deny override allow', () => {
    expect(run(call({ tool: 'publish' }))).toEqual({
      effect: 'deny',
      code: 'denied_by_rule',
      rule: 'writers-never-publish',
      reason:
        'rule "writers-never-publish" denies docs.publish for "writer": Publishing needs a release manager.',
      applied: [],
      visible: false,
    });
  });

  it('omits the reason suffix when a deny rule has none', () => {
    const p = parsePolicy(
      yamlOf([NEVER_PUBLISH.replace('    reason: Publishing needs a release manager.\n', '')]),
    );
    expect(run(call({ tool: 'publish' }), p).reason).toBe(
      'rule "writers-never-publish" denies docs.publish for "writer"',
    );
  });

  it('gives the same effect and code whatever the rule order', () => {
    const reversed = parsePolicy(yamlOf([...ALL].reverse()));
    const calls = [
      call(),
      call({ tool: 'publish' }),
      call({ tool: 'create_draft', args: { title: 'x'.repeat(121) } }),
      call({ tool: 'delete_everything' }),
      call({ identity: 'release-manager', tool: 'publish' }),
      call({ identity: 'nobody' }),
      call({ server: 'mail', tool: 'send' }),
      call({ server: 'web', tool: 'fetch_page', args: { url: 'https://docs.example.test/a' } }),
      call({ server: 'web', tool: 'fetch_page', args: { url: 'https://evil.test/' } }),
      call({ server: 'web', tool: 'fetch_page' }),
    ];
    for (const c of calls) {
      const a = run(c);
      const b = run(c, reversed);
      expect([b.effect, b.code]).toEqual([a.effect, a.code]);
    }
  });

  it('denies by default', () => {
    expect(run(call({ identity: 'nobody' }))).toEqual({
      effect: 'deny',
      code: 'no_matching_rule',
      reason: 'no rule allows "nobody" to call docs.get_draft',
      applied: [],
      visible: false,
    });
    const mail = run(call({ server: 'mail', tool: 'send' }));
    expect(mail).toEqual({
      effect: 'deny',
      code: 'no_matching_rule',
      reason: 'no rule allows "writer" to call mail.send',
      applied: [],
      visible: false,
    });
  });

  it('lets a rule without constraints keep a call another rule rejects', () => {
    const long = call({ tool: 'create_draft', args: { title: 'x'.repeat(121) } });
    const withBroad = run(long);
    expect(withBroad).toEqual({
      effect: 'allow',
      code: 'allowed',
      rule: 'broad-docs',
      reason: 'allowed by rule "broad-docs"',
      applied: ['broad-docs'],
      visible: true,
    });

    const narrow = parsePolicy(yamlOf([WRITER_DRAFTS, NEVER_PUBLISH]));
    expect(run(long, narrow)).toEqual({
      effect: 'deny',
      code: 'constraint_failed',
      reason: 'arguments rejected: rule "writer-drafts": title must be at most 120 characters',
      applied: [],
      visible: true,
    });
  });

  it('rejects arguments outside the allowed pattern', () => {
    const outside = run(
      call({
        server: 'web',
        tool: 'fetch_page',
        args: { url: 'https://evil.test/?x=docs.example.test' },
      }),
    );
    expect(outside.effect).toBe('deny');
    expect(outside.code).toBe('constraint_failed');
    expect(outside.rule).toBeUndefined();
    expect(outside.applied).toEqual([]);
    expect(outside.visible).toBe(true);
    expect(outside.reason).toMatch(/^arguments rejected: rule "anyone-fetch": /);

    const missing = run(call({ server: 'web', tool: 'fetch_page', args: {} }));
    expect(missing).toEqual({
      effect: 'deny',
      code: 'constraint_failed',
      reason: 'arguments rejected: rule "anyone-fetch": url is missing',
      applied: [],
      visible: true,
    });
  });

  it('joins the failing constraint of each candidate', () => {
    const p = parsePolicy(
      yamlOf([
        WRITER_DRAFTS,
        `
  - id: second
    identities: [writer]
    server: docs
    tools: [create_draft]
    effect: allow
    when:
      - arg: title
        max_length: 5
`,
      ]),
    );
    const d = run(call({ tool: 'create_draft', args: { title: 'x'.repeat(121) } }), p);
    expect(d.reason).toBe(
      'arguments rejected: rule "writer-drafts": title must be at most 120 characters; rule "second": title must be at most 5 characters',
    );
  });

  it('requires approval', () => {
    expect(run(call({ identity: 'release-manager', tool: 'publish' }))).toEqual({
      effect: 'require_approval',
      code: 'approval_required',
      rule: 'release-publish',
      reason: 'rule "release-publish" requires approval',
      applied: ['release-publish'],
      visible: true,
    });
  });

  it('lets the stricter effect win over an allow', () => {
    const p = parsePolicy(
      yamlOf([
        `
  - id: release-allow
    identities: [release-manager]
    server: docs
    tools: [publish]
    effect: allow
`,
        ...ALL,
      ]),
    );
    const d = run(call({ identity: 'release-manager', tool: 'publish' }), p);
    expect(d).toEqual({
      effect: 'require_approval',
      code: 'approval_required',
      rule: 'release-publish',
      reason: 'rule "release-publish" requires approval',
      applied: ['release-allow', 'release-publish'],
      visible: true,
    });
  });
});

describe('limits', () => {
  const forward = (state: LimitState, c: Call): Decision => {
    const d = decide(policy, state, c);
    expect(d.code).toBe('allowed');
    commit(state, c, d);
    return d;
  };

  it('stops a session at the per-session limit of the first exhausted rule', () => {
    const state = new LimitState();
    // 25 s apart keeps writer-drafts under its per-minute limit of 3.
    for (let i = 0; i < 4; i++) forward(state, call({ tool: 'update_draft', at: i * 25_000 }));
    expect(run(call({ tool: 'update_draft', at: 100_000 }), policy, state)).toEqual({
      effect: 'deny',
      code: 'limit_exceeded',
      rule: 'broad-docs',
      reason: 'rule "broad-docs": limit of 4 calls per session reached',
      applied: [],
      visible: true,
    });
  });

  it('stops a burst at the per-minute limit, then allows again after the window', () => {
    const state = new LimitState();
    for (let i = 0; i < 3; i++) forward(state, call({ session: 's2', at: i * 1000 }));
    expect(run(call({ session: 's2', at: 3000 }), policy, state)).toEqual({
      effect: 'deny',
      code: 'limit_exceeded',
      rule: 'writer-drafts',
      reason: 'rule "writer-drafts": limit of 3 calls per minute reached',
      applied: [],
      visible: true,
    });
    expect(run(call({ session: 's2', at: 63_000 }), policy, state).code).toBe('allowed');
  });

  it('fails closed when the clock steps back before recorded calls', () => {
    const p = parsePolicy(
      yamlOf([
        `
  - id: burst
    identities: [writer]
    server: docs
    tools: ["*"]
    effect: allow
    limits:
      per_minute: 3
`,
      ]),
    );
    const state = new LimitState();
    for (const at of [100_000, 101_000, 102_000]) {
      const c = call({ at });
      commit(state, c, decide(p, state, c));
    }
    expect(decide(p, state, call({ at: 99_000 })).code).toBe('limit_exceeded');
  });

  it('throws on a non-finite call time', () => {
    for (const at of [NaN, Infinity, -Infinity]) {
      expect(() => decide(policy, new LimitState(), call({ at }))).toThrow(RangeError);
    }
  });

  it('reports per session before per minute inside one rule', () => {
    const p = parsePolicy(
      yamlOf([
        `
  - id: tight
    identities: [writer]
    server: docs
    tools: ["*"]
    effect: allow
    limits:
      per_minute: 1
      per_session: 1
`,
      ]),
    );
    const state = new LimitState();
    const c = call();
    commit(state, c, decide(p, state, c));
    expect(decide(p, state, c).reason).toBe('rule "tight": limit of 1 calls per session reached');
  });

  it('never changes counts when only deciding', () => {
    const state = new LimitState();
    for (let i = 0; i < 100; i++) decide(policy, state, call());
    expect(decide(policy, state, call()).code).toBe('allowed');
    expect(state.minuteCount('writer-drafts', 'writer', 0)).toBe(0);
  });

  it('records nothing when committing a deny', () => {
    const state = new LimitState();
    const c = call({ tool: 'publish' });
    const d = decide(policy, state, c);
    commit(state, c, d);
    expect(state.minuteCount('broad-docs', 'writer', 0)).toBe(0);
    expect(state.sessionCount('broad-docs', 'writer', 's1')).toBe(0);
  });
});

describe('visible', () => {
  it.each([
    ['writer', 'docs', 'create_draft', true],
    ['writer', 'docs', 'publish', false],
    ['release-manager', 'docs', 'publish', true],
    ['writer', 'web', 'fetch_page', true],
    ['nobody', 'docs', 'get_draft', false],
  ])('%s on %s.%s is %s', (identity, server, tool, expected) => {
    expect(visible(policy, identity, server, tool)).toBe(expected);
  });
});
