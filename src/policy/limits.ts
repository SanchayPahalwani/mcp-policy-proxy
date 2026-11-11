export type Clock = () => number;

const MINUTE_MS = 60_000;

// Keys are JSON arrays so no identity or session string can collide with another.
const key = (...parts: string[]) => JSON.stringify(parts);

export class LimitState {
  private readonly sessionIdleMs: number;
  private readonly minutes = new Map<string, number[]>();
  private readonly sessionCounts = new Map<string, Map<string, number>>();
  private readonly lastSeen = new Map<string, number>();

  constructor(opts: { sessionIdleMs?: number } = {}) {
    this.sessionIdleMs = opts.sessionIdleMs ?? 3_600_000;
  }

  // No upper bound on purpose: if the clock steps back, calls recorded "in the
  // future" still count, so a limit refuses instead of failing open.
  minuteCount(ruleId: string, identity: string, now: number): number {
    const stamps = this.minutes.get(key(ruleId, identity));
    return stamps ? stamps.filter((t) => t > now - MINUTE_MS).length : 0;
  }

  sessionCount(ruleId: string, identity: string, session: string): number {
    return this.sessionCounts.get(key(identity, session))?.get(ruleId) ?? 0;
  }

  record(ruleId: string, identity: string, session: string, now: number): void {
    // Pruning on write bounds each list by that rule's forwarded calls in the
    // last minute (every applied rule is recorded, whether or not it has a limit).
    const mKey = key(ruleId, identity);
    const stamps = (this.minutes.get(mKey) ?? []).filter((t) => t > now - MINUTE_MS);
    stamps.push(now);
    this.minutes.set(mKey, stamps);

    // Counters are dropped per session, never per rule, so a rule's count cannot
    // vanish while the session keeps calling other rules.
    const sKey = key(identity, session);
    const counts = this.sessionCounts.get(sKey) ?? new Map<string, number>();
    counts.set(ruleId, (counts.get(ruleId) ?? 0) + 1);
    this.sessionCounts.set(sKey, counts);
    this.lastSeen.set(sKey, Math.max(this.lastSeen.get(sKey) ?? now, now));

    for (const [k, seen] of this.lastSeen) {
      if (now - seen > this.sessionIdleMs) {
        this.lastSeen.delete(k);
        this.sessionCounts.delete(k);
      }
    }
  }
}
