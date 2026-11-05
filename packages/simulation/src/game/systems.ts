// The composition root's system list: every system that plugs into the kernel.
//
// To add a system, append one line to SYSTEMS. Registration order is the order
// hooks run within a phase (registry.ts), so it's part of the rules: append,
// don't reorder, unless the PR says why.

import type { TransactionCoordinator } from "@eov/contracts";
import type { GameData } from "@eov/game-data";
import { createCoordinator } from "../economy/coordinator/coordinator.ts";
import { registerMarket } from "../economy/market/market.ts";
import { createRegistry, type SystemRegistry } from "../kernel/registry.ts";
import { registerLogistics } from "../logistics/logistics.ts";
import { registerProduction } from "../production/production.ts";
import { PROJECTION_SYSTEM } from "../projection/index.ts";

export type RegisterSystem = (registry: SystemRegistry, data: GameData, coordinator: TransactionCoordinator) => void;

export interface SystemEntry {
  /** Who owns the system, for readers and error messages. */
  readonly name: string;
  readonly register: RegisterSystem;
}

export const SYSTEMS: readonly SystemEntry[] = [
  { name: "market (S0 stub, T02d)", register: registerMarket },
  { name: "production (S0 stub, T02c)", register: registerProduction },
  { name: "logistics (S0 stub, T03)", register: registerLogistics },
  PROJECTION_SYSTEM,
];

/** A registry with every system in SYSTEMS, sharing one coordinator. */
export function createGameRegistry(
  data: GameData,
  coordinator: TransactionCoordinator = createCoordinator(),
  systems: readonly SystemEntry[] = SYSTEMS,
): SystemRegistry {
  const registry = createRegistry();
  for (const system of systems) system.register(registry, data, coordinator);
  return registry;
}
