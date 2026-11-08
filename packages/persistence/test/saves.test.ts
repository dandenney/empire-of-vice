import { SAVE_SCHEMA_VERSION, type SaveFile, type SaveMeta } from "@eov/contracts";
import { FIRST_SHIPMENT_SCENARIO, GAME_DATA_VERSION } from "@eov/game-data";
import { journalOf, loadGame, newGame, replayJournal } from "@eov/simulation";
import { hashState } from "@eov/simulation/hash";
import { describe, expect, it } from "vitest";
import {
  createSaveFile,
  listSaves,
  MemoryStorageAdapter,
  nextSlotId,
  parseSaveFile,
  readSave,
  serializeSaveFile,
  writeSave,
} from "../src/index.ts";
import { rawStateHash } from "../src/save-file.ts";
import { gameInProgress, meta } from "./game.ts";

const current = { scenarioId: FIRST_SHIPMENT_SCENARIO.id, gameDataVersion: GAME_DATA_VERSION };

function withSave(file: SaveFile, save: Record<string, unknown>): string {
  return JSON.stringify({ ...file, save: { ...file.save, ...save } });
}

describe("saving and loading", () => {
  it("saves through a storage adapter and loads back the same state", async () => {
    const storage = new MemoryStorageAdapter();
    const sim = gameInProgress();
    const written = await writeSave(storage, sim, meta);
    expect(written.stateHash).toBe(sim.stateHash());
    expect(await storage.list()).toEqual(["slot-1"]);

    const loaded = await readSave(storage, "slot-1", current);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.error));
    expect(loaded.file.meta).toEqual(meta);
    expect(loaded.file.stateHash).toBe(sim.stateHash());
    expect(loaded.migratedFrom).toBeNull();
    expect(loaded.gameDataChanged).toBe(false);
  });

  it("save → close → load → continue gives the same state hash as an uninterrupted run, and as a replay of the journal", async () => {
    const storage = new MemoryStorageAdapter();
    const sim = gameInProgress();
    expect(sim.state.queuedCommands.length).toBeGreaterThan(0);
    await writeSave(storage, sim, meta);

    // "Close": nothing survives but the stored text.
    const reopened = new MemoryStorageAdapter();
    await reopened.write("slot-1", (await storage.read("slot-1"))!);
    const loaded = await readSave(reopened, "slot-1", current);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.error));
    const resumed = loadGame(loaded.file.save);
    expect(resumed.stateHash()).toBe(sim.stateHash());

    sim.advance(2_000);
    resumed.advance(2_000);
    expect(resumed.stateHash()).toBe(sim.stateHash());
    // The queued purchase applied after the load, and the sale went through.
    expect(resumed.state.queuedCommands).toHaveLength(0);
    expect(resumed.state.ledger.transactions.map((t) => t.kind)).toContain("SALE");

    // The kernel's journal replay reaches the same state from a fresh game.
    const replayed = newGame();
    replayJournal(replayed, journalOf(sim.state), sim.state.tick);
    expect(replayed.stateHash()).toBe(sim.stateHash());
  });

  it("reports an empty slot as NOT_A_SAVE", async () => {
    expect(await readSave(new MemoryStorageAdapter(), "empty")).toEqual({ ok: false, error: { code: "NOT_A_SAVE" } });
  });
});

describe("rejecting bad saves with a typed reason", () => {
  const file = createSaveFile(gameInProgress().serialize(), meta);

  it("rejects text that isn't a save", () => {
    for (const text of ["not json", "null", "[]", "42", JSON.stringify({ save: { format: "something-else", schemaVersion: 1 } }), JSON.stringify({})]) {
      expect(parseSaveFile(text), text).toEqual({ ok: false, error: { code: "NOT_A_SAVE" } });
    }
    expect(parseSaveFile(withSave(file, { schemaVersion: 0 }))).toEqual({ ok: false, error: { code: "NOT_A_SAVE" } });
    expect(parseSaveFile(withSave(file, { schemaVersion: "1" }))).toEqual({ ok: false, error: { code: "NOT_A_SAVE" } });
  });

  it("rejects saves from a newer build (no downgrades)", () => {
    expect(parseSaveFile(withSave(file, { schemaVersion: SAVE_SCHEMA_VERSION + 1 }))).toEqual({
      ok: false,
      error: { code: "NEWER_VERSION", saveVersion: SAVE_SCHEMA_VERSION + 1, supportedVersion: SAVE_SCHEMA_VERSION },
    });
  });

  it("validates against saveFileSchema, listing the issues", () => {
    const broken = withSave(file, { state: { ...file.save.state, tick: -1 } });
    const result = parseSaveFile(broken);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === "INVALID") expect(result.error.issues.join("\n")).toContain("save.state.tick");
    else throw new Error(`expected INVALID, got ${JSON.stringify(result)}`);

    const badMeta = JSON.stringify({ ...file, meta: { ...file.meta, savedAt: "yesterday" } });
    expect(parseSaveFile(badMeta)).toMatchObject({ ok: false, error: { code: "INVALID" } });
  });

  it("checks the state hash", () => {
    const state = file.save.state;
    // Valid by the schema, but not the state that was hashed.
    const tampered = withSave(file, { state: { ...state, family: { ...state.family, reputation: 50 } } });
    expect(parseSaveFile(tampered)).toEqual({ ok: false, error: { code: "HASH_MISMATCH", expected: file.stateHash, actual: expect.any(String) } });
  });

  it("rejects a save for another scenario, which the simulation can't resume", () => {
    const other = withSave(file, { scenarioId: "another-scenario", state: { ...file.save.state, scenarioId: "another-scenario" } });
    const rehashed = JSON.parse(other) as SaveFile;
    const text = serializeSaveFile(createSaveFile(rehashed.save, rehashed.meta));
    expect(parseSaveFile(text).ok).toBe(true);
    const result = parseSaveFile(text, current);
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID", issues: [expect.stringContaining("save.scenarioId")] } });
  });

  it("checks gameDataVersion: other game-data still loads (ADR 0009) and is reported", () => {
    const older = serializeSaveFile({ ...file, save: { ...file.save, gameDataVersion: "0.1.0-old" } });
    const loaded = parseSaveFile(older, current);
    expect(loaded).toMatchObject({ ok: true, gameDataChanged: true });
    expect(parseSaveFile(serializeSaveFile(file), current)).toMatchObject({ ok: true, gameDataChanged: false });
    // Without a version to compare with, nothing is reported.
    expect(parseSaveFile(older)).toMatchObject({ ok: true, gameDataChanged: false });
  });
});

describe("listing saves", () => {
  it("lists every slot newest first, with the saves that won't load and why", async () => {
    const storage = new MemoryStorageAdapter();
    const sim = gameInProgress();
    const at = (slot: string, savedAt: string, label: string): SaveMeta => ({ ...meta, slot, savedAt, label });
    await writeSave(storage, sim, at("slot-1", "2026-11-04T10:00:00.000Z", "Morning"));
    await writeSave(storage, sim, at("slot-2", "2026-11-04T12:00:00.000Z", "Noon"));
    await storage.write("slot-3", JSON.stringify({ save: { format: "empire-of-vice/save", schemaVersion: 99 }, meta: { label: "Future", savedAt: "2026-11-04T11:00:00.000Z" } }));
    await storage.write("slot-4", "garbage");

    const summaries = await listSaves(storage, current);
    expect(summaries.map((s) => s.slot)).toEqual(["slot-2", "slot-3", "slot-1", "slot-4"]);
    expect(summaries[0]).toEqual({ slot: "slot-2", ok: true, meta: at("slot-2", "2026-11-04T12:00:00.000Z", "Noon"), gameDataVersion: GAME_DATA_VERSION, gameDataChanged: false });
    expect(summaries[1]).toEqual({
      slot: "slot-3",
      ok: false,
      meta: { label: "Future", savedAt: "2026-11-04T11:00:00.000Z" },
      error: { code: "NEWER_VERSION", saveVersion: 99, supportedVersion: SAVE_SCHEMA_VERSION },
    });
    expect(summaries[3]).toEqual({ slot: "slot-4", ok: false, meta: {}, error: { code: "NOT_A_SAVE" } });
  });

  it("picks the first free slot id", () => {
    expect(nextSlotId([])).toBe("slot-1");
    expect(nextSlotId(["slot-1", "slot-3"])).toBe("slot-2");
    expect(nextSlotId(["slot-2", "slot-1", "other"])).toBe("slot-3");
  });
});

describe("removing", () => {
  it("removes a slot", async () => {
    const storage = new MemoryStorageAdapter();
    await writeSave(storage, gameInProgress(), meta);
    await storage.remove("slot-1");
    expect(await storage.list()).toEqual([]);
    expect(await readSave(storage, "slot-1")).toEqual({ ok: false, error: { code: "NOT_A_SAVE" } });
  });
});

// An older version's state is hashed raw, before migration. parseSaveFile only
// takes that path once SAVE_SCHEMA_VERSION goes above 1, so the hash is tested
// directly: parsed JSON that can't be canonicalized is INVALID, not a throw.
describe("rawStateHash", () => {
  it("hashes a raw state as the kernel does", () => {
    const state = gameInProgress().serialize().state;
    expect(rawStateHash(JSON.parse(JSON.stringify(state)))).toEqual({ ok: true, hash: hashState(state) });
  });

  it("is INVALID for a state that isn't an object", () => {
    expect(rawStateHash([1, 2])).toEqual({ ok: false, error: { code: "INVALID", issues: ["save.state: not a JSON object"] } });
  });

  it("is INVALID, not a throw, for a number JSON parses as Infinity", () => {
    const state: unknown = JSON.parse('{"tick": 1e400}');
    expect(rawStateHash(state)).toEqual({
      ok: false,
      error: { code: "INVALID", issues: [expect.stringContaining("save.state: Non-finite number")] },
    });
  });
});
