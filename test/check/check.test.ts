import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { Client, Transport } from '@modelcontextprotocol/client';
import { memoryAuditSink } from '../../src/audit/log.js';
import { checkSessions, type CheckResult } from '../../src/check/check.js';
import { formatCheck, formatLint, formatTests } from '../../src/check/report.js';
import { readSessionFile, type SessionRecord } from '../../src/check/sessions.js';
import { loadPolicy, parsePolicy, type Policy } from '../../src/policy/load.js';
import { sha256Hex, staticTokenAuthenticator } from '../../src/proxy/auth.js';
import { startHttpProxy } from '../../src/proxy/http.js';
import { policyGate } from '../../src/proxy/policy-gate.js';
import { Upstreams, type UpstreamSpec } from '../../src/proxy/upstreams.js';
import { mockServer } from '../helpers/mock-upstream.js';
import { call, connectAgent } from '../helpers/proxy-client.js';

const EXAMPLES = fileURLToPath(new URL('../../examples/', import.meta.url));
const POLICY = loadPolicy(`${EXAMPLES}policy.yaml`);

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
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
    expect(formatCheck(result, 'json')).toBe(JSON.stringify(result, null, 2) + '\n');
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
