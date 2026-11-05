import { SAVE_SCHEMA_VERSION, type SaveMeta } from "@eov/contracts";
import { BASIC_MOONSHINE_RECIPE, CORN, CROSSROADS_ROADHOUSE, DISTILLERY_MAIN, MILLERS_FEED, MODEL_TT_TRUCK, MOONSHINE, SUGAR } from "@eov/game-data";
import { loadGame, newGame } from "@eov/simulation";
import { describe, expect, it } from "vitest";
import { createSaveFile, MemoryStorageAdapter, parseSaveFile, readSave, serializeSaveFile, writeSave } from "../src/index.ts";

const meta: SaveMeta = { slot: "slot-1", label: "Day 1", savedAt: "2026-11-04T18:30:00.000Z", appVersion: "0.0.0-test" };

/** A game mid-way through the Sprint Zero path: a case is on the truck. */
function gameInProgress() {
  const sim = newGame();
  sim.dispatch({ command: { type: "PURCHASE_MATERIALS", supplierId: MILLERS_FEED, materialId: CORN, quantity: 2, facilityId: DISTILLERY_MAIN } });
  sim.dispatch({ command: { type: "PURCHASE_MATERIALS", supplierId: MILLERS_FEED, materialId: SUGAR, quantity: 1, facilityId: DISTILLERY_MAIN } });
  sim.dispatch({ command: { type: "START_PRODUCTION", facilityId: DISTILLERY_MAIN, recipeId: BASIC_MOONSHINE_RECIPE, quantity: 1 } });
  sim.advance(200);
  const price = sim.state.buyers.find((b) => b.id === CROSSROADS_ROADHOUSE)!.wants[0]!.unitPrice;
  const result = sim.dispatch({
    command: {
      type: "DISPATCH_DELIVERY",
      vehicleId: MODEL_TT_TRUCK,
      cargo: [{ productId: MOONSHINE, quality: "basic", quantity: 1 }],
      purpose: { kind: "SALE", buyerId: CROSSROADS_ROADHOUSE, agreedUnitPrice: price },
      routeId: null,
    },
  });
  expect(result.status).toBe("applied");
  sim.advance(30);
  return sim;
}

describe("persistence (S0 stub)", () => {
  it("saves through a storage adapter and loads back the same state", async () => {
    const storage = new MemoryStorageAdapter();
    const sim = gameInProgress();
    const written = await writeSave(storage, sim, meta);
    expect(written.stateHash).toBe(sim.stateHash());
    expect(await storage.list()).toEqual(["slot-1"]);

    const loaded = await readSave(storage, "slot-1");
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.error));
    expect(loaded.file.meta).toEqual(meta);
    expect(loaded.file.stateHash).toBe(sim.stateHash());
  });

  it("save → load → continue gives the same state hash as an uninterrupted run", async () => {
    const storage = new MemoryStorageAdapter();
    const sim = gameInProgress();
    await writeSave(storage, sim, meta);
    const loaded = await readSave(storage, "slot-1");
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.error));
    const resumed = loadGame(loaded.file.save);

    sim.advance(1_000);
    resumed.advance(1_000);
    expect(resumed.stateHash()).toBe(sim.stateHash());
    expect(resumed.state.ledger.transactions.map((t) => t.kind)).toContain("SALE");
  });

  it("rejects text that isn't a save", () => {
    expect(parseSaveFile("not json")).toEqual({ ok: false, error: { code: "NOT_A_SAVE" } });
    expect(parseSaveFile(JSON.stringify({ save: { format: "something-else" } }))).toEqual({ ok: false, error: { code: "NOT_A_SAVE" } });
  });

  it("reports an empty slot as NOT_A_SAVE", async () => {
    expect(await readSave(new MemoryStorageAdapter(), "empty")).toEqual({ ok: false, error: { code: "NOT_A_SAVE" } });
  });

  it("rejects saves from a newer build, and older versions until T06 adds migrations", () => {
    const file = createSaveFile(gameInProgress().serialize(), meta);
    const withVersion = (v: number) => serializeSaveFile({ ...file, save: { ...file.save, schemaVersion: v as typeof SAVE_SCHEMA_VERSION } });
    expect(parseSaveFile(withVersion(SAVE_SCHEMA_VERSION + 1))).toEqual({
      ok: false,
      error: { code: "NEWER_VERSION", saveVersion: SAVE_SCHEMA_VERSION + 1, supportedVersion: SAVE_SCHEMA_VERSION },
    });
    expect(parseSaveFile(withVersion(0)).ok).toBe(false);
  });

  it("validates against saveFileSchema", () => {
    const file = createSaveFile(gameInProgress().serialize(), meta);
    const broken = { ...file, save: { ...file.save, state: { ...file.save.state, tick: -1 } } };
    const result = parseSaveFile(JSON.stringify(broken));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID");
      if (result.error.code === "INVALID") expect(result.error.issues.join("\n")).toContain("save.state.tick");
    }
  });

  it("checks the state hash on load", () => {
    const file = createSaveFile(gameInProgress().serialize(), meta);
    const state = file.save.state;
    // Valid by the schema, but not the state that was hashed.
    const tampered = { ...file, save: { ...file.save, state: { ...state, family: { ...state.family, reputation: 50 } } } };
    const result = parseSaveFile(serializeSaveFile(tampered));
    expect(result).toEqual({ ok: false, error: { code: "HASH_MISMATCH", expected: file.stateHash, actual: expect.any(String) } });
  });
});
