import { createHmac } from 'node:crypto';
import type { ApprovalResult, Approver } from './types.js';

export const SIGNATURE_HEADER = 'x-mcp-policy-signature';

export function sign(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function webhookApprover(opts: {
  url: string;
  secret: string;
  fetch?: typeof fetch;
}): Approver {
  const { url, secret } = opts;
  return {
    async request(pending, signal) {
      // Signed exactly as sent, so the receiver can verify the bytes it got.
      const body = JSON.stringify(pending);
      const send = opts.fetch ?? fetch;
      const response = await send(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: sign(secret, body) },
        body,
        signal,
        // A redirect would re-send the pending call to a host nobody configured.
        redirect: 'manual',
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`approval webhook answered with status ${response.status}`);
      }
      let answer: unknown;
      try {
        answer = await response.json();
      } catch (e) {
        if (signal.aborted) throw e;
        throw new Error('approval webhook answered with a body that is not JSON');
      }
      if (!isRecord(answer) || typeof answer.approved !== 'boolean') {
        throw new Error('approval webhook answer has no boolean "approved"');
      }
      const result: ApprovalResult = { approved: answer.approved };
      if (typeof answer.approver === 'string') result.approver = answer.approver;
      if (typeof answer.note === 'string') result.note = answer.note;
      return result;
    },
  };
}
