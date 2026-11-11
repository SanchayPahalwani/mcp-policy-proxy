import { cliApprover } from '../approval/cli.js';
import { denyApprover, type Approver } from '../approval/types.js';
import { webhookApprover } from '../approval/webhook.js';
import { fileAuditSink } from '../audit/log.js';
import { lintPolicy } from '../policy/lint.js';
import { loadPolicy, PolicyError, type Policy } from '../policy/load.js';
import { staticTokenAuthenticator, type Authenticator } from '../proxy/auth.js';
import { startHttpProxy } from '../proxy/http.js';
import { policyGate } from '../proxy/policy-gate.js';
import { startStdioProxy } from '../proxy/stdio.js';
import { Upstreams, type UpstreamSpec } from '../proxy/upstreams.js';
import { messageOf } from '../util.js';
import { configError, type ProxyConfig } from './schema.js';

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
        ...(u.cwd !== undefined && { cwd: u.cwd }),
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
