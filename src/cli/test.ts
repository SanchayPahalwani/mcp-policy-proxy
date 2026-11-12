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
  const results = positionals.flatMap((path) => {
    const fileResults = runPolicyTestFile(path, policy);
    // An empty file passes trivially; say so, in case the wrong file was named.
    if (fileResults.length === 0) io.stderr.write(`note: ${path}: no cases\n`);
    return fileResults;
  });
  io.stdout.write(formatTests(results, format));
  return results.every((r) => r.ok) ? 0 : 1;
}
