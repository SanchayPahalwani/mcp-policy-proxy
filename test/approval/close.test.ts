import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cliApprover } from '../../src/approval/cli.js';
import type { PendingApproval } from '../../src/approval/types.js';

const CHILD = fileURLToPath(new URL('../helpers/cli-approver-child.ts', import.meta.url));

const PENDING: PendingApproval = {
  call_id: 'c1',
  identity: 'release-manager',
  session: 's1',
  server: 'docs',
  tool: 'publish',
  args: { id: 7 },
  rule: 'release-publish',
  reason: 'rule "release-publish" requires approval',
  requested_at: new Date(0).toISOString(),
};

const signal = () => new AbortController().signal;

describe('closing the cli approver', () => {
  it('lets the process exit while its stdin stays open', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', CHILD], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
    try {
      await expect
        .poll(() => /Type (\w{4}) to approve/.exec(stderr), { timeout: 8_000 })
        .toBeTruthy();
      const code = /Type (\w{4}) to approve/.exec(stderr)?.[1];
      // Past the grace period, so the answer counts.
      await new Promise((resolve) => setTimeout(resolve, 300));
      child.stdin.write(`${code}\n`);
      await expect.poll(() => stderr).toContain('RESULT');
      expect(stderr).toContain('RESULT {"approved":true,"approver":"cli"}');

      // stdin is deliberately left open: only close() can release the event loop.
      const timeout = new Promise<'still running'>((resolve) =>
        setTimeout(() => resolve('still running'), 3_000).unref(),
      );
      expect(await Promise.race([exited, timeout])).toBe(0);
    } finally {
      child.stdin.end();
      if (child.exitCode === null) child.kill();
    }
  }, 15_000);

  it('refuses the request at the prompt and every later one', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = '';
    output.setEncoding('utf8');
    output.on('data', (chunk: string) => (text += chunk));
    const approver = cliApprover({ input, output, graceMs: 0 });

    const active = approver.request(PENDING, signal());
    const queued = approver.request(PENDING, signal());
    await expect.poll(() => text).toContain('to approve');
    await approver.close?.();

    // Noted, so the audit log does not show a shutdown as a person saying no.
    const closed = { approved: false, note: 'approver closed' };
    expect(await active).toEqual(closed);
    expect(await queued).toEqual(closed);
    expect(await approver.request(PENDING, signal())).toEqual(closed);
    expect(text).toContain('cancelled');
    expect(text.split('Approval needed:')).toHaveLength(2);
    expect(input.destroyed).toBe(false);
    expect(input.listenerCount('data')).toBe(0);
  });

  it('refuses after close without ever having prompted', async () => {
    const approver = cliApprover({ input: new PassThrough(), output: new PassThrough() });
    await approver.close?.();
    expect(await approver.request(PENDING, signal())).toEqual({
      approved: false,
      note: 'approver closed',
    });
  });

  it('still answers a request its own caller gave up on without the note', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = '';
    output.setEncoding('utf8');
    output.on('data', (chunk: string) => (text += chunk));
    const approver = cliApprover({ input, output, graceMs: 0 });
    const caller = new AbortController();
    const active = approver.request(PENDING, caller.signal);
    await expect.poll(() => text).toContain('to approve');
    caller.abort();
    expect(await active).toEqual({ approved: false });
    await approver.close?.();
  });
});
