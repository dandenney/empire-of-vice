// The test hook (architecture §4): test builds expose the current snapshot,
// the state hash, and the map scene on `window.__eov`, so Playwright can check
// game state and the map directly, not just the DOM. Never installed in a
// production build (see index.ts).
//
// Everything here is read-only, except `dispatchRaw`, which sends an
// unvalidated request through the gateway so tests can check that the worker
// rejects malformed commands before they reach the simulation.

import type { GameSnapshot } from "@eov/contracts";
import type { SceneShape } from "../map/placeholder-map.ts";
import type { DispatchOutcome, GatewayClient } from "../state/gateway-client.ts";
import type { SprintZeroUi } from "./sprint-zero-ui.ts";

export interface EovTestHook {
  readonly snapshot: GameSnapshot | null;
  readonly stateHash: string | null;
  readonly scene: readonly SceneShape[];
  dispatchRaw(request: unknown): Promise<DispatchOutcome>;
}

declare global {
  interface Window {
    __eov?: EovTestHook;
  }
}

export function installTestHook(gateway: GatewayClient, ui: SprintZeroUi): void {
  const hook: EovTestHook = {
    get snapshot() {
      return gateway.view.snapshot;
    },
    get stateHash() {
      return gateway.view.stateHash;
    },
    get scene() {
      return ui.scene();
    },
    dispatchRaw: (request) => gateway.dispatch(request),
  };
  window.__eov = hook;
}
