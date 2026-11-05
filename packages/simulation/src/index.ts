// @eov/simulation: the deterministic simulation engine.
// T01 provides the kernel: clock and calendar, command queue, SIM-001 tick
// order, event journal, seeded RNG, state hashing, and the system registry
// that economic systems (S0, T02*) plug into. S0 adds the composition root
// (newGame, loadGame), the S0 economic systems, and the snapshot projection.

import type { SaveGame, TransactionCoordinator } from "@eov/contracts";
import type { GameData } from "@eov/game-data";
import {
  createGameRegistry as createEconomyRegistry,
  loadGame as loadEconomyGame,
  newGame as newEconomyGame,
  simulationOptions as economySimulationOptions,
  SYSTEMS as ECONOMIC_SYSTEMS,
  type GameSetup,
  type SystemEntry,
} from "./game/index.ts";
import { PROJECTION_SYSTEM } from "./projection/index.ts";
import type { SystemRegistry } from "./kernel/registry.ts";
import type { KernelSimulation, SimulationOptions } from "./kernel/simulation.ts";

export {
  createSimulation,
  KernelError,
  KernelSimulation,
  loadSimulation,
  type ReplayResult,
  type SimulationOptions,
} from "./kernel/simulation.ts";
export {
  createRegistry,
  PHASES,
  RegistryError,
  SystemRegistry,
  type CommandContext,
  type CommandHandler,
  type CommandOfType,
  type CommandOutcome,
  type Phase,
  type PhaseHook,
  type Projection,
  type ProjectionContext,
  type TickContext,
  type WorldEventHandler,
} from "./kernel/registry.ts";
export { allocateId, formatId, ID_PREFIXES, idNumber } from "./kernel/ids.ts";
export { canonicalJson, CanonicalJsonError, fnv1a64Hex, hashState, STATE_HASH_ALGORITHM } from "./kernel/hash.ts";
export {
  addDays,
  assertValidCalendarDay,
  civilFromDays,
  clockAt,
  dateOfTick,
  daysFromCivil,
  daysInMonth,
  InvalidDateError,
  isLeapYear,
  type CalendarDay,
} from "./clock/calendar.ts";
export { assignCommandIdentity, compareEnvelopes } from "./commands/queue.ts";
export {
  emitEvent,
  emitEvents,
  EventEmissionError,
  eventsEmittedBetween,
  trimJournal,
  type EmitMeta,
} from "./events/journal.ts";
export {
  compareWorldEvents,
  scheduleWorldEvent,
  type WorldEventInput,
  type WorldEventKind,
  type WorldEventOfKind,
} from "./events/world-events.ts";
export {
  drawInt,
  InvalidSeedError,
  nextInt,
  nextIntBetween,
  nextUint32,
  seedRng,
  seedRngStreams,
} from "./rng/xoshiro128.ts";

// ---------------------------------------------------------------------------
// The composition root (S0a) with the snapshot projection (S0b)
// ---------------------------------------------------------------------------
//
// `src/game/` builds games from SYSTEMS, its list of economic systems. The
// projection isn't in that list (src/game/systems.ts belongs to S0a's owners),
// so the entry points below add it: every game created through this package
// can take snapshots. Moving PROJECTION_SYSTEM into game/systems.ts and
// dropping these wrappers is a one-line follow-up (see the S0b PR).

export {
  accountBalances,
  allocateRemovalCost,
  availableMaterial,
  availableProduct,
  balanceSheet,
  cashBalance,
  checkInvariants,
  CoordinatorError,
  createCoordinator,
  createInitialState,
  entryTotals,
  ScenarioSetupError,
  type AccountBalances,
  type BalanceSheet,
  type GameSetup,
  type RegisterSystem,
  type SystemEntry,
} from "./game/index.ts";
export {
  balanceSheetOf,
  cashFlowStatement,
  FinanceProjectionError,
  incomeStatement,
  PROJECTION_SYSTEM,
  projectFinance,
  projectSnapshot,
  registerProjection,
  SNAPSHOT_RECENT_TRANSACTIONS,
  UNDEFINED_IN_GAME_DATA,
  type ProjectionDeps,
} from "./projection/index.ts";

/** Every system a game runs: the economic systems, then the snapshot projection. */
export const SYSTEMS: readonly SystemEntry[] = [...ECONOMIC_SYSTEMS, PROJECTION_SYSTEM];

const withSystems = (setup: GameSetup): GameSetup => ({ ...setup, systems: setup.systems ?? SYSTEMS });

/** A registry with every system in SYSTEMS (default), sharing one coordinator. */
export function createGameRegistry(
  data: GameData,
  coordinator?: TransactionCoordinator,
  systems: readonly SystemEntry[] = SYSTEMS,
): SystemRegistry {
  return createEconomyRegistry(data, coordinator, systems);
}

export function simulationOptions(setup: GameSetup = {}): SimulationOptions {
  return economySimulationOptions(withSystems(setup));
}

/** A new game from the scenario (default: The First Shipment). */
export function newGame(setup: GameSetup = {}): KernelSimulation {
  return newEconomyGame(withSystems(setup));
}

/** Resumes a save. Validating the save (schema, hash) is persistence's job. */
export function loadGame(save: SaveGame, setup: GameSetup = {}): KernelSimulation {
  return loadEconomyGame(save, withSystems(setup));
}
