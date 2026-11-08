// Replaying a command journal (ADR 0004 amendment, replay procedure, issue #66).
// One implementation for every caller: the economy lab's replay check (T07b),
// the save/load hash-parity tests (T06a, issue #135), and anything else that
// rebuilds a run from its start state and its journal.
//
// To replay a run that ended at tick E on a fresh simulation from the same start
// state:
//   1. place the applied envelopes (the command log) with scheduledTick ≤ E,
//      and every envelope still queued at E, in journal order;
//   2. advance to E;
//   3. then place the applied envelopes with scheduledTick > E, in log order.
//
// An applied envelope due after E can only be a command applied on the run's
// last tick (an immediate dispatch, or a queued command such a dispatch
// drained ahead of itself): its scheduledTick is E + 1. Placed after the
// advance, it's due on the next tick, so it applies at once, as in the
// original run; placed before, it would stay queued and never apply.
//
// A still-queued envelope can be due at E + 1 too (dispatched earlier for that
// tick), so the tick alone can't tell the two apart: which list an envelope
// came from does. Queued envelopes are placed before the advance, while the
// target is still behind E, so they're queued again, unchanged, and not
// applied. (One due at the start tick + 1 would apply at once, but a run
// can't leave one queued: dispatching it would have applied it.)
//
// ADR 0004's text says only applied commands can be due at E + 1; issue #135's
// property test found the still-queued case (a command scheduled for E + 1).

import type { CommandEnvelope, GameState, Tick } from "@eov/contracts";
import { KernelError, type ReplayResult } from "./simulation.ts";

/** What replaying needs from a simulation: `KernelSimulation` has it. */
export interface Replayable {
  readonly state: GameState;
  replay(envelope: CommandEnvelope): ReplayResult;
  advance(ticks: number): void;
}

/** A run's journal, as `replayJournal` takes it. */
export interface Journal {
  /** The applied (and apply-time rejected) commands: `GameState.commandLog`. */
  readonly applied: readonly CommandEnvelope[];
  /** The commands still queued when the run stopped: `GameState.queuedCommands`. */
  readonly queued: readonly CommandEnvelope[];
}

/** A run's whole journal, from its state. */
export function journalOf(state: GameState): Journal {
  return { applied: state.commandLog, queued: state.queuedCommands };
}

/**
 * Replays `journal` onto `target` (a fresh simulation from the run's start
 * state) and leaves it at `endTick`, the tick the original run stopped at.
 * Returns each envelope's replay result, in the order placed. Throws a
 * KernelError if `target` is already past `endTick`.
 */
export function replayJournal(target: Replayable, journal: Journal, endTick: Tick): readonly ReplayResult[] {
  if (target.state.tick > endTick) {
    throw new KernelError(`replayJournal: the target is at tick ${target.state.tick}, past the end tick ${endTick}`);
  }
  const results: ReplayResult[] = [];
  for (const envelope of journal.applied) if (envelope.scheduledTick <= endTick) results.push(target.replay(envelope));
  for (const envelope of journal.queued) results.push(target.replay(envelope));
  target.advance(endTick - target.state.tick);
  for (const envelope of journal.applied) if (envelope.scheduledTick > endTick) results.push(target.replay(envelope));
  return results;
}
