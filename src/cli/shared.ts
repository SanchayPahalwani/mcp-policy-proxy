import { parseArgs } from 'node:util';
import type { CliIo } from '../cli.js';
import type { Format } from '../check/report.js';
import { loadPolicy } from '../policy/load.js';
import { messageOf } from '../util.js';

/** A problem with the arguments or an input file: exit 2. */
export class InputError extends Error {}

const FORMATS: readonly string[] = ['text', 'json', 'github'];

export type OptionSpec = Record<string, { type: 'string' }>;

export function parse<T extends OptionSpec>(args: string[], options: T) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (e) {
    throw new InputError(messageOf(e));
  }
}

export function formatOf(value: string | undefined, io: CliIo): Format {
  const chosen =
    value ?? ((io.env ?? process.env)['GITHUB_ACTIONS'] === 'true' ? 'github' : 'text');
  if (!FORMATS.includes(chosen)) throw new InputError(`unknown format "${chosen}"`);
  return chosen as Format;
}

export function required(value: string | undefined, flag: string): string {
  if (value === undefined) throw new InputError(`${flag} is required`);
  return value;
}

export function policyAt(path: string) {
  try {
    return loadPolicy(path);
  } catch (e) {
    throw new InputError(messageOf(e));
  }
}
