// The migration runner (ADR 0009), with made-up chains, and the real steps.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EMPTY_KNOWLEDGE, SAVE_SCHEMA_VERSION, type SaveMigration } from "@eov/contracts";
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

describe("v1 → v2: empty knowledge (K1, ADR 0021 decision 10)", () => {
  const v1 = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/save-v1.json", import.meta.url)), "utf8")) as {
    save: Record<string, unknown> & { state: Record<string, unknown> };
  };

  it("adds GameState.knowledge with no records, news, books, activity or catch-up, and changes nothing else", () => {
    const result = migrateSave(v1.save, 1, SAVE_MIGRATIONS, 2);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const { knowledge, ...rest } = result.save["state"] as Record<string, unknown>;
    expect(knowledge).toEqual({ records: [], pendingNews: [], pendingBooks: [], activity: [], lastCatchUp: null });
    expect(knowledge).toEqual(EMPTY_KNOWLEDGE);
    expect(rest).toEqual(v1.save.state);
    expect(result.save["schemaVersion"]).toBe(2);
    expect(v1.save.state).not.toHaveProperty("knowledge");
  });

  it("fails cleanly on a state that isn't an object or already has knowledge", () => {
    expect(migrateSave({ schemaVersion: 1, state: null }, 1, SAVE_MIGRATIONS, 2)).toMatchObject({
      ok: false,
      error: { code: "MIGRATION_FAILED", fromVersion: 1, toVersion: 2 },
    });
    expect(migrateSave({ schemaVersion: 1, state: { knowledge: {} } }, 1, SAVE_MIGRATIONS, 2)).toMatchObject({
      ok: false,
      error: { code: "MIGRATION_FAILED", message: "save.state already has knowledge" },
    });
  });
});

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
