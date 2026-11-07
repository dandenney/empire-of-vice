// T03b (#76): TRANSFER between owned facilities and the warehouse.
//
// Fixtures own the warehouse through a scenario that lists it (the First
// Shipment scenario doesn't, ADR 0020 decision 13), so the game has state for
// the depot routes (route state only for occupied routes, #76 option 1).

import fc from "fast-check";
import { addMoney, asId, cents, idempotencyKey, ZERO_MONEY, type GameCommand, type GameEvent, type FacilityId, type GameState, type Money, type RejectionCode, type RouteId } from "@eov/contracts";
import {
  DEPOT_ROAD,
  DISTILLERY_MAIN,
  FIRST_SHIPMENT_SCENARIO,
  GAME_DATA,
  MODEL_TT_TRUCK,
  MOONSHINE,
  RIVERSIDE_WAREHOUSE,
  STATE_HIGHWAY,
  type GameData,
  type RouteDefinition,
  type ScenarioDefinition,
} from "@eov/game-data";
import { describe, expect, it } from "vitest";
import { createCoordinator, createSimulation, newGame, simulationOptions, type GameSetup, type KernelSimulation } from "../../src/index.ts";
import { checkInvariants } from "../../src/game/index.ts";
import { addProduct } from "../../src/inventory/index.ts";

const PPM = 1_000_000;
const depotRoad = GAME_DATA.routes.find((r) => r.id === DEPOT_ROAD)!;
const UNIT_COST = 700;
const NO_SUCH_FACILITY = asId("Facility", "no-such-facility");

const OWNS_WAREHOUSE: ScenarioDefinition = {
  ...FIRST_SHIPMENT_SCENARIO,
  facilities: [...FIRST_SHIPMENT_SCENARIO.facilities, { id: RIVERSIDE_WAREHOUSE, equipmentIds: [], workerCount: 0 }],
};

function withWarehouseStorage(baseStorage: number, data: GameData = GAME_DATA): GameData {
  return {
    ...data,
    facilityProduction: data.facilityProduction.map((f) => (f.facilityId === RIVERSIDE_WAREHOUSE ? { ...f, baseStorage } : f)),
  };
}

function withDepotRoad(patch: Partial<RouteDefinition>, data: GameData = GAME_DATA): GameData {
  return { ...data, routes: data.routes.map((r) => (r.id === DEPOT_ROAD ? { ...r, ...patch } : r)) };
}

/** Books `quantity` cases of basic moonshine at `facilityId` against owner equity. */
function stocked(state: GameState, facilityId: typeof DISTILLERY_MAIN, quantity: number, unitCost = UNIT_COST): GameState {
  if (quantity === 0) return state;
  const cost = cents(unitCost * quantity);
  const tx = createCoordinator().begin(state, {
    kind: "OPENING_BALANCE",
    idempotencyKey: `OPENING_BALANCE:fixture:${facilityId}`,
    tick: state.tick,
    causedBy: null,
  });
  if (tx.status === "duplicate") throw new Error("fixture key collision");
  tx.update((s) => addProduct(s, facilityId, MOONSHINE, "basic", quantity, cost));
  tx.post([
    { account: "FINISHED_GOODS", side: "DEBIT", amount: cost },
    { account: "OWNER_EQUITY", side: "CREDIT", amount: cost },
  ]);
  const result = tx.commit();
  if (result.status !== "committed") throw new Error(JSON.stringify(result.reason));
  return result.state;
}

interface Fixture {
  readonly scenario?: ScenarioDefinition;
  readonly data?: GameData;
  readonly home?: number;
  readonly warehouse?: number;
  readonly homeUnitCost?: number;
}

function game({ scenario = OWNS_WAREHOUSE, data = GAME_DATA, home = 20, warehouse = 0, homeUnitCost = UNIT_COST }: Fixture = {}): KernelSimulation {
  const setup: GameSetup = { scenario, data };
  let state = newGame(setup).state;
  state = stocked(state, DISTILLERY_MAIN, home, homeUnitCost);
  state = stocked(state, RIVERSIDE_WAREHOUSE, warehouse);
  return createSimulation(state, simulationOptions(setup));
}

function transfer(quantity: number, destinationFacilityId: FacilityId = RIVERSIDE_WAREHOUSE, routeId: RouteId | null = null): GameCommand {
  return {
    type: "DISPATCH_DELIVERY",
    vehicleId: MODEL_TT_TRUCK,
    cargo: [{ productId: MOONSHINE, quality: "basic", quantity }],
    purpose: { kind: "TRANSFER", destinationFacilityId },
    routeId,
  };
}

function pool(state: GameState, facilityId: string) {
  return state.productPools.find((p) => p.facilityId === facilityId && p.productId === MOONSHINE && p.quality === "basic");
}

const quantityAt = (state: GameState, facilityId: string) => pool(state, facilityId)?.quantity ?? 0;
const costAt = (state: GameState, facilityId: string): Money => pool(state, facilityId)?.totalCost ?? ZERO_MONEY;
const netWorth = (sim: KernelSimulation) => sim.snapshot().finance.netWorth;
const txByKey = (state: GameState, key: string) => state.ledger.transactions.filter((t) => t.idempotencyKey === key);
const ofType = <T extends GameEvent["type"]>(events: readonly GameEvent[], type: T) =>
  events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === type);

function dispatchOk(sim: KernelSimulation, command: GameCommand): void {
  const result = sim.dispatch({ command });
  if (result.status !== "applied") throw new Error(`Expected applied, got ${JSON.stringify(result)}`);
}

function expectRejected(sim: KernelSimulation, command: GameCommand, code: RejectionCode) {
  sim.takeEvents();
  const before = sim.stateHash();
  const result = sim.dispatch({ command });
  if (result.status !== "rejected") throw new Error(`Expected rejected, got ${JSON.stringify(result)}`);
  expect(result.reason.code).toBe(code);
  // Rule 6: nothing changed.
  expect(sim.stateHash()).toBe(before);
  expect(sim.takeEvents()).toEqual([]);
  return result.reason;
}

/** Advances to the end of the truck's current leg. */
function toLegEnd(sim: KernelSimulation): void {
  sim.advance(sim.state.vehicles[0]!.trip!.arrivesAt - sim.state.tick);
}

function expectClean(state: GameState): void {
  const last = state.ledger.transactions.at(-1)!;
  expect(checkInvariants(state, last)).toEqual([]);
}

describe("T03b transfer dispatch and arrival", () => {
  it("moves cargo home → in transit → warehouse at book value, exactly once, without changing net worth", () => {
    const sim = game({ home: 10 });
    const worth = netWorth(sim);
    const homeCost = costAt(sim.state, DISTILLERY_MAIN);

    dispatchOk(sim, transfer(4));
    const delivery = sim.state.deliveries.find((d) => d.id === "delivery-1")!;
    const moved = delivery.cargo[0]!.cost;
    expect(moved).toBe(cents(4 * UNIT_COST));
    expect(delivery).toMatchObject({ status: "OUTBOUND", routeId: DEPOT_ROAD, dealDeadline: null, fromFacilityId: DISTILLERY_MAIN });
    expect(quantityAt(sim.state, DISTILLERY_MAIN)).toBe(6);
    expect(costAt(sim.state, DISTILLERY_MAIN)).toBe(homeCost - moved);
    expect(netWorth(sim)).toBe(worth);
    expectClean(sim.state);

    const trip = sim.state.vehicles[0]!.trip!;
    expect(trip).toMatchObject({ leg: "OUTBOUND", arrivesAt: trip.departedAt + depotRoad.durationTicks });
    sim.takeEvents();
    sim.advance(trip.arrivesAt - sim.state.tick);
    const events = sim.takeEvents();

    expect(quantityAt(sim.state, RIVERSIDE_WAREHOUSE)).toBe(4);
    expect(costAt(sim.state, RIVERSIDE_WAREHOUSE)).toBe(moved);
    expect(ofType(events, "TRANSFER_COMPLETED")).toEqual([
      expect.objectContaining({
        deliveryId: "delivery-1",
        destinationFacilityId: RIVERSIDE_WAREHOUSE,
        cargo: [{ productId: MOONSHINE, quality: "basic", quantity: 4 }],
        bookValue: moved,
      }),
    ]);
    const [arrival] = txByKey(sim.state, idempotencyKey("TRANSFER", "delivery-1"));
    expect(arrival).toMatchObject({ kind: "TRANSFER" });
    expect(arrival!.entries).toEqual([
      { account: "FINISHED_GOODS", side: "DEBIT", amount: moved },
      { account: "GOODS_IN_TRANSIT", side: "CREDIT", amount: moved },
    ]);
    expect(sim.state.deliveries[0]).toMatchObject({ status: "DELIVERED" });
    expect(sim.state.vehicles[0]!.trip).toMatchObject({ leg: "RETURN", deliveryId: "delivery-1" });
    expect(netWorth(sim)).toBe(worth);
    expectClean(sim.state);

    // Home: the transport cost is charged like any trip, and nothing comes back.
    toLegEnd(sim);
    const back = sim.takeEvents();
    expect(sim.state.vehicles[0]!.trip).toBeNull();
    expect(ofType(back, "VEHICLE_RETURNED")).toEqual([expect.objectContaining({ deliveryId: "delivery-1", returnedCargo: [] })]);
    expect(netWorth(sim)).toBe(worth - depotRoad.transportCost);
    expect(quantityAt(sim.state, RIVERSIDE_WAREHOUSE)).toBe(4);
    expect(quantityAt(sim.state, DISTILLERY_MAIN)).toBe(6);
    expect(txByKey(sim.state, idempotencyKey("TRANSFER", "delivery-1"))).toHaveLength(1);
    expect(ofType(back, "TRANSFER_COMPLETED")).toEqual([]);
    expectClean(sim.state);
  });

  it("unloads only what fits in the warehouse's storage and brings the rest home unreserved", () => {
    // Capacity 5 with 2 already held: 3 of the 7 cases fit.
    const partial = game({ data: withWarehouseStorage(5), home: 7, warehouse: 2, homeUnitCost: 333 });
    const before = netWorth(partial);
    dispatchOk(partial, transfer(7));
    const loaded = partial.state.deliveries[0]!.cargo[0]!.cost;
    partial.takeEvents();
    toLegEnd(partial);
    const arrived = partial.takeEvents();
    const unloadedCost = cents(999); // 3/7 of 2,331
    expect(loaded).toBe(cents(2_331));
    expect(ofType(arrived, "TRANSFER_COMPLETED")).toEqual([
      expect.objectContaining({ cargo: [{ productId: MOONSHINE, quality: "basic", quantity: 3 }], bookValue: unloadedCost }),
    ]);
    expect(quantityAt(partial.state, RIVERSIDE_WAREHOUSE)).toBe(5);
    expect(costAt(partial.state, RIVERSIDE_WAREHOUSE)).toBe(addMoney(cents(1_400), unloadedCost));
    // The rest stays aboard at the cost it still carries.
    expect(partial.state.deliveries[0]).toMatchObject({ status: "FAILED", cargo: [{ quantity: 4, cost: cents(2_331 - 999) }] });
    expect(netWorth(partial)).toBe(before);
    expectClean(partial.state);

    toLegEnd(partial);
    const home = partial.takeEvents();
    expect(ofType(home, "VEHICLE_RETURNED")).toEqual([
      expect.objectContaining({ returnedCargo: [{ productId: MOONSHINE, quality: "basic", quantity: 4 }] }),
    ]);
    expect(quantityAt(partial.state, DISTILLERY_MAIN)).toBe(4);
    expect(costAt(partial.state, DISTILLERY_MAIN)).toBe(cents(2_331 - 999));
    expect(partial.state.reservations).toEqual([]);
    expect(partial.state.deliveries[0]).toMatchObject({ status: "FAILED", cargo: [] });
    expect(netWorth(partial)).toBe(before - depotRoad.transportCost);
    expectClean(partial.state);
  });

  it("unloads nothing and emits no TRANSFER_COMPLETED when the destination is full", () => {
    const sim = game({ data: withWarehouseStorage(4), home: 3, warehouse: 4 });
    dispatchOk(sim, transfer(3));
    sim.takeEvents();
    toLegEnd(sim);
    const events = sim.takeEvents();
    expect(ofType(events, "TRANSFER_COMPLETED")).toEqual([]);
    expect(quantityAt(sim.state, RIVERSIDE_WAREHOUSE)).toBe(4);
    expect(sim.state.deliveries[0]).toMatchObject({ status: "FAILED", cargo: [{ quantity: 3, cost: cents(2_100) }] });
    expect(txByKey(sim.state, idempotencyKey("TRANSFER", "delivery-1"))[0]!.entries).toEqual([]);
    toLegEnd(sim);
    expect(quantityAt(sim.state, DISTILLERY_MAIN)).toBe(3);
    expect(costAt(sim.state, DISTILLERY_MAIN)).toBe(cents(2_100));
    expectClean(sim.state);
  });

  it("transfers only unreserved stock", () => {
    const sim = game({ home: 5 });
    const reserved: GameState = {
      ...sim.state,
      reservations: [
        {
          id: "reservation-99" as never,
          facilityId: DISTILLERY_MAIN,
          goods: { kind: "PRODUCT", productId: MOONSHINE, quality: "basic" },
          quantity: 3,
          holder: { kind: "CONTRACT", contractId: "contract-1" as never },
        },
      ],
    };
    const held = createSimulation(reserved, simulationOptions({ scenario: OWNS_WAREHOUSE }));
    const reason = expectRejected(held, transfer(3), "INSUFFICIENT_STOCK");
    expect(reason).toMatchObject({ requested: 3, available: 2 });
    dispatchOk(held, transfer(2));
    expect(held.state.reservations).toHaveLength(1);
  });
});

describe("T03b transfer rejections (rule 6)", () => {
  it("rejects an unknown facility, or one this game doesn't own, with UNKNOWN_ENTITY { Facility }", () => {
    const sim = game();
    expect(expectRejected(sim, transfer(1, NO_SUCH_FACILITY), "UNKNOWN_ENTITY")).toEqual({
      code: "UNKNOWN_ENTITY",
      kind: "Facility",
      id: "no-such-facility",
    });
    // The First Shipment scenario doesn't own the warehouse.
    const notOwned = game({ scenario: FIRST_SHIPMENT_SCENARIO });
    expect(expectRejected(notOwned, transfer(1), "UNKNOWN_ENTITY")).toEqual({ code: "UNKNOWN_ENTITY", kind: "Facility", id: RIVERSIDE_WAREHOUSE });
  });

  it("rejects the home facility itself, or a destination with no route, with NO_ROUTE", () => {
    expectRejected(game(), transfer(1, DISTILLERY_MAIN), "NO_ROUTE");
    const noRoad = game({ data: { ...GAME_DATA, routes: GAME_DATA.routes.filter((r) => r.id !== DEPOT_ROAD) } });
    expectRejected(noRoad, transfer(1), "NO_ROUTE");
    // A route that connects other places isn't a way to the warehouse.
    expectRejected(game(), transfer(1, RIVERSIDE_WAREHOUSE, STATE_HIGHWAY), "NO_ROUTE");
    expectRejected(game(), transfer(1, RIVERSIDE_WAREHOUSE, asId("Route", "no-such-road")), "UNKNOWN_ENTITY");
  });

  it("rejects a closed route with ROUTE_CLOSED", () => {
    const sim = game();
    const closed: GameState = {
      ...sim.state,
      routes: sim.state.routes.map((r) => (r.id === DEPOT_ROAD ? { ...r, closure: { reason: "RIVAL", reopensAt: null } } : r)),
    };
    const reason = expectRejected(createSimulation(closed, simulationOptions({ scenario: OWNS_WAREHOUSE })), transfer(1), "ROUTE_CLOSED");
    expect(reason).toEqual({ code: "ROUTE_CLOSED", routeId: DEPOT_ROAD, reopensAt: null });
  });

  it("rejects not enough stock with INSUFFICIENT_STOCK", () => {
    expect(expectRejected(game({ home: 2 }), transfer(3), "INSUFFICIENT_STOCK")).toMatchObject({ requested: 3, available: 2 });
    expectRejected(game({ home: 0 }), transfer(1), "INSUFFICIENT_STOCK");
  });

  it("keeps the vehicle and cargo checks ahead of the destination checks", () => {
    expectRejected(game(), transfer(0, NO_SUCH_FACILITY), "INVALID_QUANTITY");
    expectRejected(game(), transfer(21, NO_SUCH_FACILITY), "VEHICLE_CAPACITY_EXCEEDED");
  });
});

describe("T03b transfers roll no risk and touch no buyer", () => {
  it("arrives on time on a route with certain seizure, drawing nothing, and leaves buyers, quotes, markets and reputation alone", () => {
    const data = withDepotRoad({ riskPpm: PPM, seizureSharePpm: PPM });
    const sim = game({ data });
    const before = sim.state;
    dispatchOk(sim, transfer(5));
    sim.takeEvents();
    toLegEnd(sim);
    const events = sim.takeEvents();
    expect(ofType(events, "TRANSFER_COMPLETED")).toHaveLength(1);
    expect(events.map((e) => e.type)).not.toContain("CARGO_LOST");
    expect(events.map((e) => e.type)).not.toContain("DELIVERY_DELAYED");
    expect(sim.state.rng.routes).toEqual(before.rng.routes);
    expect(sim.state.buyers).toEqual(before.buyers);
    expect(sim.state.markets).toEqual(before.markets);
    expect(sim.state.family).toEqual(before.family);
    expect(sim.state.ledger.transactions.some((t) => t.kind === "CARGO_LOSS" || t.kind === "SALE")).toBe(false);
  });
});

describe("T03b exactly once (property)", () => {
  it("conserves cases and book value across any split, step pattern, and capacity", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 0, max: 10 }),
        fc.integer({ min: 0, max: 30 }),
        fc.integer({ min: 1, max: 999 }),
        fc.array(fc.integer({ min: 1, max: 50 }), { minLength: 1, maxLength: 20 }),
        (quantity, held, capacity, unitCost, steps) => {
          const sim = game({ data: withWarehouseStorage(capacity), home: quantity, warehouse: Math.min(held, capacity), homeUnitCost: unitCost });
          const startQty = quantityAt(sim.state, DISTILLERY_MAIN) + quantityAt(sim.state, RIVERSIDE_WAREHOUSE);
          const startCost = addMoney(costAt(sim.state, DISTILLERY_MAIN), costAt(sim.state, RIVERSIDE_WAREHOUSE));
          const warehouseBefore = quantityAt(sim.state, RIVERSIDE_WAREHOUSE);
          const worth = netWorth(sim);
          const room = Math.max(0, capacity - warehouseBefore);
          dispatchOk(sim, transfer(quantity));
          sim.takeEvents();
          const events: GameEvent[] = [];
          // Advance in arbitrary steps until well past the round trip.
          const end = 2 * depotRoad.durationTicks + 2;
          let i = 0;
          while (sim.state.tick < end) {
            sim.advance(Math.min(steps[i++ % steps.length]!, end - sim.state.tick));
            events.push(...sim.takeEvents());
            expectClean(sim.state);
          }
          const unloaded = Math.min(quantity, room);
          const completed = ofType(events, "TRANSFER_COMPLETED");
          expect(completed).toHaveLength(unloaded > 0 ? 1 : 0);
          expect(ofType(events, "VEHICLE_RETURNED")).toHaveLength(1);
          expect(txByKey(sim.state, idempotencyKey("TRANSFER", "delivery-1"))).toHaveLength(1);
          expect(quantityAt(sim.state, RIVERSIDE_WAREHOUSE)).toBe(warehouseBefore + unloaded);
          expect(quantityAt(sim.state, DISTILLERY_MAIN) + quantityAt(sim.state, RIVERSIDE_WAREHOUSE)).toBe(startQty);
          expect(addMoney(costAt(sim.state, DISTILLERY_MAIN), costAt(sim.state, RIVERSIDE_WAREHOUSE))).toBe(startCost);
          expect(netWorth(sim)).toBe(worth - depotRoad.transportCost);
        },
      ),
      { numRuns: 60 },
    );
  });
});
