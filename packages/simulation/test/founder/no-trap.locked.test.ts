// @locked
// ADR 0023 decision 8 (no traps) acceptance tests for SK1a (issue #198): with
// `founderRules` on, the founder can always rest again within a bound computed
// from game-data, from any reachable state, whatever the place hours, the
// tiredness, the route closures and the commands still queued.
//
// Written ahead of the implementation by a separate test-writer agent
// (factory.md §2, §7.3). Do not edit (CLAUDE.md rule 9).
//
// Imports are limited to the public package entry `src/index.ts`,
// `@eov/contracts` and `@eov/game-data`. Everything is driven through the
// Simulation: commands, ticks and the state it exposes read-only. Every number
// comes from game-data, so PT1's tuning doesn't break these tests.
//
// The property (decision 8, last paragraph). From a reachable state, the player
// issues only the one-click `REST` (decision 7), eagerly, once per tick, and
// advances one tick after each rejection. Let
//   now = the apply tick of the first such REST (`state.tick + 1`),
//   Q   = the latest `scheduledTick` among queued commands issued by the founder,
//         or `now` if there are none,
//   B   = max( longest ACTIVITY_DURATIONS × TIRED_DURATION_PPM,
//              MAX_REST_TICKS,
//              longest delivery round trip + delayTicks + LOAD_TRUCK × TIRED_DURATION_PPM,
//              longest simple path's duration, on foot (× FOOT_TRAVEL_PPM) and by vehicle ),
// all computed from game-data below. The REST is accepted at an apply tick no
// later than `max(now, Q) + B + 1`.
//
// Interpretations pinned here (reported to the orchestrator):
// - `now` is the first REST's apply tick, not `state.tick`. A command the player
//   dispatched eagerly at the same `state.tick` applies at `state.tick + 1` too,
//   and a walk of exactly B ticks started that way ends at `state.tick + 1 + B`;
//   the REST is accepted the tick after, `state.tick + B + 2`. Read as
//   `state.tick`, decision 8's bound would be one tick short in that case, which
//   the "longest walk" example below shows is reachable.
// - "Queued founder commands" are every queued command whose issuer is the
//   FOUNDER. Every player command is (ADR 0022 decision 5), and with founder
//   rules on every timed command takes the founder's time, not just
//   TRAVEL / REST / WAKE.
// - Multiplying by a parts-per-million factor rounds up, per leg or per
//   activity, as decisions 3, 4 and 7 define it.
// - The longest delivery round trip is twice the longest route, and
//   `delayTicks` is the largest of any risky route (decision 8 and ADR 0019
//   don't name a route; this is the most a delivery can take).
// - The one-click REST is exact while paused (decision 7): `untilTick` is the
//   first WAKE_HOUR at or after `apply + MIN_REST_TICKS`, clamped into
//   [apply + MIN_REST_TICKS, apply + MAX_REST_TICKS]. Tick 0 is 00:00.
// - The founder's REST starts at its apply tick (`startedAt`).
//
// Besides the bound, every step checks decision 8 item 1: REST is refused only
// with FOUNDER_AWAY or FOUNDER_BUSY (never for place, hours, cash, tiredness,
// or the one-click length), and is never refused while the founder is PRESENT,
// not busy, with no queued command due on the apply tick. Once accepted, the
// founder is RESTING where they were, until the requested tick.

import {
  asId,
  cents,
  minuteOfDay,
  TICKS_PER_DAY,
  TICKS_PER_HOUR,
  tick,
  type ActivityKind,
  type CommandResult,
  type GameCommand,
  type GameState,
  type LocationId,
  type Money,
  type RouteLeg,
  type Tick,
} from "@eov/contracts";
import {
  ACTIVITY_DURATIONS,
  BASIC_MOONSHINE_RECIPE,
  BUYERS,
  CORN,
  COUNTY_ROAD,
  CROSSROADS,
  DISTILLERY_MAIN,
  EQUIPMENT,
  FIRST_SHIPMENT_SCENARIO,
  FOOT_TRAVEL_PPM,
  HOLLOW_CREEK,
  LAKE_SHORE_DRIVE,
  LAKEVIEW,
  LAKEVIEW_BACK_ROAD,
  LOCATIONS,
  MAX_REST_TICKS,
  MILLERS_FEED,
  MILLERS_FEED_LOCATION,
  MIN_REST_TICKS,
  MODEL_TT_TRUCK,
  MOONSHINE,
  PLACE_HOURS,
  ROUTES,
  START_WAKE_TICK,
  STATE_HIGHWAY,
  CROSSROADS_ROADHOUSE,
  CROSSROADS_BACK_ROAD,
  KESSLER_BACK_ROAD,
  FEED_STORE_ROAD,
  STANDARD_MOONSHINE_RECIPE,
  SUGAR,
  TIRED_AFTER_TICKS,
  TIRED_DURATION_PPM,
  WAKE_HOUR,
  type ScenarioDefinition,
  type ScenarioScheduledEvent,
} from "@eov/game-data";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { loadGame, newGame, type KernelSimulation } from "../../src/index.ts";

// ---------------------------------------------------------------------------
// Scenario and game-data arithmetic
// ---------------------------------------------------------------------------

/** The First Shipment with the founder's rules on, at M002 pacing (ADR 0023 decision 9). */
const FOUNDER_SCENARIO: ScenarioDefinition = {
  ...FIRST_SHIPMENT_SCENARIO,
  scheduledEvents: [],
  founderRules: true,
  realMsPerGameHourAt1x: 20_000,
};

const PPM = 1_000_000;
/** `value × ppm / 1 000 000`, rounded up, in integers. */
const scaleUp = (value: number, ppm: number): number => Math.floor((value * ppm + PPM - 1) / PPM);
const tired = (duration: number): number => scaleUp(duration, TIRED_DURATION_PPM);
const footTicks = (routeDuration: number): number => scaleUp(routeDuration, FOOT_TRAVEL_PPM);
const routeById = (id: string) => {
  const r = ROUTES.find((x) => x.id === id);
  if (!r) throw new Error(`no route ${id}`);
  return r;
};

interface WeightedPath {
  readonly start: LocationId;
  readonly legs: readonly RouteLeg[];
  readonly ticks: number;
}

/** The longest simple path (no location twice, decision 3) by the given leg duration, over every route in either direction. */
function longestSimplePath(legTicks: (routeDuration: number) => number): WeightedPath {
  let best: WeightedPath = { start: HOLLOW_CREEK, legs: [], ticks: 0 };
  const walk = (start: LocationId, at: LocationId, visited: Set<string>, legs: RouteLeg[], ticks: number): void => {
    if (ticks > best.ticks) best = { start, legs: [...legs], ticks };
    for (const r of ROUTES) {
      for (const reversed of [false, true]) {
        const from = reversed ? r.toLocationId : r.fromLocationId;
        const to = reversed ? r.fromLocationId : r.toLocationId;
        if (from !== at || visited.has(to)) continue;
        visited.add(to);
        legs.push({ routeId: r.id, reversed });
        walk(start, to, visited, legs, ticks + legTicks(r.durationTicks));
        legs.pop();
        visited.delete(to);
      }
    }
  };
  for (const l of LOCATIONS) walk(l.id, l.id, new Set([l.id]), [], 0);
  return best;
}

const LONGEST_WALK = longestSimplePath(footTicks);
const LONGEST_DRIVE = longestSimplePath((d) => d);
const LONGEST_ACTIVITY = Math.max(...Object.values(ACTIVITY_DURATIONS));
const LONGEST_ROUTE = Math.max(...ROUTES.map((r) => r.durationTicks));
const LONGEST_DELAY = Math.max(0, ...ROUTES.filter((r) => r.riskPpm > 0).map((r) => r.delayTicks));

/** Decision 8's B, from game-data. */
const B = Math.max(
  tired(LONGEST_ACTIVITY),
  MAX_REST_TICKS,
  2 * LONGEST_ROUTE + LONGEST_DELAY + tired(ACTIVITY_DURATIONS.LOAD_TRUCK),
  LONGEST_WALK.ticks,
  LONGEST_DRIVE.ticks,
);

/** How long an activity keeps the founder busy when it applies at `applyTick` (decision 4, 7). */
function activityTicks(kind: ActivityKind, state: GameState, applyTick: number): number {
  const base = ACTIVITY_DURATIONS[kind];
  return applyTick - state.founder.awakeSince > TIRED_AFTER_TICKS ? tired(base) : base;
}

/** The one-click "rest until morning" for a command applying at `applyTick` (decision 7, paused: exact). */
function oneClickRestUntil(applyTick: number): Tick {
  const earliest = applyTick + MIN_REST_TICKS;
  const latest = applyTick + MAX_REST_TICKS;
  let next = earliest - minuteOfDay(tick(earliest)) + WAKE_HOUR * TICKS_PER_HOUR;
  if (next < earliest) next += TICKS_PER_DAY;
  return tick(Math.min(Math.max(next, earliest), latest));
}

function isOpen(locationId: LocationId, t: number): boolean {
  const entry = PLACE_HOURS.find((h) => h.locationId === locationId);
  if (!entry) return true;
  const m = minuteOfDay(tick(t));
  return entry.intervals.some(({ opensAtMinute: o, closesAtMinute: c }) => (o < c ? m >= o && m < c : m >= o || m < c));
}

// ---------------------------------------------------------------------------
// Driving the simulation
// ---------------------------------------------------------------------------

const isFree = (s: GameState): boolean => s.founder.whereabouts.kind === "PRESENT" && s.founder.whereabouts.busy === null;
const presentAt = (s: GameState, locationId: LocationId): boolean =>
  s.founder.whereabouts.kind === "PRESENT" && s.founder.whereabouts.locationId === locationId;

function advanceUntil(sim: KernelSimulation, done: (s: GameState) => boolean, maxTicks: number, what: string): void {
  for (let i = 0; i < maxTicks; i++) {
    if (done(sim.state)) return;
    sim.advance(1);
  }
  if (!done(sim.state)) {
    throw new Error(`Not reached within ${maxTicks} ticks: ${what} (tick ${sim.state.tick}, founder ${JSON.stringify(sim.state.founder)})`);
  }
}

function expectApplied(result: CommandResult, what: string): void {
  if (result.status !== "applied") throw new Error(`${what}: expected applied, got ${JSON.stringify(result)}`);
}

interface Measurement {
  readonly now: number;
  readonly q: number;
  readonly bound: number;
  readonly acceptedAt: number;
  readonly rejections: readonly { readonly applyTick: number; readonly code: string }[];
}

/**
 * Decision 8's experiment: the one-click REST each tick until it's accepted.
 * Checks item 1 at every step and the bound at the end. Throws (fails the test)
 * on any violation.
 */
function restUntilAccepted(sim: KernelSimulation): Measurement {
  const now = sim.state.tick + 1;
  const queued = sim.state.queuedCommands.filter((e) => e.issuer.kind === "FOUNDER").map((e) => e.scheduledTick as number);
  const q = Math.max(now, ...queued);
  const bound = q + B + 1;
  const rejections: { applyTick: number; code: string }[] = [];
  for (;;) {
    const before = sim.state;
    const applyTick = before.tick + 1;
    if (applyTick > bound) {
      throw new Error(
        `Trapped: REST still refused at apply tick ${applyTick} > bound ${bound} (now ${now}, Q ${q}, B ${B}); ` +
          `founder ${JSON.stringify(before.founder)}; last rejections ${JSON.stringify(rejections.slice(-3))}`,
      );
    }
    const untilTick = oneClickRestUntil(applyTick);
    const result = sim.dispatch({ command: { type: "REST", untilTick } });
    const dueNow = before.queuedCommands.some((e) => e.scheduledTick === applyTick);
    if (result.status === "applied") {
      expect(result.tick).toBe(applyTick);
      const w = before.founder.whereabouts;
      // Accepted means the founder was at a place: present there, or (only if a queued WAKE ran first) resting there.
      expect(w.kind === "PRESENT" || (w.kind === "RESTING" && dueNow)).toBe(true);
      const locationId = w.kind === "PRESENT" || w.kind === "RESTING" ? w.locationId : null;
      expect(sim.state.founder.whereabouts).toEqual({ kind: "RESTING", locationId, startedAt: applyTick, until: untilTick });
      return { now, q, bound, acceptedAt: applyTick, rejections };
    }
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") throw new Error("unreachable");
    // Item 1: never refused for location, hours, cash, tiredness, or the one-click length.
    expect(["FOUNDER_AWAY", "FOUNDER_BUSY"]).toContain(result.reason.code);
    if (result.reason.code === "FOUNDER_BUSY") expect(result.reason.until).toBeGreaterThanOrEqual(applyTick);
    // A free founder with nothing queued for this tick is never refused.
    if (isFree(before) && !dueNow) {
      throw new Error(`REST refused for a free founder at apply tick ${applyTick}: ${JSON.stringify(result.reason)}`);
    }
    rejections.push({ applyTick, code: result.reason.code });
    sim.advance(1);
  }
}

/** A fresh game under founder rules, awake and free at Hollow Creek. */
function awakeGame(scenario: ScenarioDefinition = FOUNDER_SCENARIO): KernelSimulation {
  const sim = newGame({ scenario });
  advanceUntil(sim, isFree, START_WAKE_TICK + 2, "the founder wakes on the first morning");
  return sim;
}

function walkTo(sim: KernelSimulation, destinationLocationId: LocationId, maxTicks: number): void {
  expectApplied(sim.dispatch({ command: { type: "TRAVEL", destinationLocationId, transport: { kind: "FOOT" }, via: null } }), `walk to ${destinationLocationId}`);
  advanceUntil(sim, (s) => presentAt(s, destinationLocationId) && isFree(s), maxTicks, `the founder arrives at ${destinationLocationId}`);
}

const STOCKED_CASES = 4;

let stockedSave: ReturnType<KernelSimulation["serialize"]> | null = null;

/**
 * A reachable state with moonshine in the distillery, so deliveries can be
 * driven: the founder walks to the feed store, buys materials during its
 * hours, walks back and runs a batch.
 */
function stockedGame(): KernelSimulation {
  if (!stockedSave) {
    const sim = awakeGame();
    walkTo(sim, MILLERS_FEED_LOCATION, 2 * TICKS_PER_DAY);
    advanceUntil(sim, (s) => isOpen(MILLERS_FEED_LOCATION, s.tick + 1), TICKS_PER_DAY, "the feed store opens");
    for (const [materialId, quantity] of [
      [CORN, 2 * STOCKED_CASES],
      [SUGAR, STOCKED_CASES],
    ] as const) {
      expectApplied(
        sim.dispatch({ command: { type: "PURCHASE_MATERIALS", supplierId: MILLERS_FEED, materialId, quantity, facilityId: DISTILLERY_MAIN } }),
        `buy ${materialId}`,
      );
      advanceUntil(sim, isFree, TICKS_PER_DAY, "buying ends");
    }
    walkTo(sim, HOLLOW_CREEK, 2 * TICKS_PER_DAY);
    expectApplied(
      sim.dispatch({ command: { type: "START_PRODUCTION", facilityId: DISTILLERY_MAIN, recipeId: BASIC_MOONSHINE_RECIPE, quantity: STOCKED_CASES } }),
      "start the batch",
    );
    advanceUntil(
      sim,
      (s) =>
        isFree(s) &&
        s.productionJobs.length === 0 &&
        s.productPools.some((p) => p.facilityId === DISTILLERY_MAIN && p.productId === MOONSHINE && p.quantity >= STOCKED_CASES),
      4 * TICKS_PER_DAY,
      "the batch completes",
    );
    stockedSave = sim.serialize();
  }
  return loadGame(stockedSave, { scenario: FOUNDER_SCENARIO });
}

// ---------------------------------------------------------------------------
// The bound itself
// ---------------------------------------------------------------------------

describe("decision 8's bound B, from game-data", () => {
  it("covers every term, each finite and positive", () => {
    expect(Number.isSafeInteger(B)).toBe(true);
    expect(B).toBeGreaterThanOrEqual(tired(LONGEST_ACTIVITY));
    expect(B).toBeGreaterThanOrEqual(MAX_REST_TICKS);
    expect(B).toBeGreaterThanOrEqual(2 * LONGEST_ROUTE + LONGEST_DELAY + tired(ACTIVITY_DURATIONS.LOAD_TRUCK));
    expect(B).toBeGreaterThanOrEqual(LONGEST_WALK.ticks);
    expect(B).toBeGreaterThanOrEqual(LONGEST_DRIVE.ticks);
    // Walking is never faster than driving (FOOT_TRAVEL_PPM ≥ 1 000 000), so the walk dominates the drive.
    expect(LONGEST_WALK.ticks).toBeGreaterThanOrEqual(LONGEST_DRIVE.ticks);
    expect(LONGEST_WALK.legs.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Focused examples
// ---------------------------------------------------------------------------

describe("no traps: focused cases (ADR 0023 decisions 2a, 4, 7, 8)", () => {
  it("from the first night: refused as RESTING through START_WAKE_TICK, accepted the tick after", () => {
    const sim = newGame({ scenario: FOUNDER_SCENARIO });
    const m = restUntilAccepted(sim);
    expect(m.now).toBe(1);
    expect(m.acceptedAt).toBe(START_WAKE_TICK + 1);
    expect(new Set(m.rejections.map((r) => r.code))).toEqual(new Set(["FOUNDER_AWAY"]));
    expect(m.rejections.at(-1)?.applyTick).toBe(START_WAKE_TICK);
    expect(m.acceptedAt).toBeLessThanOrEqual(m.bound);
  });

  it("a busy activity ending this tick: REST and TRAVEL on the end tick are FOUNDER_BUSY; REST is accepted the next tick", () => {
    const sim = awakeGame();
    const t = sim.state.tick + 1;
    const workers = sim.state.facilities.find((f) => f.id === DISTILLERY_MAIN)!.workerCount;
    const duration = activityTicks("SET_WORKFORCE", sim.state, t);
    expectApplied(sim.dispatch({ command: { type: "SET_WORKFORCE", facilityId: DISTILLERY_MAIN, workerCount: Math.max(0, workers - 1) } }), "set workforce");
    const end = t + duration;
    expect(sim.state.founder.whereabouts).toEqual({ kind: "PRESENT", locationId: HOLLOW_CREEK, busy: { activity: "SET_WORKFORCE", until: end }, call: null });

    // On the end tick itself, the busy gate's `≥` still holds the founder (decision 2a).
    sim.advance(end - 1 - sim.state.tick);
    expect(sim.dispatch({ command: { type: "REST", untilTick: oneClickRestUntil(end) } })).toMatchObject({
      status: "rejected",
      reason: { code: "FOUNDER_BUSY", until: end },
    });
    expect(
      sim.dispatch({ command: { type: "TRAVEL", destinationLocationId: MILLERS_FEED_LOCATION, transport: { kind: "FOOT" }, via: null } }),
    ).toMatchObject({ status: "rejected", reason: { code: "FOUNDER_BUSY", until: end } });

    const m = restUntilAccepted(sim);
    expect(m.now).toBe(end);
    expect(m.acceptedAt).toBe(end + 1);
    expect(m.rejections).toEqual([{ applyTick: end, code: "FOUNDER_BUSY" }]);
  });

  it("counting from the activity's own apply tick: REST dispatched with it is accepted exactly at end + 1", () => {
    const sim = awakeGame();
    const t = sim.state.tick + 1;
    const duration = activityTicks("SET_WORKFORCE", sim.state, t);
    expectApplied(sim.dispatch({ command: { type: "SET_WORKFORCE", facilityId: DISTILLERY_MAIN, workerCount: 1 } }), "set workforce");
    const m = restUntilAccepted(sim);
    expect(m.now).toBe(t);
    expect(m.acceptedAt).toBe(t + duration + 1);
    expect(m.rejections.every((r) => r.code === "FOUNDER_BUSY")).toBe(true);
    expect(m.rejections).toHaveLength(duration + 1);
  });

  it("a tired founder works slower (× TIRED_DURATION_PPM, rounded up) but is never refused for it", () => {
    const sim = awakeGame();
    advanceUntil(sim, (s) => s.tick + 1 - s.founder.awakeSince > TIRED_AFTER_TICKS, 3 * TICKS_PER_DAY, "the founder is tired");
    const t = sim.state.tick + 1;
    expectApplied(sim.dispatch({ command: { type: "SET_WORKFORCE", facilityId: DISTILLERY_MAIN, workerCount: 2 } }), "set workforce while tired");
    const end = t + tired(ACTIVITY_DURATIONS.SET_WORKFORCE);
    expect(sim.state.founder.whereabouts).toEqual({ kind: "PRESENT", locationId: HOLLOW_CREEK, busy: { activity: "SET_WORKFORCE", until: end }, call: null });
    const m = restUntilAccepted(sim);
    expect(m.acceptedAt).toBe(end + 1);
    expect(m.acceptedAt).toBeLessThanOrEqual(m.bound);
  });

  it("a rest of MAX_REST_TICKS: refused as RESTING through its end, accepted the tick after", () => {
    const sim = awakeGame();
    const t = sim.state.tick + 1;
    expectApplied(sim.dispatch({ command: { type: "REST", untilTick: tick(t + MAX_REST_TICKS) } }), "a maximal rest");
    const m = restUntilAccepted(sim);
    expect(m.acceptedAt).toBe(t + MAX_REST_TICKS + 1);
    expect(m.rejections.every((r) => r.code === "FOUNDER_AWAY")).toBe(true);
    expect(m.acceptedAt).toBeLessThanOrEqual(m.bound);
  });

  it("the longest walk reaches the bound exactly: REST at now + B + 1 (the off-by-one)", () => {
    const sim = awakeGame();
    if (LONGEST_WALK.start !== HOLLOW_CREEK) walkTo(sim, LONGEST_WALK.start, 3 * TICKS_PER_DAY);
    const t = sim.state.tick + 1;
    const destination = (() => {
      let at: LocationId = LONGEST_WALK.start;
      for (const leg of LONGEST_WALK.legs) {
        const r = routeById(leg.routeId);
        at = leg.reversed ? r.fromLocationId : r.toLocationId;
      }
      return at;
    })();
    expectApplied(
      sim.dispatch({ command: { type: "TRAVEL", destinationLocationId: destination, transport: { kind: "FOOT" }, via: LONGEST_WALK.legs } }),
      "the longest walk",
    );
    expect(sim.state.founder.whereabouts.kind).toBe("TRAVELLING");
    const m = restUntilAccepted(sim);
    expect(m.now).toBe(t);
    expect(m.acceptedAt).toBe(t + LONGEST_WALK.ticks + 1);
    expect(m.rejections.every((r) => r.code === "FOUNDER_AWAY")).toBe(true);
    if (LONGEST_WALK.ticks === B) expect(m.acceptedAt).toBe(m.bound);
    expect(m.acceptedAt).toBeLessThanOrEqual(m.bound);
  });

  it("queued commands apply before a fresh REST on their tick and extend the wait, but only up to max(now, Q) + B + 1", () => {
    const sim = awakeGame();
    const t = sim.state.tick + 1;
    const busyFor = activityTicks("SET_WORKFORCE", sim.state, t);
    // Queued while the founder is free: a walk for the tick they're first free
    // after the activity below, then a REST while they'll be walking (rejected
    // when it applies).
    const q1 = t + busyFor + 1;
    expect(
      sim.dispatch({ command: { type: "TRAVEL", destinationLocationId: LAKEVIEW, transport: { kind: "FOOT" }, via: null }, scheduledTick: tick(q1) }),
    ).toMatchObject({ status: "queued" });
    const q2 = q1 + 5;
    expect(sim.dispatch({ command: { type: "REST", untilTick: tick(q2 + MIN_REST_TICKS) }, scheduledTick: tick(q2) })).toMatchObject({
      status: "queued",
    });
    expectApplied(sim.dispatch({ command: { type: "SET_WORKFORCE", facilityId: DISTILLERY_MAIN, workerCount: 2 } }), "set workforce");
    expect(sim.state.founder.whereabouts).toMatchObject({ kind: "PRESENT", busy: { activity: "SET_WORKFORCE", until: t + busyFor } });
    const walk = Math.min(
      ...[LAKE_SHORE_DRIVE, LAKEVIEW_BACK_ROAD].map((id) => footTicks(routeById(id).durationTicks)),
    );
    const m = restUntilAccepted(sim);
    expect(m.q).toBe(q2);
    // Busy through its end, then the queued walk wins tick q1 and the founder is away until they arrive.
    expect(m.rejections.find((r) => r.applyTick === q1)?.code).toBe("FOUNDER_AWAY");
    expect(m.acceptedAt).toBe(q1 + walk + 1);
    expect(sim.state.founder.whereabouts).toMatchObject({ kind: "RESTING", locationId: LAKEVIEW });
    expect(m.acceptedAt).toBeLessThanOrEqual(m.bound);
  });

  it("driving a delivery: busy loading, away on the round trip, accepted the tick after the truck is home", () => {
    const sim = stockedGame();
    // A sale carries out a held deal (ADR 0022 decision 6; on spec is SK1c's):
    // agree one case at the Crossroads at today's quote, then dispatch it.
    advanceUntil(sim, (s) => isOpen(CROSSROADS, s.tick + 1) && isFree(s), TICKS_PER_DAY, "the Crossroads opens");
    const agree = (price: number): CommandResult =>
      sim.dispatch({
        command: { type: "AGREE_DEAL", buyerId: CROSSROADS_ROADHOUSE, productId: MOONSHINE, quality: "basic", quantity: 1, agreedUnitPrice: cents(price) },
      });
    let agreed = agree(1);
    if (agreed.status === "rejected" && agreed.reason.code === "QUOTE_CHANGED") agreed = agree(agreed.reason.current);
    expectApplied(agreed, "agree a deal at the Crossroads");
    advanceUntil(sim, isFree, TICKS_PER_DAY, "agreeing ends");
    const deal = sim.state.heldDeals.at(-1)!;
    expect(deal).toMatchObject({ buyerId: CROSSROADS_ROADHOUSE, quantity: 1, status: "HELD" });
    const t = sim.state.tick + 1;
    const load = activityTicks("LOAD_TRUCK", sim.state, t);
    expectApplied(
      sim.dispatch({
        command: {
          type: "DISPATCH_DELIVERY",
          vehicleId: MODEL_TT_TRUCK,
          cargo: [{ productId: MOONSHINE, quality: "basic", quantity: 1 }],
          purpose: { kind: "SALE", buyerId: CROSSROADS_ROADHOUSE, dealId: deal.id },
          routeId: STATE_HIGHWAY,
          driver: { kind: "FOUNDER" },
        },
      }),
      "dispatch with the founder driving",
    );
    expect(sim.state.founder.whereabouts).toEqual({ kind: "PRESENT", locationId: HOLLOW_CREEK, busy: { activity: "LOAD_TRUCK", until: t + load }, call: null });
    const home = t + load + 2 * routeById(STATE_HIGHWAY).durationTicks;
    const m = restUntilAccepted(sim);
    expect(m.acceptedAt).toBe(home + 1);
    expect(m.rejections.filter((r) => r.code === "FOUNDER_BUSY").map((r) => r.applyTick)).toEqual(
      Array.from({ length: load + 1 }, (_, i) => t + i),
    );
    expect(m.rejections.filter((r) => r.code === "FOUNDER_AWAY")).toHaveLength(home - (t + load));
    expect(sim.state.founder.whereabouts).toMatchObject({ kind: "RESTING", locationId: HOLLOW_CREEK });
    expect(m.acceptedAt).toBeLessThanOrEqual(m.bound);
  });
});

// ---------------------------------------------------------------------------
// The property
// ---------------------------------------------------------------------------

const PROPERTY_SEED = 23_008;
const LOCATION_IDS = LOCATIONS.map((l) => l.id);
const BUYER_IDS = BUYERS.map((b) => b.id);
const EQUIPMENT_IDS = EQUIPMENT.map((e) => e.id);
/** Routes with state in the First Shipment (both ends occupied), so a scenario may close them. */
const CLOSABLE_ROUTES = [STATE_HIGHWAY, COUNTY_ROAD, LAKE_SHORE_DRIVE, CROSSROADS_BACK_ROAD, KESSLER_BACK_ROAD, LAKEVIEW_BACK_ROAD, FEED_STORE_ROAD];

type When = { readonly kind: "eager" } | { readonly kind: "queued"; readonly offset: number };

type Action =
  | { readonly kind: "advance"; readonly ticks: number }
  | { readonly kind: "settle" }
  | { readonly kind: "sale"; readonly buyerId: (typeof BUYER_IDS)[number]; readonly quantity: number; readonly routeId: RouteLeg["routeId"] | null }
  | { readonly kind: "command"; readonly when: When; readonly build: (s: GameState, applyTick: number) => GameCommand | null };

const whenArb: fc.Arbitrary<When> = fc.oneof(
  { weight: 3, arbitrary: fc.constant({ kind: "eager" } as const) },
  { weight: 1, arbitrary: fc.integer({ min: 2, max: 900 }).map((offset) => ({ kind: "queued", offset }) as const) },
);

const legArb: fc.Arbitrary<RouteLeg> = fc.record({ routeId: fc.constantFrom(...ROUTES.map((r) => r.id)), reversed: fc.boolean() });

const commandArb: fc.Arbitrary<(s: GameState, applyTick: number) => GameCommand | null> = fc.oneof(
  // TRAVEL: anywhere, on foot or by truck, default or an arbitrary (possibly invalid) path.
  fc
    .record({
      destination: fc.constantFrom(...LOCATION_IDS),
      byTruck: fc.boolean(),
      via: fc.option(fc.array(legArb, { minLength: 1, maxLength: 3 }), { nil: null }),
    })
    .map(({ destination, byTruck, via }) => (): GameCommand => ({
      type: "TRAVEL",
      destinationLocationId: destination,
      transport: byTruck ? { kind: "VEHICLE", vehicleId: MODEL_TT_TRUCK } : { kind: "FOOT" },
      via,
    })),
  // REST: mostly valid lengths, sometimes just outside the range.
  fc.integer({ min: MIN_REST_TICKS - 3, max: MAX_REST_TICKS + 3 }).map((length) => (_s: GameState, applyTick: number): GameCommand => ({
    type: "REST",
    untilTick: tick(applyTick + length),
  })),
  fc.constant((): GameCommand => ({ type: "WAKE" })),
  // Timed activities.
  fc
    .record({ materialId: fc.constantFrom(CORN, SUGAR), quantity: fc.integer({ min: 1, max: 12 }) })
    .map(({ materialId, quantity }) => (): GameCommand => ({ type: "PURCHASE_MATERIALS", supplierId: MILLERS_FEED, materialId, quantity, facilityId: DISTILLERY_MAIN })),
  fc
    .record({ recipeId: fc.constantFrom(BASIC_MOONSHINE_RECIPE, STANDARD_MOONSHINE_RECIPE), quantity: fc.integer({ min: 1, max: 3 }) })
    .map(({ recipeId, quantity }) => (): GameCommand => ({ type: "START_PRODUCTION", facilityId: DISTILLERY_MAIN, recipeId, quantity })),
  // DISPATCH_DELIVERY of a held deal (ADR 0022 decision 6): mostly one the
  // founder holds, carried out as agreed; sometimes any deal on record or one
  // that was never agreed, which is rejected. (A sale on spec, `dealId: null`,
  // is SK1c's and rejected until then.)
  fc
    .record({
      pick: fc.nat(),
      deal: fc.oneof(
        { weight: 4, arbitrary: fc.constant("held" as const) },
        { weight: 1, arbitrary: fc.constant("any" as const) },
        { weight: 1, arbitrary: fc.constant("unknown" as const) },
      ),
      buyerId: fc.constantFrom(...BUYER_IDS),
      quantity: fc.integer({ min: 1, max: 2 }),
      routeId: fc.option(fc.constantFrom(...ROUTES.map((r) => r.id)), { nil: null }),
    })
    .map(({ pick, deal, buyerId, quantity, routeId }) => (s: GameState): GameCommand => {
      const pool = deal === "held" ? s.heldDeals.filter((d) => d.status === "HELD") : deal === "any" ? s.heldDeals : [];
      const chosen = pool[pick % Math.max(1, pool.length)];
      return {
        type: "DISPATCH_DELIVERY",
        vehicleId: MODEL_TT_TRUCK,
        cargo: [{ productId: MOONSHINE, quality: chosen?.quality ?? "basic", quantity: chosen?.quantity ?? quantity }],
        purpose: { kind: "SALE", buyerId: chosen?.buyerId ?? buyerId, dealId: chosen?.id ?? asId("Deal", "deal-never-agreed") },
        routeId,
        driver: { kind: "FOUNDER" },
      };
    }),
  // AGREE_DEAL: mostly at the buyer's current quote, so deals get held; sometimes at an arbitrary price.
  fc
    .record({
      buyerId: fc.constantFrom(...BUYER_IDS),
      quantity: fc.integer({ min: 1, max: 3 }),
      price: fc.option(fc.integer({ min: 100, max: 3_000 }), { nil: null, freq: 2 }),
    })
    .map(({ buyerId, quantity, price }) => (s: GameState): GameCommand => {
      const quote = s.buyers.find((b) => b.id === buyerId)?.wants.find((w) => w.productId === MOONSHINE)?.unitPrice;
      return {
        type: "AGREE_DEAL",
        buyerId,
        productId: MOONSHINE,
        quality: "basic",
        quantity,
        agreedUnitPrice: price === null ? (quote ?? cents(1)) : cents(price),
      };
    }),
  fc.nat().map((pick) => (s: GameState): GameCommand | null => {
    const offer = s.contractOffers[pick % Math.max(1, s.contractOffers.length)];
    return offer ? { type: "ACCEPT_CONTRACT", contractOfferId: offer.id } : null;
  }),
  fc.integer({ min: 0, max: 6 }).map((workerCount) => (): GameCommand => ({ type: "SET_WORKFORCE", facilityId: DISTILLERY_MAIN, workerCount })),
  fc
    .record({ equipmentId: fc.constantFrom(...EQUIPMENT_IDS), sell: fc.boolean() })
    .map(({ equipmentId, sell }) => (): GameCommand => ({ type: sell ? "SELL_EQUIPMENT" : "PURCHASE_EQUIPMENT", facilityId: DISTILLERY_MAIN, equipmentId })),
  fc.nat().map((pick) => (s: GameState): GameCommand | null => {
    const sources = s.commandLog.filter((e) => ["PURCHASE_MATERIALS", "START_PRODUCTION", "DISPATCH_DELIVERY"].includes(e.command.type));
    const source = sources[pick % Math.max(1, sources.length)];
    return source ? { type: "REPEAT_OPERATION", sourceCommandId: source.id } : null;
  }),
);

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  // Short steps land on activity and leg boundaries; long ones reach tiredness, other hours of the day, and the closures.
  { weight: 2, arbitrary: fc.integer({ min: 0, max: 60 }).map((ticks) => ({ kind: "advance", ticks }) as const) },
  { weight: 2, arbitrary: fc.integer({ min: 0, max: 720 }).map((ticks) => ({ kind: "advance", ticks }) as const) },
  { weight: 1, arbitrary: fc.integer({ min: 720, max: 2 * TICKS_PER_DAY }).map((ticks) => ({ kind: "advance", ticks }) as const) },
  { weight: 1, arbitrary: fc.constant({ kind: "settle" } as const) },
  // A sale the way the player makes one: agree a deal at the quote, then drive it out, so deliveries actually leave.
  {
    weight: 2,
    arbitrary: fc
      .record({
        buyerId: fc.constantFrom(...BUYER_IDS),
        quantity: fc.integer({ min: 1, max: 2 }),
        routeId: fc.option(fc.constantFrom(...ROUTES.map((r) => r.id)), { nil: null }),
      })
      .map((sale) => ({ kind: "sale", ...sale }) as const),
  },
  { weight: 6, arbitrary: fc.record({ when: whenArb, build: commandArb }).map(({ when, build }) => ({ kind: "command", when, build }) as const) },
);

const closureArb: fc.Arbitrary<ScenarioScheduledEvent> = fc.record({
  kind: fc.constant("ROUTE_CLOSURE" as const),
  tick: fc.integer({ min: 1, max: 4 * TICKS_PER_DAY }).map((t) => tick(t)),
  routeId: fc.constantFrom(...CLOSABLE_ROUTES),
  reason: fc.constantFrom("RIVAL" as const, "POLICE" as const),
  durationTicks: fc.integer({ min: 1, max: 2 * TICKS_PER_DAY }),
});

type Start = { readonly kind: "fresh"; readonly closures: readonly ScenarioScheduledEvent[] } | { readonly kind: "stocked" };

const startArb: fc.Arbitrary<Start> = fc.oneof(
  fc.array(closureArb, { maxLength: 3 }).map((closures) => ({ kind: "fresh", closures }) as const),
  fc.constant({ kind: "stocked" } as const),
);

/**
 * AGREE_DEAL at the buyer's quote once they're open and the founder is free,
 * then DISPATCH_DELIVERY of that deal by its id (ADR 0022 decision 6). Either
 * step may be rejected (closed all day, reputation, stock, the truck away);
 * the sale is then dropped, as a player would.
 */
function sellOnDeal(sim: KernelSimulation, sale: Extract<Action, { kind: "sale" }>): void {
  const locationId = BUYERS.find((b) => b.id === sale.buyerId)!.locationId;
  for (let i = 0; i < TICKS_PER_DAY && !(isOpen(locationId, sim.state.tick + 1) && isFree(sim.state)); i++) sim.advance(1);
  const agree = (price: Money): CommandResult =>
    sim.dispatch({
      command: { type: "AGREE_DEAL", buyerId: sale.buyerId, productId: MOONSHINE, quality: "basic", quantity: sale.quantity, agreedUnitPrice: price },
    });
  const quote = sim.state.buyers.find((b) => b.id === sale.buyerId)?.wants.find((w) => w.productId === MOONSHINE)?.unitPrice ?? cents(1);
  let agreed = agree(quote);
  if (agreed.status === "rejected" && agreed.reason.code === "QUOTE_CHANGED") agreed = agree(agreed.reason.current);
  if (agreed.status !== "applied") return;
  const deal = sim.state.heldDeals.at(-1)!;
  for (let i = 0; i < TICKS_PER_DAY && !isFree(sim.state); i++) sim.advance(1);
  sim.dispatch({
    command: {
      type: "DISPATCH_DELIVERY",
      vehicleId: MODEL_TT_TRUCK,
      cargo: [{ productId: deal.productId, quality: deal.quality, quantity: deal.quantity }],
      purpose: { kind: "SALE", buyerId: deal.buyerId, dealId: deal.id },
      routeId: sale.routeId,
      driver: { kind: "FOUNDER" },
    },
  });
}

function play(start: Start, actions: readonly Action[]): KernelSimulation {
  const sim = start.kind === "stocked" ? stockedGame() : newGame({ scenario: { ...FOUNDER_SCENARIO, scheduledEvents: start.closures } });
  for (const action of actions) {
    if (action.kind === "advance") sim.advance(action.ticks);
    else if (action.kind === "settle") {
      for (let i = 0; i < 2 * B && !isFree(sim.state); i++) sim.advance(1);
    } else if (action.kind === "sale") {
      sellOnDeal(sim, action);
    } else {
      const applyTick = action.when.kind === "eager" ? sim.state.tick + 1 : sim.state.tick + action.when.offset;
      const command = action.build(sim.state, applyTick);
      if (command) sim.dispatch(action.when.kind === "eager" ? { command } : { command, scheduledTick: tick(applyTick) });
    }
  }
  return sim;
}

describe("no traps: the property (ADR 0023 decision 8)", () => {
  it("from any reachable state, the one-click REST is accepted by max(now, Q) + B + 1", () => {
    fc.assert(
      fc.property(startArb, fc.array(actionArb, { maxLength: 20 }), (start, actions) => {
        // A finished game (won or lost) still runs commands and ticks (ADR 0020 decision 8), so it's no exception.
        const sim = play(start, actions);
        const m = restUntilAccepted(sim);
        expect(m.acceptedAt).toBeLessThanOrEqual(m.bound);
      }),
      { seed: PROPERTY_SEED, numRuns: 200, endOnFailure: true },
    );
  });
});
