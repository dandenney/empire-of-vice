// The projections, registered with the kernel: the world snapshot (ADR 0007),
// the player snapshot (ADR 0021 decision 8), and, with founder rules on, the
// knowledge steps that keep `GameState.knowledge` (ADR 0021 decisions 5–8).

import type { TransactionCoordinator } from "@eov/contracts";
import type { GameData } from "@eov/game-data";
import { commandRecorded, tickEnd } from "../knowledge/system.ts";
import type { SystemRegistry } from "../kernel/registry.ts";
import { M001_RULES, type GameRules } from "../kernel/rules.ts";
import { projectPlayerSnapshot } from "./player-snapshot.ts";
import { projectSnapshot } from "./snapshot.ts";

export { balanceSheetOf, cashFlowStatement, FinanceProjectionError, incomeStatement, projectFinance, SNAPSHOT_RECENT_TRANSACTIONS } from "./finance.ts";
export { projectPlayerSnapshot, type PlayerProjectionDeps } from "./player-snapshot.ts";
export { projectSnapshot, type ProjectionDeps } from "./snapshot.ts";

/**
 * A RegisterSystem (game/systems.ts) that sets the registry's projections, and
 * with founder rules on the knowledge steps. With them off nothing writes
 * knowledge, so the state (and every hash) is as before.
 */
export function registerProjection(registry: SystemRegistry, data: GameData, _coordinator?: TransactionCoordinator, rules: GameRules = M001_RULES): void {
  registry.setProjection((state, ctx) => projectSnapshot(state, ctx, { data, registry }));
  registry.setPlayerProjection((state, ctx) => projectPlayerSnapshot(state, ctx, { data, founderRules: rules.founderRules }));
  if (rules.founderRules) {
    registry.setKnowledge({
      commandRecorded,
      tickEnd: (state, ctx) => tickEnd(state, data, ctx.tick),
    });
  }
}

export const PROJECTION_SYSTEM = { name: "snapshot projection (S0b)", register: registerProjection } as const;
