import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileAuditSink, memoryAuditSink, type AuditEvent } from '../../src/audit/log.js';

// Lets a test make the OS accept fewer bytes than asked, or none; otherwise the real call.
const fs = vi.hoisted(() => ({ mode: 'real' as 'real' | 'short' | 'zero' }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeSync: (fd: number, buffer: Buffer, offset: number, length: number) => {
      if (fs.mode === 'zero') return 0;
      return actual.writeSync(
        fd,
        buffer,
        offset,
        fs.mode === 'short' ? Math.min(length, 5) : length,
      );
    },
  };
});

const dirs: string[] = [];

afterEach(() => {
  fs.mode = 'real';
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-policy-audit-'));
  dirs.push(dir);
  return dir;
}

const listEvent = (n: number): AuditEvent => ({
  type: 'list',
  ts: new Date(n).toISOString(),
  session: 's1',
  identity: 'writer',
  tools: [`docs__tool_${n}`],
  policy_sha256: 'abc',
});

const outcome: AuditEvent = {
  type: 'outcome',
  ts: new Date(0).toISOString(),
  call_id: 'c1',
  ok: true,
  is_error: false,
  duration_ms: 4,
  policy_sha256: 'abc',
};

function lines(path: string): unknown[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as unknown);
}

describe('fileAuditSink', () => {
  it('writes one JSON line per event, in order, appending across sinks', () => {
    const path = join(tempDir(), 'nested', 'dir', 'audit.jsonl');

    const first = fileAuditSink(path);
    first.write(listEvent(1));
    first.write(outcome);
    first.close();
    const second = fileAuditSink(path);
    second.write(listEvent(2));
    second.close();

    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true);
    expect(lines(path)).toEqual([listEvent(1), outcome, listEvent(2)]);
  });

  it('creates the file readable by its owner only', () => {
    const path = join(tempDir(), 'audit.jsonl');
    fileAuditSink(path).close();
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('finishes a line the OS accepted only part of', () => {
    const path = join(tempDir(), 'audit.jsonl');
    const sink = fileAuditSink(path);
    fs.mode = 'short';
    sink.write(outcome);
    sink.write(listEvent(1));
    sink.close();
    expect(lines(path)).toEqual([outcome, listEvent(1)]);
  });

  it('throws when a write makes no progress', () => {
    const sink = fileAuditSink(join(tempDir(), 'audit.jsonl'));
    fs.mode = 'zero';
    expect(() => sink.write(outcome)).toThrow(/no progress/);
    sink.close();
  });

  it('throws when written after close', () => {
    const sink = fileAuditSink(join(tempDir(), 'audit.jsonl'));
    sink.close();
    expect(() => sink.write(outcome)).toThrow();
  });
});

describe('memoryAuditSink', () => {
  it('keeps events in order', () => {
    const sink = memoryAuditSink();
    sink.write(listEvent(1));
    sink.write(outcome);
    expect(sink.events).toEqual([listEvent(1), outcome]);
  });
});
