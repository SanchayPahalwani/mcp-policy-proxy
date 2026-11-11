import { readFileSync } from 'node:fs';
import type { CliIo } from '../cli.js';
import { formatLint } from '../check/report.js';
import { loadConfig } from '../config/schema.js';
import { lintPolicy } from '../policy/lint.js';
import { parsePolicy, PolicyError } from '../policy/load.js';
import { messageOf } from '../util.js';
import { formatOf, InputError, noPositionals, parse, required } from './shared.js';

export function validate(args: string[], io: CliIo): number {
  const { values, positionals } = parse(args, {
    policy: { type: 'string' },
    config: { type: 'string' },
    format: { type: 'string' },
  });
  noPositionals(positionals);
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
