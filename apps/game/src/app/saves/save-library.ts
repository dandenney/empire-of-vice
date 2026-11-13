// The save/load UI's access to saves (T06a, #135; T06f, #152): list, save, load, delete.
//
// Saving and loading go through the gateway (GatewayClient.save / .load): the
// worker serializes and resumes, persistence wraps, checks, and stores. Before
// a load, the library checks the save itself with this build's scenario and
// game-data version, so a save the simulation can't resume is refused with a
// typed SaveLoadError and never reaches the worker, and a save made with other
// game-data is reported (it still loads, ADR 0009). Either the whole load
// succeeds or nothing changes: a failed load leaves the running game alone.
//
// Nothing here holds game state; summaries are read from storage each time.

import type { SaveLoadError } from "@eov/contracts";
import { GAME_DATA_VERSION } from "@eov/game-data";
import { listSaves, nextSlotId, readSave, type SaveSummary, type StorageAdapter } from "@eov/persistence";
import type { GatewayClient } from "../../state/gateway-client.ts";
import { PLAYABLE_SCENARIOS } from "../../workers/scenarios.ts";

/** What a build plays, for the load checks. */
export interface BuildOptions {
  /** The scenarios it plays. A save for any other scenario is INVALID. */
  readonly scenarioIds: readonly string[];
  /** Its game-data version, to report a save made with other game-data. */
  readonly gameDataVersion: string;
}

/**
 * What this build plays: the worker's scenarios (the First Shipment and the
 * First Hire). A save resumes in its own scenario, so either kind loads.
 */
export const CURRENT_BUILD: BuildOptions = { scenarioIds: PLAYABLE_SCENARIOS.map((s) => s.id), gameDataVersion: GAME_DATA_VERSION };

/** Why a load failed: persistence refused the save, or the worker couldn't resume it. */
export type LoadFailure = { readonly kind: "save"; readonly error: SaveLoadError } | { readonly kind: "start"; readonly message: string };

export type LoadAttempt =
  | { readonly ok: true; readonly slot: string; readonly label: string; readonly otherGameData: string | null }
  | { readonly ok: false; readonly slot: string; readonly failure: LoadFailure };

export type SaveGateway = Pick<GatewayClient, "save" | "load">;

/** Where a save went, and the name it has there. */
export interface SavedTo {
  readonly slot: string;
  readonly label: string;
}

export class SaveLibrary {
  readonly #storage: StorageAdapter;
  readonly #gateway: SaveGateway;
  readonly #build: BuildOptions;

  constructor(storage: StorageAdapter, gateway: SaveGateway, build: BuildOptions = CURRENT_BUILD) {
    this.#storage = storage;
    this.#gateway = gateway;
    this.#build = build;
  }

  /** Every save, newest first, including ones that won't load (with why). */
  async list(): Promise<readonly SaveSummary[]> {
    const summaries = await listSaves(this.#storage, { gameDataVersion: this.#build.gameDataVersion });
    const checked: SaveSummary[] = [];
    for (const summary of summaries) {
      // Persistence checks one scenario; this build plays several, so check those here.
      const refusal = summary.ok ? this.#refuseScenario(readableScenarioId((await this.#storage.read(summary.slot)) ?? "")) : null;
      checked.push(refusal === null ? summary : { slot: summary.slot, ok: false, meta: summary.meta, error: refusal });
    }
    return checked;
  }

  /**
   * The top bar's Save (#145). With a current slot, overwrites it and keeps
   * that slot's name (only its contents and saved-at time change), so a
   * player's name is never replaced by the game date. With none, or if the
   * slot has gone (deleted in another tab), saves to a new slot named
   * `defaultLabel`. A slot with an empty name gets `defaultLabel` too. No
   * confirmation: this is the quick save.
   *
   * Only the current slot is read, and only for its name: it's about to be
   * overwritten, so its save isn't checked. A damaged save keeps whatever name
   * can still be read, as the saves list shows it.
   */
  async quickSave(slot: string | null, defaultLabel: string): Promise<SavedTo> {
    if (slot === null) return this.saveNew(defaultLabel);
    const text = await this.#storage.read(slot);
    if (text === null) return this.saveNew(defaultLabel);
    const label = readableLabel(text) || defaultLabel;
    await this.#write(slot, label);
    return { slot, label };
  }

  /**
   * Saves the running game to a new slot named `label`, always: the label is
   * used as given, and may repeat another slot's (slot ids stay unique).
   */
  async saveNew(label: string): Promise<SavedTo> {
    const slot = nextSlotId(await this.#storage.list());
    await this.#write(slot, label);
    return { slot, label };
  }

  /**
   * One save, written in a single storage write: the save text is built
   * before storage is touched, and the adapter replaces a slot's contents in
   * one step (one IndexedDB put, in its own transaction). So a save that
   * fails, whether serializing or writing, leaves the slot's previous save as
   * it was.
   */
  #write(slot: string, label: string): Promise<void> {
    return this.#gateway.save(slot, label);
  }

  async load(slot: string): Promise<LoadAttempt> {
    const checked = await readSave(this.#storage, slot, { gameDataVersion: this.#build.gameDataVersion });
    if (!checked.ok) return { ok: false, slot, failure: { kind: "save", error: checked.error } };
    const refusal = this.#refuseScenario(checked.file.save.scenarioId);
    if (refusal !== null) return { ok: false, slot, failure: { kind: "save", error: refusal } };
    let outcome: Awaited<ReturnType<SaveGateway["load"]>>;
    try {
      outcome = await this.#gateway.load(slot);
    } catch (error) {
      return { ok: false, slot, failure: { kind: "start", message: error instanceof Error ? error.message : String(error) } };
    }
    if (!outcome.ok) return { ok: false, slot, failure: { kind: "save", error: outcome.error } };
    const { meta, save } = checked.file;
    return { ok: true, slot, label: meta.label, otherGameData: checked.gameDataChanged ? save.gameDataVersion : null };
  }

  remove(slot: string): Promise<void> {
    return this.#storage.remove(slot);
  }

  /** INVALID for a save of a scenario this build doesn't play, as persistence words it for one scenario; else null. */
  #refuseScenario(scenarioId: string): SaveLoadError | null {
    if (this.#build.scenarioIds.includes(scenarioId)) return null;
    return { code: "INVALID", issues: [`save.scenarioId: this save is for scenario ${scenarioId}, not ${this.#build.scenarioIds.join(" or ")}`] };
  }
}

/** A save's `save.scenarioId` if its text has one (else ""). Only called on a save persistence has already checked. */
function readableScenarioId(text: string): string {
  try {
    const raw: unknown = JSON.parse(text);
    const save = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)["save"] : undefined;
    const id = typeof save === "object" && save !== null ? (save as Record<string, unknown>)["scenarioId"] : undefined;
    return typeof id === "string" ? id : "";
  } catch {
    return "";
  }
}

/** A save's `meta.label` if its text has one (else ""), without checking the rest of the save. */
function readableLabel(text: string): string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return "";
  }
  const meta = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)["meta"] : undefined;
  const label = typeof meta === "object" && meta !== null ? (meta as Record<string, unknown>)["label"] : undefined;
  return typeof label === "string" ? label : "";
}

/** The save `Continue` loads: the newest one that loads, else the newest (to show why it won't), else none. */
export function continueTarget(saves: readonly SaveSummary[]): SaveSummary | null {
  return saves.find((s) => s.ok) ?? saves[0] ?? null;
}
