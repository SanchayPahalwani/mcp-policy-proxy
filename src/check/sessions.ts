import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { splitName } from '../policy/names.js';
import { isPlainObject } from '../util.js';

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
  /** The proxy run that wrote the line, when it names one; `check` keeps limits per run. */
  run?: string;
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

// An explicit zone is required: a bare "1" or "Jan 5" parses to some date and would put
// the call at a time nobody recorded.
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

// The engine throws on a non-finite time, so a bad one is refused here with its line number.
function parseTime(value: unknown): number | undefined {
  let ms = value;
  if (typeof value === 'string') ms = isRealTime(value) ? Date.parse(value) : NaN;
  return typeof ms === 'number' && Number.isFinite(ms) && Math.abs(ms) <= MAX_DATE_MS
    ? ms
    : undefined;
}

const MAX_DATE_MS = 8.64e15;

// Date.parse rolls 2026-02-30 over to March 2, which would put the call on a day nobody recorded.
function isRealTime(text: string): boolean {
  if (!ISO_TIME.test(text)) return false;
  const [year, month, day, hour, minute, second] = text.split(/[-T:.Z+]/, 6).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const monthLength = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= monthLength &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59
  );
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
    if (!isPlainObject(fields)) return fail('line must be a JSON object');

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
    for (const [field, namespaced] of [
      ['name', name],
      ['tool', server === undefined ? tool : undefined],
    ] as const) {
      if (namespaced === undefined) continue;
      const parts = splitName(namespaced);
      if (!parts) {
        return fail(
          field === 'name'
            ? '"name" must be a namespaced server__tool name'
            : 'needs "server" and "tool", or a name like server__tool',
        );
      }
      forms.push(parts);
    }
    const target = forms[0];
    if (!target) return fail('"tool" is required');
    if (forms.some((f) => f.server !== target.server || f.tool !== target.tool)) {
      return fail('conflicting target fields');
    }

    const run = text_('run');
    const identity = text_('identity') ?? defaults.identity;
    if (identity === undefined) {
      return fail('no identity on the line and no default identity given');
    }

    const args = fields['args'] === undefined && !typed ? {} : fields['args'];
    if (!isPlainObject(args)) return fail('"args" must be a JSON object');

    let approved = false;
    if (typed) {
      const approval = fields['approval'];
      approved = isPlainObject(approval) && approval['approved'] === true;
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
      ...(run !== undefined && { run }),
    });
  }
  // Array.prototype.sort is stable, so equal times keep file order.
  return records.sort((a, b) => a.ts - b.ts);
}
