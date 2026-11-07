// The progression system (T05e, issue #104; GDD §9 PROG-001; ADR 0020
// decisions 4, 5, and 8).
//
// Registered last in SYSTEMS, so its `deadlines` hook runs after contract
// settlement: reputation from this tick's sales and settlements, then tier
// promotion. Net worth only rises through sales (vehicles phase) and reputation
// only here, so a promotion lands on the tick its condition becomes true.
// T05f's (#105) victory runs in the same hook, after tier promotion; its
// insolvency check registers on `midnight`, last, after payroll and penalties.

import type { TransactionCoordinator } from "@eov/contracts";
import type { GameData } from "@eov/game-data";
import type { SystemRegistry } from "../kernel/registry.ts";
import { checkInsolvency } from "./insolvency.ts";
import { applyReputation } from "./reputation.ts";
import { promoteTiers } from "./tiers.ts";
import { checkVictory } from "./victory.ts";

export { applyReputation } from "./reputation.ts";
export { promoteTiers } from "./tiers.ts";

export function registerProgression(registry: SystemRegistry, data: GameData, coordinator: TransactionCoordinator): void {
  registry.onPhase("deadlines", "progression", (state, ctx) =>
    checkVictory(promoteTiers(applyReputation(state, data, coordinator, ctx), data, coordinator, ctx), data, coordinator, ctx),
  );
  registry.onPhase("midnight", "progression-insolvency", (state, ctx) => checkInsolvency(state, data, coordinator, ctx));
}
