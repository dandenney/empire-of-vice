// The save/load UI's library (T06a, #135; T06f, #152) against memory storage and a
// gateway that does what GatewayClient does (persistence + the simulation),
// without a worker.

import { SAVE_SCHEMA_VERSION, type SaveLoadError } from "@eov/contracts";
import { GAME_DATA_VERSION } from "@eov/game-data";
import { createSaveFile, MemoryStorageAdapter, readSave, serializeSaveFile, writeSave, type StorageAdapter } from "@eov/persistence";
import { loadGame, newGame, type KernelSimulation } from "@eov/simulation";
import { describe, expect, it } from "vitest";
import { LOAD_ERROR_COPY, SAVES_COPY } from "../../../src/app/saves/copy.ts";
import { continueTarget, SaveLibrary, type SaveGateway } from "../../../src/app/saves/save-library.ts";
import { describeLoadError, describeLoadFailure, formatSavedAt, saveLabel } from "../../../src/app/saves/saves-view.ts";

/** GatewayClient.save / .load, with the simulation in-process. */
class FakeGateway implements SaveGateway {
  sim: KernelSimulation = newGame();
  loads = 0;
  saves = 0;
  failStart: string | null = null;
  failSerialize = false;
  constructor(private readonly storage: StorageAdapter) {}

  /** Each save a second after the last, so saved-at times differ. */
  async save(slot: string, label: string): Promise<void> {
    const savedAt = `2026-11-08T12:00:${String(++this.saves).padStart(2, "0")}.000Z`;
    const game = this.failSerialize ? { serialize: (): never => { throw new Error("worker gone"); } } : this.sim;
    await writeSave(this.storage, game, { slot, label, savedAt, appVersion: "test" });
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

/** Memory storage whose writes can be made to fail, as a full disk or an aborted transaction would. */
class FlakyStorage extends MemoryStorageAdapter {
  failWrites = false;
  override async write(slot: string, contents: string): Promise<void> {
    if (this.failWrites) throw new Error("QuotaExceededError");
    await super.write(slot, contents);
  }
}

function setup() {
  const storage = new FlakyStorage();
  const gateway = new FakeGateway(storage);
  return { storage, gateway, library: new SaveLibrary(storage, gateway) };
}

const DEFAULT = "1920-01-17 06:40";
const labels = async (library: SaveLibrary) => (await library.list()).map((s) => [s.slot, s.meta.label, s.meta.savedAt]);

describe("SaveLibrary", () => {
  it("quick save with no current slot: a new slot, named with the default (in-game date and time)", async () => {
    const { library } = setup();
    expect(await library.quickSave(null, DEFAULT)).toEqual({ slot: "slot-1", label: DEFAULT });
    expect(await library.quickSave(null, "1920-01-17 09:00")).toEqual({ slot: "slot-2", label: "1920-01-17 09:00" });
    expect(await labels(library)).toEqual([
      ["slot-2", "1920-01-17 09:00", "2026-11-08T12:00:02.000Z"],
      ["slot-1", DEFAULT, "2026-11-08T12:00:01.000Z"],
    ]);
  });

  it("quick save over the current slot: new contents and saved-at time, and the slot keeps its name (#145)", async () => {
    const { library, gateway, storage } = setup();
    await library.saveNew("Before the first batch");
    gateway.sim.advance(2 * 1_440);
    expect(await library.quickSave("slot-1", DEFAULT)).toEqual({ slot: "slot-1", label: "Before the first batch" });
    expect(await storage.list()).toEqual(["slot-1"]);
    expect(await labels(library)).toEqual([["slot-1", "Before the first batch", "2026-11-08T12:00:02.000Z"]]);
    const saved = await readSave(storage, "slot-1");
    expect(saved.ok && saved.file.save.state.tick).toBe(gateway.sim.serialize().state.tick);

    // A default-named slot keeps its default name too: it isn't renamed to the new game date.
    await library.quickSave(null, DEFAULT);
    expect(await library.quickSave("slot-2", "1920-01-19 06:40")).toEqual({ slot: "slot-2", label: DEFAULT });
  });

  it("quick save to a slot that has gone (deleted elsewhere) makes a new one with the default name", async () => {
    const { library } = setup();
    await library.saveNew("Morning");
    await library.remove("slot-1");
    expect(await library.quickSave("slot-1", DEFAULT)).toEqual({ slot: "slot-1", label: DEFAULT });
  });

  it("save as a new slot: always another slot, the name as given, and repeated names allowed", async () => {
    const { library, storage } = setup();
    await library.quickSave(null, DEFAULT);
    expect(await library.saveNew("Corn bought")).toEqual({ slot: "slot-2", label: "Corn bought" });
    expect(await library.saveNew("Corn bought")).toEqual({ slot: "slot-3", label: "Corn bought" });
    expect(await library.saveNew(DEFAULT)).toEqual({ slot: "slot-4", label: DEFAULT });
    expect(await storage.list()).toEqual(["slot-1", "slot-2", "slot-3", "slot-4"]);
    expect((await library.list()).map((s) => s.meta.label).sort()).toEqual(["Corn bought", "Corn bought", DEFAULT, DEFAULT].sort());
  });

  it("an overwrite that fails leaves the previous save intact and loadable", async () => {
    const { library, gateway, storage } = setup();
    gateway.sim.advance(300);
    await library.saveNew("Before the first batch");
    const before = await storage.read("slot-1");
    const savedHash = gateway.sim.stateHash();
    gateway.sim.advance(600);

    storage.failWrites = true;
    await expect(library.quickSave("slot-1", DEFAULT)).rejects.toThrow("QuotaExceededError");
    storage.failWrites = false;
    gateway.failSerialize = true;
    await expect(library.quickSave("slot-1", DEFAULT)).rejects.toThrow("worker gone");
    gateway.failSerialize = false;

    expect(await storage.read("slot-1")).toBe(before);
    expect(await labels(library)).toEqual([["slot-1", "Before the first batch", "2026-11-08T12:00:01.000Z"]]);
    expect(await library.load("slot-1")).toMatchObject({ ok: true, label: "Before the first batch" });
    expect(gateway.sim.stateHash()).toBe(savedHash);
  });

  it("loads a save, and save → load → continue matches the uninterrupted run", async () => {
    const { library, gateway } = setup();
    gateway.sim.advance(500);
    await library.saveNew("Morning");
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
    await library.saveNew("Morning");
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
    await library.saveNew("Morning");
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
    // The integrity failure is said plainly; the checksums are under Details.
    expect(describeLoadError(errors[5]!)).not.toContain("fnv1a64");
    expect(describeLoadFailure({ kind: "save", error: errors[5]! }).details).toEqual(["HASH_MISMATCH", "expected fnv1a64:1", "actual fnv1a64:2"]);
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
