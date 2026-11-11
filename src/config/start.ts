import type { Transport } from '@modelcontextprotocol/server';
import { cliApprover } from '../approval/cli.js';
import { denyApprover, type Approver } from '../approval/types.js';
import { webhookApprover } from '../approval/webhook.js';
import { fileAuditSink } from '../audit/log.js';
import { lintPolicy } from '../policy/lint.js';
import { loadPolicy, PolicyError, type Policy } from '../policy/load.js';
import { sha256Hex, staticTokenAuthenticator } from '../proxy/auth.js';
import { startHttpProxy } from '../proxy/http.js';
import { policyGate } from '../proxy/policy-gate.js';
import { startStdioProxy } from '../proxy/stdio.js';
import { UpstreamConnectError, Upstreams, type UpstreamSpec } from '../proxy/upstreams.js';
import { codeOf } from '../util.js';
import { configError, LOOPBACK_HOSTS, type ProxyConfig } from './schema.js';

// Starting a proxy from a loaded config: everything that needs the environment or other files.
//
// Every failure before the proxy listens is a PolicyError whose text is written here. An
// underlying error's message is never relayed, because it can quote a header value or another
// secret back (Node's header validation does); it is kept as `cause` for debugging only.

export interface StartOptions {
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  /** Replaces the process's stdin/stdout when listening over stdio; for tests. */
  stdioTransport?: Transport;
}

export interface RunningFromConfig {
  /** Set when listening on HTTP. */
  url?: string;
  /** Stops the proxy, its upstreams and the audit log; later calls get the same promise. */
  close(): Promise<void>;
  /** Resolves once the proxy has stopped, by `close()` or on its own (stdio client gone). */
  closed: Promise<void>;
}

// A header value with one of these would be refused by Node, which quotes the value in its error.
const CONTROL = /[\u0000-\u001f\u007f]/;

function startError(issues: string[], cause?: unknown): PolicyError {
  const error = configError('Cannot start', issues);
  if (cause !== undefined) error.cause = cause;
  return error;
}

interface Secrets {
  headers: Map<string, Record<string, string>>;
  childEnv: Map<string, Record<string, string>>;
  webhookSecret?: string;
}

/** Looks up each variable the config names; issues name the variable, never a value. */
function secrets(config: ProxyConfig, env: NodeJS.ProcessEnv): Secrets {
  const issues: string[] = [];
  const read = (variable: string, what: string, sentAsHeader = false): string => {
    const value = env[variable];
    if (!value) issues.push(`${what}: environment variable ${variable} is not set`);
    else if (sentAsHeader && CONTROL.test(value)) {
      issues.push(`${what}: environment variable ${variable} contains a control character`);
    }
    return value ?? '';
  };
  // Over stdio the identity is fixed at launch, so no token is ever presented.
  if (config.listen.transport === 'http') {
    const owners = new Map<string, string>();
    for (const i of config.identities) {
      const digest =
        i.token_env !== undefined
          ? sha256Hex(read(i.token_env, `identity "${i.name}"`))
          : i.token_sha256?.toLowerCase();
      if (digest === undefined) continue;
      const other = owners.get(digest);
      if (other !== undefined) issues.push(`identities "${other}" and "${i.name}" share a token`);
      else owners.set(digest, i.name);
    }
  }
  const headers = new Map<string, Record<string, string>>();
  const childEnv = new Map<string, Record<string, string>>();
  for (const [name, upstream] of Object.entries(config.upstreams)) {
    const values: Record<string, string> = {};
    if (upstream.transport === 'http') {
      for (const [header, variable] of Object.entries(upstream.headers_env ?? {})) {
        values[header] = read(variable, `upstream "${name}" header ${header}`, true);
      }
      headers.set(name, values);
    } else {
      for (const variable of upstream.pass_env ?? []) {
        values[variable] = read(variable, `upstream "${name}" pass_env`);
      }
      childEnv.set(name, values);
    }
  }
  const webhookSecret =
    config.approval.type === 'webhook'
      ? read(config.approval.secret_env, 'webhook approval', true)
      : undefined;
  if (issues.length > 0) throw startError(issues);
  return { headers, childEnv, ...(webhookSecret !== undefined && { webhookSecret }) };
}

function readPolicy(path: string): Policy {
  try {
    return loadPolicy(path);
  } catch (e) {
    if (e instanceof PolicyError) throw configError(`Invalid policy ${path}`, e.issues);
    throw startError([`could not read the policy ${path}${codeOf(e)}`], e);
  }
}

function checkPolicy(policy: Policy, config: ProxyConfig, log: (line: string) => void): void {
  const issues = lintPolicy(policy, {
    identities: config.identities.map((i) => i.name),
    servers: Object.keys(config.upstreams),
  });
  const label = (i: { rule?: string; message: string }) =>
    i.rule === undefined ? i.message : `rule "${i.rule}": ${i.message}`;
  for (const issue of issues) if (issue.level === 'warning') log(`warning: ${label(issue)}`);
  const errors = issues.filter((i) => i.level === 'error').map(label);
  if (errors.length > 0) throw configError(`Policy ${config.policy} has lint errors`, errors);
}

function upstreamSpecs(config: ProxyConfig, found: Secrets): UpstreamSpec[] {
  return Object.entries(config.upstreams).map(([name, u]): UpstreamSpec => {
    if (u.transport === 'stdio') {
      const env = found.childEnv.get(name);
      return {
        name,
        transport: 'stdio',
        command: u.command,
        ...(u.cwd !== undefined && { cwd: u.cwd }),
        ...(u.args && { args: u.args }),
        ...(env && Object.keys(env).length > 0 && { env }),
      };
    }
    const headers = found.headers.get(name);
    return { name, transport: 'http', url: u.url, ...(headers && { headers }) };
  });
}

function approverFor(config: ProxyConfig, found: Secrets): Approver {
  const approval = config.approval;
  switch (approval.type) {
    case 'cli':
      return cliApprover();
    case 'webhook':
      if (!found.webhookSecret) throw startError(['webhook approval has no secret']);
      return webhookApprover({ url: approval.url, secret: found.webhookSecret });
    case 'deny':
      return denyApprover;
  }
}

/** The stdio identity, checked again here because a config can be built without `loadConfig`. */
function stdioIdentity(config: ProxyConfig): string {
  const identity = config.stdio_identity;
  if (identity === undefined || !config.identities.some((i) => i.name === identity)) {
    throw startError([
      'listen.transport stdio needs a stdio_identity that is one of the identities',
    ]);
  }
  return identity;
}

async function connectUpstreams(specs: UpstreamSpec[], log: (line: string) => void) {
  try {
    return await Upstreams.connect(specs, {
      onError: (server, e) => log(`upstream "${server}": listing its tools failed${codeOf(e)}`),
    });
  } catch (e) {
    const failures = e instanceof UpstreamConnectError ? e.failures : [];
    throw startError(
      failures.length > 0
        ? failures.map((f) => `could not connect to upstream "${f.name}"${codeOf(f.error)}`)
        : ['could not connect to the upstreams'],
      e,
    );
  }
}

/**
 * Checks everything the config refers to before anything listens or is spawned, then connects
 * the upstreams and starts serving.
 */
export async function startFromConfig(
  config: ProxyConfig,
  opts: StartOptions = {},
): Promise<RunningFromConfig> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));

  const found = secrets(config, env);
  const policy = readPolicy(config.policy);
  checkPolicy(policy, config, log);
  const approver = approverFor(config, found);
  const listen = config.listen;
  const identity = listen.transport === 'stdio' ? stdioIdentity(config) : undefined;
  if (listen.transport === 'http' && !LOOPBACK_HOSTS.includes(listen.host)) {
    log(
      `warning: listening on ${listen.host}: bearer tokens travel in clear text and Host/Origin checks are off; terminate TLS in front of the proxy`,
    );
  }

  let audit: ReturnType<typeof fileAuditSink>;
  try {
    audit = fileAuditSink(config.audit.path);
  } catch (e) {
    throw startError([`could not open the audit log ${config.audit.path}${codeOf(e)}`], e);
  }
  let upstreams: Upstreams;
  try {
    upstreams = await connectUpstreams(upstreamSpecs(config, found), log);
  } catch (e) {
    audit.close();
    throw e;
  }

  let server: { close(): Promise<void> } | undefined;
  let closing: Promise<void> | undefined;
  let markClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => (markClosed = resolve));
  const close = () => {
    closing ??= (async () => {
      try {
        await server?.close();
      } finally {
        await upstreams.close();
        audit.close();
        markClosed();
      }
    })();
    return closing;
  };

  // From here on a failure must take the spawned upstreams and the audit file down with it.
  try {
    const onError = (e: Error) => log(`error: ${e.message}`);
    const gate = policyGate({
      policy,
      audit,
      approver,
      approvalTimeoutMs: config.approval.timeout_seconds * 1000,
    });
    if (listen.transport === 'stdio') {
      server = startStdioProxy({
        upstreams,
        gate,
        onError,
        identity: identity ?? stdioIdentity(config),
        // The client closing stdin ends the session, and with it the process's reason to run.
        onClose: () => void close(),
        ...(opts.stdioTransport && { transport: opts.stdioTransport }),
      });
      return { close, closed };
    }
    const { host, port, path, session_header } = listen;
    const http = await startHttpProxy({
      upstreams,
      gate,
      onError,
      authenticator: staticTokenAuthenticator(config.identities, env),
      host,
      port,
      path,
      sessionHeader: session_header,
    }).catch((e: unknown) => {
      throw startError([`could not listen on ${host}:${port}${codeOf(e)}`], e);
    });
    server = http;
    return { url: http.url, close, closed };
  } catch (e) {
    await close();
    throw e instanceof PolicyError ? e : startError(['the proxy could not be set up'], e);
  }
}
