// The composition root: builds a new game's state from a scenario and game-data,
// and creates (or loads) a simulation with every registered system.
//
// The scenario supplies the seed and the start date (ADR 0012), and the opening
// balance sheet is booked as an OPENING_BALANCE transaction through the
// coordinator, so even the first ledger entry passes the commit-time invariants.

import {
  addMoney,
  idempotencyKey,
  tick,
  ZERO_MONEY,
  DYNAMIC_ID_KINDS,
  type DynamicIdKind,
  type FacilityState,
  type GameState,
  type LedgerEntry,
  type Money,
  type SaveGame,
  type TransactionCoordinator,
} from "@eov/contracts";
import { FIRST_SHIPMENT_SCENARIO, GAME_DATA, type GameData, type ScenarioDefinition } from "@eov/game-data";
import { createCoordinator } from "../economy/coordinator/coordinator.ts";
import { initialBuyers, initialMarkets, initialSuppliers } from "../economy/market/market.ts";
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

/** The scenario's state at tick 0, including the booked opening balance. */
export function createInitialState(
  scenario: ScenarioDefinition,
  data: GameData,
  coordinator: TransactionCoordinator = createCoordinator(),
): GameState {
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
  const vehicles = scenario.vehicleIds.map((id) => ({ id: find(data.vehicles, id, "vehicle").id, trip: null })).sort(byId);
  const markets = initialMarkets(data);
  const nextId = Object.fromEntries(DYNAMIC_ID_KINDS.map((k) => [k, 1])) as Record<DynamicIdKind, number>;

  const blank: GameState = {
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
      unlocked: [...scenario.family.unlocked].sort(),
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
    routes: data.routes.map((r) => ({ id: r.id, closure: null })).sort(byId),
    contractOffers: [],
    contracts: [],
    ledger: { transactions: [] },
    queuedCommands: [],
    commandLog: [],
    scheduledEvents: [],
    eventJournal: [],
  };

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
