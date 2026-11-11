import { describe, expect, it } from 'vitest';
import { REDACTED, redact } from '../../src/audit/redact.js';

describe('redact', () => {
  it('replaces values under redacted keys at any depth, case-insensitively', () => {
    const input = { a: { Token: 'x', keep: 1 }, list: [{ password: 'p' }] };
    const before = structuredClone(input);

    expect(redact(input, ['token', 'password'])).toEqual({
      a: { Token: REDACTED, keep: 1 },
      list: [{ password: REDACTED }],
    });
    expect(input).toEqual(before);
  });

  it('redacts a whole subtree, whatever its value', () => {
    expect(redact({ secret: { nested: 'x' }, n: null }, ['SECRET'])).toEqual({
      secret: REDACTED,
      n: null,
    });
  });

  it('returns non-objects as they are', () => {
    for (const value of ['s', 3, true, null, undefined]) {
      expect(redact(value, ['token'])).toBe(value);
    }
  });
});
