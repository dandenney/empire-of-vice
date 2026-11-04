// The simulation's public API: what the Web Worker gateway (S0b), the headless
// economy lab (T07a), and tests call. Architecture §4, GDD §11 "suggested engine API".
// Implemented in T01. Nothing here may depend on wall-clock time.

import type { CommandRequest, CommandResult } from "./commands.ts";
import type { GameEvent } from "./events.ts";
import type { SaveGame } from "./save.ts";
import type { GameSnapshot } from "./snapshot.ts";
import type { GameState } from "./state.ts";

export interface Simulation {
  /** Applies a command now, or queues it for a later tick (ADR 0004). Never partially applies. */
  dispatch(request: CommandRequest): CommandResult;
  /** Processes `ticks` ticks in SIM-001 order. The caller (scheduler or lab) decides how many. */
  advance(ticks: number): void;
  /** The read-only projection for the UI (ADR 0007). */
  snapshot(): GameSnapshot;
  /** Everything needed to resume exactly (ADR 0008). */
  serialize(): SaveGame;
  /** Hash of the canonical serialization of the current state. Same seed + same commands = same hash. */
  stateHash(): string;
  /**
   * Events emitted since the last call, oldest first. The worker publishes them
   * (immediately or batched per EVENT_IMPORTANCE); the lab uses them for full histories.
   */
  takeEvents(): readonly GameEvent[];
  /** The current state, read-only. For tests and the lab; the UI uses `snapshot()`. */
  readonly state: GameState;
}
