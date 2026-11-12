import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readSessionFile, SessionFormatError } from '../../src/check/sessions.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function write(name: string, lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'sessions-'));
  dirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n'));
  return path;
}

const base = {
  ts: '2026-01-01T00:00:00.000Z',
  session: 's1',
  identity: 'writer',
  server: 'docs',
  tool: 'create_draft',
};

function failure(path: string, defaults?: { identity?: string }): SessionFormatError {
  try {
    readSessionFile(path, defaults);
  } catch (e) {
    if (e instanceof SessionFormatError) return e;
    throw e;
  }
  throw new Error('expected a SessionFormatError');
}

describe('readSessionFile', () => {
  it('reads session records and fills the defaults', () => {
    const path = write('run.jsonl', [
      { ...base, args: { title: 'a' }, approved: true },
      { ...base },
    ]);
    expect(readSessionFile(path)).toEqual([
      {
        file: path,
        line: 1,
        ts: Date.parse(base.ts),
        session: 's1',
        identity: 'writer',
        server: 'docs',
        tool: 'create_draft',
        args: { title: 'a' },
        approved: true,
      },
      {
        file: path,
        line: 2,
        ts: Date.parse(base.ts),
        session: 's1',
        identity: 'writer',
        server: 'docs',
        tool: 'create_draft',
        args: {},
        approved: false,
      },
    ]);
  });

  it('names the session after the file when the line has none, and takes the default identity', () => {
    const { session: _s, identity: _i, ...bare } = base;
    const path = write('my-run.jsonl', [bare]);
    const [record] = readSessionFile(path, { identity: 'reader' });
    expect(record).toMatchObject({ session: 'my-run.jsonl', identity: 'reader' });
  });

  it('accepts a numeric ts and a namespaced name or tool', () => {
    const { server: _s, tool: _t, ...rest } = base;
    const path = write('n.jsonl', [
      { ...rest, ts: 5, name: 'docs__publish' },
      { ...rest, ts: 6, tool: 'web__fetch_page' },
    ]);
    expect(readSessionFile(path).map((r) => [r.ts, r.server, r.tool])).toEqual([
      [5, 'docs', 'publish'],
      [6, 'web', 'fetch_page'],
    ]);
  });

  it('turns forwarded decision events into records and skips every other typed line', () => {
    const decision = {
      type: 'decision',
      ts: '2026-01-01T00:00:01.000Z',
      call_id: 'c1',
      session: 's9',
      identity: 'release-manager',
      server: 'docs',
      tool: 'publish',
      args: { id: 'd1' },
      effect: 'allow',
      code: 'approved',
      reason: 'x',
      visible: true,
      approval: { approved: true, approver: 'sam' },
      forwarded: true,
      policy_sha256: 'abc',
    };
    const path = write('audit.jsonl', [
      decision,
      { ...decision, forwarded: false, effect: 'deny', args: null, approval: undefined },
      { type: 'outcome', ts: base.ts, call_id: 'c1', ok: true },
      { type: 'list', ts: base.ts, session: 's9', identity: 'writer', tools: [] },
      { ...decision, forwarded: true, approval: undefined, tool: 'get_draft' },
    ]);
    const records = readSessionFile(path);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      line: 1,
      session: 's9',
      identity: 'release-manager',
      tool: 'publish',
      args: { id: 'd1' },
      approved: true,
    });
    expect(records[1]).toMatchObject({ line: 5, tool: 'get_draft', approved: false });
  });

  it('reads a file with a byte-order mark', () => {
    const path = write('bom.jsonl', ['\uFEFF' + JSON.stringify(base)]);
    expect(readSessionFile(path)).toHaveLength(1);
  });

  it('reads CRLF line endings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sessions-'));
    dirs.push(dir);
    const path = join(dir, 'crlf.jsonl');
    writeFileSync(path, `${JSON.stringify(base)}\r\n${JSON.stringify({ ...base, tool: 'x' })}\r\n`);
    expect(readSessionFile(path).map((r) => r.line)).toEqual([1, 2]);
  });

  it('skips blank lines and keeps real line numbers', () => {
    const path = write('b.jsonl', ['', { ...base }, '   ', { ...base, tool: 'x' }, '']);
    expect(readSessionFile(path).map((r) => r.line)).toEqual([2, 4]);
  });

  it('sorts by time and keeps file order for ties', () => {
    const path = write('s.jsonl', [
      { ...base, ts: 30, tool: 'c' },
      { ...base, ts: 10, tool: 'a' },
      { ...base, ts: 10, tool: 'b' },
      { ...base, ts: '1970-01-01T00:00:00.020Z', tool: 'd' },
    ]);
    expect(readSessionFile(path).map((r) => r.tool)).toEqual(['a', 'b', 'd', 'c']);
  });

  describe('errors name the file and the line', () => {
    const { ts: _ts, identity: _identity, ...noTs } = base;
    const cases: Array<[string, unknown[], number, RegExp, { identity?: string }?]> = [
      ['invalid JSON', [{ ...base }, '{not json'], 2, /not valid JSON/],
      ['a JSON array', [[1, 2]], 1, /must be a JSON object/],
      ['a missing ts', [{ ...base, ts: undefined }], 1, /"ts"/],
      ['an unparseable ts', [{ ...base, ts: 'yesterday' }], 1, /"ts"/],
      ['a non-finite ts', [{ ...base, ts: null }], 1, /"ts"/],
      ['a missing identity', [{ ...noTs, ts: base.ts }], 1, /identity/],
      ['an unsplittable name', [{ ts: base.ts, identity: 'w', name: 'publish' }], 1, /server/],
      ['a missing tool', [{ ts: base.ts, identity: 'w', server: 'docs' }], 1, /"tool"/],
      ['array args', [{ ...base, args: [1] }], 1, /"args"/],
      ['null args', [{ ...base, args: null }], 1, /"args"/],
      ['a non-boolean approved', [{ ...base, approved: 'yes' }], 1, /"approved"/],
    ];
    it.each(cases)('%s', (_name, lines, line, pattern, defaults) => {
      const path = write('bad.jsonl', lines);
      const error = failure(path, defaults);
      expect(error.file).toBe(path);
      expect(error.line).toBe(line);
      expect(error.message).toMatch(pattern);
      expect(error.message.startsWith(`${path}:${line}: `)).toBe(true);
    });

    const decision = {
      type: 'decision',
      ts: base.ts,
      forwarded: true,
      session: 's',
      identity: 'w',
      server: 'docs',
      tool: 'publish',
      args: {},
    };
    it.each([
      ['type "Decision"', { ...decision, type: 'Decision' }],
      ['type " decision"', { ...decision, type: ' decision' }],
      ['type null', { ...decision, type: null }],
      ['type 5', { ...decision, type: 5 }],
      ['type ""', { ...decision, type: '' }],
      ['type "tool_call"', { ...decision, type: 'tool_call' }],
    ])('refuses %s as an unknown event type', (_n, event) => {
      const error = failure(write('t.jsonl', [event]));
      expect(error.message).toMatch(/unknown event type/);
      expect(error.line).toBe(1);
    });

    it.each([
      ['"true"', 'true'],
      ['1', 1],
      ['missing', undefined],
      ['null', null],
    ])('refuses a decision whose forwarded is %s', (_n, forwarded) => {
      expect(failure(write('f.jsonl', [{ ...decision, forwarded }])).message).toMatch(
        /"forwarded"/,
      );
    });

    it.each([
      '1',
      '2',
      'Jan 5 2026',
      '2026-01-05',
      '2026-01-05T10:00:00',
      '2026-01-05 10:00:00Z',
      '2026-13-45T10:00:00Z',
    ])('refuses the ts string %j', (ts) => {
      expect(failure(write('t.jsonl', [{ ...base, ts }])).message).toMatch(/"ts"/);
    });

    it.each([
      '2026-01-05T10:00:00Z',
      '2026-01-05T10:00:00.123456789Z',
      '2026-01-05T10:00:00+02:00',
      '2026-01-05T10:00:00-05:30',
    ])('accepts the ts string %j', (ts) => {
      expect(readSessionFile(write('t.jsonl', [{ ...base, ts }]))).toHaveLength(1);
    });

    it('refuses a numeric ts outside the Date range', () => {
      for (const ts of ['8.64e15', '-8.64e15']) {
        expect(
          readSessionFile(
            write('r.jsonl', [`{"ts":${ts},"identity":"w","server":"d","tool":"t"}`]),
          ),
        ).toHaveLength(1);
      }
      expect(
        failure(
          write('r.jsonl', ['{"ts":8.640000000000001e15,"identity":"w","server":"d","tool":"t"}']),
        ).message,
      ).toMatch(/"ts"/);
    });

    it('says a plain name is not namespaced, even next to server and tool', () => {
      const error = failure(write('n.jsonl', [{ ...base, name: 'publish' }]));
      expect(error.message).toContain('"name" must be a namespaced server__tool name');
    });

    it('refuses a non-finite numeric ts', () => {
      expect(
        failure(write('t.jsonl', ['{"ts":1e999,"identity":"w","server":"d","tool":"t"}'])).line,
      ).toBe(1);
    });

    it('refuses target fields that name different calls', () => {
      const { server: _s, tool: _t, ...rest } = base;
      const bad = [
        { ...rest, name: 'docs__list_drafts', tool: 'docs__publish' },
        { ...rest, name: 'docs__publish', server: 'docs', tool: 'list_drafts' },
        { ...rest, name: 'web__publish', server: 'docs', tool: 'publish' },
      ];
      for (const event of bad) {
        expect(failure(write('c.jsonl', [event])).message).toMatch(/conflicting target fields/);
      }
      const agreeing = [
        { ...rest, name: 'docs__publish', tool: 'docs__publish' },
        { ...rest, name: 'docs__publish', server: 'docs', tool: 'publish' },
      ];
      expect(readSessionFile(write('a.jsonl', agreeing))).toHaveLength(2);
    });

    it('rejects a forwarded decision event whose args are not an object', () => {
      const path = write('bad.jsonl', [
        {
          type: 'decision',
          ts: base.ts,
          forwarded: true,
          session: 's',
          identity: 'w',
          server: 'docs',
          tool: 't',
          args: null,
        },
      ]);
      expect(failure(path).line).toBe(1);
    });
  });
});
