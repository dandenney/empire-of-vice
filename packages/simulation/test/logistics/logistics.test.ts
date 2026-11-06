// T03 (#10): the points the orchestrator settled after the locked tests were
// written, which logistics.locked.test.ts deliberately leaves open:
// - a seizure emits CARGO_LOST, then DEAL_FELL_THROUGH { CARGO_LOST } (cause before consequence);
// - a too-late delivery's cargo, once the VEHICLE_RETURN transaction unloads it,
//   is emptied from the delivery, so a FAILED delivery's cargo is always cargo
//   still on a truck.

import { cents, idempotencyKey, type GameState, type RouteId } from "@eov/contracts";
import {
  CROSSROADS_ROADHOUSE,
  DISTILLERY_MAIN,
  FIRST_SHIPMENT_SCENARIO,
  GAME_DATA,
  MODEL_TT_TRUCK,
  MOONSHINE,
  type GameData,
  type RouteDefinition,
} from "@eov/game-data";
import { describe, expect, it } from "vitest";
import { createCoordinator, createSimulation, newGame, simulationOptions, type GameSetup, type KernelSimulation } from "../../src/index.ts";
import { addProduct } from "../../src/inventory/index.ts";

const PPM = 1_000_000;
const buyer = GAME_DATA.buyers.find((b) => b.id === CROSSROADS_ROADHOUSE)!;
const home = GAME_DATA.facilities.find((f) => f.id === DISTILLERY_MAIN)!;
const [safe, risky] = GAME_DATA.routes.filter((r) => r.fromLocationId === home.locationId && r.toLocationId === buyer.locationId) as [
  RouteDefinition,
  RouteDefinition,
];

function withRisky(patch: Partial<RouteDefinition>): GameData {
  return { ...GAME_DATA, routes: GAME_DATA.routes.map((r) => (r.id === risky.id ? { ...r, ...patch } : r)) };
}

/** A game with `quantity` cases of basic moonshine at the distillery, booked against owner equity. */
function gameWithStock(data: GameData, quantity: number): KernelSimulation {
  const setup: GameSetup = { scenario: FIRST_SHIPMENT_SCENARIO, data };
  const state = newGame(setup).state;
  const cost = cents(700 * quantity);
  const tx = createCoordinator().begin(state, { kind: "OPENING_BALANCE", idempotencyKey: "OPENING_BALANCE:fixture", tick: state.tick, causedBy: null });
  if (tx.status === "duplicate") throw new Error("fixture key collision");
  tx.update((s) => addProduct(s, DISTILLERY_MAIN, MOONSHINE, "basic", quantity, cost));
  tx.post([
    { account: "FINISHED_GOODS", side: "DEBIT", amount: cost },
    { account: "OWNER_EQUITY", side: "CREDIT", amount: cost },
  ]);
  const result = tx.commit();
  if (result.status !== "committed") throw new Error(JSON.stringify(result.reason));
  return createSimulation(result.state, simulationOptions(setup));
}

function dispatchSale(sim: KernelSimulation, routeId: RouteId, quantity: number): void {
  const unitPrice = sim.state.buyers.find((b) => b.id === CROSSROADS_ROADHOUSE)!.wants.find((w) => w.productId === MOONSHINE)!.unitPrice;
  const result = sim.dispatch({
    command: {
      type: "DISPATCH_DELIVERY",
      vehicleId: MODEL_TT_TRUCK,
      cargo: [{ productId: MOONSHINE, quality: "basic", quantity }],
      purpose: { kind: "SALE", buyerId: CROSSROADS_ROADHOUSE, agreedUnitPrice: unitPrice },
      routeId,
    },
  });
  expect(result.status).toBe("applied");
}

const tx = (state: GameState, key: string) => state.ledger.transactions.find((t) => t.idempotencyKey === key)!;
const delivery1 = (state: GameState) => state.deliveries.find((d) => d.id === "delivery-1")!;

describe("T03 settled points", () => {
  it("emits CARGO_LOST before DEAL_FELL_THROUGH { CARGO_LOST } in a seizure", () => {
    const sim = gameWithStock(withRisky({ riskPpm: PPM, seizureSharePpm: PPM }), 2);
    dispatchSale(sim, risky.id, 2);
    sim.advance(sim.state.vehicles[0]!.trip!.arrivesAt - sim.state.tick);
    const seizure = tx(sim.state, idempotencyKey("CARGO_LOSS", "delivery-1"));
    const types = seizure.eventIds.map((id) => sim.state.eventJournal.find((e) => e.id === id)!.type);
    expect(types).toEqual(["CARGO_LOST", "DEAL_FELL_THROUGH"]);
    expect(delivery1(sim.state)).toMatchObject({ status: "FAILED", cargo: [] });
  });

  it("empties a too-late delivery's cargo in the VEHICLE_RETURN that unloads it", () => {
    const sim = gameWithStock(withRisky({ riskPpm: PPM, seizureSharePpm: 0 }), 2);
    dispatchSale(sim, risky.id, 2);
    const arrivesAt = sim.state.vehicles[0]!.trip!.arrivesAt;
    sim.advance(arrivesAt + risky.delayTicks - sim.state.tick);
    // Fell through: FAILED with its cargo still aboard, heading home.
    expect(delivery1(sim.state)).toMatchObject({ status: "FAILED", cargo: [{ quantity: 2 }] });
    expect(sim.state.vehicles[0]!.trip).toMatchObject({ leg: "RETURN", deliveryId: "delivery-1" });
    sim.advance(risky.durationTicks);
    expect(sim.state.vehicles[0]!.trip).toBeNull();
    expect(delivery1(sim.state)).toMatchObject({ status: "FAILED", cargo: [] });
    expect(sim.state.productPools.find((p) => p.facilityId === DISTILLERY_MAIN)).toMatchObject({ quantity: 2, totalCost: cents(1_400) });
    // Transport plus the cargo coming home, in one transaction.
    expect(tx(sim.state, idempotencyKey("VEHICLE_RETURN", "delivery-1")).entries).toEqual([
      { account: "TRANSPORT_EXPENSE", side: "DEBIT", amount: risky.transportCost },
      { account: "CASH", side: "CREDIT", amount: risky.transportCost },
      { account: "FINISHED_GOODS", side: "DEBIT", amount: cents(1_400) },
      { account: "GOODS_IN_TRANSIT", side: "CREDIT", amount: cents(1_400) },
    ]);
  });

  it("keeps the safe default ahead of the risky alternative", () => {
    expect(safe.riskPpm).toBe(0);
    expect(risky.riskPpm).toBeGreaterThan(0);
  });
});
