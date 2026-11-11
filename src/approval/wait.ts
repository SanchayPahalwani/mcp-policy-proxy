import type { ApprovalResult, Approver, PendingApproval } from './types.js';

/** How the wait for an approver ended, as the gate sees it. */
export type ApprovalOutcome =
  | { kind: 'approved'; result: ApprovalResult }
  | { kind: 'refused'; result: ApprovalResult }
  | { kind: 'timeout'; timeoutMs: number }
  | { kind: 'error'; error: unknown }
  | { kind: 'cancelled' };

/**
 * Asks the approver, but never waits longer than `timeoutMs` or past the client giving up:
 * an approver that ignores the abort signal is left behind, and its late answer is dropped.
 */
export async function awaitApproval(
  approver: Approver,
  pending: PendingApproval,
  timeoutMs: number,
  clientSignal: AbortSignal | undefined,
): Promise<ApprovalOutcome> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let onClientAbort: (() => void) | undefined;
  // Each stop is settled before aborting, so an approver that rejects on abort cannot win.
  const stopped = new Promise<ApprovalOutcome>((resolve) => {
    timer = setTimeout(() => {
      resolve({ kind: 'timeout', timeoutMs });
      controller.abort(new Error('approval timed out'));
    }, timeoutMs);
    onClientAbort = () => {
      resolve({ kind: 'cancelled' });
      controller.abort(new Error('the client gave up'));
    };
    if (clientSignal?.aborted) onClientAbort();
    else clientSignal?.addEventListener('abort', onClientAbort, { once: true });
  });
  const answer = (async (): Promise<ApprovalOutcome> => {
    try {
      const result = await approver.request(pending, controller.signal);
      return result.approved === true ? { kind: 'approved', result } : { kind: 'refused', result };
    } catch (error) {
      return { kind: 'error', error };
    }
  })();
  try {
    return await Promise.race([answer, stopped]);
  } finally {
    clearTimeout(timer);
    if (onClientAbort) clientSignal?.removeEventListener('abort', onClientAbort);
  }
}
