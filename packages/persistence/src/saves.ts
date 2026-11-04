// S0 stub: extended by T06. Save and load through a StorageAdapter.

import type { SaveFile, SaveGame, SaveMeta } from "@eov/contracts";
import { createSaveFile, parseSaveFile, serializeSaveFile, type SaveLoadResult } from "./save-file.ts";
import type { StorageAdapter } from "./storage.ts";

/** Anything that can produce a save: the simulation (`Simulation.serialize`). */
export interface Saveable {
  serialize(): SaveGame;
}

/**
 * Writes a save to `meta.slot`. `meta` (including the real-world `savedAt`) comes
 * from the caller: the app adds wall-clock metadata, never the simulation.
 */
export async function writeSave(storage: StorageAdapter, game: Saveable, meta: SaveMeta): Promise<SaveFile> {
  const file = createSaveFile(game.serialize(), meta);
  await storage.write(meta.slot, serializeSaveFile(file));
  return file;
}

/** Reads and checks a save. An empty slot is NOT_A_SAVE. */
export async function readSave(storage: StorageAdapter, slot: string): Promise<SaveLoadResult> {
  const text = await storage.read(slot);
  if (text === null) return { ok: false, error: { code: "NOT_A_SAVE" } };
  return parseSaveFile(text);
}
