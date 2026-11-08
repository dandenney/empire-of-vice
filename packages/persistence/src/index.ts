// @eov/persistence: versioned local saves (ADR 0008, 0009).
// SaveFile serialization; loading with the migration chain, schema, hash, and
// scenario checks; save listing; and the storage interface, with a memory
// adapter for Node and tests. The browser's IndexedDB adapter is its own entry,
// `@eov/persistence/indexed-db`, so Node consumers (the economy lab) never
// need the DOM types.
export { migrateSave, SAVE_MIGRATIONS, type MigrationResult } from "./migrations.ts";
export { createSaveFile, parseSaveFile, serializeSaveFile, type LoadOptions, type SaveLoadResult } from "./save-file.ts";
export { listSaves, nextSlotId, readSave, writeSave, type Saveable, type SaveSummary } from "./saves.ts";
export { MemoryStorageAdapter, type StorageAdapter } from "./storage.ts";
