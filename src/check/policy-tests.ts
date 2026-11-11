import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import {
  commit,
  decide,
  visible,
  type Call,
  type Decision,
  type DecisionCode,
} from '../policy/engine.js';
import { LimitState } from '../policy/limits.js';
import { loadPolicy, PolicyError, type Policy } from '../policy/load.js';

export interface PolicyTestResult {
  file: string;
  name: string;
  ok: boolean;
  message?: string;
}

const effectSchema = z.enum(['allow', 'deny', 'require_approval']);
const DECISION_CODES = [
  'allowed',
  'approval_required',
  'denied_by_rule',
  'no_matching_rule',
  'constraint_failed',
  'limit_exceeded',
] as const satisfies readonly DecisionCode[];
// Fails to compile when a code is added to the engine but not listed above.
const _allCodesListed: DecisionCode extends (typeof DECISION_CODES)[number] ? true : never = true;
void _allCodesListed;
const codeSchema = z.enum(DECISION_CODES);

const callSchema = z.strictObject({
  identity: z.string(),
  session: z.string().default('test'),
  server: z.string(),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()).default({}),
});

const expectation = {
  expect: effectSchema,
  rule: z.string().optional(),
  code: codeSchema.optional(),
};

const stepSchema = z.strictObject({
  call: callSchema,
  ...expectation,
  at: z.number().nonnegative().optional(),
  approved: z.boolean().optional(),
});

const caseSchema = z.union([
  z.strictObject({ name: z.string(), call: callSchema, ...expectation }),
  z.strictObject({
    name: z.string(),
    visible: z.strictObject({ identity: z.string(), server: z.string(), tool: z.string() }),
    expect: z.boolean(),
  }),
  z.strictObject({ name: z.string(), sequence: z.array(stepSchema).min(1) }),
]);

const fileSchema = z.strictObject({
  policy: z.string().optional(),
  cases: z.array(caseSchema),
});

type Case = z.infer<typeof caseSchema>;
type CallSpec = z.infer<typeof callSchema>;
type Expected = {
  expect: Decision['effect'];
  rule?: string | undefined;
  code?: DecisionCode | undefined;
};

// Any constant works; only the offsets between steps matter.
const BASE_TIME = Date.UTC(2026, 0, 1);

function toCall(c: CallSpec, at: number): Call {
  return { ...c, at };
}

function mismatch(want: Expected, got: Decision): string | undefined {
  const ok =
    got.effect === want.expect &&
    (want.code === undefined || got.code === want.code) &&
    (want.rule === undefined || got.rule === want.rule);
  if (ok) return undefined;
  const exp =
    `expected ${want.expect}` +
    (want.code === undefined ? '' : ` code ${want.code}`) +
    (want.rule === undefined ? '' : ` rule ${want.rule}`);
  const rule = got.rule === undefined ? '' : `, rule ${got.rule}`;
  return `${exp}, got ${got.effect} (${got.code}${rule}): ${got.reason}`;
}

function runCase(policy: Policy, c: Case): string | undefined {
  if ('visible' in c) {
    const { identity, server, tool } = c.visible;
    const got = visible(policy, identity, server, tool);
    return got === c.expect ? undefined : `expected visible=${c.expect}, got ${got}`;
  }
  if ('call' in c) {
    return mismatch(c, decide(policy, new LimitState(), toCall(c.call, BASE_TIME)));
  }
  const state = new LimitState();
  for (const [index, step] of c.sequence.entries()) {
    const call = toCall(step.call, BASE_TIME + (step.at ?? index) * 1000);
    const decision = decide(policy, state, call);
    const failure = mismatch(step, decision);
    if (failure !== undefined) return `step ${index}: ${failure}`;
    if (decision.effect === 'allow' || (decision.effect === 'require_approval' && step.approved)) {
      commit(state, call, decision);
    }
  }
  return undefined;
}

function loadReferencedPolicy(testPath: string, reference: string | undefined): Policy {
  if (reference === undefined) {
    throw new PolicyError([`${testPath}: no "policy:" in the file and no policy was given`]);
  }
  const policyPath = resolve(dirname(testPath), reference);
  if (!existsSync(policyPath)) {
    throw new PolicyError([`${testPath}: policy file not found: ${policyPath}`]);
  }
  return loadPolicy(policyPath);
}

export function runPolicyTestFile(path: string, policyOverride?: Policy): PolicyTestResult[] {
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new PolicyError([
      `${path}: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`,
    ]);
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PolicyError(
      parsed.error.issues.map((i) => `${path}: ${i.path.join('.') || '(file)'}: ${i.message}`),
    );
  }
  const file = parsed.data;
  for (const c of file.cases) {
    if (!('sequence' in c)) continue;
    let previous = -Infinity;
    for (const [index, step] of c.sequence.entries()) {
      const at = step.at ?? index;
      if (at < previous) {
        throw new PolicyError([
          `${path}: case "${c.name}": step ${index}: "at" (${at}) is earlier than the previous step`,
        ]);
      }
      previous = at;
    }
  }
  const policy = policyOverride ?? loadReferencedPolicy(path, file.policy);
  return file.cases.map((c) => {
    const message = runCase(policy, c);
    return message === undefined
      ? { file: path, name: c.name, ok: true }
      : { file: path, name: c.name, ok: false, message };
  });
}
