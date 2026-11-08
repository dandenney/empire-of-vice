// @eov/persistence: versioned local saves (ADR 0008, 0009).
// SaveFile serialization; loading with the migration chain, schema, hash, and
// scenario checks; save listing; and storage adapters (IndexedDB in the
// browser, memory in Node and tests).
export { IndexedDbStorageAdapter, SAVE_DATABASE } from "./indexed-db.ts";
export { migrateSave, SAVE_MIGRATIONS, type MigrationResult } from "./migrations.ts";
export { createSaveFile, parseSaveFile, serializeSaveFile, type LoadOptions, type SaveLoadResult } from "./save-file.ts";
export { listSaves, nextSlotId, readSave, writeSave, type Saveable, type SaveSummary } from "./saves.ts";
export { MemoryStorageAdapter, type StorageAdapter } from "./storage.ts";
