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

// An explicit zone is required: a bare "1" or "Jan 5" parses to some date and would put
// the call at a time nobody recorded.
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

// The engine throws on a non-finite time, so a bad one is refused here with its line number.
function parseTime(value: unknown): number | undefined {
  const ms = typeof value === 'string' ? (ISO_TIME.test(value) ? Date.parse(value) : NaN) : value;
  return typeof ms === 'number' && Number.isFinite(ms) ? ms : undefined;
}

export function readSessionFile(
  path: string,
  defaults: { identity?: string } = {},
): SessionRecord[] {
  const records: SessionRecord[] = [];
  const lines = readFileSync(path, 'utf8')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/);
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

    // Only lines known not to be a forwarded call are skipped. Anything unrecognised is an
    // error, because skipping it would report a clean pass for calls the reader never saw.
    const typed = 'type' in fields;
    if (typed) {
      const type = fields['type'];
      if (type === 'outcome' || type === 'list') continue;
      if (type !== 'decision') fail('unknown event type');
      if (typeof fields['forwarded'] !== 'boolean') fail('"forwarded" must be true or false');
      if (fields['forwarded'] === false) continue;
    }

    const ts = parseTime(fields['ts']);
    if (ts === undefined) {
      return fail('"ts" must be an ISO 8601 time with a zone, or a number of milliseconds');
    }

    // Each form that is present must name the same call.
    const server = text_('server');
    const tool = text_('tool');
    const name = text_('name');
    if (server !== undefined && tool === undefined) fail('"tool" is required');
    const forms: Array<{ server: string; tool: string }> = [];
    if (server !== undefined && tool !== undefined) forms.push({ server, tool });
    for (const namespaced of [name, server === undefined ? tool : undefined]) {
      if (namespaced === undefined) continue;
      const parts = splitName(namespaced);
      if (!parts) return fail('needs "server" and "tool", or a name like server__tool');
      forms.push(parts);
    }
    const target = forms[0];
    if (!target) return fail('"tool" is required');
    if (forms.some((f) => f.server !== target.server || f.tool !== target.tool)) {
      return fail('conflicting target fields');
    }

    const identity = text_('identity') ?? defaults.identity;
    if (identity === undefined) {
      return fail('no identity on the line and no default identity given');
    }

    const args = fields['args'] === undefined && !typed ? {} : fields['args'];
    if (!isObject(args)) return fail('"args" must be a JSON object');

    let approved = false;
    if (typed) {
      const approval = fields['approval'];
      approved = isObject(approval) && approval['approved'] === true;
    } else if (fields['approved'] !== undefined) {
      if (typeof fields['approved'] !== 'boolean') return fail('"approved" must be true or false');
      approved = fields['approved'];
    }

    records.push({
      file: path,
      line,
      ts,
      session: text_('session') ?? basename(path),
      identity,
      server: target.server,
      tool: target.tool,
      args,
      approved,
    });
  }
  // Array.prototype.sort is stable, so equal times keep file order.
  return records.sort((a, b) => a.ts - b.ts);
}
