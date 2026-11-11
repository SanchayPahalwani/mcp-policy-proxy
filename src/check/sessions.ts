import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { splitName } from '../policy/names.js';

export interface SessionRecord {
  file: string;
  line: number;
  ts: number;
  session: string;
  identity: string;
  server: string;
  tool: string;
  args: Record<string, unknown>;
  approved: boolean;
}

export class SessionFormatError extends Error {
  readonly file: string;
  readonly line: number;

  constructor(file: string, line: number, problem: string) {
    super(`${file}:${line}: ${problem}`);
    this.name = 'SessionFormatError';
    this.file = file;
    this.line = line;
  }
}

type Fields = Record<string, unknown>;

const isObject = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// The engine throws on a non-finite time, so a bad one is refused here with its line number.
function parseTime(value: unknown): number | undefined {
  const ms = typeof value === 'string' ? Date.parse(value) : value;
  return typeof ms === 'number' && Number.isFinite(ms) ? ms : undefined;
}

export function readSessionFile(
  path: string,
  defaults: { identity?: string } = {},
): SessionRecord[] {
  const records: SessionRecord[] = [];
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  for (const [index, text] of lines.entries()) {
    if (text.trim() === '') continue;
    const line = index + 1;
    const fail = (problem: string): never => {
      throw new SessionFormatError(path, line, problem);
    };
    let fields: unknown;
    try {
      fields = JSON.parse(text);
    } catch {
      return fail('line is not valid JSON');
    }
    if (!isObject(fields)) return fail('line must be a JSON object');

    const text_ = (key: string): string | undefined => {
      const value = fields[key];
      if (value === undefined) return undefined;
      return typeof value === 'string' && value !== ''
        ? value
        : fail(`"${key}" must be a non-empty string`);
    };
    const ts = parseTime(fields['ts']);
    if (ts === undefined) fail('"ts" must be an ISO time string or a number of milliseconds');

    // Audit logs mix decisions with outcomes and listings; only a call that was forwarded
    // was ever allowed, so only those are replayed.
    const typed = fields['type'] !== undefined;
    if (typed && (fields['type'] !== 'decision' || fields['forwarded'] !== true)) continue;

    let server = text_('server');
    let tool = text_('tool');
    if (server === undefined) {
      const name = text_('name') ?? tool;
      if (name === undefined) fail('"tool" is required');
      const parts = splitName(name as string);
      if (!parts) fail('needs "server" and "tool", or a name like server__tool');
      ({ server, tool } = parts as { server: string; tool: string });
    } else if (tool === undefined) {
      fail('"tool" is required');
    }

    const identity = text_('identity') ?? defaults.identity;
    if (identity === undefined) fail('no identity on the line and no default identity given');

    const args = fields['args'] === undefined && !typed ? {} : fields['args'];
    if (!isObject(args)) fail('"args" must be a JSON object');

    let approved: boolean;
    if (typed) {
      const approval = fields['approval'];
      approved = isObject(approval) && approval['approved'] === true;
    } else {
      const flag = fields['approved'] ?? false;
      if (typeof flag !== 'boolean') fail('"approved" must be true or false');
      approved = flag as boolean;
    }

    records.push({
      file: path,
      line,
      ts: ts as number,
      session: text_('session') ?? basename(path),
      identity: identity as string,
      server: server as string,
      tool: tool as string,
      args: args as Fields,
      approved,
    });
  }
  // Array.prototype.sort is stable, so equal times keep file order.
  return records.sort((a, b) => a.ts - b.ts);
}
