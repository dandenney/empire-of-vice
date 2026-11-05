// S0 stub: replaced by T06 (IndexedDB adapter via Dexie, migrations, load-error UI).
//
// A minimal StorageAdapter over localStorage, so a save survives a page reload.
// Slots are namespaced under one key prefix. Everything else about saving
// (schema, hash, SaveFile) is @eov/persistence's job.

import type { StorageAdapter } from "@eov/persistence";

const PREFIX = "eov.save.";

export class LocalStorageAdapter implements StorageAdapter {
  readonly #storage: Storage;

  constructor(storage: Storage = window.localStorage) {
    this.#storage = storage;
  }

  async read(slot: string): Promise<string | null> {
    return this.#storage.getItem(PREFIX + slot);
  }

  async write(slot: string, contents: string): Promise<void> {
    this.#storage.setItem(PREFIX + slot, contents);
  }

  async remove(slot: string): Promise<void> {
    this.#storage.removeItem(PREFIX + slot);
  }

  async list(): Promise<readonly string[]> {
    const slots: string[] = [];
    for (let i = 0; i < this.#storage.length; i++) {
      const key = this.#storage.key(i);
      if (key?.startsWith(PREFIX)) slots.push(key.slice(PREFIX.length));
    }
    return slots.sort();
  }
}
