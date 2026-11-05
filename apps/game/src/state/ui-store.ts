// UI-only state (architecture §2): which panel is open, which location is
// selected, and which requests are in flight. Nothing here is game state: no
// cash, inventory, or other values from the simulation (CLAUDE.md rule 7). The
// snapshot reaches React from GatewayClient, not through this store.

import type { LocationId } from "@eov/contracts";
import { createStore, type StoreApi } from "zustand/vanilla";

/** A panel's id in `src/panels/registry.ts`. */
export type PanelId = string;

export interface UiState {
  readonly openPanelId: PanelId;
  readonly selectedLocationId: LocationId | null;
  /** Keys of requests in flight, e.g. "start-production:distillery-main:basic-moonshine". */
  readonly pending: Readonly<Record<string, true>>;
  openPanel(id: PanelId): void;
  /** Selects the location and opens the panel for whatever occupies it (T04b's map clicks call this). */
  openPanelForLocation(locationId: LocationId): void;
  setPending(key: string, pending: boolean): void;
}

export type UiStore = StoreApi<UiState>;

export interface UiStoreOptions {
  readonly initialPanelId: PanelId;
  /** The panel for a location's occupant, or null if the location isn't in the current snapshot. */
  readonly panelForLocation: (locationId: LocationId) => PanelId | null;
}

export function createUiStore(options: UiStoreOptions): UiStore {
  return createStore<UiState>()((set) => ({
    openPanelId: options.initialPanelId,
    selectedLocationId: null,
    pending: {},
    openPanel: (id) => set({ openPanelId: id }),
    openPanelForLocation: (locationId) => {
      const panelId = options.panelForLocation(locationId);
      if (panelId === null) return;
      set({ openPanelId: panelId, selectedLocationId: locationId });
    },
    setPending: (key, pending) =>
      set((state) => {
        if (pending === key in state.pending) return state;
        const next = { ...state.pending };
        if (pending) next[key] = true;
        else delete next[key];
        return { pending: next };
      }),
  }));
}
