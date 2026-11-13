// The test hook (architecture §4): test builds expose game state, the speed
// scheduler, and the map's queries on `window.__eov`, so Playwright can check
// them directly, not just the DOM. Never installed in a production build (see
// index.tsx).
//
// Read-only, except:
//   - `dispatchRaw` sends an unvalidated request through the gateway, so tests
//     can check that the worker rejects malformed commands before they reach
//     the simulation, and drive commands without clicking through panels.
//   - `advance(ticks)` pauses the scheduler, then runs exactly `ticks` ticks,
//     for deterministic tests (ADR 0014 decision 7).

import type { GameSnapshot, PlayerSnapshot } from "@eov/contracts";
import type { SceneShape } from "../map/scene.ts";
import type { DispatchOutcome, GatewayClient } from "../state/gateway-client.ts";
import type { SchedulerStatus } from "../workers/scheduler.ts";

/** Whatever the map exposes for tests: the PixiJS map's queries (src/app/map-slot.tsx). */
export type MapQueries = Readonly<Record<string, (...args: never[]) => unknown>>;

export interface EovTestHook {
  /** The world snapshot (world rules); null under founder rules. */
  readonly snapshot: GameSnapshot | null;
  /** The player snapshot (founder rules); null under world rules. */
  readonly playerSnapshot: PlayerSnapshot | null;
  readonly stateHash: string | null;
  readonly scheduler: SchedulerStatus;
  /** The installed map's queries, or null before a map registers. */
  readonly map: MapQueries | null;
  /** The map's world-unit scene (`map.scene()`), kept as `__eov.scene` for the Sprint Zero spec. */
  readonly scene: readonly SceneShape[];
  dispatchRaw(request: unknown): Promise<DispatchOutcome>;
  advance(ticks: number): Promise<void>;
  registerMap(queries: MapQueries): void;
}

declare global {
  interface Window {
    __eov?: EovTestHook;
  }
}

let mapQueries: MapQueries | null = null;

/**
 * Installs the map's test queries as `window.__eov.map`. Safe to call in any
 * build: without the hook it only remembers them.
 */
export function registerMap(queries: MapQueries): void {
  mapQueries = queries;
}

export function installTestHook(gateway: GatewayClient): void {
  const hook: EovTestHook = {
    get snapshot() {
      return gateway.view.snapshot;
    },
    get playerSnapshot() {
      return gateway.view.playerSnapshot;
    },
    get stateHash() {
      return gateway.view.stateHash;
    },
    get scheduler() {
      return gateway.view.scheduler;
    },
    get map() {
      return mapQueries;
    },
    get scene() {
      const scene = mapQueries?.["scene"];
      return typeof scene === "function" ? (scene() as readonly SceneShape[]) : [];
    },
    dispatchRaw: (request) => gateway.dispatch(request),
    advance: (ticks) => gateway.advance(ticks),
    registerMap,
  };
  window.__eov = hook;
}
