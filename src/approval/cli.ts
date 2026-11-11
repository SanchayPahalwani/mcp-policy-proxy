import { createInterface, type Interface } from 'node:readline';
import type { ApprovalResult, Approver, PendingApproval } from './types.js';

const indent = (text: string) => text.replace(/^/gm, '  ');

function prompt(pending: PendingApproval): string {
  return [
    `Approval needed: ${pending.identity} wants ${pending.server}.${pending.tool}`,
    indent(JSON.stringify(pending.args, null, 2) ?? 'undefined'),
    `Rule: ${pending.rule}`,
    'Approve? [y/N] ',
  ].join('\n');
}

export function cliApprover(
  io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } = {
    input: process.stdin,
    output: process.stderr,
  },
): Approver {
  let lines: Interface | undefined;
  let inputEnded = false;
  // Set only while a prompt is shown, so a line typed at any other time answers nothing.
  let answer: ((line: string | undefined) => void) | undefined;
  // One prompt at a time: each request starts when the one before it has settled.
  let queue: Promise<unknown> = Promise.resolve();

  const reader = (): Interface => {
    if (!lines) {
      lines = createInterface({ input: io.input, terminal: false });
      lines.on('line', (line) => answer?.(line));
      lines.on('close', () => {
        inputEnded = true;
        answer?.(undefined);
      });
    }
    return lines;
  };

  const ask = (pending: PendingApproval, signal: AbortSignal) =>
    new Promise<ApprovalResult>((resolve) => {
      if (signal.aborted) return resolve({ approved: false });
      if (inputEnded) return resolve({ approved: false, note: 'terminal input closed' });
      const rl = reader();
      const finish = (result: ApprovalResult) => {
        answer = undefined;
        signal.removeEventListener('abort', onAbort);
        // Paused between prompts so an idle terminal does not keep the process alive.
        if (!inputEnded) rl.pause();
        resolve(result);
      };
      const onAbort = () => {
        io.output.write('\n(no longer waiting)\n');
        finish({ approved: false });
      };
      signal.addEventListener('abort', onAbort, { once: true });
      answer = (line) =>
        finish(
          line === undefined
            ? { approved: false, note: 'terminal input closed' }
            : { approved: /^(y|yes)$/i.test(line.trim()), approver: 'cli' },
        );
      io.output.write(prompt(pending));
      rl.resume();
    });

  return {
    request(pending, signal) {
      const turn = queue.then(() => ask(pending, signal));
      queue = turn;
      if (signal.aborted) return Promise.resolve({ approved: false });
      // A request aborted while queued is answered now; its turn is skipped when it comes.
      return new Promise((resolve) => {
        const onAbort = () => resolve({ approved: false });
        signal.addEventListener('abort', onAbort, { once: true });
        void turn.then((result) => {
          signal.removeEventListener('abort', onAbort);
          resolve(result);
        });
      });
    },
  };
}
