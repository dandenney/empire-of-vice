// Held deals and the deal dispatch (O1a, issue #192; ADR 0022 decision 6), with
// founder rules off. The locked ECO-001, logistics and repeat tests cover M001's
// sale through AGREE_DEAL; these cover what's new: the deal's own life (held,
// dispatched, expired, settled, fallen through), the dispatch's deal checks and
// their order, the deadline cap, and the shape fields (driver, tripCount, issuer).

import {
  asId,
  cents,
  idempotencyKey,
  type CommandResult,
  type DealId,
  type GameCommand,
  type GameEvent,
  type GameState,
  type QualityTier,
  type RejectionCode,
  type RejectionReason,
} from "@eov/contracts";
import {
  CROSSROADS_ROADHOUSE,
  DEAL_HOLD_TICKS,
  DEPOT_ROAD,
  DISTILLERY_MAIN,
  FIRST_SHIPMENT_SCENARIO,
  GAME_DATA,
  KESSLERS_BACK_ROOM,
  LAKEVIEW_HOTEL,
  MODEL_TT_TRUCK,
  MOONSHINE,
  RIVERSIDE_WAREHOUSE,
  type ScenarioDefinition,
} from "@eov/game-data";
import { describe, expect, it } from "vitest";
import { createCoordinator, createSimulation, newGame, simulationOptions, type KernelSimulation } from "../../../src/index.ts";
import { addProduct } from "../../../src/inventory/index.ts";

const ROADHOUSE_ROUTE = GAME_DATA.routes.find((r) => r.toLocationId === GAME_DATA.buyers.find((b) => b.id === CROSSROADS_ROADHOUSE)!.locationId && r.riskPpm === 0)!;

/** Books `quantity` basic cases at `facilityId` against owner equity. */
function stocked(state: GameState, quantity: number, facilityId = DISTILLERY_MAIN): GameState {
  const cost = cents(700 * quantity);
  const tx = createCoordinator().begin(state, { kind: "OPENING_BALANCE", idempotencyKey: `OPENING_BALANCE:fixture:${facilityId}`, tick: state.tick, causedBy: null });
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

function game(cases = 4, scenario: ScenarioDefinition = FIRST_SHIPMENT_SCENARIO): KernelSimulation {
  const state = stocked(createSimulation(newGame({ scenario }).state, simulationOptions({ scenario })).state, cases);
  return createSimulation(state, simulationOptions({ scenario }));
}

const quote = (s: GameState, buyerId = CROSSROADS_ROADHOUSE, quality: QualityTier = "basic") =>
  s.buyers.find((b) => b.id === buyerId)!.wants.find((w) => w.minimumQuality === quality)!.unitPrice;

function agree(sim: KernelSimulation, quantity = 1, buyerId = CROSSROADS_ROADHOUSE): DealId {
  const result = sim.dispatch({
    command: { type: "AGREE_DEAL", buyerId, productId: MOONSHINE, quality: "basic", quantity, agreedUnitPrice: quote(sim.state, buyerId) },
  });
  if (result.status !== "applied") throw new Error(`AGREE_DEAL: ${JSON.stringify(result)}`);
  return sim.state.heldDeals.at(-1)!.id;
}

function sale(dealId: DealId | null, quantity = 1, options: { buyerId?: typeof CROSSROADS_ROADHOUSE; quality?: QualityTier } = {}): GameCommand {
  return {
    type: "DISPATCH_DELIVERY",
    vehicleId: MODEL_TT_TRUCK,
    cargo: [{ productId: MOONSHINE, quality: options.quality ?? "basic", quantity }],
    purpose: { kind: "SALE", buyerId: options.buyerId ?? CROSSROADS_ROADHOUSE, dealId },
    routeId: null,
    driver: { kind: "FOUNDER" },
  };
}

function rejected(result: CommandResult): RejectionReason {
  if (result.status !== "rejected") throw new Error(`Expected rejected, got ${JSON.stringify(result)}`);
  return result.reason;
}

function expectRejected(sim: KernelSimulation, command: GameCommand, code: RejectionCode): RejectionReason {
  const before = sim.stateHash();
  const reason = rejected(sim.dispatch({ command }));
  expect(reason.code).toBe(code);
  expect(sim.stateHash()).toBe(before);
  return reason;
}

const to = (sim: KernelSimulation, tick: number) => sim.advance(tick - sim.state.tick);
const events = (sim: KernelSimulation, type: GameEvent["type"]) => sim.state.eventJournal.filter((e) => e.type === type);
const roadhouse = (s: GameState) => s.buyers.find((b) => b.id === CROSSROADS_ROADHOUSE)!;

describe("AGREE_DEAL (ADR 0022 decision 6)", () => {
  it("holds a deal until DEAL_HOLD_TICKS after agreeing, commits demand and budget to it, and records DEAL_AGREED in its own entry-free transaction", () => {
    const sim = game();
    const before = roadhouse(sim.state);
    const price = quote(sim.state);
    const result = sim.dispatch({ command: { type: "AGREE_DEAL", buyerId: CROSSROADS_ROADHOUSE, productId: MOONSHINE, quality: "basic", quantity: 2, agreedUnitPrice: price } });
    if (result.status !== "applied") throw new Error(JSON.stringify(result));
    const deal = sim.state.heldDeals[0]!;
    expect(deal).toEqual({
      id: "deal-1",
      buyerId: CROSSROADS_ROADHOUSE,
      productId: MOONSHINE,
      quality: "basic",
      quantity: 2,
      unitPrice: price,
      agreedAt: result.tick,
      expiresAt: result.tick + DEAL_HOLD_TICKS,
      budgetCommitted: true,
      status: "HELD",
      deliveryId: null,
    });
    expect(DEAL_HOLD_TICKS).toBe(2_880);
    expect(roadhouse(sim.state).commitments).toEqual([{ dealId: "deal-1", productId: MOONSHINE, quality: "basic", quantity: 2, amount: price * 2 }]);
    expect(roadhouse(sim.state).budgetRemaining).toBe(before.budgetRemaining - price * 2);
    expect(roadhouse(sim.state).wants[0]!.demandRemaining).toBe(before.wants[0]!.demandRemaining - 2);
    const tx = sim.state.ledger.transactions.at(-1)!;
    expect(tx).toMatchObject({ kind: "DAILY_SETTLEMENT", idempotencyKey: idempotencyKey("DAILY_SETTLEMENT", "DEAL_AGREED", "deal-1"), entries: [] });
    expect(tx.eventIds).toEqual(result.eventIds);
    expect(sim.state.eventJournal.at(-1)).toMatchObject({ type: "DEAL_AGREED", dealId: "deal-1", causedBy: result.commandId, unitPrice: price, quantity: 2, expiresAt: deal.expiresAt });
    expect(sim.state.counters.nextId.Deal).toBe(2);
  });

  it("is checked as ADR 0005's sale was: shape first, then the buyer", () => {
    const sim = game();
    const price = quote(sim.state);
    const agreeWith = (patch: Partial<Extract<GameCommand, { type: "AGREE_DEAL" }>>): GameCommand => ({
      type: "AGREE_DEAL",
      buyerId: CROSSROADS_ROADHOUSE,
      productId: MOONSHINE,
      quality: "basic",
      quantity: 1,
      agreedUnitPrice: price,
      ...patch,
    });
    expect(expectRejected(sim, agreeWith({ quantity: 0, buyerId: asId("Buyer", "nobody") }), "INVALID_QUANTITY")).toEqual({ code: "INVALID_QUANTITY", field: "quantity", value: 0 });
    expect(expectRejected(sim, agreeWith({ buyerId: asId("Buyer", "nobody") }), "UNKNOWN_ENTITY")).toEqual({ code: "UNKNOWN_ENTITY", kind: "Buyer", id: "nobody" });
    expect(expectRejected(sim, agreeWith({ buyerId: LAKEVIEW_HOTEL }), "REPUTATION_TOO_LOW")).toMatchObject({ current: 0 });
    expect(expectRejected(sim, agreeWith({ productId: asId("Product", "bathtub-gin") }), "PRODUCT_NOT_WANTED")).toMatchObject({ buyerId: CROSSROADS_ROADHOUSE });
    expect(expectRejected(sim, agreeWith({ agreedUnitPrice: cents(price + 1) }), "QUOTE_CHANGED")).toMatchObject({ agreed: price + 1, current: price });
    expect(sim.state.heldDeals).toEqual([]);
    // Queued: the shape is checked at dispatch too.
    expect(rejected(sim.dispatch({ command: agreeWith({ quantity: 1.5 }), scheduledTick: sim.state.tick + 10 as never }))).toMatchObject({ code: "INVALID_QUANTITY" });
  });

  it("is not repeatable", () => {
    const sim = game();
    agree(sim);
    const source = sim.state.commandLog.at(-1)!.id;
    expect(rejected(sim.dispatch({ command: { type: "REPEAT_OPERATION", sourceCommandId: source } }))).toEqual({ code: "NOT_REPEATABLE", sourceCommandId: source });
  });
});

describe("DISPATCH_DELIVERY against a deal", () => {
  it("takes a HELD deal: DISPATCHED with the delivery, M001's deadline, the founder as driver, and one more trip on the truck", () => {
    const sim = game();
    const dealId = agree(sim);
    expect(sim.state.vehicles[0]!.tripCount).toBe(0);
    const result = sim.dispatch({ command: sale(dealId) });
    if (result.status !== "applied") throw new Error(JSON.stringify(result));
    const delivery = sim.state.deliveries.at(-1)!;
    expect(sim.state.heldDeals).toEqual([expect.objectContaining({ id: dealId, status: "DISPATCHED", deliveryId: delivery.id })]);
    expect(delivery).toMatchObject({ purpose: { kind: "SALE", buyerId: CROSSROADS_ROADHOUSE, dealId }, driver: { kind: "FOUNDER" } });
    expect(delivery.dealDeadline).toBe(result.tick + ROADHOUSE_ROUTE.durationTicks + ROADHOUSE_ROUTE.dealGraceTicks);
    expect(sim.state.vehicles[0]!.tripCount).toBe(1);
    // The commitment rides with the deal; the dispatch commits nothing more.
    expect(roadhouse(sim.state).commitments).toHaveLength(1);
  });

  it("rejects a deal it can't take: DEAL_UNAVAILABLE for one never agreed, already dispatched, or expired", () => {
    const sim = game();
    expectRejected(sim, sale(asId("Deal", "deal-9")), "DEAL_UNAVAILABLE");
    const dealId = agree(sim);
    expect(sim.dispatch({ command: sale(dealId) }).status).toBe("applied");
    expectRejected(sim, sale(dealId), "VEHICLE_UNAVAILABLE"); // the truck is out: checked before the deal
    to(sim, sim.state.vehicles[0]!.trip!.arrivesAt);
    to(sim, sim.state.vehicles[0]!.trip!.arrivesAt);
    expect(sim.state.vehicles[0]!.trip).toBeNull();
    expect(expectRejected(sim, sale(dealId), "DEAL_UNAVAILABLE")).toEqual({ code: "DEAL_UNAVAILABLE", dealId }); // settled: gone
    const late = agree(sim);
    to(sim, sim.state.heldDeals.find((d) => d.id === late)!.expiresAt);
    expect(sim.state.heldDeals).toEqual([]);
    expectRejected(sim, sale(late), "DEAL_UNAVAILABLE");
  });

  it("rejects cargo or a buyer the deal wasn't agreed for with CARGO_DOES_NOT_MATCH_DEAL, after the shape checks", () => {
    const sim = game();
    const dealId = agree(sim, 2);
    expect(expectRejected(sim, sale(dealId, 1), "CARGO_DOES_NOT_MATCH_DEAL")).toEqual({ code: "CARGO_DOES_NOT_MATCH_DEAL", dealId });
    expectRejected(sim, sale(dealId, 2, { quality: "standard" }), "CARGO_DOES_NOT_MATCH_DEAL");
    expectRejected(sim, sale(dealId, 2, { buyerId: KESSLERS_BACK_ROOM }), "CARGO_DOES_NOT_MATCH_DEAL");
    // Gate order (ADR 0022 decision 1): a shape problem comes before the deal's.
    const twoLines = { ...sale(dealId, 1), cargo: [{ productId: MOONSHINE, quality: "basic" as const, quantity: 1 }, { productId: MOONSHINE, quality: "basic" as const, quantity: 1 }] };
    expectRejected(sim, twoLines, "INVALID_QUANTITY");
    expectRejected(sim, sale(asId("Deal", "deal-9"), 0), "INVALID_QUANTITY");
    // The rejected dispatches leave the deal held.
    expect(sim.state.heldDeals).toEqual([expect.objectContaining({ id: dealId, status: "HELD" })]);
    expect(sim.dispatch({ command: sale(dealId, 2) }).status).toBe("applied");
  });

  it("takes a sale on spec (SK1c-2, #226): no deal, no deal deadline, nothing committed on the buyer", () => {
    const sim = game();
    const buyers = sim.state.buyers;
    expect(sim.dispatch({ command: sale(null) }).status).toBe("applied");
    expect(sim.state.deliveries.at(-1)).toMatchObject({ purpose: { kind: "SALE", buyerId: CROSSROADS_ROADHOUSE, dealId: null }, dealDeadline: null });
    expect(sim.state.heldDeals).toEqual([]);
    expect(sim.state.buyers).toEqual(buyers);
  });

  it("caps the deadline at the deal's expiry: a run that can't arrive before it falls through TOO_LATE, never DEAL_EXPIRED", () => {
    const sim = game();
    const dealId = agree(sim);
    const expiresAt = sim.state.heldDeals[0]!.expiresAt;
    // Dispatch so the scheduled arrival lands after the deal's expiry.
    to(sim, expiresAt - Math.floor(ROADHOUSE_ROUTE.durationTicks / 2) - 1);
    const result = sim.dispatch({ command: sale(dealId) });
    if (result.status !== "applied") throw new Error(JSON.stringify(result));
    const delivery = sim.state.deliveries.at(-1)!;
    expect(delivery.dealDeadline).toBe(expiresAt);
    const arrival = sim.state.vehicles[0]!.trip!.arrivesAt;
    expect(arrival).toBeGreaterThan(expiresAt);
    to(sim, arrival);
    expect(events(sim, "DEAL_EXPIRED")).toEqual([]);
    expect(events(sim, "DEAL_FELL_THROUGH")).toEqual([expect.objectContaining({ deliveryId: delivery.id, reason: "TOO_LATE" })]);
    expect(sim.state.heldDeals).toEqual([]);
    expect(roadhouse(sim.state).commitments).toEqual([]);
  });
});

describe("DEAL_EXPIRED (ADR 0022 decision 6)", () => {
  it("fires at expiresAt for a HELD deal only, releasing its commitment under the daily caps in a keyed, entry-free transaction", () => {
    const sim = game();
    const held = agree(sim, 1);
    const dispatched = agree(sim, 1);
    expect(sim.dispatch({ command: sale(dispatched) }).status).toBe("applied");
    const expiresAt = sim.state.heldDeals.find((d) => d.id === held)!.expiresAt;
    to(sim, expiresAt - 1);
    expect(sim.state.heldDeals.map((d) => d.id)).toEqual([held]); // the dispatched deal settled long ago
    expect(events(sim, "DEAL_EXPIRED")).toEqual([]);
    const committed = roadhouse(sim.state);
    to(sim, expiresAt);
    expect(events(sim, "DEAL_EXPIRED")).toEqual([expect.objectContaining({ dealId: held, buyerId: CROSSROADS_ROADHOUSE, tick: expiresAt, causedBy: null })]);
    expect(sim.state.heldDeals).toEqual([]);
    const after = roadhouse(sim.state);
    expect(after.commitments).toEqual([]);
    const def = GAME_DATA.buyers.find((b) => b.id === CROSSROADS_ROADHOUSE)!;
    // Released after two midnight refreshes: back to the daily caps, never above.
    expect(after.budgetRemaining).toBe(Math.min(def.dailyBudget, committed.budgetRemaining + quote(sim.state)));
    expect(after.wants[0]!.demandRemaining).toBeLessThanOrEqual(def.wants[0]!.dailyDemand);
    const tx = sim.state.ledger.transactions.find((t) => t.idempotencyKey === idempotencyKey("DAILY_SETTLEMENT", "DEAL_EXPIRED", held))!;
    expect(tx).toMatchObject({ kind: "DAILY_SETTLEMENT", tick: expiresAt, entries: [] });
  });

  it("gives back demand and budget released the same day", () => {
    const sim = game();
    const before = roadhouse(sim.state);
    agree(sim, 3);
    // A save edited so the deal expires today, before any midnight.
    const s = sim.state;
    const edited = createSimulation({ ...s, heldDeals: s.heldDeals.map((d) => ({ ...d, expiresAt: (s.tick + 5) as never })) }, simulationOptions());
    to(edited, s.tick + 5);
    expect(roadhouse(edited.state).budgetRemaining).toBe(before.budgetRemaining);
    expect(roadhouse(edited.state).wants[0]!.demandRemaining).toBe(before.wants[0]!.demandRemaining);
  });
});

describe("shapes: issuer and RELEASE_RESERVATION.facilityId", () => {
  it("stamps the FOUNDER issuer on every envelope, applied or queued", () => {
    const sim = game();
    agree(sim);
    sim.dispatch({ command: { type: "SET_WORKFORCE", facilityId: DISTILLERY_MAIN, workerCount: 3 }, scheduledTick: (sim.state.tick + 50) as never });
    expect([...sim.state.commandLog, ...sim.state.queuedCommands].map((e) => e.issuer)).toEqual([{ kind: "FOUNDER" }, { kind: "FOUNDER" }]);
  });

  it("counts every dispatch on the truck, whatever its purpose", () => {
    const owns: ScenarioDefinition = {
      ...FIRST_SHIPMENT_SCENARIO,
      facilities: [...FIRST_SHIPMENT_SCENARIO.facilities, { id: RIVERSIDE_WAREHOUSE, equipmentIds: [], workerCount: 0 }],
    };
    const sim = game(4, owns);
    const transfer: GameCommand = {
      type: "DISPATCH_DELIVERY",
      vehicleId: MODEL_TT_TRUCK,
      cargo: [{ productId: MOONSHINE, quality: "basic", quantity: 1 }],
      purpose: { kind: "TRANSFER", destinationFacilityId: RIVERSIDE_WAREHOUSE },
      routeId: DEPOT_ROAD,
      driver: { kind: "FOUNDER" },
    };
    expect(sim.dispatch({ command: transfer }).status).toBe("applied");
    expect(sim.state.vehicles[0]!.tripCount).toBe(1);
    expect(sim.state.deliveries.at(-1)!.driver).toEqual({ kind: "FOUNDER" });
    to(sim, sim.state.vehicles[0]!.trip!.arrivesAt);
    to(sim, sim.state.vehicles[0]!.trip!.arrivesAt);
    expect(sim.dispatch({ command: sale(agree(sim)) }).status).toBe("applied");
    expect(sim.state.vehicles[0]!.tripCount).toBe(2);
  });

  it("releases a contract's reservation only at the facility the command names", () => {
    const sim = game();
    const s = sim.state;
    const reservation = {
      id: asId("Reservation", "res-50"),
      facilityId: DISTILLERY_MAIN,
      goods: { kind: "PRODUCT" as const, productId: MOONSHINE, quality: "basic" as const },
      quantity: 1,
      holder: { kind: "CONTRACT" as const, contractId: asId("Contract", "contract-50") },
    };
    const withReservation = createSimulation({ ...s, reservations: [reservation] }, simulationOptions());
    const release = (facilityId: typeof DISTILLERY_MAIN): GameCommand => ({ type: "RELEASE_RESERVATION", facilityId, reservationId: reservation.id });
    expect(expectRejected(withReservation, release(RIVERSIDE_WAREHOUSE), "RESERVATION_NOT_ACTIVE")).toEqual({ code: "RESERVATION_NOT_ACTIVE", reservationId: reservation.id });
    expect(withReservation.dispatch({ command: release(DISTILLERY_MAIN) }).status).toBe("applied");
    expect(withReservation.state.reservations).toEqual([]);
  });
});
