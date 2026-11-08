// @eov/game: browser entry point.
//
// Starts the simulation worker (which owns the speed scheduler), the gateway
// client, the saves (IndexedDB), the UI store, and the React shell; reports
// tab visibility to the worker (hidden auto-pauses, ADR 0014); and, in test
// builds, installs the `window.__eov` test hook.

import { IndexedDbStorageAdapter } from "@eov/persistence/indexed-db";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/app.tsx";
import { SaveLibrary } from "./app/saves/save-library.ts";
import { installTestHook } from "./app/test-hook.ts";
import { DEFAULT_PANEL_ID, panelForLocation } from "./panels/registry.ts";
import { AppProvider } from "./state/app-context.tsx";
import { GatewayClient } from "./state/gateway-client.ts";
import { createUiStore } from "./state/ui-store.ts";

/** Test builds: anything but a production build (`vite` dev, or `vite build --mode test`). */
const TEST_BUILD = import.meta.env.MODE !== "production";

const worker = new Worker(new URL("./workers/simulation.worker.ts", import.meta.url), { type: "module" });
const storage = new IndexedDbStorageAdapter(indexedDB);
const gateway = new GatewayClient(worker, storage);
const saves = new SaveLibrary(storage, gateway);
const ui = createUiStore({
  initialPanelId: DEFAULT_PANEL_ID,
  panelForLocation: (locationId) => panelForLocation(gateway.view.snapshot, locationId),
});

const reportVisibility = (): void => {
  void gateway.setVisibility(document.visibilityState === "visible");
};
document.addEventListener("visibilitychange", reportVisibility);
reportVisibility();

if (TEST_BUILD) installTestHook(gateway);

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");
createRoot(root).render(
  <StrictMode>
    <AppProvider gateway={gateway} ui={ui}>
      <App showStateHash={TEST_BUILD} saves={saves} />
    </AppProvider>
  </StrictMode>,
);
