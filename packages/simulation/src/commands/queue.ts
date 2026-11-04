// The command queue (ADR 0004): envelopes waiting for a future tick, kept in
// (scheduledTick, sequence) order in `state.queuedCommands`.

import type { CommandEnvelope, GameState, Tick } from "@eov/contracts";
import { allocateId } from "../kernel/ids.ts";

export function compareEnvelopes(
  a: Pick<CommandEnvelope, "scheduledTick" | "sequence">,
  b: Pick<CommandEnvelope, "scheduledTick" | "sequence">,
): number {
  return a.scheduledTick - b.scheduledTick || a.sequence - b.sequence;
}

/** Assigns a command its ID and sequence from the state counters (ADR 0004). */
export function assignCommandIdentity(state: GameState): {
  readonly id: CommandEnvelope["id"];
  readonly sequence: number;
  readonly state: GameState;
} {
  const minted = allocateId(state, "Command");
  const sequence = minted.state.counters.nextCommandSequence;
  return {
    id: minted.id,
    sequence,
    state: { ...minted.state, counters: { ...minted.state.counters, nextCommandSequence: sequence + 1 } },
  };
}

export function enqueue(state: GameState, envelope: CommandEnvelope): GameState {
  return { ...state, queuedCommands: [...state.queuedCommands, envelope].sort(compareEnvelopes) };
}

/**
 * Removes and returns the first queued envelope ordered strictly before `limit`
 * in (scheduledTick, sequence) order, or null. Pass `sequence: Infinity` to take
 * everything due on or before `limit.scheduledTick`.
 */
export function shiftDue(
  state: GameState,
  limit: { readonly scheduledTick: Tick; readonly sequence: number },
): { readonly envelope: CommandEnvelope; readonly state: GameState } | null {
  const first = state.queuedCommands[0];
  if (!first || compareEnvelopes(first, limit) >= 0) return null;
  return { envelope: first, state: { ...state, queuedCommands: state.queuedCommands.slice(1) } };
}
