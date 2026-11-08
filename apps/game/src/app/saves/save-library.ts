// The save/load UI's access to saves (T06a, #135): list, save, load, delete.
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
import { FIRST_SHIPMENT_SCENARIO, GAME_DATA_VERSION } from "@eov/game-data";
import { listSaves, nextSlotId, readSave, type LoadOptions, type SaveSummary, type StorageAdapter } from "@eov/persistence";
import type { GatewayClient } from "../../state/gateway-client.ts";

/** What this build plays, for the load checks: the worker's new games use the First Shipment scenario. */
export const CURRENT_BUILD: LoadOptions = { scenarioId: FIRST_SHIPMENT_SCENARIO.id, gameDataVersion: GAME_DATA_VERSION };

/** Why a load failed: persistence refused the save, or the worker couldn't resume it. */
export type LoadFailure = { readonly kind: "save"; readonly error: SaveLoadError } | { readonly kind: "start"; readonly message: string };

export type LoadAttempt =
  | { readonly ok: true; readonly slot: string; readonly label: string; readonly otherGameData: string | null }
  | { readonly ok: false; readonly slot: string; readonly failure: LoadFailure };

export type SaveGateway = Pick<GatewayClient, "save" | "load">;

export class SaveLibrary {
  readonly #storage: StorageAdapter;
  readonly #gateway: SaveGateway;
  readonly #build: LoadOptions;

  constructor(storage: StorageAdapter, gateway: SaveGateway, build: LoadOptions = CURRENT_BUILD) {
    this.#storage = storage;
    this.#gateway = gateway;
    this.#build = build;
  }

  /** Every save, newest first, including ones that won't load (with why). */
  list(): Promise<readonly SaveSummary[]> {
    return listSaves(this.#storage, this.#build);
  }

  /** Saves the running game to `slot`, or to a new slot when `slot` is null. Returns the slot used. */
  async save(label: string, slot: string | null): Promise<string> {
    const target = slot ?? nextSlotId(await this.#storage.list());
    await this.#gateway.save(target, label);
    return target;
  }

  async load(slot: string): Promise<LoadAttempt> {
    const checked = await readSave(this.#storage, slot, this.#build);
    if (!checked.ok) return { ok: false, slot, failure: { kind: "save", error: checked.error } };
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
}

/** The save `Continue` loads: the newest one that loads, else the newest (to show why it won't), else none. */
export function continueTarget(saves: readonly SaveSummary[]): SaveSummary | null {
  return saves.find((s) => s.ok) ?? saves[0] ?? null;
}
