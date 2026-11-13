// The composition root: builds a new game's state from a scenario and game-data,
// and creates (or loads) a simulation with every registered system.
//
// The scenario supplies the seed and the start date (ADR 0012), and the opening
// balance sheet is booked as an OPENING_BALANCE transaction through the
// coordinator, so even the first ledger entry passes the commit-time invariants.
// The scenario is checked against game-data first, and its world events are
// scheduled at tick 0 (ADR 0020 decision 12).

import {
  addMoney,
  compareIds,
  EMPTY_KNOWLEDGE,
  idempotencyKey,
  RATIO_SCALE,
  tick,
  ZERO_MONEY,
  DYNAMIC_ID_KINDS,
  type DynamicIdKind,
  type FacilityState,
  type FounderState,
  type GameState,
  type LedgerEntry,
  type Money,
  type SaveGame,
  type TransactionCoordinator,
  type UnlockId,
} from "@eov/contracts";
import { FIRST_SHIPMENT_SCENARIO, GAME_DATA, START_WAKE_TICK, type GameData, type ScenarioDefinition } from "@eov/game-data";
import { createCoordinator } from "../economy/coordinator/coordinator.ts";
import { initialBuyers, initialMarkets, initialSuppliers } from "../economy/market/market.ts";
import { scheduleWorldEvent } from "../events/world-events.ts";
import { createSimulation, loadSimulation, type KernelSimulation, type SimulationOptions } from "../kernel/simulation.ts";
import { seedRngStreams } from "../rng/xoshiro128.ts";
import { createGameRegistry, SYSTEMS, type SystemEntry } from "./systems.ts";

export interface GameSetup {
  readonly scenario?: ScenarioDefinition;
  readonly data?: GameData;
  /** Defaults to SYSTEMS. Tests can pass a different list. */
  readonly systems?: readonly SystemEntry[];
}

export class ScenarioSetupError extends RangeError {
  override readonly name = "ScenarioSetupError";
}

const byId = <T extends { readonly id: string }>(a: T, b: T): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function find<T extends { readonly id: string }>(list: readonly T[], id: string, what: string): T {
  const found = list.find((x) => x.id === id);
  if (!found) throw new ScenarioSetupError(`Scenario references unknown ${what} ${id}`);
  return found;
}

/**
 * The scenario checks that need game-data (ADR 0020 decision 12), so a bad
 * scenario fails when it loads, not inside a tick. Returns the family's
 * starting unlocks, sorted by `compareIds`.
 */
function validateScenario(scenario: ScenarioDefinition, data: GameData): readonly UnlockId[] {
  for (const [i, event] of scenario.scheduledEvents.entries()) {
    const where = `Scenario scheduledEvents[${i}] (${event.kind})`;
    if (event.tick < 1) throw new ScenarioSetupError(`${where} is at tick ${event.tick}; scheduled events start at tick 1`);
    if (event.kind === "SHAKEDOWN") {
      // A share of net worth: more than all of it means nothing (issue #129).
      if (!Number.isSafeInteger(event.netWorthSharePpm) || event.netWorthSharePpm < 1 || event.netWorthSharePpm > RATIO_SCALE) {
        throw new ScenarioSetupError(`${where} has netWorthSharePpm ${event.netWorthSharePpm}; it must be 1..${RATIO_SCALE}`);
      }
      continue;
    }
    if (!data.routes.some((r) => r.id === event.routeId)) throw new ScenarioSetupError(`${where} names unknown route ${event.routeId}`);
    if (!Number.isSafeInteger(event.durationTicks) || event.durationTicks < 1) {
      throw new ScenarioSetupError(`${where} has duration ${event.durationTicks}; it must be at least 1 tick`);
    }
  }
  find(data.families, scenario.family.id, "family");
  find(data.locations, scenario.founderStartLocationId, "founder start location");
  const tiers = data.progression.tiers;
  const tierIndex = tiers.findIndex((t) => t.id === scenario.family.tierId);
  if (tierIndex < 0) throw new ScenarioSetupError(`Scenario references unknown tier ${scenario.family.tierId}`);
  const expected = [...new Set(tiers.slice(0, tierIndex + 1).flatMap((t) => t.unlocks))].sort(compareIds);
  const given = [...scenario.family.unlocked].sort(compareIds);
  if (given.length !== expected.length || given.some((u, i) => u !== expected[i])) {
    throw new ScenarioSetupError(
      `Scenario family.unlocked [${given.join(", ")}] isn't tier ${scenario.family.tierId}'s cumulative unlocks [${expected.join(", ")}]`,
    );
  }
  return expected;
}

/**
 * The routes a scenario's game has state for (T03b, #76): those whose two ends
 * the scenario occupies, with an owned facility, a supplier, or a buyer, as the
 * snapshot does for locations. A route to an unowned warehouse gets no state.
 * A scheduled closure must name one of these routes.
 */
function occupiedRoutes(scenario: ScenarioDefinition, data: GameData): GameData["routes"] {
  const occupied = new Set<string>();
  for (const f of scenario.facilities) occupied.add(find(data.facilities, f.id, "facility").locationId);
  for (const id of scenario.supplierIds) occupied.add(find(data.suppliers, id, "supplier").locationId);
  for (const id of scenario.buyerIds) occupied.add(find(data.buyers, id, "buyer").locationId);
  const routes = data.routes.filter((r) => occupied.has(r.fromLocationId) && occupied.has(r.toLocationId));
  scenario.scheduledEvents.forEach((event, i) => {
    if (event.kind === "ROUTE_CLOSURE" && !routes.some((r) => r.id === event.routeId)) {
      throw new ScenarioSetupError(`Scenario scheduledEvents[${i}] (${event.kind}) names route ${event.routeId}, which has an end the scenario doesn't occupy`);
    }
  });
  return routes;
}

/**
 * The founder at tick 0 (ADR 0023 decisions 7 and 9), at the scenario's start
 * location. With founder rules on, a new game starts with the founder resting
 * from 00:00 until START_WAKE_TICK, so the first morning starts naturally. With
 * them off (M001), the founder state never changes, so the founder is simply
 * there, not busy, as a migrated M001 save has it (decision 10).
 */
function initialFounder(scenario: ScenarioDefinition): FounderState {
  const locationId = scenario.founderStartLocationId;
  return {
    whereabouts: scenario.founderRules
      ? { kind: "RESTING", locationId, startedAt: tick(0), until: tick(START_WAKE_TICK) }
      : { kind: "PRESENT", locationId, busy: null },
    awakeSince: tick(0),
  };
}

/** The scenario's state at tick 0, including the booked opening balance. */
export function createInitialState(
  scenario: ScenarioDefinition,
  data: GameData,
  coordinator: TransactionCoordinator = createCoordinator(),
): GameState {
  const unlocked = validateScenario(scenario, data);
  const facilities: FacilityState[] = scenario.facilities
    .map((f) => {
      find(data.facilities, f.id, "facility");
      return {
        id: f.id,
        equipment: f.equipmentIds.map((equipmentId) => ({ equipmentId, bookValue: find(data.equipment, equipmentId, "equipment").price })),
        workerCount: f.workerCount,
      };
    })
    .sort(byId);
  // Every vehicle starts parked at its home facility (ADR 0023 decision 1).
  const vehicles = scenario.vehicleIds
    .map((id) => {
      const vehicle = find(data.vehicles, id, "vehicle");
      const parkedAt = find(data.facilities, vehicle.homeFacilityId, "facility").locationId;
      return { id: vehicle.id, parkedAt, trip: null };
    })
    .sort(byId);
  const markets = initialMarkets(data);
  const nextId = Object.fromEntries(DYNAMIC_ID_KINDS.map((k) => [k, 1])) as Record<DynamicIdKind, number>;

  const empty: GameState = {
    scenarioId: scenario.id,
    seed: scenario.seed,
    tick: tick(0),
    outcome: { status: "PLAYING" },
    counters: { nextCommandSequence: 1, nextScheduleSequence: 1, nextId },
    rng: seedRngStreams(scenario.seed),
    family: {
      id: scenario.family.id,
      reputation: scenario.family.reputation,
      tierId: scenario.family.tierId,
      unlocked: [...unlocked],
      firstQualifyingDeliveryMade: false,
      consecutiveFulfilledInstallments: 0,
    },
    facilities,
    productPools: [],
    materialPools: [],
    reservations: [],
    productionJobs: [],
    vehicles,
    deliveries: [],
    markets,
    suppliers: initialSuppliers(data, scenario),
    buyers: initialBuyers(data, scenario, markets),
    routes: occupiedRoutes(scenario, data).map((r) => ({ id: r.id, closure: null })).sort(byId),
    contractOffers: [],
    contracts: [],
    ledger: { transactions: [] },
    queuedCommands: [],
    commandLog: [],
    scheduledEvents: [],
    eventJournal: [],
    // Nothing is known yet; the live view shows the founder's place at once (ADR 0021 decision 5).
    knowledge: EMPTY_KNOWLEDGE,
    founder: initialFounder(scenario),
  };
  // The scenario's world events, in file order (ADR 0020 decision 12).
  const blank = scenario.scheduledEvents.reduce<GameState>(
    (s, e) =>
      scheduleWorldEvent(
        s,
        e.kind === "SHAKEDOWN"
          ? { kind: e.kind, tick: e.tick, reason: e.reason, netWorthSharePpm: e.netWorthSharePpm }
          : { kind: e.kind, tick: e.tick, routeId: e.routeId, reason: e.reason, durationTicks: e.durationTicks },
      ),
    empty,
  );

  // Opening balance sheet: cash and buildings from the scenario, equipment and
  // vehicles at their definitions' values, equity balancing the sheet.
  const sum = (amounts: readonly Money[]): Money => amounts.reduce((a, b) => addMoney(a, b), ZERO_MONEY);
  const equipment = sum(facilities.flatMap((f) => f.equipment.map((e) => e.bookValue)));
  const vehicleValue = sum(vehicles.map((v) => find(data.vehicles, v.id, "vehicle").bookValue));
  const debits: LedgerEntry[] = (
    [
      ["CASH", scenario.openingBalance.cash],
      ["EQUIPMENT", equipment],
      ["VEHICLES", vehicleValue],
      ["FACILITIES", scenario.openingBalance.buildings],
    ] as const
  )
    .filter(([, amount]) => amount > 0)
    .map(([account, amount]) => ({ account, side: "DEBIT", amount }));
  const equity = sum(debits.map((e) => e.amount));

  const tx = coordinator.begin(blank, {
    kind: "OPENING_BALANCE",
    idempotencyKey: idempotencyKey("OPENING_BALANCE", scenario.id),
    tick: tick(0),
    causedBy: null,
  });
  if (tx.status === "duplicate") throw new ScenarioSetupError("A blank state can't already have an opening balance");
  if (equity > 0) tx.post([...debits, { account: "OWNER_EQUITY", side: "CREDIT", amount: equity }]);
  const result = tx.commit();
  if (result.status !== "committed") throw new ScenarioSetupError(`Opening balance rejected: ${result.reason.code}`);
  return result.state;
}

export function simulationOptions(setup: GameSetup = {}): SimulationOptions {
  const scenario = setup.scenario ?? FIRST_SHIPMENT_SCENARIO;
  const data = setup.data ?? GAME_DATA;
  return {
    registry: createGameRegistry(data, createCoordinator(), setup.systems ?? SYSTEMS),
    startDate: scenario.startDate,
    gameDataVersion: data.version,
  };
}

/** A new game from the scenario (default: The First Shipment). */
export function newGame(setup: GameSetup = {}): KernelSimulation {
  const scenario = setup.scenario ?? FIRST_SHIPMENT_SCENARIO;
  const data = setup.data ?? GAME_DATA;
  return createSimulation(createInitialState(scenario, data), simulationOptions(setup));
}

/**
 * Resumes a save. The scenario supplies the start date, as for a new game.
 * Validating the save (schema, hash) is persistence's job.
 */
export function loadGame(save: SaveGame, setup: GameSetup = {}): KernelSimulation {
  const scenario = setup.scenario ?? FIRST_SHIPMENT_SCENARIO;
  if (save.scenarioId !== scenario.id) {
    throw new ScenarioSetupError(`Save is for scenario ${save.scenarioId}, not ${scenario.id}`);
  }
  return loadSimulation(save, simulationOptions(setup));
}
