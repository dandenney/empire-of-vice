// The UI side of the simulation gateway: sends requests to the worker and
// hands its snapshots and events to listeners.
//
// It keeps the latest snapshot only to render it (architecture §4: read-only
// projections). It never edits it, and nothing here computes game values.
// React reads `view` through `subscribe` (useSyncExternalStore), not through a
// store of its own (CLAUDE.md rule 7, ADR 0014 decision 10).
// Saves go through @eov/persistence: the worker serializes, persistence wraps,
// hashes, and stores the SaveFile; on load, persistence checks schema and hash
// before the SaveGame goes back to the worker.

import type { CommandResult, GameEvent, GameSnapshot, SaveLoadError, SaveMeta } from "@eov/contracts";
import { readSave, writeSave, type StorageAdapter } from "@eov/persistence";
import type { RequestId, WorkerMessage, WorkerRequest, WorkerResponse } from "../workers/protocol.ts";
import { PAUSED_STATUS, type SchedulerStatus, type Speed } from "../workers/scheduler.ts";

export type DispatchOutcome =
  | { readonly kind: "result"; readonly result: CommandResult }
  | { readonly kind: "invalid"; readonly issues: readonly string[] };

export type LoadOutcome = { readonly ok: true } | { readonly ok: false; readonly error: SaveLoadError };

export interface GatewayView {
  readonly snapshot: GameSnapshot | null;
  readonly stateHash: string | null;
  /** The worker's speed scheduler, as of the last snapshot. */
  readonly scheduler: SchedulerStatus;
  /** The last scheduler fault (the game paused itself), or null. */
  readonly fault: string | null;
}

type Distribute<T> = T extends unknown ? Omit<T, "requestId"> : never;
type RequestBody = Distribute<WorkerRequest>;

export class GatewayError extends Error {
  override readonly name = "GatewayError";
}

const APP_VERSION = "s0-browser";

export class GatewayClient {
  readonly #worker: Worker;
  readonly #storage: StorageAdapter;
  readonly #pending = new Map<RequestId, (response: WorkerResponse) => void>();
  readonly #snapshotListeners = new Set<(view: GatewayView) => void>();
  readonly #eventListeners = new Set<(events: readonly GameEvent[], importance: "notify" | "log") => void>();
  #nextRequestId: RequestId = 1;
  #view: GatewayView = { snapshot: null, stateHash: null, scheduler: PAUSED_STATUS, fault: null };

  constructor(worker: Worker, storage: StorageAdapter) {
    this.#worker = worker;
    this.#storage = storage;
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => this.#receive(event.data);
  }

  get view(): GatewayView {
    return this.#view;
  }

  /** For useSyncExternalStore: `view` is a new object only when something changed. */
  readonly subscribe = (listener: () => void): (() => void) => this.onSnapshot(listener);

  readonly getView = (): GatewayView => this.#view;

  onSnapshot(listener: (view: GatewayView) => void): () => void {
    this.#snapshotListeners.add(listener);
    return () => this.#snapshotListeners.delete(listener);
  }

  onEvents(listener: (events: readonly GameEvent[], importance: "notify" | "log") => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  async newGame(): Promise<void> {
    await this.#expect("READY", { type: "NEW_GAME" });
    this.#clearFault();
  }

  /** `request` is sent as-is; the worker validates it with `commandRequestSchema`. */
  async dispatch(request: unknown): Promise<DispatchOutcome> {
    const response = await this.#send({ type: "DISPATCH", request });
    if (response.type === "COMMAND_RESULT") return { kind: "result", result: response.result };
    if (response.type === "INVALID_REQUEST") return { kind: "invalid", issues: response.issues };
    throw this.#unexpected(response);
  }

  async setSpeed(speed: Speed): Promise<void> {
    await this.#expect("READY", { type: "SET_SPEED", speed });
  }

  async setVisibility(visible: boolean): Promise<void> {
    await this.#expect("READY", { type: "SET_VISIBILITY", visible });
  }

  /** Test hook only: pauses, then runs exactly `ticks` ticks (ADR 0014 decision 7). */
  async advance(ticks: number): Promise<void> {
    await this.#expect("READY", { type: "ADVANCE", ticks });
  }

  async save(slot: string, label: string): Promise<void> {
    const response = await this.#expect("SAVE_GAME", { type: "SERIALIZE" });
    const meta: SaveMeta = { slot, label, savedAt: new Date().toISOString(), appVersion: APP_VERSION };
    await writeSave(this.#storage, { serialize: () => response.save }, meta);
  }

  async load(slot: string): Promise<LoadOutcome> {
    const loaded = await readSave(this.#storage, slot);
    if (!loaded.ok) return { ok: false, error: loaded.error };
    await this.#expect("READY", { type: "LOAD_GAME", save: loaded.file.save });
    this.#clearFault();
    return { ok: true };
  }

  #receive(message: WorkerMessage): void {
    switch (message.type) {
      case "SNAPSHOT":
        this.#setView({ ...this.#view, snapshot: message.snapshot, stateHash: message.stateHash, scheduler: message.scheduler });
        return;
      case "FAULT":
        this.#setView({ ...this.#view, fault: message.message });
        return;
      case "EVENTS":
        for (const listener of this.#eventListeners) listener(message.events, message.importance);
        return;
      default: {
        const resolve = this.#pending.get(message.requestId);
        this.#pending.delete(message.requestId);
        resolve?.(message);
      }
    }
  }

  #clearFault(): void {
    if (this.#view.fault !== null) this.#setView({ ...this.#view, fault: null });
  }

  #setView(view: GatewayView): void {
    this.#view = view;
    for (const listener of this.#snapshotListeners) listener(view);
  }

  #send(body: RequestBody): Promise<WorkerResponse> {
    const requestId = this.#nextRequestId++;
    return new Promise((resolve) => {
      this.#pending.set(requestId, resolve);
      this.#worker.postMessage({ ...body, requestId } as WorkerRequest);
    });
  }

  async #expect<T extends WorkerResponse["type"]>(type: T, body: RequestBody): Promise<Extract<WorkerResponse, { type: T }>> {
    const response = await this.#send(body);
    if (response.type !== type) throw this.#unexpected(response);
    return response as Extract<WorkerResponse, { type: T }>;
  }

  #unexpected(response: WorkerResponse): GatewayError {
    return new GatewayError(response.type === "ERROR" ? response.message : `Unexpected worker response ${response.type}`);
  }
}
