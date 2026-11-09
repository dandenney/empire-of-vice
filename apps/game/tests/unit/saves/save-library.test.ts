// The save/load UI's library (T06a, #135) against memory storage and a
// gateway that does what GatewayClient does (persistence + the simulation),
// without a worker.

import { SAVE_SCHEMA_VERSION, type SaveLoadError, type SaveMeta } from "@eov/contracts";
import { GAME_DATA_VERSION } from "@eov/game-data";
import { createSaveFile, MemoryStorageAdapter, readSave, serializeSaveFile, writeSave } from "@eov/persistence";
import { loadGame, newGame, type KernelSimulation } from "@eov/simulation";
import { describe, expect, it } from "vitest";
import { LOAD_ERROR_COPY, SAVES_COPY } from "../../../src/app/saves/copy.ts";
import { continueTarget, SaveLibrary, type SaveGateway } from "../../../src/app/saves/save-library.ts";
import { describeLoadError, describeLoadFailure, formatSavedAt, saveLabel } from "../../../src/app/saves/saves-view.ts";

/** GatewayClient.save / .load, with the simulation in-process. */
class FakeGateway implements SaveGateway {
  sim: KernelSimulation = newGame();
  loads = 0;
  failStart: string | null = null;
  constructor(private readonly storage: MemoryStorageAdapter) {}

  async save(slot: string, label: string): Promise<void> {
    const meta: SaveMeta = { slot, label, savedAt: `2026-11-08T12:00:0${slot.slice(-1)}.000Z`, appVersion: "test" };
    await writeSave(this.storage, this.sim, meta);
  }

  async load(slot: string) {
    this.loads++;
    const loaded = await readSave(this.storage, slot);
    if (!loaded.ok) return { ok: false as const, error: loaded.error };
    if (this.failStart) throw new Error(this.failStart);
    this.sim = loadGame(loaded.file.save);
    return { ok: true as const };
  }
}

function setup() {
  const storage = new MemoryStorageAdapter();
  const gateway = new FakeGateway(storage);
  return { storage, gateway, library: new SaveLibrary(storage, gateway) };
}

describe("SaveLibrary", () => {
  it("saves to a new slot, or to the slot it's given", async () => {
    const { library, storage } = setup();
    expect(await library.save("First", null)).toBe("slot-1");
    expect(await library.save("Second", null)).toBe("slot-2");
    expect(await library.save("First again", "slot-1")).toBe("slot-1");
    expect(await storage.list()).toEqual(["slot-1", "slot-2"]);
    expect((await library.list()).map((s) => [s.slot, s.meta.label])).toEqual([
      ["slot-2", "Second"],
      ["slot-1", "First again"],
    ]);
  });

  it("loads a save, and save → load → continue matches the uninterrupted run", async () => {
    const { library, gateway } = setup();
    gateway.sim.advance(500);
    await library.save("Morning", null);
    const uninterrupted = gateway.sim;
    gateway.sim = newGame();

    const attempt = await library.load("slot-1");
    expect(attempt).toEqual({ ok: true, slot: "slot-1", label: "Morning", otherGameData: null });
    expect(gateway.sim.stateHash()).toBe(uninterrupted.stateHash());
    uninterrupted.advance(1_000);
    gateway.sim.advance(1_000);
    expect(gateway.sim.stateHash()).toBe(uninterrupted.stateHash());
  });

  it("refuses a bad save before the worker sees it, and leaves the running game alone", async () => {
    const { library, gateway, storage } = setup();
    gateway.sim.advance(100);
    const before = gateway.sim.stateHash();
    await storage.write("slot-1", "{ not json");
    expect(await library.load("slot-1")).toEqual({ ok: false, slot: "slot-1", failure: { kind: "save", error: { code: "NOT_A_SAVE" } } });

    const file = createSaveFile(newGame().serialize(), { slot: "slot-2", label: "Elsewhere", savedAt: "2026-11-08T12:00:00.000Z", appVersion: "test" });
    const otherScenario = { ...file.save, scenarioId: "another", state: { ...file.save.state, scenarioId: "another" } };
    await storage.write("slot-2", serializeSaveFile(createSaveFile(otherScenario as typeof file.save, file.meta)));
    const refused = await library.load("slot-2");
    expect(refused).toMatchObject({ ok: false, failure: { kind: "save", error: { code: "INVALID" } } });

    expect(gateway.loads).toBe(0);
    expect(gateway.sim.stateHash()).toBe(before);
  });

  it("reports a save the worker couldn't resume", async () => {
    const { library, gateway } = setup();
    await library.save("Morning", null);
    gateway.failStart = "boom";
    expect(await library.load("slot-1")).toEqual({ ok: false, slot: "slot-1", failure: { kind: "start", message: "boom" } });
  });

  it("loads a save made with other game-data, and says so (ADR 0009)", async () => {
    const { library, storage } = setup();
    const file = createSaveFile({ ...newGame().serialize(), gameDataVersion: "0.1.0-old" }, { slot: "slot-1", label: "Old", savedAt: "2026-11-08T12:00:00.000Z", appVersion: "test" });
    await storage.write("slot-1", serializeSaveFile(file));
    expect((await library.list())[0]).toMatchObject({ ok: true, gameDataChanged: true, gameDataVersion: "0.1.0-old" });
    expect(await library.load("slot-1")).toEqual({ ok: true, slot: "slot-1", label: "Old", otherGameData: "0.1.0-old" });
    expect(GAME_DATA_VERSION).not.toBe("0.1.0-old");
  });

  it("deletes a save", async () => {
    const { library } = setup();
    await library.save("Morning", null);
    await library.remove("slot-1");
    expect(await library.list()).toEqual([]);
  });
});

describe("continueTarget", () => {
  const ok = (slot: string) => ({ slot, ok: true as const, meta: { slot, label: slot, savedAt: "", appVersion: "" }, gameDataVersion: "v", gameDataChanged: false });
  const bad = (slot: string) => ({ slot, ok: false as const, meta: {}, error: { code: "NOT_A_SAVE" as const } });

  it("is the newest save that loads, else the newest, else none", () => {
    expect(continueTarget([bad("a"), ok("b"), ok("c")])?.slot).toBe("b");
    expect(continueTarget([bad("a"), bad("b")])?.slot).toBe("a");
    expect(continueTarget([])).toBeNull();
  });
});

describe("saves view", () => {
  const errors: readonly SaveLoadError[] = [
    { code: "NOT_A_SAVE" },
    { code: "NEWER_VERSION", saveVersion: SAVE_SCHEMA_VERSION + 1, supportedVersion: SAVE_SCHEMA_VERSION },
    { code: "MISSING_MIGRATION", fromVersion: 1 },
    { code: "MIGRATION_FAILED", fromVersion: 1, toVersion: 2, message: "no money field" },
    { code: "INVALID", issues: ["save.state.tick: Too small", "meta.savedAt: Invalid"] },
    { code: "HASH_MISMATCH", expected: "fnv1a64:1", actual: "fnv1a64:2" },
  ];

  it("describes every SaveLoadError in words, with its details", () => {
    expect(Object.keys(LOAD_ERROR_COPY).sort()).toEqual(errors.map((e) => e.code).sort());
    for (const error of errors) {
      const text = describeLoadError(error);
      expect(text, error.code).not.toContain(error.code);
      expect(text.length).toBeGreaterThan(10);
    }
    expect(describeLoadError(errors[1]!)).toContain(String(SAVE_SCHEMA_VERSION + 1));
    expect(describeLoadError(errors[3]!)).toContain("no money field");
    expect(describeLoadFailure({ kind: "save", error: errors[4]! }).details).toEqual(["INVALID", "save.state.tick: Too small", "meta.savedAt: Invalid"]);
    expect(describeLoadFailure({ kind: "save", error: errors[5]! }).details).toEqual(["HASH_MISMATCH"]);
    expect(describeLoadFailure({ kind: "start", message: "boom" })).toEqual({ reason: SAVES_COPY.startFailed("boom"), details: [] });
  });

  it("formats when a save was made, and names a save without a label", () => {
    const format = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
    expect(formatSavedAt("2026-11-08T15:04:00.000Z", format)).toBe("Nov 8, 2026, 3:04 PM");
    expect(formatSavedAt("not a date", format)).toBeNull();
    expect(formatSavedAt(undefined, format)).toBeNull();
    expect(saveLabel({ meta: {} })).toBe(SAVES_COPY.untitled);
    expect(saveLabel({ meta: { label: "Noon" } })).toBe("Noon");
  });
});
