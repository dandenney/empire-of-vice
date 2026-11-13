// @locked
// ECO-001 acceptance tests for T02e (issue #9): recurring contracts. Covers the
// contract data defaults, offers (midnight generator, CONTRACT_OFFER world-event
// handler, eligibility, expiry, midnight-tick rules, same-midnight re-offer),
// ACCEPT_CONTRACT (rejection order, locked price, deadlines, reservations with
// shortfalls, no buyer budget or demand used), DISPATCH_DELIVERY for an
// installment (rejection order, `takeForContract` draws, contract reservations
// not sellable as spot cargo), arrival crediting (a deadline-exact arrival is on
// time), settlement (outcomes, ADR 0002 penalty rounding, pay-or-accrue, exactly
// once across save/load, COMPLETED only after the last installment, CONTRACT_ENDED
// releases), penalty paydown at midnight after payroll, cash never negative, the
// reputation-relevant events, no RNG use, the Sprint Zero hash, and rule 6.
// Rules come from ADR 0018 (decisions 1–13) and the pinned notes on issue #9.
//
// Written ahead of the implementation by a separate test-writer agent
// (factory.md §2, §7.3). Do not edit (CLAUDE.md rule 9).
//
// Imports are limited to the public package entry `src/index.ts`, the inventory
// module `src/inventory/index.ts` (`addProduct`, `addReservation`, for fixtures),
// and `@eov/contracts` and `@eov/game-data`. The contracts system is driven only
// through the Simulation (commands, ticks, world events, snapshots), so this file
// typechecks on main and fails at runtime until T02e lands. No new simulation
// export is assumed.
//
// @eov/game-data, read by property through a loose cast (ADR 0018 decision 1).
// The test-writer pins this shape:
//   `GameData.contracts: {
//      terms: { installmentCount: number, intervalTicks: number, priceRatio: Ratio,
//               penaltyRatePpm: number, firstDeadlineOffsetTicks: number,
//               requiredUnlockId: UnlockId | null },
//      buyers: readonly { buyerId: BuyerId, productId: ProductId,
//                         minimumQuality: QualityTier, quantityPerInstallment: number }[] }`
//   exported from a new `contracts.ts`. The reader also accepts the shared terms
//   flattened onto `contracts` itself (no `terms` object) and `buyers` as a record
//   keyed by BuyerId (each value without `buyerId`). Patched fixture data (an
//   unlock requirement) writes back in whichever shape it found.
//
// Pinned literals: the GDD §7 / ADR 0018 defaults in the data test (3, 2 880,
// 950 000, 200 000, 3 960, null; Kessler's basic × 8, Lakeview standard × 6; the
// roadhouse offers none) and the ADR 0002 rounding examples (fixture prices).
// The Sprint Zero hash test checks the shared reference hash `SPRINT_ZERO_HASH`
// from `../sprint-zero/reference-hash.ts`. Everything else is derived from
// game-data, state, and the ADR 0018 formulas.
//
// Fixtures. Finished stock, cash, and a penalty payable are booked through a
// coordinator transaction (kind OPENING_BALANCE, keys `OPENING_BALANCE:fixture:<n>`)
// so the ledger matches inventory. Some tests inject a `ContractState` directly
// (fixture contracts; offer IDs and contract IDs allocated from the counters), add a
// second truck by patching game-data and the scenario, or schedule a CONTRACT_OFFER
// world event with `scheduleWorldEvent`. Fixture contracts always use a contract
// buyer (Kessler's or Lakeview).
//
// Midnight (#63, T02c2, in flight): production's midnight hook will pay wages and
// overhead (`DAILY_SETTLEMENT:WAGES|OVERHEAD|PAYROLL:<day>`). These tests never
// pin absolute cash across a midnight: penalty and paydown amounts are checked
// against the cash and payable balances on the ledger just before their own
// transaction, and ordering is checked by transaction key position. They hold
// before and after #63 lands.
//
// Expected to fail on main until T02e lands: there's no `GameData.contracts`, no
// offers, no ACCEPT_CONTRACT or CONTRACT_OFFER handler, and contract dispatch is
// stubbed. The Sprint Zero hash test passes on main.

import {
  applyRatios,
  asId,
  cents,
  compareById,
  compareIds,
  dayIndex,
  idempotencyKey,
  multiplyMoney,
  qualityRank,
  ratio,
  tick,
  TICKS_PER_DAY,
  type BuyerId,
  type CargoLine,
  type CommandResult,
  type ContractId,
  type ContractOfferState,
  type ContractState,
  type FacilityId,
  type GameCommand,
  type GameEvent,
  type GameState,
  type InstallmentOutcome,
  type LedgerEntry,
  type LedgerTransaction,
  type Money,
  type ProductId,
  type QualityTier,
  type Ratio,
  type ReservationId,
  type UnlockId,
  type VehicleId,
} from "@eov/contracts";
import {
  BASIC_MOONSHINE_RECIPE,
  CROSSROADS_ROADHOUSE,
  DISTILLERY_MAIN,
  FIRST_SHIPMENT_SCENARIO,
  GAME_DATA,
  KESSLERS_BACK_ROOM,
  LAKEVIEW_HOTEL,
  MILLERS_FEED,
  MODEL_TT_TRUCK,
  MOONSHINE,
  STATE_HIGHWAY,
  WHISKEY,
  type GameData,
  type RouteDefinition,
  type ScenarioDefinition,
} from "@eov/game-data";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addProduct, addReservation } from "../../src/inventory/index.ts";
import {
  accountBalances,
  allocateId,
  createCoordinator,
  createSimulation,
  hashState,
  loadGame,
  newGame,
  payDownEntries,
  payOrAccrueEntries,
  saleEntries,
  scheduleWorldEvent,
  simulationOptions,
  type GameSetup,
  type KernelSimulation,
} from "../../src/index.ts";
import { SPRINT_ZERO_HASH } from "../sprint-zero/reference-hash.ts";

// ---------------------------------------------------------------------------
// Contract data (loose reads; see the header for the assumed shape)
// ---------------------------------------------------------------------------

const DAY = TICKS_PER_DAY;

type Loose = Record<string, unknown>;

interface Terms {
  readonly installmentCount: number;
  readonly intervalTicks: number;
  readonly priceRatio: Ratio;
  readonly penaltyRatePpm: number;
  readonly firstDeadlineOffsetTicks: number;
  readonly requiredUnlockId: UnlockId | null;
}

interface ContractBuyer {
  readonly buyerId: BuyerId;
  readonly productId: ProductId;
  readonly minimumQuality: QualityTier;
  readonly quantityPerInstallment: number;
}

function contractsData(data: GameData = GAME_DATA): Loose {
  const c = (data as unknown as Loose)["contracts"];
  if (typeof c !== "object" || c === null) {
    throw new Error("GameData.contracts is missing (packages/game-data/src/contracts.ts, ADR 0018 decision 1)");
  }
  return c as Loose;
}

function termsHolder(c: Loose): Loose {
  const t = c["terms"];
  return typeof t === "object" && t !== null ? (t as Loose) : c;
}

function terms(data: GameData = GAME_DATA): Terms {
  const t = termsHolder(contractsData(data));
  for (const field of ["installmentCount", "intervalTicks", "priceRatio", "penaltyRatePpm", "firstDeadlineOffsetTicks"]) {
    if (typeof t[field] !== "number") throw new Error(`GameData.contracts terms: ${field} must be a number, got ${JSON.stringify(t[field])}`);
  }
  if (!("requiredUnlockId" in t)) throw new Error("GameData.contracts terms: requiredUnlockId is missing");
  return t as unknown as Terms;
}

function contractBuyers(data: GameData = GAME_DATA): readonly ContractBuyer[] {
  const b = contractsData(data)["buyers"];
  if (Array.isArray(b)) return b as ContractBuyer[];
  if (typeof b === "object" && b !== null) {
    return Object.entries(b as Loose).map(([buyerId, v]) => ({ ...(v as object), buyerId }) as ContractBuyer);
  }
  throw new Error("GameData.contracts.buyers is missing");
}

function contractBuyer(buyerId: BuyerId, data: GameData = GAME_DATA): ContractBuyer {
  const found = contractBuyers(data).find((b) => b.buyerId === buyerId);
  if (!found) throw new Error(`No contract definition for ${buyerId}`);
  return found;
}

function patchTerms(patch: Partial<Terms>, data: GameData = GAME_DATA): GameData {
  const c = contractsData(data);
  const t = c["terms"];
  const contracts = typeof t === "object" && t !== null ? { ...c, terms: { ...(t as Loose), ...patch } } : { ...c, ...patch };
  return { ...data, contracts } as unknown as GameData;
}

/** Offer-day timing for an offer made at `offerTick` (ADR 0018 decision 2). */
function offerTiming(offerTick: number, data: GameData = GAME_DATA) {
  const t = terms(data);
  const day = Math.floor(offerTick / DAY);
  const firstDeadline = day * DAY + t.firstDeadlineOffsetTicks;
  const deadlines = Array.from({ length: t.installmentCount }, (_, k) => firstDeadline + k * t.intervalTicks);
  return { firstDeadline, expiresAt: (day + 1) * DAY, deadlines };
}

// ---------------------------------------------------------------------------
// Static lookups
// ---------------------------------------------------------------------------

const truckDef = GAME_DATA.vehicles.find((v) => v.id === MODEL_TT_TRUCK)!;
const home = GAME_DATA.facilities.find((f) => f.id === truckDef.homeFacilityId)!;

function routeTo(buyerId: BuyerId): RouteDefinition {
  const buyer = GAME_DATA.buyers.find((b) => b.id === buyerId)!;
  const route = GAME_DATA.routes.find((r) => r.fromLocationId === home.locationId && r.toLocationId === buyer.locationId);
  if (!route) throw new Error(`No route to ${buyerId}`);
  return route;
}

const buyerName = (id: BuyerId) => GAME_DATA.buyers.find((b) => b.id === id)!.name;
const productName = (id: ProductId) => GAME_DATA.products.find((p) => p.id === id)!.name;

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

function run(g: Game, command: GameCommand, scheduledTick?: number): CommandResult {
  const result = g.sim.dispatch(scheduledTick === undefined ? { command } : { command, scheduledTick: tick(scheduledTick) });
  flush(g);
  return result;
}

function expectApplied(result: CommandResult): void {
  if (result.status !== "applied") throw new Error(`Expected applied, got ${JSON.stringify(result)}`);
}

/** Rejected with `code`; nothing changed and nothing was emitted (rule 6). Returns the reason. */
function expectRejected(g: Game, command: GameCommand, code: string) {
  flush(g);
  const before = g.sim.stateHash();
  const counters = g.sim.state.counters;
  const result = g.sim.dispatch({ command });
  if (result.status !== "rejected") throw new Error(`Expected rejected ${code}, got ${JSON.stringify(result)}`);
  expect(result.reason.code).toBe(code);
  expect(g.sim.stateHash()).toBe(before);
  expect(g.sim.state.counters).toEqual(counters);
  expect(g.sim.takeEvents()).toEqual([]);
  return result.reason;
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
  return state.ledger.transactions.findIndex((t) => t.idempotencyKey === key);
}

/** Account balances from the transactions before `tx` (what the system saw when staging it). */
function balancesBefore(state: GameState, tx: LedgerTransaction) {
  const i = state.ledger.transactions.indexOf(tx);
  if (i < 0) throw new Error(`${tx.id} isn't in the ledger`);
  return accountBalances(state.ledger.transactions.slice(0, i));
}

const sortEntries = (entries: readonly LedgerEntry[]) =>
  [...entries].sort((a, b) => (a.account < b.account ? -1 : a.account > b.account ? 1 : a.side < b.side ? -1 : a.side > b.side ? 1 : a.amount - b.amount));

function expectEntries(actual: readonly LedgerEntry[], expected: readonly LedgerEntry[]): void {
  expect(sortEntries(actual)).toEqual(sortEntries(expected));
}

/** Cash never goes below zero at any point in the ledger (FIN-001, decision 8). */
function expectCashNeverNegative(state: GameState): void {
  let cash = 0;
  for (const t of state.ledger.transactions) {
    for (const e of t.entries) if (e.account === "CASH") cash += e.side === "DEBIT" ? e.amount : -e.amount;
    expect(cash, `cash after ${t.idempotencyKey}`).toBeGreaterThanOrEqual(0);
  }
}

const cashOf = (state: GameState) => accountBalances(state.ledger.transactions).CASH;

/** The ADR 0018 decision 7 penalty: applyRatios(unitPrice × missing, [rate]). */
function penaltyFor(unitPrice: Money, required: number, delivered: number, penaltyRatePpm: number): Money {
  return applyRatios(multiplyMoney(unitPrice, Math.max(0, required - delivered)), [ratio(penaltyRatePpm)]);
}

function outcomeFor(required: number, delivered: number): InstallmentOutcome {
  return delivered >= required ? "FULFILLED" : delivered > 0 ? "PARTIAL" : "MISSED";
}

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

/** Finished moonshine at the distillery, booked against owner equity. */
function withStock(state: GameState, quality: QualityTier, quantity: number, unitCost = 700, productId: ProductId = MOONSHINE): GameState {
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

/** Moves cash to or from owner equity so the cash balance is `target`. */
function withCash(state: GameState, target: number): GameState {
  const cash = cashOf(state);
  if (cash === target) return state;
  const amount = cents(Math.abs(cash - target));
  return cash > target
    ? fixtureTx(state, [
        { account: "OWNER_EQUITY", side: "DEBIT", amount },
        { account: "CASH", side: "CREDIT", amount },
      ])
    : fixtureTx(state, [
        { account: "CASH", side: "DEBIT", amount },
        { account: "OWNER_EQUITY", side: "CREDIT", amount },
      ]);
}

/** An unpaid penalty already owed (Dr PENALTY_EXPENSE / Cr PENALTIES_PAYABLE). */
function withPenaltiesPayable(state: GameState, amount: number): GameState {
  return fixtureTx(state, [
    { account: "PENALTY_EXPENSE", side: "DEBIT", amount: cents(amount) },
    { account: "PENALTIES_PAYABLE", side: "CREDIT", amount: cents(amount) },
  ]);
}

interface FixtureContractSpec {
  readonly buyerId: BuyerId;
  readonly unitPrice: number;
  readonly deadlines: readonly number[];
  readonly productId?: ProductId;
  readonly minimumQuality?: QualityTier;
  readonly quantityPerInstallment?: number;
  readonly penaltyRatePpm?: number;
  readonly delivered?: readonly number[];
  readonly outcomes?: readonly (InstallmentOutcome | null)[];
  readonly status?: ContractState["status"];
  readonly reservationIds?: readonly ReservationId[];
}

/** Injects a ContractState (a contract as a loaded save would hold it). */
function withContract(state: GameState, spec: FixtureContractSpec): { readonly state: GameState; readonly contractId: ContractId } {
  const t = terms();
  const def = contractBuyer(spec.buyerId);
  const offer = allocateId(state, "ContractOffer");
  const contract = allocateId(offer.state, "Contract");
  const required = spec.quantityPerInstallment ?? def.quantityPerInstallment;
  const unitPrice = cents(spec.unitPrice);
  const penaltyRatePpm = spec.penaltyRatePpm ?? t.penaltyRatePpm;
  const value: ContractState = {
    id: contract.id,
    offerId: offer.id,
    buyerId: spec.buyerId,
    productId: spec.productId ?? def.productId,
    minimumQuality: spec.minimumQuality ?? def.minimumQuality,
    quantityPerInstallment: required,
    unitPrice,
    installmentCount: spec.deadlines.length,
    intervalTicks: spec.deadlines.length > 1 ? spec.deadlines[1]! - spec.deadlines[0]! : t.intervalTicks,
    penaltyRatePpm,
    status: spec.status ?? "ACTIVE",
    installments: spec.deadlines.map((deadline, k) => {
      const delivered = spec.delivered?.[k] ?? 0;
      const outcome = spec.outcomes?.[k] ?? null;
      return {
        deadline: tick(deadline),
        required,
        delivered,
        outcome,
        penalty: outcome === null ? null : penaltyFor(unitPrice, required, delivered, penaltyRatePpm),
      };
    }),
    reservationIds: [...(spec.reservationIds ?? [])],
  };
  const s = contract.state;
  return { state: { ...s, contracts: [...s.contracts, value].sort(compareById) }, contractId: contract.id };
}

function withReputation(state: GameState, reputation: number): GameState {
  return { ...state, family: { ...state.family, reputation } };
}

function withUnlocked(state: GameState, unlocked: readonly UnlockId[]): GameState {
  return { ...state, family: { ...state.family, unlocked: [...unlocked].sort() } };
}

function scenarioWith(patch: { reputation?: number; vehicleIds?: ScenarioDefinition["vehicleIds"] }): ScenarioDefinition {
  return {
    ...FIRST_SHIPMENT_SCENARIO,
    family: { ...FIRST_SHIPMENT_SCENARIO.family, reputation: patch.reputation ?? FIRST_SHIPMENT_SCENARIO.family.reputation },
    vehicleIds: patch.vehicleIds ?? FIRST_SHIPMENT_SCENARIO.vehicleIds,
  };
}

const SECOND_TRUCK = asId("Vehicle", "fixture-second-truck");

/** Game-data and scenario with a second truck (same definition as the first). */
function twoTruckSetup(): GameSetup {
  const data: GameData = { ...GAME_DATA, vehicles: [...GAME_DATA.vehicles, { ...truckDef, id: SECOND_TRUCK }] };
  return { data, scenario: scenarioWith({ vehicleIds: [...FIRST_SHIPMENT_SCENARIO.vehicleIds, SECOND_TRUCK] }) };
}

// ---------------------------------------------------------------------------
// Commands and lookups
// ---------------------------------------------------------------------------

const accept = (contractOfferId: ContractOfferState["id"]): GameCommand => ({ type: "ACCEPT_CONTRACT", contractOfferId });

function deliver(
  contractId: ContractId,
  quantity: number,
  options: { quality?: QualityTier; productId?: ProductId; vehicleId?: VehicleId; routeId?: RouteDefinition["id"] | null } = {},
): GameCommand {
  const cargo: CargoLine = { productId: options.productId ?? MOONSHINE, quality: options.quality ?? "basic", quantity };
  return {
    type: "DISPATCH_DELIVERY",
    vehicleId: options.vehicleId ?? MODEL_TT_TRUCK,
    cargo: [cargo],
    purpose: { kind: "CONTRACT_INSTALLMENT", contractId },
    routeId: options.routeId ?? null,
    driver: { kind: "FOUNDER" },
  };
}

/**
 * A spot sale at the buyer's quote (ADR 0022 decision 6): agrees the deal now (it must
 * apply), and returns the deal dispatch of the same cargo for the caller to run.
 */
function spotSale(g: Game, buyerId: BuyerId, quantity: number, quality: QualityTier = "basic"): GameCommand {
  const want = g.sim.state.buyers.find((b) => b.id === buyerId)!.wants.find((w) => w.productId === MOONSHINE && w.minimumQuality === quality)!;
  expectApplied(run(g, { type: "AGREE_DEAL", buyerId, productId: MOONSHINE, quality, quantity, agreedUnitPrice: want.unitPrice }));
  return {
    type: "DISPATCH_DELIVERY",
    vehicleId: MODEL_TT_TRUCK,
    cargo: [{ productId: MOONSHINE, quality, quantity }],
    purpose: { kind: "SALE", buyerId, dealId: g.sim.state.heldDeals.at(-1)!.id },
    routeId: null,
    driver: { kind: "FOUNDER" },
  };
}

function offerFor(state: GameState, buyerId: BuyerId): ContractOfferState {
  const offer = state.contractOffers.find((o) => o.buyerId === buyerId);
  if (!offer) throw new Error(`No open offer for ${buyerId} at tick ${state.tick}`);
  return offer;
}

function contractOf(state: GameState, id: ContractId): ContractState {
  const c = state.contracts.find((x) => x.id === id);
  if (!c) throw new Error(`No contract ${id}`);
  return c;
}

function spotOf(state: GameState, productId: ProductId, quality: QualityTier): Money {
  const m = state.markets.find((x) => x.productId === productId && x.quality === quality);
  if (!m) throw new Error(`No market ${productId} ${quality}`);
  return m.spotPrice;
}

function heldBy(state: GameState, contractId: ContractId) {
  return state.reservations.filter((r) => r.holder.kind === "CONTRACT" && r.holder.contractId === contractId);
}

function poolQuantity(state: GameState, quality: QualityTier, facilityId: FacilityId = DISTILLERY_MAIN): number {
  return state.productPools.find((p) => p.facilityId === facilityId && p.productId === MOONSHINE && p.quality === quality)?.quantity ?? 0;
}

function unreserved(state: GameState, quality: QualityTier): number {
  const reserved = state.reservations
    .filter((r) => r.facilityId === DISTILLERY_MAIN && r.goods.kind === "PRODUCT" && r.goods.productId === MOONSHINE && r.goods.quality === quality)
    .reduce((n, r) => n + r.quantity, 0);
  return poolQuantity(state, quality) - reserved;
}

const offerKey = (buyerId: BuyerId, t: number) => idempotencyKey("DAILY_SETTLEMENT", "CONTRACT_OFFER", buyerId, t);
const expiredKey = (offerId: string) => idempotencyKey("DAILY_SETTLEMENT", "CONTRACT_OFFER_EXPIRED", offerId);
const penaltiesKey = (day: number) => idempotencyKey("DAILY_SETTLEMENT", "PENALTIES", day);
const settlementKey = (contractId: ContractId, index: number) => idempotencyKey("INSTALLMENT_SETTLEMENT", contractId, index);

const offerKeys = (state: GameState) => state.ledger.transactions.filter((t) => t.idempotencyKey.startsWith("DAILY_SETTLEMENT:CONTRACT_OFFER:"));

/**
 * A game where Kessler's midnight offer (tick DAY) was accepted on the next
 * tick, after booking `stock` basic cases (plus `standard` standard cases).
 */
function acceptedKessler(stock: number, options: { standard?: number; setup?: GameSetup } = {}) {
  const g = start(options.setup);
  if (stock > 0) edit(g, (s) => withStock(s, "basic", stock));
  if ((options.standard ?? 0) > 0) edit(g, (s) => withStock(s, "standard", options.standard!));
  to(g, DAY);
  const offer = offerFor(g.sim.state, KESSLERS_BACK_ROOM);
  expectApplied(run(g, accept(offer.id)));
  const contract = g.sim.state.contracts.find((c) => c.offerId === offer.id);
  if (!contract) throw new Error("Accepting didn't create a contract");
  return { g, offer, contractId: contract.id, deadlines: offerTiming(DAY).deadlines };
}

/** Dispatches so the outbound leg arrives exactly at `arrival` (the command applies at arrival − duration). */
function dispatchArrivingAt(g: Game, command: GameCommand, arrival: number, buyerId: BuyerId = KESSLERS_BACK_ROOM): void {
  to(g, arrival - routeTo(buyerId).durationTicks - 1);
  expectApplied(run(g, command));
  const d = g.sim.state.deliveries.at(-1)!;
  const v = g.sim.state.vehicles.find((x) => x.trip?.deliveryId === d.id)!;
  expect(v.trip!.arrivesAt).toBe(arrival);
}

// ===========================================================================
// Data (decision 1)
// ===========================================================================

describe("ECO-001 contracts: data", () => {
  it("ships the GDD §7 defaults: 3 installments every 2 days, 95% of spot, 20% penalty, first deadline offset 2 days + 18:00, no unlock", () => {
    const t = terms();
    expect(t.installmentCount).toBe(3);
    expect(t.intervalTicks).toBe(2 * DAY);
    expect(t.priceRatio).toBe(950_000);
    expect(t.penaltyRatePpm).toBe(200_000);
    expect(t.firstDeadlineOffsetTicks).toBe(2 * DAY + 18 * 60);
    expect(t.requiredUnlockId).toBeNull();
  });

  it("offers contracts from Kessler's (basic, 8 per installment) and Lakeview (standard, 6), and none from the roadhouse", () => {
    const buyers = [...contractBuyers()].sort((a, b) => compareIds(a.buyerId, b.buyerId));
    expect(buyers.map((b) => b.buyerId)).toEqual([KESSLERS_BACK_ROOM, LAKEVIEW_HOTEL]);
    expect(contractBuyer(KESSLERS_BACK_ROOM)).toMatchObject({ productId: MOONSHINE, minimumQuality: "basic", quantityPerInstallment: 8 });
    expect(contractBuyer(LAKEVIEW_HOTEL)).toMatchObject({ productId: MOONSHINE, minimumQuality: "standard", quantityPerInstallment: 6 });
    expect(contractBuyers().some((b) => b.buyerId === CROSSROADS_ROADHOUSE)).toBe(false);
  });

  it("puts every installment of an offer made by day 5 inside a 15-day session, at 18:00, off midnight (GDD §14.5, decision 9)", () => {
    for (let day = 1; day <= 5; day++) {
      const { deadlines } = offerTiming(day * DAY);
      expect(deadlines).toHaveLength(3);
      deadlines.forEach((d, k) => {
        expect(Math.floor(d / DAY)).toBe(day + 2 * (k + 1));
        expect(d % DAY).toBe(18 * 60);
      });
      expect(deadlines.at(-1)!).toBeLessThan(15 * DAY);
    }
  });
});

// ===========================================================================
// Offers (decision 2)
// ===========================================================================

describe("ECO-001 contracts: offers", () => {
  it("makes Kessler's offer at the first midnight, at 95% of that day's spot, in a keyed no-entry DAILY_SETTLEMENT", () => {
    const g = start();
    to(g, DAY - 1);
    expect(g.sim.state.contractOffers).toEqual([]);
    expect(offerKeys(g.sim.state)).toEqual([]);
    to(g, DAY);

    const s = g.sim.state;
    const def = contractBuyer(KESSLERS_BACK_ROOM);
    const t = terms();
    const timing = offerTiming(DAY);
    expect(s.contractOffers).toHaveLength(1); // Lakeview's minimum reputation is above the start
    const offer = s.contractOffers[0]!;
    expect(offer).toEqual({
      id: offer.id,
      buyerId: KESSLERS_BACK_ROOM,
      productId: def.productId,
      minimumQuality: def.minimumQuality,
      quantityPerInstallment: def.quantityPerInstallment,
      unitPrice: applyRatios(spotOf(s, def.productId, def.minimumQuality), [t.priceRatio]),
      installmentCount: t.installmentCount,
      intervalTicks: t.intervalTicks,
      penaltyRatePpm: t.penaltyRatePpm,
      firstDeadline: timing.firstDeadline,
      expiresAt: timing.expiresAt,
    });
    expect(offer.firstDeadline).toBe(DAY + t.firstDeadlineOffsetTicks);
    expect(offer.expiresAt).toBe(2 * DAY);

    const tx = oneTx(s, offerKey(KESSLERS_BACK_ROOM, DAY));
    expect(tx).toMatchObject({ kind: "DAILY_SETTLEMENT", tick: DAY, entries: [] });
    expect(eventsOf(g, tx)).toEqual([
      { type: "CONTRACT_OFFERED", id: tx.eventIds[0], tick: DAY, causedBy: null, contractOfferId: offer.id, buyerId: KESSLERS_BACK_ROOM, expiresAt: offer.expiresAt },
    ]);
    // The offer reads the spot after the market's midnight update.
    expect(indexOfKey(s, idempotencyKey("DAILY_SETTLEMENT", "MARKET", 1))).toBeLessThan(s.ledger.transactions.indexOf(tx));
  });

  it("offers to every eligible contract buyer in ID order, each at its own market's spot", () => {
    const g = start({ scenario: scenarioWith({ reputation: 100 }) });
    to(g, DAY);
    const s = g.sim.state;
    const offers = s.contractOffers;
    expect(offers.map((o) => o.buyerId)).toEqual([KESSLERS_BACK_ROOM, LAKEVIEW_HOTEL]);
    expect(compareIds(offers[0]!.id, offers[1]!.id)).toBeLessThan(0);
    const lakeview = contractBuyer(LAKEVIEW_HOTEL);
    expect(offers[1]).toMatchObject({
      productId: lakeview.productId,
      minimumQuality: lakeview.minimumQuality,
      quantityPerInstallment: lakeview.quantityPerInstallment,
      unitPrice: applyRatios(spotOf(s, lakeview.productId, lakeview.minimumQuality), [terms().priceRatio]),
    });
    expect(indexOfKey(s, offerKey(KESSLERS_BACK_ROOM, DAY))).toBeLessThan(indexOfKey(s, offerKey(LAKEVIEW_HOTEL, DAY)));
  });

  it("gives no offer to a buyer below its minimum reputation, or when the unlock requirement isn't met", () => {
    const g = start();
    to(g, DAY);
    expect(g.sim.state.contractOffers.some((o) => o.buyerId === LAKEVIEW_HOTEL)).toBe(false);

    const locked = start({ data: patchTerms({ requiredUnlockId: asId("Unlock", "fixture-contracts") }) });
    to(locked, 2 * DAY);
    expect(locked.sim.state.contractOffers).toEqual([]);
    expect(offerKeys(locked.sim.state)).toEqual([]);

    const unlocked = start({ data: patchTerms({ requiredUnlockId: FIRST_SHIPMENT_SCENARIO.family.unlocked[0]! }) });
    to(unlocked, DAY);
    expect(unlocked.sim.state.contractOffers.map((o) => o.buyerId)).toEqual([KESSLERS_BACK_ROOM]);
  });

  it("expires an offer at the next midnight and re-offers to the same buyer in the same midnight hook (expiry first)", () => {
    const g = start();
    to(g, DAY);
    const first = offerFor(g.sim.state, KESSLERS_BACK_ROOM);
    to(g, 2 * DAY - 1);
    expect(g.sim.state.contractOffers).toEqual([first]);
    to(g, 2 * DAY);

    const s = g.sim.state;
    const expiry = oneTx(s, expiredKey(first.id));
    expect(expiry).toMatchObject({ kind: "DAILY_SETTLEMENT", tick: 2 * DAY, entries: [] });
    expect(eventsOf(g, expiry)).toEqual([{ type: "CONTRACT_OFFER_EXPIRED", id: expiry.eventIds[0], tick: 2 * DAY, causedBy: null, contractOfferId: first.id }]);

    const again = oneTx(s, offerKey(KESSLERS_BACK_ROOM, 2 * DAY));
    expect(s.ledger.transactions.indexOf(expiry)).toBeLessThan(s.ledger.transactions.indexOf(again));
    expect(s.contractOffers).toHaveLength(1);
    const second = s.contractOffers[0]!;
    expect(second.id).not.toBe(first.id);
    expect(compareIds(first.id, second.id)).toBeLessThan(0);
    expect(second).toMatchObject({
      buyerId: KESSLERS_BACK_ROOM,
      firstDeadline: 2 * DAY + terms().firstDeadlineOffsetTicks,
      expiresAt: 3 * DAY,
      unitPrice: applyRatios(spotOf(s, MOONSHINE, contractBuyer(KESSLERS_BACK_ROOM).minimumQuality), [terms().priceRatio]),
    });
    expect(eventsOfType(eventsOf(g, again), "CONTRACT_OFFERED")).toHaveLength(1);
  });

  it("CONTRACT_OFFER world event: offers off midnight with that day's timing, and the offer expires (and is re-made) at the next midnight", () => {
    const g = start();
    const at = 100;
    edit(g, (s) => scheduleWorldEvent(s, { kind: "CONTRACT_OFFER", tick: tick(at), buyerId: KESSLERS_BACK_ROOM }));
    to(g, at - 1);
    expect(g.sim.state.contractOffers).toEqual([]);
    to(g, at);
    const s = g.sim.state;
    const offer = offerFor(s, KESSLERS_BACK_ROOM);
    expect(offer).toMatchObject({
      firstDeadline: terms().firstDeadlineOffsetTicks,
      expiresAt: DAY,
      unitPrice: applyRatios(spotOf(s, MOONSHINE, "basic"), [terms().priceRatio]),
    });
    const tx = oneTx(s, offerKey(KESSLERS_BACK_ROOM, at));
    expect(tx).toMatchObject({ kind: "DAILY_SETTLEMENT", tick: at, entries: [] });
    expect(eventsOf(g, tx).map((e) => e.type)).toEqual(["CONTRACT_OFFERED"]);

    to(g, DAY);
    const later = g.sim.state;
    expect(indexOfKey(later, expiredKey(offer.id))).toBeLessThan(indexOfKey(later, offerKey(KESSLERS_BACK_ROOM, DAY)));
    expect(later.contractOffers.map((o) => o.buyerId)).toEqual([KESSLERS_BACK_ROOM]);
    expect(later.contractOffers[0]!.id).not.toBe(offer.id);
  });

  it("CONTRACT_OFFER world event does nothing for an ineligible buyer, a buyer with an open offer, or a buyer with no contract", () => {
    const g = start();
    to(g, DAY);
    const before = g.sim.state.contractOffers;
    edit(g, (s) => {
      let x = scheduleWorldEvent(s, { kind: "CONTRACT_OFFER", tick: tick(DAY + 10), buyerId: LAKEVIEW_HOTEL }); // reputation too low
      x = scheduleWorldEvent(x, { kind: "CONTRACT_OFFER", tick: tick(DAY + 10), buyerId: KESSLERS_BACK_ROOM }); // already has an offer
      return scheduleWorldEvent(x, { kind: "CONTRACT_OFFER", tick: tick(DAY + 10), buyerId: CROSSROADS_ROADHOUSE }); // offers no contract
    });
    const transactionsBefore = g.sim.state.ledger.transactions.length;
    to(g, DAY + 10);
    expect(g.sim.state.contractOffers).toEqual(before);
    expect(g.sim.state.ledger.transactions).toHaveLength(transactionsBefore);
    expect(g.events.filter((e) => e.tick === DAY + 10)).toEqual([]);
  });

  it("CONTRACT_OFFER world event does nothing for a buyer with an ACTIVE contract", () => {
    const { g } = acceptedKessler(0);
    edit(g, (s) => scheduleWorldEvent(s, { kind: "CONTRACT_OFFER", tick: tick(DAY + 50), buyerId: KESSLERS_BACK_ROOM }));
    to(g, DAY + 50);
    expect(g.sim.state.contractOffers).toEqual([]);
    expect(keyed(g.sim.state, offerKey(KESSLERS_BACK_ROOM, DAY + 50))).toEqual([]);
  });

  it("CONTRACT_OFFER world event on a midnight tick does nothing; the midnight hook makes the offer at the new day's price", () => {
    const g = start();
    // A day-0 spot no midnight update can produce, so an offer priced before the update is detectable.
    edit(g, (s) => ({
      ...scheduleWorldEvent(s, { kind: "CONTRACT_OFFER", tick: tick(DAY), buyerId: KESSLERS_BACK_ROOM }),
      markets: s.markets.map((m) => (m.productId === MOONSHINE && m.quality === "basic" ? { ...m, spotPrice: cents(1) } : m)),
    }));
    to(g, DAY);
    const s = g.sim.state;
    expect(s.contractOffers).toHaveLength(1);
    expect(spotOf(s, MOONSHINE, "basic")).not.toBe(cents(1));
    expect(s.contractOffers[0]!.unitPrice).toBe(applyRatios(spotOf(s, MOONSHINE, "basic"), [terms().priceRatio]));
    const tx = oneTx(s, offerKey(KESSLERS_BACK_ROOM, DAY));
    expect(s.ledger.transactions.indexOf(tx)).toBeGreaterThan(indexOfKey(s, idempotencyKey("DAILY_SETTLEMENT", "MARKET", 1)));
    expect(eventsOfType(g.events, "CONTRACT_OFFERED")).toHaveLength(1);
  });

  it("makes no new offer to a buyer while its contract is ACTIVE, and offers again at the first midnight after it completes", () => {
    const { g, deadlines } = acceptedKessler(0);
    const last = deadlines.at(-1)!;
    const nextMidnight = (Math.floor(last / DAY) + 1) * DAY;
    to(g, nextMidnight - 1);
    expect(offerKeys(g.sim.state).map((t) => t.idempotencyKey)).toEqual([offerKey(KESSLERS_BACK_ROOM, DAY)]);
    expect(g.sim.state.contractOffers).toEqual([]);
    to(g, nextMidnight);
    expect(oneTx(g.sim.state, offerKey(KESSLERS_BACK_ROOM, nextMidnight))).toBeDefined();
    expect(g.sim.state.contractOffers.map((o) => o.buyerId)).toEqual([KESSLERS_BACK_ROOM]);
  });
});

// ===========================================================================
// Accepting (decisions 3 and 4)
// ===========================================================================

describe("ECO-001 contracts: ACCEPT_CONTRACT", () => {
  it("creates an ACTIVE contract with the offer's locked terms and deadlines, in one keyed RESERVATION transaction", () => {
    const g = start();
    edit(g, (s) => withStock(s, "basic", 20));
    to(g, DAY);
    const offer = offerFor(g.sim.state, KESSLERS_BACK_ROOM);
    const buyersBefore = g.sim.state.buyers;
    const cashBefore = cashOf(g.sim.state);
    const result = run(g, accept(offer.id));
    expectApplied(result);

    const s = g.sim.state;
    expect(s.contractOffers).toEqual([]);
    expect(s.contracts).toHaveLength(1);
    const c = s.contracts[0]!;
    expect(c).toEqual({
      buyerId: offer.buyerId,
      productId: offer.productId,
      minimumQuality: offer.minimumQuality,
      quantityPerInstallment: offer.quantityPerInstallment,
      unitPrice: offer.unitPrice,
      installmentCount: offer.installmentCount,
      intervalTicks: offer.intervalTicks,
      penaltyRatePpm: offer.penaltyRatePpm,
      id: c.id,
      offerId: offer.id,
      status: "ACTIVE",
      installments: Array.from({ length: offer.installmentCount }, (_, k) => ({
        deadline: offer.firstDeadline + k * offer.intervalTicks,
        required: offer.quantityPerInstallment,
        delivered: 0,
        outcome: null,
        penalty: null,
      })),
      reservationIds: c.reservationIds,
    });
    expect(c.installments.map((i) => i.deadline)).toEqual(offerTiming(DAY).deadlines);

    const tx = oneTx(s, idempotencyKey("RESERVATION", c.id, "ACCEPT"));
    expect(tx).toMatchObject({ kind: "RESERVATION", tick: DAY + 1, entries: [] });
    expect(eventsOf(g, tx)).toEqual([
      {
        type: "CONTRACT_ACCEPTED",
        id: tx.eventIds[0],
        tick: DAY + 1,
        causedBy: result.status === "applied" ? result.commandId : null,
        contractOfferId: offer.id,
        contractId: c.id,
        buyerId: KESSLERS_BACK_ROOM,
        reservationIds: c.reservationIds,
      },
    ]);
    // The player pays nothing, and the buyer's daily budget and demand aren't touched.
    expect(cashOf(s)).toBe(cashBefore);
    expect(s.buyers).toEqual(buyersBefore);
  });

  it("keeps the agreed price after the spot moves", () => {
    const { g, offer, contractId, deadlines } = acceptedKessler(0);
    to(g, deadlines[0]!);
    expect(contractOf(g.sim.state, contractId).unitPrice).toBe(offer.unitPrice);
  });

  it("reserves the first installment from unreserved stock of acceptable quality, lowest quality first, one reservation per slice", () => {
    const quantity = contractBuyer(KESSLERS_BACK_ROOM).quantityPerInstallment;
    const basic = quantity - 3;
    const { g, contractId } = acceptedKessler(basic, { standard: 10 });
    const s = g.sim.state;
    const c = contractOf(s, contractId);
    const held = heldBy(s, contractId);
    expect(held.map((r) => ({ facilityId: r.facilityId, goods: r.goods, quantity: r.quantity }))).toEqual([
      { facilityId: DISTILLERY_MAIN, goods: { kind: "PRODUCT", productId: MOONSHINE, quality: "basic" }, quantity: basic },
      { facilityId: DISTILLERY_MAIN, goods: { kind: "PRODUCT", productId: MOONSHINE, quality: "standard" }, quantity: 3 },
    ]);
    expect(compareIds(held[0]!.id, held[1]!.id)).toBeLessThan(0);
    expect(c.reservationIds).toEqual(held.map((r) => r.id));
    expect(eventsOfType(g.events, "CONTRACT_ACCEPTED")[0]!.reservationIds).toEqual(held.map((r) => r.id));
    expect(unreserved(s, "basic")).toBe(0);
    expect(unreserved(s, "standard")).toBe(7);
  });

  it("never reserves stock below the minimum quality, or stock another holder has reserved", () => {
    const g = start({ scenario: scenarioWith({ reputation: 100 }) });
    edit(g, (s) => withStock(withStock(s, "basic", 20), "standard", 4));
    // Another contract already holds 1 of the standard cases.
    edit(g, (s) => {
      const other = withContract(s, { buyerId: KESSLERS_BACK_ROOM, unitPrice: 1_000, deadlines: [20 * DAY, 22 * DAY, 24 * DAY] });
      const res = allocateId(other.state, "Reservation");
      const withRes = addReservation(res.state, {
        id: res.id,
        facilityId: DISTILLERY_MAIN,
        goods: { kind: "PRODUCT", productId: MOONSHINE, quality: "standard" },
        quantity: 1,
        holder: { kind: "CONTRACT", contractId: other.contractId },
      });
      return { ...withRes, contracts: withRes.contracts.map((c) => (c.id === other.contractId ? { ...c, reservationIds: [res.id] } : c)) };
    });
    to(g, DAY);
    const offer = offerFor(g.sim.state, LAKEVIEW_HOTEL);
    expectApplied(run(g, accept(offer.id)));
    const contract = g.sim.state.contracts.find((c) => c.offerId === offer.id)!;
    const held = heldBy(g.sim.state, contract.id);
    expect(held.map((r) => [r.goods, r.quantity])).toEqual([[{ kind: "PRODUCT", productId: MOONSHINE, quality: "standard" }, 3]]);
    expect(unreserved(g.sim.state, "basic")).toBe(20);
  });

  it("accepts with a shortfall: reserves what there is, or nothing at all", () => {
    const short = acceptedKessler(3);
    expect(heldBy(short.g.sim.state, short.contractId).map((r) => r.quantity)).toEqual([3]);
    expect(contractOf(short.g.sim.state, short.contractId).status).toBe("ACTIVE");

    const none = acceptedKessler(0);
    const c = contractOf(none.g.sim.state, none.contractId);
    expect(c.status).toBe("ACTIVE");
    expect(c.reservationIds).toEqual([]);
    expect(heldBy(none.g.sim.state, none.contractId)).toEqual([]);
    expect(eventsOfType(none.g.events, "CONTRACT_ACCEPTED")[0]!.reservationIds).toEqual([]);
  });

  it("rejects OFFER_UNAVAILABLE for an unknown or already accepted offer, without changing anything", () => {
    const g = start();
    to(g, DAY);
    const offer = offerFor(g.sim.state, KESSLERS_BACK_ROOM);
    const unknown = asId("ContractOffer", "offer-999");
    expect(expectRejected(g, accept(unknown), "OFFER_UNAVAILABLE")).toEqual({ code: "OFFER_UNAVAILABLE", contractOfferId: unknown });
    expectApplied(run(g, accept(offer.id)));
    expect(expectRejected(g, accept(offer.id), "OFFER_UNAVAILABLE")).toEqual({ code: "OFFER_UNAVAILABLE", contractOfferId: offer.id });
  });

  it("rejects OFFER_UNAVAILABLE on the expiry tick itself (ctx.tick ≥ expiresAt), before the midnight hook removes the offer", () => {
    const g = start();
    to(g, DAY);
    const offer = offerFor(g.sim.state, KESSLERS_BACK_ROOM);
    to(g, offer.expiresAt - 1); // the command would apply at tick expiresAt
    expect(g.sim.state.contractOffers).toEqual([offer]);
    expect(expectRejected(g, accept(offer.id), "OFFER_UNAVAILABLE")).toEqual({ code: "OFFER_UNAVAILABLE", contractOfferId: offer.id });

    // One tick earlier it applies.
    const h = start();
    to(h, offer.expiresAt - 2);
    expectApplied(run(h, accept(offerFor(h.sim.state, KESSLERS_BACK_ROOM).id)));
  });

  it("a queued ACCEPT_CONTRACT due on the expiry tick fails as it applies, leaving no contract", () => {
    const g = start();
    to(g, DAY);
    const offer = offerFor(g.sim.state, KESSLERS_BACK_ROOM);
    const queued = run(g, accept(offer.id), offer.expiresAt);
    expect(queued.status).toBe("queued");
    to(g, offer.expiresAt);
    expect(g.sim.state.contracts).toEqual([]);
    const rejected = eventsOfType(g.events, "COMMAND_REJECTED");
    expect(rejected.map((e) => e.reason)).toEqual([{ code: "OFFER_UNAVAILABLE", contractOfferId: offer.id }]);
    expect(rejected[0]!.tick).toBe(offer.expiresAt);
  });

  it("rejects LOCKED when the required unlock is no longer held, and checks it before reputation", () => {
    const unlockId = FIRST_SHIPMENT_SCENARIO.family.unlocked[0]!;
    const g = start({ data: patchTerms({ requiredUnlockId: unlockId }), scenario: scenarioWith({ reputation: 100 }) });
    to(g, DAY);
    const kessler = offerFor(g.sim.state, KESSLERS_BACK_ROOM);
    const lakeview = offerFor(g.sim.state, LAKEVIEW_HOTEL);
    edit(g, (s) => withReputation(withUnlocked(s, []), 0));
    expect(expectRejected(g, accept(kessler.id), "LOCKED")).toEqual({ code: "LOCKED", unlockId });
    // Lakeview fails both the unlock and the reputation check: LOCKED comes first.
    expect(expectRejected(g, accept(lakeview.id), "LOCKED")).toEqual({ code: "LOCKED", unlockId });
  });

  it("rejects REPUTATION_TOO_LOW with the buyer's minimum and the current reputation; OFFER_UNAVAILABLE comes first", () => {
    const g = start({ scenario: scenarioWith({ reputation: 100 }) });
    to(g, DAY);
    const lakeview = offerFor(g.sim.state, LAKEVIEW_HOTEL);
    const required = GAME_DATA.buyers.find((b) => b.id === LAKEVIEW_HOTEL)!.minimumReputation;
    expect(required).toBeGreaterThan(0);
    edit(g, (s) => withReputation(s, required - 1));
    expect(expectRejected(g, accept(lakeview.id), "REPUTATION_TOO_LOW")).toEqual({ code: "REPUTATION_TOO_LOW", required, current: required - 1 });
    // On the expiry tick, the offer is unavailable whatever the reputation.
    to(g, lakeview.expiresAt - 1);
    expectRejected(g, accept(lakeview.id), "OFFER_UNAVAILABLE");
  });
});

// ===========================================================================
// Dispatching an installment (decision 5)
// ===========================================================================

describe("ECO-001 contracts: dispatching an installment", () => {
  it("rejects CONTRACT_NOT_ACTIVE for an unknown or COMPLETED contract, before checking the cargo", () => {
    const g = start();
    edit(g, (s) => withStock(s, "basic", 10));
    const unknown = asId("Contract", "contract-999");
    expect(expectRejected(g, deliver(unknown, 1), "CONTRACT_NOT_ACTIVE")).toEqual({ code: "CONTRACT_NOT_ACTIVE", contractId: unknown });
    let done = asId("Contract", "contract-1");
    edit(g, (s) => {
      const x = withContract(s, {
        buyerId: KESSLERS_BACK_ROOM,
        unitPrice: 1_000,
        deadlines: [1, 2, 3].map((k) => k * 10),
        delivered: [8, 8, 8],
        outcomes: ["FULFILLED", "FULFILLED", "FULFILLED"],
        status: "COMPLETED",
      });
      done = x.contractId;
      return x.state;
    });
    expect(expectRejected(g, deliver(done, 1, { productId: WHISKEY }), "CONTRACT_NOT_ACTIVE")).toEqual({ code: "CONTRACT_NOT_ACTIVE", contractId: done });
  });

  it("rejects CARGO_DOES_NOT_MATCH_CONTRACT for another product or a quality below the minimum, before the route checks", () => {
    const { g, contractId } = acceptedKessler(10);
    edit(g, (s) => ({ ...s, routes: s.routes.map((r) => (r.id === routeTo(KESSLERS_BACK_ROOM).id ? { ...r, closure: { reason: "POLICE" as const, reopensAt: tick(9 * DAY) } } : r)) }));
    expect(expectRejected(g, deliver(contractId, 1, { productId: WHISKEY }), "CARGO_DOES_NOT_MATCH_CONTRACT")).toEqual({
      code: "CARGO_DOES_NOT_MATCH_CONTRACT",
      contractId,
    });

    let lakeviewContract = asId("Contract", "contract-1");
    edit(g, (s) => {
      const x = withContract(s, { buyerId: LAKEVIEW_HOTEL, unitPrice: 2_000, deadlines: [6 * DAY, 8 * DAY, 10 * DAY] });
      lakeviewContract = x.contractId;
      return x.state;
    });
    expect(qualityRank("basic")).toBeLessThan(qualityRank(contractBuyer(LAKEVIEW_HOTEL).minimumQuality));
    expect(expectRejected(g, deliver(lakeviewContract, 1, { quality: "basic" }), "CARGO_DOES_NOT_MATCH_CONTRACT")).toEqual({
      code: "CARGO_DOES_NOT_MATCH_CONTRACT",
      contractId: lakeviewContract,
    });
  });

  it("checks the route to the buyer like a sale: NO_ROUTE, then ROUTE_CLOSED, both before the quantity cap", () => {
    const { g, contractId } = acceptedKessler(10);
    expect(STATE_HIGHWAY).not.toBe(routeTo(KESSLERS_BACK_ROOM).id);
    expect(expectRejected(g, deliver(contractId, 1, { routeId: STATE_HIGHWAY }), "NO_ROUTE")).toEqual({ code: "NO_ROUTE", vehicleId: MODEL_TT_TRUCK });
    const route = routeTo(KESSLERS_BACK_ROOM);
    edit(g, (s) => ({ ...s, routes: s.routes.map((r) => (r.id === route.id ? { ...r, closure: { reason: "POLICE" as const, reopensAt: tick(9 * DAY) } } : r)) }));
    expect(expectRejected(g, deliver(contractId, 20), "ROUTE_CLOSED")).toEqual({ code: "ROUTE_CLOSED", routeId: route.id, reopensAt: 9 * DAY });
  });

  it("caps the quantity at what unsettled installments still need, minus cases in transit (BUYER_WILL_TAKE_LESS), before the stock check", () => {
    const { g, contractId } = acceptedKessler(30, { setup: twoTruckSetup() });
    const per = contractBuyer(KESSLERS_BACK_ROOM).quantityPerInstallment;
    const total = per * terms().installmentCount;
    const first = Math.min(truckDef.capacityCases, total - 1);
    expectApplied(run(g, deliver(contractId, first)));
    const acceptable = total - first;
    expect(expectRejected(g, deliver(contractId, acceptable + 1, { vehicleId: SECOND_TRUCK }), "BUYER_WILL_TAKE_LESS")).toEqual({
      code: "BUYER_WILL_TAKE_LESS",
      buyerId: KESSLERS_BACK_ROOM,
      requested: acceptable + 1,
      acceptable,
    });
    expectApplied(run(g, deliver(contractId, acceptable, { vehicleId: SECOND_TRUCK })));
  });

  it("counts delivered cases and skips settled installments in the cap", () => {
    const g = start();
    edit(g, (s) => withStock(s, "basic", 12));
    let id = asId("Contract", "contract-1");
    edit(g, (s) => {
      const x = withContract(s, {
        buyerId: KESSLERS_BACK_ROOM,
        unitPrice: 1_000,
        quantityPerInstallment: 8,
        deadlines: [0, 3 * DAY, 5 * DAY],
        delivered: [2, 5, 0],
        outcomes: ["PARTIAL", null, null],
      });
      id = x.contractId;
      return x.state;
    });
    // Unsettled: installment 1 needs 3, installment 2 needs 8.
    expect(expectRejected(g, deliver(id, 12), "BUYER_WILL_TAKE_LESS")).toEqual({ code: "BUYER_WILL_TAKE_LESS", buyerId: KESSLERS_BACK_ROOM, requested: 12, acceptable: 11 });
    // The cap is checked before stock: 13 is over both the cap (11) and the stock (12).
    expect(expectRejected(g, deliver(id, 13), "BUYER_WILL_TAKE_LESS")).toMatchObject({ requested: 13, acceptable: 11 });
    expectApplied(run(g, deliver(id, 11)));
  });

  it("rejects INSUFFICIENT_STOCK against this contract's reservations plus unreserved stock, never another holder's", () => {
    const { g, contractId } = acceptedKessler(10);
    // 8 reserved for this contract, 2 unreserved. Another contract takes 1 of those 2.
    edit(g, (s) => {
      const other = withContract(s, { buyerId: LAKEVIEW_HOTEL, unitPrice: 1_000, minimumQuality: "basic", deadlines: [20 * DAY, 22 * DAY, 24 * DAY] });
      const res = allocateId(other.state, "Reservation");
      return addReservation(res.state, {
        id: res.id,
        facilityId: DISTILLERY_MAIN,
        goods: { kind: "PRODUCT", productId: MOONSHINE, quality: "basic" },
        quantity: 1,
        holder: { kind: "CONTRACT", contractId: other.contractId },
      });
    });
    expect(expectRejected(g, deliver(contractId, 10), "INSUFFICIENT_STOCK")).toEqual({
      code: "INSUFFICIENT_STOCK",
      productId: MOONSHINE,
      quality: "basic",
      requested: 10,
      available: 9,
    });
    expect(expectRejected(g, deliver(contractId, 1, { quality: "standard" }), "INSUFFICIENT_STOCK")).toMatchObject({ quality: "standard", available: 0 });
    expectApplied(run(g, deliver(contractId, 9)));
  });

  it("draws the contract's reservations first with takeForContract, reports a used-up one CONSUMED, and makes no buyer commitment", () => {
    const { g, contractId } = acceptedKessler(12);
    const s0 = g.sim.state;
    const [reservation] = heldBy(s0, contractId);
    expect(reservation!.quantity).toBe(8);
    const pool = s0.productPools.find((p) => p.productId === MOONSHINE && p.quality === "basic")!;
    const buyersBefore = s0.buyers;
    const result = run(g, deliver(contractId, 10));
    expectApplied(result);

    const s = g.sim.state;
    const delivery = s.deliveries.at(-1)!;
    const expectedCost = Number((BigInt(pool.totalCost) * 10n * 2n + BigInt(pool.quantity)) / (2n * BigInt(pool.quantity)));
    expect(delivery).toMatchObject({
      vehicleId: MODEL_TT_TRUCK,
      fromFacilityId: DISTILLERY_MAIN,
      routeId: routeTo(KESSLERS_BACK_ROOM).id,
      cargo: [{ productId: MOONSHINE, quality: "basic", quantity: 10, cost: expectedCost }],
      purpose: { kind: "CONTRACT_INSTALLMENT", contractId },
      status: "OUTBOUND",
      dealDeadline: null,
    });
    expect(heldBy(s, contractId)).toEqual([]);
    expect(poolQuantity(s, "basic")).toBe(2);
    expect(unreserved(s, "basic")).toBe(2);
    expect(s.buyers).toEqual(buyersBefore);
    // reservationIds is append-only: the consumed reservation stays listed.
    expect(contractOf(s, contractId).reservationIds).toEqual([reservation!.id]);

    const tx = oneTx(s, idempotencyKey("DISPATCH", delivery.id));
    expectEntries(tx.entries, [
      { account: "GOODS_IN_TRANSIT", side: "DEBIT", amount: cents(expectedCost) },
      { account: "FINISHED_GOODS", side: "CREDIT", amount: cents(expectedCost) },
    ]);
    const events = eventsOf(g, tx);
    expect(eventsOfType(events, "RESERVATION_RELEASED").map((e) => [e.reservationId, e.reason])).toEqual([[reservation!.id, "CONSUMED"]]);
    expect(eventsOfType(events, "DELIVERY_DISPATCHED")).toHaveLength(1);
  });

  it("a partial draw shrinks the reservation under the same ID, with no release event", () => {
    const { g, contractId } = acceptedKessler(12);
    const [reservation] = heldBy(g.sim.state, contractId);
    expectApplied(run(g, deliver(contractId, 5)));
    const s = g.sim.state;
    expect(heldBy(s, contractId)).toEqual([{ ...reservation!, quantity: 3 }]);
    expect(unreserved(s, "basic")).toBe(4);
    const tx = oneTx(s, idempotencyKey("DISPATCH", s.deliveries.at(-1)!.id));
    expect(eventsOfType(eventsOf(g, tx), "RESERVATION_RELEASED")).toEqual([]);
  });

  it("contract reservations can't be sold as spot cargo", () => {
    const { g } = acceptedKessler(8);
    expect(unreserved(g.sim.state, "basic")).toBe(0);
    for (const buyerId of [CROSSROADS_ROADHOUSE, KESSLERS_BACK_ROOM]) {
      expect(expectRejected(g, spotSale(g, buyerId, 1), "INSUFFICIENT_STOCK")).toMatchObject({ requested: 1, available: 0 });
    }
  });

  it("doesn't need or use the buyer's daily budget or demand", () => {
    const { g, contractId, deadlines } = acceptedKessler(10);
    to(g, deadlines[0]! - routeTo(KESSLERS_BACK_ROOM).durationTicks - 1);
    edit(g, (s) => ({
      ...s,
      buyers: s.buyers.map((b) => (b.id === KESSLERS_BACK_ROOM ? { ...b, budgetRemaining: cents(0), wants: b.wants.map((w) => ({ ...w, demandRemaining: 0 })) } : b)),
    }));
    const buyersBefore = g.sim.state.buyers;
    expectApplied(run(g, deliver(contractId, 8)));
    to(g, deadlines[0]!);
    expect(g.sim.state.buyers).toEqual(buyersBefore);
    expect(contractOf(g.sim.state, contractId).installments[0]).toMatchObject({ delivered: 8, outcome: "FULFILLED" });
  });
});

// ===========================================================================
// Arrival (decision 6)
// ===========================================================================

describe("ECO-001 contracts: arrival", () => {
  it("is paid cash on delivery at the contract price, credits the installment, and sends the truck home", () => {
    const { g, offer, contractId, deadlines } = acceptedKessler(10);
    const arrival = deadlines[0]! - 30;
    dispatchArrivingAt(g, deliver(contractId, 8), arrival);
    const delivery = g.sim.state.deliveries.at(-1)!;
    const cashBefore = cashOf(g.sim.state);
    to(g, arrival);

    const s = g.sim.state;
    const revenue = multiplyMoney(offer.unitPrice, 8);
    const cogs = delivery.cargo[0]!.cost;
    const tx = oneTx(s, idempotencyKey("SALE", delivery.id));
    expect(tx).toMatchObject({ kind: "SALE", tick: arrival });
    expectEntries(tx.entries, saleEntries({ revenue, costOfGoodsSold: cogs }));
    expect(cashOf(s)).toBe(cashBefore + revenue);
    const [sale] = eventsOfType(eventsOf(g, tx), "SALE_COMPLETED");
    expect(sale).toMatchObject({
      deliveryId: delivery.id,
      buyerId: KESSLERS_BACK_ROOM,
      cargo: [{ productId: MOONSHINE, quality: "basic", quantity: 8 }],
      unitPrice: offer.unitPrice,
      revenue,
      costOfGoodsSold: cogs,
      contractId,
      transactionId: tx.id,
    });
    expect(contractOf(s, contractId).installments.map((i) => i.delivered)).toEqual([8, 0, 0]);
    expect(s.deliveries.find((d) => d.id === delivery.id)!.status).toBe("DELIVERED");
    const trip = s.vehicles.find((v) => v.id === MODEL_TT_TRUCK)!.trip!;
    expect(trip).toMatchObject({ leg: "RETURN", deliveryId: delivery.id, arrivesAt: arrival + routeTo(KESSLERS_BACK_ROOM).durationTicks });
  });

  it("fills unsettled installments in index order, each up to its requirement", () => {
    const { g, contractId, deadlines } = acceptedKessler(20);
    dispatchArrivingAt(g, deliver(contractId, 11), deadlines[0]! - 60);
    to(g, deadlines[0]! - 60);
    expect(contractOf(g.sim.state, contractId).installments.map((i) => i.delivered)).toEqual([8, 3, 0]);
  });

  it("counts an arrival exactly on the deadline tick as on time; one tick later credits the next installment", () => {
    const onTime = acceptedKessler(10);
    const d0 = onTime.deadlines[0]!;
    dispatchArrivingAt(onTime.g, deliver(onTime.contractId, 8), d0);
    to(onTime.g, d0);
    const s = onTime.g.sim.state;
    const sale = oneTx(s, idempotencyKey("SALE", s.deliveries.at(-1)!.id));
    const settlement = oneTx(s, settlementKey(onTime.contractId, 0));
    expect(sale.tick).toBe(d0);
    expect(settlement.tick).toBe(d0);
    expect(s.ledger.transactions.indexOf(sale)).toBeLessThan(s.ledger.transactions.indexOf(settlement));
    expect(contractOf(s, onTime.contractId).installments[0]).toMatchObject({ delivered: 8, outcome: "FULFILLED", penalty: 0 });

    const late = acceptedKessler(10);
    dispatchArrivingAt(late.g, deliver(late.contractId, 8), d0 + 1);
    to(late.g, d0);
    expect(contractOf(late.g.sim.state, late.contractId).installments[0]).toMatchObject({ delivered: 0, outcome: "MISSED" });
    to(late.g, d0 + 1);
    expect(contractOf(late.g.sim.state, late.contractId).installments.map((i) => i.delivered)).toEqual([0, 8, 0]);
  });

  it("pays for cases that arrive after every installment has settled, but credits nothing", () => {
    const g = start();
    edit(g, (s) => withStock(s, "basic", 10));
    const duration = routeTo(KESSLERS_BACK_ROOM).durationTicks;
    let id = asId("Contract", "contract-1");
    edit(g, (s) => {
      const x = withContract(s, {
        buyerId: KESSLERS_BACK_ROOM,
        unitPrice: 1_234,
        deadlines: [0, 1, 12],
        delivered: [8, 8, 0],
        outcomes: ["FULFILLED", "FULFILLED", null],
      });
      id = x.contractId;
      return x.state;
    });
    expect(duration).toBeGreaterThan(10);
    expectApplied(run(g, deliver(id, 8)));
    const delivery = g.sim.state.deliveries.at(-1)!;
    to(g, 1 + duration);
    const s = g.sim.state;
    const c = contractOf(s, id);
    expect(c.status).toBe("COMPLETED");
    expect(c.installments.map((i) => i.delivered)).toEqual([8, 8, 0]);
    const tx = oneTx(s, idempotencyKey("SALE", delivery.id));
    expectEntries(tx.entries, saleEntries({ revenue: multiplyMoney(cents(1_234), 8), costOfGoodsSold: delivery.cargo[0]!.cost }));
    expect(eventsOfType(eventsOf(g, tx), "SALE_COMPLETED")[0]).toMatchObject({ contractId: id, unitPrice: 1_234 });
  });
});

// ===========================================================================
// Settlement (decision 7)
// ===========================================================================

/** A game at tick 0 holding one fixture contract whose first installment is due at tick 1. */
function settlingFixture(spec: Omit<FixtureContractSpec, "deadlines" | "buyerId"> & { buyerId?: BuyerId; cash?: number }) {
  const g = start();
  let id = asId("Contract", "contract-1");
  edit(g, (s) => {
    const base = spec.cash === undefined ? s : withCash(s, spec.cash);
    const x = withContract(base, { buyerId: KESSLERS_BACK_ROOM, ...spec, deadlines: [1, 1 + 2 * DAY, 1 + 4 * DAY] });
    id = x.contractId;
    return x.state;
  });
  return { g, contractId: id };
}

describe("ECO-001 contracts: settling installments", () => {
  it("settles at the deadline tick, not before, in a keyed INSTALLMENT_SETTLEMENT with INSTALLMENT_SETTLED", () => {
    const { g, contractId, deadlines, offer } = acceptedKessler(0);
    const d0 = deadlines[0]!;
    to(g, d0 - 1);
    expect(keyed(g.sim.state, settlementKey(contractId, 0))).toEqual([]);
    expect(contractOf(g.sim.state, contractId).installments[0]!.outcome).toBeNull();
    to(g, d0);
    const s = g.sim.state;
    const tx = oneTx(s, settlementKey(contractId, 0));
    const penalty = penaltyFor(offer.unitPrice, offer.quantityPerInstallment, 0, offer.penaltyRatePpm);
    expect(tx).toMatchObject({ kind: "INSTALLMENT_SETTLEMENT", tick: d0 });
    expectEntries(tx.entries, payOrAccrueEntries({ amount: penalty, expense: "PENALTY_EXPENSE", payable: "PENALTIES_PAYABLE", cashAvailable: balancesBefore(s, tx).CASH }));
    expect(eventsOf(g, tx)).toEqual([
      {
        type: "INSTALLMENT_SETTLED",
        id: tx.eventIds[0],
        tick: d0,
        causedBy: null,
        contractId,
        installmentIndex: 0,
        required: offer.quantityPerInstallment,
        delivered: 0,
        outcome: "MISSED",
        penalty,
        transactionId: tx.id,
      },
    ]);
    expect(contractOf(s, contractId).installments[0]).toMatchObject({ outcome: "MISSED", penalty });
    expect(contractOf(s, contractId).status).toBe("ACTIVE");
  });

  it("FULFILLED (penalty 0, no entries), PARTIAL and MISSED, with the ADR 0002 single rounding of the penalty", () => {
    const cases: readonly { unitPrice: number; required: number; delivered: number; outcome: InstallmentOutcome; penalty: number }[] = [
      { unitPrice: 1_000, required: 8, delivered: 8, outcome: "FULFILLED", penalty: 0 },
      { unitPrice: 1_000, required: 8, delivered: 11, outcome: "FULFILLED", penalty: 0 },
      { unitPrice: 9, required: 8, delivered: 7, outcome: "PARTIAL", penalty: 2 }, // 1.8 → 2 (not floored)
      { unitPrice: 7, required: 8, delivered: 7, outcome: "PARTIAL", penalty: 1 }, // 1.4 → 1 (not ceiled)
      { unitPrice: 9, required: 8, delivered: 5, outcome: "PARTIAL", penalty: 5 }, // 27 × 0.2 = 5.4 → 5 (rounded once, not per case)
      { unitPrice: 1_333, required: 6, delivered: 0, outcome: "MISSED", penalty: 1_600 }, // 7 998 × 0.2 = 1 599.6
    ];
    for (const c of cases) {
      const { g, contractId } = settlingFixture({ unitPrice: c.unitPrice, quantityPerInstallment: c.required, delivered: [c.delivered], penaltyRatePpm: 200_000 });
      to(g, 1);
      const s = g.sim.state;
      const tx = oneTx(s, settlementKey(contractId, 0));
      expect(contractOf(s, contractId).installments[0], JSON.stringify(c)).toMatchObject({ outcome: c.outcome, penalty: c.penalty });
      if (c.penalty === 0) expect(tx.entries).toEqual([]);
      else expectEntries(tx.entries, [
        { account: "PENALTY_EXPENSE", side: "DEBIT", amount: cents(c.penalty) },
        { account: "CASH", side: "CREDIT", amount: cents(c.penalty) },
      ]);
      expect(eventsOfType(eventsOf(g, tx), "INSTALLMENT_SETTLED")[0]).toMatchObject({ outcome: c.outcome, penalty: c.penalty, delivered: c.delivered, required: c.required });
    }
  });

  it("a PARTIAL installment at a 0 penalty rate still commits, with no entries", () => {
    const { g, contractId } = settlingFixture({ unitPrice: 1_000, quantityPerInstallment: 8, delivered: [3], penaltyRatePpm: 0 });
    to(g, 1);
    const tx = oneTx(g.sim.state, settlementKey(contractId, 0));
    expect(tx.entries).toEqual([]);
    expect(contractOf(g.sim.state, contractId).installments[0]).toMatchObject({ outcome: "PARTIAL", penalty: 0 });
  });

  it("property: outcome and penalty follow decision 7 and post through payOrAccrueEntries against the cash on hand", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 200_000 }),
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 0, max: 25 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 50_000 }),
        (unitPrice, required, delivered, rate, cash) => {
          const { g, contractId } = settlingFixture({ unitPrice, quantityPerInstallment: required, delivered: [delivered], penaltyRatePpm: rate, cash });
          to(g, 1);
          const s = g.sim.state;
          const tx = oneTx(s, settlementKey(contractId, 0));
          const penalty = penaltyFor(cents(unitPrice), required, delivered, rate);
          expect(contractOf(s, contractId).installments[0]).toMatchObject({ outcome: outcomeFor(required, delivered), penalty });
          const expected = penalty === 0 ? [] : payOrAccrueEntries({ amount: penalty, expense: "PENALTY_EXPENSE", payable: "PENALTIES_PAYABLE", cashAvailable: cents(cash) });
          expectEntries(tx.entries, expected);
          expectCashNeverNegative(s);
        },
      ),
      { numRuns: 60 },
    );
  });

  it("accrues what cash can't pay to PENALTIES_PAYABLE; cash never goes negative", () => {
    const partly = settlingFixture({ unitPrice: 1_000, quantityPerInstallment: 8, delivered: [0], penaltyRatePpm: 200_000, cash: 500 });
    to(partly.g, 1);
    const tx = oneTx(partly.g.sim.state, settlementKey(partly.contractId, 0));
    expectEntries(tx.entries, [
      { account: "PENALTY_EXPENSE", side: "DEBIT", amount: cents(1_600) },
      { account: "CASH", side: "CREDIT", amount: cents(500) },
      { account: "PENALTIES_PAYABLE", side: "CREDIT", amount: cents(1_100) },
    ]);
    expect(cashOf(partly.g.sim.state)).toBe(0);

    const broke = settlingFixture({ unitPrice: 1_000, quantityPerInstallment: 8, delivered: [0], penaltyRatePpm: 200_000, cash: 0 });
    to(broke.g, 1);
    expectEntries(oneTx(broke.g.sim.state, settlementKey(broke.contractId, 0)).entries, [
      { account: "PENALTY_EXPENSE", side: "DEBIT", amount: cents(1_600) },
      { account: "PENALTIES_PAYABLE", side: "CREDIT", amount: cents(1_600) },
    ]);
    expectCashNeverNegative(broke.g.sim.state);
  });

  it("settles ACTIVE contracts in ID order, and several overdue installments of one contract in index order", () => {
    const g = start();
    const ids: ContractId[] = [];
    edit(g, (s) => {
      let x = { ...s, tick: tick(10) };
      for (const buyerId of [LAKEVIEW_HOTEL, KESSLERS_BACK_ROOM]) {
        const made = withContract(x, { buyerId, unitPrice: 1_000, deadlines: [3, 11, 11 + 2 * DAY] });
        ids.push(made.contractId);
        x = made.state;
      }
      return x;
    });
    to(g, 11);
    const keys = g.sim.state.ledger.transactions.filter((t) => t.kind === "INSTALLMENT_SETTLEMENT").map((t) => t.idempotencyKey);
    expect(keys).toEqual([settlementKey(ids[0]!, 0), settlementKey(ids[0]!, 1), settlementKey(ids[1]!, 0), settlementKey(ids[1]!, 1)]);
  });

  it("never settles an installment that already has an outcome, nor one whose settlement key is already in the ledger", () => {
    const g = start();
    let settled = asId("Contract", "contract-1");
    let keyedOnly = asId("Contract", "contract-2");
    edit(g, (s) => {
      const a = withContract(s, { buyerId: KESSLERS_BACK_ROOM, unitPrice: 1_000, deadlines: [1, 1 + 2 * DAY, 1 + 4 * DAY], delivered: [0], outcomes: ["MISSED"] });
      settled = a.contractId;
      const b = withContract(a.state, { buyerId: LAKEVIEW_HOTEL, unitPrice: 1_000, deadlines: [1, 1 + 2 * DAY, 1 + 4 * DAY] });
      keyedOnly = b.contractId;
      const tx = createCoordinator().begin(b.state, { kind: "INSTALLMENT_SETTLEMENT", idempotencyKey: settlementKey(keyedOnly, 0), tick: tick(0), causedBy: null });
      if (tx.status === "duplicate") throw new Error("unexpected");
      const r = tx.commit();
      if (r.status !== "committed") throw new Error("fixture");
      return r.state;
    });
    const cash = cashOf(g.sim.state);
    to(g, 5);
    const s = g.sim.state;
    expect(keyed(s, settlementKey(settled, 0))).toEqual([]);
    expect(keyed(s, settlementKey(keyedOnly, 0))).toHaveLength(1);
    expect(eventsOfType(g.events, "INSTALLMENT_SETTLED")).toEqual([]);
    expect(cashOf(s)).toBe(cash);
  });

  it("is COMPLETED only after the last installment, with CONTRACT_ENDED releases in ID order and CONTRACT_COMPLETED after INSTALLMENT_SETTLED", () => {
    const { g, contractId, deadlines, offer } = acceptedKessler(10);
    const [d0, d1, d2] = deadlines as [number, number, number];

    // Installment 0: deliver 8 on time. The first reservation is consumed at dispatch.
    const [first] = heldBy(g.sim.state, contractId);
    dispatchArrivingAt(g, deliver(contractId, 8), d0 - 10);
    to(g, d0);
    let s = g.sim.state;
    const tx0 = oneTx(s, settlementKey(contractId, 0));
    expect(tx0.entries).toEqual([]);
    expect(eventsOf(g, tx0).map((e) => e.type)).toEqual(["INSTALLMENT_SETTLED"]);
    expect(contractOf(s, contractId).status).toBe("ACTIVE");
    // Top-up toward installment 1 with the 2 unreserved cases: a new reservation, appended.
    const topUp1 = heldBy(s, contractId);
    expect(topUp1.map((r) => r.quantity)).toEqual([2]);
    expect(contractOf(s, contractId).reservationIds).toEqual([first!.id, topUp1[0]!.id]);

    // More stock arrives; installment 1 is missed; top-up toward installment 2 takes 8 − 2 = 6 more.
    edit(g, (st) => withStock(st, "basic", 10));
    to(g, d1);
    s = g.sim.state;
    const tx1 = oneTx(s, settlementKey(contractId, 1));
    expect(eventsOf(g, tx1).map((e) => e.type)).toEqual(["INSTALLMENT_SETTLED"]);
    expect(contractOf(s, contractId).installments[1]).toMatchObject({
      outcome: "MISSED",
      penalty: penaltyFor(offer.unitPrice, offer.quantityPerInstallment, 0, offer.penaltyRatePpm),
    });
    expect(contractOf(s, contractId).status).toBe("ACTIVE");
    const topUp2 = heldBy(s, contractId);
    expect(topUp2.map((r) => r.quantity)).toEqual([2, 6]);
    expect(topUp2[0]).toEqual(topUp1[0]);
    expect(contractOf(s, contractId).reservationIds).toEqual([first!.id, ...topUp2.map((r) => r.id)]);

    to(g, d2 - 1);
    expect(contractOf(g.sim.state, contractId).status).toBe("ACTIVE");
    to(g, d2);
    s = g.sim.state;
    const tx2 = oneTx(s, settlementKey(contractId, 2));
    const events = eventsOf(g, tx2);
    const released = [...topUp2.map((r) => r.id)].sort(compareIds);
    expect(events.map((e) => e.type)).toEqual(["INSTALLMENT_SETTLED", ...released.map(() => "RESERVATION_RELEASED"), "CONTRACT_COMPLETED"]);
    expect(eventsOfType(events, "RESERVATION_RELEASED").map((e) => [e.reservationId, e.reason])).toEqual(released.map((id) => [id, "CONTRACT_ENDED"]));
    expect(eventsOfType(events, "CONTRACT_COMPLETED")[0]).toMatchObject({ contractId, outcomes: ["FULFILLED", "MISSED", "MISSED"] });
    const c = contractOf(s, contractId);
    expect(c.status).toBe("COMPLETED");
    expect(c.installments.map((i) => i.outcome)).toEqual(["FULFILLED", "MISSED", "MISSED"]);
    expect(heldBy(s, contractId)).toEqual([]);
    expect(c.reservationIds).toEqual([first!.id, ...topUp2.map((r) => r.id)]);
    // The goods stay in the pool, now unreserved.
    expect(poolQuantity(s, "basic")).toBe(12);
    expect(unreserved(s, "basic")).toBe(12);
    // Every penalty was paid in cash, so nothing is owed and no paydown runs.
    expect(accountBalances(s.ledger.transactions).PENALTIES_PAYABLE).toBe(0);
    expect(s.ledger.transactions.filter((t) => t.idempotencyKey.startsWith("DAILY_SETTLEMENT:PENALTIES:"))).toEqual([]);
    expectCashNeverNegative(s);
  });

  it("emits the reputation-relevant events: one INSTALLMENT_SETTLED per installment with its outcome, and one CONTRACT_COMPLETED", () => {
    const { g, contractId, deadlines } = acceptedKessler(20);
    dispatchArrivingAt(g, deliver(contractId, 8), deadlines[0]! - 1);
    dispatchArrivingAt(g, deliver(contractId, 3), deadlines[1]! - 1);
    to(g, deadlines[2]! + 1);
    const settled = eventsOfType(g.events, "INSTALLMENT_SETTLED").filter((e) => e.contractId === contractId);
    expect(settled.map((e) => [e.installmentIndex, e.outcome])).toEqual([
      [0, "FULFILLED"],
      [1, "PARTIAL"],
      [2, "MISSED"],
    ]);
    const completed = eventsOfType(g.events, "CONTRACT_COMPLETED");
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ contractId, outcomes: ["FULFILLED", "PARTIAL", "MISSED"] });
  });

  it("settles each installment exactly once across a save and load, and the resumed game matches an uninterrupted one", () => {
    const deadlines = offerTiming(DAY).deadlines;
    const end = deadlines.at(-1)! + DAY;
    for (const at of [deadlines[0]! - 1, deadlines[0]!, deadlines[0]! + 1, deadlines[1]!, deadlines[2]!]) {
      const { g, contractId } = acceptedKessler(20);
      dispatchArrivingAt(g, deliver(contractId, 8), deadlines[0]! - 5);
      to(g, at);
      const save = JSON.parse(JSON.stringify(g.sim.serialize()));
      expect(hashState(save.state)).toBe(g.sim.stateHash());
      const resumed: Game = { sim: loadGame(save), setup: {}, events: [] };
      to(g, end);
      to(resumed, end);
      expect(resumed.sim.stateHash(), `saved at ${at}`).toBe(g.sim.stateHash());
      for (let k = 0; k < deadlines.length; k++) {
        expect(keyed(resumed.sim.state, settlementKey(contractId, k)), `installment ${k}, saved at ${at}`).toHaveLength(1);
      }
      // The resumed game settles only what was still open when it was saved.
      expect(eventsOfType(resumed.events, "INSTALLMENT_SETTLED").map((e) => e.installmentIndex)).toEqual([0, 1, 2].filter((k) => deadlines[k]! > at));
      expect(eventsOfType(g.events, "INSTALLMENT_SETTLED").map((e) => e.installmentIndex)).toEqual([0, 1, 2]);
      expect(contractOf(resumed.sim.state, contractId).status).toBe("COMPLETED");
      expect(contractOf(resumed.sim.state, contractId).installments.map((i) => i.outcome)).toEqual(["FULFILLED", "MISSED", "MISSED"]);
    }
  });

  it("draws no random numbers (decision 13)", () => {
    const { g, contractId, deadlines } = acceptedKessler(20);
    const rng = g.sim.state.rng.contracts;
    dispatchArrivingAt(g, deliver(contractId, 8), deadlines[0]! - 1);
    to(g, deadlines.at(-1)! + 2 * DAY);
    expect(g.sim.state.rng.contracts).toEqual(rng);
    expect(rng).toEqual(newGame().state.rng.contracts);
  });
});

// ===========================================================================
// Penalty paydown (decision 8)
// ===========================================================================

describe("ECO-001 contracts: paying down penalties at midnight", () => {
  it("pays min(PENALTIES_PAYABLE, cash) in DAILY_SETTLEMENT:PENALTIES:<day ended>, after the market and payroll, between expiry and new offers", () => {
    const g = start();
    edit(g, (s) => withPenaltiesPayable(s, 500));
    to(g, DAY);
    let s = g.sim.state;
    const tx = oneTx(s, penaltiesKey(0));
    expect(tx).toMatchObject({ kind: "DAILY_SETTLEMENT", tick: DAY, eventIds: [] });
    const before = balancesBefore(s, tx);
    const amount = cents(Math.max(0, Math.min(before.PENALTIES_PAYABLE, before.CASH)));
    expect(amount).toBe(500);
    expectEntries(tx.entries, payDownEntries(amount, "PENALTIES_PAYABLE"));
    const at = s.ledger.transactions.indexOf(tx);
    expect(indexOfKey(s, idempotencyKey("DAILY_SETTLEMENT", "MARKET", 1))).toBeLessThan(at);
    for (const part of ["WAGES", "OVERHEAD", "PAYROLL"]) {
      const i = indexOfKey(s, idempotencyKey("DAILY_SETTLEMENT", part, 0));
      expect(i, part).toBeLessThan(at); // -1 until #63 lands
    }
    expect(at).toBeLessThan(indexOfKey(s, offerKey(KESSLERS_BACK_ROOM, DAY)));
    expect(accountBalances(s.ledger.transactions).PENALTIES_PAYABLE).toBe(0);

    // Next midnight: the expiring offer goes first, then the paydown, then the new offer.
    const offer = offerFor(s, KESSLERS_BACK_ROOM);
    edit(g, (st) => withPenaltiesPayable(st, 300));
    to(g, 2 * DAY);
    s = g.sim.state;
    const next = oneTx(s, penaltiesKey(1));
    const order = [expiredKey(offer.id), penaltiesKey(1), offerKey(KESSLERS_BACK_ROOM, 2 * DAY)].map((k) => indexOfKey(s, k));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(next.entries.length).toBeGreaterThan(0);
  });

  it("is clamped to the cash on hand, skipped when it would be 0, and leaves the rest owed", () => {
    const g = start();
    edit(g, (s) => withCash(withPenaltiesPayable(s, 500), 0));
    to(g, DAY);
    let s = g.sim.state;
    // No cash at midnight (wages, if any, accrue): nothing to pay, so no transaction.
    expect(keyed(s, penaltiesKey(0))).toEqual([]);
    expect(Math.min(accountBalances(s.ledger.transactions).PENALTIES_PAYABLE, cashOf(s))).toBe(0);
    expect(accountBalances(s.ledger.transactions).PENALTIES_PAYABLE).toBe(500);

    edit(g, (st) => withCash(st, cashOf(st) + 200));
    to(g, 2 * DAY);
    s = g.sim.state;
    const found = keyed(s, penaltiesKey(1));
    const payableAfter = accountBalances(s.ledger.transactions).PENALTIES_PAYABLE;
    if (found.length === 0) {
      // Only possible if payroll used up the cash first.
      expect(cashOf(s)).toBe(0);
      expect(payableAfter).toBe(500);
    } else {
      const tx = found[0]!;
      const before = balancesBefore(s, tx);
      const amount = Math.min(before.PENALTIES_PAYABLE, before.CASH);
      expect(amount).toBeGreaterThan(0);
      expect(amount).toBeLessThanOrEqual(200);
      expectEntries(tx.entries, payDownEntries(cents(amount), "PENALTIES_PAYABLE"));
      expect(payableAfter).toBe(500 - amount);
    }
    expectCashNeverNegative(s);
  });

  it("runs no paydown when nothing is owed", () => {
    const g = start();
    to(g, 3 * DAY);
    expect(g.sim.state.ledger.transactions.filter((t) => t.idempotencyKey.startsWith("DAILY_SETTLEMENT:PENALTIES:"))).toEqual([]);
  });

  it("pays down an accrued settlement penalty at the next midnight", () => {
    const { g, contractId } = settlingFixture({ unitPrice: 1_000, quantityPerInstallment: 8, delivered: [0], penaltyRatePpm: 200_000, cash: 0 });
    to(g, 1);
    expect(accountBalances(g.sim.state.ledger.transactions).PENALTIES_PAYABLE).toBe(1_600);
    edit(g, (s) => withCash(s, 10_000));
    to(g, DAY);
    const s = g.sim.state;
    const tx = oneTx(s, penaltiesKey(0));
    const before = balancesBefore(s, tx);
    expectEntries(tx.entries, payDownEntries(cents(Math.min(before.PENALTIES_PAYABLE, before.CASH)), "PENALTIES_PAYABLE"));
    expect(contractOf(s, contractId).installments[0]!.penalty).toBe(1_600);
    expectCashNeverNegative(s);
  });
});

// ===========================================================================
// Snapshot (ContractsSnapshot)
// ===========================================================================

describe("ECO-001 contracts: snapshot", () => {
  it("lists open offers with display names and blockedBy", () => {
    const g = start({ scenario: scenarioWith({ reputation: 100 }) });
    to(g, DAY);
    const s = g.sim.state;
    const snap = g.sim.snapshot().contracts;
    expect(snap.offers).toEqual(
      s.contractOffers.map((o) => ({ ...o, buyerName: buyerName(o.buyerId), productName: productName(o.productId), blockedBy: null })),
    );
    expect(snap.active).toEqual([]);
    expect(snap.closed).toEqual([]);

    const required = GAME_DATA.buyers.find((b) => b.id === LAKEVIEW_HOTEL)!.minimumReputation;
    edit(g, (st) => withReputation(st, 0));
    const blocked = g.sim.snapshot().contracts.offers.find((o) => o.buyerId === LAKEVIEW_HOTEL)!;
    expect(blocked.blockedBy).toEqual({ code: "REPUTATION_TOO_LOW", required, current: 0 });
  });

  it("shows an active contract's installments with in-transit cases, and only active reservations", () => {
    const { g, contractId } = acceptedKessler(30);
    const [reservation] = heldBy(g.sim.state, contractId);
    expectApplied(run(g, deliver(contractId, 5)));
    let snap = g.sim.snapshot().contracts;
    expect(snap.active).toHaveLength(1);
    let c = snap.active[0]!;
    expect(c).toMatchObject({ id: contractId, status: "ACTIVE", buyerName: buyerName(KESSLERS_BACK_ROOM), productName: productName(MOONSHINE) });
    expect(c.reservationIds).toEqual([reservation!.id]);
    expect(c.reservedQuantity).toBe(3);
    expect(c.installments.map((i) => [i.index, i.delivered, i.inTransit, i.outcome, i.penalty])).toEqual([
      [0, 0, 5, null, null],
      [1, 0, 0, null, null],
      [2, 0, 0, null, null],
    ]);

    // Truck home, then a second load that spills into installment 1.
    to(g, g.sim.state.vehicles[0]!.trip!.arrivesAt);
    to(g, g.sim.state.vehicles[0]!.trip!.arrivesAt);
    expectApplied(run(g, deliver(contractId, 10)));
    snap = g.sim.snapshot().contracts;
    c = snap.active[0]!;
    expect(c.installments.map((i) => [i.delivered, i.inTransit])).toEqual([
      [5, 3],
      [0, 7],
      [0, 0],
    ]);
    expect(c.reservationIds).toEqual([]);
    expect(c.reservedQuantity).toBe(0);
  });

  it("moves a completed contract to closed", () => {
    const { g, contractId, deadlines } = acceptedKessler(0);
    to(g, deadlines.at(-1)!);
    const snap = g.sim.snapshot().contracts;
    expect(snap.active).toEqual([]);
    expect(snap.closed.map((c) => [c.id, c.status])).toEqual([[contractId, "COMPLETED"]]);
    expect(snap.closed[0]!.installments.map((i) => i.outcome)).toEqual(["MISSED", "MISSED", "MISSED"]);
  });
});

// ===========================================================================
// Sprint Zero guard
// ===========================================================================

describe("ECO-001 contracts: Sprint Zero", () => {
  it(`keeps the Sprint Zero replay hash at ${SPRINT_ZERO_HASH}: the path ends before the first midnight`, () => {
    const recipe = GAME_DATA.recipes.find((r) => r.id === BASIC_MOONSHINE_RECIPE)!;
    const sim = newGame();
    for (const input of recipe.inputsPerCase) {
      expectApplied(sim.dispatch({ command: { type: "PURCHASE_MATERIALS", supplierId: MILLERS_FEED, materialId: input.materialId, quantity: input.quantity, facilityId: DISTILLERY_MAIN } }));
    }
    expectApplied(sim.dispatch({ command: { type: "START_PRODUCTION", facilityId: DISTILLERY_MAIN, recipeId: BASIC_MOONSHINE_RECIPE, quantity: 1 } }));
    sim.advance(sim.state.productionJobs[0]!.completesAt - sim.state.tick);
    const quote = sim.state.buyers.find((b) => b.id === CROSSROADS_ROADHOUSE)!.wants[0]!.unitPrice;
    expectApplied(
      sim.dispatch({
        command: { type: "AGREE_DEAL", buyerId: CROSSROADS_ROADHOUSE, productId: recipe.productId, quality: recipe.quality, quantity: 1, agreedUnitPrice: quote },
      }),
    );
    expectApplied(
      sim.dispatch({
        command: {
          type: "DISPATCH_DELIVERY",
          vehicleId: MODEL_TT_TRUCK,
          cargo: [{ productId: recipe.productId, quality: recipe.quality, quantity: 1 }],
          purpose: { kind: "SALE", buyerId: CROSSROADS_ROADHOUSE, dealId: sim.state.heldDeals.at(-1)!.id },
          routeId: null,
          driver: { kind: "FOUNDER" },
        },
      }),
    );
    sim.advance(sim.state.vehicles[0]!.trip!.arrivesAt - sim.state.tick);
    const resumed = loadGame(JSON.parse(JSON.stringify(sim.serialize())));
    const finalTick = sim.state.vehicles[0]!.trip!.arrivesAt;
    sim.advance(finalTick - sim.state.tick);
    resumed.advance(finalTick - resumed.state.tick);
    expect(finalTick).toBeLessThan(DAY);
    expect(dayIndex(tick(finalTick))).toBe(0);
    expect(sim.stateHash()).toBe(SPRINT_ZERO_HASH);
    expect(resumed.stateHash()).toBe(SPRINT_ZERO_HASH);
  });
});
