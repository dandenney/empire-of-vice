// The production system (T02c1 and T02c2, PROD-001; ADR 0017). The one entry
// SYSTEMS registers. Rules live in:
//
// - capacity.ts: throughput and the crew factor, job duration, storage, the
//   rule 6 quantity bound;
// - jobs.ts: START_PRODUCTION and the production phase (completion and failure);
// - equipment.ts: PURCHASE_EQUIPMENT and SELL_EQUIPMENT;
// - workforce.ts: SET_WORKFORCE;
// - settlement.ts: the midnight wage and overhead settlement.

import type { TransactionCoordinator } from "@eov/contracts";
import type { GameData } from "@eov/game-data";
import type { SystemRegistry } from "../kernel/registry.ts";
import { purchaseEquipmentHandler, sellEquipmentHandler } from "./equipment.ts";
import { settleDueJobs, startProductionHandler } from "./jobs.ts";
import { settleDay } from "./settlement.ts";
import { setWorkforceHandler } from "./workforce.ts";

export function registerProduction(registry: SystemRegistry, data: GameData, coordinator: TransactionCoordinator): void {
  registry.onCommand("START_PRODUCTION", startProductionHandler(data, coordinator));
  registry.onCommand("PURCHASE_EQUIPMENT", purchaseEquipmentHandler(data, coordinator));
  registry.onCommand("SELL_EQUIPMENT", sellEquipmentHandler(data, coordinator));
  registry.onCommand("SET_WORKFORCE", setWorkforceHandler(data, coordinator));
  registry.onPhase("production", "production-jobs", settleDueJobs(data, coordinator));
  // After the market's midnight hook (registered first in SYSTEMS), ADR 0017 decision 9.
  registry.onPhase("midnight", "production-daily-settlement", settleDay(data, coordinator));
}
