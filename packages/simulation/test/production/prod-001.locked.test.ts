// @locked
// PROD-001 acceptance tests for T02c1 (issue #7): production jobs, capacity, and
// equipment. Covers the capacity helpers (throughput, job duration, storage),
// START_PRODUCTION's check order and its rule 6 overflow bound, the RESERVATION
// start, completion through `consumeReservations` and the posting builders with
// the WAGES_PAYABLE accrual branch, seeded failure with write-off, a job that
// completes on the midnight tick, PURCHASE_EQUIPMENT, and the snapshot's facility
// section. Rules come from GDD §6 and §8 and ADR 0017.
//
// Written ahead of the implementation by a separate test-writer agent
// (factory.md §2, §7.3). Do not edit (CLAUDE.md rule 9).
//
// Imports are limited to `src/production/index.ts`, `src/inventory/index.ts`,
// the public package entry `src/index.ts` (the `Simulation`: `newGame`,
// `createSimulation`, `simulationOptions`, plus `allocateId`, `balanceSheet`,
// `cashBalance`, `nextInt` and `seedRng`, which it already exports), and
// `@eov/contracts` and `@eov/game-data`.
//
// Expected numbers are derived from game-data and the ADR 0017 formulas, so
// placeholder tuning can change without breaking these tests. Fixture data for
// failure, slots, and locks is built here by spreading GAME_DATA. The only
// pinned literals are the seeded failure run's outcome (seed 1920, which the
// draws below are computed from as well) and ADR 0017's full crew of 4.
//
// Midnight (round-3 notes on #7): T02c2 (#63) adds wage and overhead settlement
// transactions at every midnight. Every test here finishes before tick 1440,
// except the midnight tests, which only look at the production transactions and
// events, filtered by job.
//
// API these tests assume. (issue) marks names the issue fixes. The rest are the
// test-writer's choice.
//
// src/production/index.ts:
//   Existing (S0), kept:
//     `registerProduction` (issue), `conversionCost(recipe, quantity): Money`
//   New:
//     `throughput(state: GameState, data: GameData, facilityId: FacilityId): Ratio` (issue)
//         RATIO_SCALE + Σ owned equipment's throughputBonus; 0 when the facility
//         owns no equipment that any recipe in `data` requires.
//     `jobDuration(recipe: RecipeDefinition, quantity: number, throughput: Ratio): number` (issue)
//         ceil(ticksPerCase × quantity × RATIO_SCALE / throughput), exact (BigInt).
//     `storageCapacity(state: GameState, data: GameData, facilityId: FacilityId): number` (issue)
//         baseStorage + Σ owned equipment's storageBonus.
//     `storageCommitted(state: GameState, facilityId: FacilityId): number` (issue)
//         storageUsed + the quantity of running jobs at the facility.
//
// src/inventory/index.ts (existing, T02a): `addMaterial`, `addProduct`, `storageUsed`.
//
// @eov/game-data (issue):
//   `GameData.facilityProduction: readonly FacilityProductionDefinition[]`, one per
//     facility in `facilities`, each `{ facilityId: FacilityId, equipmentSlots: number,
//     baseStorage: number }` (T02c2 adds more fields), exported from a new `facilities.ts`.
//   `FacilityProductionDefinition` (type, exported).
//   `EquipmentDefinition`: `description: string`, `throughputBonus: Ratio`,
//     `storageBonus: number`, `requiredUnlockId: UnlockId | null`; `casesPerDay` removed.
//   `RecipeDefinition`: `requiredEquipmentIds: readonly EquipmentId[]` (replaces
//     `requiredEquipmentId`), `failureChance: Ratio`.
//   Shipped data: the 3 × 3 product matrix (moonshine, whiskey, beer), exactly two
//     recipes (basic and standard moonshine), four equipment items: the copper still
//     (`COPPER_STILL`), one item with a positive `throughputBonus` (the improved
//     condenser), one with a positive `storageBonus` (the storage expansion), and the
//     QC station, which the standard recipe requires besides the still. These tests
//     find the condenser, expansion, QC station and standard recipe by those
//     properties, so their constant names are the implementer's choice.
//
// Contract behaviour (no contract change): START_PRODUCTION and PURCHASE_EQUIPMENT
// reject with the existing codes in the orders ADR 0017 gives; the START_PRODUCTION
// overflow bound runs both in `validate` (dispatch of a queued command) and in
// `apply`.
//
// Expected to fail until T02c1 lands: `throughput`, `jobDuration`,
// `storageCapacity`, `storageCommitted` and the game-data fields above don't
// exist yet, PURCHASE_EQUIPMENT has no handler, and there's no failure path.

import {
  asId,
  cents,
  compareIds,
  idempotencyKey,
  RATIO_SCALE,
  ratio,
  tick,
  TICKS_PER_DAY,
  ZERO_MONEY,
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
  type ProductionJobId,
  type ProductionJobState,
  type RejectionReason,
  type UnlockId,
} from "@eov/contracts";
import {
  BASIC_MOONSHINE_RECIPE,
  COPPER_STILL,
  DISTILLERY_MAIN,
  FIRST_SHIPMENT_SCENARIO,
  GAME_DATA,
  MILLERS_FEED,
  MOONSHINE,
  type EquipmentDefinition,
  type FacilityProductionDefinition,
  type GameData,
  type RecipeDefinition,
  type ScenarioDefinition,
} from "@eov/game-data";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addMaterial, addProduct, storageUsed } from "../../src/inventory/index.ts";
import { conversionCost, jobDuration, storageCapacity, storageCommitted, throughput } from "../../src/production/index.ts";
import {
  allocateId,
  balanceSheet,
  cashBalance,
  createSimulation,
  newGame,
  nextInt,
  seedRng,
  simulationOptions,
  type GameSetup,
  type KernelSimulation,
} from "../../src/index.ts";

// ---------------------------------------------------------------------------
// Constants and lookups
// ---------------------------------------------------------------------------

const MAX = Number.MAX_SAFE_INTEGER;
const PPM = RATIO_SCALE;
/** ADR 0017 decision 1: the full crew of the still plus the condenser. */
const FULL_CREW = 4;
const UNKNOWN_FACILITY = asId("Facility", "fixture-nowhere");
const UNKNOWN_RECIPE = asId("Recipe", "fixture-no-such-recipe");
const UNKNOWN_EQUIPMENT = asId("Equipment", "fixture-no-such-equipment");
const FIXTURE_UNLOCK: UnlockId = asId("Unlock", "fixture-lock");

function recipeById(id: string, data: GameData = GAME_DATA): RecipeDefinition {
  const r = data.recipes.find((x) => x.id === id);
  if (!r) throw new Error(`No recipe ${id}`);
  return r;
}

const basic = (): RecipeDefinition => recipeById(BASIC_MOONSHINE_RECIPE);

function standard(): RecipeDefinition {
  const found = GAME_DATA.recipes.filter((r) => r.productId === MOONSHINE && r.quality === "standard");
  if (found.length !== 1) throw new Error(`Expected one standard moonshine recipe, found ${found.length}`);
  return found[0]!;
}

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

/** The QC station: what the standard recipe needs besides the copper still. */
function qcStation(): EquipmentDefinition {
  const extra = standard().requiredEquipmentIds.filter((id) => id !== COPPER_STILL);
  if (extra.length !== 1) throw new Error(`Expected the standard recipe to need one item besides the still, found ${extra.length}`);
  return equipmentDef(extra[0]!);
}

function facilitySpec(data: GameData = GAME_DATA, facilityId: FacilityId = DISTILLERY_MAIN): FacilityProductionDefinition {
  const spec = data.facilityProduction.find((f) => f.facilityId === facilityId);
  if (!spec) throw new Error(`No production spec for ${facilityId}`);
  return spec;
}

function owned(state: GameState, facilityId: FacilityId = DISTILLERY_MAIN): readonly EquipmentId[] {
  const f = state.facilities.find((x) => x.id === facilityId);
  if (!f) throw new Error(`No facility ${facilityId}`);
  return f.equipment.map((e) => e.equipmentId);
}

/** Independent of the helpers under test: baseStorage + Σ owned storageBonus. */
function expectedCapacity(state: GameState, data: GameData = GAME_DATA): number {
  return owned(state).reduce((n, id) => n + equipmentDef(id, data).storageBonus, facilitySpec(data).baseStorage);
}

/** Independent of the helpers under test: RATIO_SCALE + Σ owned throughputBonus. */
function expectedThroughput(state: GameState, data: GameData = GAME_DATA): number {
  return owned(state).reduce((n, id) => n + equipmentDef(id, data).throughputBonus, PPM);
}

/** ceil(ticksPerCase × quantity × RATIO_SCALE / throughput), exactly. */
function durationOf(ticksPerCase: number, quantity: number, ratioPpm: number): number {
  const num = BigInt(ticksPerCase) * BigInt(quantity) * BigInt(PPM);
  const den = BigInt(ratioPpm);
  return Number((num + den - 1n) / den);
}

/** floor(TICKS_PER_DAY × throughput / (ticksPerCase × RATIO_SCALE)). */
function casesPerDay(ticksPerCase: number, ratioPpm: number): number {
  return Number((BigInt(TICKS_PER_DAY) * BigInt(ratioPpm)) / (BigInt(ticksPerCase) * BigInt(PPM)));
}

/**
 * The largest quantity whose derived values all stay safe integers at 1×
 * throughput, applying at `applyTick`: input totals, conversion cost, duration
 * (ticksPerCase × q at 1×) and completesAt (applyTick + duration).
 */
function overflowBound(recipe: RecipeDefinition, applyTick: number): number {
  let bound = MAX;
  const perCase = recipe.laborPerCase + recipe.overheadPerCase;
  if (perCase > 0) bound = Math.min(bound, Math.floor(MAX / perCase));
  if (recipe.ticksPerCase > 0) bound = Math.min(bound, Math.floor((MAX - applyTick) / recipe.ticksPerCase));
  for (const input of recipe.inputsPerCase) if (input.quantity > 0) bound = Math.min(bound, Math.floor(MAX / input.quantity));
  return bound;
}

// ---------------------------------------------------------------------------
// Fixture data (built by spreading GAME_DATA)
// ---------------------------------------------------------------------------

function withRecipe(id: string, patch: Partial<RecipeDefinition>, data: GameData = GAME_DATA): GameData {
  return { ...data, recipes: data.recipes.map((r) => (r.id === id ? { ...r, ...patch } : r)) };
}

function withEquipment(id: EquipmentId, patch: Partial<EquipmentDefinition>, data: GameData = GAME_DATA): GameData {
  return { ...data, equipment: data.equipment.map((e) => (e.id === id ? { ...e, ...patch } : e)) };
}

function withFacilitySpec(patch: Partial<FacilityProductionDefinition>, data: GameData = GAME_DATA): GameData {
  return { ...data, facilityProduction: data.facilityProduction.map((f) => (f.facilityId === DISTILLERY_MAIN ? { ...f, ...patch } : f)) };
}

/** Enough slots for every equipment item, for tests that buy several. */
const roomy = (data: GameData = GAME_DATA): GameData => withFacilitySpec({ equipmentSlots: data.equipment.length }, data);

const failing = (chance: number, data: GameData = GAME_DATA): GameData => withRecipe(BASIC_MOONSHINE_RECIPE, { failureChance: ratio(chance) }, data);

/** A recipe that needs no equipment, so it's "supported" anywhere (for the zero-throughput rule). */
const HAND_MASH = asId("Recipe", "fixture-hand-mash");
function withHandMash(data: GameData = GAME_DATA): GameData {
  return { ...data, recipes: [...data.recipes, { ...recipeById(BASIC_MOONSHINE_RECIPE, data), id: HAND_MASH, requiredEquipmentIds: [] }] };
}

// ---------------------------------------------------------------------------
// Games and state edits
// ---------------------------------------------------------------------------

interface Game {
  sim: KernelSimulation;
  readonly setup: GameSetup;
}

interface GameOptions {
  readonly data?: GameData;
  /** Opening cash. Default: the scenario's. */
  readonly cash?: Money;
  /** Equipment owned at the start. Default: the scenario's. */
  readonly equipment?: readonly EquipmentId[];
  /** Workers at the start. Default: the scenario's. */
  readonly workers?: number;
  readonly seed?: number;
}

function scenarioWith(o: GameOptions): ScenarioDefinition {
  const s = FIRST_SHIPMENT_SCENARIO;
  return {
    ...s,
    seed: o.seed ?? s.seed,
    openingBalance: { ...s.openingBalance, cash: o.cash ?? s.openingBalance.cash },
    facilities: s.facilities.map((f) =>
      f.id === DISTILLERY_MAIN ? { ...f, equipmentIds: o.equipment ?? f.equipmentIds, workerCount: o.workers ?? f.workerCount } : f,
    ),
  };
}

function game(o: GameOptions = {}): Game {
  const setup: GameSetup = { scenario: scenarioWith(o), data: o.data ?? GAME_DATA };
  return { sim: newGame(setup), setup };
}

/** Replaces the game's state with `edit(state)`, keeping its data and systems. */
function edit(g: Game, fn: (s: GameState) => GameState): void {
  g.sim = createSimulation(fn(g.sim.state), simulationOptions(g.setup));
}

/** Zero-cost materials for `cases` cases of `recipe`, so the ledger still matches inventory. */
function freeMaterials(recipe: RecipeDefinition, cases: number) {
  return (s: GameState): GameState =>
    recipe.inputsPerCase.reduce((acc, i) => addMaterial(acc, DISTILLERY_MAIN, i.materialId, i.quantity * cases, ZERO_MONEY), s);
}

/** Zero-cost finished cases in stock. */
function freeCases(cases: number) {
  return (s: GameState): GameState => (cases > 0 ? addProduct(s, DISTILLERY_MAIN, MOONSHINE, "basic", cases, ZERO_MONEY) : s);
}

/** A running job with no reservations, for checks that never let it complete. */
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

function withWorkers(count: number) {
  return (s: GameState): GameState => ({ ...s, facilities: s.facilities.map((f) => (f.id === DISTILLERY_MAIN ? { ...f, workerCount: count } : f)) });
}

/** Grants every unlock the given equipment requires (so T05's QC lock doesn't stop default-data tests). */
function unlockedFor(...items: readonly EquipmentDefinition[]) {
  return (s: GameState): GameState => {
    const ids = items.map((e) => e.requiredUnlockId).filter((u): u is UnlockId => u !== null && !s.family.unlocked.includes(u));
    return ids.length === 0 ? s : { ...s, family: { ...s.family, unlocked: [...s.family.unlocked, ...ids].sort(compareIds) } };
  };
}

function advanceTo(sim: KernelSimulation, target: number): void {
  if (target < sim.state.tick) throw new Error(`Can't go back from ${sim.state.tick} to ${target}`);
  sim.advance(target - sim.state.tick);
}

function expectApplied(result: CommandResult): void {
  if (result.status !== "applied") throw new Error(`Expected applied, got ${JSON.stringify(result)}`);
}

/** Rejected with exactly `reason`, with no state change and no events. */
function expectRejected(sim: KernelSimulation, command: GameCommand, reason: RejectionReason, scheduledTick?: number): void {
  sim.takeEvents();
  const before = sim.stateHash();
  const result = sim.dispatch(scheduledTick === undefined ? { command } : { command, scheduledTick: tick(scheduledTick) });
  if (result.status !== "rejected") throw new Error(`Expected rejected ${reason.code}, got ${JSON.stringify(result)}`);
  expect(result.reason).toEqual(reason);
  expect(sim.stateHash()).toBe(before);
  expect(sim.takeEvents()).toEqual([]);
}

function reasonOf(sim: KernelSimulation, command: GameCommand): RejectionReason | null {
  const result = sim.dispatch({ command });
  return result.status === "rejected" ? result.reason : null;
}

const produce = (quantity: number, recipeId: string = BASIC_MOONSHINE_RECIPE, facilityId: FacilityId = DISTILLERY_MAIN): GameCommand => ({
  type: "START_PRODUCTION",
  facilityId,
  recipeId: recipeId as RecipeDefinition["id"],
  quantity,
});

const buyEquipment = (equipmentId: EquipmentId, facilityId: FacilityId = DISTILLERY_MAIN): GameCommand => ({
  type: "PURCHASE_EQUIPMENT",
  facilityId,
  equipmentId,
});

/** Buys the inputs for `cases` cases at the S0 supplier (so the materials carry a real cost). */
function buyInputs(sim: KernelSimulation, recipe: RecipeDefinition, cases: number): void {
  for (const input of recipe.inputsPerCase) {
    expectApplied(
      sim.dispatch({
        command: { type: "PURCHASE_MATERIALS", supplierId: MILLERS_FEED, materialId: input.materialId, quantity: input.quantity * cases, facilityId: DISTILLERY_MAIN },
      }),
    );
  }
}

function jobAt(state: GameState, facilityId: FacilityId = DISTILLERY_MAIN): ProductionJobState {
  const job = state.productionJobs.find((j) => j.facilityId === facilityId);
  if (!job) throw new Error(`No job at ${facilityId}`);
  return job;
}

function casesInStock(state: GameState, quality: "basic" | "standard" = "basic"): number {
  return state.productPools.find((p) => p.facilityId === DISTILLERY_MAIN && p.productId === MOONSHINE && p.quality === quality)?.quantity ?? 0;
}

function materialPool(state: GameState, materialId: string) {
  return state.materialPools.find((p) => p.facilityId === DISTILLERY_MAIN && p.materialId === materialId);
}

function transactionsKeyed(state: GameState, key: string): readonly LedgerTransaction[] {
  return state.ledger.transactions.filter((t) => t.idempotencyKey === key);
}

function onlyTransaction(state: GameState, key: string): LedgerTransaction {
  const found = transactionsKeyed(state, key);
  if (found.length !== 1) throw new Error(`Expected one transaction keyed ${key}, found ${found.length}`);
  return found[0]!;
}

/** The transaction's events, in its order, from the journal. */
function eventsOf(state: GameState, t: LedgerTransaction): readonly GameEvent[] {
  return t.eventIds.map((id) => {
    const e = state.eventJournal.find((x) => x.id === id);
    if (!e) throw new Error(`Event ${id} isn't in the journal`);
    return e;
  });
}

function aboutJob(events: readonly GameEvent[], jobId: ProductionJobId, type: "PRODUCTION_COMPLETED" | "PRODUCTION_FAILED"): readonly GameEvent[] {
  return events.filter((e) => (e.type === "PRODUCTION_COMPLETED" || e.type === "PRODUCTION_FAILED") && e.type === type && e.jobId === jobId);
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

const netWorth = (state: GameState): number => {
  const sheet = balanceSheet(state);
  return sheet.assets - sheet.liabilities;
};

function facilityIn(sim: KernelSimulation): FacilitySnapshot {
  const f = sim.snapshot().facilities.find((x) => x.id === DISTILLERY_MAIN);
  if (!f) throw new Error("No distillery in the snapshot");
  return f;
}

// ===========================================================================
// Game-data shape (the numbers themselves are placeholders)
// ===========================================================================

describe("PROD-001 game-data shape", () => {
  // @locked
  it("has the 3 × 3 product matrix with a positive base price per tier", () => {
    expect(GAME_DATA.products).toHaveLength(3);
    expect(GAME_DATA.products.some((p) => p.id === MOONSHINE)).toBe(true);
    for (const p of GAME_DATA.products) {
      for (const q of ["basic", "standard", "premium"] as const) {
        expect(Number.isSafeInteger(p.basePrice[q]), `${p.id} ${q}`).toBe(true);
        expect(p.basePrice[q], `${p.id} ${q}`).toBeGreaterThan(0);
      }
    }
  });

  // @locked
  it("has exactly two recipes, basic and standard moonshine, whose equipment exists", () => {
    expect(GAME_DATA.recipes).toHaveLength(2);
    expect(basic()).toMatchObject({ productId: MOONSHINE, quality: "basic" });
    expect(basic().requiredEquipmentIds).toEqual([COPPER_STILL]);
    expect(standard().requiredEquipmentIds).toContain(COPPER_STILL);
    for (const r of GAME_DATA.recipes) {
      for (const id of r.requiredEquipmentIds) expect(GAME_DATA.equipment.some((e) => e.id === id), `${r.id} needs ${id}`).toBe(true);
      expect(r.failureChance).toBeGreaterThanOrEqual(0);
      expect(r.failureChance).toBeLessThanOrEqual(PPM);
    }
  });

  // @locked
  it("has the four equipment items, with a condenser, a storage expansion, and a QC station", () => {
    expect(GAME_DATA.equipment).toHaveLength(4);
    const ids = new Set([COPPER_STILL, condenser().id, expansion().id, qcStation().id]);
    expect(ids.size).toBe(4);
    for (const e of GAME_DATA.equipment) {
      expect(typeof e.description, e.id).toBe("string");
      expect(Number.isSafeInteger(e.price) && e.price >= 0, e.id).toBe(true);
      expect(Number.isSafeInteger(e.throughputBonus) && e.throughputBonus >= 0, e.id).toBe(true);
      expect(Number.isSafeInteger(e.storageBonus) && e.storageBonus >= 0, e.id).toBe(true);
      expect(e).not.toHaveProperty("casesPerDay");
      expect(e).toHaveProperty("requiredUnlockId");
    }
  });

  // @locked
  it("has one production spec per facility", () => {
    expect(GAME_DATA.facilityProduction.map((f) => f.facilityId).sort(compareIds)).toEqual(GAME_DATA.facilities.map((f) => f.id).sort(compareIds));
    for (const f of GAME_DATA.facilityProduction) {
      expect(Number.isSafeInteger(f.equipmentSlots) && f.equipmentSlots >= 0, f.facilityId).toBe(true);
      expect(Number.isSafeInteger(f.baseStorage) && f.baseStorage >= 0, f.facilityId).toBe(true);
    }
  });
});

// ===========================================================================
// Capacity helpers (ADR 0017 decisions 1–3)
// ===========================================================================

describe("PROD-001 capacity helpers", () => {
  // @locked
  it("throughput is RATIO_SCALE plus the owned bonuses: 1× at the start, more with the condenser", () => {
    const start = game().sim.state;
    expect(throughput(start, GAME_DATA, DISTILLERY_MAIN)).toBe(expectedThroughput(start));
    expect(throughput(start, GAME_DATA, DISTILLERY_MAIN)).toBe(PPM);

    const withCondenser = game({ equipment: [COPPER_STILL, condenser().id], workers: FULL_CREW }).sim.state;
    expect(throughput(withCondenser, GAME_DATA, DISTILLERY_MAIN)).toBe(PPM + condenser().throughputBonus);
  });

  // @locked
  it("throughput is 0 when the facility owns no equipment that any recipe requires", () => {
    expect(throughput(game({ equipment: [] }).sim.state, GAME_DATA, DISTILLERY_MAIN)).toBe(0);
    expect(throughput(game({ equipment: [expansion().id] }).sim.state, GAME_DATA, DISTILLERY_MAIN)).toBe(0);
  });

  // @locked
  it("jobDuration is ceil(ticksPerCase × quantity × RATIO_SCALE / throughput), exactly", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 1, max: 5_000_000 }),
        (ticksPerCase, quantity, t) => {
          const recipe: RecipeDefinition = { ...basic(), ticksPerCase };
          // Exact in BigInt: durationOf rounds through Number, which is lossy above 2^53.
          const num = BigInt(ticksPerCase) * BigInt(quantity) * BigInt(PPM);
          const den = BigInt(t);
          const exact = (num + den - 1n) / den;
          if (exact <= BigInt(Number.MAX_SAFE_INTEGER)) {
            const d = jobDuration(recipe, quantity, ratio(t));
            expect(Number.isSafeInteger(d)).toBe(true);
            expect(BigInt(d)).toBe(exact);
          } else {
            expect(() => jobDuration(recipe, quantity, ratio(t))).toThrow(RangeError);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  // @locked
  it("at 1× a job takes exactly ticksPerCase × quantity; with the condenser 10 cases take ceil(ticksPerCase × 10 / ratio)", () => {
    for (const q of [1, 5, 10, 37]) expect(jobDuration(basic(), q, ratio(PPM))).toBe(basic().ticksPerCase * q);
    const t = PPM + condenser().throughputBonus;
    expect(jobDuration(basic(), 10, ratio(t))).toBe(durationOf(basic().ticksPerCase, 10, t));
  });

  // @locked
  it("storageCapacity is baseStorage plus the owned storage bonuses", () => {
    const start = game().sim.state;
    expect(storageCapacity(start, GAME_DATA, DISTILLERY_MAIN)).toBe(expectedCapacity(start));
    expect(storageCapacity(start, GAME_DATA, DISTILLERY_MAIN)).toBe(facilitySpec().baseStorage);

    const expanded = game({ equipment: [COPPER_STILL, expansion().id] }).sim.state;
    expect(storageCapacity(expanded, GAME_DATA, DISTILLERY_MAIN)).toBe(facilitySpec().baseStorage + expansion().storageBonus);

    const bigger = withFacilitySpec({ baseStorage: 7 });
    expect(storageCapacity(game({ data: bigger }).sim.state, bigger, DISTILLERY_MAIN)).toBe(7);
  });

  // @locked
  it("storageCommitted is cases in stock plus running jobs' output; materials don't count", () => {
    const g = game();
    expect(storageCommitted(g.sim.state, DISTILLERY_MAIN)).toBe(0);
    edit(g, (s) => freeMaterials(basic(), 100)(s));
    expect(storageCommitted(g.sim.state, DISTILLERY_MAIN)).toBe(0);
    edit(g, (s) => runningJob(15)(freeCases(30)(s)));
    expect(storageUsed(g.sim.state, DISTILLERY_MAIN)).toBe(30);
    expect(storageCommitted(g.sim.state, DISTILLERY_MAIN)).toBe(45);
  });
});

// ===========================================================================
// START_PRODUCTION: check order (ADR 0017, issue #7)
// ===========================================================================

describe("PROD-001 START_PRODUCTION check order", () => {
  const Q = 5;
  /** Cash one cent short of Q basic cases' conversion cost. */
  const lowCash = () => cents(conversionCost(basic(), Q) - 1);

  // @locked
  it("1. INVALID_QUANTITY comes first, even for an unknown facility and recipe", () => {
    const { sim } = game();
    for (const q of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX + 1]) {
      expectRejected(sim, produce(q, UNKNOWN_RECIPE, UNKNOWN_FACILITY), { code: "INVALID_QUANTITY", field: "quantity", value: q });
      expectRejected(sim, produce(q), { code: "INVALID_QUANTITY", field: "quantity", value: q });
    }
  });

  // @locked
  it("2. UNKNOWN_ENTITY: the facility, then the recipe", () => {
    const { sim } = game();
    expectRejected(sim, produce(Q, UNKNOWN_RECIPE, UNKNOWN_FACILITY), { code: "UNKNOWN_ENTITY", kind: "Facility", id: UNKNOWN_FACILITY });
    expectRejected(sim, produce(Q, BASIC_MOONSHINE_RECIPE, UNKNOWN_FACILITY), { code: "UNKNOWN_ENTITY", kind: "Facility", id: UNKNOWN_FACILITY });
    expectRejected(sim, produce(Q, UNKNOWN_RECIPE), { code: "UNKNOWN_ENTITY", kind: "Recipe", id: UNKNOWN_RECIPE });
  });

  // @locked
  it("3. RECIPE_NOT_SUPPORTED when any required equipment is missing, before capacity, storage, materials, and cash", () => {
    const g = game({ cash: lowCash() });
    edit(g, (s) => runningJob(Q)(freeCases(expectedCapacity(s))(s)));
    expectRejected(g.sim, produce(Q, standard().id), { code: "RECIPE_NOT_SUPPORTED", facilityId: DISTILLERY_MAIN, recipeId: standard().id });

    const bare = game({ cash: lowCash(), equipment: [] });
    expectRejected(bare.sim, produce(Q), { code: "RECIPE_NOT_SUPPORTED", facilityId: DISTILLERY_MAIN, recipeId: BASIC_MOONSHINE_RECIPE });
  });

  // @locked
  it("4. PRODUCTION_CAPACITY_EXCEEDED { available: 0 } while a job runs, before storage, materials, and cash", () => {
    const g = game({ cash: lowCash() });
    edit(g, (s) => runningJob(Q)(freeCases(expectedCapacity(s))(s)));
    expectRejected(g.sim, produce(Q), { code: "PRODUCTION_CAPACITY_EXCEEDED", facilityId: DISTILLERY_MAIN, requested: Q, available: 0 });
  });

  // @locked
  it("4. PRODUCTION_CAPACITY_EXCEEDED { available: 0 } at a facility with zero throughput", () => {
    const data = withHandMash();
    const g = game({ data, equipment: [] });
    expect(throughput(g.sim.state, data, DISTILLERY_MAIN)).toBe(0);
    edit(g, freeMaterials(recipeById(HAND_MASH, data), Q));
    expectRejected(g.sim, produce(Q, HAND_MASH), { code: "PRODUCTION_CAPACITY_EXCEEDED", facilityId: DISTILLERY_MAIN, requested: Q, available: 0 });
  });

  // @locked
  it("5. STORAGE_CAPACITY_EXCEEDED { available: capacity − committed }, before materials and cash", () => {
    const g = game({ cash: lowCash() });
    edit(g, (s) => freeCases(expectedCapacity(s) - 2)(s));
    expectRejected(g.sim, produce(Q), { code: "STORAGE_CAPACITY_EXCEEDED", facilityId: DISTILLERY_MAIN, requested: Q, available: 2 });
  });

  // @locked
  it("6. INSUFFICIENT_MATERIALS for the first short input line, before cash", () => {
    const g = game({ cash: lowCash() });
    const first = basic().inputsPerCase[0]!;
    expectRejected(g.sim, produce(Q), { code: "INSUFFICIENT_MATERIALS", materialId: first.materialId, required: first.quantity * Q, available: 0 });
  });

  // @locked
  it("7. INSUFFICIENT_FUNDS when cash is below the conversion cost", () => {
    const g = game({ cash: lowCash() });
    edit(g, freeMaterials(basic(), Q));
    expectRejected(g.sim, produce(Q), { code: "INSUFFICIENT_FUNDS", required: conversionCost(basic(), Q), available: lowCash() });
  });

  // @locked
  it("accepts once every check passes (cash exactly the conversion cost)", () => {
    const g = game({ cash: conversionCost(basic(), Q) });
    edit(g, freeMaterials(basic(), Q));
    expectApplied(g.sim.dispatch({ command: produce(Q) }));
  });
});

// ===========================================================================
// START_PRODUCTION: rule 6 overflow (from #47)
// ===========================================================================

describe("PROD-001 START_PRODUCTION overflow never throws", () => {
  // @locked
  it("rejects Number.MAX_SAFE_INTEGER with INVALID_QUANTITY at apply time, state unchanged", () => {
    const g = game();
    edit(g, freeMaterials(basic(), 10));
    expectRejected(g.sim, produce(MAX), { code: "INVALID_QUANTITY", field: "quantity", value: MAX });
  });

  // @locked
  it("rejects overflowing quantities at dispatch time too (validate, for a queued command)", () => {
    const { sim } = game();
    const later = sim.state.tick + 5;
    const over = Math.floor(MAX / (basic().laborPerCase + basic().overheadPerCase)) + 1;
    for (const q of [MAX, over, Math.floor(MAX / basic().ticksPerCase) + 1]) {
      expectRejected(sim, produce(q), { code: "INVALID_QUANTITY", field: "quantity", value: q }, later);
    }
  });

  // @locked
  it("the bound is exact: the largest safe quantity reaches the storage check, one more is INVALID_QUANTITY", () => {
    const { sim } = game();
    const bound = overflowBound(basic(), sim.state.tick + 1);
    expectRejected(sim, produce(bound + 1), { code: "INVALID_QUANTITY", field: "quantity", value: bound + 1 });
    expectRejected(sim, produce(bound), {
      code: "STORAGE_CAPACITY_EXCEEDED",
      facilityId: DISTILLERY_MAIN,
      requested: bound,
      available: expectedCapacity(sim.state),
    });
  });

  // @locked
  it("a zero-cost recipe at a tick other than 0 is bounded by its completion tick", () => {
    const data = withRecipe(BASIC_MOONSHINE_RECIPE, { laborPerCase: cents(0), overheadPerCase: cents(0) });
    const g = game({ data });
    advanceTo(g.sim, 100);
    const recipe = recipeById(BASIC_MOONSHINE_RECIPE, data);
    const applyTick = g.sim.state.tick + 1;
    const bound = overflowBound(recipe, applyTick);
    expect(bound).toBe(Math.floor((MAX - applyTick) / recipe.ticksPerCase));
    expectRejected(g.sim, produce(bound + 1), { code: "INVALID_QUANTITY", field: "quantity", value: bound + 1 });
    expectRejected(g.sim, produce(bound), {
      code: "STORAGE_CAPACITY_EXCEEDED",
      facilityId: DISTILLERY_MAIN,
      requested: bound,
      available: expectedCapacity(g.sim.state, data),
    });
  });

  // @locked
  it("property: no quantity makes START_PRODUCTION throw", () => {
    const { sim } = game();
    fc.assert(
      fc.property(fc.oneof(fc.integer({ min: 1, max: MAX }), fc.constantFrom(MAX, MAX - 1, 4_503_599_627_370_496, 1_099_511_627_776)), (q) => {
        const before = sim.stateHash();
        const result = sim.dispatch({ command: produce(q) });
        expect(result.status).toBe("rejected");
        expect(sim.stateHash()).toBe(before);
      }),
      { numRuns: 200 },
    );
  });
});

// ===========================================================================
// START_PRODUCTION: success, timing, one job, storage
// ===========================================================================

describe("PROD-001 START_PRODUCTION success", () => {
  // @locked
  it("reserves each input line for the job, schedules it, and emits PRODUCTION_STARTED in an empty RESERVATION transaction", () => {
    const g = game();
    edit(g, freeMaterials(basic(), 10));
    g.sim.takeEvents();
    // An eager command applies as the first thing of the next tick.
    const applyTick = g.sim.state.tick + 1;
    const result = g.sim.dispatch({ command: produce(4) });
    expectApplied(result);
    const s = g.sim.state;
    const job = jobAt(s);
    expect(job).toMatchObject({ facilityId: DISTILLERY_MAIN, recipeId: BASIC_MOONSHINE_RECIPE, quantity: 4, startedAt: applyTick });
    expect(job.completesAt).toBe(applyTick + basic().ticksPerCase * 4);

    expect(job.reservationIds).toHaveLength(basic().inputsPerCase.length);
    basic().inputsPerCase.forEach((input, i) => {
      const r = s.reservations.find((x) => x.id === job.reservationIds[i]);
      expect(r).toEqual({
        id: job.reservationIds[i],
        facilityId: DISTILLERY_MAIN,
        goods: { kind: "MATERIAL", materialId: input.materialId },
        quantity: input.quantity * 4,
        holder: { kind: "PRODUCTION_JOB", jobId: job.id },
      });
    });

    const t = onlyTransaction(s, idempotencyKey("RESERVATION", job.id));
    expect(t.kind).toBe("RESERVATION");
    expect(t.entries).toEqual([]);
    expect(t.tick).toBe(applyTick);
    const events = eventsOf(s, t);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "PRODUCTION_STARTED",
      jobId: job.id,
      facilityId: DISTILLERY_MAIN,
      recipeId: BASIC_MOONSHINE_RECIPE,
      quantity: 4,
      completesAt: job.completesAt,
    });
  });

  // @locked
  it("with the condenser and a full crew, 10 cases take jobDuration at the raised throughput", () => {
    const g = game({ equipment: [COPPER_STILL, condenser().id], workers: FULL_CREW });
    edit(g, freeMaterials(basic(), 10));
    expectApplied(g.sim.dispatch({ command: produce(10) }));
    const job = jobAt(g.sim.state);
    const t = PPM + condenser().throughputBonus;
    expect(job.completesAt - job.startedAt).toBe(durationOf(basic().ticksPerCase, 10, t));
    expect(job.completesAt - job.startedAt).toBe(jobDuration(basic(), 10, throughput(g.sim.state, GAME_DATA, DISTILLERY_MAIN)));
  });

  // @locked
  it("allows one job at a time per facility, and another once it completes", () => {
    const g = game();
    edit(g, freeMaterials(basic(), 20));
    expectApplied(g.sim.dispatch({ command: produce(2) }));
    expectRejected(g.sim, produce(3), { code: "PRODUCTION_CAPACITY_EXCEEDED", facilityId: DISTILLERY_MAIN, requested: 3, available: 0 });
    advanceTo(g.sim, jobAt(g.sim.state).completesAt);
    expect(g.sim.state.productionJobs).toEqual([]);
    expectApplied(g.sim.dispatch({ command: produce(3) }));
  });

  // @locked
  it("storage counts cases in stock plus running output; a start may fill it exactly; materials don't count", () => {
    const g = game();
    const cap = expectedCapacity(g.sim.state);
    edit(g, (s) => freeMaterials(basic(), cap + 50)(freeCases(cap - 5)(s)));
    expectRejected(g.sim, produce(6), { code: "STORAGE_CAPACITY_EXCEEDED", facilityId: DISTILLERY_MAIN, requested: 6, available: 5 });
    expectApplied(g.sim.dispatch({ command: produce(5) }));
    expect(storageCommitted(g.sim.state, DISTILLERY_MAIN)).toBe(cap);
  });

  // @locked
  it("a running job's output counts as committed storage", () => {
    const g = game();
    const cap = expectedCapacity(g.sim.state);
    edit(g, (s) => runningJob(cap - 3)(freeMaterials(basic(), 20)(s)));
    // The running job also holds production capacity, so a second start can't reach the storage check.
    expect(storageCommitted(g.sim.state, DISTILLERY_MAIN)).toBe(cap - 3);
    expect(storageCapacity(g.sim.state, GAME_DATA, DISTILLERY_MAIN) - storageCommitted(g.sim.state, DISTILLERY_MAIN)).toBe(3);
  });

  // @locked
  it("STORAGE_CAPACITY_EXCEEDED reports available 0 when stock is already over capacity", () => {
    const g = game();
    edit(g, (s) => freeMaterials(basic(), 5)(freeCases(expectedCapacity(s) + 3)(s)));
    expectRejected(g.sim, produce(1), { code: "STORAGE_CAPACITY_EXCEEDED", facilityId: DISTILLERY_MAIN, requested: 1, available: 0 });
  });

  // @locked
  it("completion never fails for lack of space", () => {
    const g = game();
    const cap = expectedCapacity(g.sim.state);
    edit(g, (s) => freeMaterials(basic(), 5)(freeCases(cap - 5)(s)));
    expectApplied(g.sim.dispatch({ command: produce(5) }));
    const job = jobAt(g.sim.state);
    // Goods arrive by another route (T03's returned cargo) while the job runs.
    edit(g, freeCases(20));
    advanceTo(g.sim, job.completesAt);
    expect(g.sim.state.productionJobs).toEqual([]);
    expect(casesInStock(g.sim.state)).toBe(cap - 5 + 20 + 5);
    expect(transactionsKeyed(g.sim.state, idempotencyKey("PRODUCTION", job.id))).toHaveLength(1);
  });
});

// ===========================================================================
// Completion (FIN-001; ADR 0017 decision 7)
// ===========================================================================

describe("PROD-001 completion", () => {
  // @locked
  it("consumes the reservations and capitalizes materials + conversion, exactly as S0 posts it", () => {
    const g = game();
    const Q = 5;
    buyInputs(g.sim, basic(), Q);
    const materials = basic().inputsPerCase.reduce((n, i) => n + materialPool(g.sim.state, i.materialId)!.totalCost, 0);
    expectApplied(g.sim.dispatch({ command: produce(Q) }));
    const job = jobAt(g.sim.state);
    expect(job.completesAt).toBeLessThan(TICKS_PER_DAY);
    advanceTo(g.sim, job.completesAt - 1);
    expect(transactionsKeyed(g.sim.state, idempotencyKey("PRODUCTION", job.id))).toEqual([]);
    const cashBefore = cashBalance(g.sim.state);
    const rngBefore = g.sim.state.rng.production;
    advanceTo(g.sim, job.completesAt);

    const s = g.sim.state;
    const conversion = conversionCost(basic(), Q);
    expect(cashBefore).toBeGreaterThanOrEqual(conversion);
    const t = onlyTransaction(s, idempotencyKey("PRODUCTION", job.id));
    expect(t).toMatchObject({ kind: "PRODUCTION", tick: job.completesAt });
    expectEntries(t.entries, [dr("FINISHED_GOODS", materials + conversion), cr("RAW_MATERIALS", materials), cr("CASH", conversion)]);
    expect(cashBalance(s)).toBe(cashBefore - conversion);

    const events = eventsOf(s, t);
    expect(events.map((e) => e.type)).toEqual([...job.reservationIds.map(() => "RESERVATION_RELEASED"), "PRODUCTION_COMPLETED"]);
    job.reservationIds.forEach((id, i) => expect(events[i]).toMatchObject({ reservationId: id, reason: "CONSUMED" }));
    expect(events.at(-1)).toMatchObject({
      type: "PRODUCTION_COMPLETED",
      jobId: job.id,
      facilityId: DISTILLERY_MAIN,
      productId: MOONSHINE,
      quality: "basic",
      quantity: Q,
      costBasis: materials + conversion,
      transactionId: t.id,
    });

    expect(s.productionJobs).toEqual([]);
    expect(s.reservations.filter((r) => job.reservationIds.includes(r.id))).toEqual([]);
    for (const i of basic().inputsPerCase) expect(materialPool(s, i.materialId)?.quantity ?? 0).toBe(0);
    expect(s.productPools.find((p) => p.productId === MOONSHINE && p.quality === "basic")).toMatchObject({ quantity: Q, totalCost: materials + conversion });
    // failureChance 0 draws nothing.
    expect(s.rng.production).toEqual(rngBefore);
  });

  // @locked
  it("accrues the conversion cost cash can't cover to WAGES_PAYABLE, to the cent, when cash was spent after the start", () => {
    const Q = 5;
    const conversion = conversionCost(basic(), Q);
    const item = expansion();
    const leftAfterPurchase = Math.floor(conversion / 3);
    expect(item.price + leftAfterPurchase).toBeGreaterThanOrEqual(conversion);
    const g = game({ cash: cents(item.price + leftAfterPurchase) });
    edit(g, (s) => unlockedFor(item)(freeMaterials(basic(), Q)(s)));
    expectApplied(g.sim.dispatch({ command: produce(Q) }));
    const job = jobAt(g.sim.state);
    expectApplied(g.sim.dispatch({ command: buyEquipment(item.id) }));
    expect(cashBalance(g.sim.state)).toBe(leftAfterPurchase);
    expect(job.completesAt).toBeLessThan(TICKS_PER_DAY);
    advanceTo(g.sim, job.completesAt);

    const t = onlyTransaction(g.sim.state, idempotencyKey("PRODUCTION", job.id));
    expectEntries(t.entries, [dr("FINISHED_GOODS", conversion), cr("CASH", leftAfterPurchase), cr("WAGES_PAYABLE", conversion - leftAfterPurchase)]);
    expect(cashBalance(g.sim.state)).toBe(0);
  });

  // @locked
  it("a job's completesAt is fixed at start: buying the condenser mid-job doesn't re-time it, but the next job is faster", () => {
    const g = game();
    edit(g, (s) => unlockedFor(condenser())(freeMaterials(basic(), 10)(s)));
    expectApplied(g.sim.dispatch({ command: produce(5) }));
    const job = jobAt(g.sim.state);
    expect(job.completesAt).toBe(job.startedAt + basic().ticksPerCase * 5);
    expectApplied(g.sim.dispatch({ command: buyEquipment(condenser().id) }));
    expect(jobAt(g.sim.state)).toEqual(job);
    advanceTo(g.sim, job.completesAt - 1);
    expect(jobAt(g.sim.state)).toEqual(job);
    advanceTo(g.sim, job.completesAt);
    expect(onlyTransaction(g.sim.state, idempotencyKey("PRODUCTION", job.id)).tick).toBe(job.completesAt);

    edit(g, withWorkers(FULL_CREW));
    expectApplied(g.sim.dispatch({ command: produce(5) }));
    const next = jobAt(g.sim.state);
    expect(next.completesAt - next.startedAt).toBe(durationOf(basic().ticksPerCase, 5, PPM + condenser().throughputBonus));
    expect(next.completesAt - next.startedAt).toBeLessThan(basic().ticksPerCase * 5);
  });
});

// ===========================================================================
// Failure (ADR 0017 decision 5)
// ===========================================================================

describe("PROD-001 failure", () => {
  // @locked
  it("failureChance 1 000 000 always fails: inputs and conversion written off to LOSSES in PRODUCTION_WRITE_OFF", () => {
    const data = failing(PPM);
    const g = game({ data });
    const Q = 5;
    buyInputs(g.sim, basic(), Q);
    const materials = basic().inputsPerCase.reduce((n, i) => n + materialPool(g.sim.state, i.materialId)!.totalCost, 0);
    expectApplied(g.sim.dispatch({ command: produce(Q) }));
    const job = jobAt(g.sim.state);
    expect(job.completesAt).toBeLessThan(TICKS_PER_DAY);
    advanceTo(g.sim, job.completesAt - 1);
    const cashBefore = cashBalance(g.sim.state);
    const rngBefore = g.sim.state.rng.production;
    const worthBefore = netWorth(g.sim.state);
    advanceTo(g.sim, job.completesAt);

    const s = g.sim.state;
    const conversion = conversionCost(basic(), Q);
    expect(transactionsKeyed(s, idempotencyKey("PRODUCTION", job.id))).toEqual([]);
    const t = onlyTransaction(s, idempotencyKey("PRODUCTION_WRITE_OFF", job.id));
    expect(t).toMatchObject({ kind: "PRODUCTION_WRITE_OFF", tick: job.completesAt });
    expectEntries(t.entries, [dr("LOSSES", materials + conversion), cr("RAW_MATERIALS", materials), cr("CASH", conversion)]);
    expect(cashBalance(s)).toBe(cashBefore - conversion);
    expect(netWorth(s)).toBe(worthBefore - materials - conversion);

    const events = eventsOf(s, t);
    expect(events.map((e) => e.type)).toEqual([...job.reservationIds.map(() => "RESERVATION_RELEASED"), "PRODUCTION_FAILED"]);
    job.reservationIds.forEach((id, i) => expect(events[i]).toMatchObject({ reservationId: id, reason: "PRODUCTION_FAILED" }));
    expect(events.at(-1)).toMatchObject({
      type: "PRODUCTION_FAILED",
      jobId: job.id,
      facilityId: DISTILLERY_MAIN,
      reason: "DISRUPTION",
      writtenOff: materials + conversion,
      transactionId: t.id,
    });

    expect(s.productionJobs).toEqual([]);
    expect(s.reservations.filter((r) => job.reservationIds.includes(r.id))).toEqual([]);
    for (const i of basic().inputsPerCase) expect(materialPool(s, i.materialId)?.quantity ?? 0).toBe(0);
    expect(casesInStock(s)).toBe(0);
    // Exactly one draw from the production stream.
    expect(s.rng.production).toEqual(nextInt(rngBefore, PPM).rng);
  });

  // @locked
  it("a failed job's conversion cost is paid from cash first, then WAGES_PAYABLE", () => {
    const Q = 5;
    const data = failing(PPM);
    const conversion = conversionCost(basic(), Q);
    const item = expansion();
    const left = Math.floor(conversion / 4);
    expect(item.price + left).toBeGreaterThanOrEqual(conversion);
    const g = game({ data, cash: cents(item.price + left) });
    edit(g, (s) => unlockedFor(item)(freeMaterials(basic(), Q)(s)));
    expectApplied(g.sim.dispatch({ command: produce(Q) }));
    const job = jobAt(g.sim.state);
    expectApplied(g.sim.dispatch({ command: buyEquipment(item.id) }));
    advanceTo(g.sim, job.completesAt);
    const t = onlyTransaction(g.sim.state, idempotencyKey("PRODUCTION_WRITE_OFF", job.id));
    expectEntries(t.entries, [dr("LOSSES", conversion), cr("CASH", left), cr("WAGES_PAYABLE", conversion - left)]);
    expect(cashBalance(g.sim.state)).toBe(0);
    expect(eventsOf(g.sim.state, t).at(-1)).toMatchObject({ type: "PRODUCTION_FAILED", writtenOff: conversion });
  });

  // @locked
  it("failureChance 0 never fails and never draws", () => {
    const data = failing(0);
    const g = game({ data });
    edit(g, freeMaterials(basic(), 5));
    const rngBefore = g.sim.state.rng.production;
    expectApplied(g.sim.dispatch({ command: produce(5) }));
    const job = jobAt(g.sim.state);
    advanceTo(g.sim, job.completesAt);
    expect(transactionsKeyed(g.sim.state, idempotencyKey("PRODUCTION", job.id))).toHaveLength(1);
    expect(transactionsKeyed(g.sim.state, idempotencyKey("PRODUCTION_WRITE_OFF", job.id))).toEqual([]);
    expect(casesInStock(g.sim.state)).toBe(5);
    expect(g.sim.state.rng.production).toEqual(rngBefore);
  });

  // @locked
  it("seeded run (seed 1920, failureChance 850 000): the first job completes and the second fails", () => {
    const CHANCE = 850_000;
    const data = failing(CHANCE);
    const g = game({ data, seed: 1920 });
    // The draws, recomputed: one per completion from the production stream.
    const first = nextInt(seedRng(1920, "production"), PPM);
    const second = nextInt(first.rng, PPM);
    expect(g.sim.state.rng.production).toEqual(seedRng(1920, "production"));
    expect(first.value >= CHANCE).toBe(true);
    expect(second.value < CHANCE).toBe(true);

    edit(g, freeMaterials(basic(), 4));
    expectApplied(g.sim.dispatch({ command: produce(2) }));
    const job1 = jobAt(g.sim.state);
    advanceTo(g.sim, job1.completesAt);
    expectApplied(g.sim.dispatch({ command: produce(2) }));
    const job2 = jobAt(g.sim.state);
    expect(job2.completesAt).toBeLessThan(TICKS_PER_DAY);
    advanceTo(g.sim, job2.completesAt);

    const s = g.sim.state;
    expect(transactionsKeyed(s, idempotencyKey("PRODUCTION", job1.id))).toHaveLength(1);
    expect(transactionsKeyed(s, idempotencyKey("PRODUCTION_WRITE_OFF", job1.id))).toEqual([]);
    expect(transactionsKeyed(s, idempotencyKey("PRODUCTION", job2.id))).toEqual([]);
    expect(transactionsKeyed(s, idempotencyKey("PRODUCTION_WRITE_OFF", job2.id))).toHaveLength(1);
    expect(casesInStock(s)).toBe(2);
    expect(s.rng.production).toEqual(second.rng);
  });
});

// ===========================================================================
// Midnight (SIM-001: midnight production must not be double-settled)
// ===========================================================================

describe("PROD-001 a job completing on the midnight tick", () => {
  /** Starts Q basic cases so the job completes exactly at tick TICKS_PER_DAY. */
  function startForMidnight(data: GameData, Q: number): { g: Game; job: ProductionJobState } {
    const g = game({ data });
    edit(g, freeMaterials(basic(), Q));
    const applyTick = TICKS_PER_DAY - basic().ticksPerCase * Q;
    expect(applyTick).toBeGreaterThan(0);
    advanceTo(g.sim, applyTick - 1);
    expectApplied(g.sim.dispatch({ command: produce(Q) }));
    const job = jobAt(g.sim.state);
    expect(job.completesAt).toBe(TICKS_PER_DAY);
    return { g, job };
  }

  // @locked
  it("completes once", () => {
    const Q = 5;
    const { g, job } = startForMidnight(GAME_DATA, Q);
    g.sim.takeEvents();
    advanceTo(g.sim, TICKS_PER_DAY);
    const events = [...g.sim.takeEvents()];
    advanceTo(g.sim, 2 * TICKS_PER_DAY + 1);
    events.push(...g.sim.takeEvents());

    const s = g.sim.state;
    const done = transactionsKeyed(s, idempotencyKey("PRODUCTION", job.id));
    expect(done).toHaveLength(1);
    expect(done[0]!.tick).toBe(TICKS_PER_DAY);
    expect(s.ledger.transactions.filter((t) => t.kind === "PRODUCTION")).toHaveLength(1);
    expect(aboutJob(events, job.id, "PRODUCTION_COMPLETED")).toHaveLength(1);
    expect(s.productionJobs).toEqual([]);
    expect(casesInStock(s)).toBe(Q);
  });

  // @locked
  it("fails once (fixture failureChance 1 000 000)", () => {
    const Q = 5;
    const { g, job } = startForMidnight(failing(PPM), Q);
    const rngBefore = g.sim.state.rng.production;
    g.sim.takeEvents();
    advanceTo(g.sim, 2 * TICKS_PER_DAY + 1);
    const events = g.sim.takeEvents();

    const s = g.sim.state;
    const failed = transactionsKeyed(s, idempotencyKey("PRODUCTION_WRITE_OFF", job.id));
    expect(failed).toHaveLength(1);
    expect(failed[0]!.tick).toBe(TICKS_PER_DAY);
    expect(s.ledger.transactions.filter((t) => t.kind === "PRODUCTION" || t.kind === "PRODUCTION_WRITE_OFF")).toHaveLength(1);
    expect(aboutJob(events, job.id, "PRODUCTION_FAILED")).toHaveLength(1);
    expect(aboutJob(events, job.id, "PRODUCTION_COMPLETED")).toHaveLength(0);
    expect(s.rng.production).toEqual(nextInt(rngBefore, PPM).rng);
  });
});

// ===========================================================================
// PURCHASE_EQUIPMENT (ADR 0017 decision 6)
// ===========================================================================

describe("PROD-001 PURCHASE_EQUIPMENT check order", () => {
  // @locked
  it("1. UNKNOWN_ENTITY: the facility, then the equipment", () => {
    const { sim } = game();
    expectRejected(sim, buyEquipment(UNKNOWN_EQUIPMENT, UNKNOWN_FACILITY), { code: "UNKNOWN_ENTITY", kind: "Facility", id: UNKNOWN_FACILITY });
    expectRejected(sim, buyEquipment(condenser().id, UNKNOWN_FACILITY), { code: "UNKNOWN_ENTITY", kind: "Facility", id: UNKNOWN_FACILITY });
    expectRejected(sim, buyEquipment(UNKNOWN_EQUIPMENT), { code: "UNKNOWN_ENTITY", kind: "Equipment", id: UNKNOWN_EQUIPMENT });
  });

  // @locked
  it("2. EQUIPMENT_ALREADY_OWNED, before the lock, slots, and cash", () => {
    const data = withFacilitySpec({ equipmentSlots: 1 }, withEquipment(COPPER_STILL, { requiredUnlockId: FIXTURE_UNLOCK }));
    const { sim } = game({ data, cash: cents(0) });
    expectRejected(sim, buyEquipment(COPPER_STILL), { code: "EQUIPMENT_ALREADY_OWNED", facilityId: DISTILLERY_MAIN, equipmentId: COPPER_STILL });
  });

  // @locked
  it("3. LOCKED { unlockId } when requiredUnlockId isn't unlocked, before slots and cash", () => {
    const item = condenser();
    const data = withFacilitySpec({ equipmentSlots: 1 }, withEquipment(item.id, { requiredUnlockId: FIXTURE_UNLOCK }));
    const { sim } = game({ data, cash: cents(0) });
    expect(sim.state.family.unlocked).not.toContain(FIXTURE_UNLOCK);
    expectRejected(sim, buyEquipment(item.id), { code: "LOCKED", unlockId: FIXTURE_UNLOCK });
  });

  // @locked
  it("passes the lock once the unlock is in family.unlocked", () => {
    const item = condenser();
    const data = withEquipment(item.id, { requiredUnlockId: FIXTURE_UNLOCK });
    const g = game({ data });
    edit(g, (s) => ({ ...s, family: { ...s.family, unlocked: [...s.family.unlocked, FIXTURE_UNLOCK].sort(compareIds) } }));
    expectApplied(g.sim.dispatch({ command: buyEquipment(item.id) }));
    expect(owned(g.sim.state)).toContain(item.id);
  });

  // @locked
  it("4. NO_EQUIPMENT_SLOT when every slot is used, before cash", () => {
    const item = condenser();
    const data = withFacilitySpec({ equipmentSlots: 1 });
    const g = game({ data, cash: cents(0) });
    edit(g, unlockedFor(item));
    expectRejected(g.sim, buyEquipment(item.id), { code: "NO_EQUIPMENT_SLOT", facilityId: DISTILLERY_MAIN, equipmentId: item.id });
  });

  // @locked
  it("5. INSUFFICIENT_FUNDS when cash is below the price", () => {
    const item = condenser();
    const cash = cents(item.price - 1);
    const g = game({ cash });
    edit(g, unlockedFor(item));
    expectRejected(g.sim, buyEquipment(item.id), { code: "INSUFFICIENT_FUNDS", required: item.price, available: cash });
  });
});

describe("PROD-001 PURCHASE_EQUIPMENT success", () => {
  // @locked
  it("posts Dr EQUIPMENT / Cr CASH at the price, adds the item at book value, and emits EQUIPMENT_PURCHASED", () => {
    const item = condenser();
    const g = game({ cash: cents(item.price) });
    edit(g, unlockedFor(item));
    const worthBefore = netWorth(g.sim.state);
    const applyTick = g.sim.state.tick + 1;
    g.sim.takeEvents();
    const result = g.sim.dispatch({ command: buyEquipment(item.id) });
    expectApplied(result);
    const s = g.sim.state;

    const t = onlyTransaction(s, idempotencyKey("EQUIPMENT_PURCHASE", DISTILLERY_MAIN, item.id));
    expect(t.kind).toBe("EQUIPMENT_PURCHASE");
    expect(t.tick).toBe(applyTick);
    expectEntries(t.entries, [dr("EQUIPMENT", item.price), cr("CASH", item.price)]);
    expect(cashBalance(s)).toBe(0);
    expect(netWorth(s)).toBe(worthBefore);

    const facility = s.facilities.find((f) => f.id === DISTILLERY_MAIN)!;
    expect(facility.equipment).toContainEqual({ equipmentId: item.id, bookValue: item.price });
    const events = eventsOf(s, t);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "EQUIPMENT_PURCHASED", facilityId: DISTILLERY_MAIN, equipmentId: item.id, price: item.price, transactionId: t.id });
    expect(g.sim.takeEvents().map((e) => e.id)).toEqual(t.eventIds);
  });

  // @locked
  it("keeps the facility's equipment sorted by ID, and a second purchase of the same item is rejected", () => {
    const g = game({ data: roomy(), cash: cents(10_000_000) });
    const others = GAME_DATA.equipment.filter((e) => e.id !== COPPER_STILL);
    edit(g, unlockedFor(...others));
    for (const e of [...others].reverse()) expectApplied(g.sim.dispatch({ command: buyEquipment(e.id) }));
    const ids = owned(g.sim.state);
    expect(ids).toEqual([...ids].sort(compareIds));
    expect([...ids].sort(compareIds)).toEqual(GAME_DATA.equipment.map((e) => e.id).sort(compareIds));
    for (const e of others) {
      expectRejected(g.sim, buyEquipment(e.id), { code: "EQUIPMENT_ALREADY_OWNED", facilityId: DISTILLERY_MAIN, equipmentId: e.id });
    }
  });

  // @locked
  it("the storage expansion raises capacity at once", () => {
    const item = expansion();
    const g = game();
    const cap = expectedCapacity(g.sim.state);
    edit(g, (s) => unlockedFor(item)(freeMaterials(basic(), 10)(freeCases(cap)(s))));
    expectRejected(g.sim, produce(1), { code: "STORAGE_CAPACITY_EXCEEDED", facilityId: DISTILLERY_MAIN, requested: 1, available: 0 });
    expectApplied(g.sim.dispatch({ command: buyEquipment(item.id) }));
    expect(storageCapacity(g.sim.state, GAME_DATA, DISTILLERY_MAIN)).toBe(cap + item.storageBonus);
    expectApplied(g.sim.dispatch({ command: produce(1) }));
  });

  // @locked
  it("the QC station makes the standard recipe startable", () => {
    const item = qcStation();
    const g = game({ cash: cents(10_000_000) });
    edit(g, (s) => unlockedFor(item)(freeMaterials(standard(), 5)(s)));
    expectRejected(g.sim, produce(5, standard().id), { code: "RECIPE_NOT_SUPPORTED", facilityId: DISTILLERY_MAIN, recipeId: standard().id });
    expectApplied(g.sim.dispatch({ command: buyEquipment(item.id) }));
    expectApplied(g.sim.dispatch({ command: produce(5, standard().id) }));
    const job = jobAt(g.sim.state);
    expect(job.recipeId).toBe(standard().id);
    advanceTo(g.sim, job.completesAt);
    expect(casesInStock(g.sim.state, "standard")).toBe(5);
  });
});

// ===========================================================================
// Snapshot: the facility section
// ===========================================================================

describe("PROD-001 snapshot facility section", () => {
  // @locked
  it("reports slots, storage, capacity per day, and kind from game-data", () => {
    const g = game();
    edit(g, (s) => runningJob(4)(freeCases(7)(s)));
    const f = facilityIn(g.sim);
    expect(f.kind).toBe("DISTILLERY");
    expect(f.equipmentSlots).toEqual({ used: owned(g.sim.state).length, total: facilitySpec().equipmentSlots });
    expect(f.storage).toEqual({ used: 7, capacity: expectedCapacity(g.sim.state) });
    expect(f.productionCapacityPerDay).toBe(casesPerDay(basic().ticksPerCase, PPM));
  });

  // @locked
  it("productionCapacityPerDay uses the condenser's throughput (full crew) and the fastest supported recipe", () => {
    const g = game({ equipment: [COPPER_STILL, condenser().id], workers: FULL_CREW });
    expect(facilityIn(g.sim).productionCapacityPerDay).toBe(casesPerDay(basic().ticksPerCase, PPM + condenser().throughputBonus));

    const fast = withRecipe(standard().id, { ticksPerCase: Math.max(1, Math.floor(basic().ticksPerCase / 2)) });
    const both = game({ data: fast, equipment: [COPPER_STILL, qcStation().id] });
    const fastest = Math.min(...[basic(), recipeById(standard().id, fast)].map((r) => r.ticksPerCase));
    expect(facilityIn(both.sim).productionCapacityPerDay).toBe(casesPerDay(fastest, PPM));
  });

  // @locked
  it("a facility that can run no recipe reports 0 capacity per day and is a WAREHOUSE", () => {
    const g = game({ equipment: [] });
    const f = facilityIn(g.sim);
    expect(f.productionCapacityPerDay).toBe(0);
    expect(f.kind).toBe("WAREHOUSE");
    expect(f.equipmentSlots).toEqual({ used: 0, total: facilitySpec().equipmentSlots });
  });

  // @locked
  it("lists every unowned equipment item, sorted by ID, with blockedBy from a dry-run PURCHASE_EQUIPMENT", () => {
    const check = (g: Game): FacilitySnapshot => {
      const f = facilityIn(g.sim);
      const unowned = GAME_DATA.equipment.filter((e) => !owned(g.sim.state).includes(e.id));
      expect(f.equipmentOptions.map((o) => o.equipmentId)).toEqual(unowned.map((e) => e.id).sort(compareIds));
      for (const o of f.equipmentOptions) {
        const def = equipmentDef(o.equipmentId);
        expect(o).toMatchObject({ name: def.name, description: def.description, price: def.price });
        const probe = createSimulation(g.sim.state, simulationOptions(g.setup));
        expect(o.blockedBy, o.equipmentId).toEqual(reasonOf(probe, buyEquipment(o.equipmentId)));
      }
      return f;
    };

    const rich = game({ data: roomy(), cash: cents(10_000_000) });
    edit(rich, unlockedFor(...GAME_DATA.equipment));
    for (const o of check(rich).equipmentOptions) expect(o.blockedBy).toBeNull();

    const poor = game({ cash: cents(0) });
    edit(poor, unlockedFor(...GAME_DATA.equipment));
    for (const o of check(poor).equipmentOptions) {
      expect(o.blockedBy).toEqual(o.price > 0 ? { code: "INSUFFICIENT_FUNDS", required: o.price, available: 0 } : null);
    }

    const full = game({ data: withFacilitySpec({ equipmentSlots: 1 }), cash: cents(10_000_000) });
    edit(full, unlockedFor(...GAME_DATA.equipment));
    for (const o of check(full).equipmentOptions) {
      expect(o.blockedBy).toEqual({ code: "NO_EQUIPMENT_SLOT", facilityId: DISTILLERY_MAIN, equipmentId: o.equipmentId });
    }

    const locked = game({ data: withEquipment(condenser().id, { requiredUnlockId: FIXTURE_UNLOCK }) });
    const option = facilityIn(locked.sim).equipmentOptions.find((o) => o.equipmentId === condenser().id);
    expect(option?.blockedBy).toEqual({ code: "LOCKED", unlockId: FIXTURE_UNLOCK });
  });

  // @locked
  it("lists both recipes with base ticksPerCase (unscaled) and standard blocked until the QC station", () => {
    const g = game({ equipment: [COPPER_STILL, condenser().id], workers: FULL_CREW });
    edit(g, freeMaterials(standard(), 5));
    const f = facilityIn(g.sim);
    expect(f.recipes.map((r) => r.recipeId).sort(compareIds)).toEqual(GAME_DATA.recipes.map((r) => r.id).sort(compareIds));
    for (const r of f.recipes) expect(r.ticksPerCase).toBe(recipeById(r.recipeId).ticksPerCase);
    const std = f.recipes.find((r) => r.recipeId === standard().id)!;
    expect(std).toMatchObject({
      blockedBy: { code: "RECIPE_NOT_SUPPORTED", facilityId: DISTILLERY_MAIN, recipeId: standard().id },
      maxStartableQuantity: 0,
    });
  });

  // @locked
  it("maxStartableQuantity is bounded by storage, and is the largest quantity a dispatch accepts", () => {
    const g = game({ cash: cents(10_000_000) });
    const cap = expectedCapacity(g.sim.state);
    edit(g, (s) => freeMaterials(basic(), cap * 4)(freeCases(3)(s)));
    const option = facilityIn(g.sim).recipes.find((r) => r.recipeId === BASIC_MOONSHINE_RECIPE)!;
    expect(option).toMatchObject({ blockedBy: null, maxStartableQuantity: cap - 3 });
    const probe = createSimulation(g.sim.state, simulationOptions(g.setup));
    expect(reasonOf(probe, produce(cap - 2))).toEqual({ code: "STORAGE_CAPACITY_EXCEEDED", facilityId: DISTILLERY_MAIN, requested: cap - 2, available: cap - 3 });
    expectApplied(g.sim.dispatch({ command: produce(cap - 3) }));
  });

  // @locked
  it("maxStartableQuantity for a zero-cost recipe at a tick other than 0 is what a dispatch accepts", () => {
    const data = withFacilitySpec(
      { baseStorage: Math.floor(MAX / 2) },
      withRecipe(BASIC_MOONSHINE_RECIPE, { laborPerCase: cents(0), overheadPerCase: cents(0), inputsPerCase: [] }),
    );
    const g = game({ data });
    advanceTo(g.sim, 250);
    const recipe = recipeById(BASIC_MOONSHINE_RECIPE, data);
    const expected = overflowBound(recipe, g.sim.state.tick + 1);
    const option = facilityIn(g.sim).recipes.find((r) => r.recipeId === BASIC_MOONSHINE_RECIPE)!;
    expect(option).toMatchObject({ blockedBy: null, maxStartableQuantity: expected });
    const probe = createSimulation(g.sim.state, simulationOptions(g.setup));
    expect(reasonOf(probe, produce(expected + 1))).toEqual({ code: "INVALID_QUANTITY", field: "quantity", value: expected + 1 });
    expectApplied(g.sim.dispatch({ command: produce(expected) }));
  });

  // @locked
  it("taking a snapshot changes neither the state hash nor the RNG state", () => {
    const g = game({ data: failing(500_000), cash: cents(10_000_000) });
    edit(g, (s) => unlockedFor(...GAME_DATA.equipment)(freeMaterials(standard(), 10)(freeMaterials(basic(), 10)(s))));
    expectApplied(g.sim.dispatch({ command: produce(2) }));
    const hash = g.sim.stateHash();
    const rng = g.sim.state.rng;
    g.sim.snapshot();
    expect(g.sim.stateHash()).toBe(hash);
    expect(g.sim.state.rng).toEqual(rng);
  });
});
