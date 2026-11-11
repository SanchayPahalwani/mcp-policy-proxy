import type { CliIo } from '../cli.js';
import { runPolicyTestFile } from '../check/policy-tests.js';
import { formatTests } from '../check/report.js';
import { formatOf, InputError, parse, policyAt } from './shared.js';

export function test(args: string[], io: CliIo): number {
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
