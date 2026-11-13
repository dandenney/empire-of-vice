// SK1a (#198): ADR 0023's presence behaviour with founder rules on. Travel
// (decision 3) and its rejections (3a), rest and waking (7), the busy gate and
// place hours (2a, 4, 6), the founder phase (2a), and the founder as driver (5).
// The no-trap property is the locked no-trap.locked.test.ts.

import {
  minuteOfDay,
  tick,
  TICKS_PER_DAY,
  TICKS_PER_HOUR,
  type CommandResult,
  type GameCommand,
  type GameEvent,
  type GameState,
  type DriverRef,
  type LocationId,
  type RouteLeg,
} from "@eov/contracts";
import {
  ACTIVITY_DURATIONS,
  BASIC_MOONSHINE_RECIPE,
  CORN,
  COUNTY_ROAD,
  CROSSROADS,
  CROSSROADS_ROADHOUSE,
  DISTILLERY_MAIN,
  FEED_STORE_ROAD,
  FIRST_SHIPMENT_SCENARIO,
  FULL_REST_TICKS,
  GAME_DATA,
  HOLLOW_CREEK,
  KESSLER_BACK_ROAD,
  KESSLER_PHARMACY,
  LAKEVIEW,
  LAKEVIEW_BACK_ROAD,
  MAX_REST_TICKS,
  MILLERS_FEED,
  MILLERS_FEED_LOCATION,
  MIN_REST_TICKS,
  MODEL_TT_TRUCK,
  MOONSHINE,
  ROUGH_REST_TICKS,
  START_WAKE_TICK,
  STATE_HIGHWAY,
  SUGAR,
  TIRED_AFTER_TICKS,
  type ScenarioDefinition,
  type ScenarioScheduledEvent,
} from "@eov/game-data";
import { describe, expect, it } from "vitest";
import { createGameRegistry, newGame, type KernelSimulation } from "../../src/index.ts";
import { activityTicks, awakeSinceAfterRest, isOpenAt, opensAt, scaleUp } from "../../src/founder/time.ts";

const SCENARIO: ScenarioDefinition = { ...FIRST_SHIPMENT_SCENARIO, scheduledEvents: [], founderRules: true, realMsPerGameHourAt1x: 20_000 };
const route = (id: string) => GAME_DATA.routes.find((r) => r.id === id)!;
const foot = (id: string) => scaleUp(route(id).durationTicks, 3_000_000);

function game(scheduledEvents: readonly ScenarioScheduledEvent[] = []): KernelSimulation {
  const sim = newGame({ scenario: { ...SCENARIO, scheduledEvents } });
  sim.advance(START_WAKE_TICK);
  expect(sim.state.founder.whereabouts).toEqual({ kind: "PRESENT", locationId: HOLLOW_CREEK, busy: null });
  sim.takeEvents();
  return sim;
}

function applied(sim: KernelSimulation, command: GameCommand): Extract<CommandResult, { status: "applied" }> {
  const result = sim.dispatch({ command });
  if (result.status !== "applied") throw new Error(`${command.type}: ${JSON.stringify(result)}`);
  return result;
}

function rejection(sim: KernelSimulation, command: GameCommand): unknown {
  const before = sim.stateHash();
  const result = sim.dispatch({ command });
  expect(sim.stateHash()).toBe(before);
  return result.status === "rejected" ? result.reason : result;
}

/** Runs ticks until `state.tick` is `target`. */
function to(sim: KernelSimulation, target: number): void {
  sim.advance(target - sim.state.tick);
}

function until(sim: KernelSimulation, done: (s: GameState) => boolean, max = 3 * TICKS_PER_DAY): void {
  for (let i = 0; i < max && !done(sim.state); i++) sim.advance(1);
  expect(done(sim.state)).toBe(true);
}

const free = (s: GameState) => s.founder.whereabouts.kind === "PRESENT" && s.founder.whereabouts.busy === null;
const at = (s: GameState, l: LocationId) => s.founder.whereabouts.kind === "PRESENT" && s.founder.whereabouts.locationId === l;
const walk = (destinationLocationId: LocationId, via: readonly RouteLeg[] | null = null): GameCommand => ({
  type: "TRAVEL",
  destinationLocationId,
  transport: { kind: "FOOT" },
  via,
});
const drive = (destinationLocationId: LocationId): GameCommand => ({
  type: "TRAVEL",
  destinationLocationId,
  transport: { kind: "VEHICLE", vehicleId: MODEL_TT_TRUCK },
  via: null,
});
const truck = (s: GameState) => s.vehicles.find((v) => v.id === MODEL_TT_TRUCK)!;
const eventsOf = (sim: KernelSimulation, type: GameEvent["type"]) => sim.takeEvents().filter((e) => e.type === type);

describe("registration (decision 9)", () => {
  it("registers the founder phase and the busy gate only with founder rules on", () => {
    expect(createGameRegistry(GAME_DATA).hooks("founder")).toEqual([]);
    expect(createGameRegistry(GAME_DATA).commandGates()).toEqual([]);
    const on = createGameRegistry(GAME_DATA, undefined, undefined, { founderRules: true });
    expect(on.hooks("founder").map((h) => h.name)).toEqual(["founder-transitions"]);
    expect(on.commandGates().map((g) => g.name)).toEqual(["founder-activities"]);
  });
});

describe("TRAVEL (decisions 3, 3a)", () => {
  it("walks the default path leg by leg, three times slower, and arrives the tick the last leg ends", () => {
    const sim = game();
    const t = sim.state.tick + 1;
    applied(sim, walk(KESSLER_PHARMACY));
    expect(sim.state.founder.whereabouts).toEqual({
      kind: "TRAVELLING",
      transport: { kind: "FOOT" },
      path: [{ routeId: KESSLER_BACK_ROAD, reversed: false }],
      legIndex: 0,
      legDepartedAt: t,
      legArrivesAt: t + foot(KESSLER_BACK_ROAD),
      destinationLocationId: KESSLER_PHARMACY,
    });
    expect(eventsOf(sim, "FOUNDER_DEPARTED")).toMatchObject([{ from: HOLLOW_CREEK, to: KESSLER_PHARMACY, transport: { kind: "FOOT" } }]);
    to(sim, t + foot(KESSLER_BACK_ROAD) - 1);
    expect(sim.state.founder.whereabouts.kind).toBe("TRAVELLING");
    sim.advance(1);
    expect(sim.state.founder.whereabouts).toEqual({ kind: "PRESENT", locationId: KESSLER_PHARMACY, busy: null });
    expect(eventsOf(sim, "FOUNDER_ARRIVED")).toMatchObject([{ locationId: KESSLER_PHARMACY, tick: t + foot(KESSLER_BACK_ROAD) }]);
  });

  it("walks a two-leg `via` through Hollow Creek, starting the next leg the tick the first ends", () => {
    const sim = game();
    applied(sim, walk(KESSLER_PHARMACY));
    until(sim, (s) => at(s, KESSLER_PHARMACY));
    const t = sim.state.tick + 1;
    const via = [
      { routeId: COUNTY_ROAD, reversed: true },
      { routeId: LAKEVIEW_BACK_ROAD, reversed: false },
    ];
    applied(sim, { type: "TRAVEL", destinationLocationId: LAKEVIEW, transport: { kind: "FOOT" }, via });
    to(sim, t + foot(COUNTY_ROAD));
    expect(sim.state.founder.whereabouts).toMatchObject({ kind: "TRAVELLING", legIndex: 1, legDepartedAt: t + foot(COUNTY_ROAD) });
    to(sim, t + foot(COUNTY_ROAD) + foot(LAKEVIEW_BACK_ROAD) - 1);
    expect(sim.state.founder.whereabouts.kind).toBe("TRAVELLING");
    sim.advance(1);
    expect(at(sim.state, LAKEVIEW)).toBe(true);
  });

  it("drives the truck: unparked while moving, parked where the founder arrives", () => {
    const sim = game();
    applied(sim, drive(CROSSROADS));
    expect(truck(sim.state).parkedAt).toBeNull();
    // The default path by vehicle is the shortest: the back road (80) beats the highway (120).
    expect(sim.state.founder.whereabouts).toMatchObject({ path: [{ routeId: "crossroads-back-road", reversed: false }] });
    until(sim, (s) => at(s, CROSSROADS));
    expect(truck(sim.state)).toMatchObject({ parkedAt: CROSSROADS, trip: null });
  });

  it("halts a drive at a junction when the next leg's route is closed, and parks the truck there", () => {
    const sim = game();
    applied(sim, drive(CROSSROADS));
    until(sim, (s) => at(s, CROSSROADS));
    // Crossroads → Hollow Creek → Kessler's, and County Road closes during the first leg.
    const closeAt = sim.state.tick + 5;
    const closing = newGame({
      scenario: { ...SCENARIO, scheduledEvents: [{ kind: "ROUTE_CLOSURE", tick: tick(closeAt), routeId: COUNTY_ROAD, reason: "POLICE", durationTicks: 600 }] },
    });
    for (const envelope of sim.state.commandLog) closing.replay(envelope);
    closing.advance(sim.state.tick - closing.state.tick);
    closing.takeEvents();
    const via = [
      { routeId: STATE_HIGHWAY, reversed: true },
      { routeId: COUNTY_ROAD, reversed: false },
    ];
    const t = closing.state.tick + 1;
    applied(closing, { type: "TRAVEL", destinationLocationId: KESSLER_PHARMACY, transport: { kind: "VEHICLE", vehicleId: MODEL_TT_TRUCK }, via });
    to(closing, t + route(STATE_HIGHWAY).durationTicks);
    expect(closing.state.founder.whereabouts).toEqual({ kind: "PRESENT", locationId: HOLLOW_CREEK, busy: null });
    expect(truck(closing.state).parkedAt).toBe(HOLLOW_CREEK);
    expect(eventsOf(closing, "FOUNDER_HALTED")).toMatchObject([{ routeId: COUNTY_ROAD, locationId: HOLLOW_CREEK }]);
  });

  it("walks through a closure: closures stop vehicles only", () => {
    const sim = game([{ kind: "ROUTE_CLOSURE", tick: tick(1), routeId: FEED_STORE_ROAD, reason: "POLICE", durationTicks: 2 * TICKS_PER_DAY }]);
    applied(sim, walk(MILLERS_FEED_LOCATION));
    until(sim, (s) => at(s, MILLERS_FEED_LOCATION));
  });

  it("rejects with decision 3a's reasons, in its gate order", () => {
    const sim = game([{ kind: "ROUTE_CLOSURE", tick: tick(1), routeId: FEED_STORE_ROAD, reason: "RIVAL", durationTicks: 2 * TICKS_PER_DAY }]);
    const reopensAt = 1 + 2 * TICKS_PER_DAY;
    expect(rejection(sim, walk("atlantis" as LocationId))).toEqual({ code: "UNKNOWN_ENTITY", kind: "Location", id: "atlantis" });
    expect(
      rejection(sim, { type: "TRAVEL", destinationLocationId: LAKEVIEW, transport: { kind: "FOOT" }, via: [{ routeId: "nowhere" as never, reversed: false }] }),
    ).toMatchObject({ code: "UNKNOWN_ENTITY", kind: "Route" });
    expect(
      rejection(sim, { type: "TRAVEL", destinationLocationId: LAKEVIEW, transport: { kind: "VEHICLE", vehicleId: "cart" as never }, via: null }),
    ).toMatchObject({ code: "UNKNOWN_ENTITY", kind: "Vehicle" });
    expect(rejection(sim, walk(HOLLOW_CREEK))).toEqual({ code: "ALREADY_THERE" });
    // Not connected, not ending at the destination, revisiting a place.
    expect(
      rejection(sim, { type: "TRAVEL", destinationLocationId: LAKEVIEW, transport: { kind: "FOOT" }, via: [{ routeId: COUNTY_ROAD, reversed: true }] }),
    ).toEqual({ code: "INVALID_PATH" });
    expect(
      rejection(sim, { type: "TRAVEL", destinationLocationId: LAKEVIEW, transport: { kind: "FOOT" }, via: [{ routeId: COUNTY_ROAD, reversed: false }] }),
    ).toEqual({ code: "INVALID_PATH" });
    expect(rejection(sim, { type: "TRAVEL", destinationLocationId: LAKEVIEW, transport: { kind: "FOOT" }, via: [] })).toEqual({ code: "INVALID_PATH" });
    // By truck, a closed route in the live view of Hollow Creek: known.
    expect(
      rejection(sim, {
        type: "TRAVEL",
        destinationLocationId: MILLERS_FEED_LOCATION,
        transport: { kind: "VEHICLE", vehicleId: MODEL_TT_TRUCK },
        via: [{ routeId: FEED_STORE_ROAD, reversed: false }],
      }),
    ).toEqual({ code: "ROUTE_CLOSED", routeId: FEED_STORE_ROAD, reopensAt });
    expect(rejection(sim, drive(MILLERS_FEED_LOCATION))).toEqual({ code: "NO_PATH", destinationLocationId: MILLERS_FEED_LOCATION });

    applied(sim, walk(LAKEVIEW));
    expect(rejection(sim, walk(CROSSROADS))).toEqual({ code: "FOUNDER_AWAY", whereabouts: "TRAVELLING" });
    expect(rejection(sim, { type: "REST", untilTick: tick(sim.state.tick + 1 + MIN_REST_TICKS) })).toEqual({
      code: "FOUNDER_AWAY",
      whereabouts: "TRAVELLING",
    });
    until(sim, (s) => at(s, LAKEVIEW));
    // The truck stayed at Hollow Creek.
    expect(rejection(sim, drive(HOLLOW_CREEK))).toEqual({ code: "VEHICLE_NOT_AT", vehicleId: MODEL_TT_TRUCK, locationId: LAKEVIEW });
  });

  it("is FOUNDER_BUSY during an activity, through its end tick", () => {
    const sim = game();
    const t = sim.state.tick + 1;
    applied(sim, { type: "SET_WORKFORCE", facilityId: DISTILLERY_MAIN, workerCount: 1 });
    const end = t + ACTIVITY_DURATIONS.SET_WORKFORCE;
    expect(rejection(sim, walk(LAKEVIEW))).toEqual({ code: "FOUNDER_BUSY", until: end });
    sim.advance(end - 1 - sim.state.tick);
    expect(rejection(sim, walk(LAKEVIEW))).toEqual({ code: "FOUNDER_BUSY", until: end });
    sim.advance(1);
    applied(sim, walk(LAKEVIEW));
  });
});

describe("REST and WAKE (decision 7)", () => {
  it("starts the first game resting until START_WAKE_TICK, then wakes with the partial-rest recovery", () => {
    const sim = newGame({ scenario: SCENARIO });
    sim.advance(START_WAKE_TICK);
    expect(sim.state.founder.awakeSince).toBe(Math.min(Math.floor((START_WAKE_TICK * TIRED_AFTER_TICKS) / FULL_REST_TICKS), START_WAKE_TICK));
    expect(sim.takeEvents().filter((e) => e.type === "FOUNDER_WOKE")).toMatchObject([{ locationId: HOLLOW_CREEK, early: false, tick: START_WAKE_TICK }]);
  });

  it("checks the length first: INVALID_REST_LENGTH in absolute ticks", () => {
    const sim = newGame({ scenario: SCENARIO });
    expect(rejection(sim, { type: "REST", untilTick: tick(5) })).toEqual({ code: "INVALID_REST_LENGTH", min: 1 + MIN_REST_TICKS, max: 1 + MAX_REST_TICKS });
    expect(rejection(sim, { type: "REST", untilTick: tick(1 + MIN_REST_TICKS) })).toEqual({ code: "FOUNDER_AWAY", whereabouts: "RESTING" });
  });

  it("rests anywhere present; a full rest at a rest place resets awakeSince to the wake tick", () => {
    const sim = game();
    const t = sim.state.tick + 1;
    applied(sim, { type: "REST", untilTick: tick(t + FULL_REST_TICKS) });
    expect(sim.state.founder.whereabouts).toEqual({ kind: "RESTING", locationId: HOLLOW_CREEK, startedAt: t, until: t + FULL_REST_TICKS });
    expect(eventsOf(sim, "FOUNDER_RESTED")).toMatchObject([{ locationId: HOLLOW_CREEK, until: t + FULL_REST_TICKS }]);
    to(sim, t + FULL_REST_TICKS);
    expect(sim.state.founder).toEqual({ whereabouts: { kind: "PRESENT", locationId: HOLLOW_CREEK, busy: null }, awakeSince: t + FULL_REST_TICKS });
  });

  it("WAKE ends a rest early and moves awakeSince forward in proportion; WAKE when awake is NOT_RESTING", () => {
    const sim = game();
    expect(rejection(sim, { type: "WAKE" })).toEqual({ code: "NOT_RESTING" });
    const since = sim.state.founder.awakeSince;
    const t = sim.state.tick + 1;
    applied(sim, { type: "REST", untilTick: tick(t + MAX_REST_TICKS) });
    to(sim, t + FULL_REST_TICKS / 2 - 1);
    const woke = applied(sim, { type: "WAKE" });
    expect(woke.tick).toBe(t + FULL_REST_TICKS / 2);
    expect(sim.state.founder).toEqual({
      whereabouts: { kind: "PRESENT", locationId: HOLLOW_CREEK, busy: null },
      awakeSince: Math.min(since + TIRED_AFTER_TICKS / 2, t + FULL_REST_TICKS / 2),
    });
    expect(eventsOf(sim, "FOUNDER_WOKE")).toMatchObject([{ early: true }]);
  });

  it("sleeping rough needs ROUGH_REST_TICKS for a full rest", () => {
    expect(awakeSinceAfterRest(tick(0), LAKEVIEW, tick(1_000), tick(1_000 + FULL_REST_TICKS))).toBe(
      Math.floor((FULL_REST_TICKS * TIRED_AFTER_TICKS) / ROUGH_REST_TICKS),
    );
    expect(awakeSinceAfterRest(tick(0), LAKEVIEW, tick(1_000), tick(1_000 + ROUGH_REST_TICKS))).toBe(1_000 + ROUGH_REST_TICKS);
    expect(awakeSinceAfterRest(tick(0), HOLLOW_CREEK, tick(1_000), tick(1_000 + FULL_REST_TICKS))).toBe(1_000 + FULL_REST_TICKS);
  });

  it("a tired founder's activities take × TIRED_DURATION_PPM, rounded up; travel doesn't", () => {
    const founder = { whereabouts: { kind: "PRESENT", locationId: HOLLOW_CREEK, busy: null }, awakeSince: tick(0) } as const;
    expect(activityTicks(founder, "SET_WORKFORCE", tick(TIRED_AFTER_TICKS))).toBe(ACTIVITY_DURATIONS.SET_WORKFORCE);
    expect(activityTicks(founder, "SET_WORKFORCE", tick(TIRED_AFTER_TICKS + 1))).toBe(scaleUp(ACTIVITY_DURATIONS.SET_WORKFORCE, 1_500_000));
  });
});

describe("timed activities: busy and hours (decisions 2a, 4, 6)", () => {
  it("an instant command is allowed while busy", () => {
    const sim = game();
    applied(sim, { type: "SET_WORKFORCE", facilityId: DISTILLERY_MAIN, workerCount: 1 });
    expect(rejection(sim, { type: "SET_WORKFORCE", facilityId: DISTILLERY_MAIN, workerCount: 2 })).toMatchObject({ code: "FOUNDER_BUSY" });
    // RELEASE_RESERVATION is instant: its own rejection, not FOUNDER_BUSY.
    expect(rejection(sim, { type: "RELEASE_RESERVATION", reservationId: "reservation-9" as never, facilityId: DISTILLERY_MAIN })).toMatchObject({
      code: "RESERVATION_NOT_ACTIVE",
    });
  });

  it("gate 1 comes before the busy gate", () => {
    const sim = game();
    applied(sim, { type: "SET_WORKFORCE", facilityId: DISTILLERY_MAIN, workerCount: 1 });
    expect(rejection(sim, { type: "SET_WORKFORCE", facilityId: "nowhere" as never, workerCount: 1 })).toMatchObject({ code: "UNKNOWN_ENTITY" });
  });

  it("buying needs the supplier open when it starts: PLACE_CLOSED with the next opening tick", () => {
    const sim = game();
    applied(sim, walk(MILLERS_FEED_LOCATION));
    until(sim, (s) => at(s, MILLERS_FEED_LOCATION) && free(s));
    // Wait outside until the feed store has closed for the evening (07:00–18:00).
    until(sim, (s) => !isOpenAt(MILLERS_FEED_LOCATION, tick(s.tick + 1)));
    const t = sim.state.tick + 1;
    const opens = t - minuteOfDay(tick(t)) + TICKS_PER_DAY + 7 * TICKS_PER_HOUR;
    expect(opensAt(MILLERS_FEED_LOCATION, tick(t))).toBe(opens);
    const buy: GameCommand = { type: "PURCHASE_MATERIALS", supplierId: MILLERS_FEED, materialId: CORN, quantity: 1, facilityId: DISTILLERY_MAIN };
    expect(rejection(sim, buy)).toEqual({ code: "PLACE_CLOSED", locationId: MILLERS_FEED_LOCATION, opensAt: opens });
    sim.advance(opens - 1 - sim.state.tick);
    // A night outside the store: tired, so buying takes longer (ADR 0023 decision 7).
    const takes = activityTicks(sim.state.founder, "BUY_MATERIALS", tick(opens));
    applied(sim, buy);
    expect(sim.state.founder.whereabouts).toMatchObject({ busy: { activity: "BUY_MATERIALS", until: opens + takes } });
  });

  it("hours that cross midnight: the back room is open 20:00–02:00", () => {
    const day = TICKS_PER_DAY;
    expect(isOpenAt(LAKEVIEW, tick(day + 20 * 60))).toBe(true);
    expect(isOpenAt(LAKEVIEW, tick(day + 1 * 60 + 59))).toBe(true);
    expect(isOpenAt(LAKEVIEW, tick(day + 2 * 60))).toBe(false);
    expect(opensAt(LAKEVIEW, tick(day + 2 * 60))).toBe(day + 20 * 60);
    expect(isOpenAt(HOLLOW_CREEK, tick(3 * 60))).toBe(true);
  });
});

/** Buys materials at the feed store and brews `cases` of basic moonshine at Hollow Creek. */
function stocked(cases: number): KernelSimulation {
  const sim = game();
  applied(sim, walk(MILLERS_FEED_LOCATION));
  until(sim, (s) => at(s, MILLERS_FEED_LOCATION));
  until(sim, (s) => isOpenAt(MILLERS_FEED_LOCATION, tick(s.tick + 1)));
  for (const [materialId, quantity] of [
    [CORN, 2 * cases],
    [SUGAR, cases],
  ] as const) {
    applied(sim, { type: "PURCHASE_MATERIALS", supplierId: MILLERS_FEED, materialId, quantity, facilityId: DISTILLERY_MAIN });
    until(sim, free);
  }
  applied(sim, walk(HOLLOW_CREEK));
  until(sim, (s) => at(s, HOLLOW_CREEK));
  applied(sim, { type: "START_PRODUCTION", facilityId: DISTILLERY_MAIN, recipeId: BASIC_MOONSHINE_RECIPE, quantity: cases });
  until(sim, (s) => free(s) && s.productionJobs.length === 0);
  sim.takeEvents();
  return sim;
}

/** Walks to the Crossroads, agrees a deal for one case at today's quote once they're open (ADR 0022 decision 3: in person), and walks home. */
function agreeDeal(sim: KernelSimulation): GameState["heldDeals"][number] {
  applied(sim, walk(CROSSROADS));
  until(sim, (s) => at(s, CROSSROADS) && free(s));
  until(sim, (s) => isOpenAt(CROSSROADS, tick(s.tick + 1)) && free(s));
  const ask = (price: number): CommandResult =>
    sim.dispatch({ command: { type: "AGREE_DEAL", buyerId: CROSSROADS_ROADHOUSE, productId: MOONSHINE, quality: "basic", quantity: 1, agreedUnitPrice: price as never } });
  let result = ask(1);
  if (result.status === "rejected" && result.reason.code === "QUOTE_CHANGED") result = ask(result.reason.current);
  expect(result.status).toBe("applied");
  until(sim, free);
  applied(sim, walk(HOLLOW_CREEK));
  until(sim, (s) => at(s, HOLLOW_CREEK) && free(s));
  sim.takeEvents();
  return sim.state.heldDeals.at(-1)!;
}

describe("a batch's clock starts when it's set up (decision 4, #200 follow-up 1)", () => {
  it("startedAt is busy.until, and completesAt counts from it", () => {
    const sim = game();
    applied(sim, walk(MILLERS_FEED_LOCATION));
    until(sim, (s) => at(s, MILLERS_FEED_LOCATION) && free(s) && isOpenAt(MILLERS_FEED_LOCATION, tick(s.tick + 1)));
    for (const [materialId, quantity] of [
      [CORN, 2],
      [SUGAR, 1],
    ] as const) {
      applied(sim, { type: "PURCHASE_MATERIALS", supplierId: MILLERS_FEED, materialId, quantity, facilityId: DISTILLERY_MAIN });
      until(sim, free);
    }
    applied(sim, walk(HOLLOW_CREEK));
    until(sim, (s) => at(s, HOLLOW_CREEK) && free(s));
    const t = sim.state.tick + 1;
    applied(sim, { type: "START_PRODUCTION", facilityId: DISTILLERY_MAIN, recipeId: BASIC_MOONSHINE_RECIPE, quantity: 1 });
    const w = sim.state.founder.whereabouts;
    if (w.kind !== "PRESENT" || w.busy === null) throw new Error("setting up keeps the founder busy");
    const job = sim.state.productionJobs.at(-1)!;
    expect(w.busy.until).toBeGreaterThan(t);
    expect(job.startedAt).toBe(w.busy.until);
  });
});

describe("the founder as driver (decisions 2a, 5)", () => {
  it("loads, rides out, observes at the buyer, rides back, and steps down where the trip started", () => {
    const sim = stocked(2);
    const deal = agreeDeal(sim);
    const t = sim.state.tick + 1;
    const load = activityTicks(sim.state.founder, "LOAD_TRUCK", tick(t));
    const d = route(STATE_HIGHWAY).durationTicks;
    applied(sim, {
      type: "DISPATCH_DELIVERY",
      vehicleId: MODEL_TT_TRUCK,
      cargo: [{ productId: MOONSHINE, quality: "basic", quantity: 1 }],
      purpose: { kind: "SALE", buyerId: CROSSROADS_ROADHOUSE, dealId: deal.id },
      routeId: STATE_HIGHWAY,
      driver: { kind: "FOUNDER" },
    });
    const delivery = sim.state.deliveries.at(-1)!;
    expect(delivery).toMatchObject({ fromFacilityId: DISTILLERY_MAIN, driver: { kind: "FOUNDER" } });
    expect(truck(sim.state)).toMatchObject({ parkedAt: HOLLOW_CREEK, trip: { departedAt: t + load, arrivesAt: t + load + d } });
    expect(sim.state.founder.whereabouts).toEqual({ kind: "PRESENT", locationId: HOLLOW_CREEK, busy: { activity: "LOAD_TRUCK", until: t + load } });

    sim.advance(t + load - 1 - sim.state.tick);
    expect(truck(sim.state).parkedAt).toBe(HOLLOW_CREEK);
    sim.advance(1);
    expect(truck(sim.state).parkedAt).toBeNull();
    expect(sim.state.founder.whereabouts).toEqual({ kind: "ON_DELIVERY", deliveryId: delivery.id, vehicleId: MODEL_TT_TRUCK, atStop: null });

    sim.advance(d);
    expect(sim.state.founder.whereabouts).toEqual({
      kind: "ON_DELIVERY",
      deliveryId: delivery.id,
      vehicleId: MODEL_TT_TRUCK,
      atStop: { locationId: CROSSROADS, tick: t + load + d },
    });
    sim.advance(d);
    expect(sim.state.founder.whereabouts).toEqual({ kind: "PRESENT", locationId: HOLLOW_CREEK, busy: null });
    expect(truck(sim.state)).toMatchObject({ parkedAt: HOLLOW_CREEK, trip: null });
    expect(sim.takeEvents().find((e) => e.type === "VEHICLE_RETURNED")).toMatchObject({ locationId: HOLLOW_CREEK });
  });

  it("needs a driver aboard and the truck where the founder is", () => {
    const sim = stocked(1);
    const deal = agreeDeal(sim);
    const dispatch = (driver: DriverRef | null): GameCommand => ({
      type: "DISPATCH_DELIVERY",
      vehicleId: MODEL_TT_TRUCK,
      cargo: [{ productId: MOONSHINE, quality: "basic", quantity: 1 }],
      purpose: { kind: "SALE", buyerId: CROSSROADS_ROADHOUSE, dealId: deal.id },
      routeId: STATE_HIGHWAY,
      driver,
    });
    expect(rejection(sim, dispatch(null))).toEqual({ code: "NO_DRIVER", vehicleId: MODEL_TT_TRUCK });
    applied(sim, walk(MILLERS_FEED_LOCATION));
    expect(rejection(sim, dispatch({ kind: "FOUNDER" }))).toEqual({ code: "NO_DRIVER", vehicleId: MODEL_TT_TRUCK });
    until(sim, (s) => at(s, MILLERS_FEED_LOCATION));
    expect(rejection(sim, dispatch({ kind: "FOUNDER" }))).toEqual({ code: "VEHICLE_NOT_AT", vehicleId: MODEL_TT_TRUCK, locationId: MILLERS_FEED_LOCATION });
  });
});

describe("with founder rules off nothing moves (decision 9)", () => {
  it("a dispatch leaves at once, the founder stays put and parkedAt never changes", () => {
    const sim = newGame();
    const before = sim.state.founder;
    sim.advance(10 * TICKS_PER_DAY);
    expect(sim.state.founder).toBe(before);
    expect(truck(sim.state).parkedAt).toBe(HOLLOW_CREEK);
  });
});

