/** A call waiting for a human; `args` are already redacted, since they leave the proxy. */
export interface PendingApproval {
  call_id: string;
  identity: string;
  session: string;
  server: string;
  tool: string;
  args: unknown;
  rule: string;
  reason: string;
  requested_at: string;
}

export interface ApprovalResult {
  approved: boolean;
  approver?: string;
  note?: string;
}

export interface Approver {
  /** `signal` aborts when the proxy stops waiting; the answer is then ignored. */
  request(pending: PendingApproval, signal: AbortSignal): Promise<ApprovalResult>;
}

export const denyApprover: Approver = {
  request: async () => ({ approved: false, note: 'no approver configured' }),
};

export function fixedApprover(
  fn: (pending: PendingApproval) => ApprovalResult | Promise<ApprovalResult>,
): Approver {
  return { request: async (pending) => fn(pending) };
}
