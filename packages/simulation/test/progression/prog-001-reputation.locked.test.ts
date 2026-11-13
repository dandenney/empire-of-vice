// @locked
// PROG-001 acceptance tests for T05e (issue #104): reputation and tier
// promotion. Covers the first qualifying delivery (spot or contract, once per
// game, PROGRESSION:FIRST_DELIVERY), installment reputation (FULFILLED with the
// family-wide consecutive bonus, PARTIAL, MISSED; event order on one tick; the
// streak across contracts; PROGRESSION:INSTALLMENT:<contractId>:<index>),
// clamping to 0–100, REPUTATION_CHANGED only when the value moves, no
// transaction when nothing changes, each change in its own transaction (never
// inside the SALE or INSTALLMENT_SETTLEMENT that caused it), tier promotion
// (ascending, several on one tick, PROGRESSION:TIER:<tierId>, TIER_REACHED then
// UNLOCK_GRANTED, never revoked, on the tick its condition becomes true, after
// contracts), unlocks sorted with compareIds, equipment gating (LOCKED and the
// snapshot's blockedBy), the static unlock-graph test over GAME_DATA, and the
// decision 2 reputation schedule (Kessler's first contract). Rules come from
// ADR 0020 decisions 2–6 and 8, GDD §9, and ADR 0018 decision 10.
//
// Written ahead of the implementation by a separate test-writer agent
// (factory.md §2, §7.3). Do not edit (CLAUDE.md rule 9).
//
// Imports are limited to the public package entry `src/index.ts`, the inventory
// module `src/inventory/index.ts` (`addProduct`, for fixtures), and
// `@eov/contracts` and `@eov/game-data`. Progression is driven only through the
// Simulation (commands, ticks, snapshots). No new simulation export is assumed.
//
// Numbers. Reputation amounts, tier thresholds, and contract quantities are read
// from GAME_DATA, so T05g's tuning doesn't break these tests. The structural
// pins are ADR 0020's: which tier grants which unlock is read from data, but
// which unlock gates which equipment item (decision 3) is pinned. With today's
// data the decision 2 schedule ends at reputation 22 and `established-producer`.
//
// Fixtures. Finished stock and cash are booked through a coordinator
// transaction (kind OPENING_BALANCE, keys `OPENING_BALANCE:fixture:<n>`) so the
// ledger matches inventory. Installment outcomes come from injected
// `ContractState`s (contract IDs allocated from the counters) whose `delivered`
// counts are preset, so each installment settles with a known outcome at its
// deadline. Reputation, the streak, and the flag are preset by editing
// `state.family`. Some tests patch `GAME_DATA.progression.tiers` (setup.data);
// the static unlock-graph test runs over GAME_DATA only.
//
// Not pinned: `causedBy` on progression events; the snapshot's victory section
// (T05f); the hashes (Sprint Zero and kernel reference are pinned by their own
// tests, which `pnpm check` runs).
//
// Expected to fail on main until T05e lands: nothing applies reputation or
// promotes tiers, and the equipment's `requiredUnlockId` values are still null.
// The static graph checks other than the equipment pins pass on main.

import {
  asId,
  cents,
  compareById,
  compareIds,
  idempotencyKey,
  multiplyMoney,
  qualityRank,
  tick,
  TICKS_PER_DAY,
  type BuyerId,
  type CommandResult,
  type ContractId,
  type ContractState,
  type EquipmentId,
  type GameCommand,
  type GameEvent,
  type GameState,
  type InstallmentOutcome,
  type LedgerEntry,
  type LedgerTransaction,
  type Money,
  type ProductId,
  type QualityTier,
  type RejectionReason,
  type TierId,
  type UnlockId,
} from "@eov/contracts";
import {
  CAPACITY_EQUIPMENT,
  DISTILLERY_MAIN,
  ESTABLISHED_PRODUCER,
  FIRST_SHIPMENT_SCENARIO,
  GAME_DATA,
  IMPROVED_CONDENSER,
  KESSLERS_BACK_ROOM,
  LAKEVIEW_HOTEL,
  MODEL_TT_TRUCK,
  MOONSHINE,
  QC_STATION,
  QUALITY_EQUIPMENT,
  SPOT_SALES,
  STORAGE_EXPANSION,
  TRUSTED_SUPPLIER,
  type GameData,
  type RouteDefinition,
  type TierDefinition,
} from "@eov/game-data";
import { describe, expect, it } from "vitest";
import { addProduct } from "../../src/inventory/index.ts";
import {
  accountBalances,
  allocateId,
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
const RULES = GAME_DATA.progression.reputation;
const TIERS = GAME_DATA.progression.tiers;
const TERMS = GAME_DATA.contracts.terms;

function tierAt(index: number): TierDefinition {
  const t = TIERS[index];
  if (!t) throw new Error(`No tier at index ${index}`);
  return t;
}

const tierIndex = (id: TierId, tiers: readonly TierDefinition[] = TIERS) => tiers.findIndex((t) => t.id === id);

function passes(t: TierDefinition, reputation: number, netWorth: number): boolean {
  return (t.netWorthRequired === null || netWorth >= t.netWorthRequired) && (t.reputationRequired === null || reputation >= t.reputationRequired);
}

/** The tiers above `fromIndex` that decision 4's rule reaches, in ascending order. */
function ladder(fromIndex: number, reputation: number, netWorth: number, tiers: readonly TierDefinition[] = TIERS): TierDefinition[] {
  const reached: TierDefinition[] = [];
  for (let k = fromIndex + 1; k < tiers.length && passes(tiers[k]!, reputation, netWorth); k++) reached.push(tiers[k]!);
  return reached;
}

const repOf = (t: TierDefinition) => t.reputationRequired ?? 0;
const worthOf = (t: TierDefinition) => t.netWorthRequired ?? 0;

const truckDef = GAME_DATA.vehicles.find((v) => v.id === MODEL_TT_TRUCK)!;
const home = GAME_DATA.facilities.find((f) => f.id === truckDef.homeFacilityId)!;

function routeTo(buyerId: BuyerId): RouteDefinition {
  const buyer = GAME_DATA.buyers.find((b) => b.id === buyerId)!;
  const route = GAME_DATA.routes.find((r) => r.fromLocationId === home.locationId && r.toLocationId === buyer.locationId);
  if (!route) throw new Error(`No route to ${buyerId}`);
  return route;
}

function contractBuyer(buyerId: BuyerId) {
  const found = GAME_DATA.contracts.buyers.find((b) => b.buyerId === buyerId);
  if (!found) throw new Error(`No contract definition for ${buyerId}`);
  return found;
}

/** GAME_DATA with tier `index` replaced by `patch` (fixture data; the static graph test never sees it). */
function withTier(index: number, patch: Partial<TierDefinition>): GameData {
  const tiers = TIERS.map((t, i) => (i === index ? { ...t, ...patch } : t));
  return { ...GAME_DATA, progression: { ...GAME_DATA.progression, tiers } };
}

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

function expectApplied(result: CommandResult): void {
  if (result.status !== "applied") throw new Error(`Expected applied, got ${JSON.stringify(result)}`);
}

/** Rejected with `reason`; nothing changed and nothing was emitted (rule 6). */
function expectRejected(g: Game, command: GameCommand, reason: RejectionReason): void {
  flush(g);
  const before = g.sim.stateHash();
  const result = g.sim.dispatch({ command });
  if (result.status !== "rejected") throw new Error(`Expected rejected ${reason.code}, got ${JSON.stringify(result)}`);
  expect(result.reason).toEqual(reason);
  expect(g.sim.stateHash()).toBe(before);
  expect(g.sim.takeEvents()).toEqual([]);
}

function eventsOf(g: Game, tx: LedgerTransaction): GameEvent[] {
  flush(g);
  return tx.eventIds.map((id) => {
    const e = g.events.find((x) => x.id === id);
    if (!e) throw new Error(`Event ${id} of ${tx.idempotencyKey} wasn't seen`);
    return e;
  });
}

function eventsOfType<T extends GameEvent["type"]>(events: readonly GameEvent[], type: T): Extract<GameEvent, { type: T }>[] {
  return events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === type);
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

const progressionTxs = (state: GameState) => state.ledger.transactions.filter((t) => t.kind === "PROGRESSION");
const progressionKeys = (state: GameState) => progressionTxs(state).map((t) => t.idempotencyKey);

const FIRST_DELIVERY_KEY = idempotencyKey("PROGRESSION", "FIRST_DELIVERY");
const installmentKey = (contractId: ContractId, index: number) => idempotencyKey("PROGRESSION", "INSTALLMENT", contractId, index);
const tierKey = (tierId: TierId) => idempotencyKey("PROGRESSION", "TIER", tierId);
const settlementKey = (contractId: ContractId, index: number) => idempotencyKey("INSTALLMENT_SETTLEMENT", contractId, index);

/** A PROGRESSION transaction: no entries (ADR 0020 decision 14), at `at`. */
function expectProgressionTx(tx: LedgerTransaction, at: number): void {
  expect(tx.kind).toBe("PROGRESSION");
  expect(tx.entries).toEqual([]);
  expect(tx.tick).toBe(at);
}

const cashOf = (state: GameState) => accountBalances(state.ledger.transactions).CASH;
const netWorthOf = (state: GameState) => balanceSheet(state).netWorth;

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

/** Finished basic moonshine at the distillery, booked against owner equity. */
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

/** Adds `amount` cents of cash against owner equity (raises net worth by the same). */
function withExtraCash(state: GameState, amount: number): GameState {
  if (amount <= 0) return state;
  return fixtureTx(state, [
    { account: "CASH", side: "DEBIT", amount: cents(amount) },
    { account: "OWNER_EQUITY", side: "CREDIT", amount: cents(amount) },
  ]);
}

/** Moves cash to owner equity so the cash balance is 0 (lowers net worth by the same). */
function withoutCash(state: GameState): GameState {
  const cash = cashOf(state);
  if (cash === 0) return state;
  return fixtureTx(state, [
    { account: "OWNER_EQUITY", side: "DEBIT", amount: cash },
    { account: "CASH", side: "CREDIT", amount: cash },
  ]);
}

/** Tops cash up so net worth is at least `target`. */
function withNetWorthAtLeast(state: GameState, target: number): GameState {
  return withExtraCash(state, target - netWorthOf(state));
}

function withFamily(state: GameState, patch: Partial<GameState["family"]>): GameState {
  return { ...state, family: { ...state.family, ...patch } };
}

interface FixtureContractSpec {
  readonly buyerId: BuyerId;
  readonly deadlines: readonly number[];
  /** Cases already credited to each installment; with the requirement, this fixes the outcome. */
  readonly delivered: readonly number[];
}

/** Injects an ACTIVE ContractState (a contract as a loaded save would hold it). */
function withContract(state: GameState, spec: FixtureContractSpec): { readonly state: GameState; readonly contractId: ContractId } {
  const def = contractBuyer(spec.buyerId);
  const offer = allocateId(state, "ContractOffer");
  const contract = allocateId(offer.state, "Contract");
  const value: ContractState = {
    id: contract.id,
    offerId: offer.id,
    buyerId: spec.buyerId,
    productId: def.productId,
    minimumQuality: def.minimumQuality,
    quantityPerInstallment: def.quantityPerInstallment,
    unitPrice: cents(1_000),
    installmentCount: spec.deadlines.length,
    intervalTicks: spec.deadlines.length > 1 ? spec.deadlines[1]! - spec.deadlines[0]! : TERMS.intervalTicks,
    penaltyRatePpm: TERMS.penaltyRatePpm,
    status: "ACTIVE",
    installments: spec.deadlines.map((deadline, k) => ({
      deadline: tick(deadline),
      required: def.quantityPerInstallment,
      delivered: spec.delivered[k] ?? 0,
      outcome: null,
      penalty: null,
    })),
    reservationIds: [],
  };
  const s = contract.state;
  return { state: { ...s, contracts: [...s.contracts, value].sort(compareById) }, contractId: contract.id };
}

/** Cases credited before the deadline that give `outcome` for `buyerId`'s installment size. */
function deliveredFor(buyerId: BuyerId, outcome: InstallmentOutcome): number {
  const required = contractBuyer(buyerId).quantityPerInstallment;
  return outcome === "FULFILLED" ? required : outcome === "PARTIAL" ? required - 1 : 0;
}

/** Deadlines for a three-installment fixture contract whose first installment settles at `first`. */
const deadlinesFrom = (first: number) => [first, first + 2 * DAY, first + 4 * DAY];

/**
 * A game at tick 0 holding one fixture contract per entry of `outcomes` (created
 * in order, so their IDs ascend), each settling installment k at `deadlinesFrom(first)[k]`
 * with outcome `outcomes[i][k]`. `family` presets reputation, streak, or flag.
 */
function settlingGame(
  outcomes: readonly { readonly buyerId: BuyerId; readonly outcomes: readonly InstallmentOutcome[] }[],
  options: { first?: number; family?: Partial<GameState["family"]>; setup?: GameSetup } = {},
): { g: Game; ids: ContractId[] } {
  const g = start(options.setup);
  const ids: ContractId[] = [];
  edit(g, (s) => {
    let x = withFamily(s, options.family ?? {});
    for (const c of outcomes) {
      const made = withContract(x, {
        buyerId: c.buyerId,
        deadlines: deadlinesFrom(options.first ?? 1),
        delivered: c.outcomes.map((o) => deliveredFor(c.buyerId, o)),
      });
      ids.push(made.contractId);
      x = made.state;
    }
    return x;
  });
  return { g, ids };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const truck = (state: GameState) => state.vehicles.find((v) => v.id === MODEL_TT_TRUCK)!;

/** Advances until the truck is home with no trip. */
function untilTruckHome(g: Game): void {
  for (let guard = 0; truck(g.sim.state).trip !== null; guard++) {
    if (guard > 4) throw new Error("The truck never came home");
    to(g, Math.max(g.sim.state.tick + 1, truck(g.sim.state).trip!.arrivesAt));
  }
}

/** The first buyer (ID order) able to take `quantity` basic cases now: reputation, demand, budget. */
function spotBuyerFor(state: GameState, quantity: number): { readonly buyerId: BuyerId; readonly unitPrice: Money } {
  for (const b of [...state.buyers].sort(compareById)) {
    const def = GAME_DATA.buyers.find((d) => d.id === b.id);
    if (!def || def.minimumReputation > state.family.reputation) continue;
    const want = b.wants.find((w) => w.productId === MOONSHINE && w.minimumQuality === "basic");
    if (!want || want.demandRemaining < quantity || b.budgetRemaining < multiplyMoney(want.unitPrice, quantity)) continue;
    return { buyerId: b.id, unitPrice: want.unitPrice };
  }
  throw new Error(`No buyer can take ${quantity} basic cases at tick ${state.tick}`);
}

/**
 * Dispatches a spot sale of `quantity` basic cases (on the default, safe route)
 * once the truck is home, and returns the delivery and its arrival tick. Doesn't
 * advance to the arrival.
 */
function dispatchSpot(g: Game, quantity: number): { readonly deliveryId: string; readonly arrival: number } {
  untilTruckHome(g);
  const { buyerId, unitPrice } = spotBuyerFor(g.sim.state, quantity);
  // ADR 0022 decision 6: agree the deal at the quote, then dispatch against it.
  expectApplied(run(g, { type: "AGREE_DEAL", buyerId, productId: MOONSHINE, quality: "basic", quantity, agreedUnitPrice: unitPrice }));
  expectApplied(
    run(g, {
      type: "DISPATCH_DELIVERY",
      vehicleId: MODEL_TT_TRUCK,
      cargo: [{ productId: MOONSHINE, quality: "basic", quantity }],
      purpose: { kind: "SALE", buyerId, dealId: g.sim.state.heldDeals.at(-1)!.id },
      routeId: null,
      driver: { kind: "FOUNDER" },
    }),
  );
  const delivery = g.sim.state.deliveries.at(-1)!;
  const trip = truck(g.sim.state).trip;
  if (!trip || trip.deliveryId !== delivery.id) throw new Error("The dispatch didn't start a trip");
  return { deliveryId: delivery.id, arrival: trip.arrivesAt };
}

/** A spot sale of `quantity` cases, run through its arrival. */
function spotSale(g: Game, quantity: number): { readonly deliveryId: string; readonly arrival: number } {
  const d = dispatchSpot(g, quantity);
  to(g, d.arrival);
  expect(g.sim.state.deliveries.find((x) => x.id === d.deliveryId)!.status).toBe("DELIVERED");
  return d;
}

const buyEquipment = (equipmentId: EquipmentId): GameCommand => ({ type: "PURCHASE_EQUIPMENT", facilityId: DISTILLERY_MAIN, equipmentId });

function equipmentOption(g: Game, equipmentId: EquipmentId) {
  const f = g.sim.snapshot().facilities.find((x) => x.id === DISTILLERY_MAIN);
  if (!f) throw new Error("No distillery in the snapshot");
  const o = f.equipmentOptions.find((x) => x.equipmentId === equipmentId);
  if (!o) throw new Error(`No equipment option ${equipmentId}`);
  return o;
}

/** A REPUTATION_CHANGED payload, for toMatchObject. */
function repChange(
  from: number,
  toValue: number,
  reason: Extract<GameEvent, { type: "REPUTATION_CHANGED" }>["reason"],
  deliveryId: string | null,
  contractId: ContractId | null,
) {
  return { type: "REPUTATION_CHANGED", from, to: toValue, reason, deliveryId, contractId };
}

const clamp = (n: number) => Math.min(100, Math.max(0, n));

// ===========================================================================
// First qualifying delivery (decision 5)
// ===========================================================================

describe("PROG-001 reputation: first qualifying delivery", () => {
  const MIN = RULES.qualifyingDeliveryMinimumCases;

  it("a spot sale of the minimum cases gives the first-delivery reputation once, in PROGRESSION:FIRST_DELIVERY after the SALE, and sets the flag", () => {
    const g = start();
    edit(g, (s) => withStock(s, 2 * MIN));
    expect(g.sim.state.family).toMatchObject({ reputation: 0, firstQualifyingDeliveryMade: false });

    const d = dispatchSpot(g, MIN);
    to(g, d.arrival - 1);
    expect(progressionTxs(g.sim.state)).toEqual([]);
    to(g, d.arrival);

    const s = g.sim.state;
    const sale = oneTx(s, idempotencyKey("SALE", d.deliveryId));
    const tx = oneTx(s, FIRST_DELIVERY_KEY);
    expectProgressionTx(tx, d.arrival);
    expect(indexOfKey(s, FIRST_DELIVERY_KEY)).toBeGreaterThan(s.ledger.transactions.indexOf(sale));
    const events = eventsOf(g, tx);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ ...repChange(0, RULES.firstQualifyingDelivery, "FIRST_QUALIFYING_DELIVERY", d.deliveryId, null), tick: d.arrival });
    // Never inside its cause's transaction.
    expect(eventsOfType(eventsOf(g, sale), "REPUTATION_CHANGED")).toEqual([]);
    expect(s.family).toMatchObject({ reputation: RULES.firstQualifyingDelivery, firstQualifyingDeliveryMade: true });

    // A second qualifying sale earns nothing and commits nothing.
    const keysBefore = progressionKeys(s);
    to(g, DAY + 60); // the next day: demand and budget are reset
    const second = spotSale(g, MIN);
    expect(oneTx(g.sim.state, idempotencyKey("SALE", second.deliveryId))).toBeDefined();
    expect(progressionKeys(g.sim.state)).toEqual(keysBefore);
    expect(keyed(g.sim.state, FIRST_DELIVERY_KEY)).toHaveLength(1);
    expect(g.sim.state.family.reputation).toBe(RULES.firstQualifyingDelivery);
    expect(eventsOfType(g.events, "REPUTATION_CHANGED")).toHaveLength(1);
  });

  it("a sale one case short of the minimum earns nothing and leaves the flag unset; a later qualifying sale still earns it", () => {
    const g = start();
    edit(g, (s) => withStock(s, 2 * MIN));
    const short = spotSale(g, MIN - 1);
    expect(oneTx(g.sim.state, idempotencyKey("SALE", short.deliveryId))).toBeDefined();
    expect(progressionTxs(g.sim.state)).toEqual([]);
    expect(eventsOfType(g.events, "REPUTATION_CHANGED")).toEqual([]);
    expect(g.sim.state.family).toMatchObject({ reputation: 0, firstQualifyingDeliveryMade: false });

    to(g, DAY + 60);
    const full = spotSale(g, MIN);
    const tx = oneTx(g.sim.state, FIRST_DELIVERY_KEY);
    expectProgressionTx(tx, full.arrival);
    expect(eventsOf(g, tx)).toMatchObject([repChange(0, RULES.firstQualifyingDelivery, "FIRST_QUALIFYING_DELIVERY", full.deliveryId, null)]);
    expect(g.sim.state.family.firstQualifyingDeliveryMade).toBe(true);
  });
});

// ===========================================================================
// Installments (decision 5)
// ===========================================================================

describe("PROG-001 reputation: installments", () => {
  it("FULFILLED adds the fulfilled amount; the second in a row adds the consecutive bonus as its own event in the same transaction; deliveryId is null", () => {
    const { g, ids } = settlingGame([{ buyerId: KESSLERS_BACK_ROOM, outcomes: ["FULFILLED", "FULFILLED", "MISSED"] }]);
    const [id] = ids as [ContractId];
    const [d0, d1, d2] = deadlinesFrom(1) as [number, number, number];
    const F = RULES.installmentFulfilled;
    const B = RULES.consecutiveInstallmentBonus;

    to(g, d0);
    let s = g.sim.state;
    const settle0 = oneTx(s, settlementKey(id, 0));
    const tx0 = oneTx(s, installmentKey(id, 0));
    expectProgressionTx(tx0, d0);
    expect(s.ledger.transactions.indexOf(settle0)).toBeLessThan(s.ledger.transactions.indexOf(tx0));
    expect(eventsOf(g, settle0).map((e) => e.type)).toEqual(["INSTALLMENT_SETTLED"]);
    expect(eventsOf(g, tx0)).toMatchObject([repChange(0, clamp(F), "INSTALLMENT_FULFILLED", null, id)]);
    expect(s.family).toMatchObject({ reputation: clamp(F), consecutiveFulfilledInstallments: 1 });

    to(g, d1);
    s = g.sim.state;
    const settle1 = oneTx(s, settlementKey(id, 1));
    const tx1 = oneTx(s, installmentKey(id, 1));
    expectProgressionTx(tx1, d1);
    expect(s.ledger.transactions.indexOf(settle1)).toBeLessThan(s.ledger.transactions.indexOf(tx1));
    expect(eventsOf(g, settle1).map((e) => e.type)).toEqual(["INSTALLMENT_SETTLED"]);
    const r1 = clamp(F);
    expect(eventsOf(g, tx1)).toMatchObject([
      repChange(r1, clamp(r1 + F), "INSTALLMENT_FULFILLED", null, id),
      repChange(clamp(r1 + F), clamp(clamp(r1 + F) + B), "CONSECUTIVE_INSTALLMENT", null, id),
    ]);
    const r2 = clamp(clamp(r1 + F) + B);
    expect(s.family).toMatchObject({ reputation: r2, consecutiveFulfilledInstallments: 2 });

    to(g, d2);
    s = g.sim.state;
    const settle2 = oneTx(s, settlementKey(id, 2));
    const tx2 = oneTx(s, installmentKey(id, 2));
    expectProgressionTx(tx2, d2);
    // The last settlement also completes the contract; its events are still only the contract's own.
    expect(eventsOfType(eventsOf(g, settle2), "REPUTATION_CHANGED")).toEqual([]);
    expect(eventsOf(g, tx2)).toMatchObject([repChange(r2, clamp(r2 + RULES.installmentMissed), "INSTALLMENT_MISSED", null, id)]);
    expect(s.family).toMatchObject({ reputation: clamp(r2 + RULES.installmentMissed), consecutiveFulfilledInstallments: 0 });
  });

  it("PARTIAL and MISSED apply their penalties and reset the streak; a FULFILLED after a reset gets no bonus", () => {
    const start0 = 50;
    const { g, ids } = settlingGame([{ buyerId: KESSLERS_BACK_ROOM, outcomes: ["PARTIAL", "MISSED", "FULFILLED"] }], {
      family: { reputation: start0, consecutiveFulfilledInstallments: 3 },
    });
    const [id] = ids as [ContractId];
    const [d0, d1, d2] = deadlinesFrom(1) as [number, number, number];

    to(g, d0);
    const a = clamp(start0 + RULES.installmentPartial);
    const tx0 = oneTx(g.sim.state, installmentKey(id, 0));
    expectProgressionTx(tx0, d0);
    expect(eventsOf(g, tx0)).toMatchObject([repChange(start0, a, "INSTALLMENT_PARTIAL", null, id)]);
    expect(g.sim.state.family).toMatchObject({ reputation: a, consecutiveFulfilledInstallments: 0 });

    to(g, d1);
    const b = clamp(a + RULES.installmentMissed);
    const tx1 = oneTx(g.sim.state, installmentKey(id, 1));
    expectProgressionTx(tx1, d1);
    expect(eventsOf(g, tx1)).toMatchObject([repChange(a, b, "INSTALLMENT_MISSED", null, id)]);
    expect(g.sim.state.family).toMatchObject({ reputation: b, consecutiveFulfilledInstallments: 0 });

    to(g, d2);
    const c = clamp(b + RULES.installmentFulfilled);
    const tx2 = oneTx(g.sim.state, installmentKey(id, 2));
    expectProgressionTx(tx2, d2);
    expect(eventsOf(g, tx2)).toMatchObject([repChange(b, c, "INSTALLMENT_FULFILLED", null, id)]);
    expect(eventsOf(g, tx2)).toHaveLength(1);
    expect(g.sim.state.family).toMatchObject({ reputation: c, consecutiveFulfilledInstallments: 1 });
  });

  it("applies several settlements on one tick in event order, after every settlement, with the streak carried across contracts", () => {
    const start0 = 20;
    const { g, ids } = settlingGame(
      [
        { buyerId: KESSLERS_BACK_ROOM, outcomes: ["FULFILLED"] },
        { buyerId: LAKEVIEW_HOTEL, outcomes: ["MISSED"] },
        { buyerId: KESSLERS_BACK_ROOM, outcomes: ["FULFILLED"] },
      ],
      // A streak of 1 left by an earlier contract.
      { family: { reputation: start0, consecutiveFulfilledInstallments: 1 } },
    );
    const [a, b, c] = ids as [ContractId, ContractId, ContractId];
    to(g, 1);
    const s = g.sim.state;

    // Settlements in contract ID order, then the progression transactions in the same order.
    const order = [settlementKey(a, 0), settlementKey(b, 0), settlementKey(c, 0), installmentKey(a, 0), installmentKey(b, 0), installmentKey(c, 0)].map((k) =>
      indexOfKey(s, k),
    );
    expect(order).toEqual([...order].sort((x, y) => x - y));
    const settledIds = eventsOfType(g.events, "INSTALLMENT_SETTLED").map((e) => e.contractId);
    expect(settledIds).toEqual([a, b, c]);

    const F = RULES.installmentFulfilled;
    const B = RULES.consecutiveInstallmentBonus;
    const r1 = clamp(start0 + F);
    const r2 = clamp(r1 + B); // the streak is now 2, counting the earlier contract
    const r3 = clamp(r2 + RULES.installmentMissed); // resets the streak
    const r4 = clamp(r3 + F); // streak 1 again: no bonus
    for (const k of [installmentKey(a, 0), installmentKey(b, 0), installmentKey(c, 0)]) expectProgressionTx(oneTx(s, k), 1);
    expect(eventsOf(g, oneTx(s, installmentKey(a, 0)))).toMatchObject([
      repChange(start0, r1, "INSTALLMENT_FULFILLED", null, a),
      repChange(r1, r2, "CONSECUTIVE_INSTALLMENT", null, a),
    ]);
    expect(eventsOf(g, oneTx(s, installmentKey(b, 0)))).toMatchObject([repChange(r2, r3, "INSTALLMENT_MISSED", null, b)]);
    expect(eventsOf(g, oneTx(s, installmentKey(c, 0)))).toMatchObject([repChange(r3, r4, "INSTALLMENT_FULFILLED", null, c)]);
    expect(eventsOf(g, oneTx(s, installmentKey(c, 0)))).toHaveLength(1);
    expect(s.family).toMatchObject({ reputation: r4, consecutiveFulfilledInstallments: 1 });
    // The journal holds the changes in the same order.
    expect(eventsOfType(g.events, "REPUTATION_CHANGED").map((e) => [e.contractId, e.reason])).toEqual([
      [a, "INSTALLMENT_FULFILLED"],
      [a, "CONSECUTIVE_INSTALLMENT"],
      [b, "INSTALLMENT_MISSED"],
      [c, "INSTALLMENT_FULFILLED"],
    ]);
  });
});

// ===========================================================================
// Clamping and recording (decision 5)
// ===========================================================================

describe("PROG-001 reputation: clamping and recording", () => {
  it("clamps at 0: a penalty larger than the reputation lands on 0", () => {
    const from = Math.max(1, -RULES.installmentMissed - 1);
    expect(from + RULES.installmentMissed).toBeLessThan(0);
    const { g, ids } = settlingGame([{ buyerId: KESSLERS_BACK_ROOM, outcomes: ["MISSED"] }], { family: { reputation: from } });
    to(g, 1);
    const tx = oneTx(g.sim.state, installmentKey(ids[0]!, 0));
    expectProgressionTx(tx, 1);
    expect(eventsOf(g, tx)).toMatchObject([repChange(from, 0, "INSTALLMENT_MISSED", null, ids[0]!)]);
    expect(g.sim.state.family.reputation).toBe(0);
  });

  it("clamps at 100, and emits REPUTATION_CHANGED only when the value moves (a bonus at 100 emits nothing)", () => {
    const { g, ids } = settlingGame([{ buyerId: KESSLERS_BACK_ROOM, outcomes: ["FULFILLED"] }], {
      family: { reputation: 99, consecutiveFulfilledInstallments: 1 },
    });
    to(g, 1);
    const tx = oneTx(g.sim.state, installmentKey(ids[0]!, 0));
    expectProgressionTx(tx, 1);
    expect(eventsOf(g, tx)).toMatchObject([repChange(99, 100, "INSTALLMENT_FULFILLED", null, ids[0]!)]);
    expect(eventsOf(g, tx)).toHaveLength(1);
    expect(g.sim.state.family).toMatchObject({ reputation: 100, consecutiveFulfilledInstallments: 2 });
  });

  it("commits nothing when nothing changes: a MISSED installment at reputation 0 with no streak", () => {
    const { g, ids } = settlingGame([{ buyerId: KESSLERS_BACK_ROOM, outcomes: ["MISSED"] }]);
    to(g, 1);
    expect(oneTx(g.sim.state, settlementKey(ids[0]!, 0))).toBeDefined();
    expect(keyed(g.sim.state, installmentKey(ids[0]!, 0))).toEqual([]);
    expect(progressionTxs(g.sim.state)).toEqual([]);
    expect(eventsOfType(g.events, "REPUTATION_CHANGED")).toEqual([]);
    expect(g.sim.state.family).toMatchObject({ reputation: 0, consecutiveFulfilledInstallments: 0 });
  });

  it("commits with no event when only the streak changes (MISSED at 0 with a streak; FULFILLED at 100)", () => {
    const missed = settlingGame([{ buyerId: KESSLERS_BACK_ROOM, outcomes: ["MISSED"] }], { family: { consecutiveFulfilledInstallments: 2 } });
    to(missed.g, 1);
    const m = oneTx(missed.g.sim.state, installmentKey(missed.ids[0]!, 0));
    expectProgressionTx(m, 1);
    expect(m.eventIds).toEqual([]);
    expect(missed.g.sim.state.family).toMatchObject({ reputation: 0, consecutiveFulfilledInstallments: 0 });

    const full = settlingGame([{ buyerId: KESSLERS_BACK_ROOM, outcomes: ["FULFILLED"] }], { family: { reputation: 100 } });
    to(full.g, 1);
    const f = oneTx(full.g.sim.state, installmentKey(full.ids[0]!, 0));
    expectProgressionTx(f, 1);
    expect(f.eventIds).toEqual([]);
    expect(full.g.sim.state.family).toMatchObject({ reputation: 100, consecutiveFulfilledInstallments: 1 });
    expect(eventsOfType(full.g.events, "REPUTATION_CHANGED")).toEqual([]);
  });

  it("commits PROGRESSION:FIRST_DELIVERY with no event when only the flag changes (reputation already 100)", () => {
    const g = start();
    edit(g, (s) => withFamily(withStock(s, RULES.qualifyingDeliveryMinimumCases), { reputation: 100 }));
    const d = spotSale(g, RULES.qualifyingDeliveryMinimumCases);
    const tx = oneTx(g.sim.state, FIRST_DELIVERY_KEY);
    expectProgressionTx(tx, d.arrival);
    expect(tx.eventIds).toEqual([]);
    expect(g.sim.state.family).toMatchObject({ reputation: 100, firstQualifyingDeliveryMade: true });
    expect(eventsOfType(g.events, "REPUTATION_CHANGED")).toEqual([]);
  });
});

// ===========================================================================
// Tier promotion (decision 4)
// ===========================================================================

describe("PROG-001 tiers: promotion", () => {
  it("the starting tier emits nothing, and reputation 0 reaches no tier", () => {
    const g = start();
    to(g, 2 * DAY + 1);
    const s = g.sim.state;
    expect(s.family.tierId).toBe(FIRST_SHIPMENT_SCENARIO.family.tierId);
    expect(s.family.unlocked).toEqual(FIRST_SHIPMENT_SCENARIO.family.unlocked);
    expect(progressionTxs(s)).toEqual([]);
    expect(eventsOfType(g.events, "TIER_REACHED")).toEqual([]);
    expect(eventsOfType(g.events, "UNLOCK_GRANTED")).toEqual([]);
  });

  it("promotes through several tiers on one tick in ascending order: PROGRESSION:TIER:<tierId>, TIER_REACHED, then UNLOCK_GRANTED per new unlock", () => {
    const target = tierAt(2);
    const g = start();
    edit(g, (s) => withFamily(withNetWorthAtLeast(s, worthOf(target)), { reputation: repOf(target) }));
    const startIndex = tierIndex(g.sim.state.family.tierId);
    const expected = ladder(startIndex, repOf(target), netWorthOf(g.sim.state));
    expect(expected.length).toBeGreaterThanOrEqual(2);
    expect(expected).toContain(target);
    const unlockedBefore = g.sim.state.family.unlocked;

    to(g, 1);
    const s = g.sim.state;
    expect(progressionKeys(s)).toEqual(expected.map((t) => tierKey(t.id)));
    const held = new Set<UnlockId>(unlockedBefore);
    for (const t of expected) {
      const tx = oneTx(s, tierKey(t.id));
      expectProgressionTx(tx, 1);
      const fresh = t.unlocks.filter((u) => !held.has(u));
      for (const u of fresh) held.add(u);
      expect(eventsOf(g, tx)).toMatchObject([
        { type: "TIER_REACHED", tierId: t.id, tick: 1 },
        ...fresh.map((unlockId) => ({ type: "UNLOCK_GRANTED", unlockId, tick: 1 })),
      ]);
      expect(eventsOf(g, tx)).toHaveLength(1 + fresh.length);
    }
    const last = expected.at(-1)!;
    expect(s.family.tierId).toBe(last.id);
    expect(s.family.unlocked).toEqual([...held].sort(compareIds));

    const snap = g.sim.snapshot().progression;
    expect(snap.currentTierId).toBe(last.id);
    expect(snap.unlocked).toEqual([...held].sort(compareIds));
    expect(snap.tiers.map((t) => t.reached)).toEqual(TIERS.map((_, i) => i <= tierIndex(last.id)));

    // Keyed once: nothing more on later ticks.
    to(g, 10);
    expect(progressionKeys(g.sim.state)).toEqual(expected.map((t) => tierKey(t.id)));
  });

  it("never revokes a tier or an unlock when net worth or reputation falls", () => {
    const target = tierAt(2);
    const g = start();
    edit(g, (s) => withFamily(withNetWorthAtLeast(s, worthOf(target)), { reputation: repOf(target) }));
    to(g, 1);
    const reached = g.sim.state.family;
    expect(tierIndex(reached.tierId)).toBeGreaterThanOrEqual(2);
    const keys = progressionKeys(g.sim.state);
    const tierEvents = eventsOfType(g.events, "TIER_REACHED").length;

    edit(g, (s) => withFamily(withoutCash(s), { reputation: 0 }));
    expect(netWorthOf(g.sim.state)).toBeLessThan(worthOf(target));
    to(g, 2 * DAY + 1);
    const s = g.sim.state;
    expect(s.family.tierId).toBe(reached.tierId);
    expect(s.family.unlocked).toEqual(reached.unlocked);
    expect(progressionKeys(s).filter((k) => k.startsWith("PROGRESSION:TIER:"))).toEqual(keys);
    expect(eventsOfType(g.events, "TIER_REACHED")).toHaveLength(tierEvents);
  });

  it("needs both thresholds, and the tier below: no tier is skipped", () => {
    // Reputation one short of tier 2, with plenty of net worth.
    const second = tierAt(1);
    const shortRep = start();
    edit(shortRep, (s) => withFamily(withNetWorthAtLeast(s, worthOf(tierAt(TIERS.length - 1))), { reputation: repOf(second) - 1 }));
    to(shortRep, 2);
    expect(shortRep.sim.state.family.tierId).toBe(tierAt(0).id);
    expect(progressionTxs(shortRep.sim.state)).toEqual([]);

    // Tier 2's net worth is out of reach; every higher tier's thresholds are met, but none is reached.
    const data = withTier(1, { netWorthRequired: cents(1_000_000_000) });
    const blocked: Game = { sim: newGame({ data }), setup: { data }, events: [] };
    edit(blocked, (s) => withFamily(withNetWorthAtLeast(s, worthOf(tierAt(TIERS.length - 1))), { reputation: 100 }));
    expect(netWorthOf(blocked.sim.state)).toBeLessThan(1_000_000_000);
    to(blocked, 2);
    expect(blocked.sim.state.family.tierId).toBe(tierAt(0).id);
    expect(blocked.sim.state.family.unlocked).toEqual(FIRST_SHIPMENT_SCENARIO.family.unlocked);
    expect(progressionTxs(blocked.sim.state).filter((t) => t.idempotencyKey.startsWith("PROGRESSION:TIER:"))).toEqual([]);
  });

  it("is evaluated in the deadlines phase after contracts: an installment that crosses the threshold promotes on its own tick", () => {
    const second = tierAt(1);
    const from = repOf(second) - RULES.installmentFulfilled;
    expect(from).toBeGreaterThanOrEqual(0);
    const at = 5;
    const { g, ids } = settlingGame([{ buyerId: KESSLERS_BACK_ROOM, outcomes: ["FULFILLED"] }], { first: at, family: { reputation: from } });
    edit(g, (s) => withNetWorthAtLeast(s, worthOf(second)));
    to(g, at - 1);
    expect(g.sim.state.family.tierId).toBe(tierAt(0).id);
    expect(progressionTxs(g.sim.state)).toEqual([]);

    to(g, at);
    const s = g.sim.state;
    expect(s.family.tierId).toBe(second.id);
    const tierTx = oneTx(s, tierKey(second.id));
    expectProgressionTx(tierTx, at);
    expect(indexOfKey(s, settlementKey(ids[0]!, 0))).toBeLessThan(indexOfKey(s, installmentKey(ids[0]!, 0)));
    expect(indexOfKey(s, installmentKey(ids[0]!, 0))).toBeLessThan(indexOfKey(s, tierKey(second.id)));
  });

  it("a sale that crosses the threshold (vehicles phase) promotes on the sale's tick, after PROGRESSION:FIRST_DELIVERY", () => {
    const second = tierAt(1);
    const from = repOf(second) - RULES.firstQualifyingDelivery;
    expect(from).toBeGreaterThanOrEqual(0);
    const g = start();
    edit(g, (s) => withFamily(withNetWorthAtLeast(withStock(s, RULES.qualifyingDeliveryMinimumCases), worthOf(second)), { reputation: from }));
    const d = dispatchSpot(g, RULES.qualifyingDeliveryMinimumCases);
    to(g, d.arrival - 1);
    expect(g.sim.state.family.tierId).toBe(tierAt(0).id);
    to(g, d.arrival);
    const s = g.sim.state;
    expect(s.family.tierId).toBe(second.id);
    expectProgressionTx(oneTx(s, tierKey(second.id)), d.arrival);
    expect(indexOfKey(s, idempotencyKey("SALE", d.deliveryId))).toBeLessThan(indexOfKey(s, FIRST_DELIVERY_KEY));
    expect(indexOfKey(s, FIRST_DELIVERY_KEY)).toBeLessThan(indexOfKey(s, tierKey(second.id)));
  });

  it("grants unlocks in the tier's listed order, skips ones already held, and keeps family.unlocked sorted with compareIds", () => {
    // Fixture unlock IDs shaped like simulation-created IDs, where compareIds
    // (numeric suffix) and a plain string sort disagree: res-9 before res-10.
    const ten = asId("Unlock", "res-10");
    const nine = asId("Unlock", "res-9");
    const listed: readonly UnlockId[] = [ten, SPOT_SALES, nine, ...tierAt(1).unlocks];
    const data = withTier(1, { unlocks: listed });
    const g: Game = { sim: newGame({ data }), setup: { data }, events: [] };
    edit(g, (s) => withFamily(withNetWorthAtLeast(s, worthOf(tierAt(1))), { reputation: repOf(tierAt(1)) }));
    expect(ladder(0, repOf(tierAt(1)), netWorthOf(g.sim.state), data.progression.tiers).map((t) => t.id)).toEqual([tierAt(1).id]);
    expect(g.sim.state.family.unlocked).toContain(SPOT_SALES);

    to(g, 1);
    const s = g.sim.state;
    const tx = oneTx(s, tierKey(tierAt(1).id));
    const fresh = listed.filter((u) => !FIRST_SHIPMENT_SCENARIO.family.unlocked.includes(u));
    expect(eventsOfType(eventsOf(g, tx), "UNLOCK_GRANTED").map((e) => e.unlockId)).toEqual(fresh);
    const all = [...new Set<UnlockId>([...FIRST_SHIPMENT_SCENARIO.family.unlocked, ...listed])];
    expect(s.family.unlocked).toEqual([...all].sort(compareIds));
    expect(s.family.unlocked.indexOf(nine)).toBeLessThan(s.family.unlocked.indexOf(ten));
    expect(g.sim.snapshot().progression.unlocked).toEqual([...all].sort(compareIds));
  });
});

// ===========================================================================
// Gating (decision 3)
// ===========================================================================

describe("PROG-001 tiers: equipment gating", () => {
  it("pins the gates: the condenser and storage expansion need capacity-equipment, the QC station quality-equipment", () => {
    const item = (id: EquipmentId) => GAME_DATA.equipment.find((e) => e.id === id)!;
    expect(item(IMPROVED_CONDENSER).requiredUnlockId).toBe(CAPACITY_EQUIPMENT);
    expect(item(STORAGE_EXPANSION).requiredUnlockId).toBe(CAPACITY_EQUIPMENT);
    expect(item(QC_STATION).requiredUnlockId).toBe(QUALITY_EQUIPMENT);
    expect(tierAt(1).id).toBe(TRUSTED_SUPPLIER);
    expect(tierAt(1).unlocks).toContain(CAPACITY_EQUIPMENT);
    expect(tierAt(2).id).toBe(ESTABLISHED_PRODUCER);
    expect(tierAt(2).unlocks).toContain(QUALITY_EQUIPMENT);
  });

  it("PURCHASE_EQUIPMENT is LOCKED for the condenser and storage expansion until tier 2, and for the QC station until tier 3; blockedBy shows it", () => {
    const g = start();
    // Cash for every item, and net worth for tier 3, booked at tick 0 (a fixture
    // moving cash later would be a cash flow the finance projection can't file).
    const total = GAME_DATA.equipment.reduce((n, e) => n + e.price, 0);
    edit(g, (s) => withNetWorthAtLeast(withExtraCash(s, total), worthOf(tierAt(2))));
    const capacity: RejectionReason = { code: "LOCKED", unlockId: CAPACITY_EQUIPMENT };
    const quality: RejectionReason = { code: "LOCKED", unlockId: QUALITY_EQUIPMENT };

    // Tier 1.
    to(g, 1);
    expect(g.sim.state.family.tierId).toBe(tierAt(0).id);
    expect(equipmentOption(g, IMPROVED_CONDENSER).blockedBy).toEqual(capacity);
    expect(equipmentOption(g, STORAGE_EXPANSION).blockedBy).toEqual(capacity);
    expect(equipmentOption(g, QC_STATION).blockedBy).toEqual(quality);
    expectRejected(g, buyEquipment(IMPROVED_CONDENSER), capacity);
    expectRejected(g, buyEquipment(STORAGE_EXPANSION), capacity);
    expectRejected(g, buyEquipment(QC_STATION), quality);

    // Tier 2, reached by the progression system.
    edit(g, (s) => withFamily(s, { reputation: repOf(tierAt(1)) }));
    expect(ladder(0, repOf(tierAt(1)), netWorthOf(g.sim.state)).map((t) => t.id)).toEqual([TRUSTED_SUPPLIER]);
    to(g, 2);
    expect(g.sim.state.family.tierId).toBe(TRUSTED_SUPPLIER);
    expect(equipmentOption(g, IMPROVED_CONDENSER).blockedBy).toBeNull();
    expect(equipmentOption(g, STORAGE_EXPANSION).blockedBy).toBeNull();
    expect(equipmentOption(g, QC_STATION).blockedBy).toEqual(quality);
    expectRejected(g, buyEquipment(QC_STATION), quality);
    expectApplied(run(g, buyEquipment(IMPROVED_CONDENSER)));
    expectApplied(run(g, buyEquipment(STORAGE_EXPANSION)));

    // Tier 3.
    expect(netWorthOf(g.sim.state)).toBeGreaterThanOrEqual(worthOf(tierAt(2)));
    edit(g, (s) => withFamily(s, { reputation: repOf(tierAt(2)) }));
    to(g, 3);
    expect(g.sim.state.family.tierId).toBe(ESTABLISHED_PRODUCER);
    expect(equipmentOption(g, QC_STATION).blockedBy).toBeNull();
    expectApplied(run(g, buyEquipment(QC_STATION)));
  });
});

// ===========================================================================
// The unlock graph (decision 6): a static test over GAME_DATA only
// ===========================================================================

describe("PROG-001 tiers: the unlock graph is acyclic and reachable (GAME_DATA)", () => {
  it("has unique tier IDs, a first tier with null thresholds, and non-decreasing thresholds", () => {
    expect(new Set(TIERS.map((t) => t.id)).size).toBe(TIERS.length);
    expect(tierAt(0)).toMatchObject({ netWorthRequired: null, reputationRequired: null });
    for (let k = 1; k < TIERS.length; k++) {
      expect(worthOf(tierAt(k)), tierAt(k).id).toBeGreaterThanOrEqual(worthOf(tierAt(k - 1)));
      expect(repOf(tierAt(k)), tierAt(k).id).toBeGreaterThanOrEqual(repOf(tierAt(k - 1)));
      expect(tierAt(k).reputationRequired === null || (tierAt(k).reputationRequired! >= 0 && tierAt(k).reputationRequired! <= 100)).toBe(true);
    }
    expect(FIRST_SHIPMENT_SCENARIO.family.tierId).toBe(tierAt(0).id);
  });

  it("grants every unlock from exactly one tier", () => {
    const granted = TIERS.flatMap((t) => t.unlocks);
    expect(new Set(granted).size).toBe(granted.length);
  });

  it("grants every requiredUnlockId in game-data (equipment, contract terms) from some tier", () => {
    const granted = new Set<UnlockId>(TIERS.flatMap((t) => t.unlocks));
    const required = [...GAME_DATA.equipment.map((e) => e.requiredUnlockId), TERMS.requiredUnlockId].filter((u): u is UnlockId => u !== null);
    for (const u of required) expect(granted.has(u), u).toBe(true);
  });

  it("makes each tier's reputation reachable with only what the tiers below it grant", () => {
    const startRep = FIRST_SHIPMENT_SCENARIO.family.reputation;
    for (let k = 1; k < TIERS.length; k++) {
      const below = new Set<UnlockId>(TIERS.slice(0, k).flatMap((t) => t.unlocks));
      const open = (u: UnlockId | null) => u === null || below.has(u);
      const equipmentOpen = (id: EquipmentId) => {
        const e = GAME_DATA.equipment.find((x) => x.id === id);
        return e !== undefined && open(e.requiredUnlockId);
      };
      const reachable =
        open(TERMS.requiredUnlockId) &&
        GAME_DATA.contracts.buyers.some((cb) => {
          const buyer = GAME_DATA.buyers.find((b) => b.id === cb.buyerId);
          if (!buyer || buyer.minimumReputation > startRep) return false;
          return GAME_DATA.recipes.some(
            (r) => r.productId === cb.productId && qualityRank(r.quality) >= qualityRank(cb.minimumQuality) && r.requiredEquipmentIds.every(equipmentOpen),
          );
        });
      expect(reachable, `tier ${tierAt(k).id}`).toBe(true);
    }
  });
});

// ===========================================================================
// The reputation schedule (decision 2)
// ===========================================================================

describe("PROG-001 reputation: the decision 2 schedule", () => {
  it("fulfilling Kessler's first contract reaches first + 3 × fulfilled + 2 × bonus (22 today) and the matching tier by the last settlement", () => {
    const q = contractBuyer(KESSLERS_BACK_ROOM).quantityPerInstallment;
    expect(q).toBeGreaterThanOrEqual(RULES.qualifyingDeliveryMinimumCases);
    const g = start();
    // Fixture stock, and enough cash that payroll can't pull net worth under tier 3's threshold.
    edit(g, (s) => withExtraCash(withStock(s, 3 * q), worthOf(tierAt(2))));
    to(g, DAY);
    const offer = g.sim.state.contractOffers.find((o) => o.buyerId === KESSLERS_BACK_ROOM);
    if (!offer) throw new Error("No offer from Kessler's at the first midnight");
    expectApplied(run(g, { type: "ACCEPT_CONTRACT", contractOfferId: offer.id }));
    const contract = g.sim.state.contracts.find((c) => c.offerId === offer.id)!;
    const deadlines = contract.installments.map((i) => i.deadline);
    expect(deadlines).toHaveLength(3);
    const duration = routeTo(KESSLERS_BACK_ROOM).durationTicks;

    const deliveryIds: string[] = [];
    for (const deadline of deadlines) {
      const arrival = deadline - 30;
      to(g, arrival - duration - 1);
      expect(truck(g.sim.state).trip).toBeNull();
      expectApplied(
        run(g, {
          type: "DISPATCH_DELIVERY",
          vehicleId: MODEL_TT_TRUCK,
          cargo: [{ productId: MOONSHINE, quality: "basic", quantity: q }],
          purpose: { kind: "CONTRACT_INSTALLMENT", contractId: contract.id },
          routeId: null,
          driver: { kind: "FOUNDER" },
        }),
      );
      deliveryIds.push(g.sim.state.deliveries.at(-1)!.id);
      expect(truck(g.sim.state).trip!.arrivesAt).toBe(arrival);
      to(g, deadline);
    }

    const s = g.sim.state;
    expect(s.contracts.find((c) => c.id === contract.id)!.installments.map((i) => i.outcome)).toEqual(["FULFILLED", "FULFILLED", "FULFILLED"]);
    const F = RULES.installmentFulfilled;
    const B = RULES.consecutiveInstallmentBonus;
    const expected = [RULES.firstQualifyingDelivery, F, F, B, F, B].reduce((r, d) => clamp(r + d), 0);
    expect(s.family.reputation).toBe(expected);
    expect(s.family).toMatchObject({ firstQualifyingDeliveryMade: true, consecutiveFulfilledInstallments: 3 });
    expect(netWorthOf(s)).toBeGreaterThanOrEqual(worthOf(tierAt(2)));

    const changes = eventsOfType(g.events, "REPUTATION_CHANGED");
    expect(changes.map((e) => e.reason)).toEqual([
      "FIRST_QUALIFYING_DELIVERY",
      "INSTALLMENT_FULFILLED",
      "INSTALLMENT_FULFILLED",
      "CONSECUTIVE_INSTALLMENT",
      "INSTALLMENT_FULFILLED",
      "CONSECUTIVE_INSTALLMENT",
    ]);
    // The first delivery qualifies as a contract delivery: it carries both IDs.
    expect(changes[0]).toMatchObject({ deliveryId: deliveryIds[0], contractId: contract.id });
    expect(changes.slice(1).every((e) => e.deliveryId === null && e.contractId === contract.id)).toBe(true);

    // Tiers are reached as reputation climbs, so with net worth held above every
    // threshold met, the tier is what the rule gives at the final reputation.
    const reached = ladder(0, expected, netWorthOf(s));
    const tier = reached.at(-1) ?? tierAt(0);
    expect(s.family.tierId).toBe(tier.id);
    expect(eventsOfType(g.events, "TIER_REACHED").map((e) => e.tierId)).toEqual(reached.map((t) => t.id));
  });
});
