// SK1c-2 (#226): sales on spec (ADR 0022 decision 6). Nothing is checked against
// the buyer at dispatch; on arrival the buyer takes what the world allows then,
// at that day's quote, following the transfer precedent: the accepted cases are
// sold (SALE_COMPLETED), the rest rides home on the FAILED path, and
// SPEC_SALE_SETTLED always reports offered vs accepted. A take of 0 is a no-entry
// DISPATCH:<id>:SPEC_SETTLED with DEAL_FELL_THROUGH { NOT_WANTED }.
//
// Founder rules off here, so the world is driven directly; the issuer-view and
// no-trap locked tests cover the order side with them on.

import { cents, idempotencyKey, ZERO_MONEY, type GameCommand, type GameEvent, type GameState } from "@eov/contracts";
import { CROSSROADS_ROADHOUSE, DISTILLERY_MAIN, FIRST_SHIPMENT_SCENARIO, GAME_DATA, MODEL_TT_TRUCK, MOONSHINE } from "@eov/game-data";
import { describe, expect, it } from "vitest";
import { accountBalances, createCoordinator, createSimulation, newGame, simulationOptions, type KernelSimulation } from "../../src/index.ts";
import { checkInvariants } from "../../src/game/index.ts";
import { addProduct, allocateRemovalCost } from "../../src/inventory/index.ts";

const UNIT_COST = 700;
const ROUTE = GAME_DATA.routes.find((r) => r.toLocationId === GAME_DATA.buyers.find((b) => b.id === CROSSROADS_ROADHOUSE)!.locationId && r.riskPpm === 0)!;

function stocked(state: GameState, quantity: number): GameState {
  const cost = cents(UNIT_COST * quantity);
  const tx = createCoordinator().begin(state, { kind: "OPENING_BALANCE", idempotencyKey: "OPENING_BALANCE:fixture:spec", tick: state.tick, causedBy: null });
  if (tx.status === "duplicate") throw new Error("fixture key collision");
  tx.update((s) => addProduct(s, DISTILLERY_MAIN, MOONSHINE, "basic", quantity, cost));
  tx.post([
    { account: "FINISHED_GOODS", side: "DEBIT", amount: cost },
    { account: "OWNER_EQUITY", side: "CREDIT", amount: cost },
  ]);
  const result = tx.commit();
  if (result.status !== "committed") throw new Error(JSON.stringify(result.reason));
  return result.state;
}

/** A game with `cases` of basic moonshine at home and the roadhouse's world edited by `buyer`. */
function game(cases: number, buyer: (b: GameState["buyers"][number]) => GameState["buyers"][number] = (b) => b): KernelSimulation {
  const scenario = FIRST_SHIPMENT_SCENARIO;
  const s = stocked(createSimulation(newGame({ scenario }).state, simulationOptions({ scenario })).state, cases);
  return createSimulation({ ...s, buyers: s.buyers.map((b) => (b.id === CROSSROADS_ROADHOUSE ? buyer(b) : b)) }, simulationOptions({ scenario }));
}

function onSpec(quantity: number): GameCommand {
  return {
    type: "DISPATCH_DELIVERY",
    vehicleId: MODEL_TT_TRUCK,
    cargo: [{ productId: MOONSHINE, quality: "basic", quantity }],
    purpose: { kind: "SALE", buyerId: CROSSROADS_ROADHOUSE, dealId: null },
    routeId: null,
    driver: { kind: "FOUNDER" },
  };
}

const roadhouse = (s: GameState) => s.buyers.find((b) => b.id === CROSSROADS_ROADHOUSE)!;
const basicWant = (s: GameState) => roadhouse(s).wants.find((w) => w.productId === MOONSHINE && w.minimumQuality === "basic")!;
const homeCases = (s: GameState) => s.productPools.filter((p) => p.facilityId === DISTILLERY_MAIN && p.productId === MOONSHINE).reduce((n, p) => n + p.quantity, 0);

/** Dispatches on spec and runs to the outbound arrival; returns the arrival's events and the delivery. */
function arrive(sim: KernelSimulation, quantity: number): { readonly events: readonly GameEvent[]; readonly deliveryId: string } {
  const result = sim.dispatch({ command: onSpec(quantity) });
  if (result.status !== "applied") throw new Error(JSON.stringify(result));
  const deliveryId = sim.state.deliveries.at(-1)!.id;
  expect(sim.state.deliveries.at(-1)).toMatchObject({ dealDeadline: null, purpose: { dealId: null } });
  sim.takeEvents();
  const arrivesAt = sim.state.vehicles[0]!.trip!.arrivesAt;
  sim.advance(arrivesAt - sim.state.tick);
  expect(sim.state.vehicles[0]!.trip).toMatchObject({ leg: "RETURN", departedAt: arrivesAt });
  return { events: sim.takeEvents(), deliveryId };
}

function home(sim: KernelSimulation): readonly GameEvent[] {
  sim.advance(sim.state.vehicles[0]!.trip!.arrivesAt - sim.state.tick);
  expect(sim.state.vehicles[0]!.trip).toBeNull();
  expect(checkInvariants(sim.state, sim.state.ledger.transactions.at(-1)!)).toEqual([]);
  return sim.takeEvents();
}

describe("a sale on spec arriving (ADR 0022 decision 6)", () => {
  it("everything taken: one SALE at the day's quote, DELIVERED, then SPEC_SALE_SETTLED", () => {
    const sim = game(3);
    const before = basicWant(sim.state);
    const budget = roadhouse(sim.state).budgetRemaining;
    const { events, deliveryId } = arrive(sim, 3);
    const price = basicWant(sim.state).unitPrice;
    expect(price).toBe(before.unitPrice);
    const sale = sim.state.ledger.transactions.find((t) => t.idempotencyKey === idempotencyKey("SALE", deliveryId))!;
    expect(sale.entries.length).toBeGreaterThan(0);
    expect(events.filter((e) => e.type === "SALE_COMPLETED" || e.type === "SPEC_SALE_SETTLED" || e.type === "DEAL_FELL_THROUGH")).toEqual([
      expect.objectContaining({ type: "SALE_COMPLETED", deliveryId, unitPrice: price, revenue: price * 3, costOfGoodsSold: UNIT_COST * 3, contractId: null }),
      expect.objectContaining({ type: "SPEC_SALE_SETTLED", deliveryId, buyerId: CROSSROADS_ROADHOUSE, offered: 3, accepted: 3, unitPrice: price }),
    ]);
    expect(sim.state.deliveries.find((d) => d.id === deliveryId)!.status).toBe("DELIVERED");
    // The buyer's demand and budget are spent at once; nothing is held as a commitment.
    expect(basicWant(sim.state).demandRemaining).toBe(before.demandRemaining - 3);
    expect(roadhouse(sim.state).budgetRemaining).toBe(budget - price * 3);
    expect(roadhouse(sim.state).commitments).toEqual([]);
    expect(home(sim).find((e) => e.type === "VEHICLE_RETURNED")).toMatchObject({ returnedCargo: [] });
  });

  it("part taken (budget-limited): the accepted cases sold, the rest FAILED and home unreserved at the cost they carry", () => {
    const sim0 = game(4);
    const price = basicWant(sim0.state).unitPrice;
    const sim = game(4, (b) => ({ ...b, budgetRemaining: cents(price * 2 + price - 1) }));
    const { events, deliveryId } = arrive(sim, 4);
    const cogs = allocateRemovalCost(cents(UNIT_COST * 4), 4, 2);
    expect(events.find((e) => e.type === "SALE_COMPLETED")).toMatchObject({ cargo: [{ productId: MOONSHINE, quality: "basic", quantity: 2 }], revenue: price * 2, costOfGoodsSold: cogs });
    expect(events.find((e) => e.type === "SPEC_SALE_SETTLED")).toMatchObject({ offered: 4, accepted: 2, unitPrice: price });
    expect(events.some((e) => e.type === "DEAL_FELL_THROUGH")).toBe(false);
    const delivery = sim.state.deliveries.find((d) => d.id === deliveryId)!;
    expect(delivery).toMatchObject({ status: "FAILED", cargo: [{ quantity: 2, cost: UNIT_COST * 4 - cogs }] });
    expect(roadhouse(sim.state).budgetRemaining).toBe(price - 1);
    const stock = homeCases(sim.state);
    expect(home(sim).find((e) => e.type === "VEHICLE_RETURNED")).toMatchObject({ returnedCargo: [{ quantity: 2 }] });
    expect(homeCases(sim.state)).toBe(stock + 2);
    expect(accountBalances(sim.state.ledger.transactions).GOODS_IN_TRANSIT).toBe(ZERO_MONEY);
  });

  it("nothing taken: a no-entry DISPATCH:<id>:SPEC_SETTLED, SPEC_SALE_SETTLED with 0, DEAL_FELL_THROUGH NOT_WANTED, and the cargo home", () => {
    const sim = game(2, (b) => ({ ...b, wants: b.wants.map((w) => ({ ...w, demandRemaining: 0 })) }));
    const price = basicWant(sim.state).unitPrice;
    const reputation = sim.state.family.reputation;
    const { events, deliveryId } = arrive(sim, 2);
    const tx = sim.state.ledger.transactions.find((t) => t.idempotencyKey === idempotencyKey("DISPATCH", deliveryId, "SPEC_SETTLED"));
    expect(tx).toMatchObject({ kind: "DISPATCH", entries: [] });
    expect(sim.state.ledger.transactions.some((t) => t.idempotencyKey === idempotencyKey("SALE", deliveryId))).toBe(false);
    expect(events.filter((e) => e.type === "SPEC_SALE_SETTLED" || e.type === "DEAL_FELL_THROUGH" || e.type === "SALE_COMPLETED")).toEqual([
      expect.objectContaining({ type: "SPEC_SALE_SETTLED", deliveryId, offered: 2, accepted: 0, unitPrice: price }),
      expect.objectContaining({ type: "DEAL_FELL_THROUGH", deliveryId, buyerId: CROSSROADS_ROADHOUSE, reason: "NOT_WANTED" }),
    ]);
    expect(tx!.eventIds).toHaveLength(2);
    expect(sim.state.deliveries.find((d) => d.id === deliveryId)).toMatchObject({ status: "FAILED", cargo: [{ quantity: 2, cost: UNIT_COST * 2 }] });
    const stock = homeCases(sim.state);
    home(sim);
    expect(homeCases(sim.state)).toBe(stock + 2);
    // No reputation change for a 0 take in M002.
    expect(sim.state.family.reputation).toBe(reputation);
  });

  it("nothing taken when the buyer doesn't want the product at all: the price reported is 0", () => {
    const sim = game(1, (b) => ({ ...b, wants: [] }));
    const { events } = arrive(sim, 1);
    expect(events.find((e) => e.type === "SPEC_SALE_SETTLED")).toMatchObject({ accepted: 0, unitPrice: 0 });
    expect(events.find((e) => e.type === "DEAL_FELL_THROUGH")).toMatchObject({ reason: "NOT_WANTED" });
  });

  it("the take is judged at arrival, at that day's quote, whatever the buyer looked like at dispatch", () => {
    const sim = game(2);
    const result = sim.dispatch({ command: onSpec(2) });
    if (result.status !== "applied") throw new Error(JSON.stringify(result));
    // The roadhouse fills up after the truck has left.
    sim.advance(1);
    const s = sim.state;
    const full = createSimulation(
      { ...s, buyers: s.buyers.map((b) => (b.id === CROSSROADS_ROADHOUSE ? { ...b, wants: b.wants.map((w) => ({ ...w, demandRemaining: 0 })) } : b)) },
      simulationOptions({ scenario: FIRST_SHIPMENT_SCENARIO }),
    );
    full.takeEvents();
    full.advance(ROUTE.durationTicks);
    expect(full.takeEvents().find((e) => e.type === "SPEC_SALE_SETTLED")).toMatchObject({ offered: 2, accepted: 0 });
  });
});

describe("a sale on spec on a risky road", () => {
  it("seized: CARGO_LOST writes it off and the truck turns home empty, with no deal to fall through", () => {
    const risky = GAME_DATA.routes.find((r) => r.toLocationId === ROUTE.toLocationId && r.fromLocationId === ROUTE.fromLocationId && r.riskPpm > 0)!;
    for (let seed = 1; seed <= 500; seed++) {
      const s = game(2).state;
      const sim = createSimulation({ ...s, seed }, simulationOptions({ scenario: FIRST_SHIPMENT_SCENARIO }));
      const result = sim.dispatch({ command: { ...onSpec(2), routeId: risky.id } as GameCommand });
      if (result.status !== "applied") throw new Error(JSON.stringify(result));
      const deliveryId = sim.state.deliveries.at(-1)!.id;
      sim.takeEvents();
      expect(sim.state.deliveries.at(-1)!.routeId).toBe(risky.id);
      sim.advance(sim.state.vehicles[0]!.trip!.arrivesAt - sim.state.tick);
      const events = sim.takeEvents();
      if (!events.some((e) => e.type === "CARGO_LOST")) continue;
      expect(events.some((e) => e.type === "DEAL_FELL_THROUGH" || e.type === "SPEC_SALE_SETTLED")).toBe(false);
      expect(sim.state.deliveries.find((d) => d.id === deliveryId)).toMatchObject({ status: "FAILED", cargo: [] });
      expect(roadhouse(sim.state).commitments).toEqual([]);
      expect(sim.state.vehicles[0]!.trip).toMatchObject({ leg: "RETURN" });
      return;
    }
    throw new Error("no seed in 1..500 seizes the first trip");
  });
});
