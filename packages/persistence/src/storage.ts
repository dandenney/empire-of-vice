// S0 stub: extended by T06 (IndexedDB adapter, migrations, load-error UI).
//
// Persistence talks to storage only through this interface, so the same save
// code runs against IndexedDB in the browser (T06) and memory in Node and tests.
// Async because IndexedDB is.

export interface StorageAdapter {
  /** The stored text for a slot, or null if the slot is empty. */
  read(slot: string): Promise<string | null>;
  /** Replaces the slot's contents. */
  write(slot: string, contents: string): Promise<void>;
  remove(slot: string): Promise<void>;
  /** Slots that hold something, sorted. */
  list(): Promise<readonly string[]>;
}

/** Keeps saves in a Map. For Node (the economy lab) and tests. */
export class MemoryStorageAdapter implements StorageAdapter {
  readonly #slots = new Map<string, string>();

  async read(slot: string): Promise<string | null> {
    return this.#slots.get(slot) ?? null;
  }

  async write(slot: string, contents: string): Promise<void> {
    this.#slots.set(slot, contents);
  }

  async remove(slot: string): Promise<void> {
    this.#slots.delete(slot);
  }

  async list(): Promise<readonly string[]> {
    return [...this.#slots.keys()].sort();
  }
}
