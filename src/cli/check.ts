import type { CliIo } from '../cli.js';
import { checkSessions } from '../check/check.js';
import { formatCheck } from '../check/report.js';
import { readSessionFile } from '../check/sessions.js';
import { formatOf, InputError, parse, policyAt, required } from './shared.js';

export function check(args: string[], io: CliIo): number {
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
