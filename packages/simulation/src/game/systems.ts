// The composition root's system list: every system that plugs into the kernel.
//
// To add a system, append one line to SYSTEMS. Registration order is the order
// hooks run within a phase (registry.ts), so it's part of the rules: append,
// don't reorder, unless the PR says why.

import type { TransactionCoordinator } from "@eov/contracts";
import type { GameData } from "@eov/game-data";
import { registerRepeat } from "../commands/repeat.ts";
import { registerContracts } from "../contracts/index.ts";
import { registerShakedown } from "../events/shakedown.ts";
import { createCoordinator } from "../economy/coordinator/coordinator.ts";
import { registerFounder } from "../founder/founder.ts";
import { registerMarket } from "../economy/market/market.ts";
import { registerInventory } from "../inventory/release.ts";
import { createRegistry, type SystemRegistry } from "../kernel/registry.ts";
import { M001_RULES, type GameRules } from "../kernel/rules.ts";
import { registerLogistics } from "../logistics/logistics.ts";
import { registerProduction } from "../production/production.ts";
import { registerProgression } from "../progression/index.ts";
import { PROJECTION_SYSTEM } from "../projection/index.ts";

/** Registers a system's hooks and handlers. `rules` are the scenario's switches (ADR 0023 decision 9); most systems ignore them. */
export type RegisterSystem = (registry: SystemRegistry, data: GameData, coordinator: TransactionCoordinator, rules: GameRules) => void;

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
  { name: "inventory (T02a)", register: registerInventory },
  { name: "contracts (T02e)", register: registerContracts },
  { name: "repeat orders (T05c)", register: registerRepeat },
  { name: "progression (T05e)", register: registerProgression },
  { name: "shakedown (T07f)", register: registerShakedown },
  { name: "founder (SK1a)", register: registerFounder },
];

/** A registry with every system in SYSTEMS, sharing one coordinator, under the scenario's rules (default: M001's). */
export function createGameRegistry(
  data: GameData,
  coordinator: TransactionCoordinator = createCoordinator(),
  systems: readonly SystemEntry[] = SYSTEMS,
  rules: GameRules = M001_RULES,
): SystemRegistry {
  const registry = createRegistry();
  for (const system of systems) system.register(registry, data, coordinator, rules);
  return registry;
}
