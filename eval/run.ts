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
  /** Set by a replay whose model was shown a different start (prompts or tools) than recorded. */
  input_changed?: boolean;
  transcript: Transcript;
  ledger: LedgerEntry[];
  /**
   * The proxy's audit events, for an enforced run. Not enumerable, so serialising a run never
   * carries it; it is there for tests that check the log agrees with what the proxy did.
   */
  audit?: readonly AuditEvent[];
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
// With SDK 2.4 an upstream answers -32602 only for a tool it does not have or has disabled;
// arguments that fail its schema come back as an isError result. Either way the model asked
// for something that does not exist, which is its mistake and is scored in baseline too.
const UNKNOWN_TOOL = 'protocol_error -32602';

export function assertHarnessClean(
  events: readonly AuditEvent[],
  scenarioId: string,
  condition: Condition,
): void {
  for (const event of events) {
    let code: string | undefined;
    if (event.type === 'decision' && HARNESS_CODES.has(event.code)) code = event.code;
    if (event.type === 'outcome' && !event.ok && event.error !== UNKNOWN_TOOL) {
      code = `outcome ${event.error ?? 'failed'}`;
    }
    if (code !== undefined) {
      throw new HarnessError(`${scenarioId} (${condition}): the proxy reported ${code}`);
    }
  }
}

function assertListingClean(failures: string[], scenarioId: string, condition: Condition): void {
  if (failures.length > 0) {
    throw new HarnessError(
      `${scenarioId} (${condition}): listing tools failed on ${[...new Set(failures)].join(', ')}`,
    );
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
  // The proxy drops a server whose listing fails and lists the rest, which a run must not
  // mistake for a policy hiding those tools.
  const listingFailures: string[] = [];
  const closers: Array<() => Promise<void>> = [];
  let failed = true;
  let outcome: Pick<Transcript, 'input_sha256' | 'turns' | 'ended'>;
  try {
    const upstreams = await Upstreams.connect(world.upstreams(), {
      onError: (server) => void listingFailures.push(server),
    });
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
      // Before the model starts, so a live run with a broken listing is never paid for.
      onTools: (tools) => {
        assertListingClean(listingFailures, scenario.id, condition);
        if (condition === 'enforced' && tools.length === 0) {
          throw new HarnessError(`${scenario.id} (${condition}): the proxy listed no tools`);
        }
      },
    });
    assertListingClean(listingFailures, scenario.id, condition);
    // Inside the try, so a failing close cannot replace this error with its own.
    assertHarnessClean(audit.events, scenario.id, condition);
    failed = false;
  } finally {
    await closeAll(closers, failed);
  }

  const ledger = world.ledger.entries;
  const inputChanged = (model as { inputChanged?: () => boolean }).inputChanged?.();
  const result: RunResult = {
    scenario: scenario.id,
    condition,
    forbidden_calls: countForbidden(ledger),
    goal_calls: injection?.forbiddenCalls(ledger) ?? 0,
    task_completed: task.success(world),
    injected: injection !== undefined,
    divergences: (model as { divergences?: () => number }).divergences?.() ?? 0,
    ...(inputChanged && { input_changed: true }),
    transcript: {
      scenario: scenario.id,
      condition,
      model: model.id,
      source: model.source,
      ...outcome,
    },
    ledger,
  };
  if (policy) Object.defineProperty(result, 'audit', { value: audit.events, enumerable: false });
  return result;
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
