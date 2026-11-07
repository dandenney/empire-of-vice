// @eov/simulation: the deterministic simulation engine.
// T01 provides the kernel: clock and calendar, command queue, SIM-001 tick
// order, event journal, seeded RNG, state hashing, and the system registry
// that economic systems (S0, T02*) plug into. S0 adds the composition root
// (newGame, loadGame), the S0 economic systems, and the snapshot projection.

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
// `src/game/systems.ts` lists every system a game runs, the snapshot projection
// included, so every game created through this package can take snapshots.

export {
  accountBalances,
  allocateRemovalCost,
  availableMaterial,
  availableProduct,
  balanceSheet,
  cargoLossEntries,
  cashBalance,
  checkInvariants,
  CoordinatorError,
  createCoordinator,
  createGameRegistry,
  createInitialState,
  dispatchEntries,
  entryTotals,
  equipmentPurchaseEntries,
  impairmentEntries,
  ledgerBalances,
  loadGame,
  materialPurchaseEntries,
  newGame,
  payDownEntries,
  payOrAccrueEntries,
  productionEntries,
  productionWriteOffEntries,
  returnFromTransitEntries,
  saleEntries,
  ScenarioSetupError,
  simulationOptions,
  SYSTEMS,
  type AccountBalances,
  type BalanceSheet,
  type ExpenseAccount,
  type GameSetup,
  type PayOrAccrueCharge,
  type ProductionCosts,
  type RegisterSystem,
  type SaleAmounts,
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
  type ProjectionDeps,
} from "./projection/index.ts";
