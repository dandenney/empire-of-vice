// The save migration chain (ADR 0009).
//
// SAVE_SCHEMA_VERSION goes up by one for any change to SaveGame or GameState,
// and every bump adds a SaveMigration from n to n + 1 to SAVE_MIGRATIONS, with
// a fixture save at the old version under fixtures/ (test/fixtures.test.ts
// loads every one). Migrations work on raw JSON, are pure, and never read
// game-data. The result is validated against the current schema by the caller
// (save-file.ts), never trusted.
//
// Version 1 is the first version, so the chain is empty.

import { SAVE_SCHEMA_VERSION, type SaveLoadError, type SaveMigration } from "@eov/contracts";

/** Every migration, oldest first. Add one per SAVE_SCHEMA_VERSION bump. */
export const SAVE_MIGRATIONS: readonly SaveMigration[] = [];

export type MigrationResult =
  | { readonly ok: true; readonly save: Record<string, unknown> }
  | { readonly ok: false; readonly error: Extract<SaveLoadError, { code: "MISSING_MIGRATION" | "MIGRATION_FAILED" }> };

/**
 * Runs `save` (raw JSON at `fromVersion`) through the chain up to `toVersion`.
 * Each step must be the chain's `n → n + 1` migration; a gap is
 * MISSING_MIGRATION, a step that throws or returns something that isn't an
 * object is MIGRATION_FAILED. Each step's result gets the step's `toVersion`
 * as its `schemaVersion`, so a migration can't forget to bump it.
 */
export function migrateSave(
  save: Readonly<Record<string, unknown>>,
  fromVersion: number,
  chain: readonly SaveMigration[] = SAVE_MIGRATIONS,
  toVersion: number = SAVE_SCHEMA_VERSION,
): MigrationResult {
  let current: Record<string, unknown> = { ...save };
  for (let version = fromVersion; version < toVersion; version++) {
    const step = chain.find((m) => m.fromVersion === version);
    if (!step || step.toVersion !== version + 1) return { ok: false, error: { code: "MISSING_MIGRATION", fromVersion: version } };
    let next: unknown;
    try {
      next = step.migrate(current);
    } catch (error) {
      return { ok: false, error: { code: "MIGRATION_FAILED", fromVersion: version, toVersion: version + 1, message: messageOf(error) } };
    }
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      return {
        ok: false,
        error: { code: "MIGRATION_FAILED", fromVersion: version, toVersion: version + 1, message: "The migration didn't return an object" },
      };
    }
    current = { ...(next as Record<string, unknown>), schemaVersion: version + 1 };
  }
  return { ok: true, save: current };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
