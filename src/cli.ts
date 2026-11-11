#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { registerOtlpExporter } from './audit/otel.js';
import { checkSessions } from './check/check.js';
import { runPolicyTestFile } from './check/policy-tests.js';
import { formatCheck, formatLint, formatTests, type Format } from './check/report.js';
import { readSessionFile } from './check/sessions.js';
import { loadConfig, startFromConfig } from './config.js';
import { decide } from './policy/engine.js';
import { LimitState } from './policy/limits.js';
import { lintPolicy } from './policy/lint.js';
import { splitName } from './policy/names.js';
import { loadPolicy, parsePolicy, PolicyError } from './policy/load.js';

const USAGE = `usage: mcp-policy-proxy serve --config <file>
       mcp-policy-proxy check --policy <file> [--identity <name>] [--format text|json|github] <sessions...>
       mcp-policy-proxy test [--policy <file>] [--format text|json|github] <tests...>
       mcp-policy-proxy validate --policy <file> [--config <file>] [--format text|json|github]
       mcp-policy-proxy explain --policy <file> --identity <name> --tool <server__tool> [--args <json>] [--session <id>]
`;

export interface CliIo {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  /** Defaults to `process.env`; only `GITHUB_ACTIONS` is read. */
  env?: NodeJS.ProcessEnv;
}

/** A problem with the arguments or an input file: exit 2. */
class InputError extends Error {}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

function serveArgs(args: string[]): { config: string } | undefined {
  try {
    const { values } = parseArgs({ args, options: { config: { type: 'string' } }, strict: true });
    return values.config === undefined ? undefined : { config: values.config };
  } catch {
    return undefined;
  }
}

function untilSignal(): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    const stop = (signal: NodeJS.Signals) => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve(signal);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}

async function serve(file: string, io: CliIo): Promise<number> {
  const log = (line: string) => void io.stderr.write(`${line}\n`);
  let stopTracing: (() => Promise<void>) | undefined;
  let code = 0;
  try {
    const config = loadConfig(file);
    if (process.env['OTEL_EXPORTER_OTLP_ENDPOINT']) stopTracing = await registerOtlpExporter();
    const running = await startFromConfig(config, { log });
    // stdout may be the MCP channel, so everything for the operator goes to stderr.
    log(running.url === undefined ? 'serving over stdio' : `listening on ${running.url}`);
    await untilSignal();
    await running.close();
  } catch (e) {
    log(`mcp-policy-proxy: ${messageOf(e)}`);
    code = 1;
  }
  try {
    // Flushes spans still waiting in the batch.
    await stopTracing?.();
  } catch (e) {
    // The proxy itself stopped cleanly; a collector that is down only loses those spans.
    log(`mcp-policy-proxy: could not export the last spans: ${messageOf(e)}`);
  }
  return code;
}

const FORMATS: readonly string[] = ['text', 'json', 'github'];

type OptionSpec = Record<string, { type: 'string' }>;

function parse<T extends OptionSpec>(args: string[], options: T) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (e) {
    throw new InputError(messageOf(e));
  }
}

function formatOf(value: string | undefined, io: CliIo): Format {
  const chosen =
    value ?? ((io.env ?? process.env)['GITHUB_ACTIONS'] === 'true' ? 'github' : 'text');
  if (!FORMATS.includes(chosen)) throw new InputError(`unknown format "${chosen}"`);
  return chosen as Format;
}

function required(value: string | undefined, flag: string): string {
  if (value === undefined) throw new InputError(`${flag} is required`);
  return value;
}

function policyAt(path: string) {
  try {
    return loadPolicy(path);
  } catch (e) {
    throw new InputError(messageOf(e));
  }
}

function check(args: string[], io: CliIo): number {
  const { values, positionals } = parse(args, {
    policy: { type: 'string' },
    identity: { type: 'string' },
    format: { type: 'string' },
  });
  const format = formatOf(values.format, io);
  const policy = policyAt(required(values.policy, '--policy'));
  if (positionals.length === 0) throw new InputError('name at least one sessions file');
  const defaults = values.identity === undefined ? {} : { identity: values.identity };
  const result = checkSessions(
    policy,
    positionals.map((path) => readSessionFile(path, defaults)),
  );
  io.stdout.write(formatCheck(result, format));
  return result.violations.length === 0 ? 0 : 1;
}

function test(args: string[], io: CliIo): number {
  const { values, positionals } = parse(args, {
    policy: { type: 'string' },
    format: { type: 'string' },
  });
  const format = formatOf(values.format, io);
  const policy = values.policy === undefined ? undefined : policyAt(values.policy);
  if (positionals.length === 0) throw new InputError('name at least one policy test file');
  const results = positionals.flatMap((path) => runPolicyTestFile(path, policy));
  io.stdout.write(formatTests(results, format));
  return results.every((r) => r.ok) ? 0 : 1;
}

function validate(args: string[], io: CliIo): number {
  const { values } = parse(args, {
    policy: { type: 'string' },
    config: { type: 'string' },
    format: { type: 'string' },
  });
  const format = formatOf(values.format, io);
  const file = required(values.policy, '--policy');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    throw new InputError(messageOf(e));
  }
  // From here a bad policy or config is the finding this command exists to report.
  const fail = (e: unknown) => {
    io.stderr.write(`mcp-policy-proxy: ${messageOf(e)}\n`);
    return 1;
  };
  let policy;
  try {
    policy = parsePolicy(text);
  } catch (e) {
    if (e instanceof PolicyError) return fail(e);
    throw e;
  }
  let known: { identities: string[]; servers: string[] } | undefined;
  if (values.config !== undefined) {
    try {
      const config = loadConfig(values.config);
      known = {
        identities: config.identities.map((i) => i.name),
        servers: Object.keys(config.upstreams),
      };
    } catch (e) {
      return fail(e);
    }
  }
  const issues = lintPolicy(policy, known);
  io.stdout.write(formatLint(issues, format));
  return issues.some((i) => i.level === 'error') ? 1 : 0;
}

function explain(args: string[], io: CliIo): number {
  const { values } = parse(args, {
    policy: { type: 'string' },
    identity: { type: 'string' },
    tool: { type: 'string' },
    args: { type: 'string' },
    session: { type: 'string' },
  });
  const policy = policyAt(required(values.policy, '--policy'));
  const identity = required(values.identity, '--identity');
  const name = required(values.tool, '--tool');
  const target = splitName(name);
  if (!target) throw new InputError(`--tool must look like server__tool, not "${name}"`);
  let callArgs: unknown = {};
  if (values.args !== undefined) {
    try {
      callArgs = JSON.parse(values.args);
    } catch {
      throw new InputError('--args is not valid JSON');
    }
    if (typeof callArgs !== 'object' || callArgs === null || Array.isArray(callArgs)) {
      throw new InputError('--args must be a JSON object');
    }
  }
  const call = {
    identity,
    session: values.session ?? 'explain',
    ...target,
    args: callArgs as Record<string, unknown>,
    at: Date.now(),
  };
  const d = decide(policy, new LimitState(), call);
  io.stdout.write(
    [
      `effect: ${d.effect}`,
      `code: ${d.code}`,
      `rule: ${d.rule ?? '-'}`,
      `reason: ${d.reason}`,
      `visible: ${d.visible}`,
      '',
    ].join('\n'),
  );
  return 0;
}

const OFFLINE = { check, test, validate, explain };

export async function main(
  argv: string[],
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== undefined && Object.hasOwn(OFFLINE, command)) {
    try {
      return OFFLINE[command as keyof typeof OFFLINE](rest, io);
    } catch (e) {
      // Unreadable or malformed input, as opposed to a finding about it.
      io.stderr.write(`mcp-policy-proxy: ${messageOf(e)}\n`);
      return 2;
    }
  }
  const serveOptions = command === 'serve' ? serveArgs(rest) : undefined;
  if (!serveOptions) {
    io.stderr.write(USAGE);
    return 2;
  }
  return serve(serveOptions.config, io);
}

function isEntryPoint(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    // The installed bin is a symlink to this file.
    return import.meta.url === pathToFileURL(realpathSync(script)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = await main(process.argv.slice(2));
}
