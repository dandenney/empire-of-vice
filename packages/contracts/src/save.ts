// Save format and migration contract. See docs/decisions/0009-save-migration-policy.md.
//
// Two layers:
// - SaveGame: what `Simulation.serialize()` returns. Pure game data, no wall-clock
//   time, so the simulation stays deterministic.
// - SaveFile: what persistence writes. Wraps a SaveGame with metadata the app adds
//   (real save time, slot label) and the state hash used to check integrity.

import type { ScenarioId } from "./ids.ts";
import type { GameState } from "./state.ts";

/** Bump on any change to SaveGame or GameState, and add a migration (ADR 0009). */
export const SAVE_SCHEMA_VERSION = 7;

export const SAVE_FORMAT = "empire-of-vice/save";

export interface SaveGame {
  readonly format: typeof SAVE_FORMAT;
  readonly schemaVersion: typeof SAVE_SCHEMA_VERSION;
  readonly scenarioId: ScenarioId;
  /**
   * The game-data version the game was played with. Recorded for diagnostics.
   * Loading with different game-data is allowed (ADR 0009).
   */
  readonly gameDataVersion: string;
  /**
   * The authoritative state, including tick, RNG state, ID counters, queued
   * commands, scheduled world events, and the event journal.
   */
  readonly state: GameState;
}

export interface SaveFile {
  readonly save: SaveGame;
  readonly meta: SaveMeta;
  /** Hash of the canonical serialization of `save.state` (algorithm defined in T01). Checked on load. */
  readonly stateHash: string;
}

/** Written by the app, never read by the simulation. */
export interface SaveMeta {
  readonly slot: string;
  readonly label: string;
  /** Real-world save time, ISO 8601. */
  readonly savedAt: string;
  /** App build that wrote the file, for bug reports. */
  readonly appVersion: string;
}

/**
 * One step in the migration chain. Works on raw JSON, because the old types no
 * longer exist in code. The result is validated against the next version's schema.
 */
export interface SaveMigration {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly migrate: (save: Readonly<Record<string, unknown>>) => Record<string, unknown>;
}

/** Why a save couldn't be loaded. Loading never partially succeeds. */
export type SaveLoadError =
  | { readonly code: "NOT_A_SAVE" }
  | { readonly code: "NEWER_VERSION"; readonly saveVersion: number; readonly supportedVersion: number }
  | { readonly code: "MISSING_MIGRATION"; readonly fromVersion: number }
  | { readonly code: "MIGRATION_FAILED"; readonly fromVersion: number; readonly toVersion: number; readonly message: string }
  | { readonly code: "INVALID"; readonly issues: readonly string[] }
  | { readonly code: "HASH_MISMATCH"; readonly expected: string; readonly actual: string };
