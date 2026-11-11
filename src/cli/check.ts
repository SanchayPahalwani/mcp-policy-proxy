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
  const files = positionals.map((path) => {
    const records = readSessionFile(path, defaults);
    // An empty file passes trivially; say so, in case the wrong file was named.
    if (records.length === 0) io.stderr.write(`note: ${path}: no recorded calls\n`);
    return records;
  });
  const result = checkSessions(policy, files);
  io.stdout.write(formatCheck(result, format));
  return result.violations.length === 0 ? 0 : 1;
}
