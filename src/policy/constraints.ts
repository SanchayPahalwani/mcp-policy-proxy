import { anchoredPattern } from './match.js';
import type { ConstraintSpec } from './schema.js';

// JavaScript's regex engine backtracks, so the cap bounds the time an
// attacker-chosen value can cost.
export const MAX_MATCH_LENGTH = 2000;

export type ConstraintResult = { pass: true } | { pass: false; why: string };

export interface CompiledConstraint {
  spec: ConstraintSpec;
  test(args: Record<string, unknown>): ConstraintResult;
}

const PASS: ConstraintResult = { pass: true };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function lookup(args: Record<string, unknown>, path: string): unknown {
  let current: unknown = args;
  for (const key of path.split('.')) {
    // Own properties only, so 'constructor' or '__proto__' never resolve.
    if (!isPlainObject(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => deepEqual(item, b[i]))
    );
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]))
  );
}

function compileCheck(spec: ConstraintSpec): (value: unknown) => ConstraintResult {
  const { arg } = spec;
  const fail = (why: string): ConstraintResult => ({ pass: false, why });
  const wrongType = fail(`${arg} has the wrong type`);

  if (spec.equals !== undefined) {
    const expected = spec.equals;
    const why = `${arg} must equal ${JSON.stringify(expected)}`;
    return (v) => (deepEqual(v, expected) ? PASS : fail(why));
  }
  if (spec.in !== undefined) {
    const allowed = spec.in;
    const why = `${arg} must be one of ${JSON.stringify(allowed)}`;
    return (v) => (allowed.some((a) => deepEqual(v, a)) ? PASS : fail(why));
  }
  if (spec.matches !== undefined) {
    const re = anchoredPattern(spec.matches);
    const why = `${arg} must match /${spec.matches}/`;
    return (v) => {
      if (typeof v !== 'string') return wrongType;
      if (v.length > MAX_MATCH_LENGTH) return fail(`${arg} is too long to check`);
      return re.test(v) ? PASS : fail(why);
    };
  }
  if (spec.max_length !== undefined) {
    const limit = spec.max_length;
    const why = `${arg} must be at most ${limit} characters`;
    return (v) => (typeof v !== 'string' ? wrongType : v.length <= limit ? PASS : fail(why));
  }
  if (spec.min !== undefined) {
    const limit = spec.min;
    const why = `${arg} must be >= ${limit}`;
    return (v) =>
      typeof v !== 'number' || !Number.isFinite(v) ? wrongType : v >= limit ? PASS : fail(why);
  }
  if (spec.max !== undefined) {
    const limit = spec.max;
    const why = `${arg} must be <= ${limit}`;
    return (v) =>
      typeof v !== 'number' || !Number.isFinite(v) ? wrongType : v <= limit ? PASS : fail(why);
  }
  throw new Error(`constraint on "${arg}" has no operator`);
}

export function compileConstraint(spec: ConstraintSpec): CompiledConstraint {
  if (spec.absent) {
    const why = `${spec.arg} must be absent`;
    return {
      spec,
      test: (args) => (lookup(args, spec.arg) === undefined ? PASS : { pass: false, why }),
    };
  }
  const check = compileCheck(spec);
  return {
    spec,
    test(args) {
      const value = lookup(args, spec.arg);
      if (value === undefined) {
        return spec.optional ? PASS : { pass: false, why: `${spec.arg} is missing` };
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          const result = check(item);
          if (!result.pass) return result;
        }
        return PASS;
      }
      return check(value);
    },
  };
}
