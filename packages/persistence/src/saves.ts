// Save, load, and list saves through a StorageAdapter (ADR 0008, 0009).

import type { SaveFile, SaveGame, SaveLoadError, SaveMeta } from "@eov/contracts";
import { createSaveFile, parseSaveFile, serializeSaveFile, type LoadOptions, type SaveLoadResult } from "./save-file.ts";
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

/** Reads and checks a save (save-file.ts). An empty slot is NOT_A_SAVE. */
export async function readSave(storage: StorageAdapter, slot: string, options: LoadOptions = {}): Promise<SaveLoadResult> {
  const text = await storage.read(slot);
  if (text === null) return { ok: false, error: { code: "NOT_A_SAVE" } };
  return parseSaveFile(text, options);
}

/** One slot as a save list shows it. */
export type SaveSummary =
  | {
      readonly slot: string;
      readonly ok: true;
      readonly meta: SaveMeta;
      readonly gameDataVersion: string;
      readonly gameDataChanged: boolean;
    }
  /** The slot holds something that won't load. `meta` is whatever could be read, for the list. */
  | { readonly slot: string; readonly ok: false; readonly meta: Partial<SaveMeta>; readonly error: SaveLoadError };

/**
 * Every slot, fully checked (the same checks as loading), newest `savedAt`
 * first, then by slot. A slot that won't load is listed with its error, so the
 * player can see it and delete it.
 */
export async function listSaves(storage: StorageAdapter, options: LoadOptions = {}): Promise<readonly SaveSummary[]> {
  const summaries: SaveSummary[] = [];
  for (const slot of await storage.list()) {
    const text = await storage.read(slot);
    if (text === null) continue;
    const loaded = parseSaveFile(text, options);
    summaries.push(
      loaded.ok
        ? { slot, ok: true, meta: loaded.file.meta, gameDataVersion: loaded.file.save.gameDataVersion, gameDataChanged: loaded.gameDataChanged }
        : { slot, ok: false, meta: readableMeta(text), error: loaded.error },
    );
  }
  return summaries.sort((a, b) => compareText(b.meta.savedAt ?? "", a.meta.savedAt ?? "") || compareText(a.slot, b.slot));
}

/** The first `slot-N` not in use (N from 1). */
export function nextSlotId(used: readonly string[]): string {
  const taken = new Set(used);
  let n = 1;
  while (taken.has(`slot-${n}`)) n++;
  return `slot-${n}`;
}

/** Whatever string metadata a damaged save still has, for listing it. */
function readableMeta(text: string): Partial<SaveMeta> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  const meta = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)["meta"] : undefined;
  if (typeof meta !== "object" || meta === null) return {};
  const out: Record<string, string> = {};
  for (const key of ["slot", "label", "savedAt", "appVersion"] as const) {
    const value = (meta as Record<string, unknown>)[key];
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
