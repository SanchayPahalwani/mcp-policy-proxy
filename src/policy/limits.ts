export type Clock = () => number;

const MINUTE_MS = 60_000;

interface SessionEntry {
  count: number;
  lastSeen: number;
}

// Keys are JSON arrays so no identity or session string can collide with another.
const key = (...parts: string[]) => JSON.stringify(parts);

export class LimitState {
  private readonly sessionIdleMs: number;
  private readonly minutes = new Map<string, number[]>();
  private readonly sessions = new Map<string, SessionEntry>();

  constructor(opts: { sessionIdleMs?: number } = {}) {
    this.sessionIdleMs = opts.sessionIdleMs ?? 3_600_000;
  }

  minuteCount(ruleId: string, identity: string, now: number): number {
    const stamps = this.minutes.get(key(ruleId, identity));
    return stamps ? stamps.filter((t) => t > now - MINUTE_MS && t <= now).length : 0;
  }

  sessionCount(ruleId: string, identity: string, session: string): number {
    return this.sessions.get(key(ruleId, identity, session))?.count ?? 0;
  }

  record(ruleId: string, identity: string, session: string, now: number): void {
    // Pruning here, not on read, keeps each list at most as long as the limit.
    const mKey = key(ruleId, identity);
    const stamps = (this.minutes.get(mKey) ?? []).filter((t) => t > now - MINUTE_MS);
    stamps.push(now);
    this.minutes.set(mKey, stamps);

    const sKey = key(ruleId, identity, session);
    const entry = this.sessions.get(sKey) ?? { count: 0, lastSeen: now };
    entry.count += 1;
    entry.lastSeen = now;
    this.sessions.set(sKey, entry);

    for (const [k, e] of this.sessions) {
      if (now - e.lastSeen > this.sessionIdleMs) this.sessions.delete(k);
    }
  }
}
