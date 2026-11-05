// React access to the gateway and the UI store.
//
// `useGatewayView` reads the latest snapshot straight from GatewayClient with
// useSyncExternalStore (ADR 0014 decision 10). Game values never pass through
// Zustand; `useUi` is for UI-only state.

import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { useStore } from "zustand";
import type { GatewayClient, GatewayView } from "./gateway-client.ts";
import type { UiState, UiStore } from "./ui-store.ts";

interface AppServices {
  readonly gateway: GatewayClient;
  readonly ui: UiStore;
}

const AppContext = createContext<AppServices | null>(null);

export function AppProvider({ gateway, ui, children }: AppServices & { readonly children: ReactNode }) {
  const services = useMemo(() => ({ gateway, ui }), [gateway, ui]);
  return <AppContext.Provider value={services}>{children}</AppContext.Provider>;
}

function useServices(): AppServices {
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
