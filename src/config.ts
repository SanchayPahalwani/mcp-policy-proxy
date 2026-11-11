import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { cliApprover } from './approval/cli.js';
import { denyApprover, type Approver } from './approval/types.js';
import { webhookApprover } from './approval/webhook.js';
import { fileAuditSink } from './audit/log.js';
import { lintPolicy } from './policy/lint.js';
import { loadPolicy, PolicyError, type Policy } from './policy/load.js';
import { IDENTITY_NAME, SERVER_NAME } from './policy/schema.js';
import { staticTokenAuthenticator, type Authenticator } from './proxy/auth.js';
import { startHttpProxy } from './proxy/http.js';
import { policyGate } from './proxy/policy-gate.js';
import { startStdioProxy } from './proxy/stdio.js';
import { Upstreams, type UpstreamSpec } from './proxy/upstreams.js';

// ---------------------------------------------------------------------------------------------
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

function configError(headline: string, issues: string[]): PolicyError {
  const error = new PolicyError(issues);
  error.message = `${headline}:\n${issues.join('\n')}`;
  return error;
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

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

// ---------------------------------------------------------------------------------------------
// Starting a proxy from a loaded config: everything that needs the environment or other files.

export interface StartOptions {
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

/** Looks up each variable the config names; issues name the variable, never a value. */
function secrets(config: ProxyConfig, env: NodeJS.ProcessEnv) {
  const issues: string[] = [];
  const read = (variable: string, what: string): string => {
    const value = env[variable];
    if (!value) issues.push(`${what}: environment variable ${variable} is not set`);
    return value ?? '';
  };
  // Over stdio the identity is fixed at launch, so no token is ever presented.
  if (config.listen.transport === 'http') {
    for (const i of config.identities) {
      if (i.token_env !== undefined) read(i.token_env, `identity "${i.name}"`);
    }
  }
  const headers = new Map<string, Record<string, string>>();
  for (const [name, upstream] of Object.entries(config.upstreams)) {
    if (upstream.transport !== 'http' || !upstream.headers_env) continue;
    const values: Record<string, string> = {};
    for (const [header, variable] of Object.entries(upstream.headers_env)) {
      values[header] = read(variable, `upstream "${name}" header ${header}`);
    }
    headers.set(name, values);
  }
  const secret =
    config.approval.type === 'webhook'
      ? read(config.approval.secret_env, 'webhook approval')
      : undefined;
  if (issues.length > 0) throw configError('Cannot start', issues);
  return { headers, secret };
}

function readPolicy(path: string): Policy {
  try {
    return loadPolicy(path);
  } catch (e) {
    if (e instanceof PolicyError) throw configError(`Invalid policy ${path}`, e.issues);
    throw configError(`Cannot read policy ${path}`, [messageOf(e)]);
  }
}

function checkPolicy(policy: Policy, config: ProxyConfig, log: (line: string) => void): void {
  const servers = Object.keys(config.upstreams);
  // Unknown servers are left out of the lint: the example policy also covers servers that are
  // not always running, and a rule for a missing server can never match a call.
  const issues = lintPolicy(policy, { identities: config.identities.map((i) => i.name) });
  for (const { spec } of policy.rules) {
    if (spec.server !== '*' && !servers.includes(spec.server)) {
      issues.push({
        level: 'warning',
        rule: spec.id,
        message: `server "${spec.server}" is not configured, so this rule never applies`,
      });
    }
  }
  const label = (i: { rule?: string; message: string }) =>
    i.rule === undefined ? i.message : `rule "${i.rule}": ${i.message}`;
  for (const issue of issues) if (issue.level === 'warning') log(`warning: ${label(issue)}`);
  const errors = issues.filter((i) => i.level === 'error').map(label);
  if (errors.length > 0) throw configError(`Policy ${config.policy} has lint errors`, errors);
}

function upstreamSpecs(
  config: ProxyConfig,
  headers: Map<string, Record<string, string>>,
): UpstreamSpec[] {
  return Object.entries(config.upstreams).map(([name, u]): UpstreamSpec => {
    if (u.transport === 'stdio') {
      return {
        name,
        transport: 'stdio',
        command: u.command,
        cwd: u.cwd ?? config.dir,
        ...(u.args && { args: u.args }),
      };
    }
    const values = headers.get(name);
    return { name, transport: 'http', url: u.url, ...(values && { headers: values }) };
  });
}

function approverFor(config: ProxyConfig, secret: string | undefined): Approver {
  switch (config.approval.type) {
    case 'cli':
      return cliApprover();
    case 'webhook':
      return webhookApprover({ url: config.approval.url, secret: secret ?? '' });
    case 'deny':
      return denyApprover;
  }
}

/**
 * Checks everything the config refers to before anything listens or is spawned, then connects
 * the upstreams and starts serving. `url` is set when listening on HTTP.
 */
export async function startFromConfig(
  config: ProxyConfig,
  opts: StartOptions = {},
): Promise<{ url?: string; close(): Promise<void> }> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));

  const { headers, secret } = secrets(config, env);
  const policy = readPolicy(config.policy);
  checkPolicy(policy, config, log);
  let authenticator: Authenticator | undefined;
  try {
    if (config.listen.transport === 'http') {
      authenticator = staticTokenAuthenticator(config.identities, env);
    }
  } catch (e) {
    // Its messages name identities only, such as two that share a token, never the token.
    throw configError('Cannot start', [messageOf(e)]);
  }

  const audit = fileAuditSink(config.audit.path);
  const onError = (e: Error) => log(`error: ${e.message}`);
  let upstreams: Upstreams;
  try {
    upstreams = await Upstreams.connect(upstreamSpecs(config, headers), {
      onError: (server, e) => log(`upstream "${server}": ${e.message}`),
    });
  } catch (e) {
    audit.close();
    throw e;
  }
  const gate = policyGate({
    policy,
    audit,
    approver: approverFor(config, secret),
    approvalTimeoutMs: config.approval.timeout_seconds * 1000,
  });

  const stop = async (server?: { close(): Promise<void> }) => {
    try {
      await server?.close();
    } finally {
      await upstreams.close();
      audit.close();
    }
  };
  try {
    if (config.listen.transport === 'stdio') {
      const server = startStdioProxy({
        upstreams,
        gate,
        onError,
        identity: config.stdio_identity!,
      });
      return { close: () => stop(server) };
    }
    const { host, port, path, session_header } = config.listen;
    const server = await startHttpProxy({
      upstreams,
      gate,
      onError,
      authenticator: authenticator!,
      host,
      port,
      path,
      sessionHeader: session_header,
    });
    return { url: server.url, close: () => stop(server) };
  } catch (e) {
    await stop();
    throw e;
  }
}
