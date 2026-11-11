import type { CliIo } from '../cli.js';
import { decide } from '../policy/engine.js';
import { LimitState } from '../policy/limits.js';
import { splitName } from '../policy/names.js';
import { InputError, parse, policyAt, required } from './shared.js';

export function explain(args: string[], io: CliIo): number {
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
