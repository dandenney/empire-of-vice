// S0 stub: extended by T06 (ADR 0009 migration chain and fixtures).
//
// A SaveFile wraps the simulation's SaveGame with app metadata and the state
// hash. Loading either succeeds completely or returns a typed SaveLoadError:
// it's parsed, header-checked, validated against `saveFileSchema`, and its
// `stateHash` is recomputed and compared. No migrations exist yet (schema v1),
// so an older version is MISSING_MIGRATION until T06 adds the chain.

import {
  formatIssues,
  SAVE_SCHEMA_VERSION,
  saveFileSchema,
  saveHeaderSchema,
  type SaveFile,
  type SaveGame,
  type SaveLoadError,
  type SaveMeta,
} from "@eov/contracts";
import { hashState } from "@eov/simulation";

export type SaveLoadResult = { readonly ok: true; readonly file: SaveFile } | { readonly ok: false; readonly error: SaveLoadError };

/** Wraps a SaveGame for storage, hashing its state with the kernel's algorithm. */
export function createSaveFile(save: SaveGame, meta: SaveMeta): SaveFile {
  return { save, meta, stateHash: hashState(save.state) };
}

export function serializeSaveFile(file: SaveFile): string {
  return JSON.stringify(file);
}

export function parseSaveFile(text: string): SaveLoadResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: { code: "NOT_A_SAVE" } };
  }
  const inner = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)["save"] : undefined;
  const header = saveHeaderSchema.safeParse(inner);
  if (!header.success) return { ok: false, error: { code: "NOT_A_SAVE" } };
  const version = header.data.schemaVersion;
  if (version > SAVE_SCHEMA_VERSION) {
    return { ok: false, error: { code: "NEWER_VERSION", saveVersion: version, supportedVersion: SAVE_SCHEMA_VERSION } };
  }
  if (version < SAVE_SCHEMA_VERSION) return { ok: false, error: { code: "MISSING_MIGRATION", fromVersion: version } };

  const parsed = saveFileSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: { code: "INVALID", issues: formatIssues(parsed.error) } };
  const file: SaveFile = parsed.data;
  const actual = hashState(file.save.state);
  if (actual !== file.stateHash) return { ok: false, error: { code: "HASH_MISMATCH", expected: file.stateHash, actual } };
  return { ok: true, file };
}
