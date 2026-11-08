// Version fixtures (ADR 0009): one save per schema version, committed under
// fixtures/ and never edited. Every one must migrate, validate, load, and
// advance with this build, so a schema change can't break old saves unnoticed.
//
// When SAVE_SCHEMA_VERSION goes up, write the new version's fixture with
//   WRITE_SAVE_FIXTURE=1 pnpm --filter @eov/persistence test
// (it only writes a file that doesn't exist yet).

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SAVE_SCHEMA_VERSION, type SaveMeta } from "@eov/contracts";
import { FIRST_SHIPMENT_SCENARIO, GAME_DATA_VERSION } from "@eov/game-data";
import { loadGame } from "@eov/simulation";
import { describe, expect, it } from "vitest";
import { createSaveFile, parseSaveFile, serializeSaveFile } from "../src/index.ts";
import { gameInProgress } from "./game.ts";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));
const fixtureName = (version: number) => `save-v${version}.json`;

if (process.env["WRITE_SAVE_FIXTURE"]) {
  const path = FIXTURES + fixtureName(SAVE_SCHEMA_VERSION);
  if (!existsSync(path)) {
    const meta: SaveMeta = { slot: "fixture", label: `Schema v${SAVE_SCHEMA_VERSION} fixture`, savedAt: "2026-11-08T12:00:00.000Z", appVersion: "fixture" };
    writeFileSync(path, `${serializeSaveFile(createSaveFile(gameInProgress().serialize(), meta))}\n`);
  }
}

const fixtures = readdirSync(FIXTURES).filter((f) => /^save-v\d+\.json$/.test(f));

describe("save version fixtures", () => {
  it("has a fixture for every schema version", () => {
    expect(fixtures.sort()).toEqual(Array.from({ length: SAVE_SCHEMA_VERSION }, (_, i) => fixtureName(i + 1)).sort());
  });

  it.each(fixtures)("%s migrates, validates, loads, and advances", (name) => {
    const version = Number(/\d+/.exec(name)![0]);
    const loaded = parseSaveFile(readFileSync(FIXTURES + name, "utf8"), { scenarioId: FIRST_SHIPMENT_SCENARIO.id, gameDataVersion: GAME_DATA_VERSION });
    if (!loaded.ok) throw new Error(`${name}: ${JSON.stringify(loaded.error)}`);
    expect(loaded.migratedFrom).toBe(version < SAVE_SCHEMA_VERSION ? version : null);
    expect(loaded.file.save.schemaVersion).toBe(SAVE_SCHEMA_VERSION);

    const sim = loadGame(loaded.file.save);
    expect(sim.stateHash()).toBe(loaded.file.stateHash);
    const start = sim.state.tick;
    sim.advance(1_440);
    expect(sim.state.tick).toBe(start + 1_440);
    expect(sim.state.outcome.status).toBe("PLAYING");
  });
});
