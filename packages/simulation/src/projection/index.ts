// The snapshot projection (ADR 0007), registered with the kernel's projection hook.

import type { GameData } from "@eov/game-data";
import type { SystemRegistry } from "../kernel/registry.ts";
import { projectSnapshot } from "./snapshot.ts";

export { balanceSheetOf, cashFlowStatement, FinanceProjectionError, incomeStatement, projectFinance, SNAPSHOT_RECENT_TRANSACTIONS } from "./finance.ts";
export { projectSnapshot, UNDEFINED_IN_GAME_DATA, type ProjectionDeps } from "./snapshot.ts";

/** A RegisterSystem (game/systems.ts) that sets the registry's projection. */
export function registerProjection(registry: SystemRegistry, data: GameData): void {
  registry.setProjection((state, ctx) => projectSnapshot(state, ctx, { data, registry }));
}

export const PROJECTION_SYSTEM = { name: "snapshot projection (S0b)", register: registerProjection } as const;
