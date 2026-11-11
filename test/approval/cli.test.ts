import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { cliApprover } from '../../src/approval/cli.js';
import type { PendingApproval } from '../../src/approval/types.js';

const pending = (overrides: Partial<PendingApproval> = {}): PendingApproval => ({
  call_id: 'call-1',
  identity: 'release-manager',
  session: 's1',
  server: 'docs',
  tool: 'publish',
  args: { id: 7, token: '[REDACTED]' },
  rule: 'release-publish',
  reason: 'rule "release-publish" requires approval',
  requested_at: '1970-01-01T00:00:01.000Z',
  ...overrides,
});

function terminal() {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.setEncoding('utf8');
  output.on('data', (chunk: string) => (text += chunk));
  return {
    input,
    output,
    approver: cliApprover({ input, output }),
    text: () => text,
    prompts: () => text.split('Approval needed:').length - 1,
  };
}

const signal = () => new AbortController().signal;

describe('cli approver', () => {
  it.each(['y', 'yes', 'Y', 'YES', ' yes '])('approves on %j', async (answer) => {
    const t = terminal();
    const result = t.approver.request(pending(), signal());
    await expect.poll(t.text).toContain('Approve? [y/N] ');
    t.input.write(`${answer}\n`);
    expect(await result).toEqual({ approved: true, approver: 'cli' });
  });

  it.each(['n', '', 'maybe', 'yess'])('refuses on %j', async (answer) => {
    const t = terminal();
    const result = t.approver.request(pending(), signal());
    await expect.poll(t.text).toContain('Approve? [y/N] ');
    t.input.write(`${answer}\n`);
    expect(await result).toEqual({ approved: false, approver: 'cli' });
  });

  it('shows who wants what, the redacted args and the rule', async () => {
    const t = terminal();
    const result = t.approver.request(pending(), signal());
    await expect.poll(t.text).toContain('Approve? [y/N] ');
    t.input.write('n\n');
    await result;

    const text = t.text();
    expect(text).toContain('Approval needed: release-manager wants docs.publish');
    expect(text).toContain('"id": 7');
    expect(text).toContain('"token": "[REDACTED]"');
    expect(text).toContain('release-publish');
    expect(text.endsWith('Approve? [y/N] ')).toBe(true);
  });

  it('prompts for concurrent requests one after the other', async () => {
    const t = terminal();
    const first = t.approver.request(pending({ call_id: 'a', args: { id: 1 } }), signal());
    const second = t.approver.request(pending({ call_id: 'b', args: { id: 2 } }), signal());

    await expect.poll(t.prompts).toBe(1);
    expect(t.text()).toContain('"id": 1');
    expect(t.text()).not.toContain('"id": 2');
    t.input.write('y\n');
    expect(await first).toEqual({ approved: true, approver: 'cli' });

    await expect.poll(t.prompts).toBe(2);
    expect(t.text()).toContain('"id": 2');
    t.input.write('n\n');
    expect(await second).toEqual({ approved: false, approver: 'cli' });
  });

  it('refuses when aborted at the prompt, then serves the next request', async () => {
    const t = terminal();
    const controller = new AbortController();
    const first = t.approver.request(pending({ args: { id: 1 } }), controller.signal);
    const second = t.approver.request(pending({ args: { id: 2 } }), signal());

    await expect.poll(t.prompts).toBe(1);
    controller.abort();
    expect(await first).toEqual({ approved: false });

    await expect.poll(t.prompts).toBe(2);
    t.input.write('y\n');
    expect(await second).toEqual({ approved: true, approver: 'cli' });
  });

  it('refuses a queued request aborted before its turn, without prompting for it', async () => {
    const t = terminal();
    const controller = new AbortController();
    const first = t.approver.request(pending({ args: { id: 1 } }), signal());
    const queued = t.approver.request(pending({ args: { id: 2 } }), controller.signal);
    const third = t.approver.request(pending({ args: { id: 3 } }), signal());

    await expect.poll(t.prompts).toBe(1);
    controller.abort();
    expect(await queued).toEqual({ approved: false });

    t.input.write('n\n');
    await first;
    await expect.poll(t.prompts).toBe(2);
    expect(t.text()).not.toContain('"id": 2');
    t.input.write('y\n');
    expect(await third).toEqual({ approved: true, approver: 'cli' });
  });

  it('refuses a request whose signal is already aborted', async () => {
    const t = terminal();
    expect(await t.approver.request(pending(), AbortSignal.abort())).toEqual({ approved: false });
    expect(t.prompts()).toBe(0);
  });

  it('refuses when the input ends', async () => {
    const t = terminal();
    const result = t.approver.request(pending(), signal());
    await expect.poll(t.prompts).toBe(1);
    t.input.end();
    expect(await result).toEqual(expect.objectContaining({ approved: false }));
    expect(await t.approver.request(pending(), signal())).toEqual(
      expect.objectContaining({ approved: false }),
    );
  });

  it('leaves the input stream open', async () => {
    const t = terminal();
    const result = t.approver.request(pending(), signal());
    await expect.poll(t.prompts).toBe(1);
    t.input.write('y\n');
    await result;
    expect(t.input.destroyed).toBe(false);
    expect(t.input.writableEnded).toBe(false);
  });
});
