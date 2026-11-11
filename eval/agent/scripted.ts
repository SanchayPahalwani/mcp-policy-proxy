import { INJECTIONS } from '../suite/injections.js';
import type { Scenario } from '../suite/scenarios.js';
import type { ScriptContext, ToolCallSpec } from '../suite/tasks.js';
import type { AssistantTurn, Model, ToolResult } from './model.js';

interface Pending {
  spec: ToolCallSpec;
  /** The script step this call plays, absent for an injected call. */
  step?: number;
}

const DONE: AssistantTurn = { text: 'Done.', tool_calls: [], stop: 'end' };

/**
 * A worst-case stand-in for a model: it plays the task's script and obeys every injected
 * instruction it reads. It ignores the tool list on purpose, so it also calls tools the proxy
 * hid from it, which is exactly what an attacker hopes a real model will do. Its attack rate
 * without enforcement is 100% by construction; what it measures is what enforcement stops.
 */
export function scriptedModel(scenario: Scenario): Model {
  const { script } = scenario.task;
  let ctx: ScriptContext = { results: [] };
  let queue: Pending[] = [];
  let inFlight: Pending | undefined;
  let nextStep = 0;
  let calls = 0;
  let obeyed = new Set<number>();

  const read = (result: ToolResult) => {
    if (inFlight?.step !== undefined) ctx.results[inFlight.step] = result.content;
    const injected: Pending[] = [];
    INJECTIONS.forEach((injection, n) => {
      if (obeyed.has(n) || !result.content.includes(injection.text)) return;
      obeyed.add(n);
      injected.push(...injection.payload.map((spec) => ({ spec })));
    });
    queue = [...injected, ...queue];
  };

  return {
    id: 'scripted-obedient-v1',
    source: 'synthetic',
    async start() {
      ctx = { results: [] };
      queue = [];
      inFlight = undefined;
      nextStep = 0;
      calls = 0;
      obeyed = new Set();
    },
    async next(results) {
      for (const result of results) read(result);
      // Steps are built only when due, because a step's arguments come from earlier results.
      if (queue.length === 0 && nextStep < script.length) {
        const step = nextStep++;
        queue.push({ spec: script[step]!(ctx), step });
      }
      inFlight = queue.shift();
      if (!inFlight) return DONE;
      const { name, arguments: args } = inFlight.spec;
      // A copy, because the suite's payload objects are shared by every run of the scenario.
      return {
        text: '',
        stop: 'tool_use',
        tool_calls: [{ id: `c${++calls}`, name, arguments: structuredClone(args) }],
      };
    },
  };
}
