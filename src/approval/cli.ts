import { randomInt } from 'node:crypto';
import { createInterface, type Interface } from 'node:readline';
import type { ApprovalResult, Approver, PendingApproval } from './types.js';

// No 0/o or 1/l, so the code reads the same in any terminal font.
const CODE_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

export function randomCode(): string {
  let code = '';
  for (let i = 0; i < 4; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/** Control and bidi characters could make the prompt show a different call than the real one. */
function printable(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    out += cp >= 0x20 && cp <= 0x7e ? ch : `\\u{${cp.toString(16)}}`;
  }
  return out;
}

function prompt(pending: PendingApproval, code: string): string {
  // JSON escapes newlines inside strings, so the only raw ones are the layout's own.
  const args = (JSON.stringify(pending.args, null, 2) ?? 'undefined')
    .split('\n')
    .map((line) => `  ${printable(line)}`)
    .join('\n');
  return [
    `Approval needed: ${printable(pending.identity)} wants ${printable(pending.server)}.${printable(pending.tool)}`,
    args,
    `Rule: ${printable(pending.rule)}`,
    `Type ${code} to approve, anything else to refuse: `,
  ].join('\n');
}

export function cliApprover(
  opts: {
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
    /** Makes the per-request code; injectable so tests can type it. */
    newCode?: () => string;
    /** Lines arriving this soon after a prompt are dropped; default 250 ms. */
    graceMs?: number;
    /** Milliseconds from any fixed origin; injectable so tests do not sleep. */
    now?: () => number;
  } = {},
): Approver {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stderr;
  const newCode = opts.newCode ?? randomCode;
  // A stray Enter typed earlier reaches us microseconds after the prompt, before anyone read it.
  const graceMs = opts.graceMs ?? 250;
  const now = opts.now ?? (() => performance.now());
  let lines: Interface | undefined;
  let inputEnded = false;
  // Set only while a prompt is shown: a line typed at any other time is discarded.
  let answer: ((line: string | undefined) => void) | undefined;
  // One prompt at a time: each request starts when the one before it has settled.
  let queue: Promise<unknown> = Promise.resolve();
  const closed = new AbortController();
  // A shutdown is noted as such, so the audit log never shows it as a person refusing.
  const refusal = (): ApprovalResult =>
    closed.signal.aborted ? { approved: false, note: 'approver closed' } : { approved: false };

  const say = (text: string) => {
    try {
      output.write(text);
    } catch {
      // The answer is already given; a broken terminal changes nothing.
    }
  };

  // Read continuously once started, never paused, so nothing typed while idle is kept
  // around to answer a later prompt.
  const startReading = async (): Promise<void> => {
    if (lines) return;
    lines = createInterface({ input, terminal: false });
    lines.on('line', (line) => answer?.(line));
    lines.on('close', () => {
      inputEnded = true;
      answer?.(undefined);
    });
    // Lets input that was buffered before anyone listened arrive, and be discarded, first.
    await new Promise((resolve) => setImmediate(resolve));
  };

  const ask = async (pending: PendingApproval, signal: AbortSignal): Promise<ApprovalResult> => {
    const gone = () => signal.aborted || closed.signal.aborted;
    if (gone()) return refusal();
    await startReading();
    if (gone()) return refusal();
    if (inputEnded) return { approved: false, note: 'terminal input closed' };
    return new Promise<ApprovalResult>((resolve) => {
      const finish = (result: ApprovalResult) => {
        answer = undefined;
        signal.removeEventListener('abort', onAbort);
        closed.signal.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const onAbort = () => {
        finish(refusal());
        say('\ncancelled\n');
      };
      try {
        const code = newCode();
        let promptedAt = Number.POSITIVE_INFINITY;
        signal.addEventListener('abort', onAbort, { once: true });
        closed.signal.addEventListener('abort', onAbort, { once: true });
        answer = (line) => {
          if (line === undefined) return finish({ approved: false, note: 'terminal input closed' });
          if (now() - promptedAt < graceMs) return;
          const approved = line.trim() === code;
          finish({ approved, approver: 'cli' });
          say(approved ? 'approved\n' : 'refused\n');
        };
        output.write(prompt(pending, code));
        promptedAt = now();
      } catch {
        finish({ approved: false });
      }
    });
  };

  return {
    request(pending, signal) {
      if (signal.aborted || closed.signal.aborted) return Promise.resolve(refusal());
      // A failure in one request must not stop the queue for the next.
      const turn = queue.then(() => ask(pending, signal)).catch(() => ({ approved: false }));
      queue = turn;
      // A request aborted while queued is answered now; its turn is skipped when it comes.
      return new Promise((resolve) => {
        const onAbort = () => resolve(refusal());
        signal.addEventListener('abort', onAbort, { once: true });
        closed.signal.addEventListener('abort', onAbort, { once: true });
        void turn.then((result) => {
          signal.removeEventListener('abort', onAbort);
          closed.signal.removeEventListener('abort', onAbort);
          resolve(result);
        });
      });
    },

    close() {
      if (closed.signal.aborted) return;
      closed.abort();
      // Removes our listeners and pauses the input, so it no longer holds the process open.
      // The stream itself is not ours to destroy.
      lines?.close();
    },
  };
}
