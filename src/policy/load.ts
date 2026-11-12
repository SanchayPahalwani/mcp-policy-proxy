import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { compileConstraint, type CompiledConstraint } from './constraints.js';
import { compileGlob, MAX_NAME_LENGTH } from './match.js';
import {
  DEFAULT_REDACT_KEYS,
  policySchema,
  RULE_ID,
  type PolicySpec,
  type RuleSpec,
} from './schema.js';

export class PolicyError extends Error {
  readonly issues: string[];

  /** `headline` says what was being read: a policy unless the caller says otherwise. */
  constructor(issues: string[], headline = 'Invalid policy') {
    super(`${headline}:\n${issues.join('\n')}`);
    this.name = 'PolicyError';
    this.issues = issues;
  }
}

export interface CompiledRule {
  spec: RuleSpec;
  index: number;
  matches(identity: string, server: string, tool: string): boolean;
  constraints: CompiledConstraint[];
}

export interface Policy {
  spec: PolicySpec;
  sha256: string;
  rules: CompiledRule[];
  redactKeys: string[];
}

function ruleLabel(raw: unknown, index: number): string {
  const rules = (raw as { rules?: unknown } | null)?.rules;
  const rule = Array.isArray(rules) ? (rules[index] as { id?: unknown } | undefined) : undefined;
  const id = rule?.id;
  return typeof id === 'string' && RULE_ID.test(id) ? `rule "${id}"` : `rule at index ${index}`;
}

function describeIssues(raw: unknown, issues: readonly { path: PropertyKey[]; message: string }[]) {
  return issues.map((issue) => {
    const [head, index, ...rest] = issue.path;
    const where = (head === 'rules' && typeof index === 'number' ? rest : issue.path)
      .map(String)
      .join('.');
    const prefix =
      head === 'rules' && typeof index === 'number' ? `${ruleLabel(raw, index)}: ` : '';
    return `${prefix}${where ? `${where}: ` : ''}${issue.message}`;
  });
}

function compileRule(spec: RuleSpec, index: number): CompiledRule {
  const globs = spec.tools.map(compileGlob);
  const identities = spec.identities === '*' ? undefined : new Set(spec.identities);
  return {
    spec,
    index,
    matches: (identity, server, tool) =>
      tool.length <= MAX_NAME_LENGTH &&
      (identities === undefined || identities.has(identity)) &&
      (spec.server === '*' || spec.server === server) &&
      globs.some((g) => g(tool)),
    constraints: (spec.when ?? []).map(compileConstraint),
  };
}

export function parsePolicy(yamlText: string): Policy {
  let raw: unknown;
  try {
    raw = parse(yamlText);
  } catch (e) {
    throw new PolicyError([
      `YAML error: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}`,
    ]);
  }
  const result = policySchema.safeParse(raw);
  if (!result.success) throw new PolicyError(describeIssues(raw, result.error.issues));
  const spec = result.data;
  return {
    spec,
    sha256: createHash('sha256').update(yamlText).digest('hex'),
    rules: spec.rules.map(compileRule),
    redactKeys: (spec.audit?.redact_keys ?? DEFAULT_REDACT_KEYS).map((k) => k.toLowerCase()),
  };
}

export function loadPolicy(path: string): Policy {
  return parsePolicy(readFileSync(path, 'utf8'));
}
