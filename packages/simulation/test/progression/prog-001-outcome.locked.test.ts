// @locked
// PROG-001 acceptance tests for T05f (issue #105): victory, insolvency, the
// recovery policy, and the no-soft-lock and no-false-loss properties. Rules come
// from ADR 0020 decisions 7, 8, and 10, GDD §9 (Recovery), and GDD §14.9.
//
// Covers:
// - Victory (decision 7): all three conditions on one tick; each condition one
//   short (net worth one cent, reputation one point, one completed contract
//   fewer); detection on the tick the last condition becomes true (reputation
//   through an installment, completion through a final MISSED installment, net
//   worth through a sale's arrival); PROGRESSION:VICTORY with no entries, after
//   tier promotion; the VICTORY_ACHIEVED payload; completedContractId is the
//   first COMPLETED contract in state order, whatever its installment outcomes.
// - Insolvency (decision 10): checked at midnight, last, after payroll; goods,
//   a running job, an outbound truck, and a truck carrying fallen-through
//   (FAILED) cargo home each block it; resale of equipment the restart doesn't
//   need rescues the game (at the boundary); a sold still the funds can't rebuy
//   and conversion cost alone exceeding cash both lose (with positive cash); a
//   shortage can't cause a loss (base prices); an earlier DELIVERED sale keeps
//   its cargo and doesn't block a loss. PROGRESSION:LOST with no entries,
//   GAME_LOST { INSOLVENT }, outcome { LOST, tick, INSOLVENT }.
// - The outcome is terminal and sticky (decision 8): after WON or LOST neither
//   is evaluated again; commands and ticks still work; reputation and tiers keep
//   updating.
// - The recovery policy (decision 10 steps 1–3) as a helper in this file, with
//   the horizon H computed from game-data and state as decision 10 defines it.
// - Two fast-check properties over random command sequences from the First
//   Shipment (with low-cash fixtures, reaching the rival closure and the corn
//   shortage): no soft-lock (the policy on a copy of every midnight state that
//   isn't LOST reaches SALE_COMPLETED or GAME_LOST by H) and no false loss
//   (whenever GAME_LOST fires, funds(R) < cost(R) for every feasible recipe,
//   recomputed here, and with no shortage active the policy is rejected with
//   INSUFFICIENT_FUNDS at a paid step before production starts).
//
// Written ahead of the implementation by a separate test-writer agent
// (factory.md §2, §7.3). Do not edit (CLAUDE.md rule 9).
//
// Imports are limited to the public package entry `src/index.ts`, the inventory
// module `src/inventory/index.ts` (`addProduct`, for fixtures), and
// `@eov/contracts` and `@eov/game-data`. Everything is driven through the
// Simulation (commands, ticks, snapshots). No new simulation export is assumed.
//
// Numbers. Victory thresholds, reputation amounts, prices, wages, and resale are
// read from GAME_DATA, so T05g's tuning doesn't break these tests.
//
// Fixtures. Stock, cash, and injected equipment are booked through a coordinator
// transaction (kind OPENING_BALANCE, keys `OPENING_BALANCE:fixture:<n>`) so the
// ledger matches state. Contracts are injected as `ContractState`s (IDs from the
// counters) with preset installments. Reputation is preset by editing
// `state.family`. A fall-through is produced by moving a dispatched sale's
// `dealDeadline` before its arrival.
//
// Interpretation pinned here (decision 10 step 3, "short of funds only because a
// shortage raises today's price"): before its first paid step, the policy
// compares cash with the rest of the restart (missing equipment, one case's
// missing inputs, conversion) at today's supplier prices and at base prices. If
// cash covers it at base prices but not at today's, it waits for the shortage to
// end instead of buying at the raised price. Otherwise it goes ahead, and a paid
// step rejected with INSUFFICIENT_FUNDS leaves it waiting (for GAME_LOST).
//
// Not pinned: `causedBy` on outcome events; the snapshot's victory section;
// the hashes (Sprint Zero and kernel reference are pinned by their own tests).
//
// Expected to fail on main until T05f lands: nothing sets `outcome`, so no
// victory or loss is ever recorded. On main these pass: the threshold pin, the
// three near-misses, the four cases where insolvency is blocked, and the two
// policy/H checks. The no-soft-lock property fails (a broke game never reaches
// GAME_LOST), and the no-false-loss property fails only on its coverage guard
// (some GAME_LOST must fire, so it can't pass vacuously).

import {
  applyRatios,
  cents,
  compareById,
  compareIds,
  idempotencyKey,
  qualityRank,
  RATIO_SCALE,
  tick,
  TICKS_PER_DAY,
  type BuyerId,
  type BuyerState,
  type CommandResult,
  type ContractId,
  type ContractState,
  type DeliveryState,
  type EquipmentId,
  type FacilityId,
  type GameCommand,
  type GameEvent,
  type GameState,
  type InstallmentOutcome,
  type LedgerEntry,
  type LedgerTransaction,
  type MaterialId,
  type Money,
  type ProductId,
  type QualityTier,
  type RejectionReason,
  type RouteId,
  type SupplierId,
} from "@eov/contracts";
import {
  BASIC_MOONSHINE_RECIPE,
  COPPER_STILL,
  COUNTY_ROAD,
  DISTILLERY_MAIN,
  GAME_DATA,
  KESSLERS_BACK_ROOM,
  MODEL_TT_TRUCK,
  MOONSHINE,
  STORAGE_EXPANSION,
  type EquipmentDefinition,
  type GameData,
  type RecipeDefinition,
  type RouteDefinition,
} from "@eov/game-data";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addProduct } from "../../src/inventory/index.ts";
import {
  accountBalances,
  allocateId,
  availableMaterial,
  availableProduct,
  balanceSheet,
  createCoordinator,
  createSimulation,
  newGame,
  simulationOptions,
  type GameSetup,
  type KernelSimulation,
} from "../../src/index.ts";

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const DAY = TICKS_PER_DAY;
const DATA = GAME_DATA;
const VICTORY = DATA.progression.victory;
const RULES = DATA.progression.reputation;
const TERMS = DATA.contracts.terms;
const RESALE_RATIO = DATA.progression.recovery.equipmentResaleRatio;

const VICTORY_KEY = idempotencyKey("PROGRESSION", "VICTORY");
const LOST_KEY = idempotencyKey("PROGRESSION", "LOST");
const payrollKey = (day: number) => idempotencyKey("DAILY_SETTLEMENT", "PAYROLL", day);
const installmentKey = (contractId: ContractId, index: number) => idempotencyKey("PROGRESSION", "INSTALLMENT", contractId, index);

const byId = <T extends { readonly id: string }>(list: readonly T[]): T[] => [...list].sort((a, b) => compareIds(a.id, b.id));

function equipmentDef(id: EquipmentId, data: GameData = DATA): EquipmentDefinition {
  const def = data.equipment.find((e) => e.id === id);
  if (!def) throw new Error(`No equipment ${id}`);
  return def;
}

function routeDef(id: RouteId, data: GameData = DATA): RouteDefinition {
  const def = data.routes.find((r) => r.id === id);
  if (!def) throw new Error(`No route ${id}`);
  return def;
}

function recipeDef(id: string, data: GameData = DATA): RecipeDefinition {
  const def = data.recipes.find((r) => r.id === id);
  if (!def) throw new Error(`No recipe ${id}`);
  return def;
}

const resaleOf = (bookValue: Money): Money => applyRatios(bookValue, [RESALE_RATIO]);
const conversionOf = (recipe: RecipeDefinition): number => recipe.laborPerCase + recipe.overheadPerCase;

// ---------------------------------------------------------------------------
// A game with an event log
// ---------------------------------------------------------------------------

interface Game {
  sim: KernelSimulation;
  readonly setup: GameSetup;
  readonly events: GameEvent[];
}

function start(setup: GameSetup = {}): Game {
  return { sim: newGame(setup), setup, events: [] };
}

/** A game continuing from a copy of `state` (states are immutable), with its own event log. */
function copyOf(state: GameState, setup: GameSetup = {}): Game {
  return { sim: createSimulation(state, simulationOptions(setup)), setup, events: [] };
}

function flush(g: Game): void {
  g.events.push(...g.sim.takeEvents());
}

/** Continues from an edited copy of the state, with the same systems and data. */
function edit(g: Game, change: (s: GameState) => GameState): void {
  flush(g);
  g.sim = createSimulation(change(g.sim.state), simulationOptions(g.setup));
}

function to(g: Game, target: number): void {
  if (target < g.sim.state.tick) throw new Error(`Can't go back from ${g.sim.state.tick} to ${target}`);
  g.sim.advance(target - g.sim.state.tick);
  flush(g);
}

function run(g: Game, command: GameCommand): CommandResult {
  const result = g.sim.dispatch({ command });
  flush(g);
  return result;
}

function expectApplied(result: CommandResult, what = "command"): void {
  if (result.status !== "applied") throw new Error(`Expected ${what} to apply, got ${JSON.stringify(result)}`);
}

function eventsOfType<T extends GameEvent["type"]>(events: readonly GameEvent[], type: T): Extract<GameEvent, { type: T }>[] {
  return events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === type);
}

function eventsOf(g: Game, tx: LedgerTransaction): GameEvent[] {
  flush(g);
  return tx.eventIds.map((id) => {
    const e = g.events.find((x) => x.id === id);
    if (!e) throw new Error(`Event ${id} of ${tx.idempotencyKey} wasn't seen`);
    return e;
  });
}

// ---------------------------------------------------------------------------
// Ledger helpers
// ---------------------------------------------------------------------------

function keyed(state: GameState, key: string): readonly LedgerTransaction[] {
  return state.ledger.transactions.filter((t) => t.idempotencyKey === key);
}

function oneTx(state: GameState, key: string): LedgerTransaction {
  const found = keyed(state, key);
  if (found.length !== 1) throw new Error(`Expected one transaction keyed ${key}, found ${found.length}`);
  return found[0]!;
}

function indexOfKey(state: GameState, key: string): number {
  const i = state.ledger.transactions.findIndex((t) => t.idempotencyKey === key);
  if (i < 0) throw new Error(`No transaction keyed ${key}`);
  return i;
}

/** A PROGRESSION transaction: no entries (ADR 0020 decision 14), at `at`. */
function expectProgressionTx(tx: LedgerTransaction, at: number): void {
  expect(tx.kind).toBe("PROGRESSION");
  expect(tx.entries).toEqual([]);
  expect(tx.tick).toBe(at);
}

const cashOf = (state: GameState): number => accountBalances(state.ledger.transactions).CASH;
const netWorthOf = (state: GameState): number => balanceSheet(state).netWorth;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Books `entries` (and an optional state change) as a fixture coordinator transaction. */
function fixtureTx(state: GameState, entries: readonly LedgerEntry[], change?: (s: GameState) => GameState): GameState {
  const tx = createCoordinator().begin(state, {
    kind: "OPENING_BALANCE",
    idempotencyKey: idempotencyKey("OPENING_BALANCE", "fixture", state.ledger.transactions.length),
    tick: state.tick,
    causedBy: null,
  });
  if (tx.status === "duplicate") throw new Error("Fixture key collision");
  if (change) tx.update(change);
  if (entries.length > 0) tx.post(entries);
  const result = tx.commit();
  if (result.status !== "committed") throw new Error(`Fixture rejected: ${JSON.stringify(result.reason)}`);
  return result.state;
}

/** Finished goods at the distillery, booked against owner equity. */
function withStock(state: GameState, quantity: number, unitCost = 700, quality: QualityTier = "basic", productId: ProductId = MOONSHINE): GameState {
  const cost = cents(unitCost * quantity);
  return fixtureTx(
    state,
    [
      { account: "FINISHED_GOODS", side: "DEBIT", amount: cost },
      { account: "OWNER_EQUITY", side: "CREDIT", amount: cost },
    ],
    (s) => addProduct(s, DISTILLERY_MAIN, productId, quality, quantity, cost),
  );
}

/** Sets the cash balance to exactly `target` cents, against owner equity. */
function withCash(state: GameState, target: number): GameState {
  const diff = target - cashOf(state);
  if (diff === 0) return state;
  const amount = cents(diff > 0 ? diff : -diff);
  return fixtureTx(
    state,
    diff > 0
      ? [
          { account: "CASH", side: "DEBIT", amount },
          { account: "OWNER_EQUITY", side: "CREDIT", amount },
        ]
      : [
          { account: "OWNER_EQUITY", side: "DEBIT", amount },
          { account: "CASH", side: "CREDIT", amount },
        ],
  );
}

const withoutCash = (state: GameState): GameState => withCash(state, 0);

/** Moves cash so net worth is exactly `target` (needs enough cash when lowering it). */
function withNetWorth(state: GameState, target: number): GameState {
  return withCash(state, cashOf(state) + (target - netWorthOf(state)));
}

function withFamily(state: GameState, patch: Partial<GameState["family"]>): GameState {
  return { ...state, family: { ...state.family, ...patch } };
}

/** Adds an equipment item to the distillery at `bookValue`, booked against owner equity. */
function withEquipment(state: GameState, equipmentId: EquipmentId, bookValue: number): GameState {
  const amount = cents(bookValue);
  return fixtureTx(
    state,
    [
      { account: "EQUIPMENT", side: "DEBIT", amount },
      { account: "OWNER_EQUITY", side: "CREDIT", amount },
    ],
    (s) => ({
      ...s,
      facilities: s.facilities.map((f) =>
        f.id === DISTILLERY_MAIN
          ? { ...f, equipment: [...f.equipment, { equipmentId, bookValue: amount }].sort((a, b) => compareIds(a.equipmentId, b.equipmentId)) }
          : f,
      ),
    }),
  );
}

function contractBuyer(buyerId: BuyerId) {
  const found = DATA.contracts.buyers.find((b) => b.buyerId === buyerId);
  if (!found) throw new Error(`No contract definition for ${buyerId}`);
  return found;
}

function deliveredFor(buyerId: BuyerId, outcome: InstallmentOutcome): number {
  const required = contractBuyer(buyerId).quantityPerInstallment;
  return outcome === "FULFILLED" ? required : outcome === "PARTIAL" ? required - 1 : 0;
}

interface ContractSpec {
  readonly buyerId?: BuyerId;
  readonly status: "ACTIVE" | "COMPLETED";
  /** Per installment: a settled outcome, or `{ pending }` with the deadline and the outcome it will settle with. */
  readonly installments: readonly (InstallmentOutcome | { readonly deadline: number; readonly settlesAs: InstallmentOutcome })[];
}

/** Injects a ContractState (a contract as a loaded save would hold it). Settled installments have deadline 0. */
function withContract(state: GameState, spec: ContractSpec): { readonly state: GameState; readonly contractId: ContractId } {
  const buyerId = spec.buyerId ?? KESSLERS_BACK_ROOM;
  const def = contractBuyer(buyerId);
  const offer = allocateId(state, "ContractOffer");
  const contract = allocateId(offer.state, "Contract");
  const value: ContractState = {
    id: contract.id,
    offerId: offer.id,
    buyerId,
    productId: def.productId,
    minimumQuality: def.minimumQuality,
    quantityPerInstallment: def.quantityPerInstallment,
    unitPrice: cents(1_000),
    installmentCount: spec.installments.length,
    intervalTicks: TERMS.intervalTicks,
    penaltyRatePpm: TERMS.penaltyRatePpm,
    status: spec.status,
    installments: spec.installments.map((i) =>
      typeof i === "string"
        ? { deadline: tick(0), required: def.quantityPerInstallment, delivered: deliveredFor(buyerId, i), outcome: i, penalty: cents(0) }
        : { deadline: tick(i.deadline), required: def.quantityPerInstallment, delivered: deliveredFor(buyerId, i.settlesAs), outcome: null, penalty: null },
    ),
    reservationIds: [],
  };
  const s = contract.state;
  return { state: { ...s, contracts: [...s.contracts, value].sort(compareById) }, contractId: contract.id };
}

/** Injects `count` COMPLETED contracts with the given outcomes; returns their IDs in order. */
function withCompleted(state: GameState, count: number, outcomes: readonly InstallmentOutcome[] = ["FULFILLED", "FULFILLED", "FULFILLED"]) {
  let s = state;
  const ids: ContractId[] = [];
  for (let i = 0; i < count; i++) {
    const made = withContract(s, { status: "COMPLETED", installments: outcomes });
    s = made.state;
    ids.push(made.contractId);
  }
  return { state: s, ids };
}

/** Tonight's payroll and overhead (production's midnight settlement), from game-data and state. */
function dailyCost(state: GameState, data: GameData = DATA): number {
  let total = 0;
  for (const c of data.characters) total += c.dailyWage;
  for (const f of state.facilities) {
    total += f.workerCount * data.workforce.workerDailyWage;
    const spec = data.facilityProduction.find((p) => p.facilityId === f.id);
    if (!spec) throw new Error(`No production spec for ${f.id}`);
    total += spec.dailyOverhead;
  }
  return total;
}

/** Sets cash so that, after tonight's payroll and overhead (and with nothing owed), `target` is left. */
const withCashAfterMidnight = (state: GameState, target: number): GameState => withCash(state, target + dailyCost(state));

// ---------------------------------------------------------------------------
// Markets and logistics
// ---------------------------------------------------------------------------

const truck = (state: GameState) => state.vehicles.find((v) => v.id === MODEL_TT_TRUCK)!;

function untilTruckHome(g: Game): void {
  for (let guard = 0; truck(g.sim.state).trip !== null; guard++) {
    if (guard > 4) throw new Error("The truck never came home");
    to(g, Math.max(g.sim.state.tick + 1, truck(g.sim.state).trip!.arrivesAt));
  }
}

/** The buyer's most specific want for (product, quality): the highest minimum quality at or below it (ADR 0016). */
function matchWant(buyer: BuyerState, productId: ProductId, quality: QualityTier): BuyerState["wants"][number] | undefined {
  let best: BuyerState["wants"][number] | undefined;
  for (const w of buyer.wants) {
    if (w.productId !== productId || qualityRank(w.minimumQuality) > qualityRank(quality)) continue;
    if (!best || qualityRank(w.minimumQuality) > qualityRank(best.minimumQuality)) best = w;
  }
  return best;
}

/** quoteDeal's liquidity: min(demand remaining, floor(budget remaining / quote)). */
function acceptableFor(buyer: BuyerState, want: BuyerState["wants"][number]): number {
  const affordable = want.unitPrice > 0 ? Math.floor(buyer.budgetRemaining / want.unitPrice) : want.demandRemaining;
  return Math.max(0, Math.min(want.demandRemaining, affordable));
}

/** The first buyer (ID order) able to take `quantity` basic cases now. */
function spotBuyerFor(state: GameState, quantity: number): { readonly buyerId: BuyerId; readonly unitPrice: Money } {
  for (const b of [...state.buyers].sort(compareById)) {
    const def = DATA.buyers.find((d) => d.id === b.id);
    if (!def || def.minimumReputation > state.family.reputation) continue;
    const want = matchWant(b, MOONSHINE, "basic");
    if (!want || acceptableFor(b, want) < quantity) continue;
    return { buyerId: b.id, unitPrice: want.unitPrice };
  }
  throw new Error(`No buyer can take ${quantity} basic cases at tick ${state.tick}`);
}

/** Dispatches a spot sale of basic cases on the default (safe) route once the truck is home. */
function dispatchSpot(g: Game, quantity: number): { readonly deliveryId: DeliveryState["id"]; readonly arrival: number; readonly unitPrice: Money } {
  untilTruckHome(g);
  const { buyerId, unitPrice } = spotBuyerFor(g.sim.state, quantity);
  expectApplied(
    run(g, {
      type: "DISPATCH_DELIVERY",
      vehicleId: MODEL_TT_TRUCK,
      cargo: [{ productId: MOONSHINE, quality: "basic", quantity }],
      purpose: { kind: "SALE", buyerId, agreedUnitPrice: unitPrice },
      routeId: null,
    }),
    "the spot dispatch",
  );
  const delivery = g.sim.state.deliveries.at(-1)!;
  const trip = truck(g.sim.state).trip;
  if (!trip || trip.deliveryId !== delivery.id) throw new Error("The dispatch didn't start a trip");
  return { deliveryId: delivery.id, arrival: trip.arrivesAt, unitPrice };
}

const deliveryOf = (state: GameState, id: DeliveryState["id"]) => state.deliveries.find((d) => d.id === id)!;
const cargoCases = (d: DeliveryState): number => d.cargo.reduce((n, line) => n + line.quantity, 0);

// ---------------------------------------------------------------------------
// Decision 10: goods, restart routes, funds(R) and cost(R)
// ---------------------------------------------------------------------------

/** Decision 10's "no goods": empty pools, no OUTBOUND delivery or FAILED one holding cargo, no running job. */
function hasNoGoods(state: GameState): boolean {
  return (
    state.productPools.every((p) => p.quantity === 0) &&
    state.deliveries.every((d) => d.status === "DELIVERED" || cargoCases(d) === 0) &&
    state.productionJobs.length === 0
  );
}

/** The lowest base `unitPrice` of a material among the suppliers in play (game-data, ignoring shortages), or null. */
function basePrice(state: GameState, materialId: MaterialId, data: GameData = DATA): number | null {
  let best: number | null = null;
  for (const s of state.suppliers) {
    const line = data.suppliers.find((d) => d.id === s.id)?.stock.find((st) => st.materialId === materialId);
    if (line && (best === null || line.unitPrice < best)) best = line.unitPrice;
  }
  return best;
}

/** Today's cheapest supplier in play for a material (ties in supplier-ID order), or null. */
function currentOffer(state: GameState, materialId: MaterialId): { readonly supplierId: SupplierId; readonly unitPrice: number; readonly available: number } | null {
  let best: { supplierId: SupplierId; unitPrice: number; available: number } | null = null;
  for (const s of byId(state.suppliers)) {
    const line = s.stock.find((st) => st.materialId === materialId);
    if (line && (best === null || line.unitPrice < best.unitPrice)) best = { supplierId: s.id, unitPrice: line.unitPrice, available: line.available };
  }
  return best;
}

const anyShortage = (state: GameState): boolean => state.suppliers.some((s) => s.stock.some((st) => st.shortage !== null));

/** A feasible restart route (decision 10): a recipe at an owned facility, with its cost(R) and funds(R) at base prices. */
interface Restart {
  readonly facilityId: FacilityId;
  readonly recipe: RecipeDefinition;
  readonly missing: readonly EquipmentDefinition[];
  readonly unneeded: readonly { readonly equipmentId: EquipmentId; readonly bookValue: Money }[];
  readonly shortfalls: readonly { readonly materialId: MaterialId; readonly quantity: number }[];
  readonly cost: number;
  readonly funds: number;
}

/** Every feasible restart route, recipes in ID order (then facilities in ID order). */
function feasibleRestarts(state: GameState, data: GameData = DATA): Restart[] {
  const routes: Restart[] = [];
  const cash = cashOf(state);
  for (const recipe of byId(data.recipes)) {
    for (const facility of byId(state.facilities)) {
      const owned = new Set(facility.equipment.map((e) => e.equipmentId));
      const missing = recipe.requiredEquipmentIds.filter((id) => !owned.has(id)).map((id) => equipmentDef(id, data));
      if (missing.some((e) => e.requiredUnlockId !== null && !state.family.unlocked.includes(e.requiredUnlockId))) continue;
      const shortfalls: { materialId: MaterialId; quantity: number }[] = [];
      let materials = 0;
      let sellable = true;
      for (const input of recipe.inputsPerCase) {
        const price = basePrice(state, input.materialId, data);
        if (price === null) {
          sellable = false;
          break;
        }
        const quantity = Math.max(0, input.quantity - availableMaterial(state, facility.id, input.materialId));
        if (quantity > 0) shortfalls.push({ materialId: input.materialId, quantity });
        materials += quantity * price;
      }
      if (!sellable) continue;
      const wanted = state.buyers.some((b) => {
        const def = data.buyers.find((d) => d.id === b.id);
        return (
          def !== undefined &&
          def.minimumReputation <= state.family.reputation &&
          b.wants.some((w) => w.productId === recipe.productId && qualityRank(w.minimumQuality) <= qualityRank(recipe.quality))
        );
      });
      if (!wanted) continue;
      const unneeded = facility.equipment.filter((e) => !recipe.requiredEquipmentIds.includes(e.equipmentId));
      const cost = missing.reduce((n, e) => n + e.price, 0) + materials + conversionOf(recipe);
      const funds = cash + unneeded.reduce((n, e) => n + resaleOf(e.bookValue), 0);
      routes.push({ facilityId: facility.id, recipe, missing, unneeded, shortfalls, cost, funds });
    }
  }
  return routes;
}

/** The cheapest feasible restart route (ties: recipe-ID order, then facility-ID order), or null. */
function cheapestRestart(state: GameState, data: GameData = DATA): Restart | null {
  let best: Restart | null = null;
  for (const r of feasibleRestarts(state, data)) if (best === null || r.cost < best.cost) best = r;
  return best;
}

// ---------------------------------------------------------------------------
// The horizon H (decision 10)
// ---------------------------------------------------------------------------

/** One case of `recipe` at a workforce of 1 with exactly its required equipment (ADR 0017's crew formula). */
function oneCaseTicksAtOneWorker(recipe: RecipeDefinition, data: GameData = DATA): number {
  let base = RATIO_SCALE;
  let crew = 0;
  for (const id of recipe.requiredEquipmentIds) {
    const def = equipmentDef(id, data);
    base += def.throughputBonus;
    crew += def.crew;
  }
  const [c, staffed] = crew === 0 ? [1, 1] : [crew, Math.min(1, crew)];
  const numerator = recipe.ticksPerCase * RATIO_SCALE * c;
  const denominator = base * staffed;
  return Math.floor((numerator + denominator - 1) / denominator);
}

/** Decision 10's slack: two days, a one-case job at workforce 1 (slowest recipe), a round trip on the longest safe route. */
function horizonSlack(data: GameData = DATA): number {
  const slowestJob = Math.max(...data.recipes.map((r) => oneCaseTicksAtOneWorker(r, data)));
  const longestSafe = Math.max(...data.routes.filter((r) => r.riskPpm === 0).map((r) => r.durationTicks));
  return 2 * TICKS_PER_DAY + slowestJob + 2 * longestSafe;
}

/** The latest of decision 10's terms for `state`, plus the slack. */
function horizon(state: GameState, data: GameData = DATA): number {
  let latest: number = state.tick;
  const bump = (t: number) => {
    latest = Math.max(latest, t);
  };
  for (const job of state.productionJobs) bump(job.completesAt);
  for (const d of state.deliveries) {
    const trip = state.vehicles.find((v) => v.trip?.deliveryId === d.id)?.trip ?? null;
    if (d.status === "OUTBOUND") {
      if (!trip) throw new Error(`OUTBOUND delivery ${d.id} has no trip`);
      const route = routeDef(trip.routeId, data);
      bump(trip.arrivesAt + route.durationTicks + (route.riskPpm > 0 && !trip.delayed ? route.delayTicks : 0));
    } else if (d.status === "FAILED" && cargoCases(d) > 0) {
      if (!trip) throw new Error(`FAILED delivery ${d.id} holds cargo with no trip home`);
      bump(trip.arrivesAt);
    }
  }
  for (const s of state.suppliers) for (const st of s.stock) if (st.shortage) bump(st.shortage.endsAt);
  for (const e of state.scheduledEvents) {
    if (e.kind === "SHORTAGE_START") bump(e.tick + e.durationTicks);
    if (e.kind === "ROUTE_CLOSURE") {
      if (e.durationTicks === null) throw new Error("An open-ended scheduled closure has no horizon term");
      bump(e.tick + e.durationTicks);
    }
  }
  for (const r of state.routes) {
    if (!r.closure) continue;
    if (r.closure.reopensAt === null) throw new Error(`Route ${r.id} is closed with no reopening`);
    bump(r.closure.reopensAt);
  }
  return latest + horizonSlack(data);
}

// ---------------------------------------------------------------------------
// The recovery policy (decision 10, steps 1–3)
// ---------------------------------------------------------------------------

const PAID_STEPS = ["PURCHASE_EQUIPMENT", "PURCHASE_MATERIALS", "START_PRODUCTION"] as const;
type PaidStep = (typeof PAID_STEPS)[number];

type RestartAttempt =
  | { readonly status: "STARTED" }
  | { readonly status: "NO_RECIPE" }
  | { readonly status: "WAIT" }
  | { readonly status: "INSUFFICIENT_FUNDS"; readonly step: PaidStep; readonly reason: RejectionReason };

/** Runs a paid step: applied, rejected for funds (returned), or any other rejection (a test failure). */
function paidStep(g: Game, step: PaidStep, command: GameCommand): RestartAttempt | null {
  const result = run(g, command);
  if (result.status === "applied") return null;
  if (result.status === "rejected" && result.reason.code === "INSUFFICIENT_FUNDS") return { status: "INSUFFICIENT_FUNDS", step, reason: result.reason };
  throw new Error(`Recovery policy: ${step} unexpectedly ${JSON.stringify(result)} at tick ${g.sim.state.tick}`);
}

/**
 * Step 3: restart with the cheapest feasible recipe R. Sells what R doesn't need,
 * buys what it lacks, staffs one worker if there are none, buys one case's
 * missing inputs at today's price, and starts a one-case job. Waits (without
 * paying) when only a shortage's price stands in the way (see the header).
 */
function attemptRestart(g: Game): RestartAttempt {
  const r = cheapestRestart(g.sim.state);
  if (!r) return { status: "NO_RECIPE" };
  for (const item of r.unneeded) {
    expectApplied(run(g, { type: "SELL_EQUIPMENT", facilityId: r.facilityId, equipmentId: item.equipmentId }), `selling ${item.equipmentId}`);
  }

  const s = g.sim.state;
  const fixed = r.missing.reduce((n, e) => n + e.price, 0) + conversionOf(r.recipe);
  let atBase = fixed;
  let atToday = fixed;
  for (const { materialId, quantity } of r.shortfalls) {
    const offer = currentOffer(s, materialId);
    const base = basePrice(s, materialId);
    if (!offer || base === null) throw new Error(`Recovery policy: nobody in play sells ${materialId}`);
    atBase += quantity * base;
    atToday += quantity * offer.unitPrice;
  }
  const cash = cashOf(s);
  if (cash < atToday && cash >= atBase) return { status: "WAIT" };

  for (const item of r.missing) {
    const stop = paidStep(g, "PURCHASE_EQUIPMENT", { type: "PURCHASE_EQUIPMENT", facilityId: r.facilityId, equipmentId: item.id });
    if (stop) return stop;
  }
  if (g.sim.state.facilities.find((f) => f.id === r.facilityId)!.workerCount === 0) {
    expectApplied(run(g, { type: "SET_WORKFORCE", facilityId: r.facilityId, workerCount: 1 }), "staffing one worker");
  }
  for (const { materialId, quantity } of r.shortfalls) {
    const offer = currentOffer(g.sim.state, materialId)!;
    if (offer.available < quantity) return { status: "WAIT" }; // today's stock is gone: wait for the next midnight
    const stop = paidStep(g, "PURCHASE_MATERIALS", { type: "PURCHASE_MATERIALS", supplierId: offer.supplierId, materialId, quantity, facilityId: r.facilityId });
    if (stop) return stop;
  }
  const stop = paidStep(g, "START_PRODUCTION", { type: "START_PRODUCTION", facilityId: r.facilityId, recipeId: r.recipe.id, quantity: 1 });
  return stop ?? { status: "STARTED" };
}

/** The first eligible buyer (ID order) for goods, with the first safe, open route listed for it, or null. */
function firstEligibleBuyer(
  state: GameState,
  facilityId: FacilityId,
  productId: ProductId,
  quality: QualityTier,
): { readonly buyer: BuyerState; readonly want: BuyerState["wants"][number]; readonly routeId: RouteId } | null {
  const from = DATA.facilities.find((f) => f.id === facilityId);
  if (!from) throw new Error(`No facility ${facilityId}`);
  for (const buyer of byId(state.buyers)) {
    const def = DATA.buyers.find((d) => d.id === buyer.id);
    if (!def || def.minimumReputation > state.family.reputation) continue;
    const want = matchWant(buyer, productId, quality);
    if (!want) continue;
    const route = DATA.routes.find(
      (r) =>
        r.fromLocationId === from.locationId &&
        r.toLocationId === def.locationId &&
        r.riskPpm === 0 &&
        (state.routes.find((x) => x.id === r.id)?.closure ?? null) === null,
    );
    if (!route) continue;
    return { buyer, want, routeId: route.id };
  }
  return null;
}

/** One policy step: "ACTED" when it changed something (look again), "WAIT" when it must let time pass. */
function policyStep(g: Game): "ACTED" | "WAIT" {
  const s = g.sim.state;
  // 1. Wait for running jobs, outbound deliveries, and fallen-through cargo riding home.
  if (s.productionJobs.length > 0) return "WAIT";
  if (s.deliveries.some((d) => d.status === "OUTBOUND" || (d.status === "FAILED" && cargoCases(d) > 0))) return "WAIT";

  // 2. Sell goods.
  const pool = s.productPools.find((p) => p.quantity > 0);
  if (pool) {
    for (const r of s.reservations) {
      if (r.holder.kind !== "CONTRACT" || r.facilityId !== pool.facilityId || r.goods.kind !== "PRODUCT") continue;
      if (r.goods.productId !== pool.productId || r.goods.quality !== pool.quality) continue;
      expectApplied(run(g, { type: "RELEASE_RESERVATION", reservationId: r.id }), `releasing ${r.id}`);
    }
    const now = g.sim.state;
    const vehicle = byId(now.vehicles).find((v) => DATA.vehicles.find((d) => d.id === v.id)?.homeFacilityId === pool.facilityId && v.trip === null);
    if (!vehicle) return "WAIT";
    const capacity = DATA.vehicles.find((d) => d.id === vehicle.id)!.capacityCases;
    const target = firstEligibleBuyer(now, pool.facilityId, pool.productId, pool.quality);
    if (!target) return "WAIT";
    const acceptable = acceptableFor(target.buyer, target.want);
    if (acceptable === 0) return "WAIT";
    const quantity = Math.min(availableProduct(now, pool.facilityId, pool.productId, pool.quality), capacity, acceptable);
    expectApplied(
      run(g, {
        type: "DISPATCH_DELIVERY",
        vehicleId: vehicle.id,
        cargo: [{ productId: pool.productId, quality: pool.quality, quantity }],
        purpose: { kind: "SALE", buyerId: target.buyer.id, agreedUnitPrice: target.want.unitPrice },
        routeId: target.routeId,
      }),
      "the policy's dispatch",
    );
    return "ACTED";
  }

  // 3. Restart.
  return attemptRestart(g).status === "STARTED" ? "ACTED" : "WAIT";
}

/** The next tick anything the policy waits on can change: a midnight, a job, a trip, a closure, a shortage, a world event. */
function nextWake(state: GameState): number {
  const t = state.tick;
  const candidates: number[] = [(Math.floor(t / DAY) + 1) * DAY];
  for (const job of state.productionJobs) candidates.push(job.completesAt);
  for (const v of state.vehicles) if (v.trip) candidates.push(v.trip.arrivesAt);
  for (const r of state.routes) if (r.closure && r.closure.reopensAt !== null) candidates.push(r.closure.reopensAt);
  for (const s of state.suppliers) for (const st of s.stock) if (st.shortage) candidates.push(st.shortage.endsAt);
  for (const e of state.scheduledEvents) candidates.push(e.tick);
  return Math.min(...candidates.filter((c) => c > t));
}

interface PolicyResult {
  readonly reached: "SALE_COMPLETED" | "GAME_LOST" | null;
  readonly horizon: number;
  /** The copy the policy ran on. When GAME_LOST was reached, its state is the state of the losing tick. */
  readonly game: Game;
}

/** Runs the recovery policy on a copy of `state` until SALE_COMPLETED or GAME_LOST, or until tick H. */
function runPolicy(state: GameState, setup: GameSetup = {}): PolicyResult {
  const H = horizon(state);
  const g = copyOf(state, setup);
  for (let guard = 0; ; guard++) {
    if (guard > 20_000) throw new Error(`Recovery policy didn't settle from tick ${state.tick}`);
    const hit = g.events.find((e) => e.type === "SALE_COMPLETED" || e.type === "GAME_LOST");
    if (hit) return { reached: hit.type === "SALE_COMPLETED" ? "SALE_COMPLETED" : "GAME_LOST", horizon: H, game: g };
    if (g.sim.state.tick >= H) return { reached: null, horizon: H, game: g };
    if (policyStep(g) === "WAIT") to(g, Math.min(nextWake(g.sim.state), H));
  }
}

/** Decision 10's no-false-loss checks on the state of the tick GAME_LOST fired. */
function expectNoFalseLoss(state: GameState, setup: GameSetup = {}): void {
  expect(state.tick % DAY).toBe(0);
  expect(state.outcome).toEqual({ status: "LOST", tick: state.tick, reason: "INSOLVENT" });
  expect(hasNoGoods(state)).toBe(true);
  const routes = feasibleRestarts(state);
  for (const r of routes) {
    if (r.funds >= r.cost) throw new Error(`False loss at ${state.tick}: ${r.recipe.id} at ${r.facilityId} has funds ${r.funds} ≥ cost ${r.cost}`);
  }
  if (!anyShortage(state) && routes.length > 0) {
    const attempt = attemptRestart(copyOf(state, setup));
    expect(attempt.status).toBe("INSUFFICIENT_FUNDS");
    if (attempt.status === "INSUFFICIENT_FUNDS") expect(PAID_STEPS).toContain(attempt.step);
  }
}

// ===========================================================================
// Victory (decision 7)
// ===========================================================================

/** A game at tick 0 meeting every victory condition: net worth exactly the threshold, reputation exactly the threshold. */
function winningGame(outcomes?: readonly InstallmentOutcome[]): { g: Game; completed: ContractId[] } {
  const g = start();
  let completed: ContractId[] = [];
  edit(g, (s) => {
    const made = withCompleted(withFamily(s, { reputation: VICTORY.reputation }), VICTORY.completedContracts, outcomes);
    completed = made.ids;
    return withNetWorth(made.state, VICTORY.netWorth);
  });
  return { g, completed };
}

function expectNoVictory(g: Game): void {
  expect(g.sim.state.outcome).toEqual({ status: "PLAYING" });
  expect(eventsOfType(g.events, "VICTORY_ACHIEVED")).toEqual([]);
  expect(keyed(g.sim.state, VICTORY_KEY)).toEqual([]);
}

/** Victory recorded at `at`: outcome, one PROGRESSION:VICTORY (no entries, last of its tick) carrying VICTORY_ACHIEVED. */
function expectVictoryAt(g: Game, at: number, completedContractId: ContractId): void {
  const s = g.sim.state;
  expect(s.outcome).toEqual({ status: "WON", tick: at });
  const tx = oneTx(s, VICTORY_KEY);
  expectProgressionTx(tx, at);
  const events = eventsOf(g, tx);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: "VICTORY_ACHIEVED", tick: at, completedContractId });
  expect(eventsOfType(g.events, "VICTORY_ACHIEVED")).toHaveLength(1);
  // Every PROGRESSION transaction of the tick (reputation, tiers) comes before it.
  const i = indexOfKey(s, VICTORY_KEY);
  s.ledger.transactions.forEach((t, k) => {
    if (t.tick === at && t.kind === "PROGRESSION" && t.idempotencyKey !== VICTORY_KEY) expect(k).toBeLessThan(i);
  });
}

describe("PROG-001 victory: the conditions (decision 7)", () => {
  it("pins the GDD §2 thresholds that victory reads from game-data", () => {
    expect(VICTORY).toEqual({ netWorth: cents(500_000), reputation: 30, completedContracts: 1 });
  });

  it.each<{ readonly outcomes: readonly InstallmentOutcome[] }>([
    { outcomes: ["FULFILLED", "FULFILLED", "FULFILLED"] },
    { outcomes: ["MISSED", "MISSED", "MISSED"] },
    { outcomes: ["PARTIAL", "MISSED", "FULFILLED"] },
  ])(
    "wins on the first tick all three hold (completed contract outcomes $outcomes): PROGRESSION:VICTORY after tier promotion, VICTORY_ACHIEVED, outcome WON",
    ({ outcomes }) => {
      const { g, completed } = winningGame(outcomes);
      to(g, 1);
      const s = g.sim.state;
      expectVictoryAt(g, 1, completed[0]!);
      const [event] = eventsOfType(g.events, "VICTORY_ACHIEVED");
      expect(event).toMatchObject({ netWorth: netWorthOf(s), reputation: s.family.reputation, completedContractId: completed[0]! });
      expect(event!.netWorth).toBe(VICTORY.netWorth);
      expect(event!.reputation).toBe(VICTORY.reputation);
      // Tier promotion ran on the same tick, before victory.
      const tiers = s.ledger.transactions.filter((t) => t.tick === 1 && t.idempotencyKey.startsWith("PROGRESSION:TIER:"));
      expect(tiers.length).toBeGreaterThan(0);
      // Victory is the tick's last transaction (tick 1 has no midnight).
      expect(s.ledger.transactions.at(-1)!.idempotencyKey).toBe(VICTORY_KEY);
      expect(g.sim.snapshot().outcome).toEqual({ status: "WON", tick: 1 });
    },
  );

  it("completedContractId is the first COMPLETED contract in state.contracts order, skipping an earlier ACTIVE one", () => {
    const g = start();
    let ids: ContractId[] = [];
    edit(g, (s) => {
      const active = withContract(withFamily(s, { reputation: VICTORY.reputation }), {
        status: "ACTIVE",
        installments: [{ deadline: 50 * DAY, settlesAs: "FULFILLED" }],
      });
      const made = withCompleted(active.state, Math.max(2, VICTORY.completedContracts), ["MISSED", "FULFILLED", "PARTIAL"]);
      ids = [active.contractId, ...made.ids];
      return withNetWorth(made.state, VICTORY.netWorth);
    });
    expect(ids).toEqual([...ids].sort(compareIds));
    to(g, 1);
    expectVictoryAt(g, 1, ids[1]!);
  });
});

describe("PROG-001 victory: one condition short (decision 7)", () => {
  it("net worth one cent short: no victory", () => {
    const g = start();
    edit(g, (s) => withNetWorth(withCompleted(withFamily(s, { reputation: VICTORY.reputation }), VICTORY.completedContracts).state, VICTORY.netWorth - 1));
    to(g, 120);
    expect(netWorthOf(g.sim.state)).toBe(VICTORY.netWorth - 1);
    expectNoVictory(g);
  });

  it("reputation one point short: no victory", () => {
    const g = start();
    edit(g, (s) => withNetWorth(withCompleted(withFamily(s, { reputation: VICTORY.reputation - 1 }), VICTORY.completedContracts).state, VICTORY.netWorth));
    to(g, 120);
    expect(g.sim.state.family.reputation).toBe(VICTORY.reputation - 1);
    expectNoVictory(g);
  });

  it("one completed contract short (another ACTIVE, most of it settled): no victory", () => {
    const g = start();
    edit(g, (s) => {
      const fewer = withCompleted(withFamily(s, { reputation: VICTORY.reputation }), VICTORY.completedContracts - 1).state;
      const active = withContract(fewer, {
        status: "ACTIVE",
        installments: ["FULFILLED", "FULFILLED", { deadline: 50 * DAY, settlesAs: "FULFILLED" }],
      }).state;
      return withNetWorth(active, VICTORY.netWorth);
    });
    to(g, 120);
    expect(g.sim.state.contracts.filter((c) => c.status === "COMPLETED")).toHaveLength(VICTORY.completedContracts - 1);
    expectNoVictory(g);
  });
});

describe("PROG-001 victory: detected on the tick the last condition becomes true (decision 8)", () => {
  it("reputation last: the installment that lifts reputation to the threshold wins on its own tick, after its PROGRESSION:INSTALLMENT", () => {
    const F = RULES.installmentFulfilled;
    expect(F).toBeGreaterThan(0);
    expect(VICTORY.reputation).toBeGreaterThanOrEqual(F);
    const D = 100;
    const g = start();
    let completed: ContractId[] = [];
    let pending: ContractId | null = null;
    edit(g, (s) => {
      const done = withCompleted(withFamily(s, { reputation: VICTORY.reputation - F, consecutiveFulfilledInstallments: 0 }), VICTORY.completedContracts);
      completed = done.ids;
      const active = withContract(done.state, { status: "ACTIVE", installments: [{ deadline: D, settlesAs: "FULFILLED" }] });
      pending = active.contractId;
      return withNetWorth(active.state, VICTORY.netWorth + cents(100_000));
    });
    to(g, D - 1);
    expectNoVictory(g);
    to(g, D);
    const s = g.sim.state;
    expect(s.family.reputation).toBe(VICTORY.reputation);
    expectVictoryAt(g, D, completed[0]!);
    expect(indexOfKey(s, installmentKey(pending!, 0))).toBeLessThan(indexOfKey(s, VICTORY_KEY));
    expect(eventsOfType(g.events, "VICTORY_ACHIEVED")[0]).toMatchObject({ reputation: VICTORY.reputation, netWorth: netWorthOf(s) });
  });

  it("the completed contract last: a final MISSED installment completes the contract and wins on its tick, whatever the outcome", () => {
    const D = 100;
    const start0 = 50;
    const after = Math.max(0, start0 + RULES.installmentMissed);
    expect(after).toBeGreaterThanOrEqual(VICTORY.reputation);
    const g = start();
    let id: ContractId | null = null;
    edit(g, (s) => {
      const fewer = withCompleted(withFamily(s, { reputation: start0 }), VICTORY.completedContracts - 1);
      const active = withContract(fewer.state, { status: "ACTIVE", installments: ["FULFILLED", { deadline: D, settlesAs: "MISSED" }] });
      id = active.contractId;
      return withNetWorth(active.state, VICTORY.netWorth + cents(100_000));
    });
    to(g, D - 1);
    expectNoVictory(g);
    to(g, D);
    const s = g.sim.state;
    expect(s.contracts.find((c) => c.id === id)!.status).toBe("COMPLETED");
    expect(s.family.reputation).toBe(after);
    const first = s.contracts.find((c) => c.status === "COMPLETED")!.id;
    expectVictoryAt(g, D, first);
    // Net worth after the missed installment's penalty.
    expect(eventsOfType(g.events, "VICTORY_ACHIEVED")[0]).toMatchObject({ reputation: after, netWorth: netWorthOf(s) });
  });

  it("net worth last: the sale whose arrival lifts net worth to exactly the threshold wins on the arrival tick, after the SALE", () => {
    const g = start();
    let completed: ContractId[] = [];
    edit(g, (s) => {
      const made = withCompleted(withStock(withFamily(s, { reputation: VICTORY.reputation }), 1, 700), VICTORY.completedContracts);
      completed = made.ids;
      return made.state;
    });
    const { unitPrice } = spotBuyerFor(g.sim.state, 1);
    const profit = unitPrice - 700;
    expect(profit).toBeGreaterThan(0);
    edit(g, (s) => withNetWorth(s, VICTORY.netWorth - profit));
    const d = dispatchSpot(g, 1);
    expect(d.arrival).toBeLessThan(DAY);
    to(g, d.arrival - 1);
    expect(netWorthOf(g.sim.state)).toBe(VICTORY.netWorth - profit);
    expectNoVictory(g);
    to(g, d.arrival);
    const s = g.sim.state;
    expect(deliveryOf(s, d.deliveryId).status).toBe("DELIVERED");
    expectVictoryAt(g, d.arrival, completed[0]!);
    expect(indexOfKey(s, idempotencyKey("SALE", d.deliveryId))).toBeLessThan(indexOfKey(s, VICTORY_KEY));
    expect(eventsOfType(g.events, "VICTORY_ACHIEVED")[0]).toMatchObject({ netWorth: VICTORY.netWorth, reputation: VICTORY.reputation });
  });
});

// ===========================================================================
// Insolvency (decision 10)
// ===========================================================================

/** A default game with its cash moved to owner equity at tick 0: no cash, no goods, the still owned. */
function brokeGame(): Game {
  const g = start();
  edit(g, withoutCash);
  return g;
}

function expectNotLost(g: Game): void {
  expect(g.sim.state.outcome.status).not.toBe("LOST");
  expect(eventsOfType(g.events, "GAME_LOST")).toEqual([]);
  expect(keyed(g.sim.state, LOST_KEY)).toEqual([]);
}

/** Lost at midnight `at`: outcome, one PROGRESSION:LOST (no entries, the tick's last, after payroll) carrying GAME_LOST. */
function expectLostAt(g: Game, at: number): void {
  const s = g.sim.state;
  expect(s.outcome).toEqual({ status: "LOST", tick: at, reason: "INSOLVENT" });
  const tx = oneTx(s, LOST_KEY);
  expectProgressionTx(tx, at);
  const events = eventsOf(g, tx);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: "GAME_LOST", reason: "INSOLVENT", tick: at });
  expect(eventsOfType(g.events, "GAME_LOST")).toHaveLength(1);
  const sameTick = s.ledger.transactions.filter((t) => t.tick === at);
  expect(sameTick.at(-1)!.idempotencyKey).toBe(LOST_KEY);
  expect(indexOfKey(s, payrollKey(at / DAY - 1))).toBeLessThan(indexOfKey(s, LOST_KEY));
}

describe("PROG-001 insolvency: the midnight check (decision 10)", () => {
  it("loses at the first midnight with no cash, no goods, and no affordable restart; not before; PROGRESSION:LOST is the tick's last transaction", () => {
    const g = brokeGame();
    to(g, DAY - 1);
    expectNotLost(g);
    to(g, DAY);
    expectLostAt(g, DAY);
    // The fixture moved cash at tick 0 only, so the snapshot can be projected.
    expect(g.sim.snapshot().outcome).toEqual({ status: "LOST", tick: DAY, reason: "INSOLVENT" });
    expectNoFalseLoss(g.sim.state);
  });

  it("finished goods on hand block it", () => {
    const g = brokeGame();
    edit(g, (s) => withStock(s, 1));
    to(g, DAY);
    expect(cashOf(g.sim.state)).toBe(0);
    expectNotLost(g);
  });

  it("a running job blocks it", () => {
    const g = start();
    const recipe = recipeDef(BASIC_MOONSHINE_RECIPE);
    const quantity = 12;
    for (const input of recipe.inputsPerCase) {
      const offer = currentOffer(g.sim.state, input.materialId)!;
      expectApplied(run(g, { type: "PURCHASE_MATERIALS", supplierId: offer.supplierId, materialId: input.materialId, quantity: input.quantity * quantity, facilityId: DISTILLERY_MAIN }));
    }
    expectApplied(run(g, { type: "START_PRODUCTION", facilityId: DISTILLERY_MAIN, recipeId: recipe.id, quantity }));
    edit(g, withoutCash);
    const job = g.sim.state.productionJobs[0]!;
    expect(job.completesAt).toBeGreaterThan(DAY);
    to(g, DAY);
    expect(g.sim.state.productionJobs).toHaveLength(1);
    expect(g.sim.state.productPools.every((p) => p.quantity === 0)).toBe(true);
    expectNotLost(g);
  });

  it("an OUTBOUND truck blocks it", () => {
    const g = brokeGame();
    edit(g, (s) => withStock(s, 1));
    to(g, DAY - 60);
    const d = dispatchSpot(g, 1);
    expect(d.arrival).toBeGreaterThan(DAY);
    to(g, DAY);
    expect(deliveryOf(g.sim.state, d.deliveryId).status).toBe("OUTBOUND");
    expect(g.sim.state.productPools.every((p) => p.quantity === 0)).toBe(true);
    expectNotLost(g);
  });

  it("a truck carrying fallen-through (FAILED) cargo home blocks it", () => {
    const g = brokeGame();
    edit(g, (s) => withStock(s, 1));
    const buyer = DATA.buyers.find((b) => b.id === spotBuyerFor(g.sim.state, 1).buyerId)!;
    const route = DATA.routes.find((r) => r.toLocationId === buyer.locationId)!; // the default (safe) route, listed first
    expect(route.riskPpm).toBe(0);
    // Dispatch so the outbound arrival is before midnight and the return after it.
    to(g, DAY - route.durationTicks - 10);
    const d = dispatchSpot(g, 1);
    expect(d.arrival).toBeLessThan(DAY);
    expect(d.arrival + route.durationTicks).toBeGreaterThan(DAY);
    // The deal's deadline passes before the truck gets there, so the sale falls through.
    edit(g, (s) => ({ ...s, deliveries: s.deliveries.map((x) => (x.id === d.deliveryId ? { ...x, dealDeadline: tick(d.arrival - 1) } : x)) }));
    to(g, DAY);
    const s = g.sim.state;
    const delivery = deliveryOf(s, d.deliveryId);
    expect(delivery.status).toBe("FAILED");
    expect(cargoCases(delivery)).toBe(1);
    expect(truck(s).trip).toMatchObject({ deliveryId: d.deliveryId, leg: "RETURN" });
    expect(truck(s).trip!.arrivesAt).toBeGreaterThan(DAY);
    expect(s.productPools.every((p) => p.quantity === 0)).toBe(true);
    expect(cashOf(s)).toBe(0);
    expectNotLost(g);
  });

  it("an earlier DELIVERED sale keeps its cargo but doesn't block it: the game still reaches LOST", () => {
    const g = start();
    edit(g, (s) => withStock(s, 1));
    const d = dispatchSpot(g, 1);
    to(g, d.arrival);
    untilTruckHome(g);
    edit(g, withoutCash);
    to(g, DAY);
    const delivery = deliveryOf(g.sim.state, d.deliveryId);
    expect(delivery.status).toBe("DELIVERED");
    expect(cargoCases(delivery)).toBe(1);
    expectLostAt(g, DAY);
    expectNoFalseLoss(g.sim.state);
  });

  it("resale of equipment the restart doesn't need rescues the game at funds(R) = cost(R), and the policy then sells; one cent less loses", () => {
    const base = brokeGame();
    const restart = cheapestRestart(base.sim.state)!;
    expect(restart.recipe.id).toBe(BASIC_MOONSHINE_RECIPE);
    expect(restart.recipe.requiredEquipmentIds).not.toContain(STORAGE_EXPANSION);
    // The smallest book value whose resale covers cost(R); one cent less doesn't.
    let bookValue = Math.floor((restart.cost * RATIO_SCALE) / RESALE_RATIO);
    while (resaleOf(cents(bookValue)) >= restart.cost) bookValue--;
    while (resaleOf(cents(bookValue)) < restart.cost) bookValue++;
    expect(resaleOf(cents(bookValue - 1))).toBeLessThan(restart.cost);

    const rescued = brokeGame();
    edit(rescued, (s) => withEquipment(s, STORAGE_EXPANSION, bookValue));
    to(rescued, DAY);
    expect(cashOf(rescued.sim.state)).toBe(0);
    expect(cheapestRestart(rescued.sim.state)).toMatchObject({ cost: restart.cost, funds: resaleOf(cents(bookValue)) });
    expectNotLost(rescued);
    const policy = runPolicy(rescued.sim.state);
    expect(policy.reached).toBe("SALE_COMPLETED");
    expect(eventsOfType(policy.game.events, "EQUIPMENT_SOLD").map((e) => e.equipmentId)).toEqual([STORAGE_EXPANSION]);

    const short = brokeGame();
    edit(short, (s) => withEquipment(s, STORAGE_EXPANSION, bookValue - 1));
    to(short, DAY);
    expectLostAt(short, DAY);
    expectNoFalseLoss(short.sim.state);
  });

  it("a sold still the funds can't rebuy loses, with positive cash; the policy is rejected for funds at PURCHASE_EQUIPMENT", () => {
    const g = brokeGame();
    expectApplied(run(g, { type: "SELL_EQUIPMENT", facilityId: DISTILLERY_MAIN, equipmentId: COPPER_STILL }));
    expect(cashOf(g.sim.state)).toBe(resaleOf(equipmentDef(COPPER_STILL).price));
    to(g, DAY);
    const s = g.sim.state;
    expect(cashOf(s)).toBeGreaterThan(0);
    const restart = cheapestRestart(s)!;
    expect(restart.missing.map((e) => e.id)).toEqual([COPPER_STILL]);
    expect(restart.funds).toBeLessThan(restart.cost);
    expectLostAt(g, DAY);
    expectNoFalseLoss(s);
    expect(attemptRestart(copyOf(s))).toMatchObject({ status: "INSUFFICIENT_FUNDS", step: "PURCHASE_EQUIPMENT" });
  });

  it("conversion cost alone exceeding cash loses (inputs on hand, positive cash); cash equal to it doesn't", () => {
    const recipe = recipeDef(BASIC_MOONSHINE_RECIPE);
    const prepared = (cashAtCheck: number): Game => {
      const g = start();
      for (const input of recipe.inputsPerCase) {
        const offer = currentOffer(g.sim.state, input.materialId)!;
        expectApplied(run(g, { type: "PURCHASE_MATERIALS", supplierId: offer.supplierId, materialId: input.materialId, quantity: input.quantity, facilityId: DISTILLERY_MAIN }));
      }
      expect(cheapestRestart(g.sim.state)).toMatchObject({ cost: conversionOf(recipe), shortfalls: [] });
      edit(g, (s) => withCashAfterMidnight(s, cashAtCheck));
      to(g, DAY);
      expect(cashOf(g.sim.state)).toBe(cashAtCheck);
      return g;
    };
    expect(conversionOf(recipe)).toBeGreaterThan(1);

    const enough = prepared(conversionOf(recipe));
    expectNotLost(enough);

    const short = prepared(conversionOf(recipe) - 1);
    expectLostAt(short, DAY);
    expectNoFalseLoss(short.sim.state);
    expect(attemptRestart(copyOf(short.sim.state))).toMatchObject({ status: "INSUFFICIENT_FUNDS", step: "START_PRODUCTION" });
  });

  it("a shortage doesn't cause a loss: cash covering cost(R) at base prices survives a midnight where today's prices would need more; one cent less loses", () => {
    const atShortage = (cashOverCost: number): { g: Game; shortageTick: number } => {
      const g = start();
      to(g, DAY);
      const shortage = g.sim.state.scheduledEvents.find((e) => e.kind === "SHORTAGE_START");
      if (!shortage || shortage.kind !== "SHORTAGE_START") throw new Error("No shortage scheduled after day 1");
      expect(shortage.tick % DAY).toBe(0);
      to(g, shortage.tick - 1);
      const cost = cheapestRestart(g.sim.state)!.cost;
      edit(g, (s) => withCashAfterMidnight(s, cost + cashOverCost));
      to(g, shortage.tick);
      const s = g.sim.state;
      expect(cashOf(s)).toBe(cost + cashOverCost);
      // The shortage is on, and today's price for the restart is above the base price.
      const line = s.suppliers.find((x) => x.id === shortage.supplierId)!.stock.find((st) => st.materialId === shortage.materialId)!;
      expect(line.shortage).not.toBeNull();
      expect(line.unitPrice).toBeGreaterThan(basePrice(s, shortage.materialId)!);
      const r = cheapestRestart(s)!;
      expect(r.cost).toBe(cost);
      const atToday =
        conversionOf(r.recipe) + r.missing.reduce((n, e) => n + e.price, 0) + r.shortfalls.reduce((n, x) => n + x.quantity * currentOffer(s, x.materialId)!.unitPrice, 0);
      expect(atToday).toBeGreaterThan(cashOf(s));
      return { g, shortageTick: shortage.tick };
    };

    const covered = atShortage(0);
    expect(hasNoGoods(covered.g.sim.state)).toBe(true);
    expectNotLost(covered.g);

    const short = atShortage(-1);
    expectLostAt(short.g, short.shortageTick);
    expectNoFalseLoss(short.g.sim.state);
  });
});

// ===========================================================================
// The outcome is terminal and sticky (decision 8)
// ===========================================================================

describe("PROG-001 outcome: terminal and sticky (decision 8)", () => {
  it("after WON: no second victory, no loss even when insolvent at midnight; commands, ticks, and reputation keep working", () => {
    const { g, completed } = winningGame();
    let pending: ContractId | null = null;
    edit(g, (s) => {
      const active = withContract(s, { status: "ACTIVE", installments: [{ deadline: 200, settlesAs: "FULFILLED" }] });
      pending = active.contractId;
      return active.state;
    });
    to(g, 1);
    expectVictoryAt(g, 1, completed[0]!);

    // Reputation keeps updating after the win.
    to(g, 200);
    const later = eventsOfType(g.events, "REPUTATION_CHANGED").filter((e) => e.tick === 200 && e.contractId === pending);
    expect(later.length).toBeGreaterThan(0);
    expect(oneTx(g.sim.state, installmentKey(pending!, 0)).tick).toBe(200);

    // Commands still apply.
    const corn = recipeDef(BASIC_MOONSHINE_RECIPE).inputsPerCase[0]!;
    const offer = currentOffer(g.sim.state, corn.materialId)!;
    expectApplied(run(g, { type: "PURCHASE_MATERIALS", supplierId: offer.supplierId, materialId: corn.materialId, quantity: 1, facilityId: DISTILLERY_MAIN }));

    // Insolvent at midnight by decision 10's rule, but the outcome is already decided.
    edit(g, withoutCash);
    to(g, DAY);
    const s = g.sim.state;
    expect(hasNoGoods(s)).toBe(true);
    expect(feasibleRestarts(s).every((r) => r.funds < r.cost)).toBe(true);
    expect(s.outcome).toEqual({ status: "WON", tick: 1 });
    expect(eventsOfType(g.events, "GAME_LOST")).toEqual([]);
    expect(keyed(s, LOST_KEY)).toEqual([]);
    expect(keyed(s, VICTORY_KEY)).toHaveLength(1);
    expect(eventsOfType(g.events, "VICTORY_ACHIEVED")).toHaveLength(1);
  });

  it("after LOST: no second loss, no victory even when every condition holds; commands, ticks, and tiers keep working", () => {
    const g = brokeGame();
    to(g, DAY);
    expectLostAt(g, DAY);
    to(g, 2 * DAY);
    expect(g.sim.state.outcome).toEqual({ status: "LOST", tick: DAY, reason: "INSOLVENT" });
    expect(eventsOfType(g.events, "GAME_LOST")).toHaveLength(1);
    expect(keyed(g.sim.state, LOST_KEY)).toHaveLength(1);

    const tiersBefore = g.sim.state.family.tierId;
    edit(g, (s) => withNetWorth(withCompleted(withFamily(s, { reputation: VICTORY.reputation }), VICTORY.completedContracts).state, VICTORY.netWorth + cents(100_000)));
    const corn = recipeDef(BASIC_MOONSHINE_RECIPE).inputsPerCase[0]!;
    const offer = currentOffer(g.sim.state, corn.materialId)!;
    expectApplied(run(g, { type: "PURCHASE_MATERIALS", supplierId: offer.supplierId, materialId: corn.materialId, quantity: 1, facilityId: DISTILLERY_MAIN }));
    to(g, 2 * DAY + 60);
    const s = g.sim.state;
    expect(s.outcome).toEqual({ status: "LOST", tick: DAY, reason: "INSOLVENT" });
    expect(eventsOfType(g.events, "VICTORY_ACHIEVED")).toEqual([]);
    expect(keyed(s, VICTORY_KEY)).toEqual([]);
    // Tiers still promote after the loss.
    expect(s.family.tierId).not.toBe(tiersBefore);
    expect(eventsOfType(g.events, "TIER_REACHED").filter((e) => e.tick > 2 * DAY).length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// The recovery policy and the horizon (decision 10)
// ===========================================================================

describe("PROG-001 recovery: the policy helper and H (decision 10)", () => {
  it("H's slack is two days, a one-case job at workforce 1 for the slowest recipe, and a round trip on the longest safe route", () => {
    const slowest = Math.max(...DATA.recipes.map((r) => oneCaseTicksAtOneWorker(r)));
    const longest = Math.max(...DATA.routes.filter((r) => r.riskPpm === 0).map((r) => r.durationTicks));
    expect(horizonSlack()).toBe(2 * DAY + slowest + 2 * longest);
    // Every M001 recipe can't fail, which the slack's single job relies on (decision 15).
    expect(DATA.recipes.every((r) => r.failureChance === 0)).toBe(true);
    // A fresh game: the rival closure is scheduled, so it sets the latest term.
    const s = start().sim.state;
    const closure = s.scheduledEvents.find((e) => e.kind === "ROUTE_CLOSURE");
    if (!closure || closure.kind !== "ROUTE_CLOSURE" || closure.durationTicks === null) throw new Error("The First Shipment schedules a timed rival closure");
    expect(closure.routeId).toBe(COUNTY_ROAD);
    expect(horizon(s)).toBe(closure.tick + closure.durationTicks + horizonSlack());
  });

  it("restarts a default game from its first midnight and sells by H", () => {
    const g = start();
    to(g, DAY);
    const result = runPolicy(g.sim.state);
    expect(result.reached).toBe("SALE_COMPLETED");
    expect(result.game.sim.state.tick).toBeLessThanOrEqual(result.horizon);
  });
});

// ===========================================================================
// Properties: no soft-lock, no false loss (decision 10)
// ===========================================================================

type Action =
  | { readonly kind: "buy"; readonly material: number; readonly quantity: number }
  | { readonly kind: "produce"; readonly recipe: number; readonly quantity: number }
  | { readonly kind: "sell"; readonly pool: number; readonly buyer: number; readonly risky: boolean; readonly quantity: number }
  | { readonly kind: "accept" }
  | { readonly kind: "deliver"; readonly risky: boolean; readonly quantity: number }
  | { readonly kind: "equip"; readonly item: number }
  | { readonly kind: "unequip"; readonly item: number }
  | { readonly kind: "workforce"; readonly count: number }
  | { readonly kind: "release" }
  | { readonly kind: "repeat"; readonly back: number };

interface Step {
  readonly action: Action;
  readonly wait: number;
}

interface Sample {
  /** Cash at tick 0 in cents (a low-cash fixture), or null for the scenario's own. */
  readonly cash: number | null;
  /** Basic cases of finished stock booked at tick 0 (so a low-cash game can survive its first midnights). */
  readonly stock: number;
  readonly steps: readonly Step[];
  /** The run continues to this day's midnight at least. */
  readonly endDay: number;
}

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  fc.record({ kind: fc.constant("buy" as const), material: fc.nat(3), quantity: fc.integer({ min: 1, max: 30 }) }),
  fc.record({ kind: fc.constant("produce" as const), recipe: fc.nat(3), quantity: fc.integer({ min: 1, max: 12 }) }),
  fc.record({
    kind: fc.constant("sell" as const),
    pool: fc.nat(3),
    buyer: fc.nat(5),
    risky: fc.boolean(),
    quantity: fc.integer({ min: 1, max: 20 }),
  }),
  fc.constant({ kind: "accept" as const }),
  fc.record({ kind: fc.constant("deliver" as const), risky: fc.boolean(), quantity: fc.integer({ min: 1, max: 20 }) }),
  fc.record({ kind: fc.constant("equip" as const), item: fc.nat(7) }),
  fc.record({ kind: fc.constant("unequip" as const), item: fc.nat(7) }),
  fc.record({ kind: fc.constant("workforce" as const), count: fc.integer({ min: 0, max: 8 }) }),
  fc.constant({ kind: "release" as const }),
  fc.record({ kind: fc.constant("repeat" as const), back: fc.nat(5) }),
);

const sampleArb: fc.Arbitrary<Sample> = fc.record({
  cash: fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 3_000 }), fc.constant(null)),
  stock: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 12 })),
  steps: fc.array(fc.record({ action: actionArb, wait: fc.integer({ min: 0, max: DAY }) }), { maxLength: 16 }),
  // Biased toward the rival closure (day 8 08:00 to day 9 08:00 in the First Shipment) and past the shortage.
  endDay: fc.oneof(fc.integer({ min: 1, max: 12 }), fc.integer({ min: 9, max: 12 })),
});

/** The first route listed from home to `buyer` with the wanted risk (risky or safe), or null for the default. */
function routeFor(buyerId: BuyerId, risky: boolean): RouteId | null {
  if (!risky) return null;
  const buyer = DATA.buyers.find((b) => b.id === buyerId)!;
  const home = DATA.facilities.find((f) => f.id === DISTILLERY_MAIN)!;
  return DATA.routes.find((r) => r.fromLocationId === home.locationId && r.toLocationId === buyer.locationId && r.riskPpm > 0)?.id ?? null;
}

/** A well-formed command for `action` against the current state (it may still be rejected), or null to skip. */
function commandFor(state: GameState, action: Action): GameCommand | null {
  const pick = <T>(list: readonly T[], i: number): T | undefined => (list.length === 0 ? undefined : list[i % list.length]);
  switch (action.kind) {
    case "buy": {
      const supplier = pick(byId(state.suppliers), 0);
      const line = supplier && pick(supplier.stock, action.material);
      if (!supplier || !line) return null;
      return { type: "PURCHASE_MATERIALS", supplierId: supplier.id, materialId: line.materialId, quantity: action.quantity, facilityId: DISTILLERY_MAIN };
    }
    case "produce": {
      const recipe = pick(byId(DATA.recipes), action.recipe)!;
      return { type: "START_PRODUCTION", facilityId: DISTILLERY_MAIN, recipeId: recipe.id, quantity: action.quantity };
    }
    case "sell": {
      const pool = pick(
        state.productPools.filter((p) => p.quantity > 0),
        action.pool,
      );
      const buyer = pick(byId(state.buyers), action.buyer);
      if (!pool || !buyer) return null;
      const want = matchWant(buyer, pool.productId, pool.quality);
      return {
        type: "DISPATCH_DELIVERY",
        vehicleId: MODEL_TT_TRUCK,
        cargo: [{ productId: pool.productId, quality: pool.quality, quantity: action.quantity }],
        purpose: { kind: "SALE", buyerId: buyer.id, agreedUnitPrice: want?.unitPrice ?? cents(1) },
        routeId: routeFor(buyer.id, action.risky),
      };
    }
    case "accept": {
      const offer = state.contractOffers[0];
      return offer ? { type: "ACCEPT_CONTRACT", contractOfferId: offer.id } : null;
    }
    case "deliver": {
      const contract = state.contracts.find((c) => c.status === "ACTIVE");
      if (!contract) return null;
      return {
        type: "DISPATCH_DELIVERY",
        vehicleId: MODEL_TT_TRUCK,
        cargo: [{ productId: contract.productId, quality: contract.minimumQuality, quantity: action.quantity }],
        purpose: { kind: "CONTRACT_INSTALLMENT", contractId: contract.id },
        routeId: routeFor(contract.buyerId, action.risky),
      };
    }
    case "equip":
      return { type: "PURCHASE_EQUIPMENT", facilityId: DISTILLERY_MAIN, equipmentId: pick(DATA.equipment, action.item)!.id };
    case "unequip":
      return { type: "SELL_EQUIPMENT", facilityId: DISTILLERY_MAIN, equipmentId: pick(DATA.equipment, action.item)!.id };
    case "workforce":
      return { type: "SET_WORKFORCE", facilityId: DISTILLERY_MAIN, workerCount: action.count };
    case "release": {
      const reservation = state.reservations.find((r) => r.holder.kind === "CONTRACT");
      return reservation ? { type: "RELEASE_RESERVATION", reservationId: reservation.id } : null;
    }
    case "repeat": {
      const source = state.commandLog[state.commandLog.length - 1 - action.back];
      return source ? { type: "REPEAT_OPERATION", sourceCommandId: source.id } : null;
    }
  }
}

/** Advances to `target`, stopping at every midnight on the way to call `onMidnight` with the events since the last stop. */
function advanceTo(g: Game, target: number, onMidnight: (g: Game, events: readonly GameEvent[]) => void): void {
  let from = g.events.length;
  while (g.sim.state.tick < target) {
    const next = Math.min(target, (Math.floor(g.sim.state.tick / DAY) + 1) * DAY);
    to(g, next);
    if (next % DAY === 0) {
      onMidnight(g, g.events.slice(from));
      from = g.events.length;
    }
  }
}

/** Plays a sample from the First Shipment, calling `onMidnight` at every midnight reached. */
function play(sample: Sample, onMidnight: (g: Game, events: readonly GameEvent[]) => void): Game {
  const g = start();
  const { cash, stock } = sample;
  edit(g, (s) => {
    const stocked = stock > 0 ? withStock(s, stock) : s;
    return cash === null ? stocked : withCash(stocked, cash);
  });
  for (const step of sample.steps) {
    const command = commandFor(g.sim.state, step.action);
    if (command) run(g, command);
    advanceTo(g, g.sim.state.tick + step.wait, onMidnight);
  }
  advanceTo(g, Math.max(g.sim.state.tick, sample.endDay * DAY), onMidnight);
  return g;
}

const PROPERTY_SEED = 1920;

describe("PROG-001 recovery: properties (decision 10)", () => {
  it(
    "no soft-lock: from every midnight state that isn't LOST, the recovery policy on a copy reaches SALE_COMPLETED or GAME_LOST by H",
    { timeout: 120_000 },
    () => {
      const seen = { midnights: 0, lowCash: 0, closure: 0, shortage: 0 };
      fc.assert(
        fc.property(sampleArb, (sample) => {
          play(sample, (g, events) => {
            const s = g.sim.state;
            if (eventsOfType(events, "GAME_LOST").length > 0) expectNoFalseLoss(s);
            if (s.outcome.status === "LOST") return;
            seen.midnights++;
            if (cashOf(s) < conversionOf(recipeDef(BASIC_MOONSHINE_RECIPE)) + dailyCost(s)) seen.lowCash++;
            if (s.routes.some((r) => r.closure !== null)) seen.closure++;
            if (anyShortage(s)) seen.shortage++;
            const result = runPolicy(s);
            if (result.reached === null) {
              throw new Error(`Soft-lock: the policy from tick ${s.tick} reached neither SALE_COMPLETED nor GAME_LOST by H = ${result.horizon}`);
            }
            if (result.reached === "GAME_LOST") expectNoFalseLoss(result.game.sim.state);
          });
        }),
        { seed: PROPERTY_SEED, numRuns: 100, endOnFailure: true },
      );
      // The generator reached the cases the property is about.
      expect(seen.midnights).toBeGreaterThan(0);
      expect(seen.lowCash).toBeGreaterThan(0);
      expect(seen.closure).toBeGreaterThan(0);
      expect(seen.shortage).toBeGreaterThan(0);
    },
  );

  it(
    "no false loss: whenever GAME_LOST fires, funds(R) < cost(R) for every feasible R, and with no shortage the policy is rejected for funds before production starts",
    { timeout: 120_000 },
    () => {
      let losses = 0;
      fc.assert(
        fc.property(sampleArb, (sample) => {
          play(sample, (g, events) => {
            const lost = eventsOfType(events, "GAME_LOST");
            if (lost.length === 0) return;
            losses++;
            expect(lost).toHaveLength(1);
            expect(lost[0]!.tick).toBe(g.sim.state.tick);
            expectNoFalseLoss(g.sim.state);
          });
        }),
        { seed: PROPERTY_SEED + 1, numRuns: 100, endOnFailure: true },
      );
      // Not vacuous: the low-cash fixtures lose.
      expect(losses).toBeGreaterThan(0);
    },
  );
});
