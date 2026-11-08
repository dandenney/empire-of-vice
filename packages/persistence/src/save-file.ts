// The SaveFile format (ADR 0008, 0009).
//
// A SaveFile wraps the simulation's SaveGame with app metadata and the state
// hash. Loading either succeeds completely or returns a typed SaveLoadError,
// never a half-checked save:
//
//   1. parse the JSON, read the header (format, schemaVersion): NOT_A_SAVE,
//      NEWER_VERSION;
//   2. an older version: check the hash of the state as written (the file's
//      integrity), then run the migration chain: HASH_MISMATCH,
//      MISSING_MIGRATION, MIGRATION_FAILED;
//   3. validate against `saveFileSchema`: INVALID, with the schema issues;
//   4. a current version: recompute and compare the state hash: HASH_MISMATCH;
//   5. if the caller says which scenario it plays, a save for another one is
//      INVALID (the simulation can't resume it).
//
// `gameDataVersion` doesn't block loading (ADR 0009): a save made with other
// game-data loads with the current numbers, and the result says so
// (`gameDataChanged`), so the UI can tell the player.
//
// Hashing comes from `@eov/simulation/hash` (the kernel's algorithm, ADR 0008),
// not the simulation root, so the UI bundle doesn't pull in the simulation and
// game-data through persistence.

import {
  formatIssues,
  SAVE_SCHEMA_VERSION,
  saveFileSchema,
  saveHeaderSchema,
  type GameState,
  type SaveFile,
  type SaveGame,
  type SaveLoadError,
  type SaveMeta,
  type SaveMigration,
} from "@eov/contracts";
import { hashState } from "@eov/simulation/hash";
import { migrateSave, SAVE_MIGRATIONS } from "./migrations.ts";

export type SaveLoadResult =
  | {
      readonly ok: true;
      readonly file: SaveFile;
      /** The schema version the save was written at, if it was migrated; otherwise null. */
      readonly migratedFrom: number | null;
      /** The save was made with other game-data than `LoadOptions.gameDataVersion` (ADR 0009: it still loads). */
      readonly gameDataChanged: boolean;
    }
  | { readonly ok: false; readonly error: SaveLoadError };

export interface LoadOptions {
  /** The scenario this build plays. A save for any other scenario is INVALID. */
  readonly scenarioId?: string;
  /** This build's game-data version, to report `gameDataChanged`. */
  readonly gameDataVersion?: string;
  /** The migration chain. Tests pass their own; the default is SAVE_MIGRATIONS. */
  readonly migrations?: readonly SaveMigration[];
}

/** Wraps a SaveGame for storage, hashing its state with the kernel's algorithm. */
export function createSaveFile(save: SaveGame, meta: SaveMeta): SaveFile {
  return { save, meta, stateHash: hashState(save.state) };
}

export function serializeSaveFile(file: SaveFile): string {
  return JSON.stringify(file);
}

export function parseSaveFile(text: string, options: LoadOptions = {}): SaveLoadResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: { code: "NOT_A_SAVE" } };
  }
  if (!isRecord(raw)) return { ok: false, error: { code: "NOT_A_SAVE" } };
  const header = saveHeaderSchema.safeParse(raw["save"]);
  if (!header.success) return { ok: false, error: { code: "NOT_A_SAVE" } };
  const version = header.data.schemaVersion;
  if (version > SAVE_SCHEMA_VERSION) {
    return { ok: false, error: { code: "NEWER_VERSION", saveVersion: version, supportedVersion: SAVE_SCHEMA_VERSION } };
  }

  let candidate: unknown = raw;
  let migratedFrom: number | null = null;
  if (version < SAVE_SCHEMA_VERSION) {
    const expected = raw["stateHash"];
    const actual = rawStateHash(header.data["state"]);
    if (actual === null) return { ok: false, error: { code: "INVALID", issues: ["save.state: not a JSON object"] } };
    if (actual !== expected) return { ok: false, error: { code: "HASH_MISMATCH", expected: String(expected), actual } };
    const migrated = migrateSave(header.data, version, options.migrations ?? SAVE_MIGRATIONS);
    if (!migrated.ok) return { ok: false, error: migrated.error };
    // The state changed shape, so its hash is recomputed after validation.
    candidate = { ...raw, save: migrated.save };
    migratedFrom = version;
  }

  const parsed = saveFileSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, error: { code: "INVALID", issues: formatIssues(parsed.error) } };
  let file: SaveFile = parsed.data;
  if (migratedFrom === null) {
    const actual = hashState(file.save.state);
    if (actual !== file.stateHash) return { ok: false, error: { code: "HASH_MISMATCH", expected: file.stateHash, actual } };
  } else {
    file = createSaveFile(file.save, file.meta);
  }

  if (options.scenarioId !== undefined && file.save.scenarioId !== options.scenarioId) {
    return {
      ok: false,
      error: { code: "INVALID", issues: [`save.scenarioId: this save is for scenario ${file.save.scenarioId}, not ${options.scenarioId}`] },
    };
  }
  const gameDataChanged = options.gameDataVersion !== undefined && file.save.gameDataVersion !== options.gameDataVersion;
  return { ok: true, file, migratedFrom, gameDataChanged };
}

/**
 * The state hash of an old version's raw state, before migration, or null if
 * it isn't an object. The hash is over canonical JSON, so it needs no types:
 * parsed JSON is always canonicalizable.
 */
function rawStateHash(state: unknown): string | null {
  if (!isRecord(state)) return null;
  return hashState(state as unknown as GameState);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
