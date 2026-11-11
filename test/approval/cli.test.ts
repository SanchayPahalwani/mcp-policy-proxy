import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { cliApprover, randomCode } from '../../src/approval/cli.js';
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

const PROMPT_END = 'to approve, anything else to refuse: ';

/** Codes `c001`, `c002`, … in request order, so a test can type the right one; no grace period. */
function terminal() {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  let codes = 0;
  output.setEncoding('utf8');
  output.on('data', (chunk: string) => (text += chunk));
  return {
    input,
    output,
    approver: cliApprover({
      input,
      output,
      newCode: () => `c${String(++codes).padStart(3, '0')}`,
      graceMs: 0,
    }),
    text: () => text,
    prompts: () => text.split('Approval needed:').length - 1,
  };
}

const signal = () => new AbortController().signal;
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('cli approver', () => {
  it('approves only on the code shown for this request', async () => {
    const t = terminal();
    const result = t.approver.request(pending(), signal());
    await expect.poll(t.text).toContain('Type c001 to approve, anything else to refuse: ');
    t.input.write(' c001 \n');
    expect(await result).toEqual({ approved: true, approver: 'cli' });
  });

  it.each(['y', 'yes', 'Y', '', 'c002', 'C001'])('refuses on %j', async (answer) => {
    const t = terminal();
    const result = t.approver.request(pending(), signal());
    await expect.poll(t.text).toContain(PROMPT_END);
    t.input.write(`${answer}\n`);
    expect(await result).toEqual({ approved: false, approver: 'cli' });
  });

  it('says what became of each request', async () => {
    const t = terminal();
    const controller = new AbortController();
    const first = t.approver.request(pending(), signal());
    const second = t.approver.request(pending(), signal());
    const third = t.approver.request(pending(), controller.signal);

    await expect.poll(t.prompts).toBe(1);
    t.input.write('c001\n');
    await first;
    await expect.poll(t.prompts).toBe(2);
    t.input.write('no\n');
    await second;
    await expect.poll(t.prompts).toBe(3);
    controller.abort();
    await third;

    const after = t.text().split(PROMPT_END).slice(1);
    expect(after).toEqual([
      expect.stringMatching(/^approved\n/),
      expect.stringMatching(/^refused\n/),
      '\ncancelled\n',
    ]);
  });

  it('ignores a line that arrives within the grace period after the prompt', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const time = { now: 1_000 };
    let text = '';
    output.setEncoding('utf8');
    output.on('data', (chunk: string) => (text += chunk));
    const approver = cliApprover({ input, output, newCode: () => 'abcd', now: () => time.now });

    const result = approver.request(pending(), signal());
    await expect.poll(() => text).toContain(PROMPT_END);
    time.now += 10;
    input.write('abcd\n');
    await tick();
    expect(await Promise.race([result, tick().then(() => 'pending')])).toBe('pending');
    expect(text.endsWith(PROMPT_END)).toBe(true);

    time.now += 290;
    input.write('abcd\n');
    expect(await result).toEqual({ approved: true, approver: 'cli' });
  });

  it('makes codes of four unambiguous characters', () => {
    for (let i = 0; i < 200; i++) expect(randomCode()).toMatch(/^[a-km-np-z2-9]{4}$/);
  });

  it('shows who wants what, the redacted args and the rule', async () => {
    const t = terminal();
    const result = t.approver.request(pending(), signal());
    await expect.poll(t.text).toContain(PROMPT_END);
    t.input.write('n\n');
    await result;

    const text = t.text();
    expect(text).toContain('Approval needed: release-manager wants docs.publish');
    expect(text).toContain('"id": 7');
    expect(text).toContain('"token": "[REDACTED]"');
    expect(text).toContain('Rule: release-publish');
    expect(text.endsWith(`${PROMPT_END}refused\n`)).toBe(true);
  });

  it('escapes control and bidi characters in what it prints', async () => {
    const t = terminal();
    const result = t.approver.request(
      pending({
        identity: 'ops\u001b[2K',
        tool: 'pub‮lish',
        rule: 'r\u0007',
        args: { note: 'a b', emoji: '\u{1f600}' },
      }),
      signal(),
    );
    await expect.poll(t.text).toContain(PROMPT_END);
    t.input.write('n\n');
    await result;

    const text = t.text();
    expect(text).toContain('ops\\u{1b}[2K wants docs.pub\\u{202e}lish');
    expect(text).toContain('Rule: r\\u{7}');
    expect(text).toContain('"note": "a\\u{2028}b"');
    expect(text).toContain('"emoji": "\\u{1f600}"');
    expect([...text].every((ch) => ch === '\n' || (ch >= ' ' && ch <= '~'))).toBe(true);
  });

  it('a line typed before any request answers nothing', async () => {
    const t = terminal();
    t.input.write('y\n');
    t.input.write('c001\n');
    await tick();
    const result = t.approver.request(pending(), signal());
    await expect.poll(t.text).toContain(PROMPT_END);
    await tick();
    expect(await Promise.race([result, tick().then(() => 'pending')])).toBe('pending');
    t.input.write('c001\n');
    expect(await result).toEqual({ approved: true, approver: 'cli' });
  });

  it('a line typed while idle between requests answers nothing', async () => {
    const t = terminal();
    const first = t.approver.request(pending(), signal());
    await expect.poll(t.prompts).toBe(1);
    t.input.write('c001\n');
    await first;

    t.input.write('c002\n');
    await tick();
    const second = t.approver.request(pending(), signal());
    await expect.poll(t.prompts).toBe(2);
    await tick();
    expect(await Promise.race([second, tick().then(() => 'pending')])).toBe('pending');
    t.input.write('nope\n');
    expect(await second).toEqual({ approved: false, approver: 'cli' });
  });

  it('prompts for concurrent requests one after the other', async () => {
    const t = terminal();
    const first = t.approver.request(pending({ call_id: 'a', args: { id: 1 } }), signal());
    const second = t.approver.request(pending({ call_id: 'b', args: { id: 2 } }), signal());

    await expect.poll(t.prompts).toBe(1);
    expect(t.text()).toContain('"id": 1');
    expect(t.text()).not.toContain('"id": 2');
    t.input.write('c001\n');
    expect(await first).toEqual({ approved: true, approver: 'cli' });

    await expect.poll(t.prompts).toBe(2);
    expect(t.text()).toContain('"id": 2');
    t.input.write('n\n');
    expect(await second).toEqual({ approved: false, approver: 'cli' });
  });

  it("an aborted request's code does not approve the next one", async () => {
    const t = terminal();
    const controller = new AbortController();
    const first = t.approver.request(pending({ args: { id: 1 } }), controller.signal);
    const second = t.approver.request(pending({ args: { id: 2 } }), signal());

    await expect.poll(t.prompts).toBe(1);
    controller.abort();
    expect(await first).toEqual({ approved: false });

    await expect.poll(t.prompts).toBe(2);
    t.input.write('c001\n');
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
    t.input.write('c002\n');
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
    t.input.write('c002\n');
    expect(await third).toEqual({ approved: true, approver: 'cli' });
  });

  it('refuses a request whose signal is already aborted', async () => {
    const t = terminal();
    expect(await t.approver.request(pending(), AbortSignal.abort())).toEqual({ approved: false });
    expect(t.prompts()).toBe(0);
  });

  it('refuses when the prompt cannot be written, and keeps serving', async () => {
    const input = new PassThrough();
    let broken = true;
    let text = '';
    const output = {
      write(chunk: string) {
        if (broken) throw new Error('terminal gone');
        text += chunk;
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    const approver = cliApprover({ input, output, newCode: () => 'abcd', graceMs: 0 });

    expect(await approver.request(pending(), signal())).toEqual({ approved: false });
    broken = false;
    const next = approver.request(pending(), signal());
    await expect.poll(() => text).toContain(PROMPT_END);
    input.write('abcd\n');
    expect(await next).toEqual({ approved: true, approver: 'cli' });
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
    t.input.write('c001\n');
    await result;
    expect(t.input.destroyed).toBe(false);
    expect(t.input.writableEnded).toBe(false);
  });
});
