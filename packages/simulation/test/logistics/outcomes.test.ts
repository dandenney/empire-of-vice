// SK1c-1 (#200): ADR 0022 decision 6's outcomes with founder rules on, where an
// order accepted on the founder's view meets a world that differs.
//
// - An installment dispatched on known CONTRACT_PROGRESS arrives at a contract
//   that has completed since: it falls through (CONTRACT_CLOSED) and the cargo
//   comes home, unsold (review round 1 on #229). Played (SK1c-2, #226): one
//   case sent shortly before the final deadline.
// - A road that closes while the truck is loaded: ROUTE_FOUND_CLOSED at
//   departure, the route recorded IN_PERSON, and the turn-back known at once.

import { tick, TICKS_PER_DAY, type CommandResult, type GameCommand, type GameState, type LocationId } from "@eov/contracts";
import {
  BASIC_MOONSHINE_RECIPE,
  CORN,
  CROSSROADS,
  CROSSROADS_ROADHOUSE,
  DISTILLERY_MAIN,
  FIRST_SHIPMENT_SCENARIO,
  HOLLOW_CREEK,
  KESSLER_BACK_ROAD,
  KESSLER_PHARMACY,
  KESSLERS_BACK_ROOM,
  MILLERS_FEED,
  MILLERS_FEED_LOCATION,
  MODEL_TT_TRUCK,
  MOONSHINE,
  STATE_HIGHWAY,
  SUGAR,
  type ScenarioDefinition,
} from "@eov/game-data";
import { describe, expect, it } from "vitest";
import { loadGame, newGame, scheduleWorldEvent, type KernelSimulation } from "../../src/index.ts";
import { isOpenAt } from "../../src/founder/time.ts";

const SCENARIO: ScenarioDefinition = { ...FIRST_SHIPMENT_SCENARIO, scheduledEvents: [], founderRules: true, realMsPerGameHourAt1x: 20_000 };

const free = (s: GameState): boolean => s.founder.whereabouts.kind === "PRESENT" && s.founder.whereabouts.busy === null;
const at = (s: GameState, l: LocationId): boolean => s.founder.whereabouts.kind === "PRESENT" && s.founder.whereabouts.locationId === l;
const moonshineAtHome = (s: GameState): number =>
  s.productPools.filter((p) => p.facilityId === DISTILLERY_MAIN && p.productId === MOONSHINE).reduce((n, p) => n + p.quantity, 0);

function until(sim: KernelSimulation, done: (s: GameState) => boolean, max = 3 * TICKS_PER_DAY): void {
  for (let i = 0; i < max && !done(sim.state); i++) sim.advance(1);
  if (!done(sim.state)) throw new Error(`not reached by tick ${sim.state.tick}`);
}

function applied(sim: KernelSimulation, command: GameCommand): void {
  const result = sim.dispatch({ command });
  if (result.status !== "applied") throw new Error(`${command.type}: ${JSON.stringify(result)}`);
}

function walkTo(sim: KernelSimulation, destinationLocationId: LocationId): void {
  until(sim, free);
  if (at(sim.state, destinationLocationId)) return;
  applied(sim, { type: "TRAVEL", destinationLocationId, transport: { kind: "FOOT" }, via: null });
  until(sim, (s) => at(s, destinationLocationId) && free(s));
}

function waitOpen(sim: KernelSimulation, locationId: LocationId): void {
  until(sim, (s) => free(s) && isOpenAt(locationId, tick(s.tick + 1)) && isOpenAt(locationId, tick(s.tick + 2)));
}

/** Materials bought at the feed store, and `cases` of moonshine brewed at Hollow Creek. */
function stocked(cases: number): KernelSimulation {
  const sim = newGame({ scenario: SCENARIO });
  until(sim, free);
  walkTo(sim, MILLERS_FEED_LOCATION);
  waitOpen(sim, MILLERS_FEED_LOCATION);
  for (const [materialId, quantity] of [
    [CORN, 2 * cases],
    [SUGAR, cases],
  ] as const) {
    applied(sim, { type: "PURCHASE_MATERIALS", supplierId: MILLERS_FEED, materialId, quantity, facilityId: DISTILLERY_MAIN });
    until(sim, free);
  }
  walkTo(sim, HOLLOW_CREEK);
  applied(sim, { type: "START_PRODUCTION", facilityId: DISTILLERY_MAIN, recipeId: BASIC_MOONSHINE_RECIPE, quantity: cases });
  until(sim, (s) => free(s) && s.productionJobs.length === 0, 4 * TICKS_PER_DAY);
  return sim;
}

function withState(sim: KernelSimulation, state: GameState): KernelSimulation {
  return loadGame({ ...sim.serialize(), state }, { scenario: SCENARIO });
}

describe("an installment arriving at a contract that closed unseen (ADR 0022 decision 6)", () => {
  it("falls through with CONTRACT_CLOSED, sells nothing, and the cargo comes home", () => {
    const sim0 = stocked(4);
    walkTo(sim0, KESSLER_PHARMACY);
    waitOpen(sim0, KESSLER_PHARMACY);
    sim0.advance(1);
    const offer = sim0.state.contractOffers.find((o) => o.buyerId === KESSLERS_BACK_ROOM);
    if (!offer) throw new Error("no offer at Kessler's");
    applied(sim0, { type: "ACCEPT_CONTRACT", contractOfferId: offer.id });
    walkTo(sim0, HOLLOW_CREEK);
    const sim = sim0;
    const contract = sim.state.contracts[0]!;

    // Played, not edited: the founder waits at home until shortly before the final
    // deadline, then sends one case. Loading and the road take longer than what's
    // left, so the last installment settles (short) and the contract completes
    // while the truck is on the road. At dispatch the founder's record still
    // shows the contract ACTIVE, which is all the order is judged on.
    const finalDeadline = contract.installments.at(-1)!.deadline;
    until(sim, (s) => s.tick >= finalDeadline - 20 && free(s) && at(s, HOLLOW_CREEK), 8 * TICKS_PER_DAY);
    expect(sim.state.tick, "construction: before the final deadline").toBeLessThan(finalDeadline);
    const record = sim.state.knowledge.records.find((r) => r.subject.kind === "CONTRACT_PROGRESS" && r.subject.contractId === contract.id);
    expect(record?.value, "construction: the founder knows the contract as still running").toMatchObject({ kind: "CONTRACT_PROGRESS", status: "ACTIVE" });

    const stockBefore = moonshineAtHome(sim.state);
    const dispatched: CommandResult = sim.dispatch({
      command: {
        type: "DISPATCH_DELIVERY",
        vehicleId: MODEL_TT_TRUCK,
        cargo: [{ productId: MOONSHINE, quality: "basic", quantity: 1 }],
        purpose: { kind: "CONTRACT_INSTALLMENT", contractId: contract.id },
        routeId: KESSLER_BACK_ROAD,
        driver: { kind: "FOUNDER" },
      },
    });
    expect(dispatched.status, "the order is judged on known progress").toBe("applied");
    const deliveryId = sim.state.deliveries.at(-1)!.id;
    sim.takeEvents();

    until(sim, (s) => s.deliveries.find((d) => d.id === deliveryId)?.status !== "OUTBOUND");
    expect(sim.state.contracts.find((c) => c.id === contract.id)!.status, "construction: it completed while the truck was out").toBe("COMPLETED");
    expect(sim.state.tick, "construction: the truck arrived after the final deadline").toBeGreaterThan(finalDeadline);
    const events = sim.takeEvents();
    expect(events.filter((e) => e.type === "SALE_COMPLETED")).toEqual([]);
    expect(events.filter((e) => e.type === "DEAL_FELL_THROUGH")).toEqual([
      expect.objectContaining({ deliveryId, buyerId: contract.buyerId, reason: "CONTRACT_CLOSED" }),
    ]);
    expect(sim.state.deliveries.find((d) => d.id === deliveryId)).toMatchObject({ status: "FAILED", cargo: [expect.objectContaining({ quantity: 1 })] });
    expect(sim.state.ledger.transactions.some((t) => t.idempotencyKey === `SALE:${deliveryId}`), "nothing is sold").toBe(false);

    until(sim, (s) => at(s, HOLLOW_CREEK) && s.vehicles.find((v) => v.id === MODEL_TT_TRUCK)!.trip === null);
    expect(moonshineAtHome(sim.state), "the case comes home unsold").toBe(stockBefore);
  });
});

describe("a road that closes while the truck is loaded (ADR 0023 decisions 2a and 4)", () => {
  it("records the route IN_PERSON where the founder stands, and the turn-back is known at once", () => {
    const sim0 = stocked(2);
    walkTo(sim0, CROSSROADS);
    waitOpen(sim0, CROSSROADS);
    const want = sim0.state.buyers.find((b) => b.id === CROSSROADS_ROADHOUSE)!.wants.find((w) => w.productId === MOONSHINE && w.minimumQuality === "basic")!;
    applied(sim0, { type: "AGREE_DEAL", buyerId: CROSSROADS_ROADHOUSE, productId: MOONSHINE, quality: "basic", quantity: 1, agreedUnitPrice: want.unitPrice });
    walkTo(sim0, HOLLOW_CREEK);
    const deal = sim0.state.heldDeals.at(-1)!;
    applied(sim0, {
      type: "DISPATCH_DELIVERY",
      vehicleId: MODEL_TT_TRUCK,
      cargo: [{ productId: MOONSHINE, quality: "basic", quantity: 1 }],
      purpose: { kind: "SALE", buyerId: CROSSROADS_ROADHOUSE, dealId: deal.id },
      routeId: STATE_HIGHWAY,
      driver: { kind: "FOUNDER" },
    });
    const deliveryId = sim0.state.deliveries.at(-1)!.id;
    const w = sim0.state.founder.whereabouts;
    if (w.kind !== "PRESENT" || w.busy === null) throw new Error("loading keeps the founder busy");
    const departure = w.busy.until;
    const sim = withState(
      sim0,
      scheduleWorldEvent(sim0.state, { kind: "ROUTE_CLOSURE", tick: tick(sim0.state.tick + 2), routeId: STATE_HIGHWAY, reason: "POLICE", durationTicks: 2 * TICKS_PER_DAY }),
    );
    sim.advance(departure - sim.state.tick);

    expect(sim.takeEvents().filter((e) => e.type === "ROUTE_FOUND_CLOSED")).toEqual([expect.objectContaining({ deliveryId, routeId: STATE_HIGHWAY })]);
    const record = sim.state.knowledge.records.find((r) => r.subject.kind === "ROUTE_CONDITION" && r.subject.routeId === STATE_HIGHWAY);
    expect(record).toMatchObject({ source: { kind: "IN_PERSON", locationId: HOLLOW_CREEK }, value: { status: { open: false } } });
    const turnBack = sim.state.ledger.transactions.find((t) => t.idempotencyKey === `VEHICLE_RETURN:${deliveryId}`);
    expect(turnBack?.entries.length, "the cargo is unloaded back, at its cost").toBeGreaterThan(0);
    expect(sim.state.knowledge.pendingBooks.some((b) => b.transactionId === turnBack!.id), "the founder is standing there: known, not pending").toBe(false);
    expect(sim.state.heldDeals.find((d) => d.id === deal.id)).toMatchObject({ status: "HELD", deliveryId: null });
  });
});
