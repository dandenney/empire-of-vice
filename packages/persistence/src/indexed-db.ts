// The browser's StorageAdapter: one IndexedDB object store, keyed by slot,
// holding each save's serialized text.
//
// The IDBFactory is passed in (the app passes `indexedDB`), so this module
// touches no browser global and the rest of persistence stays runnable in
// Node, where tests use MemoryStorageAdapter.

import type { StorageAdapter } from "./storage.ts";

/** The database and store the game's saves live in. Tests read them directly. */
export const SAVE_DATABASE = { name: "empire-of-vice", version: 1, store: "saves" } as const;

export class IndexedDbStorageAdapter implements StorageAdapter {
  readonly #factory: IDBFactory;
  #db: Promise<IDBDatabase> | null = null;

  constructor(factory: IDBFactory) {
    this.#factory = factory;
  }

  async read(slot: string): Promise<string | null> {
    const value = await this.#request("readonly", (store) => store.get(slot));
    return typeof value === "string" ? value : null;
  }

  async write(slot: string, contents: string): Promise<void> {
    await this.#request("readwrite", (store) => store.put(contents, slot));
  }

  async remove(slot: string): Promise<void> {
    await this.#request("readwrite", (store) => store.delete(slot));
  }

  async list(): Promise<readonly string[]> {
    const keys = await this.#request("readonly", (store) => store.getAllKeys());
    return keys.filter((k): k is string => typeof k === "string").sort();
  }

  /** Runs one request in its own transaction, resolving once the transaction commits. */
  async #request<T>(mode: IDBTransactionMode, make: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.#open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(SAVE_DATABASE.store, mode);
      const request = make(tx.objectStore(SAVE_DATABASE.store));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error ?? request.error);
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    });
  }

  #open(): Promise<IDBDatabase> {
    this.#db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.#factory.open(SAVE_DATABASE.name, SAVE_DATABASE.version);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(SAVE_DATABASE.store)) request.result.createObjectStore(SAVE_DATABASE.store);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    // A failed open isn't cached: the next call tries again.
    this.#db.catch(() => {
      this.#db = null;
    });
    return this.#db;
  }
}
