// The migration runner (ADR 0009), with made-up chains: the real chain is
// empty until SAVE_SCHEMA_VERSION first goes up.

import { SAVE_SCHEMA_VERSION, type SaveMigration } from "@eov/contracts";
import { describe, expect, it } from "vitest";
import { migrateSave, SAVE_MIGRATIONS } from "../src/index.ts";

const renameCash: SaveMigration = {
  fromVersion: 1,
  toVersion: 2,
  migrate: ({ money, ...rest }) => ({ ...rest, cash: money }),
};
const addFlag: SaveMigration = {
  fromVersion: 2,
  toVersion: 3,
  migrate: (save) => ({ ...save, flag: false }),
};

describe("migrateSave", () => {
  it("has one n → n + 1 step for every version below the current one", () => {
    expect(SAVE_MIGRATIONS.map((m) => [m.fromVersion, m.toVersion])).toEqual(
      Array.from({ length: SAVE_SCHEMA_VERSION - 1 }, (_, i) => [i + 1, i + 2]),
    );
  });

  it("is the identity at the current version", () => {
    const save = { format: "x", schemaVersion: SAVE_SCHEMA_VERSION };
    expect(migrateSave(save, SAVE_SCHEMA_VERSION)).toEqual({ ok: true, save });
  });

  it("runs every step in order and stamps each step's version", () => {
    const result = migrateSave({ schemaVersion: 1, money: 5 }, 1, [addFlag, renameCash], 3);
    expect(result).toEqual({ ok: true, save: { schemaVersion: 3, cash: 5, flag: false } });
  });

  it("doesn't touch its input", () => {
    const input = Object.freeze({ schemaVersion: 1, money: 5 });
    migrateSave(input, 1, [renameCash, addFlag], 3);
    expect(input).toEqual({ schemaVersion: 1, money: 5 });
  });

  it("reports a missing step", () => {
    expect(migrateSave({ schemaVersion: 1 }, 1, [renameCash], 3)).toEqual({ ok: false, error: { code: "MISSING_MIGRATION", fromVersion: 2 } });
    expect(migrateSave({ schemaVersion: 1 }, 1, [], 2)).toEqual({ ok: false, error: { code: "MISSING_MIGRATION", fromVersion: 1 } });
    // A step that skips a version isn't the n → n + 1 step.
    const skip: SaveMigration = { fromVersion: 1, toVersion: 3, migrate: (s) => s };
    expect(migrateSave({ schemaVersion: 1 }, 1, [skip], 3)).toEqual({ ok: false, error: { code: "MISSING_MIGRATION", fromVersion: 1 } });
  });

  it("reports a step that throws or returns something that isn't an object", () => {
    const throws: SaveMigration = {
      fromVersion: 1,
      toVersion: 2,
      migrate: () => {
        throw new Error("no money field");
      },
    };
    expect(migrateSave({}, 1, [throws], 2)).toEqual({
      ok: false,
      error: { code: "MIGRATION_FAILED", fromVersion: 1, toVersion: 2, message: "no money field" },
    });
    const nothing: SaveMigration = { fromVersion: 1, toVersion: 2, migrate: () => null as unknown as Record<string, unknown> };
    expect(migrateSave({}, 1, [nothing], 2)).toMatchObject({ ok: false, error: { code: "MIGRATION_FAILED", fromVersion: 1, toVersion: 2 } });
  });
});
