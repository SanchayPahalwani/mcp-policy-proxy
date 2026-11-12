import { describe, expect, it } from 'vitest';
import { compileConstraint, MAX_MATCH_LENGTH } from '../../src/policy/constraints.js';
import { CONSTRAINT_OPERATORS, type ConstraintSpec } from '../../src/policy/schema.js';

function run(spec: ConstraintSpec, args: Record<string, unknown>) {
  return compileConstraint(spec).test(args);
}

const pass = { pass: true };
const fail = (why: string) => ({ pass: false, why });

describe('constraint operators', () => {
  const cases: Array<[string, ConstraintSpec, Record<string, unknown>, unknown]> = [
    ['equals passes', { arg: 'a', equals: 'x' }, { a: 'x' }, pass],
    ['equals fails', { arg: 'a', equals: 'x' }, { a: 'y' }, fail('a must equal "x"')],
    [
      'equals compares objects deeply',
      { arg: 'a', equals: { k: [1, { z: null }] } },
      { a: { k: [1, { z: null }] } },
      pass,
    ],
    [
      'equals rejects a different nested value',
      { arg: 'a', equals: { k: [1] } },
      { a: { k: [2] } },
      fail('a must equal {"k":[1]}'),
    ],
    ['equals null matches null', { arg: 'a', equals: null }, { a: null }, pass],
    ['in passes', { arg: 'a', in: ['x', 2] }, { a: 2 }, pass],
    ['in fails', { arg: 'a', in: ['x', 2] }, { a: 'y' }, fail('a must be one of ["x",2]')],
    ['matches passes', { arg: 'a', matches: 'ab+' }, { a: 'abbb' }, pass],
    ['matches fails', { arg: 'a', matches: 'ab+' }, { a: 'xabbb' }, fail('a must match /ab+/')],
    ['max_length passes at the limit', { arg: 'a', max_length: 3 }, { a: 'abc' }, pass],
    [
      'max_length fails',
      { arg: 'a', max_length: 3 },
      { a: 'abcd' },
      fail('a must be at most 3 characters'),
    ],
    ['min passes at the limit', { arg: 'a', min: 1 }, { a: 1 }, pass],
    ['min fails', { arg: 'a', min: 1 }, { a: 0 }, fail('a must be >= 1')],
    ['max passes at the limit', { arg: 'a', max: 5 }, { a: 5 }, pass],
    ['max fails', { arg: 'a', max: 5 }, { a: 6 }, fail('a must be <= 5')],
    ['absent passes when missing', { arg: 'a', absent: true }, { b: 1 }, pass],
    ['absent fails when present', { arg: 'a', absent: true }, { a: 1 }, fail('a must be absent')],
    [
      'absent fails when present as null',
      { arg: 'a', absent: true },
      { a: null },
      fail('a must be absent'),
    ],
  ];
  it.each(cases)('%s', (_name, spec, args, expected) => {
    expect(run(spec, args)).toEqual(expected);
  });
});

describe('missing values', () => {
  it('fails when missing', () => {
    expect(run({ arg: 'a', equals: 1 }, {})).toEqual(fail('a is missing'));
  });
  it('passes when missing and optional', () => {
    expect(run({ arg: 'a', equals: 1, optional: true }, {})).toEqual(pass);
  });
  it('still checks a present value when optional', () => {
    expect(run({ arg: 'a', equals: 1, optional: true }, { a: 2 })).toEqual(fail('a must equal 1'));
  });
  it('treats an undefined value as missing', () => {
    expect(run({ arg: 'a', equals: 1 }, { a: undefined })).toEqual(fail('a is missing'));
  });
  it('does not read inherited properties', () => {
    expect(run({ arg: 'constructor', max_length: 5 }, {})).toEqual(fail('constructor is missing'));
  });
});

describe('wrong types', () => {
  const cases: Array<[string, ConstraintSpec, Record<string, unknown>]> = [
    ['max_length on a number', { arg: 'a', max_length: 3 }, { a: 12 }],
    ['matches on an object', { arg: 'a', matches: '.*' }, { a: {} }],
    ['min on a string', { arg: 'a', min: 1 }, { a: '5' }],
    ['max on null', { arg: 'a', max: 1 }, { a: null }],
    ['min on NaN', { arg: 'a', min: 1 }, { a: Number.NaN }],
    ['max on Infinity', { arg: 'a', max: 1 }, { a: Number.POSITIVE_INFINITY }],
  ];
  it.each(cases)('%s', (_name, spec, args) => {
    expect(run(spec, args)).toEqual(fail('a has the wrong type'));
  });
});

describe('arrays', () => {
  const spec: ConstraintSpec = { arg: 'a', in: ['a', 'b'] };
  it('passes when every element passes', () => {
    expect(run(spec, { a: ['a', 'b'] })).toEqual(pass);
  });
  it('fails when one element fails', () => {
    expect(run(spec, { a: ['a', 'x'] })).toEqual(fail('a must be one of ["a","b"]'));
  });
  it('fails an empty array, even when optional', () => {
    expect(run(spec, { a: [] })).toEqual(fail('a is empty'));
    expect(run({ ...spec, optional: true }, { a: [] })).toEqual(fail('a is empty'));
  });

  // Typed by the schema's list, so a new operator does not compile until it has a case here.
  const ONE_OF_EACH: Record<(typeof CONSTRAINT_OPERATORS)[number], ConstraintSpec> = {
    equals: { arg: 'a', equals: [] },
    in: { arg: 'a', in: [[]] },
    matches: { arg: 'a', matches: '.*' },
    max_length: { arg: 'a', max_length: 5 },
    min: { arg: 'a', min: 0 },
    max: { arg: 'a', max: 5 },
    absent: { arg: 'a', absent: true },
  };
  it.each(CONSTRAINT_OPERATORS.map((op) => [op, ONE_OF_EACH[op]] as const))(
    'fails an empty array under %s, with or without optional',
    (op, each) => {
      const why = op === 'absent' ? 'a must be absent' : 'a is empty';
      expect(run(each, { a: [] })).toEqual(fail(why));
      if (op !== 'absent') expect(run({ ...each, optional: true }, { a: [] })).toEqual(fail(why));
    },
  );
  it('reports a wrong-typed element', () => {
    expect(run({ arg: 'a', max_length: 2 }, { a: ['ab', 3] })).toEqual(
      fail('a has the wrong type'),
    );
  });
});

describe('paths', () => {
  const spec: ConstraintSpec = { arg: 'to.address', matches: '[a-z]+@example\\.test' };
  it('walks nested objects', () => {
    expect(run(spec, { to: { address: 'a@example.test' } })).toEqual(pass);
    expect(run(spec, { to: { address: 'a@evil.test' } })).toEqual(
      fail('to.address must match /[a-z]+@example\\.test/'),
    );
  });
  it('fails a path through a non-object as the wrong type', () => {
    for (const to of ['a@example.test', null, ['x'], 5]) {
      expect(run(spec, { to })).toEqual(fail('to.address has the wrong type'));
    }
  });
  it('does not let optional or absent pass a malformed parent', () => {
    const optional: ConstraintSpec = { ...spec, optional: true };
    const wrong = fail('to.address has the wrong type');
    expect(run(optional, { to: 'x@evil.test' })).toEqual(wrong);
    expect(run(optional, { to: [{ address: 'x@evil.test' }] })).toEqual(wrong);
    expect(run({ arg: 'to.address', absent: true }, { to: [{ address: 'x@evil.test' }] })).toEqual(
      wrong,
    );
    expect(run({ arg: 'to.address', absent: true }, { to: 'x' })).toEqual(wrong);
  });
  it('still passes optional and absent when the parent is missing', () => {
    expect(run({ ...spec, optional: true }, {})).toEqual(pass);
    expect(run({ arg: 'to.address', absent: true }, {})).toEqual(pass);
    expect(run({ ...spec, optional: true }, { to: {} })).toEqual(pass);
  });
  it('handles empty args', () => {
    expect(run(spec, {})).toEqual(fail('to.address is missing'));
    expect(run({ arg: 'a', absent: true }, {})).toEqual(pass);
  });
});

describe('matches', () => {
  const spec: ConstraintSpec = { arg: 'url', matches: 'https://docs\\.example\\.test/.*' };
  it('is anchored at both ends', () => {
    expect(run(spec, { url: 'https://docs.example.test/page' })).toEqual(pass);
    expect(run(spec, { url: 'https://evil.test/?u=https://docs.example.test/x' })).toEqual(
      fail('url must match /https://docs\\.example\\.test/.*/'),
    );
    expect(run({ arg: 'a', matches: 'a|b' }, { a: 'bx' }).pass).toBe(false);
  });
  it('refuses strings over the cap without running the pattern', () => {
    expect(MAX_MATCH_LENGTH).toBe(2000);
    expect(run({ arg: 'a', matches: 'a*' }, { a: 'a'.repeat(2001) })).toEqual(
      fail('a is too long to check'),
    );
    expect(run({ arg: 'a', matches: 'a*' }, { a: 'a'.repeat(2000) })).toEqual(pass);
    expect(run({ arg: 'a', matches: 'a*' }, { a: 'a'.repeat(1999) + 'b' }).pass).toBe(false);
  });
  it('throws on a pattern that does not compile', () => {
    expect(() => compileConstraint({ arg: 'a', matches: '(' })).toThrow();
  });
  it('rejects a pattern that tries to close the anchor group', () => {
    expect(() => compileConstraint({ arg: 'a', matches: 'a)|(?:b' })).toThrow();
  });
});

describe('operator count', () => {
  it('throws with zero or two operators', () => {
    expect(() => compileConstraint({ arg: 'a' })).toThrow(/exactly one operator/);
    expect(() => compileConstraint({ arg: 'a', min: 1, max: 2 })).toThrow(/exactly one operator/);
  });
});
