// @locked
// T03 acceptance tests (issue #10): logistics and route disruption. Covers the
// route data (a safe default and a risky alternative per buyer, the new per-route
// tuning fields), dispatch (route choice, deal deadline, capacity, no funds
// check), the transport charge at VEHICLE_RETURN (paid or accrued, filed under
// TRANSPORT), disruption on risky routes (rng.routes at the outbound arrival,
// at most once per trip, delay and seizure, the return leg, keyed outcome
// transactions, no CLEAR on safe routes), deal deadlines and deals that fall
// through (TOO_LATE, cargo home unreserved at cost, always unloads), contract
// trips on risky routes, a conservation property, the recoverable choice, route
// closures, and rule 6. Rules come from ADR 0019 (decisions 1–6) and the pinned
// notes on issue #10.
//
// Written ahead of the implementation by a separate test-writer agent
// (factory.md §2, §7.3). Do not edit (CLAUDE.md rule 9).
//
// Imports are limited to the public package entry `src/index.ts`, the inventory
// module `src/inventory/index.ts` (`addProduct`, for fixtures), and
// `@eov/contracts` and `@eov/game-data`. Logistics is driven only through the
// Simulation (commands, ticks, world events, snapshots). No new simulation
// export is assumed.
//
// New `RouteDefinition` fields (ADR 0019 decision 1): `delayTicks`,
// `seizureSharePpm`, `dealGraceTicks`. They don't exist on main, so this file
// reads them by property through a loose cast (`tuning()`), and fixture routes
// are written by spreading a patch object onto the definition. Both compile
// today and keep compiling once the fields are added.
//
// Pinned literals: the ADR 0019 route table (120/150/300 ticks, $1.50/$2.00/$4.00
// safe; 80/100/200 ticks, $1.00/$1.33/$2.67 risky; riskPpm 0 and 150 000), the
// per-route 240 / 333 334 / 120, the truck's 20 cases, and the draw bound
// 1 000 000. Everything else is read from game-data or state.
//
// Forcing outcomes. Fixture GameData patches the risky routes only:
//   riskPpm 1 000 000 makes the first draw always disrupt (a < 1 000 000);
//   seizureSharePpm 1 000 000 makes it always a seizure, 0 always a delay.
// Where the real numbers matter, the expected outcome is recomputed from the
// state's `rng.routes` with `nextInt`, exactly as decision 3 specifies.
// These tests assume nothing else draws from `rng.routes` during day 0.
//
// Settled-only. Points ADR 0019 leaves open are not pinned:
//   - The order of DEAL_FELL_THROUGH and CARGO_LOST inside the seizure
//     transaction (checked as a set, not a sequence).
//   - Whether `delivery.cargo` is cleared after a TOO_LATE delivery's cargo comes
//     home (the conservation property counts a FAILED delivery's cargo as in
//     transit only while a vehicle's trip still carries it).
//   - The names, IDs and waypoints of the new risky routes (#77).
//   - TRANSFER dispatch (T03b, #76), so it isn't exercised here.
//
// Implementation note for the T03 agent (not a test assumption): the
// coordinator's commit-time invariant (`economy/coordinator/invariants.ts`)
// counts goods in transit only for deliveries with status OUTBOUND. Under
// decision 4 a TOO_LATE delivery is FAILED while its cargo is still on the
// truck, so that check needs to count it too. That file isn't in T03's owned
// list; see the issue.
//
// Expected to fail on main until T03 lands: there are no risky routes or
// per-route tuning fields, no transport charge, no disruption, no deal
// deadlines, and no ROUTE_CLOSURE / ROUTE_REOPENING handlers. Three tests pass
// on main and must keep passing: the open route state with the 20-case truck,
// the snapshot's route fields, and the 21-case VEHICLE_CAPACITY_EXCEEDED.

import {
  asId,
  cents,
  compareIds,
  idempotencyKey,
  tick,
  TICKS_PER_DAY,
  type BuyerId,
  type CargoLine,
  type CommandResult,
  type ContractId,
  type GameCommand,
  type GameEvent,
  type GameState,
  type LedgerEntry,
  type LedgerTransaction,
  type Money,
  type QualityTier,
  type RngState,
  type RouteId,
  type VehicleId,
  type VehicleState,
} from "@eov/contracts";
import {
  CROSSROADS_ROADHOUSE,
  DISTILLERY_MAIN,
  FIRST_SHIPMENT_SCENARIO,
  GAME_DATA,
  KESSLERS_BACK_ROOM,
  LAKEVIEW_HOTEL,
  MODEL_TT_TRUCK,
  MOONSHINE,
  type GameData,
  type RouteDefinition,
  type ScenarioDefinition,
} from "@eov/game-data";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addProduct } from "../../src/inventory/index.ts";
import {
  accountBalances,
  cargoLossEntries,
  cashFlowStatement,
  createCoordinator,
  createSimulation,
  dispatchEntries,
  newGame,
  nextInt,
  payOrAccrueEntries,
  returnFromTransitEntries,
  saleEntries,
  scheduleWorldEvent,
  seedRngStreams,
  simulationOptions,
  type GameSetup,
  type KernelSimulation,
} from "../../src/index.ts";

const DAY = TICKS_PER_DAY;
/** The draw bound: `nextInt(rng.routes, 1 000 000)` (decision 3). */
const PPM = 1_000_000;

// ---------------------------------------------------------------------------
// Route data (the new per-route fields are read loosely; see the header)
// ---------------------------------------------------------------------------

type Loose = Record<string, unknown>;

interface RouteTuning {
  readonly delayTicks: number;
  readonly seizureSharePpm: number;
  readonly dealGraceTicks: number;
}

function tuning(route: RouteDefinition): RouteTuning {
  const r = route as unknown as Loose;
  for (const field of ["delayTicks", "seizureSharePpm", "dealGraceTicks"]) {
    if (typeof r[field] !== "number") {
      throw new Error(`RouteDefinition ${route.id}: ${field} must be a number, got ${JSON.stringify(r[field])} (ADR 0019 decision 1)`);
    }
  }
  return r as unknown as RouteTuning;
}

const truckDef = GAME_DATA.vehicles.find((v) => v.id === MODEL_TT_TRUCK)!;
const home = GAME_DATA.facilities.find((f) => f.id === truckDef.homeFacilityId)!;
const BUYER_IDS = [CROSSROADS_ROADHOUSE, KESSLERS_BACK_ROOM, LAKEVIEW_HOTEL] as const;

/** Routes from the truck's home to the buyer, in listed order (the first is the default). */
function routesTo(buyerId: BuyerId, data: GameData = GAME_DATA): readonly RouteDefinition[] {
  const buyer = data.buyers.find((b) => b.id === buyerId);
  if (!buyer) throw new Error(`No buyer ${buyerId}`);
  return data.routes.filter((r) => r.fromLocationId === home.locationId && r.toLocationId === buyer.locationId);
}

function safeRoute(buyerId: BuyerId, data: GameData = GAME_DATA): RouteDefinition {
  const r = routesTo(buyerId, data)[0];
  if (!r) throw new Error(`No route to ${buyerId}`);
  return r;
}

function riskyRoute(buyerId: BuyerId, data: GameData = GAME_DATA): RouteDefinition {
  const r = routesTo(buyerId, data)[1];
  if (!r) throw new Error(`No risky alternative route to ${buyerId} (ADR 0019 decision 1)`);
  return r;
}

function routeById(id: RouteId, data: GameData = GAME_DATA): RouteDefinition {
  const r = data.routes.find((x) => x.id === id);
  if (!r) throw new Error(`No route ${id}`);
  return r;
}

type RoutePatch = Partial<Pick<RouteDefinition, "riskPpm" | "durationTicks" | "transportCost">> & Partial<RouteTuning>;

/** GameData with every buyer's risky route patched (the safe defaults untouched). */
function withRiskyRoutes(patch: RoutePatch, data: GameData = GAME_DATA): GameData {
  const risky = new Set<string>(BUYER_IDS.map((b) => riskyRoute(b, data).id));
  return { ...data, routes: data.routes.map((r) => (risky.has(r.id) ? ({ ...r, ...patch } as RouteDefinition) : r)) };
}

const FORCE_DELAY: RoutePatch = { riskPpm: PPM, seizureSharePpm: 0 };
const FORCE_SEIZE: RoutePatch = { riskPpm: PPM, seizureSharePpm: PPM };

type Outcome = "NONE" | "CLEAR" | "DELAY" | "SEIZE";

/** Decision 3's draws, replayed: none at riskPpm 0; `a` then (if disrupted) `b`. */
function expectedDraw(rng: RngState, route: RouteDefinition): { readonly outcome: Outcome; readonly rng: RngState } {
  if (route.riskPpm === 0) return { outcome: "NONE", rng };
  const a = nextInt(rng, PPM);
  if (a.value >= route.riskPpm) return { outcome: "CLEAR", rng: a.rng };
  const b = nextInt(a.rng, PPM);
  return { outcome: b.value < tuning(route).seizureSharePpm ? "SEIZE" : "DELAY", rng: b.rng };
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

/** Rejected with `code`; nothing changed and nothing was emitted (rule 6). Returns the reason. */
function expectRejected(g: Game, command: GameCommand, code: string) {
  flush(g);
  const before = g.sim.stateHash();
  const state = g.sim.state;
  const result = g.sim.dispatch({ command });
  if (result.status !== "rejected") throw new Error(`Expected rejected ${code}, got ${JSON.stringify(result)}`);
  expect(result.reason.code).toBe(code);
  expect(g.sim.stateHash()).toBe(before);
  expect(g.sim.state.counters).toEqual(state.counters);
  expect(g.sim.state.rng).toEqual(state.rng);
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

const cashOf = (state: GameState) => accountBalances(state.ledger.transactions).CASH;

/** The decision 2 charge: Dr TRANSPORT_EXPENSE / Cr CASH what's available / Cr WAGES_PAYABLE the rest. */
function transportEntries(cost: Money, cashAvailable: Money): readonly LedgerEntry[] {
  return payOrAccrueEntries({ amount: cost, expense: "TRANSPORT_EXPENSE", payable: "WAGES_PAYABLE", cashAvailable });
}

const keys = {
  dispatch: (d: string) => idempotencyKey("DISPATCH", d),
  clear: (d: string) => idempotencyKey("DISPATCH", d, "CLEAR"),
  delay: (d: string) => idempotencyKey("DISPATCH", d, "DELAY"),
  fellThrough: (d: string) => idempotencyKey("DISPATCH", d, "FELL_THROUGH"),
  loss: (d: string) => idempotencyKey("CARGO_LOSS", d),
  sale: (d: string) => idempotencyKey("SALE", d),
  ret: (d: string) => idempotencyKey("VEHICLE_RETURN", d),
  closure: (r: RouteId, t: number) => idempotencyKey("DAILY_SETTLEMENT", "ROUTE_CLOSURE", r, t),
  reopening: (r: RouteId, t: number) => idempotencyKey("DAILY_SETTLEMENT", "ROUTE_REOPENING", r, t),
};

/** Every transaction about delivery `d` after its DISPATCH, by key. */
function outcomeKeysOf(state: GameState, d: string): string[] {
  const prefix = `${keys.dispatch(d)}:`;
  return state.ledger.transactions.map((t) => t.idempotencyKey).filter((k) => k.startsWith(prefix) || k === keys.loss(d));
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
function withStock(state: GameState, quality: QualityTier, quantity: number, unitCost = 700): GameState {
  const cost = cents(unitCost * quantity);
  return fixtureTx(
    state,
    [
      { account: "FINISHED_GOODS", side: "DEBIT", amount: cost },
      { account: "OWNER_EQUITY", side: "CREDIT", amount: cost },
    ],
    (s) => addProduct(s, DISTILLERY_MAIN, MOONSHINE, quality, quantity, cost),
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

function scenarioWith(patch: { seed?: number; vehicleIds?: ScenarioDefinition["vehicleIds"] }): ScenarioDefinition {
  return {
    ...FIRST_SHIPMENT_SCENARIO,
    seed: patch.seed ?? FIRST_SHIPMENT_SCENARIO.seed,
    vehicleIds: patch.vehicleIds ?? FIRST_SHIPMENT_SCENARIO.vehicleIds,
  };
}

const SECOND_TRUCK = asId("Vehicle", "fixture-second-truck");

/** A second truck with the same definition as the first. */
function twoTruckSetup(data: GameData, seed: number): GameSetup {
  return {
    data: { ...data, vehicles: [...data.vehicles, { ...truckDef, id: SECOND_TRUCK }] },
    scenario: scenarioWith({ seed, vehicleIds: [...FIRST_SHIPMENT_SCENARIO.vehicleIds, SECOND_TRUCK] }),
  };
}

// ---------------------------------------------------------------------------
// Commands and lookups
// ---------------------------------------------------------------------------

function wantOf(state: GameState, buyerId: BuyerId, quality: QualityTier = "basic") {
  const want = state.buyers.find((b) => b.id === buyerId)?.wants.find((w) => w.productId === MOONSHINE && w.minimumQuality === quality);
  if (!want) throw new Error(`${buyerId} has no ${quality} moonshine want`);
  return want;
}

/**
 * A spot sale of `quantity` basic cases at the buyer's quote, split by ADR 0022 decision 6
 * into AGREE_DEAL and a deal dispatch. Reuses a HELD deal for the same buyer, cargo and
 * price (a rejected dispatch leaves its deal held), or agrees one now (it must apply).
 * Returns the dispatch for the caller to run.
 */
function sale(
  g: Game,
  buyerId: BuyerId,
  quantity: number,
  options: { routeId?: RouteId | null; vehicleId?: VehicleId; cargo?: readonly CargoLine[] } = {},
): GameCommand {
  const unitPrice = wantOf(g.sim.state, buyerId).unitPrice;
  const held = g.sim.state.heldDeals.find(
    (d) => d.status === "HELD" && d.buyerId === buyerId && d.productId === MOONSHINE && d.quality === "basic" && d.quantity === quantity && d.unitPrice === unitPrice,
  );
  if (!held) expectApplied(run(g, { type: "AGREE_DEAL", buyerId, productId: MOONSHINE, quality: "basic", quantity, agreedUnitPrice: unitPrice }));
  return {
    type: "DISPATCH_DELIVERY",
    vehicleId: options.vehicleId ?? MODEL_TT_TRUCK,
    cargo: options.cargo ?? [{ productId: MOONSHINE, quality: "basic", quantity }],
    purpose: { kind: "SALE", buyerId, dealId: held?.id ?? g.sim.state.heldDeals.at(-1)!.id },
    routeId: options.routeId ?? null,
    driver: { kind: "FOUNDER" },
  };
}

/**
 * Setup for tests of the dispatch's own checks: every buyer can agree any deal today, so
 * the buyer checks ADR 0022 decision 6 moved to AGREE_DEAL don't stand in the way.
 */
function withRoomyBuyers(state: GameState): GameState {
  return {
    ...state,
    buyers: state.buyers.map((b) => ({ ...b, budgetRemaining: cents(100_000_000), wants: b.wants.map((w) => ({ ...w, demandRemaining: 1_000 })) })),
  };
}

function deliverContract(contractId: ContractId, quantity: number, routeId: RouteId | null): GameCommand {
  return {
    type: "DISPATCH_DELIVERY",
    vehicleId: MODEL_TT_TRUCK,
    cargo: [{ productId: MOONSHINE, quality: "basic", quantity }],
    purpose: { kind: "CONTRACT_INSTALLMENT", contractId },
    routeId,
    driver: { kind: "FOUNDER" },
  };
}

function truckOf(state: GameState, vehicleId: VehicleId = MODEL_TT_TRUCK): VehicleState {
  const v = state.vehicles.find((x) => x.id === vehicleId);
  if (!v) throw new Error(`No vehicle ${vehicleId}`);
  return v;
}

function tripOf(state: GameState, vehicleId: VehicleId = MODEL_TT_TRUCK): NonNullable<VehicleState["trip"]> {
  const trip = truckOf(state, vehicleId).trip;
  if (!trip) throw new Error(`${vehicleId} isn't on a trip at ${state.tick}`);
  return trip;
}

function deliveryOf(state: GameState, id: string) {
  const d = state.deliveries.find((x) => x.id === id);
  if (!d) throw new Error(`No delivery ${id}`);
  return d;
}

function buyerOf(state: GameState, id: BuyerId) {
  const b = state.buyers.find((x) => x.id === id);
  if (!b) throw new Error(`No buyer ${id}`);
  return b;
}

function poolOf(state: GameState) {
  const p = state.productPools.find((x) => x.facilityId === DISTILLERY_MAIN && x.productId === MOONSHINE && x.quality === "basic");
  return { quantity: p?.quantity ?? 0, totalCost: p?.totalCost ?? 0 };
}

interface Trip {
  readonly deliveryId: string;
  readonly route: RouteDefinition;
  readonly departedAt: number;
  readonly arrivesAt: number;
  readonly cost: Money;
  readonly line: CargoLine;
}

/** Dispatches a spot sale and returns what was loaded. */
function dispatchSale(g: Game, buyerId: BuyerId, quantity: number, routeId: RouteId | null, vehicleId: VehicleId = MODEL_TT_TRUCK): Trip {
  const data = g.setup.data ?? GAME_DATA;
  expectApplied(run(g, sale(g, buyerId, quantity, { routeId, vehicleId })));
  const trip = tripOf(g.sim.state, vehicleId);
  const delivery = deliveryOf(g.sim.state, trip.deliveryId);
  const cargo = delivery.cargo[0]!;
  return {
    deliveryId: delivery.id,
    route: routeById(trip.routeId, data),
    departedAt: trip.departedAt,
    arrivesAt: trip.arrivesAt,
    cost: cargo.cost,
    line: { productId: cargo.productId, quality: cargo.quality, quantity: cargo.quantity },
  };
}

/** Steps tick by tick until the truck is home (bounded). */
function untilHome(g: Game, vehicleId: VehicleId = MODEL_TT_TRUCK, limit = 2 * DAY): void {
  const stop = g.sim.state.tick + limit;
  while (truckOf(g.sim.state, vehicleId).trip !== null) {
    if (g.sim.state.tick >= stop) throw new Error(`${vehicleId} didn't get home within ${limit} ticks`);
    to(g, g.sim.state.tick + 1);
  }
}

/** First seed (from 1) whose day-0 rng.routes gives `outcome` on `route`'s first trip. */
function seedFor(route: RouteDefinition, outcome: Outcome): number {
  for (let seed = 1; seed <= 500; seed++) {
    if (expectedDraw(seedRngStreams(seed).routes, route).outcome === outcome) return seed;
  }
  throw new Error(`No seed in 1..500 gives ${outcome} on ${route.id}`);
}

// ===========================================================================
// Routes (decision 1)
// ===========================================================================

describe("T03 routes: data (decision 1)", () => {
  const TABLE: readonly (readonly [BuyerId, readonly [number, number], readonly [number, number]])[] = [
    [CROSSROADS_ROADHOUSE, [120, 150], [80, 100]],
    [KESSLERS_BACK_ROOM, [150, 200], [100, 133]],
    [LAKEVIEW_HOTEL, [300, 400], [200, 267]],
  ];

  it("lists a safe default (riskPpm 0) first and a risky alternative (riskPpm 150 000) second for each buyer, at the ADR 0019 figures", () => {
    for (const [buyerId, [safeTicks, safeCents], [riskyTicks, riskyCents]] of TABLE) {
      const routes = routesTo(buyerId);
      expect(routes, buyerId).toHaveLength(2);
      const [safe, risky] = routes as [RouteDefinition, RouteDefinition];
      expect(safe, buyerId).toMatchObject({ durationTicks: safeTicks, transportCost: safeCents, riskPpm: 0 });
      expect(risky, buyerId).toMatchObject({ durationTicks: riskyTicks, transportCost: riskyCents, riskPpm: 150_000 });
      expect(risky.id).not.toBe(safe.id);
      expect(typeof risky.name).toBe("string");
      expect(risky.name.length).toBeGreaterThan(0);
    }
  });

  it("gives every route delayTicks 240, seizureSharePpm 333 334 and dealGraceTicks 120", () => {
    expect(GAME_DATA.routes.length).toBeGreaterThanOrEqual(6);
    for (const route of GAME_DATA.routes) {
      expect(tuning(route), route.id).toMatchObject({ delayTicks: 240, seizureSharePpm: 333_334, dealGraceTicks: 120 });
    }
  });

  /**
   * The game-data routes whose two ends the First Shipment scenario occupies
   * (an owned facility, a supplier, or a buyer): the routes a default game has
   * state for (#76). Computed from GAME_DATA and the scenario, not from state.
   */
  function occupiedRoutes(): readonly RouteDefinition[] {
    const sc = FIRST_SHIPMENT_SCENARIO;
    const locationOf = (list: readonly { readonly id: string; readonly locationId: string }[], id: string): string => {
      const found = list.find((x) => x.id === id);
      if (found === undefined) throw new Error(`${id} isn't in game-data`);
      return found.locationId;
    };
    const occupied = new Set<string>([
      ...sc.facilities.map((f) => locationOf(GAME_DATA.facilities, f.id)),
      ...sc.supplierIds.map((id) => locationOf(GAME_DATA.suppliers, id)),
      ...sc.buyerIds.map((id) => locationOf(GAME_DATA.buyers, id)),
    ]);
    return GAME_DATA.routes.filter((r) => occupied.has(r.fromLocationId) && occupied.has(r.toLocationId));
  }

  it("starts every route open, and the truck carries 20 cases", () => {
    const s = newGame().state;
    expect(s.routes.map((r) => r.id)).toEqual(occupiedRoutes().map((r) => r.id).sort(compareIds));
    expect(s.routes.every((r) => r.closure === null)).toBe(true);
    expect(truckDef.capacityCases).toBe(20);
  });

  it("shows each route's duration, cost and risk from game-data in the snapshot", () => {
    const snap = newGame().snapshot();
    for (const route of occupiedRoutes()) {
      expect(snap.routes.find((r) => r.id === route.id), route.id).toMatchObject({
        durationTicks: route.durationTicks,
        transportCost: route.transportCost,
        riskPpm: route.riskPpm,
        status: { open: true },
      });
    }
  });
});

// ===========================================================================
// Dispatch: route choice, deal deadline, capacity, no funds check, rule 6
// ===========================================================================

describe("T03 dispatch", () => {
  it("takes the safe default for routeId null and the risky route when asked, with game-data durations and a deal deadline of arrival + dealGraceTicks", () => {
    for (const choice of ["safe", "risky"] as const) {
      const g = start();
      edit(g, (s) => withStock(s, "basic", 4));
      const route = choice === "safe" ? safeRoute(CROSSROADS_ROADHOUSE) : riskyRoute(CROSSROADS_ROADHOUSE);
      const rngBefore = g.sim.state.rng.routes;
      const result = run(g, sale(g, CROSSROADS_ROADHOUSE, 4, { routeId: choice === "safe" ? null : route.id }));
      expectApplied(result);
      if (result.status !== "applied") return;
      const trip = tripOf(g.sim.state);
      const delivery = deliveryOf(g.sim.state, trip.deliveryId);
      expect(trip).toEqual({
        deliveryId: delivery.id,
        routeId: route.id,
        leg: "OUTBOUND",
        departedAt: result.tick,
        arrivesAt: result.tick + route.durationTicks,
        delayed: false,
      });
      expect(delivery.routeId).toBe(route.id);
      expect(delivery.dealDeadline).toBe(trip.arrivesAt + tuning(route).dealGraceTicks);
      // Nothing is drawn at dispatch (decision 3: at the outbound arrival tick).
      expect(g.sim.state.rng.routes).toEqual(rngBefore);
      // Dispatch moves the cargo cost only; transport is charged at return.
      const tx = oneTx(g.sim.state, keys.dispatch(delivery.id));
      expectEntries(tx.entries, dispatchEntries(delivery.cargo[0]!.cost));
    }
  });

  it("never rejects a dispatch for lack of cash: a sale dispatches with cash 0 (no soft lock)", () => {
    const g = start();
    edit(g, (s) => withCash(withStock(s, "basic", 4), 0));
    expect(cashOf(g.sim.state)).toBe(0);
    expectApplied(run(g, sale(g, CROSSROADS_ROADHOUSE, 4, { routeId: riskyRoute(CROSSROADS_ROADHOUSE).id })));
    expect(truckOf(g.sim.state).trip).not.toBeNull();
  });

  it("rejects more than the truck's 20 cases with VEHICLE_CAPACITY_EXCEEDED and changes nothing", () => {
    const g = start();
    edit(g, (s) => withRoomyBuyers(withStock(s, "basic", 30)));
    expect(expectRejected(g, sale(g, KESSLERS_BACK_ROOM, 21), "VEHICLE_CAPACITY_EXCEEDED")).toEqual({
      code: "VEHICLE_CAPACITY_EXCEEDED",
      vehicleId: MODEL_TT_TRUCK,
      requested: 21,
      capacity: 20,
    });
  });

  it("never double-assigns the truck: VEHICLE_UNAVAILABLE on the outbound leg, while delayed, and on the return leg", () => {
    const g = start({ data: withRiskyRoutes(FORCE_DELAY) });
    edit(g, (s) => withStock(s, "basic", 8));
    const t = dispatchSale(g, CROSSROADS_ROADHOUSE, 2, riskyRoute(CROSSROADS_ROADHOUSE).id);
    expectRejected(g, sale(g, CROSSROADS_ROADHOUSE, 1), "VEHICLE_UNAVAILABLE");
    to(g, t.arrivesAt);
    expect(tripOf(g.sim.state).delayed).toBe(true);
    expectRejected(g, sale(g, CROSSROADS_ROADHOUSE, 1), "VEHICLE_UNAVAILABLE");
    to(g, tripOf(g.sim.state).arrivesAt);
    expect(tripOf(g.sim.state).leg).toBe("RETURN");
    expectRejected(g, sale(g, CROSSROADS_ROADHOUSE, 1), "VEHICLE_UNAVAILABLE");
  });

  it("rejects multi-line cargo, an unknown route, and another buyer's route, each atomically (rule 6)", () => {
    const g = start();
    edit(g, (s) => withRoomyBuyers(withStock(withStock(s, "basic", 4), "standard", 4)));
    const twoLines: CargoLine[] = [
      { productId: MOONSHINE, quality: "basic", quantity: 1 },
      { productId: MOONSHINE, quality: "standard", quantity: 1 },
    ];
    expectRejected(g, sale(g, KESSLERS_BACK_ROOM, 2, { cargo: twoLines }), "INVALID_QUANTITY");
    expectRejected(g, sale(g, CROSSROADS_ROADHOUSE, 1, { routeId: asId("Route", "fixture-no-such-route") }), "UNKNOWN_ENTITY");
    expectRejected(g, sale(g, CROSSROADS_ROADHOUSE, 1, { routeId: riskyRoute(KESSLERS_BACK_ROOM).id }), "NO_ROUTE");
    expectRejected(g, sale(g, CROSSROADS_ROADHOUSE, 5), "INSUFFICIENT_STOCK");
    expectApplied(run(g, sale(g, CROSSROADS_ROADHOUSE, 4, { routeId: riskyRoute(CROSSROADS_ROADHOUSE).id })));
  });
});

// ===========================================================================
// Transport cost (decision 2)
// ===========================================================================

describe("T03 transport cost (decision 2)", () => {
  it("charges the route's cost once, in VEHICLE_RETURN when the truck gets home, paid in cash", () => {
    const g = start();
    edit(g, (s) => withStock(s, "basic", 4));
    const cashAtDispatch = cashOf(g.sim.state);
    const t = dispatchSale(g, CROSSROADS_ROADHOUSE, 4, null);
    expect(t.route.id).toBe(safeRoute(CROSSROADS_ROADHOUSE).id);
    to(g, t.arrivesAt);
    const saleTx = oneTx(g.sim.state, keys.sale(t.deliveryId));
    const revenue = saleTx.entries.find((e) => e.account === "SALES_REVENUE")!.amount;
    // Nothing is charged before the truck is home (the ECO-001 pin holds).
    expect(cashOf(g.sim.state) - cashAtDispatch).toBe(revenue);
    to(g, tripOf(g.sim.state).arrivesAt);
    expect(truckOf(g.sim.state).trip).toBeNull();

    const tx = oneTx(g.sim.state, keys.ret(t.deliveryId));
    expect(tx).toMatchObject({ kind: "VEHICLE_RETURN", tick: t.arrivesAt + t.route.durationTicks });
    const cashBefore = balancesBefore(g.sim.state, tx).CASH;
    expect(cashBefore).toBeGreaterThanOrEqual(t.route.transportCost);
    expectEntries(tx.entries, transportEntries(t.route.transportCost, cashBefore));
    const charged = g.sim.state.ledger.transactions.filter((x) => x.entries.some((e) => e.account === "TRANSPORT_EXPENSE"));
    expect(charged.map((x) => x.idempotencyKey)).toEqual([keys.ret(t.deliveryId)]);
    const [returned] = eventsOfType(eventsOf(g, tx), "VEHICLE_RETURNED");
    expect(returned).toMatchObject({ vehicleId: MODEL_TT_TRUCK, deliveryId: t.deliveryId, locationId: home.locationId, returnedCargo: [] });
  });

  it("charges a risky trip its own route's cost", () => {
    const g = start();
    edit(g, (s) => withStock(s, "basic", 4));
    const t = dispatchSale(g, KESSLERS_BACK_ROOM, 4, riskyRoute(KESSLERS_BACK_ROOM).id);
    untilHome(g);
    const tx = oneTx(g.sim.state, keys.ret(t.deliveryId));
    const debit = tx.entries.find((e) => e.account === "TRANSPORT_EXPENSE" && e.side === "DEBIT");
    expect(debit?.amount).toBe(riskyRoute(KESSLERS_BACK_ROOM).transportCost);
  });

  it("accrues a shortfall to WAGES_PAYABLE (partly or wholly) and files the cash part under TRANSPORT", () => {
    const cost = safeRoute(CROSSROADS_ROADHOUSE).transportCost;
    const partial = Math.floor(cost / 3);
    expect(partial).toBeGreaterThan(0);
    for (const cashAtReturn of [partial, 0]) {
      const g = start();
      edit(g, (s) => withStock(s, "basic", 2));
      const t = dispatchSale(g, CROSSROADS_ROADHOUSE, 2, null);
      const returnAt = t.arrivesAt + t.route.durationTicks;
      to(g, returnAt - 1);
      edit(g, (s) => withCash(s, cashAtReturn));
      to(g, returnAt);
      const tx = oneTx(g.sim.state, keys.ret(t.deliveryId));
      const expected = transportEntries(cost, cents(cashAtReturn));
      expectEntries(tx.entries, expected);
      expect(tx.entries.find((e) => e.account === "WAGES_PAYABLE")?.amount).toBe(cost - cashAtReturn);
      expect(cashOf(g.sim.state)).toBe(0);
      // Cash flow (ADR 0015): VEHICLE_RETURN's default category is TRANSPORT.
      const flow = cashFlowStatement(cents(cashAtReturn), [tx]);
      expect(flow.lines.find((l) => l.category === "TRANSPORT")?.amount).toBe(0 - cashAtReturn);
      expect(flow.lines.filter((l) => l.category !== "TRANSPORT").every((l) => l.amount === 0)).toBe(true);
    }
  });
});

// ===========================================================================
// Disruption (decision 3)
// ===========================================================================

describe("T03 disruption (decision 3)", () => {
  it("draws nothing on a safe route and commits no CLEAR transaction", () => {
    const g = start();
    edit(g, (s) => withStock(s, "basic", 4));
    const rng = g.sim.state.rng.routes;
    const t = dispatchSale(g, CROSSROADS_ROADHOUSE, 4, null);
    expect(t.route.riskPpm).toBe(0);
    untilHome(g);
    expect(g.sim.state.rng.routes).toEqual(rng);
    expect(outcomeKeysOf(g.sim.state, t.deliveryId)).toEqual([]);
    expect(deliveryOf(g.sim.state, t.deliveryId).status).toBe("DELIVERED");
  });

  it("draws once at the outbound arrival on a risky route; a clear trip commits a no-event DISPATCH:<id>:CLEAR just before the SALE", () => {
    const route = riskyRoute(CROSSROADS_ROADHOUSE);
    const seed = seedFor(route, "CLEAR");
    const g = start({ scenario: scenarioWith({ seed }) });
    edit(g, (s) => withStock(s, "basic", 4));
    const rng = g.sim.state.rng.routes;
    const t = dispatchSale(g, CROSSROADS_ROADHOUSE, 4, route.id);
    to(g, t.arrivesAt - 1);
    expect(g.sim.state.rng.routes).toEqual(rng);
    expect(outcomeKeysOf(g.sim.state, t.deliveryId)).toEqual([]);
    to(g, t.arrivesAt);

    const s = g.sim.state;
    expect(s.rng.routes).toEqual(expectedDraw(rng, route).rng);
    const clear = oneTx(s, keys.clear(t.deliveryId));
    expect(clear).toMatchObject({ kind: "DISPATCH", tick: t.arrivesAt, entries: [], eventIds: [] });
    expect(indexOfKey(s, keys.sale(t.deliveryId))).toBe(indexOfKey(s, keys.clear(t.deliveryId)) + 1);
    expect(outcomeKeysOf(s, t.deliveryId)).toEqual([keys.clear(t.deliveryId)]);
    expect(deliveryOf(s, t.deliveryId).status).toBe("DELIVERED");

    // The return leg draws nothing.
    const after = s.rng.routes;
    untilHome(g);
    expect(g.sim.state.rng.routes).toEqual(after);
  });

  it("a delay pushes arrivesAt by delayTicks, emits DELIVERY_DELAYED in DISPATCH:<id>:DELAY, and the late arrival draws nothing", () => {
    // delayTicks below the grace, so the delayed sale still delivers.
    const data = withRiskyRoutes({ ...FORCE_DELAY, delayTicks: 60, dealGraceTicks: 120 });
    const g = start({ data });
    edit(g, (s) => withStock(s, "basic", 4));
    const rng = g.sim.state.rng.routes;
    const t = dispatchSale(g, CROSSROADS_ROADHOUSE, 4, riskyRoute(CROSSROADS_ROADHOUSE, data).id);
    to(g, t.arrivesAt);

    const s = g.sim.state;
    const draw = expectedDraw(rng, t.route);
    expect(draw.outcome).toBe("DELAY");
    expect(s.rng.routes).toEqual(draw.rng);
    const tx = oneTx(s, keys.delay(t.deliveryId));
    expect(tx).toMatchObject({ kind: "DISPATCH", tick: t.arrivesAt, entries: [] });
    expect(eventsOf(g, tx)).toEqual([
      {
        type: "DELIVERY_DELAYED",
        id: tx.eventIds[0],
        tick: t.arrivesAt,
        causedBy: null,
        deliveryId: t.deliveryId,
        routeId: t.route.id,
        previousArrivesAt: t.arrivesAt,
        arrivesAt: t.arrivesAt + 60,
      },
    ]);
    expect(tripOf(s)).toEqual({
      deliveryId: t.deliveryId,
      routeId: t.route.id,
      leg: "OUTBOUND",
      departedAt: t.departedAt,
      arrivesAt: t.arrivesAt + 60,
      delayed: true,
    });
    expect(deliveryOf(s, t.deliveryId).status).toBe("OUTBOUND");
    expect(keyed(s, keys.sale(t.deliveryId))).toEqual([]);

    to(g, t.arrivesAt + 60);
    const late = g.sim.state;
    expect(late.rng.routes).toEqual(draw.rng);
    expect(oneTx(late, keys.sale(t.deliveryId)).tick).toBe(t.arrivesAt + 60);
    expect(outcomeKeysOf(late, t.deliveryId)).toEqual([keys.delay(t.deliveryId)]);
    expect(deliveryOf(late, t.deliveryId).status).toBe("DELIVERED");
  });

  it("a seizure writes off the cargo in CARGO_LOSS:<id>, releases the deal, empties the cargo, and turns the truck home empty", () => {
    const data = withRiskyRoutes(FORCE_SEIZE);
    const g = start({ data });
    edit(g, (s) => withStock(s, "basic", 4));
    const reputation = g.sim.state.family.reputation;
    const buyerBefore = buyerOf(g.sim.state, CROSSROADS_ROADHOUSE);
    const poolBefore = poolOf(g.sim.state);
    const rng = g.sim.state.rng.routes;
    const t = dispatchSale(g, CROSSROADS_ROADHOUSE, 4, riskyRoute(CROSSROADS_ROADHOUSE, data).id);
    to(g, t.arrivesAt);

    const s = g.sim.state;
    const draw = expectedDraw(rng, t.route);
    expect(draw.outcome).toBe("SEIZE");
    expect(s.rng.routes).toEqual(draw.rng);
    const tx = oneTx(s, keys.loss(t.deliveryId));
    expect(tx).toMatchObject({ kind: "CARGO_LOSS", tick: t.arrivesAt });
    expectEntries(tx.entries, cargoLossEntries(t.cost));
    const events = eventsOf(g, tx);
    expect(events).toHaveLength(2);
    expect(eventsOfType(events, "CARGO_LOST")).toEqual([
      expect.objectContaining({ deliveryId: t.deliveryId, vehicleId: MODEL_TT_TRUCK, cargo: [t.line], bookValue: t.cost, transactionId: tx.id }),
    ]);
    expect(eventsOfType(events, "DEAL_FELL_THROUGH")).toEqual([
      expect.objectContaining({ deliveryId: t.deliveryId, buyerId: CROSSROADS_ROADHOUSE, reason: "CARGO_LOST" }),
    ]);
    expect(deliveryOf(s, t.deliveryId)).toMatchObject({ status: "FAILED", cargo: [] });
    // releaseDeal: same day, so the buyer is back where it was before the dispatch.
    expect(buyerOf(s, CROSSROADS_ROADHOUSE)).toEqual(buyerBefore);
    expect(tripOf(s)).toEqual({
      deliveryId: t.deliveryId,
      routeId: t.route.id,
      leg: "RETURN",
      departedAt: t.arrivesAt,
      arrivesAt: t.arrivesAt + t.route.durationTicks,
      delayed: false,
    });
    expect(keyed(s, keys.sale(t.deliveryId))).toEqual([]);
    expect(outcomeKeysOf(s, t.deliveryId)).toEqual([keys.loss(t.deliveryId)]);

    to(g, t.arrivesAt + t.route.durationTicks);
    const end = g.sim.state;
    expect(end.rng.routes).toEqual(draw.rng);
    expect(truckOf(end).trip).toBeNull();
    const ret = oneTx(end, keys.ret(t.deliveryId));
    expectEntries(ret.entries, transportEntries(t.route.transportCost, balancesBefore(end, ret).CASH));
    expect(eventsOfType(eventsOf(g, ret), "VEHICLE_RETURNED")[0]).toMatchObject({ deliveryId: t.deliveryId, returnedCargo: [] });
    const balances = accountBalances(end.ledger.transactions);
    expect(balances.GOODS_IN_TRANSIT).toBe(0);
    expect(balances.LOSSES).toBe(t.cost);
    expect(poolOf(end).quantity).toBe(poolBefore.quantity - 4);
    // A failed spot deal changes no reputation (decision 4).
    expect(eventsOfType(g.events, "REPUTATION_CHANGED")).toEqual([]);
    expect(end.family.reputation).toBe(reputation);
  });

  it("resolves same-tick risky arrivals in vehicle ID order, drawing for each in turn", () => {
    const data = withRiskyRoutes({ riskPpm: 500_000, seizureSharePpm: 500_000, delayTicks: 60, dealGraceTicks: 120 });
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const g = start(twoTruckSetup(data, seed));
      edit(g, (s) => withStock(s, "basic", 4));
      const route = riskyRoute(CROSSROADS_ROADHOUSE, data);
      const rng = g.sim.state.rng.routes;
      const a = dispatchSale(g, CROSSROADS_ROADHOUSE, 1, route.id, MODEL_TT_TRUCK);
      const b = dispatchSale(g, CROSSROADS_ROADHOUSE, 1, route.id, SECOND_TRUCK);
      expect(a.arrivesAt).toBe(b.arrivesAt);
      to(g, a.arrivesAt);

      const byVehicle = new Map<VehicleId, Trip>([
        [MODEL_TT_TRUCK, a],
        [SECOND_TRUCK, b],
      ]);
      const order = [...byVehicle.keys()].sort(compareIds).map((id) => byVehicle.get(id)!);
      let current = rng;
      const indexes: number[] = [];
      for (const trip of order) {
        const draw = expectedDraw(current, route);
        current = draw.rng;
        const key = draw.outcome === "SEIZE" ? keys.loss(trip.deliveryId) : draw.outcome === "DELAY" ? keys.delay(trip.deliveryId) : keys.clear(trip.deliveryId);
        expect(outcomeKeysOf(g.sim.state, trip.deliveryId), `seed ${seed}`).toEqual([key]);
        indexes.push(indexOfKey(g.sim.state, key));
      }
      expect(g.sim.state.rng.routes, `seed ${seed}`).toEqual(current);
      expect(indexes[0]!).toBeLessThan(indexes[1]!);
    }
  });

  it("property: on the shipped risky route the outcome follows the two draws, and only the matching outcome transaction exists", { timeout: 60_000 }, () => {
    const route = riskyRoute(KESSLERS_BACK_ROOM);
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 0x7fff_ffff }), (seed) => {
        const g = start({ scenario: scenarioWith({ seed }) });
        edit(g, (s) => withStock(s, "basic", 2));
        const rng = g.sim.state.rng.routes;
        const t = dispatchSale(g, KESSLERS_BACK_ROOM, 2, route.id);
        to(g, t.arrivesAt);
        const draw = expectedDraw(rng, route);
        const expected =
          draw.outcome === "SEIZE" ? keys.loss(t.deliveryId) : draw.outcome === "DELAY" ? keys.delay(t.deliveryId) : keys.clear(t.deliveryId);
        expect(outcomeKeysOf(g.sim.state, t.deliveryId)).toEqual([expected]);
        expect(g.sim.state.rng.routes).toEqual(draw.rng);
        expect(deliveryOf(g.sim.state, t.deliveryId).status).toBe(
          draw.outcome === "SEIZE" ? "FAILED" : draw.outcome === "DELAY" ? "OUTBOUND" : "DELIVERED",
        );
      }),
      { numRuns: 40, seed: 0x7e03 },
    );
  });
});

// ===========================================================================
// Deal deadline (decision 4)
// ===========================================================================

describe("T03 deal deadline (decision 4)", () => {
  it("a delayed sale on the shipped numbers falls through TOO_LATE, and its cargo comes home unreserved at cost", () => {
    const data = withRiskyRoutes(FORCE_DELAY); // shipped delayTicks 240 > dealGraceTicks 120
    const g = start({ data });
    edit(g, (s) => withStock(s, "basic", 6));
    const reputation = g.sim.state.family.reputation;
    const buyerBefore = buyerOf(g.sim.state, CROSSROADS_ROADHOUSE);
    const poolBefore = poolOf(g.sim.state);
    const t = dispatchSale(g, CROSSROADS_ROADHOUSE, 4, riskyRoute(CROSSROADS_ROADHOUSE, data).id);
    const { delayTicks, dealGraceTicks } = tuning(t.route);
    expect(delayTicks).toBeGreaterThan(dealGraceTicks);
    to(g, t.arrivesAt);
    const rngAfterDraw = g.sim.state.rng.routes;
    const lateAt = t.arrivesAt + delayTicks;
    to(g, lateAt);

    const s = g.sim.state;
    expect(s.rng.routes).toEqual(rngAfterDraw);
    const tx = oneTx(s, keys.fellThrough(t.deliveryId));
    expect(tx).toMatchObject({ kind: "DISPATCH", tick: lateAt, entries: [] });
    expect(eventsOf(g, tx)).toEqual([
      { type: "DEAL_FELL_THROUGH", id: tx.eventIds[0], tick: lateAt, causedBy: null, deliveryId: t.deliveryId, buyerId: CROSSROADS_ROADHOUSE, reason: "TOO_LATE" },
    ]);
    expect(deliveryOf(s, t.deliveryId)).toMatchObject({ status: "FAILED", cargo: [{ ...t.line, cost: t.cost }] });
    expect(buyerOf(s, CROSSROADS_ROADHOUSE)).toEqual(buyerBefore);
    expect(keyed(s, keys.sale(t.deliveryId))).toEqual([]);
    expect(tripOf(s)).toEqual({
      deliveryId: t.deliveryId,
      routeId: t.route.id,
      leg: "RETURN",
      departedAt: lateAt,
      arrivesAt: lateAt + t.route.durationTicks,
      delayed: false,
    });
    expect(outcomeKeysOf(s, t.deliveryId)).toEqual([keys.delay(t.deliveryId), keys.fellThrough(t.deliveryId)]);
    const reservations = s.reservations;

    to(g, lateAt + t.route.durationTicks);
    const end = g.sim.state;
    expect(truckOf(end).trip).toBeNull();
    const ret = oneTx(end, keys.ret(t.deliveryId));
    expectEntries(ret.entries, [...transportEntries(t.route.transportCost, balancesBefore(end, ret).CASH), ...returnFromTransitEntries(t.cost)]);
    expect(eventsOfType(eventsOf(g, ret), "VEHICLE_RETURNED")).toEqual([
      expect.objectContaining({ vehicleId: MODEL_TT_TRUCK, deliveryId: t.deliveryId, locationId: home.locationId, returnedCargo: [t.line] }),
    ]);
    expect(poolOf(end)).toEqual(poolBefore);
    expect(end.reservations).toEqual(reservations);
    expect(accountBalances(end.ledger.transactions).GOODS_IN_TRANSIT).toBe(0);
    expect(eventsOfType(g.events, "SALE_COMPLETED").filter((e) => e.deliveryId === t.deliveryId)).toEqual([]);
    expect(eventsOfType(g.events, "REPUTATION_CHANGED")).toEqual([]);
    expect(end.family.reputation).toBe(reputation);
  });

  it("an arrival exactly at the deadline still sells; one tick later falls through", () => {
    for (const late of [0, 1]) {
      const data = withRiskyRoutes({ ...FORCE_DELAY, dealGraceTicks: 50, delayTicks: 50 + late });
      const g = start({ data });
      edit(g, (s) => withStock(s, "basic", 2));
      const t = dispatchSale(g, CROSSROADS_ROADHOUSE, 2, riskyRoute(CROSSROADS_ROADHOUSE, data).id);
      expect(deliveryOf(g.sim.state, t.deliveryId).dealDeadline).toBe(t.arrivesAt + 50);
      to(g, t.arrivesAt + 50 + late);
      const s = g.sim.state;
      if (late === 0) {
        expect(oneTx(s, keys.sale(t.deliveryId)).tick).toBe(t.arrivesAt + 50);
        expect(keyed(s, keys.fellThrough(t.deliveryId))).toEqual([]);
        expect(deliveryOf(s, t.deliveryId).status).toBe("DELIVERED");
      } else {
        expect(oneTx(s, keys.fellThrough(t.deliveryId)).tick).toBe(t.arrivesAt + 51);
        expect(keyed(s, keys.sale(t.deliveryId))).toEqual([]);
        expect(deliveryOf(s, t.deliveryId).status).toBe("FAILED");
      }
    }
  });

  it("returned cargo always unloads, even over storage capacity", () => {
    const data = withRiskyRoutes(FORCE_DELAY);
    const g = start({ data });
    edit(g, (s) => withStock(s, "basic", 4));
    const t = dispatchSale(g, CROSSROADS_ROADHOUSE, 4, riskyRoute(CROSSROADS_ROADHOUSE, data).id);
    to(g, t.arrivesAt + tuning(t.route).delayTicks);
    expect(deliveryOf(g.sim.state, t.deliveryId).status).toBe("FAILED");
    // Production filled the space while the truck was out.
    const storage = () => g.sim.snapshot().facilities.find((f) => f.id === DISTILLERY_MAIN)!.storage;
    const room = storage().capacity - storage().used;
    expect(room).toBeGreaterThan(0);
    edit(g, (s) => withStock(s, "basic", room));
    expect(storage().used).toBe(storage().capacity);

    untilHome(g);
    expect(poolOf(g.sim.state).quantity).toBe(storage().capacity + 4);
    expect(storage().used).toBeGreaterThan(storage().capacity);
    const ret = oneTx(g.sim.state, keys.ret(t.deliveryId));
    expect(eventsOfType(eventsOf(g, ret), "VEHICLE_RETURNED")[0]).toMatchObject({ returnedCargo: [t.line] });
  });
});

// ===========================================================================
// Contract trips (ADR 0018 paths kept; decisions 2–4 apply)
// ===========================================================================

describe("T03 contract trips", () => {
  /** Kessler's midnight offer, accepted with `stock` basic cases at the distillery. */
  function acceptedKessler(stock: number, setup: GameSetup = {}) {
    const g = start(setup);
    edit(g, (s) => withStock(s, "basic", stock));
    to(g, DAY);
    const offer = g.sim.state.contractOffers.find((o) => o.buyerId === KESSLERS_BACK_ROOM);
    if (!offer) throw new Error("No Kessler's offer at the first midnight");
    expectApplied(run(g, { type: "ACCEPT_CONTRACT", contractOfferId: offer.id }));
    const contract = g.sim.state.contracts.find((c) => c.offerId === offer.id);
    if (!contract) throw new Error("Accepting didn't create a contract");
    return { g, contractId: contract.id, quantity: contract.quantityPerInstallment };
  }

  function contractTrip(g: Game) {
    const trip = tripOf(g.sim.state);
    const delivery = deliveryOf(g.sim.state, trip.deliveryId);
    return { trip, delivery, route: routeById(trip.routeId, g.setup.data ?? GAME_DATA) };
  }

  it("has no deal deadline, is never rejected for lack of cash, and pays transport at return", () => {
    const { g, contractId, quantity } = acceptedKessler(8);
    edit(g, (s) => withCash(s, 0));
    expectApplied(run(g, deliverContract(contractId, quantity, null)));
    const { trip, delivery, route } = contractTrip(g);
    expect(route.id).toBe(safeRoute(KESSLERS_BACK_ROOM).id);
    expect(delivery.dealDeadline).toBeNull();
    untilHome(g);
    const ret = oneTx(g.sim.state, keys.ret(delivery.id));
    expect(ret.tick).toBe(trip.arrivesAt + route.durationTicks);
    expectEntries(ret.entries, transportEntries(route.transportCost, balancesBefore(g.sim.state, ret).CASH));
  });

  it("a delayed contract trip still delivers late and credits the installment (no deadline, no DEAL_FELL_THROUGH)", () => {
    const data = withRiskyRoutes(FORCE_DELAY);
    const { g, contractId, quantity } = acceptedKessler(8, { data });
    expectApplied(run(g, deliverContract(contractId, quantity, riskyRoute(KESSLERS_BACK_ROOM, data).id)));
    const { trip, delivery, route } = contractTrip(g);
    to(g, trip.arrivesAt);
    oneTx(g.sim.state, keys.delay(delivery.id));
    expect(tripOf(g.sim.state).arrivesAt).toBe(trip.arrivesAt + tuning(route).delayTicks);
    to(g, trip.arrivesAt + tuning(route).delayTicks);

    const s = g.sim.state;
    const saleTx = oneTx(s, keys.sale(delivery.id));
    expect(eventsOfType(eventsOf(g, saleTx), "SALE_COMPLETED")[0]).toMatchObject({ deliveryId: delivery.id, contractId });
    expect(s.contracts.find((c) => c.id === contractId)!.installments[0]!.delivered).toBe(quantity);
    expect(keyed(s, keys.fellThrough(delivery.id))).toEqual([]);
    expect(eventsOfType(g.events, "DEAL_FELL_THROUGH")).toEqual([]);
    expect(deliveryOf(s, delivery.id).status).toBe("DELIVERED");
  });

  it("a seized contract trip writes the cargo off, credits nothing, and emits no DEAL_FELL_THROUGH", () => {
    const data = withRiskyRoutes(FORCE_SEIZE);
    const { g, contractId, quantity } = acceptedKessler(8, { data });
    expectApplied(run(g, deliverContract(contractId, quantity, riskyRoute(KESSLERS_BACK_ROOM, data).id)));
    const { trip, delivery, route } = contractTrip(g);
    const cost = delivery.cargo[0]!.cost;
    to(g, trip.arrivesAt);

    const s = g.sim.state;
    const tx = oneTx(s, keys.loss(delivery.id));
    expectEntries(tx.entries, cargoLossEntries(cost));
    const events = eventsOf(g, tx);
    expect(events.map((e) => e.type)).toEqual(["CARGO_LOST"]);
    expect(deliveryOf(s, delivery.id)).toMatchObject({ status: "FAILED", cargo: [] });
    expect(s.contracts.find((c) => c.id === contractId)!.installments[0]!.delivered).toBe(0);
    expect(tripOf(s)).toMatchObject({ leg: "RETURN", departedAt: trip.arrivesAt, arrivesAt: trip.arrivesAt + route.durationTicks, delayed: false });
    untilHome(g);
    const ret = oneTx(g.sim.state, keys.ret(delivery.id));
    expectEntries(ret.entries, transportEntries(route.transportCost, balancesBefore(g.sim.state, ret).CASH));
    expect(eventsOfType(g.events, "DEAL_FELL_THROUGH")).toEqual([]);
  });
});

// ===========================================================================
// Conservation (property)
// ===========================================================================

describe("T03 conservation (property)", () => {
  const STOCK = 12;

  /** Cargo still on a truck: a delivery a vehicle's trip carries that hasn't been delivered. */
  function inTransit(state: GameState) {
    let quantity = 0;
    let cost = 0;
    for (const v of state.vehicles) {
      if (!v.trip) continue;
      const d = deliveryOf(state, v.trip.deliveryId);
      if (d.status === "DELIVERED") continue;
      for (const line of d.cargo) {
        quantity += line.quantity;
        cost += line.cost;
      }
    }
    return { quantity, cost };
  }

  function exitsOf(events: readonly GameEvent[], deliveryId: string): number {
    return (
      eventsOfType(events, "SALE_COMPLETED").filter((e) => e.deliveryId === deliveryId).length +
      eventsOfType(events, "CARGO_LOST").filter((e) => e.deliveryId === deliveryId).length +
      eventsOfType(events, "VEHICLE_RETURNED").filter((e) => e.deliveryId === deliveryId && e.returnedCargo.length > 0).length
    );
  }

  function expectConserved(g: Game, deliveryIds: readonly string[]): void {
    const s = g.sim.state;
    const sold = eventsOfType(g.events, "SALE_COMPLETED").reduce((n, e) => n + e.cargo.reduce((m, l) => m + l.quantity, 0), 0);
    const lost = eventsOfType(g.events, "CARGO_LOST").reduce((n, e) => n + e.cargo.reduce((m, l) => m + l.quantity, 0), 0);
    const transit = inTransit(s);
    expect(poolOf(s).quantity + transit.quantity + sold + lost, `cases at ${s.tick}`).toBe(STOCK);
    const balances = accountBalances(s.ledger.transactions);
    expect(balances.GOODS_IN_TRANSIT, `in transit at ${s.tick}`).toBe(transit.cost);
    expect(balances.FINISHED_GOODS, `finished goods at ${s.tick}`).toBe(s.productPools.reduce((n, p) => n + p.totalCost, 0));
    expect(balances.CASH).toBeGreaterThanOrEqual(0);
    for (const t of s.ledger.transactions) {
      const debits = t.entries.filter((e) => e.side === "DEBIT").reduce((n, e) => n + e.amount, 0);
      const credits = t.entries.filter((e) => e.side === "CREDIT").reduce((n, e) => n + e.amount, 0);
      expect(debits, t.idempotencyKey).toBe(credits);
    }
    for (const id of deliveryIds) expect(exitsOf(g.events, id), id).toBeLessThanOrEqual(1);
  }

  it(
    "property: cargo enters transit at dispatch and leaves it exactly once (sold, lost, or returned), with the ledger matching every tick",
    { timeout: 180_000 },
    () => {
      const tripArb = fc.record({
        buyerId: fc.constantFrom(CROSSROADS_ROADHOUSE, KESSLERS_BACK_ROOM),
        risky: fc.boolean(),
        quantity: fc.integer({ min: 1, max: 4 }),
      });
      fc.assert(
        fc.property(
          fc.record({
            seed: fc.integer({ min: 1, max: 0x7fff_ffff }),
            riskPpm: fc.constantFrom(150_000, 500_000, PPM),
            seizureSharePpm: fc.constantFrom(0, 333_334, PPM),
            delayTicks: fc.integer({ min: 1, max: 300 }),
            dealGraceTicks: fc.integer({ min: 0, max: 300 }),
            trips: fc.array(tripArb, { minLength: 1, maxLength: 3 }),
          }),
          (p) => {
            const data = withRiskyRoutes({ riskPpm: p.riskPpm, seizureSharePpm: p.seizureSharePpm, delayTicks: p.delayTicks, dealGraceTicks: p.dealGraceTicks });
            const g = start({ data, scenario: scenarioWith({ seed: p.seed }) });
            edit(g, (s) => withStock(s, "basic", STOCK));
            const deliveryIds: string[] = [];
            for (const trip of p.trips) {
              const s = g.sim.state;
              const want = wantOf(s, trip.buyerId);
              const affordable = Math.floor(buyerOf(s, trip.buyerId).budgetRemaining / want.unitPrice);
              const quantity = Math.min(trip.quantity, want.demandRemaining, affordable, poolOf(s).quantity);
              if (quantity <= 0) continue;
              const routeId = trip.risky ? riskyRoute(trip.buyerId, data).id : null;
              const t = dispatchSale(g, trip.buyerId, quantity, routeId);
              deliveryIds.push(t.deliveryId);
              expectConserved(g, deliveryIds);
              const stop = g.sim.state.tick + 2 * DAY;
              while (truckOf(g.sim.state).trip !== null) {
                if (g.sim.state.tick >= stop) throw new Error("Truck didn't get home");
                to(g, g.sim.state.tick + 1);
                expectConserved(g, deliveryIds);
              }
              expect(exitsOf(g.events, t.deliveryId), t.deliveryId).toBe(1);
            }
          },
        ),
        { numRuns: 20, seed: 0x10ad },
      );
    },
  );
});

// ===========================================================================
// Recoverable choice (GDD §10, §4 action 8)
// ===========================================================================

describe("T03 recoverable choice", () => {
  it("the risky route saves time and cost against an expected loss; the safe route has none", () => {
    for (const buyerId of BUYER_IDS) {
      const safe = safeRoute(buyerId);
      const risky = riskyRoute(buyerId);
      const { seizureSharePpm, delayTicks, dealGraceTicks } = tuning(risky);
      // What the player saves per trip by taking the risk.
      const ticksSaved = safe.durationTicks - risky.durationTicks;
      const centsSaved = safe.transportCost - risky.transportCost;
      expect(ticksSaved, buyerId).toBeGreaterThan(0);
      expect(centsSaved, buyerId).toBeGreaterThan(0);
      // What it can cost: per million trips, seized loads (goods lost) and
      // delayed sales (a delay always outlasts the grace, so the deal falls through).
      const seizedPerMillion = (risky.riskPpm * seizureSharePpm) / PPM;
      const fellThroughPerMillion = risky.riskPpm - seizedPerMillion;
      expect(seizedPerMillion, buyerId).toBeGreaterThan(0);
      expect(fellThroughPerMillion, buyerId).toBeGreaterThan(0);
      expect(delayTicks).toBeGreaterThan(dealGraceTicks);
      // A full truck of basic stock at 700¢ a case: the expected write-off per trip.
      const expectedLossCents = (20 * 700 * seizedPerMillion) / PPM;
      expect(expectedLossCents).toBeGreaterThan(0);
      expect(safe.riskPpm).toBe(0);
    }
  });

  it("after a seizure the truck comes home and the player can dispatch again, even with no cash", () => {
    const data = withRiskyRoutes(FORCE_SEIZE);
    const g = start({ data });
    edit(g, (s) => withStock(s, "basic", 8));
    dispatchSale(g, CROSSROADS_ROADHOUSE, 4, riskyRoute(CROSSROADS_ROADHOUSE, data).id);
    untilHome(g);
    edit(g, (s) => withCash(s, 0));
    const again = dispatchSale(g, CROSSROADS_ROADHOUSE, 4, null);
    untilHome(g);
    expect(deliveryOf(g.sim.state, again.deliveryId).status).toBe("DELIVERED");
  });

  it("after a deal falls through the returned cases can be sold on the safe route", () => {
    const data = withRiskyRoutes(FORCE_DELAY);
    const g = start({ data });
    edit(g, (s) => withStock(s, "basic", 4));
    const failed = dispatchSale(g, CROSSROADS_ROADHOUSE, 4, riskyRoute(CROSSROADS_ROADHOUSE, data).id);
    untilHome(g);
    expect(deliveryOf(g.sim.state, failed.deliveryId).status).toBe("FAILED");
    expect(poolOf(g.sim.state).quantity).toBe(4);
    const again = dispatchSale(g, CROSSROADS_ROADHOUSE, 4, null);
    untilHome(g);
    const saleTx = oneTx(g.sim.state, keys.sale(again.deliveryId));
    expectEntries(saleTx.entries, saleEntries({ revenue: saleTx.entries.find((e) => e.account === "SALES_REVENUE")!.amount, costOfGoodsSold: failed.cost }));
  });
});

// ===========================================================================
// Route closures (decision 5)
// ===========================================================================

describe("T03 route closures (decision 5)", () => {
  function closeAt(g: Game, routeId: RouteId, at: number, durationTicks: number | null, reason: "RIVAL" | "POLICE" = "POLICE"): void {
    edit(g, (s) => scheduleWorldEvent(s, { kind: "ROUTE_CLOSURE", tick: tick(at), routeId, reason, durationTicks }));
  }

  function reopenAt(g: Game, routeId: RouteId, at: number): void {
    edit(g, (s) => scheduleWorldEvent(s, { kind: "ROUTE_REOPENING", tick: tick(at), routeId }));
  }

  const closureOf = (state: GameState, routeId: RouteId) => state.routes.find((r) => r.id === routeId)!.closure;
  const reopeningsOf = (state: GameState, routeId: RouteId) =>
    state.scheduledEvents.filter((e) => e.kind === "ROUTE_REOPENING" && e.routeId === routeId).map((e) => e.tick);

  it("closes a route for its duration in a keyed no-entry DAILY_SETTLEMENT, rejects dispatch onto it, and reopens on schedule", () => {
    const g = start();
    edit(g, (s) => withStock(s, "basic", 4));
    const risky = riskyRoute(CROSSROADS_ROADHOUSE);
    closeAt(g, risky.id, 10, 100);
    to(g, 10);

    const s = g.sim.state;
    expect(closureOf(s, risky.id)).toEqual({ reason: "POLICE", reopensAt: 110 });
    const tx = oneTx(s, keys.closure(risky.id, 10));
    expect(tx).toMatchObject({ kind: "DAILY_SETTLEMENT", tick: 10, entries: [] });
    expect(eventsOf(g, tx)).toEqual([{ type: "ROUTE_CLOSED", id: tx.eventIds[0], tick: 10, causedBy: null, routeId: risky.id, reason: "POLICE", reopensAt: 110 }]);
    expect(reopeningsOf(s, risky.id)).toEqual([110]);
    expect(g.sim.snapshot().routes.find((r) => r.id === risky.id)!.status).toEqual({ open: false, reopensAt: 110, reason: "POLICE" });
    // The other route to the same buyer stays open.
    expect(closureOf(s, safeRoute(CROSSROADS_ROADHOUSE).id)).toBeNull();

    expect(expectRejected(g, sale(g, CROSSROADS_ROADHOUSE, 4, { routeId: risky.id }), "ROUTE_CLOSED")).toEqual({
      code: "ROUTE_CLOSED",
      routeId: risky.id,
      reopensAt: 110,
    });

    to(g, 110);
    const reopened = oneTx(g.sim.state, keys.reopening(risky.id, 110));
    expect(reopened).toMatchObject({ kind: "DAILY_SETTLEMENT", tick: 110, entries: [] });
    expect(eventsOf(g, reopened)).toEqual([{ type: "ROUTE_REOPENED", id: reopened.eventIds[0], tick: 110, causedBy: null, routeId: risky.id }]);
    expect(closureOf(g.sim.state, risky.id)).toBeNull();
    expectApplied(run(g, sale(g, CROSSROADS_ROADHOUSE, 4, { routeId: risky.id })));
  });

  it("a closure with no duration has reopensAt null, schedules nothing, and a later ROUTE_REOPENING clears it", () => {
    const g = start();
    const route = safeRoute(KESSLERS_BACK_ROOM);
    closeAt(g, route.id, 5, null, "RIVAL");
    to(g, 5);
    expect(closureOf(g.sim.state, route.id)).toEqual({ reason: "RIVAL", reopensAt: null });
    expect(eventsOf(g, oneTx(g.sim.state, keys.closure(route.id, 5)))[0]).toMatchObject({ type: "ROUTE_CLOSED", reopensAt: null });
    expect(reopeningsOf(g.sim.state, route.id)).toEqual([]);
    to(g, 400);
    expect(closureOf(g.sim.state, route.id)).not.toBeNull();

    reopenAt(g, route.id, 500);
    to(g, 500);
    expect(closureOf(g.sim.state, route.id)).toBeNull();
    expect(eventsOf(g, oneTx(g.sim.state, keys.reopening(route.id, 500)))[0]).toMatchObject({ type: "ROUTE_REOPENED", routeId: route.id });
  });

  it("a new closure replaces the current one, and the stale reopening is a no-op with no transaction", () => {
    const g = start();
    const route = riskyRoute(KESSLERS_BACK_ROOM);
    closeAt(g, route.id, 10, 100); // reopens at 110
    closeAt(g, route.id, 50, 200, "RIVAL"); // replaces it: reopens at 250
    to(g, 50);
    expect(closureOf(g.sim.state, route.id)).toEqual({ reason: "RIVAL", reopensAt: 250 });
    expect(eventsOf(g, oneTx(g.sim.state, keys.closure(route.id, 50)))[0]).toMatchObject({ type: "ROUTE_CLOSED", reason: "RIVAL", reopensAt: 250 });

    to(g, 110);
    expect(closureOf(g.sim.state, route.id)).toEqual({ reason: "RIVAL", reopensAt: 250 });
    expect(keyed(g.sim.state, keys.reopening(route.id, 110))).toEqual([]);
    expect(eventsOfType(g.events, "ROUTE_REOPENED")).toEqual([]);

    to(g, 250);
    expect(closureOf(g.sim.state, route.id)).toBeNull();
    oneTx(g.sim.state, keys.reopening(route.id, 250));
    expect(eventsOfType(g.events, "ROUTE_REOPENED")).toHaveLength(1);
  });

  it("a reopening for an open route is a no-op with no transaction", () => {
    const g = start();
    const route = safeRoute(CROSSROADS_ROADHOUSE);
    reopenAt(g, route.id, 20);
    const before = g.sim.state.ledger.transactions.length;
    to(g, 20);
    expect(closureOf(g.sim.state, route.id)).toBeNull();
    expect(keyed(g.sim.state, keys.reopening(route.id, 20))).toEqual([]);
    expect(g.sim.state.ledger.transactions.length).toBe(before);
    expect(eventsOfType(g.events, "ROUTE_REOPENED")).toEqual([]);
  });

  it("ignores a second closure of the same route on the same tick: the first wins", () => {
    const g = start();
    const route = riskyRoute(CROSSROADS_ROADHOUSE);
    closeAt(g, route.id, 30, 100, "POLICE");
    closeAt(g, route.id, 30, 300, "RIVAL");
    to(g, 30);
    expect(closureOf(g.sim.state, route.id)).toEqual({ reason: "POLICE", reopensAt: 130 });
    expect(keyed(g.sim.state, keys.closure(route.id, 30))).toHaveLength(1);
    expect(eventsOfType(g.events, "ROUTE_CLOSED")).toHaveLength(1);
    expect(reopeningsOf(g.sim.state, route.id)).toEqual([130]);
  });

  it("leaves trips in flight alone: a truck on a route that closes still arrives, sells, and comes home on time", () => {
    const g = start();
    edit(g, (s) => withStock(s, "basic", 4));
    const t = dispatchSale(g, CROSSROADS_ROADHOUSE, 4, null);
    closeAt(g, t.route.id, t.departedAt + 10, null);
    to(g, t.arrivesAt);
    expect(closureOf(g.sim.state, t.route.id)).not.toBeNull();
    expect(oneTx(g.sim.state, keys.sale(t.deliveryId)).tick).toBe(t.arrivesAt);
    to(g, t.arrivesAt + t.route.durationTicks);
    expect(truckOf(g.sim.state).trip).toBeNull();
    oneTx(g.sim.state, keys.ret(t.deliveryId));
  });
});
