import type { Policy } from './load.js';

export interface LintIssue {
  level: 'error' | 'warning';
  rule?: string;
  message: string;
}

// The audit log blanks redacted keys, so a decision on one could not be replayed offline.
function constrainsRedactedKey(arg: string, redactKeys: string[]): boolean {
  const last = arg.split('.').pop() ?? arg;
  return redactKeys.includes(last.toLowerCase());
}

export function lintPolicy(
  policy: Policy,
  known: { identities?: string[]; servers?: string[] } = {},
): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const { spec } of policy.rules) {
    const rule = spec.id;
    for (const c of spec.when ?? []) {
      if (constrainsRedactedKey(c.arg, policy.redactKeys)) {
        issues.push({
          level: 'error',
          rule,
          message: `constraint on "${c.arg}" uses a redacted key, so the audit log cannot reproduce the decision`,
        });
      }
    }
    if (known.identities && spec.identities !== '*') {
      for (const id of spec.identities) {
        if (!known.identities.includes(id)) {
          issues.push({
            level: 'error',
            rule,
            message: `identity "${id}" is not in the configuration`,
          });
        }
      }
    }
    if (known.servers && spec.server !== '*' && !known.servers.includes(spec.server)) {
      // A typo on a deny rule silently disables it; on a permitting rule it only never matches.
      const denies = spec.effect === 'deny';
      issues.push({
        level: denies ? 'error' : 'warning',
        rule,
        message: denies
          ? `server "${spec.server}" is not in the configuration, so this deny rule can never apply`
          : `server "${spec.server}" is not in the configuration, so this rule can never match`,
      });
    }
    if (spec.effect === 'deny') continue;
    if (spec.server === '*' && spec.tools.includes('*')) {
      issues.push({
        level: 'warning',
        rule,
        message: 'permits every tool on every server',
      });
    }
    if (spec.identities === '*' && (spec.when ?? []).length === 0) {
      issues.push({
        level: 'warning',
        rule,
        message: 'permits any identity with no argument constraints',
      });
    }
  }
  return issues;
}
