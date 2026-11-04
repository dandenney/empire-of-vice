// @eov/persistence: versioned local saves (ADR 0008, 0009).
// S0 stub (issue #4): SaveFile serialization, schema and hash checks on load, and
// an in-memory storage adapter. T06 adds migrations and the IndexedDB adapter.
export { createSaveFile, parseSaveFile, serializeSaveFile, type SaveLoadResult } from "./save-file.ts";
export { readSave, writeSave, type Saveable } from "./saves.ts";
export { MemoryStorageAdapter, type StorageAdapter } from "./storage.ts";
