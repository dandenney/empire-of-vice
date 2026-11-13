// @locked
// ADR 0021 decision 9 (the static non-leak property) acceptance tests for SK1b
// (issue #199), with the decision's renaming canonicaliser. States are reachable
// with `founderRules` on: the First Shipment with the flag, as
// `founder/no-trap.locked.test.ts` builds them.
//
// Written ahead of the implementation by a separate test-writer agent
// (factory.md §2, §7.3). Do not edit (CLAUDE.md rule 9).
//
// Imports are limited to the public package entry `src/index.ts`,
// `@eov/contracts` and `@eov/game-data`. Everything runs through the Simulation:
// commands, ticks, `serialize` / `loadGame`, the state it exposes read-only, and
// `playerSnapshot()`. Every number comes from game-data or the state itself.
//
// The property, as decision 9 states it:
//
//   Static. Let S₁ and S₂ be valid states with identical `knowledge`, identical
//   always-known state (decision 3) and an identical live view (decision 5), up
//   to renaming. They may differ anywhere else in world state. Then
//   `playerSnapshot(S₁)` and `playerSnapshot(S₂)` are equal in canonical JSON
//   after renaming.
//
// Renaming: each distinct simulation-created ID (`DYNAMIC_ID_PREFIXES`) is
// replaced with `<prefix>#k`, numbered by first appearance in canonical JSON,
// including ID tokens inside strings. `outcome` is not excluded: it's stored
// state, and no pair below differs in it.
//
// How pairs are built (each kept inside the premise):
// 1. Perturbed saves (the property): a reachable S₁, and S₂ = S₁ with world
//    values outside the live view perturbed (decision 9's generator families:
//    stock at facilities the founder isn't at, supplier and buyer state
//    elsewhere, contract offers elsewhere, route conditions off the founder's
//    view, production timing elsewhere, reputation while not present, the
//    market while not at a buyer or supplier), hidden plumbing perturbed (RNG
//    state, ID counters, sequence counters, the event journal, future scheduled
//    world events), and every dynamic ID renumbered by an order-preserving map,
//    which gives "up to renaming" its full force. Every state along each play
//    is an S₁: asleep, present (open or closed), travelling, riding, at a stop.
//    The same check confirms that building the snapshot changes no state
//    (decision 5) and is a function of the state.
// 2. Reachable pairs from the divergence-set construction (decision 9, dynamic
//    half): two games that differ by route closures that open and close during
//    the first night, while the founder sleeps. No channel delivers them, and
//    they leave nothing behind but different ID counters (extra transactions and
//    events with no entries), so every later pair of states is a static pair up
//    to renaming. A guard checks that the worlds really agree outside the hidden
//    plumbing.
// 3. Focused examples for the leaks the ADR and its review history name (PR
//    #187: B1 ID counters; B4 a buyer's budget through affordances; B2/R3-1
//    the books revealing an outcome that posted no cash (a prepaid batch
//    finishing elsewhere); B2/R2-2 a seizure showing through `inTransit` or the
//    deal list before it happens; since #222 a riding founder learns it on the
//    spot), plus controls showing the live view
//    is read from the world and that never-known subjects are null. Cash
//    postings are a declared channel (decision 6), so a posting that differs is
//    allowed to show; the examples stop before a differing one can post.
//
// Interpretations pinned here (reported to the orchestrator):
// - "Identical knowledge" means what the founder knows: records, activity,
//   the last catch-up, and the books as known. `pendingBooks` and `pendingNews`
//   list what the founder does *not* know yet (decision 7), so a hidden world
//   transaction or road event legitimately puts entries there. The production
//   example compares worlds that differ in them, as the dynamic
//   half's construction allows while no channel has delivered (D_t undelivered).
//   The perturbed-save property never changes `knowledge` at all.
// - The live view is taken conservatively: everything at the place the founder
//   observes (present at, or a delivery stop on its tick), the routes listed for
//   it in LIVE_VIEW_ROUTES, the route of the leg under way (on foot or on a
//   delivery), MARKET_PRICES at any buyer or supplier and STANDING anywhere. A
//   party's subjects, MARKET_PRICES and STANDING are treated as hidden at a
//   closed place (ADR 0023 decision 5 amendment) only when the place is closed
//   both at the snapshot's tick and at the next one, so the boundary minute
//   never decides a case.
// - A founder riding a delivery is not present anywhere except at a stop's tick
//   (ADR 0023 decisions 2, 2a). But road events on the founder's own delivery
//   (a seizure, a delay, a deal falling through) are known at once while they
//   ride (#222, the human's decision, amending ADR 0021 decision 7 and ADR 0023
//   decision 2a step 3); they aren't news at the delivery's origin. How the
//   snapshot shows it, as pinned here: on the outcome's tick the truck's
//   VEHICLE_WHEREABOUTS record is rewritten (`learnedAt` that tick, source
//   `IN_PERSON`; its `locationId` isn't pinned, since the founder is on the
//   road), so the deal list (`PlayerDeal`) and the installment's `inTransit`
//   follow at once; the CARGO_LOSS transaction is in the books, not pending; and
//   no pending news names the delivery. Before the outcome's tick, a trip that
//   will be seized and one that will be delayed must look the same. News at the
//   origin stays for deliveries without the founder aboard, which need a hired
//   Driver (E2, #182): no such delivery is reachable in M002 yet, so it isn't
//   constructed here (E2's test-writer pins it).
// - Per-trip randomness (ADR 0022 decision 8): a trip's outcome draws from a
//   stream keyed by the game seed, the truck and its trip ordinal, never from
//   the master `routes` stream. So the game seed is hidden plumbing too: the
//   perturbed saves change it, and the seizure example varies it, alone, to
//   find a delayed and a seized world.
// - A perturbed save stays valid: amounts and quantities stay non-negative, pool
//   costs are unchanged (so the ledger still matches the pools), and nothing the
//   founder agreed (contracts, deals, workforce, equipment, queued commands) or
//   the ledger is touched.

import {
  cents,
  DYNAMIC_ID_KINDS,
  DYNAMIC_ID_PREFIXES,
  minuteOfDay,
  RNG_STREAMS,
  TICKS_PER_DAY,
  tick,
  type BuyerId,
  type CommandResult,
  type ContractId,
  type GameState,
  type LocationId,
  type PlayerPlace,
  type PlayerSnapshot,
  type RouteId,
  type ScheduledWorldEvent,
} from "@eov/contracts";
import {
  BASIC_MOONSHINE_RECIPE,
  BUYERS,
  CORN,
  COUNTY_ROAD,
  CROSSROADS,
  CROSSROADS_BACK_ROAD,
  CROSSROADS_ROADHOUSE,
  DISTILLERY_MAIN,
  FACILITIES,
  FEED_STORE_ROAD,
  FIRST_SHIPMENT_SCENARIO,
  HOLLOW_CREEK,
  KESSLER_BACK_ROAD,
  KESSLER_PHARMACY,
  KESSLERS_BACK_ROOM,
  LAKE_SHORE_DRIVE,
  LAKEVIEW,
  LAKEVIEW_BACK_ROAD,
  LIVE_VIEW_ROUTES,
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
  STANDARD_MOONSHINE_RECIPE,
  SUGAR,
  SUPPLIERS,
  type ScenarioDefinition,
  type ScenarioScheduledEvent,
} from "@eov/game-data";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalJson, loadGame, newGame, seedRng, type KernelSimulation } from "../../src/index.ts";

// ---------------------------------------------------------------------------
// The canonicaliser (decision 9, "Renaming")
// ---------------------------------------------------------------------------

const PREFIXES: readonly string[] = Object.values(DYNAMIC_ID_PREFIXES);
/**
 * A simulation-created ID as a whole token: `<prefix>-<n>` (no leading zeros, as
 * `compareIds` defines them), not part of a longer ID. Matches inside strings
 * too (`"SALE:delivery-3"`).
 */
const DYNAMIC_ID_TOKEN = new RegExp(`(?<![a-z0-9-])(${PREFIXES.join("|")})-(0|[1-9][0-9]*)(?![a-z0-9-])`, "g");

/** Replaces each distinct dynamic ID with `<prefix>#k`, numbered per prefix by first appearance. */
function renameDynamicIds(json: string): string {
  const names = new Map<string, string>();
  const counts = new Map<string, number>();
  return json.replace(DYNAMIC_ID_TOKEN, (token: string, prefix: string) => {
    let name = names.get(token);
    if (name === undefined) {
      const k = (counts.get(prefix) ?? 0) + 1;
      counts.set(prefix, k);
      name = `${prefix}#${k}`;
      names.set(token, name);
    }
    return name;
  });
}

/** A shallow copy without the named keys. */
function without(value: object, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}

/** Canonical JSON after renaming. */
function canonical(value: unknown): string {
  return renameDynamicIds(canonicalJson(value));
}

/** Parsed back, so a failing comparison shows a structural diff. */
function canonicalTree(value: unknown): unknown {
  return JSON.parse(canonical(value)) as unknown;
}

function expectSamePlayerView(actual: PlayerSnapshot, expected: PlayerSnapshot, what: string): void {
  const a = canonical(actual);
  const b = canonical(expected);
  if (a !== b) {
    // Localise the first differing section before the full diff.
    for (const key of Object.keys(expected) as (keyof PlayerSnapshot)[]) {
      expect(canonicalTree(actual[key]), `${what}: player snapshot section \`${key}\` differs (a leak)`).toEqual(canonicalTree(expected[key]));
    }
    expect(JSON.parse(a), `${what}: player snapshots differ (a leak)`).toEqual(JSON.parse(b));
  }
}

// ---------------------------------------------------------------------------
// Scenario, places and driving the simulation
// ---------------------------------------------------------------------------

/** The First Shipment with the founder's rules on, at M002 pacing, and no scheduled events. */
const FOUNDER_SCENARIO: ScenarioDefinition = {
  ...FIRST_SHIPMENT_SCENARIO,
  scheduledEvents: [],
  founderRules: true,
  realMsPerGameHourAt1x: 20_000,
};

const routeById = (id: RouteId) => {
  const r = ROUTES.find((x) => x.id === id);
  if (!r) throw new Error(`no route ${id}`);
  return r;
};
const buyerLocation = (id: BuyerId): LocationId => BUYERS.find((b) => b.id === id)!.locationId;
const facilityLocation = (id: string): LocationId | null => FACILITIES.find((f) => f.id === id)?.locationId ?? null;
const supplierLocation = (id: string): LocationId | null => SUPPLIERS.find((s) => s.id === id)?.locationId ?? null;
const isPartyLocation = (l: LocationId): boolean => BUYERS.some((b) => b.locationId === l) || SUPPLIERS.some((s) => s.locationId === l);

function isOpen(locationId: LocationId, t: number): boolean {
  const entry = PLACE_HOURS.find((h) => h.locationId === locationId);
  if (!entry) return true;
  const m = minuteOfDay(tick(t));
  return entry.intervals.some(({ opensAtMinute: o, closesAtMinute: c }) => (o < c ? m >= o && m < c : m >= o || m < c));
}

const isFree = (s: GameState): boolean => s.founder.whereabouts.kind === "PRESENT" && s.founder.whereabouts.busy === null;
const presentAt = (s: GameState, l: LocationId): boolean => s.founder.whereabouts.kind === "PRESENT" && s.founder.whereabouts.locationId === l;

function advanceUntil(sim: KernelSimulation, done: (s: GameState) => boolean, maxTicks: number, what: string): void {
  for (let i = 0; i < maxTicks; i++) {
    if (done(sim.state)) return;
    sim.advance(1);
  }
  if (!done(sim.state)) throw new Error(`Construction: not reached within ${maxTicks} ticks: ${what} (tick ${sim.state.tick}, founder ${JSON.stringify(sim.state.founder)})`);
}

function expectApplied(result: CommandResult, what: string): void {
  if (result.status !== "applied") throw new Error(`Construction: ${what}: expected applied, got ${JSON.stringify(result)}`);
}

function walkTo(sim: KernelSimulation, destinationLocationId: LocationId): void {
  advanceUntil(sim, isFree, 2 * TICKS_PER_DAY, "the founder is free to leave");
  if (presentAt(sim.state, destinationLocationId)) return;
  expectApplied(sim.dispatch({ command: { type: "TRAVEL", destinationLocationId, transport: { kind: "FOOT" }, via: null } }), `walk to ${destinationLocationId}`);
  advanceUntil(sim, (s) => presentAt(s, destinationLocationId) && isFree(s), 3 * TICKS_PER_DAY, `the founder arrives at ${destinationLocationId}`);
}

function waitOpen(sim: KernelSimulation, locationId: LocationId): void {
  advanceUntil(sim, (s) => isFree(s) && isOpen(locationId, s.tick) && isOpen(locationId, s.tick + 1), 2 * TICKS_PER_DAY, `${locationId} opens`);
}

/** A copy of `sim` with its state replaced (a save of the same game, edited). */
function withState(sim: KernelSimulation, state: GameState): KernelSimulation {
  return loadGame({ ...sim.serialize(), state }, { scenario: FOUNDER_SCENARIO });
}

function clone(sim: KernelSimulation): KernelSimulation {
  return withState(sim, sim.state);
}

/** A fresh game under founder rules, awake and free at Hollow Creek. */
function awakeGame(): KernelSimulation {
  const sim = newGame({ scenario: FOUNDER_SCENARIO });
  advanceUntil(sim, isFree, START_WAKE_TICK + 2, "the founder wakes on the first morning");
  return sim;
}

const STOCKED_CASES = 4;
/** Cases' worth of materials left in stock after the stocked batch (it takes longer than walking to the feed store). */
const SPARE_CASES = 3;
let stockedSave: ReturnType<KernelSimulation["serialize"]> | null = null;

/** Moonshine in the distillery: buy at the feed store, walk home, run a batch to completion (as no-trap does). */
function stockedGame(): KernelSimulation {
  if (!stockedSave) {
    const sim = awakeGame();
    walkTo(sim, MILLERS_FEED_LOCATION);
    waitOpen(sim, MILLERS_FEED_LOCATION);
    for (const [materialId, quantity] of [
      // Materials for a later batch of SPARE_CASES too.
      [CORN, 2 * (STOCKED_CASES + SPARE_CASES)],
      [SUGAR, STOCKED_CASES + SPARE_CASES],
    ] as const) {
      expectApplied(sim.dispatch({ command: { type: "PURCHASE_MATERIALS", supplierId: MILLERS_FEED, materialId, quantity, facilityId: DISTILLERY_MAIN } }), `buy ${materialId}`);
      advanceUntil(sim, isFree, TICKS_PER_DAY, "buying ends");
    }
    walkTo(sim, HOLLOW_CREEK);
    expectApplied(
      sim.dispatch({ command: { type: "START_PRODUCTION", facilityId: DISTILLERY_MAIN, recipeId: BASIC_MOONSHINE_RECIPE, quantity: STOCKED_CASES } }),
      "start the batch",
    );
    advanceUntil(
      sim,
      (s) => isFree(s) && s.productionJobs.length === 0 && s.productPools.some((p) => p.facilityId === DISTILLERY_MAIN && p.productId === MOONSHINE && p.quantity >= STOCKED_CASES),
      4 * TICKS_PER_DAY,
      "the batch completes",
    );
    stockedSave = sim.serialize();
  }
  return loadGame(stockedSave, { scenario: FOUNDER_SCENARIO });
}

let contractedSave: ReturnType<KernelSimulation["serialize"]> | null = null;

/** Stocked, then a contract accepted at Kessler's: the founder is free at the pharmacy. */
function contractedGame(): KernelSimulation {
  if (!contractedSave) {
    const sim = stockedGame();
    walkTo(sim, KESSLER_PHARMACY);
    waitOpen(sim, KESSLER_PHARMACY);
    const offer = sim.state.contractOffers.filter((o) => o.buyerId === KESSLERS_BACK_ROOM).at(-1);
    if (!offer) throw new Error("Construction: no contract offer at Kessler's");
    expectApplied(sim.dispatch({ command: { type: "ACCEPT_CONTRACT", contractOfferId: offer.id } }), "accept Kessler's contract");
    advanceUntil(sim, isFree, TICKS_PER_DAY, "accepting ends");
    if (sim.state.contracts.length !== 1) throw new Error("Construction: no contract");
    contractedSave = sim.serialize();
  }
  return loadGame(contractedSave, { scenario: FOUNDER_SCENARIO });
}

/** Agree a deal at the buyer's quote (the founder must be free there, during hours). */
function agreeAtQuote(sim: KernelSimulation, buyerId: BuyerId, quantity: number): CommandResult {
  const quote = sim.state.buyers.find((b) => b.id === buyerId)?.wants.find((w) => w.productId === MOONSHINE)?.unitPrice;
  const agree = (price: number): CommandResult =>
    sim.dispatch({ command: { type: "AGREE_DEAL", buyerId, productId: MOONSHINE, quality: "basic", quantity, agreedUnitPrice: cents(price) } });
  let result = agree(quote ?? 1);
  if (result.status === "rejected" && result.reason.code === "QUOTE_CHANGED") result = agree(result.reason.current);
  return result;
}

// ---------------------------------------------------------------------------
// The live view, conservatively (decision 5, ADR 0023 decisions 2 and 5)
// ---------------------------------------------------------------------------

interface ViewScope {
  /** Where the founder observes: present at, or a delivery stop on its tick. */
  readonly observed: LocationId | null;
  /** Whether the party there (buyer or supplier) shows its subjects; true at a facility or a delivery stop. */
  readonly partyVisible: boolean;
  readonly liveRoutes: ReadonlySet<RouteId>;
}

function viewScope(s: GameState): ViewScope {
  const w = s.founder.whereabouts;
  const liveRoutes = new Set<RouteId>();
  let observed: LocationId | null = null;
  let partyVisible = true;
  if (w.kind === "PRESENT") {
    observed = w.locationId;
    partyVisible = isOpen(w.locationId, s.tick) || isOpen(w.locationId, s.tick + 1);
  } else if (w.kind === "ON_DELIVERY") {
    if (w.atStop !== null && w.atStop.tick === s.tick) observed = w.atStop.locationId;
    const delivery = s.deliveries.find((d) => d.id === w.deliveryId);
    if (delivery) liveRoutes.add(delivery.routeId);
    const vehicle = s.vehicles.find((v) => v.id === w.vehicleId);
    if (vehicle?.trip) liveRoutes.add(vehicle.trip.routeId);
  } else if (w.kind === "TRAVELLING") {
    const leg = w.path[w.legIndex];
    if (leg) liveRoutes.add(leg.routeId);
  }
  if (observed !== null) for (const id of LIVE_VIEW_ROUTES.find((e) => e.locationId === observed)?.routeIds ?? []) liveRoutes.add(id);
  return { observed, partyVisible, liveRoutes };
}

function hiddenPredicates(s: GameState) {
  const v = viewScope(s);
  const partyHidden = (location: LocationId | null): boolean => location !== v.observed || !v.partyVisible;
  return {
    scope: v,
    facility: (id: string): boolean => facilityLocation(id) !== v.observed,
    buyer: (id: BuyerId): boolean => partyHidden(buyerLocation(id)),
    supplier: (id: string): boolean => partyHidden(supplierLocation(id)),
    market: v.observed === null || !isPartyLocation(v.observed) || !v.partyVisible,
    standing: v.observed === null || (isPartyLocation(v.observed) && !v.partyVisible),
    route: (id: RouteId): boolean => !v.liveRoutes.has(id),
  };
}

// ---------------------------------------------------------------------------
// Perturbing hidden state, and renaming
// ---------------------------------------------------------------------------

interface IdMap {
  readonly mul: number;
  readonly add: number;
}

/**
 * Renumbers every dynamic ID in the state with `n ↦ mul·n + add` per prefix:
 * strictly increasing, so every `compareIds` order is kept, and the counters
 * move past every ID. The result equals the input up to renaming.
 */
function renumberIds(state: GameState, maps: Readonly<Record<string, IdMap>>): GameState {
  const json = JSON.stringify(state).replace(DYNAMIC_ID_TOKEN, (_token: string, prefix: string, digits: string) => {
    const m = maps[prefix] ?? { mul: 1, add: 0 };
    return `${prefix}-${m.mul * Number(digits) + m.add}`;
  });
  const renamed = JSON.parse(json) as GameState;
  const nextId = { ...renamed.counters.nextId };
  for (const kind of DYNAMIC_ID_KINDS) {
    const m = maps[DYNAMIC_ID_PREFIXES[kind]] ?? { mul: 1, add: 0 };
    nextId[kind] = m.mul * nextId[kind] + m.add + 1;
  }
  return { ...renamed, counters: { ...renamed.counters, nextId } };
}

interface HiddenPlan {
  readonly ids: Readonly<Record<string, IdMap>>;
  readonly rngSeeds: readonly number[];
  readonly journalKeep: number;
  readonly sequenceBump: number;
  readonly budget: number;
  readonly demand: number;
  readonly wantPriceDelta: number;
  readonly dropOffers: boolean;
  readonly offerPriceDelta: number;
  readonly supplierAvailable: number;
  readonly supplierPriceDelta: number;
  readonly marketDelta: { readonly demand: number; readonly supply: number; readonly spot: number };
  readonly flipRoutes: readonly boolean[];
  readonly jobDelay: number;
  readonly extraStock: number;
  readonly reputation: number;
  readonly futureClosure: { readonly offset: number; readonly routePick: number; readonly durationTicks: number } | null;
}

const idMapArb: fc.Arbitrary<IdMap> = fc.record({ mul: fc.integer({ min: 1, max: 3 }), add: fc.integer({ min: 0, max: 60 }) });

const hiddenPlanArb: fc.Arbitrary<HiddenPlan> = fc.record({
  ids: fc.record(Object.fromEntries(PREFIXES.map((p) => [p, idMapArb])) as Record<string, fc.Arbitrary<IdMap>>),
  rngSeeds: fc.array(fc.integer({ min: 1, max: 2_000_000_000 }), { minLength: RNG_STREAMS.length, maxLength: RNG_STREAMS.length }),
  journalKeep: fc.nat(),
  sequenceBump: fc.integer({ min: 0, max: 50 }),
  budget: fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 500_000 })),
  demand: fc.integer({ min: 0, max: 40 }),
  wantPriceDelta: fc.integer({ min: -500, max: 500 }),
  dropOffers: fc.boolean(),
  offerPriceDelta: fc.integer({ min: -500, max: 500 }),
  supplierAvailable: fc.integer({ min: 0, max: 200 }),
  supplierPriceDelta: fc.integer({ min: -200, max: 200 }),
  marketDelta: fc.record({ demand: fc.integer({ min: -50, max: 50 }), supply: fc.integer({ min: -50, max: 50 }), spot: fc.integer({ min: -300, max: 300 }) }),
  flipRoutes: fc.array(fc.boolean(), { minLength: ROUTES.length, maxLength: ROUTES.length }),
  jobDelay: fc.integer({ min: 0, max: 2 * TICKS_PER_DAY }),
  extraStock: fc.integer({ min: 0, max: 3 }),
  reputation: fc.integer({ min: 0, max: 100 }),
  futureClosure: fc.option(
    fc.record({ offset: fc.integer({ min: 2, max: 3 * TICKS_PER_DAY }), routePick: fc.nat(), durationTicks: fc.integer({ min: 1, max: TICKS_PER_DAY }) }),
    { nil: null },
  ),
});

/**
 * S₂ from S₁: world values outside the live view and hidden plumbing changed;
 * `knowledge`, the founder, the ledger, agreements and queued commands untouched.
 */
function perturbHidden(s: GameState, plan: HiddenPlan): GameState {
  const hidden = hiddenPredicates(s);
  const routesToOpen = new Set<RouteId>();
  const routes = s.routes.map((r, i) => {
    if (!hidden.route(r.id) || !plan.flipRoutes[i % plan.flipRoutes.length]) return r;
    if (r.closure === null) return { ...r, closure: { reason: "POLICE" as const, reopensAt: null } };
    routesToOpen.add(r.id);
    return { ...r, closure: null };
  });
  let scheduledEvents: ScheduledWorldEvent[] = s.scheduledEvents.filter((e) => !(e.kind === "ROUTE_REOPENING" && routesToOpen.has(e.routeId)));
  let nextScheduleSequence = s.counters.nextScheduleSequence + plan.sequenceBump;
  if (plan.futureClosure && s.routes.length > 0) {
    const routeId = s.routes[plan.futureClosure.routePick % s.routes.length]!.id;
    scheduledEvents.push({
      kind: "ROUTE_CLOSURE",
      tick: tick(s.tick + plan.futureClosure.offset),
      sequence: nextScheduleSequence,
      routeId,
      reason: "RIVAL",
      durationTicks: plan.futureClosure.durationTicks,
    });
    nextScheduleSequence += 1;
    scheduledEvents = scheduledEvents.sort((a, b) => a.tick - b.tick || a.sequence - b.sequence);
  }
  const journal = s.eventJournal.slice(s.eventJournal.length - (plan.journalKeep % (s.eventJournal.length + 1)));
  const rng = Object.fromEntries(RNG_STREAMS.map((stream, i) => [stream, seedRng(plan.rngSeeds[i] ?? 1, stream)])) as GameState["rng"];

  return {
    ...s,
    // The game seed: hidden plumbing that per-trip draws read (ADR 0022 decision 8).
    seed: s.seed + (plan.rngSeeds[0] ?? 1),
    rng,
    eventJournal: journal,
    scheduledEvents,
    counters: { ...s.counters, nextScheduleSequence, nextCommandSequence: s.counters.nextCommandSequence + plan.sequenceBump },
    family: hidden.standing ? { ...s.family, reputation: plan.reputation } : s.family,
    productPools: s.productPools.map((p) => (hidden.facility(p.facilityId) ? { ...p, quantity: p.quantity + plan.extraStock } : p)),
    materialPools: s.materialPools.map((p) => (hidden.facility(p.facilityId) ? { ...p, quantity: p.quantity + plan.extraStock } : p)),
    productionJobs: s.productionJobs.map((j) => (hidden.facility(j.facilityId) ? { ...j, completesAt: tick(j.completesAt + plan.jobDelay) } : j)),
    markets: hidden.market
      ? s.markets.map((m) => ({
          ...m,
          demand: Math.max(1, m.demand + plan.marketDelta.demand),
          supply: Math.max(1, m.supply + plan.marketDelta.supply),
          spotPrice: Math.max(1, m.spotPrice + plan.marketDelta.spot) as typeof m.spotPrice,
        }))
      : s.markets,
    suppliers: s.suppliers.map((sup) =>
      hidden.supplier(sup.id)
        ? {
            ...sup,
            stock: sup.stock.map((st) => ({ ...st, available: plan.supplierAvailable, unitPrice: Math.max(1, st.unitPrice + plan.supplierPriceDelta) as typeof st.unitPrice })),
          }
        : sup,
    ),
    buyers: s.buyers.map((b) =>
      hidden.buyer(b.id)
        ? {
            ...b,
            budgetRemaining: plan.budget as typeof b.budgetRemaining,
            wants: b.wants.map((w) => ({ ...w, demandRemaining: plan.demand, unitPrice: Math.max(1, w.unitPrice + plan.wantPriceDelta) as typeof w.unitPrice })),
          }
        : b,
    ),
    contractOffers: s.contractOffers
      .filter((o) => !(hidden.buyer(o.buyerId) && plan.dropOffers))
      .map((o) => (hidden.buyer(o.buyerId) ? { ...o, unitPrice: Math.max(1, o.unitPrice + plan.offerPriceDelta) as typeof o.unitPrice } : o)),
    routes,
  };
}

// ---------------------------------------------------------------------------
// Reachable states (as no-trap plays them)
// ---------------------------------------------------------------------------

const LOCATION_IDS = LOCATIONS.map((l) => l.id);
const BUYER_IDS = BUYERS.map((b) => b.id);
const ROUTE_IDS = ROUTES.map((r) => r.id);

type Action =
  | { readonly kind: "advance"; readonly ticks: number }
  | { readonly kind: "travel"; readonly destination: LocationId; readonly byTruck: boolean; readonly arrive: boolean }
  | { readonly kind: "buy"; readonly material: "corn" | "sugar"; readonly quantity: number }
  | { readonly kind: "batch"; readonly standard: boolean; readonly quantity: number }
  | { readonly kind: "agree"; readonly buyerId: BuyerId; readonly quantity: number }
  | { readonly kind: "accept"; readonly pick: number }
  | { readonly kind: "dispatch"; readonly pick: number; readonly routeId: RouteId | null; readonly contract: boolean; readonly ride: boolean }
  | { readonly kind: "rest"; readonly length: number }
  | { readonly kind: "workforce"; readonly workers: number }
  | { readonly kind: "settle" }
  | { readonly kind: "ride"; readonly buyerId: BuyerId; readonly routePick: number; readonly into: number; readonly toStop: boolean };

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  { weight: 3, arbitrary: fc.integer({ min: 0, max: 90 }).map((ticks) => ({ kind: "advance", ticks }) as const) },
  { weight: 2, arbitrary: fc.integer({ min: 0, max: TICKS_PER_DAY }).map((ticks) => ({ kind: "advance", ticks }) as const) },
  {
    weight: 4,
    arbitrary: fc
      .record({ destination: fc.constantFrom(...LOCATION_IDS), byTruck: fc.boolean(), arrive: fc.boolean() })
      .map((a) => ({ kind: "travel", ...a }) as const),
  },
  {
    weight: 1,
    arbitrary: fc
      .record({ material: fc.constantFrom("corn" as const, "sugar" as const), quantity: fc.integer({ min: 1, max: 8 }) })
      .map((a) => ({ kind: "buy", ...a }) as const),
  },
  { weight: 1, arbitrary: fc.record({ standard: fc.boolean(), quantity: fc.integer({ min: 1, max: 3 }) }).map((a) => ({ kind: "batch", ...a }) as const) },
  {
    weight: 2,
    arbitrary: fc.record({ buyerId: fc.constantFrom(...BUYER_IDS), quantity: fc.integer({ min: 1, max: 2 }) }).map((a) => ({ kind: "agree", ...a }) as const),
  },
  { weight: 1, arbitrary: fc.nat().map((pick) => ({ kind: "accept", pick }) as const) },
  {
    weight: 2,
    arbitrary: fc
      .record({ pick: fc.nat(), routeId: fc.option(fc.constantFrom(...ROUTE_IDS), { nil: null }), contract: fc.boolean(), ride: fc.boolean() })
      .map((a) => ({ kind: "dispatch", ...a }) as const),
  },
  { weight: 1, arbitrary: fc.integer({ min: MIN_REST_TICKS, max: MAX_REST_TICKS }).map((length) => ({ kind: "rest", length }) as const) },
  { weight: 1, arbitrary: fc.integer({ min: 0, max: 5 }).map((workers) => ({ kind: "workforce", workers }) as const) },
  { weight: 1, arbitrary: fc.constant({ kind: "settle" } as const) },
  // A sale the way the player makes one, ridden: agree at the buyer, walk home, drive it out, and stop on the road or at the hand-over.
  {
    weight: 2,
    arbitrary: fc
      .record({
        buyerId: fc.constantFrom(...BUYER_IDS),
        routePick: fc.nat(),
        into: fc.integer({ min: 0, max: 400 }),
        toStop: fc.boolean(),
      })
      .map((a) => ({ kind: "ride", ...a }) as const),
  },
);

/** Applies one action as the player would. Rejections are fine: the player tried. */
function act(sim: KernelSimulation, action: Action): void {
  const s = sim.state;
  switch (action.kind) {
    case "advance":
      sim.advance(action.ticks);
      return;
    case "settle":
      for (let i = 0; i < 2 * TICKS_PER_DAY && !isFree(sim.state); i++) sim.advance(1);
      return;
    case "travel": {
      const result = sim.dispatch({
        command: {
          type: "TRAVEL",
          destinationLocationId: action.destination,
          transport: action.byTruck ? { kind: "VEHICLE", vehicleId: MODEL_TT_TRUCK } : { kind: "FOOT" },
          via: null,
        },
      });
      if (result.status === "applied" && action.arrive) {
        for (let i = 0; i < 2 * TICKS_PER_DAY && !presentAt(sim.state, action.destination); i++) sim.advance(1);
      }
      return;
    }
    case "buy":
      sim.dispatch({
        command: { type: "PURCHASE_MATERIALS", supplierId: MILLERS_FEED, materialId: action.material === "corn" ? CORN : SUGAR, quantity: action.quantity, facilityId: DISTILLERY_MAIN },
      });
      return;
    case "batch":
      sim.dispatch({
        command: { type: "START_PRODUCTION", facilityId: DISTILLERY_MAIN, recipeId: action.standard ? STANDARD_MOONSHINE_RECIPE : BASIC_MOONSHINE_RECIPE, quantity: action.quantity },
      });
      return;
    case "agree":
      agreeAtQuote(sim, action.buyerId, action.quantity);
      return;
    case "accept": {
      const offer = s.contractOffers[action.pick % Math.max(1, s.contractOffers.length)];
      if (offer) sim.dispatch({ command: { type: "ACCEPT_CONTRACT", contractOfferId: offer.id } });
      return;
    }
    case "dispatch": {
      const contract = s.contracts.filter((c) => c.status === "ACTIVE")[action.pick % Math.max(1, s.contracts.length)];
      const deal = s.heldDeals.filter((d) => d.status === "HELD")[action.pick % Math.max(1, s.heldDeals.length)];
      if (action.contract && contract) {
        const routeId = action.routeId ?? (buyerLocation(contract.buyerId) === KESSLER_PHARMACY ? KESSLER_BACK_ROAD : LAKEVIEW_BACK_ROAD);
        sim.dispatch({
          command: {
            type: "DISPATCH_DELIVERY",
            vehicleId: MODEL_TT_TRUCK,
            cargo: [{ productId: contract.productId, quality: "basic", quantity: Math.min(STOCKED_CASES, contract.quantityPerInstallment) }],
            purpose: { kind: "CONTRACT_INSTALLMENT", contractId: contract.id },
            routeId,
            driver: { kind: "FOUNDER" },
          },
        });
      } else if (deal) {
        sim.dispatch({
          command: {
            type: "DISPATCH_DELIVERY",
            vehicleId: MODEL_TT_TRUCK,
            cargo: [{ productId: deal.productId, quality: deal.quality, quantity: deal.quantity }],
            purpose: { kind: "SALE", buyerId: deal.buyerId, dealId: deal.id },
            routeId: action.routeId,
            driver: { kind: "FOUNDER" },
          },
        });
      } else return;
      if (action.ride) for (let i = 0; i < TICKS_PER_DAY && sim.state.founder.whereabouts.kind !== "ON_DELIVERY"; i++) sim.advance(1);
      return;
    }
    case "rest":
      sim.dispatch({ command: { type: "REST", untilTick: tick(s.tick + 1 + action.length) } });
      return;
    case "workforce":
      sim.dispatch({ command: { type: "SET_WORKFORCE", facilityId: DISTILLERY_MAIN, workerCount: action.workers } });
      return;
    case "ride": {
      const at = buyerLocation(action.buyerId);
      // The default route, or any route between home and the buyer (risky ones included).
      const routes: (RouteId | null)[] = [
        null,
        ...ROUTES.filter((r) => [r.fromLocationId, r.toLocationId].includes(at) && [r.fromLocationId, r.toLocationId].includes(HOLLOW_CREEK)).map((r) => r.id),
      ];
      const travel = (to: LocationId): boolean => {
        for (let i = 0; i < TICKS_PER_DAY && !isFree(sim.state); i++) sim.advance(1);
        if (presentAt(sim.state, to)) return true;
        const r = sim.dispatch({ command: { type: "TRAVEL", destinationLocationId: to, transport: { kind: "FOOT" }, via: null } });
        if (r.status !== "applied") return false;
        for (let i = 0; i < 2 * TICKS_PER_DAY && !(presentAt(sim.state, to) && isFree(sim.state)); i++) sim.advance(1);
        return presentAt(sim.state, to);
      };
      if (!travel(at)) return;
      for (let i = 0; i < TICKS_PER_DAY && !(isOpen(at, sim.state.tick + 1) && isFree(sim.state)); i++) sim.advance(1);
      if (agreeAtQuote(sim, action.buyerId, 1).status !== "applied") return;
      const deal = sim.state.heldDeals.at(-1)!;
      if (!travel(HOLLOW_CREEK)) return;
      const r = sim.dispatch({
        command: {
          type: "DISPATCH_DELIVERY",
          vehicleId: MODEL_TT_TRUCK,
          cargo: [{ productId: deal.productId, quality: deal.quality, quantity: deal.quantity }],
          purpose: { kind: "SALE", buyerId: deal.buyerId, dealId: deal.id },
          routeId: routes[action.routePick % routes.length]!,
          driver: { kind: "FOUNDER" },
        },
      });
      if (r.status !== "applied") return;
      for (let i = 0; i < TICKS_PER_DAY && sim.state.founder.whereabouts.kind !== "ON_DELIVERY"; i++) sim.advance(1);
      if (action.toStop) {
        const atStopNow = (st: GameState): boolean => st.founder.whereabouts.kind !== "ON_DELIVERY" || st.founder.whereabouts.atStop?.tick === st.tick;
        for (let i = 0; i < TICKS_PER_DAY && !atStopNow(sim.state); i++) sim.advance(1);
      } else sim.advance(action.into);
      return;
    }
  }
}

type Start = "fresh" | "closures" | "awake" | "stocked" | "contracted";
const startArb: fc.Arbitrary<Start> = fc.constantFrom("fresh", "closures", "awake", "stocked", "contracted");

/** Closures the founder can run into on the first day, so S₁ has closed routes too. */
const DAY_ONE_CLOSURES: readonly ScenarioScheduledEvent[] = [
  { kind: "ROUTE_CLOSURE", tick: tick(400), routeId: LAKE_SHORE_DRIVE, reason: "POLICE", durationTicks: 2 * TICKS_PER_DAY },
  { kind: "ROUTE_CLOSURE", tick: tick(450), routeId: CROSSROADS_BACK_ROAD, reason: "RIVAL", durationTicks: TICKS_PER_DAY },
];

function start(kind: Start, scenario: ScenarioDefinition = FOUNDER_SCENARIO): KernelSimulation {
  switch (kind) {
    case "fresh":
      return newGame({ scenario });
    case "closures":
      return newGame({ scenario: { ...scenario, scheduledEvents: DAY_ONE_CLOSURES } });
    case "awake":
      return awakeGame();
    case "stocked":
      return stockedGame();
    case "contracted":
      return contractedGame();
  }
}

// ---------------------------------------------------------------------------
// The canonicaliser itself
// ---------------------------------------------------------------------------

describe("decision 9's renaming canonicaliser", () => {
  it("numbers each prefix by first appearance in canonical JSON (keys sorted), consistently", () => {
    expect(canonical({ b: ["txn-7", "txn-3"], a: "txn-3", c: "deal-12" })).toBe('{"a":"txn#1","b":["txn#2","txn#1"],"c":"deal#1"}');
  });

  it("renames ID tokens inside strings, and only whole simulation-created IDs", () => {
    expect(canonical({ k: "SALE:delivery-3", j: "DISPATCH:delivery-3:CLEAR" })).toBe('{"j":"DISPATCH:delivery#1:CLEAR","k":"SALE:delivery#1"}');
    // Static IDs, leading zeros and longer IDs aren't dynamic (compareIds' definition).
    expect(canonical(["distillery-main", "job-07", "offers-3", "x-job-3", "job-3-x", "job-0"])).toBe('["distillery-main","job-07","offers-3","x-job-3","job-3-x","job#1"]');
    for (const prefix of PREFIXES) expect(canonical(`${prefix}-41`)).toBe(`"${prefix}#1"`);
  });

  it("absorbs counter differences but still sees different structure", () => {
    expect(canonical({ x: ["deal-2", "deal-9"], y: "txn-40" })).toBe(canonical({ x: ["deal-31", "deal-77"], y: "txn-5" }));
    expect(canonical({ x: ["deal-2", "deal-9"] })).not.toBe(canonical({ x: ["deal-2", "deal-2"] }));
    expect(canonical({ x: ["deal-2"], q: 3 })).not.toBe(canonical({ x: ["deal-2"], q: 4 }));
    expect(canonical({ x: ["deal-2", "deal-9"] })).not.toBe(canonical({ x: ["deal-2", "deal-9", "deal-10"] }));
  });

  it("an order-preserving renumbering of a whole state compares equal, counters included", () => {
    const sim = stockedGame();
    const maps = Object.fromEntries(PREFIXES.map((p, i) => [p, { mul: 1 + (i % 3), add: 7 * i }]));
    const renamed = renumberIds(sim.state, maps);
    expect(canonical(renamed)).not.toBe(canonical(sim.state)); // the counters moved
    const rest = without(renamed, ["counters"]);
    const original = without(sim.state, ["counters"]);
    expect(canonical(rest)).toBe(canonical(original));
    expect(canonicalJson(rest)).not.toBe(canonicalJson(original));
  });
});

// ---------------------------------------------------------------------------
// The property over perturbed saves
// ---------------------------------------------------------------------------

const PROPERTY_SEED = 21_009;

describe("the static non-leak property (ADR 0021 decision 9)", () => {
  it("states that agree on everything the founder can know give equal player snapshots, after renaming", { timeout: 60_000 }, () => {
    let pairs = 0;
    fc.assert(
      fc.property(startArb, fc.array(actionArb, { maxLength: 12 }), hiddenPlanArb, (startKind, actions, plan) => {
        const sim = start(startKind);
        // Every state along the play is S₁ once.
        for (const action of [null, ...actions]) {
          if (action) act(sim, action);
          const hashBefore = sim.stateHash();
          const s1 = sim.playerSnapshot();
          // Building the snapshot changes no state, and building it again gives the same snapshot (decision 5).
          expect(sim.stateHash(), "playerSnapshot() changed the state").toBe(hashBefore);
          expect(canonicalJson(sim.playerSnapshot()), "playerSnapshot() isn't a function of the state").toBe(canonicalJson(s1));

          const twin = withState(sim, renumberIds(perturbHidden(sim.state, plan), plan.ids));
          expectSamePlayerView(twin.playerSnapshot(), s1, `tick ${sim.state.tick}, founder ${JSON.stringify(sim.state.founder.whereabouts)}, after ${JSON.stringify(action)}`);
          pairs++;
        }
      }),
      { seed: PROPERTY_SEED, numRuns: 250, endOnFailure: true },
    );
    expect(pairs).toBeGreaterThan(250);
  });
});

// ---------------------------------------------------------------------------
// Reachable pairs: hidden route closures while the founder sleeps
// ---------------------------------------------------------------------------

/** Routes with state in the First Shipment (both ends occupied), so a scenario may close them. */
const CLOSABLE_ROUTES = [STATE_HIGHWAY, COUNTY_ROAD, LAKE_SHORE_DRIVE, CROSSROADS_BACK_ROAD, KESSLER_BACK_ROAD, LAKEVIEW_BACK_ROAD, FEED_STORE_ROAD];

/** A closure that opens and closes entirely while the founder sleeps on the first night (tick 0 to START_WAKE_TICK). */
const nightClosureArb: fc.Arbitrary<ScenarioScheduledEvent> = fc
  .record({
    at: fc.integer({ min: 1, max: START_WAKE_TICK - 3 }),
    routeId: fc.constantFrom(...CLOSABLE_ROUTES),
    reason: fc.constantFrom("RIVAL" as const, "POLICE" as const),
    length: fc.nat(),
  })
  .map(({ at, routeId, reason, length }) => ({
    kind: "ROUTE_CLOSURE" as const,
    tick: tick(at),
    routeId,
    reason,
    durationTicks: 1 + (length % (START_WAKE_TICK - 2 - at)),
  }));

/**
 * The world without its hidden plumbing: the event journal, counters, RNG
 * streams, the scheduling sequence, ledger rows with no entries (decision 6
 * rule 4) and `knowledge` (the implementation's, checked through the snapshot).
 */
function worldWithoutPlumbing(s: GameState): unknown {
  return {
    ...without(s, ["eventJournal", "counters", "rng", "knowledge", "scheduledEvents", "ledger"]),
    scheduledEvents: s.scheduledEvents.map((e) => without(e, ["sequence"])),
    ledger: s.ledger.transactions.filter((t) => t.entries.length > 0),
  };
}

function expectSameWorld(a: KernelSimulation, b: KernelSimulation, what: string): void {
  expect(b.state.tick, `construction: ${what}`).toBe(a.state.tick);
  expect(
    canonicalTree(worldWithoutPlumbing(b.state)),
    `construction: the worlds differ beyond hidden plumbing (${what}); either the pair is broken, or hidden state reached the founder's view and changed what they could do`,
  ).toEqual(
    canonicalTree(worldWithoutPlumbing(a.state)),
  );
}

describe("reachable pairs: closures the sleeping founder never saw (decision 9's divergence set)", () => {
  it("only the ID counters differ, and the player snapshots stay equal after renaming", { timeout: 60_000 }, () => {
    fc.assert(
      fc.property(fc.array(nightClosureArb, { minLength: 1, maxLength: 3 }), fc.array(actionArb, { maxLength: 10 }), (closures, actions) => {
        const a = newGame({ scenario: FOUNDER_SCENARIO });
        const b = newGame({ scenario: { ...FOUNDER_SCENARIO, scheduledEvents: closures } });
        const both = (f: (sim: KernelSimulation) => void): void => {
          f(a);
          f(b);
        };
        both((sim) => advanceUntil(sim, isFree, START_WAKE_TICK + 2, "the founder wakes"));
        expect(b.state.counters.nextId.Transaction, "construction: the closures posted transactions").toBeGreaterThan(a.state.counters.nextId.Transaction);
        expectSameWorld(a, b, "on waking");
        expectSamePlayerView(b.playerSnapshot(), a.playerSnapshot(), "on waking");
        actions.forEach((action, i) => {
          both((sim) => act(sim, action));
          expectSameWorld(a, b, `after action ${i}: ${JSON.stringify(action)}`);
          expectSamePlayerView(b.playerSnapshot(), a.playerSnapshot(), `after action ${i}: ${JSON.stringify(action)}`);
        });
      }),
      { seed: PROPERTY_SEED + 1, numRuns: 80, endOnFailure: true },
    );
  });
});

// ---------------------------------------------------------------------------
// Focused examples
// ---------------------------------------------------------------------------

const placeOf = (snapshot: PlayerSnapshot, id: LocationId): PlayerPlace => {
  const place = snapshot.places.find((p) => p.id === id);
  if (!place) throw new Error(`no place ${id} in the player snapshot`);
  return place;
};
const buyerPlace = (snapshot: PlayerSnapshot, id: LocationId) => {
  const place = placeOf(snapshot, id);
  if (place.kind !== "BUYER") throw new Error(`${id} isn't a buyer`);
  return place.buyer;
};

describe("non-leak: focused examples", () => {
  it("ID counters (review B1): hidden transactions shift every later ID, and renaming absorbs it", () => {
    const a = newGame({ scenario: FOUNDER_SCENARIO });
    const b = newGame({
      scenario: {
        ...FOUNDER_SCENARIO,
        scheduledEvents: [
          { kind: "ROUTE_CLOSURE", tick: tick(30), routeId: KESSLER_BACK_ROAD, reason: "POLICE", durationTicks: 60 },
          { kind: "ROUTE_CLOSURE", tick: tick(100), routeId: LAKE_SHORE_DRIVE, reason: "RIVAL", durationTicks: 120 },
        ],
      },
    });
    const step = (what: string, f: (sim: KernelSimulation) => void): void => {
      f(a);
      f(b);
      expectSameWorld(a, b, what);
      expectSamePlayerView(b.playerSnapshot(), a.playerSnapshot(), what);
    };
    step("waking", (sim) => advanceUntil(sim, isFree, START_WAKE_TICK + 2, "the founder wakes"));
    expect(b.state.counters.nextId.Transaction).toBeGreaterThan(a.state.counters.nextId.Transaction);
    expect(b.state.counters.nextId.Event).toBeGreaterThan(a.state.counters.nextId.Event);
    step("at the feed store", (sim) => {
      walkTo(sim, MILLERS_FEED_LOCATION);
      waitOpen(sim, MILLERS_FEED_LOCATION);
    });
    step("buying corn", (sim) => {
      expectApplied(sim.dispatch({ command: { type: "PURCHASE_MATERIALS", supplierId: MILLERS_FEED, materialId: CORN, quantity: 4, facilityId: DISTILLERY_MAIN } }), "buy corn");
      advanceUntil(sim, isFree, TICKS_PER_DAY, "buying ends");
    });
    step("buying sugar", (sim) => {
      expectApplied(sim.dispatch({ command: { type: "PURCHASE_MATERIALS", supplierId: MILLERS_FEED, materialId: SUGAR, quantity: 2, facilityId: DISTILLERY_MAIN } }), "buy sugar");
      advanceUntil(sim, isFree, TICKS_PER_DAY, "buying ends");
    });
    step("home", (sim) => walkTo(sim, HOLLOW_CREEK));
    step("a batch", (sim) => {
      expectApplied(sim.dispatch({ command: { type: "START_PRODUCTION", facilityId: DISTILLERY_MAIN, recipeId: BASIC_MOONSHINE_RECIPE, quantity: 2 } }), "start a batch");
      advanceUntil(sim, isFree, TICKS_PER_DAY, "starting ends");
    });
    step("at the Crossroads", (sim) => {
      walkTo(sim, CROSSROADS);
      waitOpen(sim, CROSSROADS);
    });
    step("a deal", (sim) => {
      expectApplied(agreeAtQuote(sim, CROSSROADS_ROADHOUSE, 1), "agree a deal");
      advanceUntil(sim, isFree, TICKS_PER_DAY, "agreeing ends");
    });
    step("through midnight", (sim) => sim.advance(TICKS_PER_DAY));
  });

  it("a buyer's budget through affordances (review B4): budgets and demand elsewhere don't show, even through maxAcceptableQuantity", () => {
    const sim = awakeGame();
    walkTo(sim, CROSSROADS);
    waitOpen(sim, CROSSROADS);
    sim.advance(1); // a tick-end persist at the open Crossroads
    walkTo(sim, HOLLOW_CREEK);
    const s1 = sim.playerSnapshot();
    expect(buyerPlace(s1, CROSSROADS).budget, "the Crossroads' budget was learned there").not.toBeNull();
    const variants: readonly [string, (b: GameState["buyers"][number]) => GameState["buyers"][number]][] = [
      ["no budget left", (b) => ({ ...b, budgetRemaining: 0 as typeof b.budgetRemaining })],
      ["a tiny budget", (b) => ({ ...b, budgetRemaining: 1 as typeof b.budgetRemaining })],
      ["a huge budget", (b) => ({ ...b, budgetRemaining: (b.budgetRemaining * 50 + 1) as typeof b.budgetRemaining })],
      ["no demand", (b) => ({ ...b, wants: b.wants.map((w) => ({ ...w, demandRemaining: 0 })) })],
    ];
    for (const [what, change] of variants) {
      const twin = withState(sim, { ...sim.state, buyers: sim.state.buyers.map(change) });
      const s2 = twin.playerSnapshot();
      for (const id of [CROSSROADS, KESSLER_PHARMACY, LAKEVIEW]) {
        expect(canonicalTree(buyerPlace(s2, id)), `${what}: buyer at ${id}`).toEqual(canonicalTree(buyerPlace(s1, id)));
      }
      expectSamePlayerView(s2, s1, what);
    }
  });

  it("batch progress (review R3-1): a prepaid batch finishing out of sight leaves the player snapshot as it was", () => {
    const sim = stockedGame();
    expectApplied(sim.dispatch({ command: { type: "START_PRODUCTION", facilityId: DISTILLERY_MAIN, recipeId: BASIC_MOONSHINE_RECIPE, quantity: SPARE_CASES } }), "start a batch");
    advanceUntil(sim, isFree, TICKS_PER_DAY, "starting ends");
    walkTo(sim, MILLERS_FEED_LOCATION);
    const job = sim.state.productionJobs[0];
    if (!job || job.completesAt <= sim.state.tick + 1) throw new Error("Construction: the batch must still be running when the founder is away");
    expect(job.conversionPrepaid, "construction: a prepaid job (ADR 0022 decision 7)").not.toBeNull();
    // S₂: the same batch runs two days longer (FACILITY_OPERATIONS, a subject in P).
    const a = clone(sim);
    const b = withState(sim, { ...sim.state, productionJobs: sim.state.productionJobs.map((j) => ({ ...j, completesAt: tick(j.completesAt + 2 * TICKS_PER_DAY) })) });
    const ledgerSize = a.state.ledger.transactions.length;
    while (a.state.tick < job.completesAt + 120) {
      a.advance(1);
      b.advance(1);
      expect(presentAt(a.state, MILLERS_FEED_LOCATION), "construction: the founder stays at the feed store").toBe(true);
      expectSamePlayerView(b.playerSnapshot(), a.playerSnapshot(), `tick ${a.state.tick}`);
    }
    expect(a.state.productionJobs, "construction: the batch finished in S₁").toEqual([]);
    expect(b.state.productionJobs, "construction: the batch still runs in S₂").toHaveLength(1);
    const posting = a.state.ledger.transactions.slice(ledgerSize).find((t) => t.kind === "PRODUCTION");
    expect(posting, "construction: the completion was posted").toBeDefined();
    expect(posting!.entries.some((e) => e.account === "CASH"), "construction: a non-cash posting (decision 6 rule 3)").toBe(false);
  });

  /**
   * A risky trip with the founder riding, resolved two ways by a hidden input
   * of the trip's own draw stream (the game seed, ADR 0022 decision 8): delayed
   * in one world, seized in the other. Until the outcome's tick the worlds
   * differ only in hidden plumbing, so the snapshots match. On that tick the
   * founder is aboard and learns the outcome at once (#222): the seizure shows
   * through known VEHICLE_WHEREABOUTS, so through `inTransit` (review R2-2) for
   * an installment and the deal list (`PlayerDeal`) for a sale, and the loss is
   * in the books; the delay shows too. Neither is news at the origin.
   */
  function rideOut(purpose: "installment" | "deal"): KernelSimulation {
    let sim: KernelSimulation;
    let routeId: RouteId;
    if (purpose === "installment") {
      sim = contractedGame();
      walkTo(sim, HOLLOW_CREEK);
      const contract = sim.state.contracts[0]!;
      routeId = KESSLER_BACK_ROAD;
      expectApplied(
        sim.dispatch({
          command: {
            type: "DISPATCH_DELIVERY",
            vehicleId: MODEL_TT_TRUCK,
            cargo: [{ productId: MOONSHINE, quality: "basic", quantity: STOCKED_CASES }],
            purpose: { kind: "CONTRACT_INSTALLMENT", contractId: contract.id as ContractId },
            routeId,
            driver: { kind: "FOUNDER" },
          },
        }),
        "dispatch the installment, riding",
      );
    } else {
      sim = stockedGame();
      walkTo(sim, CROSSROADS);
      waitOpen(sim, CROSSROADS);
      expectApplied(agreeAtQuote(sim, CROSSROADS_ROADHOUSE, 2), "agree a deal");
      walkTo(sim, HOLLOW_CREEK);
      const deal = sim.state.heldDeals.at(-1)!;
      routeId = CROSSROADS_BACK_ROAD;
      expectApplied(
        sim.dispatch({
          command: {
            type: "DISPATCH_DELIVERY",
            vehicleId: MODEL_TT_TRUCK,
            cargo: [{ productId: deal.productId, quality: deal.quality, quantity: deal.quantity }],
            purpose: { kind: "SALE", buyerId: deal.buyerId, dealId: deal.id },
            routeId,
            driver: { kind: "FOUNDER" },
          },
        }),
        "dispatch the deal, riding",
      );
    }
    expect(routeById(routeId).riskPpm, "construction: a risky route").toBeGreaterThan(0);
    advanceUntil(sim, (s) => s.founder.whereabouts.kind === "ON_DELIVERY", TICKS_PER_DAY, "the truck sets out");
    return sim;
  }

  /** The ride with only the game seed changed: hidden plumbing, read by the trip's draws. */
  function reseeded(sim: KernelSimulation, seed: number): KernelSimulation {
    return withState(sim, { ...sim.state, seed });
  }

  /** Searches game seeds, in a fixed order, for one that delays the trip and one that seizes the cargo. */
  function delayedAndSeized(sim: KernelSimulation): { readonly delayed: KernelSimulation; readonly seized: KernelSimulation; readonly resolvedAt: number } {
    const trip = sim.state.vehicles.find((v) => v.id === MODEL_TT_TRUCK)!.trip!;
    let delayed: KernelSimulation | null = null;
    let seized: KernelSimulation | null = null;
    for (let seed = 1; seed <= 2_000 && (!delayed || !seized); seed++) {
      const candidate = reseeded(sim, seed);
      candidate.advance(trip.arrivesAt - candidate.state.tick);
      const t = candidate.state.vehicles.find((v) => v.id === MODEL_TT_TRUCK)!.trip;
      const outcome = t?.leg === "OUTBOUND" && t.delayed ? "delayed" : t?.leg === "RETURN" && candidate.state.deliveries.some((d) => d.status === "FAILED") ? "seized" : "other";
      if (outcome === "delayed" && !delayed) delayed = reseeded(sim, seed);
      if (outcome === "seized" && !seized) seized = reseeded(sim, seed);
    }
    if (!delayed || !seized) throw new Error("Construction: no game seed gives both a delay and a seizure (are trip draws keyed by the seed?)");
    return { delayed, seized, resolvedAt: trip.arrivesAt };
  }

  /** Pending news items, at any place, that name `deliveryId`. */
  function newsAbout(s: GameState, deliveryId: string): readonly unknown[] {
    return s.knowledge.pendingNews.flatMap((p) => p.items).filter((item) => "deliveryId" in item.event && item.event.deliveryId === deliveryId);
  }

  function knownTruck(snapshot: PlayerSnapshot) {
    const truck = snapshot.vehicles.find((v) => v.id === MODEL_TT_TRUCK);
    if (!truck) throw new Error("No truck in the player snapshot");
    return truck.whereabouts;
  }

  const inTransitTotal = (snapshot: PlayerSnapshot): number =>
    snapshot.contracts.reduce((n, c) => n + (c.progress?.value.installments.reduce((m, i) => m + i.inTransit, 0) ?? 0), 0);

  for (const purpose of ["installment", "deal"] as const) {
    it(`a seizure while riding is known at once, and not before it happens (${purpose}; reviews B2, R2-2; #222)`, () => {
      const { delayed, seized, resolvedAt } = delayedAndSeized(rideOut(purpose));
      const deliveryId = seized.state.vehicles.find((v) => v.id === MODEL_TT_TRUCK)!.trip!.deliveryId;
      if (purpose === "installment") expect(inTransitTotal(seized.playerSnapshot()), "construction: the cases count as on their way at departure").toBeGreaterThan(0);
      else expect(seized.playerSnapshot().deals.filter((x) => x.deliveryId === deliveryId).map((x) => x.status), "construction: the deal is out").toEqual(["DISPATCHED"]);

      // Up to the outcome: the worlds differ only in the seed, and nothing has happened yet.
      while (delayed.state.tick < resolvedAt) {
        expect(canonicalTree(seized.state.founder), "construction: the founder rides in both worlds").toEqual(canonicalTree(delayed.state.founder));
        const d = delayed.playerSnapshot();
        const s = seized.playerSnapshot();
        if (purpose === "installment") {
          expect(canonicalTree(s.contracts), `tick ${delayed.state.tick}: contracts (inTransit)`).toEqual(canonicalTree(d.contracts));
        } else {
          expect(canonicalTree(s.deals), `tick ${delayed.state.tick}: deals`).toEqual(canonicalTree(d.deals));
        }
        expectSamePlayerView(s, d, `tick ${delayed.state.tick}, before the outcome`);
        delayed.advance(1);
        seized.advance(1);
      }

      // The outcome's tick: seized in one world, delayed in the other, the founder aboard in both.
      const seizedTrip = seized.state.vehicles.find((v) => v.id === MODEL_TT_TRUCK)!.trip!;
      const delayedTrip = delayed.state.vehicles.find((v) => v.id === MODEL_TT_TRUCK)!.trip!;
      expect(seizedTrip.leg, "construction: seized, heading home").toBe("RETURN");
      expect(delayedTrip.delayed, "construction: delayed, still outbound").toBe(true);
      expect(seized.state.founder.whereabouts, "construction: riding home with the truck").toMatchObject({ kind: "ON_DELIVERY", deliveryId });
      expect(delayed.state.founder.whereabouts, "construction: riding on with the truck").toMatchObject({ kind: "ON_DELIVERY", deliveryId });
      const s = seized.playerSnapshot();
      const d = delayed.playerSnapshot();

      // Seized: known at once, in person (#222).
      expect(knownTruck(s), "the seizure is known at once: the truck's whereabouts, learned in person on the spot").toMatchObject({
        learnedAt: resolvedAt,
        source: { kind: "IN_PERSON" },
        value: { kind: "VEHICLE_WHEREABOUTS", vehicleId: MODEL_TT_TRUCK, parkedAt: null, trip: { deliveryId, leg: "RETURN", arrivesAt: seizedTrip.arrivesAt } },
      });
      const loss = seized.state.ledger.transactions.find((t) => t.kind === "CARGO_LOSS" && t.tick === resolvedAt);
      if (!loss) throw new Error("Construction: the seized cargo was written off");
      expect(seized.state.knowledge.pendingBooks.map((b) => b.transactionId), "the loss isn't pending: the founder saw it").not.toContain(loss.id);
      expect(s.finance.books.some((r) => r.kind === "CARGO_LOSS" && r.tick === resolvedAt), "the loss is in the books at once").toBe(true);
      expect(newsAbout(seized.state, deliveryId), "a road event on the founder's own run isn't news at the origin").toEqual([]);
      if (purpose === "installment") {
        expect(inTransitTotal(s), "the seized cases no longer count as on their way").toBe(0);
      } else {
        expect(s.deals.filter((x) => x.deliveryId === deliveryId), "the seized deal has left the deal list").toEqual([]);
      }

      // Delayed: known at once too.
      expect(knownTruck(d), "the delay is known at once").toMatchObject({
        learnedAt: resolvedAt,
        source: { kind: "IN_PERSON" },
        value: { kind: "VEHICLE_WHEREABOUTS", vehicleId: MODEL_TT_TRUCK, parkedAt: null, trip: { deliveryId, leg: "OUTBOUND", delayed: true, arrivesAt: delayedTrip.arrivesAt } },
      });
      expect(newsAbout(delayed.state, deliveryId), "the delay isn't news at the origin").toEqual([]);
      if (purpose === "deal") {
        expect(d.deals.filter((x) => x.deliveryId === deliveryId).map((x) => x.status), "the delayed deal is still out").toEqual(["DISPATCHED"]);
      }
      expect(canonical(s), "the founder saw different things happen").not.toBe(canonical(d));

      // Riding home after the seizure: no news of it waits anywhere, and the founder comes home with the truck.
      while (seized.state.vehicles.find((v) => v.id === MODEL_TT_TRUCK)!.trip !== null) {
        if (seized.state.tick >= seizedTrip.arrivesAt) throw new Error("Construction: the truck didn't get home on time");
        seized.advance(1);
        expect(newsAbout(seized.state, deliveryId), `tick ${seized.state.tick}: no news of the seizure waits anywhere`).toEqual([]);
      }
      expect(presentAt(seized.state, HOLLOW_CREEK), "construction: home with the truck").toBe(true);
    });
  }

  it("control: the live view is read from the world when the snapshot is built (decision 5)", () => {
    const sim = awakeGame();
    walkTo(sim, CROSSROADS);
    waitOpen(sim, CROSSROADS);
    const s1 = sim.playerSnapshot();
    expect(s1.here).toBe(CROSSROADS);
    const twin = withState(sim, {
      ...sim.state,
      buyers: sim.state.buyers.map((b) => (b.id === CROSSROADS_ROADHOUSE ? { ...b, budgetRemaining: (b.budgetRemaining + 1_234) as typeof b.budgetRemaining } : b)),
    });
    const budget = buyerPlace(twin.playerSnapshot(), CROSSROADS).budget;
    expect(budget).toEqual({
      value: { kind: "BUYER_BUDGET", buyerId: CROSSROADS_ROADHOUSE, budgetRemaining: twin.state.buyers.find((b) => b.id === CROSSROADS_ROADHOUSE)!.budgetRemaining },
      learnedAt: twin.state.tick,
      source: { kind: "IN_PERSON", locationId: CROSSROADS },
    });
    expect(canonical(twin.playerSnapshot())).not.toBe(canonical(s1));
  });

  it("control: never-known subjects are null, and a fresh founder knows only the live view (decision 4)", () => {
    const sim = awakeGame();
    const s = sim.playerSnapshot();
    expect(s.here).toBe(HOLLOW_CREEK);
    expect(s.market).toBeNull();
    for (const id of [CROSSROADS, KESSLER_PHARMACY, LAKEVIEW]) {
      const buyer = buyerPlace(s, id);
      expect(buyer.wants).toBeNull();
      expect(buyer.budget).toBeNull();
      expect(buyer.offers).toBeNull();
    }
    const supplier = placeOf(s, MILLERS_FEED_LOCATION);
    expect(supplier.kind === "SUPPLIER" ? supplier.supplier.offer : "not a supplier").toBeNull();
    const home = placeOf(s, HOLLOW_CREEK);
    if (home.kind !== "FACILITY") throw new Error("Hollow Creek isn't a facility");
    expect(home.facility.stock).toMatchObject({ learnedAt: sim.state.tick, source: { kind: "IN_PERSON", locationId: HOLLOW_CREEK } });
  });
});
