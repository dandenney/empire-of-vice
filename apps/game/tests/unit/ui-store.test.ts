// The UI store holds UI-only state, and location clicks open the right panel
// (issue #11).

import { asId, type GameSnapshot } from "@eov/contracts";
import { newGame } from "@eov/simulation";
import { describe, expect, it } from "vitest";
import { DEFAULT_PANEL_ID, PANEL_FOR_OCCUPANT, PANELS, panelById, panelForLocation } from "../../src/panels/registry.ts";
import { createUiStore } from "../../src/state/ui-store.ts";

const snapshot: GameSnapshot = newGame().snapshot();

function storeFor(s: GameSnapshot | null) {
  return createUiStore({ initialPanelId: DEFAULT_PANEL_ID, panelForLocation: (id) => panelForLocation(s, id) });
}

describe("ui store", () => {
  it("opens the dashboard first, with nothing selected or pending", () => {
    const state = storeFor(snapshot).getState();
    expect(state.openPanelId).toBe("dashboard");
    expect(state.selectedLocationId).toBeNull();
    expect(state.pending).toEqual({});
  });

  it("holds no game values: only the open panel, the selected location, and pending flags", () => {
    const data = Object.entries(storeFor(snapshot).getState()).filter(([, v]) => typeof v !== "function");
    expect(data.map(([k]) => k).sort()).toEqual(["openPanelId", "pending", "selectedLocationId"]);
  });

  it("openPanel switches panels", () => {
    const store = storeFor(snapshot);
    store.getState().openPanel("finance");
    expect(store.getState().openPanelId).toBe("finance");
  });

  it("openPanelForLocation maps a facility to Production and suppliers and buyers to Market", () => {
    const store = storeFor(snapshot);
    const byKind = (kind: string) => snapshot.locations.find((l) => l.occupant.kind === kind)!;
    for (const [kind, panel] of [
      ["FACILITY", "production"],
      ["SUPPLIER", "market"],
      ["BUYER", "market"],
    ] as const) {
      const location = byKind(kind);
      store.getState().openPanelForLocation(location.id);
      expect(store.getState()).toMatchObject({ openPanelId: panel, selectedLocationId: location.id });
    }
  });

  it("ignores a location that isn't in the snapshot, or when there's no game", () => {
    const store = storeFor(snapshot);
    store.getState().openPanelForLocation(asId("Location", "nowhere"));
    expect(store.getState()).toMatchObject({ openPanelId: "dashboard", selectedLocationId: null });
    const empty = storeFor(null);
    empty.getState().openPanelForLocation(snapshot.locations[0]!.id);
    expect(empty.getState().openPanelId).toBe("dashboard");
  });

  it("tracks pending requests by key", () => {
    const store = storeFor(snapshot);
    store.getState().setPending("a", true);
    store.getState().setPending("b", true);
    store.getState().setPending("a", false);
    expect(store.getState().pending).toEqual({ b: true });
    const before = store.getState();
    store.getState().setPending("a", false);
    expect(store.getState()).toBe(before);
  });
});

describe("panel registry", () => {
  it("lists Dashboard, Production, Finance, and the Market placeholder, with unique ids", () => {
    expect(PANELS.map((p) => p.id)).toEqual(["dashboard", "production", "finance", "market"]);
    for (const p of PANELS) {
      expect(p.title.length).toBeGreaterThan(0);
      expect(typeof p.component).toBe("function");
    }
  });

  it("maps every occupant kind to a registered panel", () => {
    for (const id of Object.values(PANEL_FOR_OCCUPANT)) expect(panelById(id)).toBeDefined();
  });
});
