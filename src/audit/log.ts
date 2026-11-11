import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export interface DecisionEvent {
  type: 'decision';
  ts: string;
  call_id: string;
  session: string;
  identity: string;
  server: string;
  tool: string;
  args: unknown;
  effect: 'allow' | 'deny';
  code: string;
  rule?: string;
  reason: string;
  visible: boolean;
  /** Set for every call the approver was asked about, whatever the answer. */
  approval_requested_at?: string;
  approval?: { approved: boolean; approver?: string; note?: string };
  forwarded: boolean;
  policy_sha256: string;
}

export interface OutcomeEvent {
  type: 'outcome';
  ts: string;
  call_id: string;
  ok: boolean;
  is_error: boolean;
  /**
   * One of three values: `protocol_error <code>` for a JSON-RPC reserved code from the
   * upstream, `error` for any other upstream failure, or `internal_error` when the proxy
   * itself failed after clearing the call. Never the message, class or another code: an
   * upstream picks those and can make them echo an argument.
   */
  error?: string;
  duration_ms: number;
  policy_sha256: string;
}

export interface ListEvent {
  type: 'list';
  ts: string;
  session: string;
  identity: string;
  tools: string[];
  policy_sha256: string;
}

export type AuditEvent = DecisionEvent | OutcomeEvent | ListEvent;

export interface AuditSink {
  /**
   * Synchronous; throws if the event cannot be stored. Returning a promise breaks the
   * contract, because the gate would forward before knowing whether the write landed:
   * the gate treats a returned thenable as a failed write.
   */
  write(event: AuditEvent): void;
}

export function fileAuditSink(path: string): AuditSink & { close(): void } {
  mkdirSync(dirname(path), { recursive: true });
  // Owner-only: the log holds call arguments. The mode applies when the file is created.
  let fd: number | undefined = openSync(path, 'a', 0o600);
  return {
    write(event) {
      if (fd === undefined) throw new Error(`audit log ${path} is closed`);
      // Synchronous, so the decision is with the OS before the gate goes on to forward.
      const line = Buffer.from(`${JSON.stringify(event)}\n`);
      // A short write is legal; keep going so no line is left without its newline.
      for (let offset = 0; offset < line.length;) {
        const written = writeSync(fd, line, offset, line.length - offset);
        if (written <= 0) throw new Error(`audit log ${path}: write made no progress`);
        offset += written;
      }
    },
    close() {
      if (fd === undefined) return;
      closeSync(fd);
      fd = undefined;
    },
  };
}

export function memoryAuditSink(): AuditSink & { events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  return { events, write: (event) => void events.push(event) };
}
