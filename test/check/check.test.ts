import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryTransport, type CallToolResult } from '@modelcontextprotocol/server';
import { Client, type Transport } from '@modelcontextprotocol/client';
import type { Approver } from '../../src/approval/types.js';
import { fileAuditSink, memoryAuditSink } from '../../src/audit/log.js';
import { checkSessions, type CheckResult } from '../../src/check/check.js';
import { formatCheck, formatLint, formatTests } from '../../src/check/report.js';
import { readSessionFile, type SessionRecord } from '../../src/check/sessions.js';
import { loadPolicy, parsePolicy, type Policy } from '../../src/policy/load.js';
import { sha256Hex, staticTokenAuthenticator } from '../../src/proxy/auth.js';
import { startHttpProxy } from '../../src/proxy/http.js';
import { policyGate } from '../../src/proxy/policy-gate.js';
import { startStdioProxy } from '../../src/proxy/stdio.js';
import { Upstreams, type UpstreamSpec } from '../../src/proxy/upstreams.js';
import { inMemoryUpstream, mockServer } from '../helpers/mock-upstream.js';
import { call, connectAgent, textOf } from '../helpers/proxy-client.js';

const EXAMPLES = fileURLToPath(new URL('../../examples/', import.meta.url));
const POLICY = loadPolicy(`${EXAMPLES}policy.yaml`);

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

let lineNo = 0;
function rec(over: Partial<SessionRecord>): SessionRecord {
  return {
    file: 'f.jsonl',
    line: ++lineNo,
    ts: 1_000_000,
    session: 's1',
    identity: 'writer',
    server: 'mail',
    tool: 'send',
    args: { to: 'team@example.test' },
    approved: false,
    ...over,
  };
}

describe('checkSessions', () => {
  it('finds nothing in the ok example', () => {
    const result = checkSessions(POLICY, [readSessionFile(`${EXAMPLES}sessions/ok.jsonl`)]);
    expect(result).toEqual({ files: 1, records: 6, violations: [] });
  });

  it('finds exactly the three violations in the violation example', () => {
    const file = `${EXAMPLES}sessions/violation.jsonl`;
    const result = checkSessions(POLICY, [readSessionFile(file)]);
    expect(result.records).toBe(5);
    expect(result.violations.map((v) => [v.line, v.tool, v.code, v.rule])).toEqual([
      [2, 'publish', 'denied_by_rule', 'writers-never-publish'],
      [3, 'send', 'constraint_failed', undefined],
      [5, 'delete_draft', 'no_matching_rule', undefined],
    ]);
    expect(result.violations[0]).toMatchObject({ file, session: 'writer-bad', identity: 'writer' });
  });

  it('refuses the third mail in a session, and counts per file', () => {
    const sends = [0, 1, 2].map((i) => rec({ ts: 1_000_000 + i * 120_000 }));
    const one = checkSessions(POLICY, [sends]);
    expect(one.violations.map((v) => [v.line, v.code])).toEqual([
      [sends[2]!.line, 'limit_exceeded'],
    ]);
    const split = checkSessions(POLICY, [sends.slice(0, 2), sends.slice(2)]);
    expect(split).toMatchObject({ files: 2, records: 3, violations: [] });
  });

  it('flags an approval-required call without an approval, and accepts one with it', () => {
    const publish = { identity: 'release-manager', server: 'docs', tool: 'publish', args: {} };
    const missing = checkSessions(POLICY, [[rec(publish)]]);
    expect(missing.violations).toHaveLength(1);
    expect(missing.violations[0]).toMatchObject({
      code: 'approval_missing',
      rule: 'release-publish',
      reason: 'rule "release-publish" requires approval and the record has none',
    });
    expect(checkSessions(POLICY, [[rec({ ...publish, approved: true })]]).violations).toEqual([]);
  });

  describe('a real proxy run', () => {
    async function auditOfRun(): Promise<string> {
      const sink = memoryAuditSink();
      const specs: UpstreamSpec[] = [
        ['docs', ['create_draft', 'list_drafts', 'publish']],
        ['mail', ['send']],
      ].map(([name, tools]) => ({
        name: name as string,
        transport: 'custom',
        connect: async (): Promise<Transport> => {
          const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
          await mockServer(
            name as string,
            (tools as string[]).map((t) => ({ name: t })),
            [],
          ).connect(serverSide);
          return clientSide;
        },
      }));
      const upstreams = await Upstreams.connect(specs);
      cleanups.push(() => upstreams.close());
      const proxy = await startHttpProxy({
        upstreams,
        gate: policyGate({ policy: POLICY, audit: sink }),
        authenticator: staticTokenAuthenticator([
          { name: 'writer', token_sha256: sha256Hex('tok-writer') },
        ]),
      });
      cleanups.push(() => proxy.close());
      const writer: Client = await connectAgent(proxy, 'tok-writer', 'live-session');
      cleanups.push(() => writer.close());
      await call(writer, 'docs__create_draft', { title: 'Notes' });
      await call(writer, 'docs__list_drafts');
      await call(writer, 'mail__send', { to: 'team@example.test' });
      // Refused live (and hidden from the writer), so it is never forwarded.
      await call(writer, 'docs__publish', { id: 'd1' }).catch(() => undefined);
      const dir = mkdtempSync(join(tmpdir(), 'audit-'));
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
      const path = join(dir, 'audit.jsonl');
      writeFileSync(path, sink.events.map((e) => JSON.stringify(e)).join('\n') + '\n');
      return path;
    }

    it('replays clean against the policy that served it, and fails a stricter one', async () => {
      const records = readSessionFile(await auditOfRun());
      expect(records.map((r) => `${r.server}.${r.tool}`)).toEqual([
        'docs.create_draft',
        'docs.list_drafts',
        'mail.send',
      ]);
      expect(checkSessions(POLICY, [records]).violations).toEqual([]);

      const stricter: Policy = parsePolicy(`
version: 1
rules:
  - { id: read-only, identities: [writer], server: docs, tools: [list_drafts], effect: allow }
`);
      expect(checkSessions(stricter, [records]).violations.map((v) => [v.tool, v.code])).toEqual([
        ['create_draft', 'no_matching_rule'],
        ['send', 'no_matching_rule'],
      ]);
    });

    it('reads approvals, refusals, timeouts, cancellations and failed forwards from a real log', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const served = parsePolicy(`
version: 1
rules:
  - { id: publish-approved, identities: [writer], server: docs, tools: [publish], effect: require_approval }
  - { id: mail, identities: [writer], server: mail, tools: [send], effect: allow }
`);
      const dir = mkdtempSync(join(tmpdir(), 'audit-'));
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
      const path = join(dir, 'audit.jsonl');
      const sink = fileAuditSink(path);
      const client = new AbortController();
      // The draft id says how the approver answers.
      const approver: Approver = {
        request: (pending, signal) =>
          new Promise((resolve) => {
            const id = (pending.args as { id?: string }).id;
            if (id === 'yes') resolve({ approved: true, approver: 'sam' });
            if (id === 'no') resolve({ approved: false, approver: 'sam' });
            if (id === 'gone') client.abort();
            signal.addEventListener('abort', () => resolve({ approved: false }));
          }),
      };
      const gate = policyGate({ policy: served, audit: sink, approver, approvalTimeoutMs: 20 });
      const caller = { identity: 'writer', session: 's1' };
      const ok = async (): Promise<CallToolResult> => ({ content: [] });
      const publish = (id: string, signal?: AbortSignal) =>
        gate.callTool(
          caller,
          { server: 'docs', tool: 'publish', args: { id } },
          ok,
          signal && { signal },
        );
      try {
        expect((await publish('yes')).isError).toBeFalsy();
        expect(textOf(await publish('no'))).toMatch(/approval_denied/);
        expect(textOf(await publish('wait'))).toMatch(/approval_timeout/);
        expect(textOf(await publish('gone', client.signal))).toMatch(/client_cancelled/);
        const failed = await gate.callTool(
          caller,
          { server: 'mail', tool: 'send', args: { to: 'team@example.test' } },
          async () => {
            throw new Error('upstream down');
          },
        );
        expect(textOf(failed)).toMatch(/^Upstream error: /);
      } finally {
        sink.close();
      }

      const records = readSessionFile(path);
      // Only the two forwarded calls are records; the three refusals are skipped.
      expect(records.map((r) => [r.tool, r.args, r.approved])).toEqual([
        ['publish', { id: 'yes' }, true],
        ['send', { to: 'team@example.test' }, false],
      ]);
      expect(checkSessions(served, [records]).violations).toEqual([]);

      const stricter = parsePolicy(`
version: 1
rules:
  - { id: no-publish, identities: [writer], server: docs, tools: [publish], effect: deny }
  - { id: mail-approved, identities: [writer], server: mail, tools: [send], effect: require_approval }
`);
      expect(checkSessions(stricter, [records]).violations.map((v) => [v.tool, v.code])).toEqual([
        ['publish', 'denied_by_rule'],
        ['send', 'approval_missing'],
      ]);
    });
  });

  describe('proxy restarts on one audit log', () => {
    const MAIL = { to: 'team@example.test', subject: 's', body: 'b' };
    // One mail per session: under it the second mail of each run is a violation.
    const ONE_MAIL = parsePolicy(`
version: 1
rules:
  - id: one-mail
    identities: [writer]
    server: mail
    tools: [send]
    effect: allow
    limits: { per_session: 1 }
`);

    function auditPath(): string {
      const dir = mkdtempSync(join(tmpdir(), 'audit-'));
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
      return join(dir, 'audit.jsonl');
    }

    const mailUpstream = (): UpstreamSpec[] => [inMemoryUpstream('mail', [{ name: 'send' }])];

    /** One proxy process's life: start on the shared log, send two mails, stop. */
    async function httpRun(path: string): Promise<void> {
      const sink = fileAuditSink(path);
      const upstreams = await Upstreams.connect(mailUpstream());
      const proxy = await startHttpProxy({
        upstreams,
        gate: policyGate({ policy: POLICY, audit: sink }),
        authenticator: staticTokenAuthenticator([
          { name: 'writer', token_sha256: sha256Hex('tok-writer') },
        ]),
      });
      const writer = await connectAgent(proxy, 'tok-writer', 'same-session');
      try {
        for (let i = 0; i < 2; i++) {
          expect((await call(writer, 'mail__send', MAIL)).isError).toBeFalsy();
        }
      } finally {
        await writer.close();
        await proxy.close();
        await upstreams.close();
        sink.close();
      }
    }

    /** A stdio launch: every one of them names its session `stdio`. */
    async function stdioRun(path: string): Promise<void> {
      const sink = fileAuditSink(path);
      const upstreams = await Upstreams.connect(mailUpstream());
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      const proxy = startStdioProxy({
        upstreams,
        gate: policyGate({ policy: POLICY, audit: sink }),
        identity: 'writer',
        transport: serverSide,
      });
      const agent = new Client(
        { name: 'test-agent', version: '0.0.0' },
        { versionNegotiation: { mode: 'auto' } },
      );
      await agent.connect(clientSide);
      try {
        for (let i = 0; i < 2; i++) {
          expect((await call(agent, 'mail__send', MAIL)).isError).toBeFalsy();
        }
      } finally {
        await agent.close();
        await proxy.close();
        await upstreams.close();
        sink.close();
      }
    }

    it.each([
      ['HTTP', httpRun, 'same-session'],
      ['stdio', stdioRun, 'stdio'],
    ] as const)('replays each %s run with its own counters', async (_kind, runProxy, session) => {
      const path = auditPath();
      await runProxy(path);
      await runProxy(path);
      const records = readSessionFile(path);
      expect(records.map((r) => r.session)).toEqual([session, session, session, session]);
      expect(new Set(records.map((r) => r.run)).size).toBe(2);

      // The example policy allows two mails per session; each run sent two.
      expect(checkSessions(POLICY, [records]).violations).toEqual([]);
      // Lines 1-4 are the first run (decision, outcome, decision, outcome), 5-8 the second.
      const strict = checkSessions(ONE_MAIL, [records]).violations;
      expect(strict.map((v) => [v.line, v.code])).toEqual([
        [3, 'limit_exceeded'],
        [7, 'limit_exceeded'],
      ]);
    });

    it('still counts records that name no run as one run per file', () => {
      const sends = [0, 1, 2].map((i) => rec({ ts: 1_000_000 + i * 120_000 }));
      expect(checkSessions(POLICY, [sends]).violations).toHaveLength(1);
      const split = sends.map((r, i) => ({ ...r, run: `run-${i}` }));
      expect(checkSessions(POLICY, [split]).violations).toEqual([]);
    });
  });
});

describe('formatCheck', () => {
  const result: CheckResult = {
    files: 2,
    records: 7,
    violations: [
      {
        file: 'a.jsonl',
        line: 2,
        session: 's',
        identity: 'writer',
        server: 'docs',
        tool: 'publish',
        code: 'denied_by_rule',
        rule: 'writers-never-publish',
        reason: 'rule "writers-never-publish" denies docs.publish for "writer"',
      },
      {
        file: 'b.jsonl',
        line: 4,
        session: 's',
        identity: 'writer',
        server: 'mail',
        tool: 'send',
        code: 'constraint_failed',
        reason: 'arguments rejected: x',
      },
    ],
  };

  it('prints text lines and a summary', () => {
    expect(formatCheck(result, 'text')).toBe(
      [
        'a.jsonl:2 writer docs.publish denied_by_rule: rule "writers-never-publish" denies docs.publish for "writer"',
        'b.jsonl:4 writer mail.send constraint_failed: arguments rejected: x',
        '2 violation(s) in 7 call(s) across 2 file(s)',
        '',
      ].join('\n'),
    );
  });

  it('says so when there are no violations', () => {
    expect(formatCheck({ files: 1, records: 6, violations: [] }, 'text')).toBe(
      'no violations in 6 call(s) across 1 file(s)\n',
    );
  });

  it('prints the result object as pretty JSON', () => {
    expect(formatCheck(result, 'json')).toBe(`{
  "files": 2,
  "records": 7,
  "violations": [
    {
      "file": "a.jsonl",
      "line": 2,
      "session": "s",
      "identity": "writer",
      "server": "docs",
      "tool": "publish",
      "code": "denied_by_rule",
      "rule": "writers-never-publish",
      "reason": "rule \\"writers-never-publish\\" denies docs.publish for \\"writer\\""
    },
    {
      "file": "b.jsonl",
      "line": 4,
      "session": "s",
      "identity": "writer",
      "server": "mail",
      "tool": "send",
      "code": "constraint_failed",
      "reason": "arguments rejected: x"
    }
  ]
}
`);
  });

  it('escapes control characters in recorded values so they cannot forge lines', () => {
    const forged = {
      ...result,
      violations: [
        {
          ...result.violations[0]!,
          tool: 'publish\n0 violation(s) in 1 call(s) across 1 file(s)\u2028',
        },
      ],
    };
    const out = formatCheck(forged, 'text');
    expect(out.split('\n')).toHaveLength(3);
    expect(out).toContain('docs.publish\\u{a}0 violation(s)');
    expect(out).toContain('\\u{2028} denied_by_rule');
  });

  it('prints GitHub annotations, escaping what the format reserves', () => {
    expect(formatCheck(result, 'github')).toBe(
      [
        '::error file=a.jsonl,line=2,title=Policy violation::writer docs.publish denied_by_rule: rule "writers-never-publish" denies docs.publish for "writer"',
        '::error file=b.jsonl,line=4,title=Policy violation::writer mail.send constraint_failed: arguments rejected: x',
        '2 violation(s) in 7 call(s) across 2 file(s)',
        '',
      ].join('\n'),
    );
    const tricky = {
      ...result,
      violations: [{ ...result.violations[0]!, file: 'a,b:c.jsonl', reason: '50%\nnext' }],
    };
    expect(formatCheck(tricky, 'github')).toContain(
      '::error file=a%2Cb%3Ac.jsonl,line=2,title=Policy violation::writer docs.publish denied_by_rule: 50%25%0Anext\n',
    );
  });
});

describe('formatTests and formatLint', () => {
  const results = [
    { file: 't.yaml', name: 'ok one', ok: true },
    { file: 't.yaml', name: 'bad one', ok: false, message: 'expected deny, got allow' },
  ];
  const issues = [
    { level: 'error' as const, rule: 'r1', message: 'bad thing' },
    { level: 'warning' as const, message: 'general thing' },
  ];

  it('formats policy test results', () => {
    expect(formatTests(results, 'text')).toBe(
      't.yaml: bad one: expected deny, got allow\n1 of 2 policy test(s) failed\n',
    );
    expect(formatTests(results.slice(0, 1), 'text')).toBe('1 policy test(s) passed\n');
    expect(formatTests(results, 'github')).toBe(
      '::error file=t.yaml,title=Policy test failed::bad one: expected deny, got allow\n1 of 2 policy test(s) failed\n',
    );
    expect(JSON.parse(formatTests(results, 'json'))).toEqual(results);
  });

  it('formats lint issues', () => {
    expect(formatLint(issues, 'text')).toBe(
      'error: rule "r1": bad thing\nwarning: general thing\n1 error(s), 1 warning(s)\n',
    );
    expect(formatLint(issues, 'github')).toBe(
      '::error title=Policy lint::rule "r1": bad thing\n::warning title=Policy lint::general thing\n1 error(s), 1 warning(s)\n',
    );
    expect(formatLint([], 'text')).toBe('0 error(s), 0 warning(s)\n');
    expect(JSON.parse(formatLint(issues, 'json'))).toEqual(issues);
  });
});
