import { runScenario, type RunResult } from '../run.js';
import { SCENARIOS } from '../suite/scenarios.js';
import type { Transcript } from './loop.js';
import type { AssistantTurn, Model, ToolResult } from './model.js';

const END: AssistantTurn = { text: '', tool_calls: [], stop: 'end' };

function differing(actual: ToolResult[], recorded: ToolResult[]): number {
  let count = Math.abs(actual.length - recorded.length);
  for (let i = 0; i < Math.min(actual.length, recorded.length); i++) {
    const a = actual[i]!;
    const r = recorded[i]!;
    if (a.content !== r.content || a.is_error !== r.is_error) count++;
  }
  return count;
}

/**
 * Plays back a transcript's assistant turns while the calls run for real. A divergence is a
 * result that differs from the recorded one: the recorded model never saw it, so whatever it
 * did next is no longer evidence of how it would have reacted.
 */
export function replayModel(transcript: Transcript): Model & { divergences(): number } {
  let played = 0;
  let divergences = 0;
  return {
    id: transcript.model,
    source: transcript.source,
    async start() {
      played = 0;
      divergences = 0;
    },
    async next(results) {
      divergences += differing(results, played === 0 ? [] : transcript.turns[played - 1]!.results);
      const turn = transcript.turns[played];
      if (!turn) {
        divergences++;
        return structuredClone(END);
      }
      played++;
      // A copy, so the run's own transcript never shares objects with the one it replays.
      return structuredClone(turn.assistant);
    },
    divergences() {
      // A run that stopped before playing every recorded turn did not reproduce the recording.
      return divergences + (played < transcript.turns.length ? 1 : 0);
    },
  };
}

/** Replays a transcript under its own condition, with the clock set from its recorded turns. */
export async function replayRun(
  transcript: Transcript,
  opts: { policyPath?: string } = {},
): Promise<RunResult> {
  const scenario = SCENARIOS.find((s) => s.id === transcript.scenario);
  if (!scenario) throw new Error(`transcript names unknown scenario ${transcript.scenario}`);
  return runScenario(scenario, transcript.condition, () => replayModel(transcript), {
    ...opts,
    turnTimes: transcript.turns.map((t) => t.ts),
  });
}
