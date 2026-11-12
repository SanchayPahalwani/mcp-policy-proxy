import { commit, decide, type DecisionCode } from '../policy/engine.js';
import { LimitState } from '../policy/limits.js';
import type { Policy } from '../policy/load.js';
import type { SessionRecord } from './sessions.js';

export interface Violation {
  file: string;
  line: number;
  session: string;
  identity: string;
  server: string;
  tool: string;
  code: DecisionCode | 'approval_missing';
  rule?: string;
  reason: string;
}

export interface CheckResult {
  files: number;
  records: number;
  violations: Violation[];
}

export function checkSessions(policy: Policy, files: SessionRecord[][]): CheckResult {
  const violations: Violation[] = [];
  let records = 0;
  for (const file of files) {
    // A live proxy's counters start empty each time it starts, so each run named in the log
    // gets its own. Lines that name no run (hand-written records, older logs) are one run per file.
    const states = new Map<string | undefined, LimitState>();
    for (const record of file) {
      records++;
      let state = states.get(record.run);
      if (state === undefined) states.set(record.run, (state = new LimitState()));
      const { identity, session, server, tool, args, ts: at } = record;
      const call = { identity, session, server, tool, args, at };
      const decision = decide(policy, state, call);
      const where = { file: record.file, line: record.line, session, identity, server, tool };
      if (decision.effect === 'allow') {
        commit(state, call, decision);
      } else if (decision.effect === 'require_approval') {
        if (record.approved) {
          commit(state, call, decision);
        } else {
          violations.push({
            ...where,
            code: 'approval_missing',
            ...(decision.rule !== undefined && { rule: decision.rule }),
            reason: `rule "${decision.rule}" requires approval and the record has none`,
          });
        }
      } else {
        violations.push({
          ...where,
          code: decision.code,
          ...(decision.rule !== undefined && { rule: decision.rule }),
          reason: decision.reason,
        });
      }
    }
  }
  return { files: files.length, records, violations };
}
