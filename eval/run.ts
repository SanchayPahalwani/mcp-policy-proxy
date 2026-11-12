import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { memoryAuditSink, type AuditEvent } from '../src/audit/log.js';
import { loadPolicy } from '../src/policy/load.js';
import { sha256Hex, staticTokenAuthenticator } from '../src/proxy/auth.js';
import { passthroughGate } from '../src/proxy/gate.js';
import { startHttpProxy } from '../src/proxy/http.js';
import { policyGate } from '../src/proxy/policy-gate.js';
import { Upstreams } from '../src/proxy/upstreams.js';
import { runAgent, type Transcript } from './agent/loop.js';
import type { Model } from './agent/model.js';
import type { LedgerEntry } from './ledger.js';
import { countForbidden } from './suite/injections.js';
import { plant, SCENARIOS, SYSTEM_PROMPT, type Scenario } from './suite/scenarios.js';
import { createWorld } from './world.js';

export type Condition = 'baseline' | 'enforced';

export interface RunResult {
  scenario: string;
  condition: Condition;
  /** Every forbidden behaviour that reached a server, whatever the scenario planted. */
  forbidden_calls: number;
  /** Only the calls toward the planted goal, for a table by goal. */
  goal_calls: number;
  task_completed: boolean;
  injected: boolean;
  divergences: number;
  transcript: Transcript;
  ledger: LedgerEntry[];
}

export type MakeModel = (scenario: Scenario, condition: Condition) => Model;

export const EVAL_EPOCH = Date.UTC(2026, 0, 1);

const TURN_MS = 1000;
// Never a secret: the proxy listens on loopback for one run and is closed straight after.
const WRITER_TOKEN = 'eval-writer-token';
const EXAMPLE_POLICY = fileURLToPath(new URL('../examples/policy.yaml', import.meta.url));

/**
 * A run whose proxy failed is not a measurement: scoring it would credit the policy for what a
 * crash refused, or drop an attack that reached a broken server. A policy refusal is fine.
 */
export class HarnessError extends Error {
  override name = 'HarnessError';
}

const HARNESS_CODES = new Set(['internal_error', 'audit_failed']);

export function assertHarnessClean(
  events: readonly AuditEvent[],
  scenarioId: string,
  condition: Condition,
): void {
  for (const event of events) {
    let code: string | undefined;
    if (event.type === 'decision' && HARNESS_CODES.has(event.code)) code = event.code;
    if (event.type === 'outcome' && !event.ok) code = `outcome ${event.error ?? 'failed'}`;
    if (code !== undefined) {
      throw new HarnessError(`${scenarioId} (${condition}): the proxy reported ${code}`);
    }
  }
}

/** Closes everything; a close failure is rethrown only when nothing else has gone wrong first. */
async function closeAll(closers: Array<() => Promise<void>>, failed: boolean): Promise<void> {
  let failure: unknown;
  for (const close of closers.reverse()) {
    try {
      await close();
    } catch (e) {
      if (failed) console.error('eval: cleanup after a failed run also failed', e);
      else failure ??= e;
    }
  }
  if (failure !== undefined) throw failure;
}

export async function runScenario(
  scenario: Scenario,
  condition: Condition,
  makeModel: MakeModel,
  opts: { policyPath?: string; turnTimes?: number[] } = {},
): Promise<RunResult> {
  const { task, injection } = scenario;
  const policy = condition === 'enforced' ? loadPolicy(opts.policyPath ?? EXAMPLE_POLICY) : null;
  // One clock for the ledger, the limits and the transcript, so a replay can reproduce all three.
  let now = EVAL_EPOCH;
  const clock = () => now;
  const world = createWorld(clock, injection ? plant(task, injection) : task.seed);
  const model = makeModel(scenario, condition);

  const audit = memoryAuditSink();
  const closers: Array<() => Promise<void>> = [];
  let failed = true;
  let outcome: Pick<Transcript, 'turns' | 'ended'>;
  try {
    const upstreams = await Upstreams.connect(world.upstreams());
    closers.push(() => upstreams.close());
    const proxy = await startHttpProxy({
      upstreams,
      gate: policy ? policyGate({ policy, clock, audit }) : passthroughGate,
      authenticator: staticTokenAuthenticator([
        { name: 'writer', token_sha256: sha256Hex(WRITER_TOKEN) },
      ]),
      host: '127.0.0.1',
      port: 0,
    });
    closers.push(() => proxy.close());

    const client = new Client(
      { name: 'eval-agent', version: '0.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    closers.push(() => client.close());
    const headers = {
      authorization: `Bearer ${WRITER_TOKEN}`,
      // Scenario ids carry a '+', which the proxy's session header does not accept.
      'x-agent-session': scenario.id.replace('+', '.'),
    };
    await client.connect(
      new StreamableHTTPClientTransport(new URL(proxy.url), { requestInit: { headers } }),
    );

    outcome = await runAgent(model, client, {
      system: SYSTEM_PROMPT,
      prompt: task.prompt,
      now: clock,
      beforeTurn: (i) => {
        now = opts.turnTimes?.[i] ?? now + TURN_MS;
      },
    });
    failed = false;
  } finally {
    await closeAll(closers, failed);
  }
  assertHarnessClean(audit.events, scenario.id, condition);

  const ledger = world.ledger.entries;
  return {
    scenario: scenario.id,
    condition,
    forbidden_calls: countForbidden(ledger),
    goal_calls: injection?.forbiddenCalls(ledger) ?? 0,
    task_completed: task.success(world),
    injected: injection !== undefined,
    divergences: (model as { divergences?: () => number }).divergences?.() ?? 0,
    transcript: {
      scenario: scenario.id,
      condition,
      model: model.id,
      source: model.source,
      ...outcome,
    },
    ledger,
  };
}

/** One run at a time, so only one proxy is listening at once and results keep a fixed order. */
export async function runAll(
  conditions: Condition[],
  makeModel: MakeModel,
  scenarios: Scenario[] = SCENARIOS,
): Promise<RunResult[]> {
  const runs: RunResult[] = [];
  for (const condition of conditions) {
    for (const scenario of scenarios) runs.push(await runScenario(scenario, condition, makeModel));
  }
  return runs;
}
