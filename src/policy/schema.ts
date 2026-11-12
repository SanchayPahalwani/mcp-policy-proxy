import { z } from 'zod';
import { anchoredPattern } from './match.js';

export type Effect = 'allow' | 'require_approval' | 'deny';

export interface ConstraintSpec {
  arg: string;
  optional?: boolean;
  equals?: unknown;
  in?: unknown[];
  matches?: string;
  max_length?: number;
  min?: number;
  max?: number;
  absent?: true;
}

export interface RuleSpec {
  id: string;
  description?: string;
  identities: string[] | '*';
  server: string;
  tools: string[];
  effect: Effect;
  when?: ConstraintSpec[];
  limits?: { per_minute?: number; per_session?: number };
  reason?: string;
}

export interface PolicySpec {
  version: 1;
  audit?: { redact_keys?: string[] };
  rules: RuleSpec[];
}

export const DEFAULT_REDACT_KEYS: string[] = [
  'password',
  'token',
  'secret',
  'api_key',
  'authorization',
];

// No underscores, so the first '__' in a joined tool name always ends the server part.
export const SERVER_NAME = /^[a-z0-9][a-z0-9-]*$/;
export const IDENTITY_NAME = /^[a-z0-9][a-z0-9_-]*$/;
export const RULE_ID = /^[a-z0-9][a-z0-9_-]*$/;

/** Every constraint operator; a constraint names exactly one. */
export const CONSTRAINT_OPERATORS = [
  'equals',
  'in',
  'matches',
  'max_length',
  'min',
  'max',
  'absent',
] as const;
const OPERATORS = CONSTRAINT_OPERATORS;

const constraintSchema = z
  .strictObject({
    arg: z
      .string()
      .min(1)
      .refine((a) => a.split('.').every((seg) => seg !== ''), {
        error: 'arg must not have empty path segments',
      })
      // A key such as "to " is almost always a typo, and against it absent and optional
      // constraints pass for every call, since the real argument is never named.
      .refine((a) => !/\s/.test(a), { error: 'arg path segments must not contain whitespace' }),
    optional: z.boolean().optional(),
    equals: z.unknown().optional(),
    in: z.array(z.unknown()).optional(),
    matches: z.string().optional(),
    max_length: z.number().int().nonnegative().optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    absent: z.literal(true).optional(),
  })
  .superRefine((c, ctx) => {
    const used = OPERATORS.filter((op) => c[op] !== undefined);
    if (used.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        message: `constraint on "${c.arg}" needs exactly one of ${OPERATORS.join(', ')} (found ${used.length})`,
      });
    }
    if (c.absent !== undefined && c.optional !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `constraint on "${c.arg}" cannot combine absent with optional`,
      });
    }
    if (c.matches !== undefined) {
      try {
        anchoredPattern(c.matches);
      } catch (e) {
        ctx.addIssue({
          code: 'custom',
          path: ['matches'],
          message: `pattern does not compile: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
  });

const ruleSchema = z
  .strictObject({
    id: z.string().regex(RULE_ID, `must match ${RULE_ID}`),
    description: z.string().optional(),
    identities: z.unknown().superRefine((v, ctx) => {
      const bad = (message: string) => ctx.addIssue({ code: 'custom', message });
      if (v === '*') return;
      if (!Array.isArray(v) || v.length === 0) {
        return bad('identities must be "*" or a non-empty list of names');
      }
      for (const name of v) {
        if (name === '*') bad('a list cannot contain "*"; write identities: "*" instead');
        else if (typeof name !== 'string' || !IDENTITY_NAME.test(name)) {
          bad(`identity ${JSON.stringify(name)} must match ${IDENTITY_NAME}`);
        }
      }
    }),
    server: z.string().refine((v) => v === '*' || SERVER_NAME.test(v), {
      error: `server must be "*" or match ${SERVER_NAME}`,
    }),
    tools: z.array(z.string().min(1)).min(1, 'tools must not be empty'),
    effect: z.enum(['allow', 'require_approval', 'deny']),
    when: z.array(constraintSchema).optional(),
    limits: z
      .strictObject({
        per_minute: z.number().int().positive().optional(),
        per_session: z.number().int().positive().optional(),
      })
      .optional(),
    reason: z.string().optional(),
  })
  .superRefine((r, ctx) => {
    if (r.effect === 'deny') {
      for (const key of ['when', 'limits'] as const) {
        if (r[key] !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `deny rules must not have ${key}`,
          });
        }
      }
    } else if (r.reason !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'reason is only allowed on deny rules',
      });
    }
  });

export const policySchema = z
  .strictObject({
    version: z.literal(1, { error: 'version must be 1' }),
    audit: z.strictObject({ redact_keys: z.array(z.string()).optional() }).optional(),
    rules: z.array(ruleSchema),
  })
  .superRefine((p, ctx) => {
    const seen = new Set<string>();
    p.rules.forEach((r, i) => {
      if (seen.has(r.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['rules', i, 'id'],
          message: 'duplicate rule id',
        });
      }
      seen.add(r.id);
    });
  }) as unknown as z.ZodType<PolicySpec>;
