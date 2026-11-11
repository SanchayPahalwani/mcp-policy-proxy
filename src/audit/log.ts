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
  error?: string;
  duration_ms: number;
}

export interface ListEvent {
  type: 'list';
  ts: string;
  session: string;
  identity: string;
  tools: string[];
}

export type AuditEvent = DecisionEvent | OutcomeEvent | ListEvent;

export interface AuditSink {
  /** Synchronous; throws if the event cannot be stored. */
  write(event: AuditEvent): void;
}

export function fileAuditSink(path: string): AuditSink & { close(): void } {
  mkdirSync(dirname(path), { recursive: true });
  let fd: number | undefined = openSync(path, 'a');
  return {
    write(event) {
      if (fd === undefined) throw new Error(`audit log ${path} is closed`);
      // Synchronous, so the decision is with the OS before the gate goes on to forward.
      writeSync(fd, `${JSON.stringify(event)}\n`);
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
