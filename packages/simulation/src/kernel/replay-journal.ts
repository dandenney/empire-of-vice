// Replaying a command journal (ADR 0004 amendment, replay procedure, issue #66).
// One implementation for every caller: the economy lab's replay check (T07b),
// the save/load hash-parity tests (T06a, issue #135), and anything else that
// rebuilds a run from its start state and its log.
//
// To replay a run that ended at tick E on a fresh simulation from the same start
// state:
//   1. place the envelopes with scheduledTick ≤ E, in log order;
//   2. advance to E;
//   3. then place the rest, in log order.
//
// Envelopes due at E + 1 can only be commands applied on the run's last tick
// (immediate dispatches, and queued commands such a dispatch drained ahead of
// itself). Placed after the advance, each is due on the next tick, so it applies
// at once, as in the original run; placed before, it would stay queued and never
// apply. Envelopes still queued for later ticks are queued again, unchanged.

import type { CommandEnvelope, GameState, Tick } from "@eov/contracts";
import { KernelError, type ReplayResult } from "./simulation.ts";

/** What replaying needs from a simulation: `KernelSimulation` has it. */
export interface Replayable {
  readonly state: GameState;
  replay(envelope: CommandEnvelope): ReplayResult;
  advance(ticks: number): void;
}

/**
 * A run's whole journal, as `replayJournal` takes it: the applied (and
 * apply-time rejected) commands, then the ones still queued.
 */
export function journalOf(state: GameState): readonly CommandEnvelope[] {
  return [...state.commandLog, ...state.queuedCommands];
}

/**
 * Replays `log` onto `target` (a fresh simulation from the run's start state)
 * and leaves it at `endTick`, the tick the original run stopped at. Returns each
 * envelope's replay result, in the order placed. Throws a KernelError if
 * `target` is already past `endTick`.
 */
export function replayJournal(target: Replayable, log: readonly CommandEnvelope[], endTick: Tick): readonly ReplayResult[] {
  if (target.state.tick > endTick) {
    throw new KernelError(`replayJournal: the target is at tick ${target.state.tick}, past the end tick ${endTick}`);
  }
  const results: ReplayResult[] = [];
  for (const envelope of log) if (envelope.scheduledTick <= endTick) results.push(target.replay(envelope));
  target.advance(endTick - target.state.tick);
  for (const envelope of log) if (envelope.scheduledTick > endTick) results.push(target.replay(envelope));
  return results;
}
