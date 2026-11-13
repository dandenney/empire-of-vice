// React access to the gateway and the UI store.
//
// `useGatewayView` reads the latest snapshot straight from GatewayClient with
// useSyncExternalStore (ADR 0014 decision 10). Game values never pass through
// Zustand; `useUi` is for UI-only state.
//
// The current save slot (the slot this game was last saved to or loaded
// from) is shared session state: the game menu saves to it, and every way of
// starting a new game must clear it, or the next Save would overwrite the
// previous game's save. `useStartNewGame` is that one way.

import type { ScenarioId } from "@eov/contracts";
import { createContext, useCallback, useContext, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { useStore } from "zustand";
import type { GatewayClient, GatewayView } from "./gateway-client.ts";
import type { UiState, UiStore } from "./ui-store.ts";

interface AppServices {
  readonly gateway: GatewayClient;
  readonly ui: UiStore;
}

interface AppSession extends AppServices {
  readonly currentSlot: string | null;
  readonly setCurrentSlot: (slot: string | null) => void;
  readonly startNewGame: (scenarioId?: ScenarioId) => Promise<void>;
}

const AppContext = createContext<AppSession | null>(null);

export function AppProvider({ gateway, ui, children }: AppServices & { readonly children: ReactNode }) {
  const [currentSlot, setCurrentSlot] = useState<string | null>(null);
  const startNewGame = useCallback(async (scenarioId?: ScenarioId) => {
    await gateway.newGame(scenarioId);
    setCurrentSlot(null);
  }, [gateway]);
  const session = useMemo(() => ({ gateway, ui, currentSlot, setCurrentSlot, startNewGame }), [gateway, ui, currentSlot, startNewGame]);
  return <AppContext.Provider value={session}>{children}</AppContext.Provider>;
}

function useServices(): AppSession {
  const services = useContext(AppContext);
  if (!services) throw new Error("AppProvider is missing");
  return services;
}

export function useGateway(): GatewayClient {
  return useServices().gateway;
}

/** The latest snapshot, state hash, and scheduler status. Re-renders when the worker posts. */
export function useGatewayView(): GatewayView {
  const { gateway } = useServices();
  return useSyncExternalStore(gateway.subscribe, gateway.getView);
}

export function useUi<T>(selector: (state: UiState) => T): T {
  return useStore(useServices().ui, selector);
}

/** The save slot this game was last saved to or loaded from (null for a new game), and its setter. */
export function useCurrentSlot(): readonly [string | null, (slot: string | null) => void] {
  const { currentSlot, setCurrentSlot } = useServices();
  return [currentSlot, setCurrentSlot];
}

/**
 * Starts a new game (in `scenarioId`, default The First Shipment) and clears
 * the current slot. Every New game / Start again goes through this.
 */
export function useStartNewGame(): (scenarioId?: ScenarioId) => Promise<void> {
  return useServices().startNewGame;
}
