import { describe, expect, it } from 'vitest';
import { LimitState } from '../../src/policy/limits.js';

describe('LimitState', () => {
  it('starts every counter at zero', () => {
    const s = new LimitState();
    expect(s.minuteCount('r', 'alice', 0)).toBe(0);
    expect(s.sessionCount('r', 'alice', 's1')).toBe(0);
  });

  it('counts forwarded calls in a sliding 60 second window', () => {
    const s = new LimitState();
    for (const t of [0, 10_000, 59_000]) s.record('r', 'alice', 's1', t);
    expect(s.minuteCount('r', 'alice', 59_000)).toBe(3);
    expect(s.minuteCount('r', 'alice', 60_000)).toBe(2);
    expect(s.minuteCount('r', 'alice', 60_001)).toBe(2);
    expect(s.minuteCount('r', 'alice', 120_000)).toBe(0);
  });

  it('keeps counters separate per rule, identity and session', () => {
    const s = new LimitState();
    s.record('r1', 'alice', 's1', 1000);
    expect(s.minuteCount('r2', 'alice', 1000)).toBe(0);
    expect(s.minuteCount('r1', 'bob', 1000)).toBe(0);
    expect(s.sessionCount('r1', 'alice', 's2')).toBe(0);
    expect(s.sessionCount('r1', 'bob', 's1')).toBe(0);
    expect(s.sessionCount('r1', 'alice', 's1')).toBe(1);
  });

  it('shares the minute window across sessions of one identity', () => {
    const s = new LimitState();
    s.record('r', 'alice', 's1', 1000);
    s.record('r', 'alice', 's2', 2000);
    expect(s.minuteCount('r', 'alice', 2000)).toBe(2);
  });

  it('drops a session idle longer than sessionIdleMs on the next record', () => {
    const s = new LimitState({ sessionIdleMs: 1000 });
    s.record('r', 'alice', 's1', 0);
    s.record('r', 'alice', 's2', 1000);
    expect(s.sessionCount('r', 'alice', 's1')).toBe(1);
    s.record('r', 'alice', 's2', 1001);
    expect(s.sessionCount('r', 'alice', 's1')).toBe(0);
    expect(s.sessionCount('r', 'alice', 's2')).toBe(2);
  });

  it('keeps all counters of a session that is still active', () => {
    const min = 60_000;
    const s = new LimitState();
    s.record('one-publish', 'alice', 's1', 0);
    for (const t of [20, 40, 61]) s.record('drafts', 'alice', 's1', t * min);
    expect(s.sessionCount('one-publish', 'alice', 's1')).toBe(1);
  });

  it('does not rewind last-seen on a late record', () => {
    const s = new LimitState({ sessionIdleMs: 1000 });
    s.record('r', 'alice', 's1', 900);
    s.record('r', 'alice', 's1', 0);
    s.record('r', 'alice', 'other', 1500);
    expect(s.sessionCount('r', 'alice', 's1')).toBe(2);
  });

  it('counts timestamps newer than the window start with no upper bound', () => {
    const s = new LimitState();
    s.record('r', 'alice', 's1', 100_000);
    expect(s.minuteCount('r', 'alice', 99_000)).toBe(1);
  });
});
