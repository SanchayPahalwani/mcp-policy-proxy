import { parseArgs } from 'node:util';
import type { CliIo } from '../cli.js';
import type { Format } from '../check/report.js';
import { loadPolicy } from '../policy/load.js';
import { messageOf } from '../util.js';

/** A problem with the arguments or an input file: exit 2. */
export class InputError extends Error {}

const FORMATS: readonly string[] = ['text', 'json', 'github'];

export type OptionSpec = Record<string, { type: 'string' }>;

/** Thrown by `parse` when `-h`/`--help` was parsed as an option (not after `--`, not as a value). */
export class HelpRequested extends Error {}

export function parse<T extends OptionSpec>(args: string[], options: T) {
  try {
    const parsed = parseArgs({
      args,
      options: { ...options, help: { type: 'boolean', short: 'h' } },
      allowPositionals: true,
      strict: true,
    });
    if ((parsed.values as { help?: boolean }).help === true) throw new HelpRequested();
    return parsed as { values: Partial<Record<keyof T, string>>; positionals: string[] };
  } catch (e) {
    if (e instanceof HelpRequested) throw e;
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

export function noPositionals(positionals: string[]): void {
  if (positionals.length > 0) {
    throw new InputError(`unexpected argument "${positionals[0]}"`);
  }
}
