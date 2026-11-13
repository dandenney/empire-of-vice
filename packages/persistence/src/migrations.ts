// The save migration chain (ADR 0009).
//
// SAVE_SCHEMA_VERSION goes up by one for any change to SaveGame or GameState,
// and every bump adds a SaveMigration from n to n + 1 to SAVE_MIGRATIONS, with
// a fixture save at the old version under fixtures/ (test/fixtures.test.ts
// loads every one). Migrations work on raw JSON, are pure, and never read
// game-data. The result is validated against the current schema by the caller
// (save-file.ts), never trusted.
//
// Each step writes its new fields as frozen literals, never from current
// contract constants, so a later change to those constants can't change what an
// old save migrates to.

import { SAVE_SCHEMA_VERSION, type SaveLoadError, type SaveMigration } from "@eov/contracts";

/**
 * v1 → v2 (K1, ADR 0021 decision 10): `GameState.knowledge`, empty. Records are
 * copies of world projections and migrations never read game-data, so nothing
 * can be rebuilt here. The live view shows the founder's place at once, and the
 * rest of the world starts out unknown. With no pending books, the whole M001
 * ledger counts as known, which fits: M001 players saw everything.
 */
export const migrateV1ToV2: SaveMigration = {
  fromVersion: 1,
  toVersion: 2,
  migrate: (save) => {
    const state = save["state"];
    if (typeof state !== "object" || state === null || Array.isArray(state)) throw new Error("save.state is not an object");
    if ("knowledge" in state) throw new Error("save.state already has knowledge");
    return {
      ...save,
      state: {
        ...state,
        knowledge: { records: [], pendingNews: [], pendingBooks: [], activity: [], lastCatchUp: null },
      },
    };
  },
};

/**
 * The M001 scenario's one start location, frozen (ADR 0023 decision 10). M001's
 * founder and its one truck both live at Hollow Creek. A literal, not a
 * game-data read, so later edits to game-data can't change what a v2 save
 * becomes.
 */
const M001_SCENARIO_ID = "first-shipment";
const M001_START_LOCATION_ID = "hollow-creek";

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * v2 → v3 (P1, ADR 0023 decision 10): `GameState.founder` and
 * `VehicleState.parkedAt`, from the save's own fields only:
 * - only an M001 save (`state.scenarioId` "first-shipment") can migrate; any
 *   other scenario fails as MIGRATION_FAILED;
 * - the founder is PRESENT at Hollow Creek, not busy, awake since the save's tick;
 * - an idle truck (`trip: null`) is parked at Hollow Creek; a truck with a trip
 *   is on the road (`parkedAt: null`).
 * M001 saves load into the M001 scenario (`founderRules: false`), so the founder
 * just sits at Hollow Creek and the game plays exactly as before.
 * (`DeliveryState.driver` and `DISPATCH_DELIVERY.driver` are O1a's step.)
 */
export const migrateV2ToV3: SaveMigration = {
  fromVersion: 2,
  toVersion: 3,
  migrate: (save) => {
    const state = save["state"];
    if (!isObject(state)) throw new Error("save.state is not an object");
    if ("founder" in state) throw new Error("save.state already has founder");
    if (state["scenarioId"] !== M001_SCENARIO_ID) {
      throw new Error(`save.state.scenarioId ${JSON.stringify(state["scenarioId"])} has no frozen founder placement; only ${M001_SCENARIO_ID} saves migrate`);
    }
    const tick = state["tick"];
    if (typeof tick !== "number" || !Number.isSafeInteger(tick) || tick < 0) throw new Error("save.state.tick is not a tick");
    const vehicles = state["vehicles"];
    if (!Array.isArray(vehicles)) throw new Error("save.state.vehicles is not an array");
    return {
      ...save,
      state: {
        ...state,
        vehicles: vehicles.map((vehicle: unknown, i) => {
          if (!isObject(vehicle)) throw new Error(`save.state.vehicles[${i}] is not an object`);
          if ("parkedAt" in vehicle) throw new Error(`save.state.vehicles[${i}] already has parkedAt`);
          const { id, ...rest } = vehicle;
          // Key order as in the contract: id, parkedAt, trip (canonical JSON sorts keys anyway).
          return { id, parkedAt: vehicle["trip"] === null ? M001_START_LOCATION_ID : null, ...rest };
        }),
        founder: {
          whereabouts: { kind: "PRESENT", locationId: M001_START_LOCATION_ID, busy: null },
          awakeSince: tick,
        },
      },
    };
  },
};

/** Every migration, oldest first. Add one per SAVE_SCHEMA_VERSION bump. */
export const SAVE_MIGRATIONS: readonly SaveMigration[] = [migrateV1ToV2, migrateV2ToV3];

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
