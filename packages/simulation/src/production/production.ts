// The production system (T02c1, PROD-001; ADR 0017). The one entry SYSTEMS
// registers. Rules live in:
//
// - capacity.ts: throughput, job duration, storage, the rule 6 quantity bound;
// - jobs.ts: START_PRODUCTION and the production phase (completion and failure);
// - equipment.ts: PURCHASE_EQUIPMENT.
//
// T02c2 adds the workforce (crew factor, SET_WORKFORCE) and the midnight wage
// and overhead settlement.

import type { TransactionCoordinator } from "@eov/contracts";
import type { GameData } from "@eov/game-data";
import type { SystemRegistry } from "../kernel/registry.ts";
import { purchaseEquipmentHandler } from "./equipment.ts";
import { settleDueJobs, startProductionHandler } from "./jobs.ts";

export function registerProduction(registry: SystemRegistry, data: GameData, coordinator: TransactionCoordinator): void {
  registry.onCommand("START_PRODUCTION", startProductionHandler(data, coordinator));
  registry.onCommand("PURCHASE_EQUIPMENT", purchaseEquipmentHandler(data, coordinator));
  registry.onPhase("production", "production-jobs", settleDueJobs(data, coordinator));
}
