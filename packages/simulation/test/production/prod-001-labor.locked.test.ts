// @locked
// PROD-001 acceptance tests for T02c2 (issue #63): workforce, leaders, and the
// midnight wage and overhead settlement. Covers the crew factor in throughput
// and job duration, SET_WORKFORCE's rejections, commit and no-op, the three
// midnight transactions (wages, overhead, payroll paydown) with DAY_SETTLED and
// their cash-flow categories, leaders' skill and loyalty in the snapshot, the
// Sprint Zero hash, and rule 6 on every rejection. Rules come from GDD §6
// (PROD-001) and §10, SIM-001, FIN-001, ADR 0015, ADR 0016 and ADR 0017
// decisions 1, 7, 8, 9 and 10.
//
// Written ahead of the implementation by a separate test-writer agent
// (factory.md §2, §7.3). Do not edit (CLAUDE.md rule 9).
//
// Imports are limited to `src/production/index.ts`, `src/inventory/index.ts`,
// the public package entry `src/index.ts`, and `@eov/contracts` and
// `@eov/game-data`.
//
// Expected numbers are derived from game-data and the ADR 0017 formulas, so
// placeholder tuning can change without breaking these tests. Two tests pin
// literals on purpose: the shipped crew numbers the issue names (still 3,
// condenser 1, QC station 0, storage expansion 0, and so 1.05× / 1.4× / 1 372
// ticks / 10 a day), and the Sprint Zero hash `fnv1a64:cc8a53a058022ea5`.
//
// API these tests assume. (issue) marks names the issue or ADR fixes. The rest
// are the test-writer's choice.
//
// @eov/game-data (issue). These fields don't exist on main, so the tests read
// them through `num(obj, name)` and build fixtures with loose patches. That
// keeps this file compiling before and after they're added.
//   `EquipmentDefinition.crew: number` (still 3, condenser 1, QC station 0,
//     storage expansion 0).
//   `FacilityProductionDefinition.maximumWorkers: number` and
//     `FacilityProductionDefinition.dailyOverhead: Money`.
//   `CharacterDefinition.skill: number` and `CharacterDefinition.loyalty: number`
//     (integers 0–100). `GAME_DATA.characters` are the family's leaders.
//   `GAME_DATA.workforce.workerDailyWage` (existing).
//
// src/production/index.ts (existing, T02c1):
//   `throughput(state, data, facilityId): Ratio` now returns the displayed ratio,
//     floor(base × staffed / crew), with base = RATIO_SCALE + Σ throughputBonus,
//     crew = Σ owned crew, staffed = min(workerCount, crew); 1× crew factor when
//     crew = 0; 0 when the facility owns no recipe equipment, or crew > 0 and
//     staffed = 0.
//   `productionCapacityPerDay(state, data, facilityId)` uses that displayed ratio.
//   Job durations are checked through START_PRODUCTION (completesAt − startedAt),
//     not through `jobDuration`, so its new signature is the implementer's choice.
//
// src/index.ts (existing): `newGame`, `createSimulation`, `simulationOptions`,
//   `createCoordinator`, `accountBalances`, `cashBalance`, `cashFlowStatement`,
//   `payOrAccrueEntries`, `payDownEntries`, `allocateId`.
//
// Contract behaviour (no contract change):
//   SET_WORKFORCE checks, in order: INVALID_QUANTITY { field: "workerCount" } for
//   a count that isn't a non-negative safe integer → UNKNOWN_ENTITY Facility →
//   WORKFORCE_LIMIT_EXCEEDED { facilityId, requested, maximum } → while a job
//   runs at the facility, INVALID_QUANTITY { field: "workerCount" } below
//   min(workerCount, crew). A changed count commits an entry-free
//   DAILY_SETTLEMENT transaction keyed `DAILY_SETTLEMENT:WORKFORCE:<commandId>`
//   with one WORKFORCE_CHANGED { facilityId, from, to }. The current count is an
//   applied no-op: no transaction, no event, no state change but the command log.
//
//   At each midnight tick T (day = dayIndex(T) − 1), after the market's
//   DAILY_SETTLEMENT:MARKET:<dayIndex(T)>, three DAILY_SETTLEMENT transactions in
//   order: WAGES:<day> (skipped at 0), OVERHEAD:<day> (skipped at 0), and
//   PAYROLL:<day> (always) carrying DAY_SETTLED.
//
// Expected to fail until T02c2 lands: SET_WORKFORCE has no handler, workers
// don't affect throughput, there's no midnight settlement, the snapshot's
// leaders are empty and its workforce maximum is a stub, and the game-data
// fields above don't exist.

import {
  asId,
  cents,
  compareIds,
  idempotencyKey,
  RATIO_SCALE,
  tick,
  TICKS_PER_DAY,
  ZERO_MONEY,
  type CashFlowCategory,
  type CommandResult,
  type EquipmentId,
  type FacilityId,
  type FacilitySnapshot,
  type GameCommand,
  type GameEvent,
  type GameState,
  type LedgerAccount,
  type LedgerEntry,
  type LedgerTransaction,
  type Money,
  type ProductionJobState,
  type RejectionReason,
  type TransactionKind,
} from "@eov/contracts";
import {
  BASIC_MOONSHINE_RECIPE,
  COPPER_STILL,
  CROSSROADS_ROADHOUSE,
  DISTILLERY_MAIN,
  FIRST_SHIPMENT_SCENARIO,
  GAME_DATA,
  MILLERS_FEED,
  MODEL_TT_TRUCK,
  type CharacterDefinition,
  type EquipmentDefinition,
  type FacilityProductionDefinition,
  type GameData,
  type RecipeDefinition,
  type ScenarioDefinition,
} from "@eov/game-data";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addMaterial } from "../../src/inventory/index.ts";
import { productionCapacityPerDay, throughput } from "../../src/production/index.ts";
import {
  accountBalances,
  allocateId,
  cashBalance,
  cashFlowStatement,
  createCoordinator,
  createSimulation,
  newGame,
  payDownEntries,
  payOrAccrueEntries,
  simulationOptions,
  type GameSetup,
  type KernelSimulation,
} from "../../src/index.ts";

// ---------------------------------------------------------------------------
// Constants and lookups
// ---------------------------------------------------------------------------

const MAX = Number.MAX_SAFE_INTEGER;
const PPM = RATIO_SCALE;
const SPRINT_ZERO_HASH = "fnv1a64:cc8a53a058022ea5";
const UNKNOWN_FACILITY = asId("Facility", "fixture-nowhere");

type Loose = Readonly<Record<string, unknown>>;

/** A numeric field that T02c2 adds to a game-data definition. Throws (a clear failure) while it's missing. */
function num(obj: object, name: string): number {
  const v = (obj as unknown as Loose)[name];
  if (typeof v !== "number") throw new Error(`Expected a numeric "${name}" on ${JSON.stringify(obj)}`);
  return v;
}

const crewOf = (e: EquipmentDefinition): number => num(e, "crew");

function recipeById(id: string, data: GameData = GAME_DATA): RecipeDefinition {
  const r = data.recipes.find((x) => x.id === id);
  if (!r) throw new Error(`No recipe ${id}`);
  return r;
}

const basic = (data: GameData = GAME_DATA): RecipeDefinition => recipeById(BASIC_MOONSHINE_RECIPE, data);

function equipmentDef(id: EquipmentId, data: GameData = GAME_DATA): EquipmentDefinition {
  const e = data.equipment.find((x) => x.id === id);
  if (!e) throw new Error(`No equipment ${id}`);
  return e;
}

/** The improved condenser: the one item with a throughput bonus. */
function condenser(): EquipmentDefinition {
  const found = GAME_DATA.equipment.filter((e) => e.throughputBonus > 0);
  if (found.length !== 1) throw new Error(`Expected one equipment item with a throughput bonus, found ${found.length}`);
  return found[0]!;
}

/** The storage expansion: the one item with a storage bonus. */
function expansion(): EquipmentDefinition {
  const found = GAME_DATA.equipment.filter((e) => e.storageBonus > 0);
  if (found.length !== 1) throw new Error(`Expected one equipment item with a storage bonus, found ${found.length}`);
  return found[0]!;
}

/** The QC station: the one item that is neither the still, the condenser, nor the expansion. */
function qcStation(): EquipmentDefinition {
  const found = GAME_DATA.equipment.filter((e) => e.id !== COPPER_STILL && e.throughputBonus === 0 && e.storageBonus === 0);
  if (found.length !== 1) throw new Error(`Expected one QC station, found ${found.length}`);
  return found[0]!;
}

function facilitySpec(data: GameData = GAME_DATA, facilityId: FacilityId = DISTILLERY_MAIN): FacilityProductionDefinition {
  const spec = data.facilityProduction.find((f) => f.facilityId === facilityId);
  if (!spec) throw new Error(`No production spec for ${facilityId}`);
  return spec;
}

const maximumWorkers = (data: GameData = GAME_DATA): number => num(facilitySpec(data), "maximumWorkers");
const dailyOverhead = (data: GameData = GAME_DATA): number => num(facilitySpec(data), "dailyOverhead");

function facilityState(state: GameState, facilityId: FacilityId = DISTILLERY_MAIN) {
  const f = state.facilities.find((x) => x.id === facilityId);
  if (!f) throw new Error(`No facility ${facilityId}`);
  return f;
}

const workersAt = (state: GameState): number => facilityState(state).workerCount;

function owned(state: GameState): readonly EquipmentId[] {
  return facilityState(state).equipment.map((e) => e.equipmentId);
}

const startingWorkers = (): number => FIRST_SHIPMENT_SCENARIO.facilities.find((f) => f.id === DISTILLERY_MAIN)!.workerCount;

// ---------------------------------------------------------------------------
// The ADR 0017 formulas, computed independently of the code under test
// ---------------------------------------------------------------------------

interface CrewTerms {
  readonly base: number;
  readonly crew: number;
  readonly staffed: number;
}

/** base = RATIO_SCALE + Σ throughputBonus, crew = Σ crew, staffed = min(workers, crew). */
function crewTerms(state: GameState, data: GameData = GAME_DATA): CrewTerms {
  const items = owned(state).map((id) => equipmentDef(id, data));
  const base = items.reduce((n, e) => n + e.throughputBonus, PPM);
  const crew = items.reduce((n, e) => n + crewOf(e), 0);
  return { base, crew, staffed: Math.min(workersAt(state), crew) };
}

/** ceil(ticksPerCase × q × RATIO_SCALE × crew / (base × staffed)), exactly; crew = staffed = 1 when crew = 0. */
function crewDuration(ticksPerCase: number, quantity: number, t: CrewTerms): number {
  const crew = t.crew === 0 ? 1 : t.crew;
  const staffed = t.crew === 0 ? 1 : t.staffed;
  const num_ = BigInt(ticksPerCase) * BigInt(quantity) * BigInt(PPM) * BigInt(crew);
  const den = BigInt(t.base) * BigInt(staffed);
  return Number((num_ + den - 1n) / den);
}

/** The displayed ratio: floor(base × staffed / crew); base when crew = 0. */
function displayedRatio(t: CrewTerms): number {
  if (t.crew === 0) return t.base;
  return Number((BigInt(t.base) * BigInt(t.staffed)) / BigInt(t.crew));
}

/** floor(TICKS_PER_DAY × ratio / (ticksPerCase × RATIO_SCALE)). */
function casesPerDay(ticksPerCase: number, ratioPpm: number): number {
  return Number((BigInt(TICKS_PER_DAY) * BigInt(ratioPpm)) / (BigInt(ticksPerCase) * BigInt(PPM)));
}

/** Tonight's wages: Σ leaders' dailyWage + Σ facilities' workerCount × workerDailyWage. */
function wagesDue(state: GameState, data: GameData = GAME_DATA): number {
  const leaders = data.characters.reduce((n, c) => n + c.dailyWage, 0);
  return state.facilities.reduce((n, f) => n + f.workerCount * data.workforce.workerDailyWage, leaders);
}

/** Tonight's overhead: Σ facilities' dailyOverhead. */
function overheadDue(state: GameState, data: GameData = GAME_DATA): number {
  return state.facilities.reduce((n, f) => n + num(facilitySpec(data, f.id), "dailyOverhead"), 0);
}

// ---------------------------------------------------------------------------
// Fixture data (built by spreading GAME_DATA)
// ---------------------------------------------------------------------------

function withEquipment(id: EquipmentId, patch: Loose, data: GameData = GAME_DATA): GameData {
  return { ...data, equipment: data.equipment.map((e) => (e.id === id ? ({ ...e, ...patch } as EquipmentDefinition) : e)) };
}

function withFacilitySpec(patch: Loose, data: GameData = GAME_DATA): GameData {
  return {
    ...data,
    facilityProduction: data.facilityProduction.map((f) => (f.facilityId === DISTILLERY_MAIN ? ({ ...f, ...patch } as FacilityProductionDefinition) : f)),
  };
}

function withRecipe(id: string, patch: Partial<RecipeDefinition>, data: GameData = GAME_DATA): GameData {
  return { ...data, recipes: data.recipes.map((r) => (r.id === id ? { ...r, ...patch } : r)) };
}

function withCharacters(fn: (c: CharacterDefinition) => Loose, data: GameData = GAME_DATA): GameData {
  return { ...data, characters: data.characters.map((c) => ({ ...c, ...fn(c) }) as CharacterDefinition) };
}

function withWorkerWage(wage: number, data: GameData = GAME_DATA): GameData {
  return { ...data, workforce: { ...data.workforce, workerDailyWage: cents(wage) } };
}

// ---------------------------------------------------------------------------
// Games and state edits
// ---------------------------------------------------------------------------

interface Game {
  sim: KernelSimulation;
  readonly setup: GameSetup;
  readonly data: GameData;
}

interface GameOptions {
  readonly data?: GameData;
  readonly cash?: Money;
  readonly equipment?: readonly EquipmentId[];
  readonly workers?: number;
}

function scenarioWith(o: GameOptions): ScenarioDefinition {
  const s = FIRST_SHIPMENT_SCENARIO;
  return {
    ...s,
    openingBalance: { ...s.openingBalance, cash: o.cash ?? s.openingBalance.cash },
    facilities: s.facilities.map((f) =>
      f.id === DISTILLERY_MAIN ? { ...f, equipmentIds: o.equipment ?? f.equipmentIds, workerCount: o.workers ?? f.workerCount } : f,
    ),
  };
}

function game(o: GameOptions = {}): Game {
  const data = o.data ?? GAME_DATA;
  const setup: GameSetup = { scenario: scenarioWith(o), data };
  return { sim: newGame(setup), setup, data };
}

function edit(g: Game, fn: (s: GameState) => GameState): void {
  g.sim = createSimulation(fn(g.sim.state), simulationOptions(g.setup));
}

/** Zero-cost materials for `cases` cases of `recipe`. */
function freeMaterials(recipe: RecipeDefinition, cases: number) {
  return (s: GameState): GameState =>
    recipe.inputsPerCase.reduce((acc, i) => addMaterial(acc, DISTILLERY_MAIN, i.materialId, i.quantity * cases, ZERO_MONEY), s);
}

/** A running job with no reservations that never completes within these tests. */
function runningJob(quantity: number) {
  return (s: GameState): GameState => {
    const { id, state } = allocateId(s, "ProductionJob");
    const job: ProductionJobState = {
      id,
      facilityId: DISTILLERY_MAIN,
      recipeId: BASIC_MOONSHINE_RECIPE,
      quantity,
      startedAt: s.tick,
      completesAt: tick(s.tick + 10 * TICKS_PER_DAY),
      reservationIds: [],
    };
    return { ...state, productionJobs: [...state.productionJobs, job] };
  };
}

const fixtureCoordinator = createCoordinator();
let fixtureSerial = 0;

/** Commits a fixture transaction with `entries` at the current tick. */
function fixtureTransaction(kind: TransactionKind, entries: readonly LedgerEntry[]) {
  return (s: GameState): GameState => {
    fixtureSerial += 1;
    const tx = fixtureCoordinator.begin(s, { kind, idempotencyKey: idempotencyKey(kind, "fixture", fixtureSerial), tick: s.tick, causedBy: null });
    if (tx.status === "duplicate") throw new Error("Fixture key collided");
    tx.post(entries);
    const result = tx.commit();
    if (result.status !== "committed") throw new Error(`Fixture rejected: ${JSON.stringify(result.reason)}`);
    return result.state;
  };
}

/** Earlier unpaid wages: Dr WAGES_EXPENSE / Cr WAGES_PAYABLE. */
const owedWages = (amount: number) => fixtureTransaction("DAILY_SETTLEMENT", [dr("WAGES_EXPENSE", amount), cr("WAGES_PAYABLE", amount)]);
/** Cash coming in: Dr CASH / Cr SALES_REVENUE. */
const cashIn = (amount: number) => fixtureTransaction("SALE", [dr("CASH", amount), cr("SALES_REVENUE", amount)]);

function advanceTo(sim: KernelSimulation, target: number): void {
  if (target < sim.state.tick) throw new Error(`Can't go back from ${sim.state.tick} to ${target}`);
  sim.advance(target - sim.state.tick);
}

function expectApplied(result: CommandResult): Extract<CommandResult, { status: "applied" }> {
  if (result.status !== "applied") throw new Error(`Expected applied, got ${JSON.stringify(result)}`);
  return result;
}

/** Rejected with exactly `reason`, with no state change and no events (rule 6). */
function expectRejected(sim: KernelSimulation, command: GameCommand, reason: RejectionReason): void {
  sim.takeEvents();
  const before = sim.stateHash();
  const state = sim.state;
  const result = sim.dispatch({ command });
  if (result.status !== "rejected") throw new Error(`Expected rejected ${reason.code}, got ${JSON.stringify(result)}`);
  expect(result.reason).toEqual(reason);
  expect(sim.stateHash()).toBe(before);
  expect(sim.state.facilities).toEqual(state.facilities);
  expect(sim.state.ledger.transactions).toHaveLength(state.ledger.transactions.length);
  expect(sim.takeEvents()).toEqual([]);
}

const setWorkforce = (workerCount: number, facilityId: FacilityId = DISTILLERY_MAIN): GameCommand => ({ type: "SET_WORKFORCE", facilityId, workerCount });

const produce = (quantity: number, recipeId: string = BASIC_MOONSHINE_RECIPE): GameCommand => ({
  type: "START_PRODUCTION",
  facilityId: DISTILLERY_MAIN,
  recipeId: recipeId as RecipeDefinition["id"],
  quantity,
});

function jobAt(state: GameState): ProductionJobState {
  const job = state.productionJobs.find((j) => j.facilityId === DISTILLERY_MAIN);
  if (!job) throw new Error("No job at the distillery");
  return job;
}

/** Starts q cases of `recipe` and returns completesAt − startedAt. */
function startedDuration(g: Game, q: number, recipe: RecipeDefinition = basic(g.data)): number {
  edit(g, freeMaterials(recipe, q));
  expectApplied(g.sim.dispatch({ command: produce(q, recipe.id) }));
  const job = jobAt(g.sim.state);
  return job.completesAt - job.startedAt;
}

function transactionsKeyed(state: GameState, key: string): readonly LedgerTransaction[] {
  return state.ledger.transactions.filter((t) => t.idempotencyKey === key);
}

function onlyTransaction(state: GameState, key: string): LedgerTransaction {
  const found = transactionsKeyed(state, key);
  if (found.length !== 1) throw new Error(`Expected one transaction keyed ${key}, found ${found.length}`);
  return found[0]!;
}

function indexOfKey(state: GameState, key: string): number {
  return state.ledger.transactions.findIndex((t) => t.idempotencyKey === key);
}

function eventsOf(state: GameState, t: LedgerTransaction): readonly GameEvent[] {
  return t.eventIds.map((id) => {
    const e = state.eventJournal.find((x) => x.id === id);
    if (!e) throw new Error(`Event ${id} isn't in the journal`);
    return e;
  });
}

const dr = (account: LedgerAccount, amount: number): LedgerEntry => ({ account, side: "DEBIT", amount: cents(amount) });
const cr = (account: LedgerAccount, amount: number): LedgerEntry => ({ account, side: "CREDIT", amount: cents(amount) });

function sortedEntries(entries: readonly LedgerEntry[]): LedgerEntry[] {
  const key = (e: LedgerEntry) => `${e.side}/${e.account}/${String(e.amount).padStart(20, "0")}`;
  return [...entries].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

function expectEntries(actual: readonly LedgerEntry[], expected: readonly LedgerEntry[]): void {
  expect(sortedEntries(actual)).toEqual(sortedEntries(expected.filter((e) => e.amount > 0)));
}

const wagesPayable = (state: GameState): number => accountBalances(state.ledger.transactions).WAGES_PAYABLE;

/** Keys of the night that ends day `day` (ADR 0017 decision 9). */
const keys = (day: number) => ({
  wages: idempotencyKey("DAILY_SETTLEMENT", "WAGES", day),
  overhead: idempotencyKey("DAILY_SETTLEMENT", "OVERHEAD", day),
  payroll: idempotencyKey("DAILY_SETTLEMENT", "PAYROLL", day),
  // The market's midnight cycle is keyed by the day that is starting (ADR 0016).
  market: idempotencyKey("DAILY_SETTLEMENT", "MARKET", day + 1),
});

type DaySettled = Extract<GameEvent, { type: "DAY_SETTLED" }>;

function daySettledEvents(state: GameState): readonly DaySettled[] {
  return state.eventJournal.filter((e): e is DaySettled => e.type === "DAY_SETTLED");
}

function cashFlowLine(statement: { readonly lines: readonly { readonly category: CashFlowCategory; readonly amount: Money }[] }, category: CashFlowCategory): number {
  const line = statement.lines.find((l) => l.category === category);
  if (!line) throw new Error(`No ${category} line`);
  return line.amount;
}

function facilityIn(sim: KernelSimulation): FacilitySnapshot {
  const f = sim.snapshot().facilities.find((x) => x.id === DISTILLERY_MAIN);
  if (!f) throw new Error("No distillery in the snapshot");
  return f;
}

/**
 * What the midnight hook should post, given cash and WAGES_PAYABLE just before
 * it runs, computed with the exported posting builders (ADR 0017 decision 9).
 */
function expectedNight(cashBefore: number, payableBefore: number, wages: number, overhead: number) {
  const wagesPaid = Math.min(wages, cashBefore);
  const afterWages = cashBefore - wagesPaid;
  const overheadPaid = Math.min(overhead, afterWages);
  const afterOverhead = afterWages - overheadPaid;
  const paydown = Math.min(payableBefore, afterOverhead);
  return {
    wagesEntries: payOrAccrueEntries({ amount: cents(wages), expense: "WAGES_EXPENSE", payable: "WAGES_PAYABLE", cashAvailable: cents(cashBefore) }),
    overheadEntries: payOrAccrueEntries({ amount: cents(overhead), expense: "OVERHEAD_EXPENSE", payable: "WAGES_PAYABLE", cashAvailable: cents(afterWages) }),
    payrollEntries: payDownEntries(cents(paydown), "WAGES_PAYABLE"),
    paidInCash: wagesPaid + overheadPaid,
    addedToLiabilities: wages - wagesPaid + (overhead - overheadPaid),
    liabilitiesPaid: paydown,
    cashAfter: afterOverhead - paydown,
    payableAfter: payableBefore + (wages - wagesPaid) + (overhead - overheadPaid) - paydown,
  };
}

// ===========================================================================
// Game-data shape
// ===========================================================================

describe("PROD-001 labor game-data shape", () => {
  // @locked
  it("every equipment item has a non-negative integer crew", () => {
    for (const e of GAME_DATA.equipment) {
      const crew = crewOf(e);
      expect(Number.isSafeInteger(crew) && crew >= 0, e.id).toBe(true);
    }
  });

  // @locked
  it("every facility spec has a maximum workforce and a daily overhead in cents", () => {
    for (const f of GAME_DATA.facilityProduction) {
      const max = num(f, "maximumWorkers");
      const overhead = num(f, "dailyOverhead");
      expect(Number.isSafeInteger(max) && max >= 0, f.facilityId).toBe(true);
      expect(Number.isSafeInteger(overhead) && overhead >= 0, f.facilityId).toBe(true);
    }
    // The starting workforce fits, and there's room to hire.
    expect(maximumWorkers()).toBeGreaterThan(startingWorkers());
  });

  // @locked
  it("every leader has integer skill and loyalty in 0–100 and a daily wage", () => {
    expect(GAME_DATA.characters.length).toBeGreaterThan(0);
    for (const c of GAME_DATA.characters) {
      for (const field of ["skill", "loyalty"]) {
        const v = num(c, field);
        expect(Number.isSafeInteger(v) && v >= 0 && v <= 100, `${c.id} ${field}`).toBe(true);
      }
      expect(Number.isSafeInteger(c.dailyWage) && c.dailyWage >= 0, c.id).toBe(true);
    }
    expect(GAME_DATA.characters.map((c) => c.role).sort()).toEqual(["FOREMAN", "FOUNDER"]);
  });

  // @locked
  it("the shipped crew numbers (placeholder tuning the issue names): still 3, condenser 1, QC station 0, storage 0", () => {
    expect(crewOf(equipmentDef(COPPER_STILL))).toBe(3);
    expect(crewOf(condenser())).toBe(1);
    expect(crewOf(qcStation())).toBe(0);
    expect(crewOf(expansion())).toBe(0);
    // The starting state is fully staffed, so Sprint Zero runs at 1×.
    expect(startingWorkers()).toBe(crewOf(equipmentDef(COPPER_STILL)));
  });
});

// ===========================================================================
// Crew factor (ADR 0017 decision 1)
// ===========================================================================

describe("PROD-001 crew factor", () => {
  // @locked
  it("the starting state (still, full crew) runs at 1×: S0 timing is kept", () => {
    const g = game();
    const terms = crewTerms(g.sim.state);
    expect(terms.staffed).toBe(terms.crew);
    expect(throughput(g.sim.state, GAME_DATA, DISTILLERY_MAIN)).toBe(PPM);
    expect(productionCapacityPerDay(g.sim.state, GAME_DATA, DISTILLERY_MAIN)).toBe(casesPerDay(basic().ticksPerCase, PPM));
    expect(startedDuration(g, 7)).toBe(basic().ticksPerCase * 7);
  });

  // @locked
  it("shipped numbers: with the condenser, 3 workers give 1.05× and 4 give 1.4×; 10 cases take 1 372 and 1 029 ticks", () => {
    const three = game({ equipment: [COPPER_STILL, condenser().id], workers: 3 });
    expect(throughput(three.sim.state, GAME_DATA, DISTILLERY_MAIN)).toBe(1_050_000);
    expect(productionCapacityPerDay(three.sim.state, GAME_DATA, DISTILLERY_MAIN)).toBe(10);
    expect(startedDuration(three, 10)).toBe(1_372);

    const four = game({ equipment: [COPPER_STILL, condenser().id], workers: 4 });
    expect(throughput(four.sim.state, GAME_DATA, DISTILLERY_MAIN)).toBe(1_400_000);
    expect(startedDuration(four, 10)).toBe(1_029);

    // ADR 0017's still-alone example: 2 of 3 workers take 2 160 ticks for 10 cases.
    const two = game({ workers: 2 });
    expect(startedDuration(two, 10)).toBe(2_160);
  });

  // @locked
  it("duration is ceil(ticksPerCase × q × RATIO_SCALE × crew / (base × staffed)) for every workforce, with or without the condenser", () => {
    const max = maximumWorkers();
    for (const equipment of [[COPPER_STILL], [COPPER_STILL, condenser().id]] as const) {
      for (let workers = 1; workers <= max; workers++) {
        for (const q of [1, 3, 10]) {
          const g = game({ equipment, workers });
          const terms = crewTerms(g.sim.state);
          expect(startedDuration(g, q), `${equipment.join("+")} ${workers} workers ${q} cases`).toBe(crewDuration(basic().ticksPerCase, q, terms));
        }
      }
    }
  });

  // @locked
  it("property: duration, displayed ratio and capacity per day follow the formula for any crew sizes and recipe time", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 9 }),
        fc.integer({ min: 0, max: 4 }),
        fc.integer({ min: 0, max: 12 }),
        fc.integer({ min: 1, max: 700 }),
        fc.integer({ min: 1, max: 60 }),
        (stillCrew, condenserCrew, workers, ticksPerCase, q) => {
          const data = withFacilitySpec(
            { maximumWorkers: 12, baseStorage: 1_000 },
            withEquipment(condenser().id, { crew: condenserCrew }, withEquipment(COPPER_STILL, { crew: stillCrew }, withRecipe(BASIC_MOONSHINE_RECIPE, { ticksPerCase }))),
          );
          const g = game({ data, equipment: [COPPER_STILL, condenser().id], workers, cash: cents(100_000_000) });
          const terms = crewTerms(g.sim.state, data);
          if (terms.staffed === 0) {
            expect(throughput(g.sim.state, data, DISTILLERY_MAIN)).toBe(0);
            expect(productionCapacityPerDay(g.sim.state, data, DISTILLERY_MAIN)).toBe(0);
            return;
          }
          const shown = displayedRatio(terms);
          expect(throughput(g.sim.state, data, DISTILLERY_MAIN)).toBe(shown);
          expect(productionCapacityPerDay(g.sim.state, data, DISTILLERY_MAIN)).toBe(casesPerDay(ticksPerCase, shown));
          expect(startedDuration(g, q)).toBe(crewDuration(ticksPerCase, q, terms));
        },
      ),
      { numRuns: 150 },
    );
  });

  // @locked
  it("workers beyond the crew add nothing", () => {
    const max = maximumWorkers();
    const full = game();
    const extra = game({ workers: max });
    expect(throughput(extra.sim.state, GAME_DATA, DISTILLERY_MAIN)).toBe(throughput(full.sim.state, GAME_DATA, DISTILLERY_MAIN));
    expect(startedDuration(extra, 10)).toBe(startedDuration(full, 10));
  });

  // @locked
  it("0 workers give zero throughput: a start rejects with PRODUCTION_CAPACITY_EXCEEDED { available: 0 }, before storage, materials and cash", () => {
    const g = game({ workers: 0, cash: cents(0) });
    expect(throughput(g.sim.state, GAME_DATA, DISTILLERY_MAIN)).toBe(0);
    expect(productionCapacityPerDay(g.sim.state, GAME_DATA, DISTILLERY_MAIN)).toBe(0);
    expect(facilityIn(g.sim).productionCapacityPerDay).toBe(0);
    expectRejected(g.sim, produce(5), { code: "PRODUCTION_CAPACITY_EXCEEDED", facilityId: DISTILLERY_MAIN, requested: 5, available: 0 });
  });

  // @locked
  it("equipment with no crew runs at 1× whatever the workforce, even with 0 workers", () => {
    const data = withEquipment(COPPER_STILL, { crew: 0 });
    for (const workers of [0, 1, 5]) {
      const g = game({ data, workers });
      expect(throughput(g.sim.state, data, DISTILLERY_MAIN)).toBe(PPM);
      expect(startedDuration(g, 4)).toBe(basic().ticksPerCase * 4);
    }
  });

  // @locked
  it("the rule 6 overflow bound is crew-aware: with 2 of 3 workers the largest safe quantity reaches storage, one more is INVALID_QUANTITY", () => {
    const data = withRecipe(BASIC_MOONSHINE_RECIPE, { laborPerCase: cents(0), overheadPerCase: cents(0), inputsPerCase: [] });
    const g = game({ data, workers: 2 });
    advanceTo(g.sim, 100);
    const terms = crewTerms(g.sim.state, data);
    expect(terms.staffed).toBeLessThan(terms.crew);
    const applyTick = g.sim.state.tick + 1;
    const tpc = basic(data).ticksPerCase;
    // applyTick + ceil(tpc × q × PPM × crew / (base × staffed)) ≤ MAX  ⟺  q ≤ floor((MAX − applyTick) × base × staffed / (tpc × PPM × crew)).
    const bound = Number(
      (BigInt(MAX - applyTick) * BigInt(terms.base) * BigInt(terms.staffed)) / (BigInt(tpc) * BigInt(PPM) * BigInt(terms.crew)),
    );
    expect(bound).toBeLessThan(Math.floor((MAX - applyTick) / tpc));
    expect(applyTick + crewDuration(tpc, bound, terms)).toBeLessThanOrEqual(MAX);
    expect(applyTick + crewDuration(tpc, bound + 1, terms)).toBeGreaterThan(MAX);
    expectRejected(g.sim, produce(bound + 1), { code: "INVALID_QUANTITY", field: "quantity", value: bound + 1 });
    expectRejected(g.sim, produce(bound), {
      code: "STORAGE_CAPACITY_EXCEEDED",
      facilityId: DISTILLERY_MAIN,
      requested: bound,
      available: facilitySpec(data).baseStorage,
    });
  });

  // @locked
  it("the snapshot's maxStartableQuantity uses the crew-aware bound, and a dispatch accepts exactly it", () => {
    const data = withFacilitySpec(
      { baseStorage: Math.floor(MAX / 2) },
      withRecipe(BASIC_MOONSHINE_RECIPE, { laborPerCase: cents(0), overheadPerCase: cents(0), inputsPerCase: [] }),
    );
    const g = game({ data, workers: 2 });
    advanceTo(g.sim, 250);
    const terms = crewTerms(g.sim.state, data);
    const applyTick = g.sim.state.tick + 1;
    const tpc = basic(data).ticksPerCase;
    const bound = Number(
      (BigInt(MAX - applyTick) * BigInt(terms.base) * BigInt(terms.staffed)) / (BigInt(tpc) * BigInt(PPM) * BigInt(terms.crew)),
    );
    const option = facilityIn(g.sim).recipes.find((r) => r.recipeId === BASIC_MOONSHINE_RECIPE)!;
    expect(option).toMatchObject({ blockedBy: null, maxStartableQuantity: bound });
    const probe = createSimulation(g.sim.state, simulationOptions(g.setup));
    const over = probe.dispatch({ command: produce(bound + 1) });
    expect(over.status === "rejected" ? over.reason : over).toEqual({ code: "INVALID_QUANTITY", field: "quantity", value: bound + 1 });
    expectApplied(g.sim.dispatch({ command: produce(bound) }));
    expect(jobAt(g.sim.state).completesAt).toBe(applyTick + crewDuration(tpc, bound, terms));
  });
});

// ===========================================================================
// SET_WORKFORCE (ADR 0017 decision 8)
// ===========================================================================

describe("PROD-001 SET_WORKFORCE rejections", () => {
  // @locked
  it("1. INVALID_QUANTITY { field: workerCount } for a negative, non-integer or unsafe count, even at an unknown facility", () => {
    const { sim } = game();
    for (const n of [-1, -3, 1.5, 0.25, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, MAX + 1]) {
      expectRejected(sim, setWorkforce(n, UNKNOWN_FACILITY), { code: "INVALID_QUANTITY", field: "workerCount", value: n });
      expectRejected(sim, setWorkforce(n), { code: "INVALID_QUANTITY", field: "workerCount", value: n });
    }
  });

  // @locked
  it("2. UNKNOWN_ENTITY for an unknown facility, before the limit", () => {
    const { sim } = game();
    expectRejected(sim, setWorkforce(2, UNKNOWN_FACILITY), { code: "UNKNOWN_ENTITY", kind: "Facility", id: UNKNOWN_FACILITY });
    expectRejected(sim, setWorkforce(maximumWorkers() + 1, UNKNOWN_FACILITY), { code: "UNKNOWN_ENTITY", kind: "Facility", id: UNKNOWN_FACILITY });
  });

  // @locked
  it("3. WORKFORCE_LIMIT_EXCEEDED { requested, maximum } above the facility's maximum; the maximum itself is accepted", () => {
    const g = game();
    const max = maximumWorkers();
    for (const n of [max + 1, max + 10, MAX]) {
      expectRejected(g.sim, setWorkforce(n), { code: "WORKFORCE_LIMIT_EXCEEDED", facilityId: DISTILLERY_MAIN, requested: n, maximum: max });
    }
    expectApplied(g.sim.dispatch({ command: setWorkforce(max) }));
    expect(workersAt(g.sim.state)).toBe(max);
  });

  // @locked
  it("3. the limit comes from game-data and is checked before the running-job rule", () => {
    const data = withFacilitySpec({ maximumWorkers: 5 });
    const g = game({ data });
    edit(g, runningJob(2));
    expectRejected(g.sim, setWorkforce(6), { code: "WORKFORCE_LIMIT_EXCEEDED", facilityId: DISTILLERY_MAIN, requested: 6, maximum: 5 });
    expectApplied(g.sim.dispatch({ command: setWorkforce(5) }));
  });

  // @locked
  it("4. while a job runs, INVALID_QUANTITY { field: workerCount } below min(workerCount, crew); at or above it is accepted", () => {
    // Still alone: crew 3, 3 workers. The floor is 3.
    const g = game();
    const crew = crewTerms(g.sim.state).crew;
    edit(g, runningJob(2));
    for (let n = 0; n < crew; n++) expectRejected(g.sim, setWorkforce(n), { code: "INVALID_QUANTITY", field: "workerCount", value: n });
    expectApplied(g.sim.dispatch({ command: setWorkforce(maximumWorkers()) }));
    // More workers than the crew: the floor is still the crew.
    for (let n = 0; n < crew; n++) expectRejected(g.sim, setWorkforce(n), { code: "INVALID_QUANTITY", field: "workerCount", value: n });
    expectApplied(g.sim.dispatch({ command: setWorkforce(crew) }));
    expect(workersAt(g.sim.state)).toBe(crew);
  });

  // @locked
  it("4. while a job runs short-handed, the floor is the current workforce", () => {
    // Still plus condenser: crew 4, 2 workers. The floor is 2.
    const g = game({ equipment: [COPPER_STILL, condenser().id], workers: 2 });
    expect(crewTerms(g.sim.state).crew).toBeGreaterThan(2);
    edit(g, runningJob(2));
    for (const n of [0, 1]) expectRejected(g.sim, setWorkforce(n), { code: "INVALID_QUANTITY", field: "workerCount", value: n });
    expectApplied(g.sim.dispatch({ command: setWorkforce(3) }));
    expectRejected(g.sim, setWorkforce(2), { code: "INVALID_QUANTITY", field: "workerCount", value: 2 });
  });

  // @locked
  it("4. with no job running, any count down to 0 is accepted; equipment with no crew never blocks a layoff", () => {
    const g = game();
    expectApplied(g.sim.dispatch({ command: setWorkforce(0) }));
    expect(workersAt(g.sim.state)).toBe(0);

    const data = withEquipment(COPPER_STILL, { crew: 0 });
    const h = game({ data });
    edit(h, runningJob(2));
    expectApplied(h.sim.dispatch({ command: setWorkforce(0) }));
    expect(workersAt(h.sim.state)).toBe(0);
  });

  // @locked
  it("rule 6 property: no count makes SET_WORKFORCE throw, and a rejection changes nothing", () => {
    const g = game();
    edit(g, runningJob(2));
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: -1_000, max: 1_000 }),
          fc.double({ noNaN: false }),
          fc.constantFrom(MAX, MAX + 1, -MAX, Number.NaN, Number.POSITIVE_INFINITY),
        ),
        (n) => {
          g.sim.takeEvents();
          const before = g.sim.stateHash();
          const result = g.sim.dispatch({ command: setWorkforce(n) });
          if (result.status === "rejected") {
            expect(g.sim.stateHash()).toBe(before);
            expect(g.sim.takeEvents()).toEqual([]);
          } else {
            expect(result.status).toBe("applied");
            expect(workersAt(g.sim.state)).toBe(n);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("PROD-001 SET_WORKFORCE commits", () => {
  // @locked
  it("commits an entry-free DAILY_SETTLEMENT:WORKFORCE:<commandId> with one WORKFORCE_CHANGED", () => {
    const g = game();
    const from = workersAt(g.sim.state);
    const to = from + 2;
    const cashBefore = cashBalance(g.sim.state);
    const applyTick = g.sim.state.tick + 1;
    g.sim.takeEvents();
    const result = expectApplied(g.sim.dispatch({ command: setWorkforce(to) }));
    const s = g.sim.state;

    expect(workersAt(s)).toBe(to);
    const t = onlyTransaction(s, idempotencyKey("DAILY_SETTLEMENT", "WORKFORCE", result.commandId));
    expect(t).toMatchObject({ kind: "DAILY_SETTLEMENT", tick: applyTick });
    expect(t.entries).toEqual([]);
    expect(cashBalance(s)).toBe(cashBefore);

    const events = eventsOf(s, t);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "WORKFORCE_CHANGED", facilityId: DISTILLERY_MAIN, from, to, tick: applyTick, causedBy: result.commandId });
    expect(result.eventIds).toEqual(t.eventIds);
    expect(g.sim.takeEvents().map((e) => e.id)).toEqual(t.eventIds);
    expect(s.commandLog.at(-1)?.id).toBe(result.commandId);
  });

  // @locked
  it("setting the current count is an applied no-op: no transaction, no event, no facility change; only the command log grows", () => {
    const g = game();
    const before = g.sim.state;
    g.sim.takeEvents();
    const result = expectApplied(g.sim.dispatch({ command: setWorkforce(workersAt(before)) }));
    const s = g.sim.state;
    expect(result.eventIds).toEqual([]);
    expect(g.sim.takeEvents()).toEqual([]);
    expect(s.ledger.transactions).toEqual(before.ledger.transactions);
    expect(s.eventJournal).toEqual(before.eventJournal);
    expect(s.facilities).toEqual(before.facilities);
    expect(transactionsKeyed(s, idempotencyKey("DAILY_SETTLEMENT", "WORKFORCE", result.commandId))).toEqual([]);
    expect(s.commandLog).toHaveLength(before.commandLog.length + 1);
    expect(s.commandLog.at(-1)?.id).toBe(result.commandId);
  });

  // @locked
  it("each change gets its own transaction; the snapshot's workforce reports workers, the game-data maximum and wage", () => {
    const g = game();
    expect(facilityIn(g.sim).workforce).toEqual({
      workers: startingWorkers(),
      maximum: maximumWorkers(),
      dailyWagePerWorker: GAME_DATA.workforce.workerDailyWage,
    });
    const a = expectApplied(g.sim.dispatch({ command: setWorkforce(5) }));
    const b = expectApplied(g.sim.dispatch({ command: setWorkforce(1) }));
    expect(onlyTransaction(g.sim.state, idempotencyKey("DAILY_SETTLEMENT", "WORKFORCE", a.commandId)).id).not.toBe(
      onlyTransaction(g.sim.state, idempotencyKey("DAILY_SETTLEMENT", "WORKFORCE", b.commandId)).id,
    );
    expect(g.sim.state.eventJournal.filter((e) => e.type === "WORKFORCE_CHANGED").map((e) => (e.type === "WORKFORCE_CHANGED" ? [e.from, e.to] : null))).toEqual([
      [startingWorkers(), 5],
      [5, 1],
    ]);
    expect(facilityIn(g.sim).workforce).toEqual({ workers: 1, maximum: maximumWorkers(), dailyWagePerWorker: GAME_DATA.workforce.workerDailyWage });

    const data = withFacilitySpec({ maximumWorkers: 11 }, withWorkerWage(275));
    expect(facilityIn(game({ data }).sim).workforce).toEqual({ workers: startingWorkers(), maximum: 11, dailyWagePerWorker: 275 });
  });

  // @locked
  it("a workforce change doesn't re-time a running job; the next job uses the new workforce", () => {
    const g = game();
    edit(g, freeMaterials(basic(), 20));
    expectApplied(g.sim.dispatch({ command: produce(5) }));
    const job = jobAt(g.sim.state);
    expectApplied(g.sim.dispatch({ command: setWorkforce(maximumWorkers()) }));
    expect(jobAt(g.sim.state)).toEqual(job);
    advanceTo(g.sim, job.completesAt);
    expect(g.sim.state.productionJobs).toEqual([]);

    expectApplied(g.sim.dispatch({ command: setWorkforce(1) }));
    const terms = crewTerms(g.sim.state);
    expect(terms.staffed).toBe(1);
    expectApplied(g.sim.dispatch({ command: produce(5) }));
    const next = jobAt(g.sim.state);
    expect(next.completesAt - next.startedAt).toBe(crewDuration(basic().ticksPerCase, 5, terms));
    expect(next.completesAt - next.startedAt).toBeGreaterThan(basic().ticksPerCase * 5);
  });
});

// ===========================================================================
// Midnight settlement (ADR 0017 decision 9; SIM-001; FIN-001)
// ===========================================================================

describe("PROD-001 midnight settlement", () => {
  // @locked
  it("pays tonight's wages and overhead in cash: WAGES, OVERHEAD and PAYROLL transactions, in order, after the market", () => {
    const g = game();
    advanceTo(g.sim, TICKS_PER_DAY - 1);
    const pre = g.sim.state;
    const wages = wagesDue(pre);
    const overhead = overheadDue(pre);
    expect(wages).toBeGreaterThan(0);
    expect(overhead).toBeGreaterThan(0);
    expect(wages).toBe(GAME_DATA.characters.reduce((n, c) => n + c.dailyWage, 0) + startingWorkers() * GAME_DATA.workforce.workerDailyWage);
    expect(overhead).toBe(dailyOverhead());
    const cashBefore = cashBalance(pre);
    expect(cashBefore).toBeGreaterThanOrEqual(wages + overhead);
    expect(transactionsKeyed(pre, keys(0).payroll)).toEqual([]);

    advanceTo(g.sim, TICKS_PER_DAY);
    const s = g.sim.state;
    const k = keys(0);
    const w = onlyTransaction(s, k.wages);
    const o = onlyTransaction(s, k.overhead);
    const p = onlyTransaction(s, k.payroll);
    for (const t of [w, o, p]) expect(t).toMatchObject({ kind: "DAILY_SETTLEMENT", tick: TICKS_PER_DAY });
    expectEntries(w.entries, [dr("WAGES_EXPENSE", wages), cr("CASH", wages)]);
    expectEntries(o.entries, [dr("OVERHEAD_EXPENSE", overhead), cr("CASH", overhead)]);
    expect(p.entries).toEqual([]);
    expect(cashBalance(s)).toBe(cashBefore - wages - overhead);
    expect(wagesPayable(s)).toBe(0);

    // Order: the market's hook first (registration order), then wages, overhead, payroll.
    const iMarket = indexOfKey(s, k.market);
    expect(iMarket).toBeGreaterThanOrEqual(0);
    expect(iMarket).toBeLessThan(indexOfKey(s, k.wages));
    expect(indexOfKey(s, k.wages)).toBeLessThan(indexOfKey(s, k.overhead));
    expect(indexOfKey(s, k.overhead)).toBeLessThan(indexOfKey(s, k.payroll));

    const events = eventsOf(s, p);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      id: p.eventIds[0],
      tick: TICKS_PER_DAY,
      causedBy: null,
      type: "DAY_SETTLED",
      dayIndex: 0,
      wagesDue: wages,
      overheadDue: overhead,
      paidInCash: wages + overhead,
      addedToLiabilities: 0,
      liabilitiesPaid: 0,
      transactionId: p.id,
    });
    expect(daySettledEvents(s)).toHaveLength(1);
  });

  // @locked
  it("matches payOrAccrueEntries / payDownEntries exactly, reading cash after each step", () => {
    const g = game();
    advanceTo(g.sim, TICKS_PER_DAY - 1);
    const pre = g.sim.state;
    const want = expectedNight(cashBalance(pre), wagesPayable(pre), wagesDue(pre), overheadDue(pre));
    advanceTo(g.sim, TICKS_PER_DAY);
    const s = g.sim.state;
    expectEntries(onlyTransaction(s, keys(0).wages).entries, want.wagesEntries);
    expectEntries(onlyTransaction(s, keys(0).overhead).entries, want.overheadEntries);
    expectEntries(onlyTransaction(s, keys(0).payroll).entries, want.payrollEntries);
    expect(cashBalance(s)).toBe(want.cashAfter);
  });

  // @locked
  it("wages count every leader and the workforce as it stands at midnight (a change applied on the midnight tick counts)", () => {
    const g = game();
    advanceTo(g.sim, TICKS_PER_DAY - 1);
    const max = maximumWorkers();
    // An eager command applies first thing on the next tick, before the midnight phase.
    expectApplied(g.sim.dispatch({ command: setWorkforce(max) }));
    advanceTo(g.sim, TICKS_PER_DAY);
    const leaders = GAME_DATA.characters.reduce((n, c) => n + c.dailyWage, 0);
    const wages = leaders + max * GAME_DATA.workforce.workerDailyWage;
    expectEntries(onlyTransaction(g.sim.state, keys(0).wages).entries, [dr("WAGES_EXPENSE", wages), cr("CASH", wages)]);
    expect(daySettledEvents(g.sim.state)[0]).toMatchObject({ wagesDue: wages });

    const data = withCharacters((c) => ({ dailyWage: cents(c.role === "FOUNDER" ? 1_234 : 567) }), withWorkerWage(89));
    const h = game({ data, workers: 4 });
    advanceTo(h.sim, TICKS_PER_DAY);
    expect(daySettledEvents(h.sim.state)[0]).toMatchObject({ wagesDue: 1_234 + 567 + 4 * 89, overheadDue: dailyOverhead(data) });
  });

  // @locked
  it("accrues what cash can't cover to WAGES_PAYABLE: wages first, then overhead; cash ends at 0, never below", () => {
    const g0 = game();
    const wages = wagesDue(g0.sim.state);
    const overhead = overheadDue(g0.sim.state);
    const short = Math.floor(wages / 2);
    expect(short).toBeGreaterThan(0);
    const g = game({ cash: cents(short) });
    advanceTo(g.sim, TICKS_PER_DAY);
    const s = g.sim.state;
    expectEntries(onlyTransaction(s, keys(0).wages).entries, [dr("WAGES_EXPENSE", wages), cr("CASH", short), cr("WAGES_PAYABLE", wages - short)]);
    expectEntries(onlyTransaction(s, keys(0).overhead).entries, [dr("OVERHEAD_EXPENSE", overhead), cr("WAGES_PAYABLE", overhead)]);
    expect(onlyTransaction(s, keys(0).payroll).entries).toEqual([]);
    expect(cashBalance(s)).toBe(0);
    expect(wagesPayable(s)).toBe(wages - short + overhead);
    expect(daySettledEvents(s)[0]).toMatchObject({
      dayIndex: 0,
      wagesDue: wages,
      overheadDue: overhead,
      paidInCash: short,
      addedToLiabilities: wages - short + overhead,
      liabilitiesPaid: 0,
    });
  });

  // @locked
  it("with no cash at all, everything accrues and nothing is paid down", () => {
    const g = game({ cash: cents(0) });
    edit(g, owedWages(500));
    const wages = wagesDue(g.sim.state);
    const overhead = overheadDue(g.sim.state);
    advanceTo(g.sim, TICKS_PER_DAY);
    const s = g.sim.state;
    expectEntries(onlyTransaction(s, keys(0).wages).entries, [dr("WAGES_EXPENSE", wages), cr("WAGES_PAYABLE", wages)]);
    expectEntries(onlyTransaction(s, keys(0).overhead).entries, [dr("OVERHEAD_EXPENSE", overhead), cr("WAGES_PAYABLE", overhead)]);
    expect(onlyTransaction(s, keys(0).payroll).entries).toEqual([]);
    expect(cashBalance(s)).toBe(0);
    expect(wagesPayable(s)).toBe(500 + wages + overhead);
    expect(daySettledEvents(s)[0]).toMatchObject({ paidInCash: 0, addedToLiabilities: wages + overhead, liabilitiesPaid: 0 });
  });

  // @locked
  it("pays down earlier WAGES_PAYABLE with the cash left after tonight's costs: in full when it can", () => {
    const g = game();
    const owed = 4_321;
    edit(g, owedWages(owed));
    advanceTo(g.sim, TICKS_PER_DAY - 1);
    const cashBefore = cashBalance(g.sim.state);
    const wages = wagesDue(g.sim.state);
    const overhead = overheadDue(g.sim.state);
    expect(cashBefore - wages - overhead).toBeGreaterThan(owed);
    advanceTo(g.sim, TICKS_PER_DAY);
    const s = g.sim.state;
    const p = onlyTransaction(s, keys(0).payroll);
    expectEntries(p.entries, [dr("WAGES_PAYABLE", owed), cr("CASH", owed)]);
    expectEntries(p.entries, payDownEntries(cents(owed), "WAGES_PAYABLE"));
    expect(wagesPayable(s)).toBe(0);
    expect(cashBalance(s)).toBe(cashBefore - wages - overhead - owed);
    expect(eventsOf(s, p)[0]).toMatchObject({
      type: "DAY_SETTLED",
      paidInCash: wages + overhead,
      addedToLiabilities: 0,
      liabilitiesPaid: owed,
      transactionId: p.id,
    });
  });

  // @locked
  it("pays down partly when cash runs out, leaving cash at 0", () => {
    const g0 = game();
    const wages = wagesDue(g0.sim.state);
    const overhead = overheadDue(g0.sim.state);
    const spare = 250;
    const owed = 10_000;
    const g = game({ cash: cents(wages + overhead + spare) });
    edit(g, owedWages(owed));
    advanceTo(g.sim, TICKS_PER_DAY);
    const s = g.sim.state;
    expectEntries(onlyTransaction(s, keys(0).payroll).entries, [dr("WAGES_PAYABLE", spare), cr("CASH", spare)]);
    expect(cashBalance(s)).toBe(0);
    expect(wagesPayable(s)).toBe(owed - spare);
    expect(daySettledEvents(s)[0]).toMatchObject({ paidInCash: wages + overhead, addedToLiabilities: 0, liabilitiesPaid: spare });
  });

  // @locked
  it("accrues one night and pays it down the next, once cash arrives", () => {
    const g0 = game();
    const wages = wagesDue(g0.sim.state);
    const overhead = overheadDue(g0.sim.state);
    const g = game({ cash: cents(0) });
    advanceTo(g.sim, TICKS_PER_DAY);
    expect(wagesPayable(g.sim.state)).toBe(wages + overhead);
    expect(cashBalance(g.sim.state)).toBe(0);

    const income = 3 * (wages + overhead);
    advanceTo(g.sim, TICKS_PER_DAY + 100);
    edit(g, cashIn(income));
    advanceTo(g.sim, 2 * TICKS_PER_DAY);
    const s = g.sim.state;
    const k = keys(1);
    expectEntries(onlyTransaction(s, k.wages).entries, [dr("WAGES_EXPENSE", wages), cr("CASH", wages)]);
    expectEntries(onlyTransaction(s, k.overhead).entries, [dr("OVERHEAD_EXPENSE", overhead), cr("CASH", overhead)]);
    // The paydown covers last night's accrual (earlier WAGES_PAYABLE).
    expectEntries(onlyTransaction(s, k.payroll).entries, [dr("WAGES_PAYABLE", wages + overhead), cr("CASH", wages + overhead)]);
    expect(wagesPayable(s)).toBe(0);
    expect(cashBalance(s)).toBe(income - 2 * (wages + overhead));
    expect(daySettledEvents(s).map((e) => e.dayIndex)).toEqual([0, 1]);
    expect(daySettledEvents(s)[1]).toMatchObject({ paidInCash: wages + overhead, addedToLiabilities: 0, liabilitiesPaid: wages + overhead });
  });

  // @locked
  it("property: cash never goes negative and every night matches the builders, for any cash and earlier payable", () => {
    const g0 = game();
    const wages = wagesDue(g0.sim.state);
    const overhead = overheadDue(g0.sim.state);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 3 * (wages + overhead) }), fc.integer({ min: 0, max: 2 * (wages + overhead) }), (cash, owed) => {
        const g = game({ cash: cents(cash) });
        if (owed > 0) edit(g, owedWages(owed));
        advanceTo(g.sim, TICKS_PER_DAY - 1);
        const want = expectedNight(cashBalance(g.sim.state), wagesPayable(g.sim.state), wages, overhead);
        advanceTo(g.sim, TICKS_PER_DAY);
        const s = g.sim.state;
        expectEntries(onlyTransaction(s, keys(0).wages).entries, want.wagesEntries);
        expectEntries(onlyTransaction(s, keys(0).overhead).entries, want.overheadEntries);
        expectEntries(onlyTransaction(s, keys(0).payroll).entries, want.payrollEntries);
        expect(cashBalance(s)).toBe(want.cashAfter);
        expect(cashBalance(s)).toBeGreaterThanOrEqual(0);
        expect(wagesPayable(s)).toBe(want.payableAfter);
        expect(daySettledEvents(s)[0]).toMatchObject({
          wagesDue: wages,
          overheadDue: overhead,
          paidInCash: want.paidInCash,
          addedToLiabilities: want.addedToLiabilities,
          liabilitiesPaid: want.liabilitiesPaid,
        });
      }),
      { numRuns: 25 },
    );
  });

  // @locked
  it("skips WAGES and OVERHEAD when their amount is 0; PAYROLL always commits with DAY_SETTLED", () => {
    const noWages = withCharacters(() => ({ dailyWage: cents(0) }), withWorkerWage(0));
    const g = game({ data: noWages });
    advanceTo(g.sim, TICKS_PER_DAY);
    expect(transactionsKeyed(g.sim.state, keys(0).wages)).toEqual([]);
    expect(transactionsKeyed(g.sim.state, keys(0).overhead)).toHaveLength(1);
    expect(daySettledEvents(g.sim.state)[0]).toMatchObject({ wagesDue: 0, overheadDue: dailyOverhead(noWages) });

    const nothing = withFacilitySpec({ dailyOverhead: cents(0) }, noWages);
    const h = game({ data: nothing });
    const cashBefore = cashBalance(h.sim.state);
    advanceTo(h.sim, TICKS_PER_DAY);
    const s = h.sim.state;
    expect(transactionsKeyed(s, keys(0).wages)).toEqual([]);
    expect(transactionsKeyed(s, keys(0).overhead)).toEqual([]);
    const p = onlyTransaction(s, keys(0).payroll);
    expect(p).toMatchObject({ kind: "DAILY_SETTLEMENT", tick: TICKS_PER_DAY, entries: [] });
    expect(eventsOf(s, p)).toEqual([
      {
        id: p.eventIds[0],
        tick: TICKS_PER_DAY,
        causedBy: null,
        type: "DAY_SETTLED",
        dayIndex: 0,
        wagesDue: 0,
        overheadDue: 0,
        paidInCash: 0,
        addedToLiabilities: 0,
        liabilitiesPaid: 0,
        transactionId: p.id,
      },
    ]);
    expect(cashBalance(s)).toBe(cashBefore);

    const noOverhead = withFacilitySpec({ dailyOverhead: cents(0) });
    const k = game({ data: noOverhead });
    advanceTo(k.sim, TICKS_PER_DAY);
    expect(transactionsKeyed(k.sim.state, keys(0).wages)).toHaveLength(1);
    expect(transactionsKeyed(k.sim.state, keys(0).overhead)).toEqual([]);
  });

  // @locked
  it("settles each day exactly once, at its midnight, keyed by the day that ended", () => {
    const g = game();
    const days = 3;
    advanceTo(g.sim, days * TICKS_PER_DAY + 7);
    const s = g.sim.state;
    for (let d = 0; d < days; d++) {
      for (const key of [keys(d).wages, keys(d).overhead, keys(d).payroll]) {
        const t = onlyTransaction(s, key);
        expect(t.tick, key).toBe((d + 1) * TICKS_PER_DAY);
      }
    }
    expect(transactionsKeyed(s, keys(days).payroll)).toEqual([]);
    const settled = daySettledEvents(s);
    expect(settled.map((e) => e.dayIndex)).toEqual([0, 1, 2]);
    expect(settled.map((e) => e.tick)).toEqual([1, 2, 3].map((n) => n * TICKS_PER_DAY));
    const payrolls = s.ledger.transactions.filter((t) => t.kind === "DAILY_SETTLEMENT" && t.idempotencyKey.startsWith("DAILY_SETTLEMENT:PAYROLL:"));
    expect(payrolls).toHaveLength(days);
    // Re-entering the same tick (a reload) settles nothing new.
    const reloaded = createSimulation(s, simulationOptions(g.setup));
    expect(reloaded.stateHash()).toBe(g.sim.stateHash());
    reloaded.advance(1);
    expect(daySettledEvents(reloaded.state)).toHaveLength(days);
  });

  // @locked
  it("a job completing on the midnight tick is settled once, before tonight's wages, which see the cash it used", () => {
    const Q = 5;
    const recipe = basic();
    const conversion = (recipe.laborPerCase + recipe.overheadPerCase) * Q;
    const g0 = game();
    const wages = wagesDue(g0.sim.state);
    const overhead = overheadDue(g0.sim.state);
    // Enough for the conversion and part of tonight's wages.
    const cash = conversion + Math.floor(wages / 3);
    const g = game({ cash: cents(cash) });
    edit(g, freeMaterials(recipe, Q));
    const applyTick = TICKS_PER_DAY - recipe.ticksPerCase * Q;
    expect(applyTick).toBeGreaterThan(0);
    advanceTo(g.sim, applyTick - 1);
    expectApplied(g.sim.dispatch({ command: produce(Q) }));
    const job = jobAt(g.sim.state);
    expect(job.completesAt).toBe(TICKS_PER_DAY);
    advanceTo(g.sim, 2 * TICKS_PER_DAY + 1);

    const s = g.sim.state;
    const done = onlyTransaction(s, idempotencyKey("PRODUCTION", job.id));
    expect(done.tick).toBe(TICKS_PER_DAY);
    expect(s.ledger.transactions.filter((t) => t.kind === "PRODUCTION")).toHaveLength(1);
    expect(indexOfKey(s, idempotencyKey("PRODUCTION", job.id))).toBeLessThan(indexOfKey(s, keys(0).wages));
    const left = cash - conversion;
    expectEntries(onlyTransaction(s, keys(0).wages).entries, [dr("WAGES_EXPENSE", wages), cr("CASH", left), cr("WAGES_PAYABLE", wages - left)]);
    expectEntries(onlyTransaction(s, keys(0).overhead).entries, [dr("OVERHEAD_EXPENSE", overhead), cr("WAGES_PAYABLE", overhead)]);
    expect(daySettledEvents(s).filter((e) => e.dayIndex === 0)).toHaveLength(1);
    expect(cashBalance(s)).toBe(0);
  });
});

// ===========================================================================
// Cash flow and profit (ADR 0015)
// ===========================================================================

describe("PROD-001 settlement in cash flow and profit", () => {
  // @locked
  it("fully paid wages file under WAGES and fully paid overhead under OVERHEAD, in the transaction and in the snapshot", () => {
    const g = game();
    advanceTo(g.sim, TICKS_PER_DAY);
    const s = g.sim.state;
    const wages = wagesDue(s);
    const overhead = overheadDue(s);
    const w = cashFlowStatement(cents(0), [onlyTransaction(s, keys(0).wages)]);
    expect(cashFlowLine(w, "WAGES")).toBe(-wages);
    expect(cashFlowLine(w, "OVERHEAD")).toBe(0);
    const o = cashFlowStatement(cents(0), [onlyTransaction(s, keys(0).overhead)]);
    expect(cashFlowLine(o, "OVERHEAD")).toBe(-overhead);
    expect(cashFlowLine(o, "WAGES")).toBe(0);

    const previous = g.sim.snapshot().finance.previousDay;
    expect(previous).not.toBeNull();
    expect(cashFlowLine(previous!.cashFlow, "WAGES")).toBe(-wages);
    expect(cashFlowLine(previous!.cashFlow, "OVERHEAD")).toBe(-overhead);
    expect(previous!.cashFlow.netChange).toBe(-(wages + overhead));
    const expense = (c: string) => previous!.profit.expenses.find((e) => e.category === c)!.amount;
    expect(expense("WAGES")).toBe(wages);
    expect(expense("OVERHEAD")).toBe(overhead);
  });

  // @locked
  it("partly accrued overhead falls to the DAILY_SETTLEMENT default (WAGES), and so does the paydown", () => {
    const g0 = game();
    const wages = wagesDue(g0.sim.state);
    const overhead = overheadDue(g0.sim.state);
    const part = Math.floor(overhead / 2);
    expect(part).toBeGreaterThan(0);
    const g = game({ cash: cents(wages + part) });
    advanceTo(g.sim, TICKS_PER_DAY);
    const o = onlyTransaction(g.sim.state, keys(0).overhead);
    expectEntries(o.entries, [dr("OVERHEAD_EXPENSE", overhead), cr("CASH", part), cr("WAGES_PAYABLE", overhead - part)]);
    const flow = cashFlowStatement(cents(0), [o]);
    expect(cashFlowLine(flow, "WAGES")).toBe(-part);
    expect(cashFlowLine(flow, "OVERHEAD")).toBe(0);

    advanceTo(g.sim, TICKS_PER_DAY + 10);
    edit(g, cashIn(10 * (wages + overhead)));
    advanceTo(g.sim, 2 * TICKS_PER_DAY);
    const p = onlyTransaction(g.sim.state, keys(1).payroll);
    expectEntries(p.entries, [dr("WAGES_PAYABLE", overhead - part), cr("CASH", overhead - part)]);
    const paydown = cashFlowStatement(cents(0), [p]);
    expect(cashFlowLine(paydown, "WAGES")).toBe(-(overhead - part));
    expect(cashFlowLine(paydown, "OVERHEAD")).toBe(0);
  });
});

// ===========================================================================
// Leaders (ADR 0017 decision 10)
// ===========================================================================

describe("PROD-001 leaders", () => {
  // @locked
  it("the snapshot lists every leader with skill, loyalty and daily wage from game-data", () => {
    const g = game();
    const leaders = [...g.sim.snapshot().family.leaders].sort((a, b) => compareIds(a.id, b.id));
    const expected = [...GAME_DATA.characters]
      .sort((a, b) => compareIds(a.id, b.id))
      .map((c) => ({ id: c.id, name: c.name, role: c.role, skill: num(c, "skill"), loyalty: num(c, "loyalty"), dailyWage: c.dailyWage }));
    expect(leaders).toEqual(expected);

    const data = withCharacters((c) => ({ skill: c.role === "FOUNDER" ? 91 : 12, loyalty: c.role === "FOUNDER" ? 100 : 7 }));
    const h = game({ data });
    const byRole = (role: string) => h.sim.snapshot().family.leaders.find((l) => l.role === role)!;
    expect(byRole("FOUNDER")).toMatchObject({ skill: 91, loyalty: 100 });
    expect(byRole("FOREMAN")).toMatchObject({ skill: 12, loyalty: 7 });
  });

  // @locked
  it("skill and loyalty have no mechanical effect: the same commands give the same state hash", () => {
    const run = (data: GameData): string => {
      const g = game({ data, equipment: [COPPER_STILL, condenser().id], workers: 3 });
      edit(g, freeMaterials(basic(), 10));
      expectApplied(g.sim.dispatch({ command: produce(10) }));
      expectApplied(g.sim.dispatch({ command: setWorkforce(5) }));
      advanceTo(g.sim, 2 * TICKS_PER_DAY + 3);
      return g.sim.stateHash();
    };
    const low = withCharacters(() => ({ skill: 0, loyalty: 0 }));
    const high = withCharacters(() => ({ skill: 100, loyalty: 100 }));
    expect(run(low)).toBe(run(high));
    expect(run(high)).toBe(run(GAME_DATA));
  });
});

// ===========================================================================
// Sprint Zero (the S0 path ends before the first midnight)
// ===========================================================================

describe("PROD-001 labor keeps Sprint Zero", () => {
  // @locked
  it(`the headless Sprint Zero run still ends at ${SPRINT_ZERO_HASH}, before any settlement`, () => {
    // The same commands and ticks as tools/economy-lab/src/sprint-zero.ts.
    const recipe = basic();
    const sim = newGame();
    for (const input of recipe.inputsPerCase) {
      expectApplied(
        sim.dispatch({
          command: { type: "PURCHASE_MATERIALS", supplierId: MILLERS_FEED, materialId: input.materialId, quantity: input.quantity, facilityId: DISTILLERY_MAIN },
        }),
      );
    }
    expectApplied(sim.dispatch({ command: { type: "START_PRODUCTION", facilityId: DISTILLERY_MAIN, recipeId: BASIC_MOONSHINE_RECIPE, quantity: 1 } }));
    advanceTo(sim, sim.state.productionJobs[0]!.completesAt);
    const quote = sim.state.buyers.find((b) => b.id === CROSSROADS_ROADHOUSE)!.wants[0]!.unitPrice;
    expectApplied(
      sim.dispatch({
        command: {
          type: "DISPATCH_DELIVERY",
          vehicleId: MODEL_TT_TRUCK,
          cargo: [{ productId: recipe.productId, quality: recipe.quality, quantity: 1 }],
          purpose: { kind: "SALE", buyerId: CROSSROADS_ROADHOUSE, agreedUnitPrice: quote },
          routeId: null,
        },
      }),
    );
    advanceTo(sim, sim.state.vehicles[0]!.trip!.arrivesAt);
    advanceTo(sim, sim.state.vehicles[0]!.trip!.arrivesAt);

    expect(sim.state.tick).toBeLessThan(TICKS_PER_DAY);
    expect(daySettledEvents(sim.state)).toEqual([]);
    expect(sim.state.ledger.transactions.filter((t) => t.idempotencyKey.startsWith("DAILY_SETTLEMENT:WAGES:"))).toEqual([]);
    expect(sim.stateHash()).toBe(SPRINT_ZERO_HASH);
  });
});
