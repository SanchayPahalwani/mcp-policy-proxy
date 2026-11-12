import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { messageOf } from '../src/util.js';
import { anthropicModel } from './agent/anthropic.js';
import type { Transcript, TranscriptTurn } from './agent/loop.js';
import { replayRun } from './agent/replay.js';
import { scriptedModel } from './agent/scripted.js';
import {
  PROVENANCE_BEGIN,
  PROVENANCE_END,
  RESULTS_BEGIN,
  RESULTS_END,
  renderTable,
  replaceBlock,
  summarize,
  type Summary,
} from './report.js';
import { runAll, type Condition, type MakeModel, type RunResult } from './run.js';
import { SCENARIOS, type Scenario } from './suite/scenarios.js';

const CONDITIONS: Condition[] = ['baseline', 'enforced'];
const DEFAULT_MODEL = 'claude-opus-5-5';
const SYNTHETIC = 'synthetic';
// Becomes a directory name, so nothing that could leave eval/transcripts.
const MODEL_ID = /^[a-z0-9][a-z0-9.-]*$/;
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

const USAGE = `usage: tsx eval/cli.ts run
       tsx eval/cli.ts record [--model scripted | <model id>] [--only <scenario id>]...
       tsx eval/cli.ts replay [--check]
       tsx eval/cli.ts report

  run      runs the scripted model under both conditions and prints the table
  record   runs a model under both conditions and writes its transcript set;
           --model defaults to ${DEFAULT_MODEL}, which needs ANTHROPIC_API_KEY or
           ANTHROPIC_AUTH_TOKEN and is billed; --only replaces just those scenarios
  replay   replays every set under eval/transcripts and prints the table; --check exits 1
           if a replay diverges or docs/results.md does not hold that table
  report   replays every set and rewrites the results block of docs/results.md
`;

export interface EvalIo {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  /** Defaults to `process.env`; only the two Anthropic credential variables are read. */
  env?: NodeJS.ProcessEnv;
  /** The repository root that holds `eval/transcripts` and `docs/results.md`. */
  root?: string;
}

const transcriptsDir = (root: string) => join(root, 'eval', 'transcripts');
const setFile = (root: string, set: string, condition: Condition) =>
  join(transcriptsDir(root), set, `${condition}.jsonl`);
const resultsDoc = (root: string) => join(root, 'docs', 'results.md');
const shown = (root: string, path: string) =>
  path.startsWith(root) ? path.slice(root.length).replace(/^[/\\]/, '') : path;

/** One transcript per line, in the order given; the committed files are written by this. */
export function transcriptLines(transcripts: Transcript[]): string {
  return transcripts.map((t) => `${JSON.stringify(t)}\n`).join('');
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function isTurn(v: unknown): v is TranscriptTurn {
  if (!isObject(v) || typeof v['ts'] !== 'number' || !isObject(v['assistant'])) return false;
  const { text, tool_calls, stop } = v['assistant'];
  const results = v['results'];
  return (
    typeof text === 'string' &&
    (stop === 'tool_use' || stop === 'end' || stop === 'refusal') &&
    Array.isArray(tool_calls) &&
    tool_calls.every(
      (c) =>
        isObject(c) &&
        typeof c['id'] === 'string' &&
        typeof c['name'] === 'string' &&
        isObject(c['arguments']),
    ) &&
    Array.isArray(results) &&
    results.every(
      (r) =>
        isObject(r) &&
        typeof r['tool_call_id'] === 'string' &&
        typeof r['content'] === 'string' &&
        typeof r['is_error'] === 'boolean',
    )
  );
}

function parseTranscript(line: string, where: string, condition: Condition): Transcript {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (e) {
    throw new Error(`${where}: not JSON (${messageOf(e)})`);
  }
  if (
    !isObject(value) ||
    typeof value['scenario'] !== 'string' ||
    typeof value['model'] !== 'string' ||
    (value['source'] !== 'synthetic' && value['source'] !== 'live') ||
    !['end', 'refusal', 'max_turns'].includes(value['ended'] as string) ||
    !Array.isArray(value['turns']) ||
    !value['turns'].every(isTurn)
  ) {
    throw new Error(`${where}: not a transcript`);
  }
  if (value['condition'] !== condition) {
    throw new Error(
      `${where}: a ${String(value['condition'])} transcript in the ${condition} file`,
    );
  }
  return value as unknown as Transcript;
}

function readSetFile(root: string, set: string, condition: Condition): Transcript[] {
  const path = setFile(root, set, condition);
  const where = shown(root, path);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(`cannot read ${where}: ${messageOf(e)}`);
  }
  return text
    .split('\n')
    .map((line, i) => ({ line, where: `${where}:${i + 1}` }))
    .filter(({ line }) => line.trim() !== '')
    .map(({ line, where: at }) => parseTranscript(line, at, condition));
}

/** `synthetic` first, then the live sets by name, so the report has a fixed order. */
function listSets(root: string): string[] {
  const dir = transcriptsDir(root);
  const sets = existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    : [];
  if (sets.length === 0) throw new Error(`no transcript sets under ${shown(root, dir)}`);
  return sets.sort(
    (a, b) => Number(b === SYNTHETIC) - Number(a === SYNTHETIC) || a.localeCompare(b),
  );
}

interface Divergence {
  set: string;
  run: RunResult;
}

async function replaySets(root: string): Promise<{ summaries: Summary[]; diverged: Divergence[] }> {
  const summaries: Summary[] = [];
  const diverged: Divergence[] = [];
  for (const set of listSets(root)) {
    const results: RunResult[] = [];
    for (const condition of CONDITIONS) {
      const seen = new Set<string>();
      for (const transcript of readSetFile(root, set, condition)) {
        // A scenario listed twice would be counted twice.
        if (seen.has(transcript.scenario)) {
          throw new Error(`set ${set}: ${transcript.scenario} appears twice in ${condition}.jsonl`);
        }
        seen.add(transcript.scenario);
        const run = await replayRun(transcript);
        results.push(run);
        if (run.divergences > 0) diverged.push({ set, run });
      }
    }
    if (results.length === 0) throw new Error(`set ${set} holds no transcripts`);
    const summary = summarize(results);
    // A live set must never be counted as synthetic, nor the other way round.
    const expected = set === SYNTHETIC ? 'synthetic' : 'live';
    if (summary.source !== expected || (expected === 'live' && set !== `live-${summary.model}`)) {
      throw new Error(`set ${set} holds ${summary.model} (${summary.source}) transcripts`);
    }
    summaries.push(summary);
  }
  return { summaries, diverged };
}

function reportDivergences(diverged: Divergence[], io: EvalIo): void {
  for (const { set, run } of diverged) {
    io.stderr.write(
      `divergence: ${set} ${run.condition} ${run.scenario}: ${run.divergences} result(s) differ from the recording\n`,
    );
  }
}

function revision(root: string): string {
  const opts: ExecFileSyncOptionsWithStringEncoding = {
    cwd: root,
    encoding: 'utf8',
    // Outside a repository git complains on stderr; the answer is then just "unknown".
    stdio: ['ignore', 'pipe', 'ignore'],
  };
  try {
    const hash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], opts).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], opts).trim() !== '';
    return dirty ? `${hash}-dirty` : hash;
  } catch {
    return 'unknown';
  }
}

function provenance(root: string): string {
  return [
    '- Command: `npm run eval:report` (`tsx eval/cli.ts report`)',
    `- Commit: \`${revision(root)}\``,
    `- Date: ${new Date().toISOString().slice(0, 10)}`,
  ].join('\n');
}

function readDoc(root: string): string {
  const path = resultsDoc(root);
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(`cannot read ${shown(root, path)}: ${messageOf(e)}`);
  }
}

function parseRecordArgs(args: string[]): { model: string; only: string[] } {
  let model = DEFAULT_MODEL;
  const only: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    if ((flag !== '--model' && flag !== '--only') || value === undefined) {
      throw new Error(`record: unexpected argument ${flag ?? ''}\n${USAGE}`);
    }
    if (flag === '--model') model = value;
    else only.push(value);
    i++;
  }
  return { model, only };
}

function selectScenarios(only: string[]): Scenario[] {
  if (only.length === 0) return SCENARIOS;
  for (const id of only) {
    if (!SCENARIOS.some((s) => s.id === id)) throw new Error(`record: unknown scenario ${id}`);
  }
  return SCENARIOS.filter((s) => only.includes(s.id));
}

function writeSet(root: string, set: string, runs: RunResult[], partial: boolean): void {
  const order = new Map(SCENARIOS.map((s, i) => [s.id, i]));
  mkdirSync(join(transcriptsDir(root), set), { recursive: true });
  for (const condition of CONDITIONS) {
    const path = setFile(root, set, condition);
    const kept = partial && existsSync(path) ? readSetFile(root, set, condition) : [];
    const byScenario = new Map(kept.map((t) => [t.scenario, t]));
    for (const run of runs)
      if (run.condition === condition) byScenario.set(run.scenario, run.transcript);
    const transcripts = [...byScenario.values()]
      .filter((t) => order.has(t.scenario))
      .sort((a, b) => order.get(a.scenario)! - order.get(b.scenario)!);
    writeFileSync(path, transcriptLines(transcripts));
  }
}

async function record(args: string[], io: EvalIo, root: string): Promise<number> {
  const { model, only } = parseRecordArgs(args);
  const scenarios = selectScenarios(only);
  let makeModel: MakeModel;
  let set: string;
  if (model === 'scripted') {
    makeModel = scriptedModel;
    set = SYNTHETIC;
  } else {
    if (!MODEL_ID.test(model)) throw new Error(`record: ${model} is not a model id`);
    const env = io.env ?? process.env;
    const apiKey = env['ANTHROPIC_API_KEY'];
    const authToken = env['ANTHROPIC_AUTH_TOKEN'];
    if (!apiKey && !authToken) {
      io.stderr.write(
        `record: a live model needs ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN in the environment; neither is set. Recording ${model} costs money; use --model scripted for the synthetic set.\n`,
      );
      return 2;
    }
    const client = new Anthropic(apiKey ? { apiKey } : { authToken: authToken ?? null });
    makeModel = () => anthropicModel({ model, client });
    set = `live-${model}`;
    io.stderr.write(`recording ${model}: ${scenarios.length * CONDITIONS.length} runs, billed\n`);
  }
  // Nothing is written unless every run finished, so a failure never leaves a half-new set.
  const runs = await runAll(CONDITIONS, makeModel, scenarios);
  writeSet(root, set, runs, only.length > 0);
  io.stdout.write(renderTable([summarize(runs)]));
  io.stderr.write(
    `wrote ${shown(root, join(transcriptsDir(root), set))}/{baseline,enforced}.jsonl\n`,
  );
  return 0;
}

async function replay(args: string[], io: EvalIo, root: string): Promise<number> {
  const check = args.length === 1 && args[0] === '--check';
  if (args.length > 0 && !check)
    throw new Error(`replay: unexpected argument ${args[0]}\n${USAGE}`);
  const { summaries, diverged } = await replaySets(root);
  const table = renderTable(summaries);
  io.stdout.write(table);
  reportDivergences(diverged, io);
  if (!check) return 0;
  let failed = diverged.length > 0;
  const doc = readDoc(root);
  if (replaceBlock(doc, RESULTS_BEGIN, RESULTS_END, table) !== doc) {
    io.stderr.write(
      'replay: the results block in docs/results.md differs from the replayed table; run npm run eval:report\n',
    );
    failed = true;
  }
  return failed ? 1 : 0;
}

async function report(args: string[], io: EvalIo, root: string): Promise<number> {
  if (args.length > 0) throw new Error(`report: unexpected argument ${args[0]}\n${USAGE}`);
  const { summaries, diverged } = await replaySets(root);
  if (diverged.length > 0) {
    reportDivergences(diverged, io);
    io.stderr.write(
      'report: replays diverged from their recordings; docs/results.md left as it was\n',
    );
    return 1;
  }
  const table = renderTable(summaries);
  let doc = readDoc(root);
  doc = replaceBlock(doc, RESULTS_BEGIN, RESULTS_END, table);
  doc = replaceBlock(doc, PROVENANCE_BEGIN, PROVENANCE_END, provenance(root));
  writeFileSync(resultsDoc(root), doc);
  io.stdout.write(table);
  io.stderr.write('updated docs/results.md\n');
  return 0;
}

async function run(args: string[], io: EvalIo): Promise<number> {
  if (args.length > 0) throw new Error(`run: unexpected argument ${args[0]}\n${USAGE}`);
  io.stdout.write(renderTable([summarize(await runAll(CONDITIONS, scriptedModel))]));
  return 0;
}

export async function main(
  argv: string[],
  io: EvalIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  const root = io.root ?? REPO_ROOT;
  const [command, ...rest] = argv;
  if (command === '--help' || command === '-h') {
    io.stdout.write(USAGE);
    return 0;
  }
  try {
    switch (command) {
      case 'run':
        return await run(rest, io);
      case 'record':
        return await record(rest, io, root);
      case 'replay':
        return await replay(rest, io, root);
      case 'report':
        return await report(rest, io, root);
      default:
        io.stderr.write(USAGE);
        return 2;
    }
  } catch (e) {
    // Input the command could not use, or a harness that broke: no result either way, unlike a
    // check that ran and failed, which is exit 1.
    io.stderr.write(`eval: ${messageOf(e)}\n`);
    return 2;
  }
}

function isEntryPoint(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(script)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = await main(process.argv.slice(2));
}
