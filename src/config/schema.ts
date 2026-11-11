import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { PolicyError } from '../policy/load.js';
import { IDENTITY_NAME, SERVER_NAME } from '../policy/schema.js';
import { messageOf } from '../util.js';

// The config file: its shape and the checks that need nothing outside the file.

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const envName = z.string().regex(ENV_NAME, `must be an environment variable name`);

const listenSchema = z.discriminatedUnion('transport', [
  z.strictObject({
    transport: z.literal('http'),
    host: z.string().min(1).default('127.0.0.1'),
    port: z.number().int().min(0).max(65_535).default(8787),
    path: z.string().startsWith('/').default('/mcp'),
    session_header: z.string().min(1).default('x-agent-session'),
  }),
  z.strictObject({ transport: z.literal('stdio') }),
]);

const identitySchema = z
  .strictObject({
    name: z.string().regex(IDENTITY_NAME, `must match ${IDENTITY_NAME}`),
    token_sha256: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex characters')
      .optional(),
    token_env: envName.optional(),
  })
  .refine((i) => (i.token_sha256 === undefined) !== (i.token_env === undefined), {
    error: 'needs exactly one of token_sha256 or token_env',
  });

const upstreamSchema = z.discriminatedUnion('transport', [
  z.strictObject({
    transport: z.literal('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    cwd: z.string().min(1).optional(),
  }),
  z.strictObject({
    transport: z.literal('http'),
    url: z.url(),
    /** Header name to the variable holding its value, so credentials stay out of the file. */
    headers_env: z.record(z.string().min(1), envName).optional(),
  }),
]);

// Under the MCP SDK client's default 60 s request timeout, so the agent hears the refusal.
const timeoutSeconds = z.number().positive().default(55);

const approvalSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('cli'), timeout_seconds: timeoutSeconds }),
  z.strictObject({ type: z.literal('deny'), timeout_seconds: timeoutSeconds }),
  z.strictObject({
    type: z.literal('webhook'),
    url: z.url(),
    secret_env: envName,
    timeout_seconds: timeoutSeconds,
  }),
]);

const configSchema = z
  .strictObject({
    listen: listenSchema,
    identities: z.array(identitySchema).min(1, 'at least one identity is needed'),
    stdio_identity: z.string().optional(),
    upstreams: z.record(
      z.string().regex(SERVER_NAME, `upstream names must match ${SERVER_NAME}`),
      upstreamSchema,
    ),
    policy: z.string().min(1),
    audit: z.strictObject({ path: z.string().min(1) }),
    approval: approvalSchema.default({ type: 'deny', timeout_seconds: 55 }),
  })
  .superRefine((c, ctx) => {
    const names = c.identities.map((i) => i.name);
    names.forEach((name, i) => {
      if (names.indexOf(name) !== i) {
        ctx.addIssue({ code: 'custom', path: ['identities', i], message: 'duplicate name' });
      }
    });
    if (c.listen.transport !== 'stdio') return;
    if (c.stdio_identity === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['stdio_identity'],
        message: 'required when listen.transport is stdio',
      });
    } else if (!names.includes(c.stdio_identity)) {
      ctx.addIssue({
        code: 'custom',
        path: ['stdio_identity'],
        message: `"${c.stdio_identity}" is not one of the identities`,
      });
    }
    // Over stdio the proxy's stdin is the MCP channel, so nobody could type an answer.
    if (c.approval.type === 'cli') {
      ctx.addIssue({
        code: 'custom',
        path: ['approval', 'type'],
        message: 'cli approval needs a terminal, which listen.transport stdio takes over',
      });
    }
  });

type ConfigSpec = z.infer<typeof configSchema>;

export type UpstreamConfig = ConfigSpec['upstreams'][string];

/** The config file as written, with every path made absolute. */
export interface ProxyConfig extends ConfigSpec {
  /** The config file's directory: relative paths in the file were resolved against it. */
  dir: string;
}

/** A `PolicyError` whose headline says what was being read, instead of "Invalid policy". */
export function configError(headline: string, issues: string[]): PolicyError {
  const error = new PolicyError(issues);
  error.message = `${headline}:\n${issues.join('\n')}`;
  return error;
}

export function loadConfig(path: string): ProxyConfig {
  const file = resolve(path);
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw configError(`Cannot read config ${file}`, [messageOf(e).split('\n')[0]!]);
  }
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    throw configError(
      `Invalid config ${file}`,
      result.error.issues.map((i) => `${i.path.map(String).join('.') || '(top)'}: ${i.message}`),
    );
  }
  const spec = result.data;
  const dir = dirname(file);
  const upstreams: Record<string, UpstreamConfig> = {};
  for (const [name, upstream] of Object.entries(spec.upstreams)) {
    // Commands such as `npx tsx ../eval/...` are written relative to the config file.
    upstreams[name] =
      upstream.transport === 'stdio'
        ? { ...upstream, cwd: resolve(dir, upstream.cwd ?? '.') }
        : upstream;
  }
  return {
    ...spec,
    dir,
    upstreams,
    policy: resolve(dir, spec.policy),
    audit: { path: resolve(dir, spec.audit.path) },
  };
}
