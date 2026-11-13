// @locked
// ADR 0022 decision 9 (and decision 2's "Implementation shape") acceptance
// tests for SK1c-1 (issue #200): every validator takes an `IssuerView`, never
// `GameState`, and for every `RejectionCode` the immediate result of a founder
// command reads only the founder's view. With `founderRules` on, states are
// reachable ones: the First Shipment with the flag, as
// `founder/no-trap.locked.test.ts` and `knowledge/non-leak.locked.test.ts`
// build them.
//
// Written ahead of the implementation by a separate test-writer agent
// (factory.md §2, §7.3). Do not edit (CLAUDE.md rule 9). Until SK1c-1 lands this
// file doesn't compile: `src/view/index.ts` doesn't exist yet.
//
// Imports are limited to the public package entry `src/index.ts`,
// `@eov/contracts`, `@eov/game-data`, and the one internal module this file
// specifies, `src/view/index.ts`. Everything else runs through the Simulation:
// commands, ticks, `serialize` / `loadGame`, `playerSnapshot()` and the state it
// exposes read-only. Every number comes from game-data or the state itself.
//
// ---------------------------------------------------------------------------
// The API SK1c-1 must export from `packages/simulation/src/view/index.ts`
// ---------------------------------------------------------------------------
//
//   /** What a validator may read (ADR 0022 decision 2). Implementation-defined,
//    *  read-only members; none of them is, or returns, a GameState. */
//   export interface IssuerView {
//     readonly issuer: CommandIssuer;            // from @eov/contracts
//     // ...whatever the validators need, built only from the view's inputs
//   }
//
//   /** The founder's view: knowledge, the always-known state and the live
//    *  view (ADR 0021 decisions 3–5). With `founderRules: false` the live view
//    *  is the whole world (decision 2's lab mode). */
//   export interface PlayerView extends IssuerView {
//     readonly issuer: { readonly kind: "FOUNDER" };
//   }
//
//   /** Builds the founder's view of `state` for a command applied at `at`
//    *  (`state.tick + 1` for an eager command). Pure: reads only its arguments
//    *  and changes nothing. */
//   export function playerViewOf(state: GameState, data: GameData, rules: GameRules, at: Tick): PlayerView;
//
//   /** A command's whole immediate check: decision 1's five gates in order,
//    *  presence (ADR 0023's busy and hours rules included) and identity
//    *  resolution through the view. null: the order is accepted. */
//   export type OrderValidator<T extends GameCommandType> =
//     (view: IssuerView, command: CommandOfType<T>) => RejectionReason | null;
//
//   export type OrderValidators = { readonly [T in GameCommandType]: OrderValidator<T> };
//
//   /** One validator per command type, for these game-data and rules. */
//   export function orderValidators(data: GameData, rules: GameRules): OrderValidators;
//
// `GameRules` is `kernel/rules.ts`'s `{ founderRules: boolean }`; this file
// passes object literals of that shape. `EmployeeView` is ADR 0025's task, so
// it isn't required here.
//
// ---------------------------------------------------------------------------
// What is asserted
// ---------------------------------------------------------------------------
//
// 1. Compile time (`pnpm typecheck` runs tsc over this file): every command
//    type has a validator; each validator's parameters are exactly
//    `[IssuerView, CommandOfType<T>]` and it returns `RejectionReason | null`;
//    `GameState` isn't assignable to `IssuerView` (so a validator can't be
//    handed the world); and no public member of `IssuerView` or `PlayerView`
//    is, or returns, something a `GameState` fits into.
// 2. Run time, the registry: `orderValidators` has exactly one function per
//    `GAME_COMMAND_TYPES` entry, with the flag on and off, and building a view
//    and validating change no state.
// 3. Run time, the tie between the validator and the kernel (decision 2:
//    "Either the order is rejected from the view, or it's applied"): for every
//    command this file dispatches eagerly with no queued commands, the
//    Simulation's immediate result is exactly
//    `orderValidators(...)[type](playerViewOf(state, data, rules, state.tick + 1), command)`:
//    applied when it returns null, otherwise rejected with that reason. So the
//    validator is the path the kernel takes, not a parallel copy.
// 4. Run time, per `RejectionCode` (decision 9): for each code and each
//    command that can produce it (the CASES table, checked exhaustive over
//    `RejectionCode` by COVERAGE), a reachable founder-rules state S₁ that
//    produces it, and twins S₂ that agree with S₁ on the founder's view
//    (knowledge, always-known state, live view) up to renaming but differ in
//    hidden world state. The same command (renamed) gets the same verdict and
//    the same rejection payload, compared in canonical JSON after decision 9's
//    renaming. Codes that come only from shape or always-known checks get a
//    focused example (still run against the twins). Plus a full battery of
//    probe commands at every station, and a seeded property over random plays
//    (as non-leak builds them) with random probes at every state.
// 5. Focused examples the issue names: the presence table (NOT_PRESENT,
//    FOUNDER_BUSY, FOUNDER_AWAY, PLACE_CLOSED, VEHICLE_NOT_AT, NO_DRIVER, and an
//    instant command allowed while busy); AGREE_DEAL against the live view
//    (with a control showing it reads the world there); installment checks on
//    known CONTRACT_PROGRESS (world progress differs, verdicts don't);
//    ROUTE_CLOSED from the live view and from a known-closed record (reopensAt
//    from the record), an unknown closure not rejected, and ROUTE_FOUND_CLOSED
//    when the road closes while the truck is loaded.
// 6. Flag off: the validators exist and the tie (3) holds with the whole world
//    as the live view; there's no presence gate; VEHICLE_UNAVAILABLE stays;
//    TRAVEL / REST / WAKE are accepted no-ops. That M001's behaviour is
//    otherwise unchanged is left to the existing tests, which all run with the
//    flag off: the ten re-locked M001 files (`logistics`, `economy`,
//    `production`, `contracts`, `commands/repeat`, `progression`,
//    `inventory`), the Sprint Zero and reference state hashes
//    (`test/sprint-zero`), and the economy-lab batch the issue's acceptance
//    criteria name.
//
// How twins are built (as non-leak's perturbed saves, decision 9 family 1):
// S₂ = S₁ with world values outside the live view perturbed (stock at
// facilities the founder isn't at, supplier and buyer state elsewhere, offers
// elsewhere dropped or re-priced, route conditions off the founder's view,
// production timing elsewhere, reputation while not present, the market while
// not at a buyer or supplier), hidden plumbing perturbed (RNG, counters, the
// event journal, a future closure), and every dynamic ID renumbered by an
// order-preserving map. The command sent to S₂ is the same command with the
// same renumbering. `knowledge`, the founder, the ledger, agreements and queued
// commands are never touched. A focused twin family perturbs a contract's
// world progress (outcomes and deliveries) while the founder is away from the
// buyer, for the installment checks.
//
// Interpretations pinned here (reported to the orchestrator):
// - The validator is the whole immediate check: all five gates, the kernel's
//   presence gate included. `orderValidators` must agree with `dispatch` on
//   every probe (3), so a check that stays outside the validators and reads
//   `GameState` fails the tie, not just the type test.
// - Gate 1 resolves IDs through the view only (decision 1). So an ID the view
//   doesn't hold is rejected with the command's not-found reason before any
//   presence check, wherever the founder is: an unknown offer is
//   OFFER_UNAVAILABLE and a bogus repeat source NOT_REPEATABLE even while the
//   founder walks; a known offer (from a record) at a buyer the founder isn't at
//   is NOT_PRESENT; at that buyer while it's closed, PLACE_CLOSED.
// - NOT_PRESENT's `issuerLocationId` is the founder's place when PRESENT
//   elsewhere and null while TRAVELLING. While RESTING it isn't pinned (the ADR
//   says resting counts as not present but doesn't say which value to report).
// - `PLACE_CLOSED.opensAt` is the first tick at or after the apply tick when
//   the place is open (the contract's "the next tick the place opens").
// - A dispatch from a place where the truck isn't parked is VEHICLE_NOT_AT with
//   the founder's place (ADR 0022 decision 3, ADR 0023 decision 5); a new
//   dispatch with `driver: null` under founder rules is NO_DRIVER.
// - Where the ADR leaves the order between two reasons open (which of
//   DEAL_UNAVAILABLE, NO_DRIVER and NOT_PRESENT wins while riding; capacity
//   versus a deal mismatch; RELEASE_RESERVATION away from the facility), a case
//   accepts any of the candidate codes and the differential still requires both
//   worlds to agree exactly.
// - Repeating a SALE dispatch with founder rules on is SK1c-2's (#226, on-spec
//   repeat), and `commands/repeat.ts` isn't SK1c-1's file, so flag-on probes
//   never repeat a sale. With the flag off they do.
// - NO_WAY_TO_REACH can't arise in M002 before phones and employees (decision
//   4: the communication gate is "present in person"), and VEHICLE_UNAVAILABLE
//   is flag-off only (decision 9); with the flag on, neither may ever be
//   returned.

import {
  asId,
  cents,
  DYNAMIC_ID_KINDS,
  DYNAMIC_ID_PREFIXES,
  GAME_COMMAND_TYPES,
  minuteOfDay,
  RNG_STREAMS,
  TICKS_PER_DAY,
  tick,
  type BuyerId,
  type CommandId,
  type CommandIssuer,
  type CommandResult,
  type ContractId,
  type ContractOfferId,
  type DealId,
  type GameCommand,
  type GameCommandType,
  type GameState,
  type LocationId,
  type PlayerPlace,
  type PlayerSnapshot,
  type RejectionCode,
  type RejectionReason,
  type ReservationId,
  type RouteId,
  type SaveGame,
  type ScheduledWorldEvent,
  type Tick,
} from "@eov/contracts";
import {
  BASIC_MOONSHINE_RECIPE,
  BUYERS,
  COPPER_STILL,
  CORN,
  COUNTY_ROAD,
  CROSSROADS,
  CROSSROADS_BACK_ROAD,
  CROSSROADS_ROADHOUSE,
  DISTILLERY_MAIN,
  EQUIPMENT,
  FACILITIES,
  FIRST_SHIPMENT_SCENARIO,
  GAME_DATA,
  HOLLOW_CREEK,
  IMPROVED_CONDENSER,
  KESSLER_BACK_ROAD,
  KESSLER_PHARMACY,
  KESSLERS_BACK_ROOM,
  LAKEVIEW,
  LAKEVIEW_BACK_ROAD,
  LAKEVIEW_HOTEL,
  LIVE_VIEW_ROUTES,
  LOCATIONS,
  MAX_REST_TICKS,
  MILLERS_FEED,
  MILLERS_FEED_LOCATION,
  MIN_REST_TICKS,
  MODEL_TT_TRUCK,
  MOONSHINE,
  PLACE_HOURS,
  QC_STATION,
  ROUTES,
  START_WAKE_TICK,
  STATE_HIGHWAY,
  STANDARD_MOONSHINE_RECIPE,
  SUGAR,
  SUPPLIERS,
  VEHICLES,
  WHISKEY,
  type ScenarioDefinition,
} from "@eov/game-data";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalJson, loadGame, newGame, scheduleWorldEvent, seedRng, type CommandOfType, type KernelSimulation } from "../../src/index.ts";
import { orderValidators, playerViewOf, type IssuerView, type OrderValidator, type OrderValidators, type PlayerView } from "../../src/view/index.ts";

// ---------------------------------------------------------------------------
// 1. Compile time: every validator takes an IssuerView, never GameState
// ---------------------------------------------------------------------------

/** A and B are each assignable to the other (labels and spelling don't matter). */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** Exact identity, for the places where `any` must not slip through. */
type Exact<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type AllTrue<R extends Record<string, boolean>> = R[keyof R] extends true ? true : false;
/** Fails `tsc` unless its type argument is `true`. A no-op at run time. */
const typeCheck = <T extends true>(): T | undefined => undefined;

/** Per command type: the validator's parameters are exactly (IssuerView, that command). */
type ParametersAreTheView = AllTrue<{ [T in GameCommandType]: Same<Parameters<OrderValidators[T]>, [IssuerView, CommandOfType<T>]> }>;
/** Per command type: the first parameter is IssuerView itself, not `any` or a GameState-shaped type. */
type FirstParameterIsIssuerView = AllTrue<{ [T in GameCommandType]: Exact<Parameters<OrderValidators[T]>[0], IssuerView> }>;
type ReturnsAReason = AllTrue<{ [T in GameCommandType]: Same<ReturnType<OrderValidators[T]>, RejectionReason | null> }>;
/** The member names of V that are, or return, something a GameState fits into (`any`, `unknown`, GameState, a supertype of it). */
type MembersExposingTheWorld<V> = {
  [K in keyof V]-?: [GameState] extends [V[K]]
    ? K
    : V[K] extends (...args: never[]) => infer R
      ? [GameState] extends [R]
        ? K
        : never
      : never;
}[keyof V];

describe("decision 9, compile time: validators take an IssuerView, never GameState", () => {
  it("is enforced by tsc over this file (these calls are no-ops at run time)", () => {
    typeCheck<Same<keyof OrderValidators, GameCommandType>>();
    typeCheck<ParametersAreTheView>();
    typeCheck<FirstParameterIsIssuerView>();
    typeCheck<ReturnsAReason>();
    typeCheck<Same<OrderValidator<"AGREE_DEAL">, OrderValidators["AGREE_DEAL"]>>();
    // A GameState can't be handed to a validator.
    typeCheck<[GameState] extends [IssuerView] ? false : true>();
    typeCheck<[GameState] extends [PlayerView] ? false : true>();
    typeCheck<Exact<IssuerView, unknown> extends true ? false : true>();
    // The view doesn't carry the world, directly or through a getter.
    typeCheck<Same<MembersExposingTheWorld<IssuerView>, never>>();
    typeCheck<Same<MembersExposingTheWorld<PlayerView>, never>>();
    // The founder's view is an issuer view, for the founder.
    typeCheck<[PlayerView] extends [IssuerView] ? true : false>();
    typeCheck<Same<IssuerView["issuer"], CommandIssuer>>();
    typeCheck<[PlayerView["issuer"]] extends [{ readonly kind: "FOUNDER" }] ? true : false>();
    typeCheck<Same<ReturnType<typeof playerViewOf>, PlayerView>>();
    typeCheck<Same<ReturnType<typeof orderValidators>, OrderValidators>>();
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Decision 9's renaming canonicaliser (as in non-leak)
// ---------------------------------------------------------------------------

const PREFIXES: readonly string[] = Object.values(DYNAMIC_ID_PREFIXES);
const DYNAMIC_ID_TOKEN = new RegExp(`(?<![a-z0-9-])(${PREFIXES.join("|")})-(0|[1-9][0-9]*)(?![a-z0-9-])`, "g");

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

const canonical = (value: unknown): string => renameDynamicIds(canonicalJson(value));
const canonicalTree = (value: unknown): unknown => JSON.parse(canonical(value)) as unknown;

interface IdMap {
  readonly mul: number;
  readonly add: number;
}
type IdMaps = Readonly<Record<string, IdMap>>;
const IDENTITY_IDS: IdMaps = {};

/** `n ↦ mul·n + add` per prefix, in any JSON value: order-preserving, so it's a renaming. */
function renumberValue<T>(value: T, maps: IdMaps): T {
  const json = JSON.stringify(value).replace(DYNAMIC_ID_TOKEN, (_token: string, prefix: string, digits: string) => {
    const m = maps[prefix] ?? { mul: 1, add: 0 };
    return `${prefix}-${m.mul * Number(digits) + m.add}`;
  });
  return JSON.parse(json) as T;
}

/** A whole state renumbered, with the counters moved past every ID. Equal to the input up to renaming. */
function renumberIds(state: GameState, maps: IdMaps): GameState {
  const renamed = renumberValue(state, maps);
  const nextId = { ...renamed.counters.nextId };
  for (const kind of DYNAMIC_ID_KINDS) {
    const m = maps[DYNAMIC_ID_PREFIXES[kind]] ?? { mul: 1, add: 0 };
    nextId[kind] = m.mul * nextId[kind] + m.add + 1;
  }
  return { ...renamed, counters: { ...renamed.counters, nextId } };
}

// ---------------------------------------------------------------------------
// Scenarios, places, and driving the simulation
// ---------------------------------------------------------------------------

/** The First Shipment with the founder's rules on, at M002 pacing, and no scheduled events. */
const FOUNDER_SCENARIO: ScenarioDefinition = {
  ...FIRST_SHIPMENT_SCENARIO,
  scheduledEvents: [],
  founderRules: true,
  realMsPerGameHourAt1x: 20_000,
};
/** M001: the flag off. */
const M001_SCENARIO: ScenarioDefinition = FIRST_SHIPMENT_SCENARIO;

const RULES_ON = { founderRules: true } as const;
const RULES_OFF = { founderRules: false } as const;
type Rules = typeof RULES_ON | typeof RULES_OFF;
const scenarioOf = (rules: Rules): ScenarioDefinition => (rules.founderRules ? FOUNDER_SCENARIO : M001_SCENARIO);

const TRUCK = MODEL_TT_TRUCK;
const TRUCK_CAPACITY = VEHICLES.find((v) => v.id === TRUCK)!.capacityCases;
const buyerLocation = (id: BuyerId): LocationId => BUYERS.find((b) => b.id === id)!.locationId;
const facilityLocation = (id: string): LocationId | null => FACILITIES.find((f) => f.id === id)?.locationId ?? null;
const supplierLocation = (id: string): LocationId | null => SUPPLIERS.find((s) => s.id === id)?.locationId ?? null;
const isPartyLocation = (l: LocationId): boolean => BUYERS.some((b) => b.locationId === l) || SUPPLIERS.some((s) => s.locationId === l);
const routesTouching = (l: LocationId): readonly RouteId[] => ROUTES.filter((r) => r.fromLocationId === l || r.toLocationId === l).map((r) => r.id);

function isOpen(locationId: LocationId, t: number): boolean {
  const entry = PLACE_HOURS.find((h) => h.locationId === locationId);
  if (!entry) return true;
  const m = minuteOfDay(tick(t));
  return entry.intervals.some(({ opensAtMinute: o, closesAtMinute: c }) => (o < c ? m >= o && m < c : m >= o || m < c));
}

/** PLACE_CLOSED's `opensAt`: the first tick at or after `t` when the place is open (known hours). */
function firstOpenTick(locationId: LocationId, t: number): Tick {
  for (let i = 0; i <= TICKS_PER_DAY; i++) if (isOpen(locationId, t + i)) return tick(t + i);
  throw new Error(`${locationId} never opens`);
}

const isFree = (s: GameState): boolean => s.founder.whereabouts.kind === "PRESENT" && s.founder.whereabouts.busy === null;
const presentAt = (s: GameState, l: LocationId): boolean => s.founder.whereabouts.kind === "PRESENT" && s.founder.whereabouts.locationId === l;
const applyTick = (s: GameState): Tick => tick(s.tick + 1);

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
  advanceUntil(sim, (s) => isFree(s) && isOpen(locationId, s.tick + 1) && isOpen(locationId, s.tick + 2), 2 * TICKS_PER_DAY, `${locationId} opens`);
}

/** A copy of `sim` with its state replaced (a save of the same game, edited). */
function withState(sim: KernelSimulation, state: GameState, rules: Rules = RULES_ON): KernelSimulation {
  return loadGame({ ...sim.serialize(), state }, { scenario: scenarioOf(rules) });
}

function closeRoute(sim: KernelSimulation, routeId: RouteId, at: number, durationTicks: number): KernelSimulation {
  return withState(sim, scheduleWorldEvent(sim.state, { kind: "ROUTE_CLOSURE", tick: tick(at), routeId, reason: "POLICE", durationTicks }));
}

/** The buyer's current quote for a product at a quality (the want `matchWant` would pick), from the world. */
function worldWant(s: GameState, buyerId: BuyerId, quality: "basic" | "standard" = "basic") {
  const rank = (q: string): number => (q === "standard" ? 1 : 0);
  return s.buyers
    .find((b) => b.id === buyerId)
    ?.wants.filter((w) => w.productId === MOONSHINE && rank(w.minimumQuality) <= rank(quality))
    .sort((a, b) => rank(b.minimumQuality) - rank(a.minimumQuality))[0];
}

/** Agree a deal at the buyer's quote (the founder must be free there, during hours). */
function agreeAtQuote(sim: KernelSimulation, buyerId: BuyerId, quantity: number): CommandResult {
  const agree = (price: number): CommandResult =>
    sim.dispatch({ command: { type: "AGREE_DEAL", buyerId, productId: MOONSHINE, quality: "basic", quantity, agreedUnitPrice: cents(price) } });
  let result = agree(worldWant(sim.state, buyerId)?.unitPrice ?? 1);
  if (result.status === "rejected" && result.reason.code === "QUOTE_CHANGED") result = agree(result.reason.current);
  return result;
}

const placeOf = (snapshot: PlayerSnapshot, id: LocationId): PlayerPlace => {
  const place = snapshot.places.find((p) => p.id === id);
  if (!place) throw new Error(`no place ${id} in the player snapshot`);
  return place;
};

/** Contract offers the founder knows at a buyer's place (from the player snapshot). */
function knownOfferIds(sim: KernelSimulation, location: LocationId): readonly ContractOfferId[] {
  const place = placeOf(sim.playerSnapshot(), location);
  if (place.kind !== "BUYER") throw new Error(`${location} isn't a buyer`);
  return place.buyer.offers?.value.offers.map((o) => o.id) ?? [];
}

// ---------------------------------------------------------------------------
// Hidden state (as non-leak's perturbed saves)
// ---------------------------------------------------------------------------

interface ViewScope {
  readonly observed: LocationId | null;
  readonly partyVisible: boolean;
  readonly liveRoutes: ReadonlySet<RouteId>;
}

/** The live view, conservatively (ADR 0021 decision 5, ADR 0023 decisions 2 and 6). */
function viewScope(s: GameState): ViewScope {
  const w = s.founder.whereabouts;
  const liveRoutes = new Set<RouteId>();
  let observed: LocationId | null = null;
  let partyVisible = true;
  if (w.kind === "PRESENT") {
    observed = w.locationId;
    partyVisible = isOpen(w.locationId, s.tick) || isOpen(w.locationId, s.tick + 1) || isOpen(w.locationId, s.tick + 2);
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
    facility: (id: string): boolean => facilityLocation(id) !== v.observed,
    buyer: (id: BuyerId): boolean => partyHidden(buyerLocation(id)),
    supplier: (id: string): boolean => partyHidden(supplierLocation(id)),
    market: v.observed === null || !isPartyLocation(v.observed) || !v.partyVisible,
    standing: v.observed === null || (isPartyLocation(v.observed) && !v.partyVisible),
    route: (id: RouteId): boolean => !v.liveRoutes.has(id),
  };
}

interface HiddenPlan {
  readonly ids: IdMaps;
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

/** S₂ from S₁: world values outside the live view and hidden plumbing changed; knowledge, the founder, the ledger, agreements and queued commands untouched. */
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

/** Two fixed hidden plans: one renamed, offers dropped and every hidden road flipped; one with identity IDs and hidden buyers broke. */
const FIXED_PLANS: readonly HiddenPlan[] = (() => {
  const [a, b] = fc.sample(hiddenPlanArb, { seed: 22_009, numRuns: 2 });
  if (!a || !b) throw new Error("no plans");
  const allRoutes = ROUTES.map(() => true);
  return [
    { ...a, dropOffers: true, flipRoutes: allRoutes, extraStock: 3, reputation: 77 },
    { ...b, ids: IDENTITY_IDS, dropOffers: false, budget: 0, demand: 0, flipRoutes: allRoutes, supplierAvailable: 0, reputation: 0 },
  ];
})();

interface Twin {
  readonly sim: KernelSimulation;
  readonly ids: IdMaps;
  readonly what: string;
}

function twinOf(sim: KernelSimulation, plan: HiddenPlan, what: string): Twin {
  return { sim: withState(sim, renumberIds(perturbHidden(sim.state, plan), plan.ids)), ids: plan.ids, what };
}

const fixedTwins = (sim: KernelSimulation): readonly Twin[] => FIXED_PLANS.map((plan, i) => twinOf(sim, plan, `fixed hidden plan ${i}`));

// ---------------------------------------------------------------------------
// Verdicts: the tie to the view-based validator, and the differential
// ---------------------------------------------------------------------------

type Verdict = { readonly status: "applied" } | { readonly status: "rejected"; readonly reason: RejectionReason };

/** Never returned with founder rules on (header). */
const NEVER_UNDER_FOUNDER_RULES: ReadonlySet<RejectionCode> = new Set<RejectionCode>([
  "NO_WAY_TO_REACH",
  "VEHICLE_UNAVAILABLE",
  // PH1's codes (ADR 0027 decision 16): unreachable while PH1's handlers are no-ops. C1 (#179) pins them.
  "NO_PHONE_HERE",
  "NO_PHONE_THERE",
  "PHONE_ALREADY_INSTALLED",
  "PHONE_USE_NOT_GRANTED",
  "NO_ROOMS_HERE",
]);

const VALIDATORS = { on: orderValidators(GAME_DATA, RULES_ON), off: orderValidators(GAME_DATA, RULES_OFF) };

/** The view-based validator's verdict for `command` applied eagerly in `state`. */
function viewVerdict(state: GameState, command: GameCommand, rules: Rules): RejectionReason | null {
  const view = playerViewOf(state, GAME_DATA, rules, applyTick(state));
  const validate = (rules.founderRules ? VALIDATORS.on : VALIDATORS.off)[command.type] as OrderValidator<GameCommandType>;
  return validate(view, command);
}

/**
 * Dispatches `command` eagerly on a copy of `sim` and returns its verdict,
 * after checking it's exactly the view-based validator's (header, item 3).
 */
function judge(sim: KernelSimulation, command: GameCommand, rules: Rules = RULES_ON): Verdict {
  const state = sim.state;
  if (state.queuedCommands.length !== 0) throw new Error("Construction: judged states have no queued commands");
  const expected = viewVerdict(state, command, rules);
  const result = withState(sim, state, rules).dispatch({ command });
  if (result.status === "queued") throw new Error("Construction: an eager command was queued");
  const verdict: Verdict = result.status === "applied" ? { status: "applied" } : { status: "rejected", reason: result.reason };
  expect(verdict, `the immediate result of ${JSON.stringify(command)} at tick ${state.tick + 1} is the view-based validator's verdict (decision 2)`).toEqual(
    expected === null ? { status: "applied" } : { status: "rejected", reason: expected },
  );
  if (rules.founderRules && verdict.status === "rejected") {
    expect(NEVER_UNDER_FOUNDER_RULES.has(verdict.reason.code), `${verdict.reason.code} with founder rules on`).toBe(false);
  }
  return verdict;
}

/** S₁'s verdict, and the same (renamed) verdict in every twin: decision 9's per-code property. */
function expectSameVerdict(sim: KernelSimulation, twins: readonly Twin[], command: GameCommand, what: string): Verdict {
  const v1 = judge(sim, command);
  for (const twin of twins) {
    const c2 = renumberValue(command, twin.ids);
    const v2 = judge(twin.sim, c2);
    expect(
      canonicalTree({ command: c2, verdict: v2 }),
      `${what}: ${twin.what} differs from S₁ only outside the founder's view, but the verdict differs (a leak)`,
    ).toEqual(canonicalTree({ command, verdict: v1 }));
  }
  return v1;
}

// ---------------------------------------------------------------------------
// Probe commands: a broad battery built from a state (world values included,
// so hidden things are probed too)
// ---------------------------------------------------------------------------

const BOGUS = {
  supplier: asId("Supplier", "no-such-supplier"),
  recipe: asId("Recipe", "no-such-recipe"),
  buyer: asId("Buyer", "no-such-buyer"),
  equipment: asId("Equipment", "no-such-equipment"),
  facility: asId("Facility", "no-such-facility"),
  vehicle: asId("Vehicle", "no-such-vehicle"),
  location: asId("Location", "no-such-location"),
  offer: `${DYNAMIC_ID_PREFIXES.ContractOffer}-90001` as ContractOfferId,
  deal: `${DYNAMIC_ID_PREFIXES.Deal}-90001` as DealId,
  contract: `${DYNAMIC_ID_PREFIXES.Contract}-90001` as ContractId,
  reservation: `${DYNAMIC_ID_PREFIXES.Reservation}-90001` as ReservationId,
  command: `${DYNAMIC_ID_PREFIXES.Command}-90001` as CommandId,
};

/** Whether repeating `id` would repeat a SALE dispatch (SK1c-2's with founder rules on). */
function repeatsASale(s: GameState, id: CommandId): boolean {
  for (let step = 0; step <= s.commandLog.length; step++) {
    const entry = s.commandLog.find((e) => e.id === id);
    if (!entry) return false;
    if (entry.command.type !== "REPEAT_OPERATION") return entry.command.type === "DISPATCH_DELIVERY" && entry.command.purpose.kind === "SALE";
    id = entry.command.sourceCommandId;
  }
  return false;
}

function probeCatalog(s: GameState, rules: Rules = RULES_ON): readonly GameCommand[] {
  const out: GameCommand[] = [];
  const at = applyTick(s);
  for (const materialId of [CORN, SUGAR]) {
    for (const quantity of [1, 4, 400]) out.push({ type: "PURCHASE_MATERIALS", supplierId: MILLERS_FEED, materialId, quantity, facilityId: DISTILLERY_MAIN });
  }
  out.push({ type: "PURCHASE_MATERIALS", supplierId: BOGUS.supplier, materialId: CORN, quantity: 1, facilityId: DISTILLERY_MAIN });
  out.push({ type: "PURCHASE_MATERIALS", supplierId: MILLERS_FEED, materialId: CORN, quantity: 0, facilityId: DISTILLERY_MAIN });
  for (const recipeId of [BASIC_MOONSHINE_RECIPE, STANDARD_MOONSHINE_RECIPE]) {
    for (const quantity of [1, 3]) out.push({ type: "START_PRODUCTION", facilityId: DISTILLERY_MAIN, recipeId, quantity });
  }
  for (const buyer of s.buyers) {
    for (const want of buyer.wants) {
      for (const quantity of [1, 3, want.demandRemaining + 1]) {
        out.push({ type: "AGREE_DEAL", buyerId: buyer.id, productId: want.productId, quality: want.minimumQuality, quantity, agreedUnitPrice: want.unitPrice });
      }
      out.push({ type: "AGREE_DEAL", buyerId: buyer.id, productId: want.productId, quality: want.minimumQuality, quantity: 1, agreedUnitPrice: cents(want.unitPrice + 1) });
    }
    out.push({ type: "AGREE_DEAL", buyerId: buyer.id, productId: WHISKEY, quality: "basic", quantity: 1, agreedUnitPrice: cents(100) });
  }
  for (const offer of s.contractOffers) out.push({ type: "ACCEPT_CONTRACT", contractOfferId: offer.id });
  out.push({ type: "ACCEPT_CONTRACT", contractOfferId: BOGUS.offer });
  for (const deal of s.heldDeals) {
    const cargo = [{ productId: deal.productId, quality: deal.quality, quantity: deal.quantity }];
    for (const routeId of [null, ...routesTouching(buyerLocation(deal.buyerId))]) {
      out.push({ type: "DISPATCH_DELIVERY", vehicleId: TRUCK, cargo, purpose: { kind: "SALE", buyerId: deal.buyerId, dealId: deal.id }, routeId, driver: { kind: "FOUNDER" } });
    }
    out.push({
      type: "DISPATCH_DELIVERY",
      vehicleId: TRUCK,
      cargo: [{ ...cargo[0]!, quantity: deal.quantity + 1 }],
      purpose: { kind: "SALE", buyerId: deal.buyerId, dealId: deal.id },
      routeId: null,
      driver: { kind: "FOUNDER" },
    });
  }
  for (const contract of s.contracts) {
    for (const quantity of [1, 4, TRUCK_CAPACITY + 1]) {
      for (const routeId of [null, ...routesTouching(buyerLocation(contract.buyerId))]) {
        out.push({
          type: "DISPATCH_DELIVERY",
          vehicleId: TRUCK,
          cargo: [{ productId: contract.productId, quality: "basic", quantity }],
          purpose: { kind: "CONTRACT_INSTALLMENT", contractId: contract.id },
          routeId,
          driver: { kind: "FOUNDER" },
        });
      }
    }
  }
  const moonshine = [{ productId: MOONSHINE, quality: "basic" as const, quantity: 1 }];
  for (const buyer of BUYERS) {
    out.push({ type: "DISPATCH_DELIVERY", vehicleId: TRUCK, cargo: moonshine, purpose: { kind: "SALE", buyerId: buyer.id, dealId: null }, routeId: null, driver: { kind: "FOUNDER" } });
  }
  out.push({ type: "DISPATCH_DELIVERY", vehicleId: TRUCK, cargo: moonshine, purpose: { kind: "SALE", buyerId: CROSSROADS_ROADHOUSE, dealId: BOGUS.deal }, routeId: null, driver: { kind: "FOUNDER" } });
  out.push({ type: "DISPATCH_DELIVERY", vehicleId: TRUCK, cargo: moonshine, purpose: { kind: "TRANSFER", destinationFacilityId: DISTILLERY_MAIN }, routeId: null, driver: null });
  out.push({ type: "DISPATCH_DELIVERY", vehicleId: BOGUS.vehicle, cargo: moonshine, purpose: { kind: "TRANSFER", destinationFacilityId: DISTILLERY_MAIN }, routeId: null, driver: { kind: "FOUNDER" } });
  for (const e of EQUIPMENT) {
    out.push({ type: "PURCHASE_EQUIPMENT", facilityId: DISTILLERY_MAIN, equipmentId: e.id });
    out.push({ type: "SELL_EQUIPMENT", facilityId: DISTILLERY_MAIN, equipmentId: e.id });
  }
  for (const workerCount of [0, 2, 3, 99]) out.push({ type: "SET_WORKFORCE", facilityId: DISTILLERY_MAIN, workerCount });
  for (const r of s.reservations) {
    out.push({ type: "RELEASE_RESERVATION", facilityId: r.facilityId, reservationId: r.id });
    if (r.facilityId !== DISTILLERY_MAIN) out.push({ type: "RELEASE_RESERVATION", facilityId: DISTILLERY_MAIN, reservationId: r.id });
  }
  out.push({ type: "RELEASE_RESERVATION", facilityId: DISTILLERY_MAIN, reservationId: BOGUS.reservation });
  for (const entry of s.commandLog.slice(-8)) {
    if (!rules.founderRules || !repeatsASale(s, entry.id)) out.push({ type: "REPEAT_OPERATION", sourceCommandId: entry.id });
  }
  out.push({ type: "REPEAT_OPERATION", sourceCommandId: BOGUS.command });
  for (const location of LOCATIONS) {
    out.push({ type: "TRAVEL", destinationLocationId: location.id, transport: { kind: "FOOT" }, via: null });
    out.push({ type: "TRAVEL", destinationLocationId: location.id, transport: { kind: "VEHICLE", vehicleId: TRUCK }, via: null });
  }
  out.push({ type: "TRAVEL", destinationLocationId: KESSLER_PHARMACY, transport: { kind: "VEHICLE", vehicleId: TRUCK }, via: [{ routeId: COUNTY_ROAD, reversed: false }] });
  out.push({
    type: "TRAVEL",
    destinationLocationId: KESSLER_PHARMACY,
    transport: { kind: "VEHICLE", vehicleId: TRUCK },
    via: [
      { routeId: STATE_HIGHWAY, reversed: true },
      { routeId: KESSLER_BACK_ROAD, reversed: false },
    ],
  });
  out.push({ type: "REST", untilTick: tick(at + MIN_REST_TICKS + 30) });
  out.push({ type: "REST", untilTick: at });
  out.push({ type: "WAKE" });
  return out;
}

// ---------------------------------------------------------------------------
// Stations: reachable founder-rules states, built once and loaded fresh
// ---------------------------------------------------------------------------

const STOCKED_CASES = 4;
const SPARE_CASES = 3;

type Station =
  | "resting"
  | "home"
  | "travelling"
  | "feedStore"
  | "busyFeedStore"
  | "stockedHome"
  | "crossroads"
  | "dealHome"
  | "dealHomeClosed"
  | "dealNoStock"
  | "kesslerKnown"
  | "kesslerClosed"
  | "kesslerKnownHome"
  | "newOfferHome"
  | "contractedHome"
  | "lakeview"
  | "jobRunning"
  | "riding";

const STATIONS: readonly Station[] = [
  "resting",
  "home",
  "travelling",
  "feedStore",
  "busyFeedStore",
  "stockedHome",
  "crossroads",
  "dealHome",
  "dealHomeClosed",
  "dealNoStock",
  "kesslerKnown",
  "kesslerClosed",
  "kesslerKnownHome",
  "newOfferHome",
  "contractedHome",
  "lakeview",
  "jobRunning",
  "riding",
];

const saves = new Map<Station, SaveGame>();

function station(name: Station): KernelSimulation {
  let save = saves.get(name);
  if (!save) {
    const sim = build(name);
    save = sim.serialize();
    saves.set(name, save);
  }
  return loadGame(save, { scenario: FOUNDER_SCENARIO });
}

function build(name: Station): KernelSimulation {
  switch (name) {
    case "resting": {
      const sim = newGame({ scenario: FOUNDER_SCENARIO });
      if (sim.state.founder.whereabouts.kind !== "RESTING") throw new Error("Construction: a new game starts with the founder resting");
      return sim;
    }
    case "home": {
      const sim = newGame({ scenario: FOUNDER_SCENARIO });
      advanceUntil(sim, isFree, START_WAKE_TICK + 2, "the founder wakes on the first morning");
      return sim;
    }
    case "travelling": {
      const sim = station("home");
      expectApplied(sim.dispatch({ command: { type: "TRAVEL", destinationLocationId: CROSSROADS, transport: { kind: "FOOT" }, via: null } }), "walk out");
      sim.advance(10);
      if (sim.state.founder.whereabouts.kind !== "TRAVELLING") throw new Error("Construction: the founder is on the road");
      return sim;
    }
    case "feedStore": {
      const sim = station("home");
      walkTo(sim, MILLERS_FEED_LOCATION);
      waitOpen(sim, MILLERS_FEED_LOCATION);
      return sim;
    }
    case "busyFeedStore": {
      const sim = station("feedStore");
      expectApplied(sim.dispatch({ command: { type: "PURCHASE_MATERIALS", supplierId: MILLERS_FEED, materialId: CORN, quantity: 1, facilityId: DISTILLERY_MAIN } }), "buy corn");
      const w = sim.state.founder.whereabouts;
      if (w.kind !== "PRESENT" || w.busy === null) throw new Error("Construction: buying keeps the founder busy");
      return sim;
    }
    case "stockedHome": {
      const sim = station("feedStore");
      for (const [materialId, quantity] of [
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
      return sim;
    }
    case "crossroads": {
      const sim = station("stockedHome");
      walkTo(sim, CROSSROADS);
      waitOpen(sim, CROSSROADS);
      return sim;
    }
    case "dealHome": {
      const sim = station("crossroads");
      expectApplied(agreeAtQuote(sim, CROSSROADS_ROADHOUSE, 2), "agree a deal");
      walkTo(sim, HOLLOW_CREEK);
      return sim;
    }
    case "dealHomeClosed": {
      const base = station("dealHome");
      const sim = closeRoute(base, STATE_HIGHWAY, base.state.tick + 1, 2 * TICKS_PER_DAY);
      sim.advance(1);
      if (sim.state.routes.find((r) => r.id === STATE_HIGHWAY)?.closure == null) throw new Error("Construction: the highway is closed");
      return sim;
    }
    case "dealNoStock": {
      const sim = station("home");
      walkTo(sim, CROSSROADS);
      waitOpen(sim, CROSSROADS);
      expectApplied(agreeAtQuote(sim, CROSSROADS_ROADHOUSE, 1), "agree a deal");
      walkTo(sim, HOLLOW_CREEK);
      return sim;
    }
    case "kesslerKnown": {
      const sim = station("stockedHome");
      walkTo(sim, KESSLER_PHARMACY);
      waitOpen(sim, KESSLER_PHARMACY);
      sim.advance(1); // a tick-end persist at the open pharmacy
      if (knownOfferIds(sim, KESSLER_PHARMACY).length === 0) throw new Error("Construction: the founder learned Kessler's offers");
      return sim;
    }
    case "kesslerClosed": {
      const sim = station("kesslerKnown");
      advanceUntil(sim, (s) => isFree(s) && !isOpen(KESSLER_PHARMACY, s.tick) && !isOpen(KESSLER_PHARMACY, s.tick + 1) && !isOpen(KESSLER_PHARMACY, s.tick + 2), TICKS_PER_DAY, "Kessler's closes");
      if (!presentAt(sim.state, KESSLER_PHARMACY)) throw new Error("Construction: the founder stays at the pharmacy");
      return sim;
    }
    case "kesslerKnownHome": {
      const sim = station("kesslerKnown");
      walkTo(sim, HOLLOW_CREEK);
      return sim;
    }
    case "newOfferHome": {
      const sim = station("kesslerKnownHome");
      const unlearned = (): boolean => sim.state.contractOffers.some((o) => !knownOfferIds(sim, buyerLocation(o.buyerId)).includes(o.id));
      for (let i = 0; i < 3 * TICKS_PER_DAY && !unlearned(); i++) sim.advance(1);
      if (!unlearned() || !isFree(sim.state)) throw new Error("Construction: a new offer the founder hasn't learned, the founder free at home");
      return sim;
    }
    case "contractedHome": {
      const sim = station("kesslerKnown");
      const offer = sim.state.contractOffers.filter((o) => o.buyerId === KESSLERS_BACK_ROOM).at(-1);
      if (!offer) throw new Error("Construction: no contract offer at Kessler's");
      expectApplied(sim.dispatch({ command: { type: "ACCEPT_CONTRACT", contractOfferId: offer.id } }), "accept Kessler's contract");
      walkTo(sim, HOLLOW_CREEK);
      if (sim.state.contracts.length !== 1) throw new Error("Construction: one contract");
      return sim;
    }
    case "lakeview": {
      const sim = station("home");
      walkTo(sim, LAKEVIEW);
      waitOpen(sim, LAKEVIEW);
      return sim;
    }
    case "jobRunning": {
      const sim = station("stockedHome");
      expectApplied(
        sim.dispatch({ command: { type: "START_PRODUCTION", facilityId: DISTILLERY_MAIN, recipeId: BASIC_MOONSHINE_RECIPE, quantity: SPARE_CASES } }),
        "start a second batch",
      );
      advanceUntil(sim, isFree, TICKS_PER_DAY, "setting up ends");
      if (sim.state.productionJobs.length !== 1) throw new Error("Construction: the batch still runs once the founder is free");
      return sim;
    }
    case "riding": {
      const sim = station("dealHome");
      const deal = sim.state.heldDeals.at(-1)!;
      expectApplied(
        sim.dispatch({
          command: {
            type: "DISPATCH_DELIVERY",
            vehicleId: TRUCK,
            cargo: [{ productId: deal.productId, quality: deal.quality, quantity: deal.quantity }],
            purpose: { kind: "SALE", buyerId: deal.buyerId, dealId: deal.id },
            routeId: STATE_HIGHWAY,
            driver: { kind: "FOUNDER" },
          },
        }),
        "dispatch the deal, riding",
      );
      advanceUntil(sim, (s) => s.founder.whereabouts.kind === "ON_DELIVERY", TICKS_PER_DAY, "the truck sets out");
      sim.advance(20);
      if (sim.state.founder.whereabouts.kind !== "ON_DELIVERY") throw new Error("Construction: the founder rides");
      return sim;
    }
  }
}

// ---------------------------------------------------------------------------
// 2. The registry, at run time
// ---------------------------------------------------------------------------

describe("orderValidators: one view-based validator per command type", () => {
  it.each([
    ["on", RULES_ON],
    ["off", RULES_OFF],
  ] as const)("with founderRules %s, exactly GAME_COMMAND_TYPES, each a function", (_label, rules) => {
    const validators = orderValidators(GAME_DATA, rules);
    expect(Object.keys(validators).sort()).toEqual([...GAME_COMMAND_TYPES].sort());
    for (const type of GAME_COMMAND_TYPES) expect(typeof validators[type], type).toBe("function");
  });

  it("the player view is the founder's; building it and validating change no state", { timeout: 60_000 }, () => {
    for (const name of ["home", "dealHome", "riding"] as const) {
      const sim = station(name);
      const hash = sim.stateHash();
      const before = canonicalJson(sim.state);
      const view = playerViewOf(sim.state, GAME_DATA, RULES_ON, applyTick(sim.state));
      expect(view.issuer).toEqual({ kind: "FOUNDER" });
      for (const command of probeCatalog(sim.state)) viewVerdict(sim.state, command, RULES_ON);
      expect(sim.stateHash(), `${name}: the state hash moved`).toBe(hash);
      expect(canonicalJson(sim.state), `${name}: the state changed`).toBe(before);
    }
  });
});


// ---------------------------------------------------------------------------
// 4. Per RejectionCode: cases, each run against S₁ and its twins
// ---------------------------------------------------------------------------

interface Case {
  readonly name: string;
  readonly station: Station;
  readonly command: (sim: KernelSimulation) => GameCommand;
  /** What S₁ returns: applied, or one of these codes (one code pins it). */
  readonly expect: "APPLIED" | readonly RejectionCode[];
  /** S₁'s exact payload, where the ADR pins it. */
  readonly reason?: (sim: KernelSimulation) => RejectionReason;
  /** Part of S₁'s payload, where the ADR pins only part of it. */
  readonly partial?: (sim: KernelSimulation) => Partial<Record<string, unknown>>;
}

type CaseBody = Omit<Case, "name" | "station" | "command">;

const applied: CaseBody = { expect: "APPLIED" };
const code = (c: RejectionCode): CaseBody => ({ expect: [c] });
/** A payload that doesn't depend on the state, so its code is known up front. */
const exactly = (reason: () => RejectionReason): CaseBody => ({ expect: [reason().code], reason });
const oneOf = (...codes: RejectionCode[]): CaseBody => ({ expect: codes });

const notPresent = (requiredLocationId: LocationId, issuerLocationId: LocationId | null): CaseBody =>
  exactly(() => ({ code: "NOT_PRESENT", requiredLocationId, issuerLocationId }));
const busyFor = (): CaseBody => ({ expect: ["FOUNDER_BUSY"], reason: (sim) => ({ code: "FOUNDER_BUSY", until: busyUntil(sim) }) });
const closedAt = (locationId: LocationId): CaseBody => ({
  expect: ["PLACE_CLOSED"],
  reason: (sim) => ({ code: "PLACE_CLOSED", locationId, opensAt: firstOpenTick(locationId, applyTick(sim.state)) }),
});

const purchase = (materialId = CORN, quantity = 1): GameCommand => ({ type: "PURCHASE_MATERIALS", supplierId: MILLERS_FEED, materialId, quantity, facilityId: DISTILLERY_MAIN });
const startBatch = (quantity = 1, recipeId = BASIC_MOONSHINE_RECIPE): CommandOfType<"START_PRODUCTION"> => ({ type: "START_PRODUCTION", facilityId: DISTILLERY_MAIN, recipeId, quantity });
const workforce = (workerCount: number): GameCommand => ({ type: "SET_WORKFORCE", facilityId: DISTILLERY_MAIN, workerCount });
const agreeWith =
  (buyerId: BuyerId, quantity = 1, quality: "basic" | "standard" = "basic") =>
  (sim: KernelSimulation): CommandOfType<"AGREE_DEAL"> => ({
    type: "AGREE_DEAL",
    buyerId,
    productId: MOONSHINE,
    quality,
    quantity,
    agreedUnitPrice: worldWant(sim.state, buyerId, quality)?.unitPrice ?? cents(100),
  });
const walk = (destinationLocationId: LocationId): GameCommand => ({ type: "TRAVEL", destinationLocationId, transport: { kind: "FOOT" }, via: null });
const restValid = (sim: KernelSimulation): GameCommand => ({ type: "REST", untilTick: tick(applyTick(sim.state) + MIN_REST_TICKS + 30) });
const onSpec = (quantity: number): GameCommand => ({
  type: "DISPATCH_DELIVERY",
  vehicleId: TRUCK,
  cargo: [{ productId: MOONSHINE, quality: "basic", quantity }],
  purpose: { kind: "SALE", buyerId: CROSSROADS_ROADHOUSE, dealId: null },
  routeId: null,
  driver: { kind: "FOUNDER" },
});
const transferHome = (driver: "FOUNDER" | null): CommandOfType<"DISPATCH_DELIVERY"> => ({
  type: "DISPATCH_DELIVERY",
  vehicleId: TRUCK,
  cargo: [{ productId: MOONSHINE, quality: "basic", quantity: 1 }],
  purpose: { kind: "TRANSFER", destinationFacilityId: DISTILLERY_MAIN },
  routeId: null,
  driver: driver === null ? null : { kind: driver },
});
function heldDealOf(sim: KernelSimulation) {
  const deal = sim.state.heldDeals.find((d) => d.status === "HELD");
  if (!deal) throw new Error("Construction: a held deal");
  return deal;
}
const dispatchDeal =
  (routeId: RouteId | null, quantityDelta = 0) =>
  (sim: KernelSimulation): CommandOfType<"DISPATCH_DELIVERY"> => {
    const deal = heldDealOf(sim);
    return {
      type: "DISPATCH_DELIVERY",
      vehicleId: TRUCK,
      cargo: [{ productId: deal.productId, quality: deal.quality, quantity: deal.quantity + quantityDelta }],
      purpose: { kind: "SALE", buyerId: deal.buyerId, dealId: deal.id },
      routeId,
      driver: { kind: "FOUNDER" },
    };
  };
const installment =
  (quantity: number, productId = MOONSHINE, routeId: RouteId = KESSLER_BACK_ROAD) =>
  (sim: KernelSimulation): CommandOfType<"DISPATCH_DELIVERY"> => ({
    type: "DISPATCH_DELIVERY",
    vehicleId: TRUCK,
    cargo: [{ productId, quality: "basic", quantity }],
    purpose: { kind: "CONTRACT_INSTALLMENT", contractId: sim.state.contracts[0]!.id },
    routeId,
    driver: { kind: "FOUNDER" },
  });
function busyUntil(sim: KernelSimulation): Tick {
  const w = sim.state.founder.whereabouts;
  if (w.kind !== "PRESENT" || w.busy === null) throw new Error("Construction: the founder is busy");
  return w.busy.until;
}
const lastLogged = (sim: KernelSimulation, type: GameCommandType): CommandId => {
  const entry = sim.state.commandLog.filter((e) => e.command.type === type).at(-1);
  if (!entry) throw new Error(`Construction: no ${type} in the command log`);
  return entry.id;
};
const supplierAvailable = (sim: KernelSimulation, materialId: typeof CORN): number =>
  sim.state.suppliers.find((s) => s.id === MILLERS_FEED)!.stock.find((st) => st.materialId === materialId)!.available;

/** An offer in the world at a buyer whose offers the founder has never learned. */
function unlearnedOffer(sim: KernelSimulation): ContractOfferId {
  const offer = sim.state.contractOffers.find((o) => !knownOfferIds(sim, buyerLocation(o.buyerId)).includes(o.id));
  if (!offer) throw new Error("Construction: an offer the founder never learned");
  return offer.id;
}

/** ECO-001 liquidity at a buyer, from the world (the live view when the founder is there). */
function acceptableAt(s: GameState, buyerId: BuyerId): number {
  const buyer = s.buyers.find((b) => b.id === buyerId)!;
  const want = worldWant(s, buyerId)!;
  const affordable = want.unitPrice > 0 ? Math.floor(buyer.budgetRemaining / want.unitPrice) : want.demandRemaining;
  return Math.max(0, Math.min(want.demandRemaining, affordable));
}

const CASES: readonly Case[] = [
  // --- Gate 1 (shape and identity) comes before presence: checked while the founder walks.
  { name: "PURCHASE_MATERIALS, quantity 0", station: "travelling", command: () => purchase(CORN, 0), ...code("INVALID_QUANTITY") },
  { name: "START_PRODUCTION, quantity 0", station: "travelling", command: () => startBatch(0), ...code("INVALID_QUANTITY") },
  { name: "AGREE_DEAL, quantity 0", station: "travelling", command: agreeWith(CROSSROADS_ROADHOUSE, 0), ...code("INVALID_QUANTITY") },
  { name: "SET_WORKFORCE, -1 workers", station: "travelling", command: () => workforce(-1), ...code("INVALID_QUANTITY") },
  { name: "DISPATCH_DELIVERY, 0 cases", station: "travelling", command: () => ({ ...transferHome("FOUNDER"), cargo: [{ productId: MOONSHINE, quality: "basic", quantity: 0 }] }), ...code("INVALID_QUANTITY") },
  {
    name: "PURCHASE_MATERIALS, unknown supplier",
    station: "travelling",
    command: () => ({ type: "PURCHASE_MATERIALS", supplierId: BOGUS.supplier, materialId: CORN, quantity: 1, facilityId: DISTILLERY_MAIN }),
    ...code("UNKNOWN_ENTITY"),
  },
  { name: "START_PRODUCTION, unknown recipe", station: "travelling", command: () => startBatch(1, BOGUS.recipe), ...code("UNKNOWN_ENTITY") },
  { name: "AGREE_DEAL, unknown buyer", station: "travelling", command: (sim) => ({ ...agreeWith(CROSSROADS_ROADHOUSE)(sim), buyerId: BOGUS.buyer }), ...code("UNKNOWN_ENTITY") },
  {
    name: "PURCHASE_EQUIPMENT, unknown equipment",
    station: "travelling",
    command: () => ({ type: "PURCHASE_EQUIPMENT", facilityId: DISTILLERY_MAIN, equipmentId: BOGUS.equipment }),
    ...code("UNKNOWN_ENTITY"),
  },
  { name: "SELL_EQUIPMENT, unknown equipment", station: "travelling", command: () => ({ type: "SELL_EQUIPMENT", facilityId: DISTILLERY_MAIN, equipmentId: BOGUS.equipment }), ...code("UNKNOWN_ENTITY") },
  { name: "SET_WORKFORCE, unknown facility", station: "travelling", command: () => ({ type: "SET_WORKFORCE", facilityId: BOGUS.facility, workerCount: 2 }), ...code("UNKNOWN_ENTITY") },
  { name: "DISPATCH_DELIVERY, unknown vehicle", station: "travelling", command: () => ({ ...transferHome("FOUNDER"), vehicleId: BOGUS.vehicle }), ...code("UNKNOWN_ENTITY") },
  { name: "TRAVEL, unknown destination", station: "travelling", command: () => walk(BOGUS.location), ...code("UNKNOWN_ENTITY") },
  {
    name: "ACCEPT_CONTRACT, an offer the view doesn't hold",
    station: "travelling",
    command: () => ({ type: "ACCEPT_CONTRACT", contractOfferId: BOGUS.offer }),
    ...exactly(() => ({ code: "OFFER_UNAVAILABLE", contractOfferId: BOGUS.offer })),
  },
  {
    name: "REPEAT_OPERATION, an unknown source",
    station: "travelling",
    command: () => ({ type: "REPEAT_OPERATION", sourceCommandId: BOGUS.command }),
    ...exactly(() => ({ code: "NOT_REPEATABLE", sourceCommandId: BOGUS.command })),
  },

  // --- Presence while travelling: not present anywhere; TRAVEL and REST away; WAKE not resting.
  { name: "PURCHASE_MATERIALS while travelling", station: "travelling", command: () => purchase(), ...notPresent(MILLERS_FEED_LOCATION, null) },
  { name: "START_PRODUCTION while travelling", station: "travelling", command: () => startBatch(), ...notPresent(HOLLOW_CREEK, null) },
  { name: "AGREE_DEAL while travelling", station: "travelling", command: agreeWith(CROSSROADS_ROADHOUSE), ...notPresent(CROSSROADS, null) },
  { name: "SELL_EQUIPMENT while travelling", station: "travelling", command: () => ({ type: "SELL_EQUIPMENT", facilityId: DISTILLERY_MAIN, equipmentId: COPPER_STILL }), ...notPresent(HOLLOW_CREEK, null) },
  { name: "TRAVEL while travelling", station: "travelling", command: () => walk(HOLLOW_CREEK), ...exactly(() => ({ code: "FOUNDER_AWAY", whereabouts: "TRAVELLING" })) },
  { name: "REST while travelling", station: "travelling", command: restValid, ...exactly(() => ({ code: "FOUNDER_AWAY", whereabouts: "TRAVELLING" })) },
  { name: "WAKE while travelling", station: "travelling", command: () => ({ type: "WAKE" }), ...exactly(() => ({ code: "NOT_RESTING" })) },
  { name: "DISPATCH_DELIVERY while travelling", station: "travelling", command: () => transferHome("FOUNDER"), ...oneOf("NOT_PRESENT", "NO_DRIVER") },

  // --- Presence while resting (tick 0 of a new game, at Hollow Creek).
  {
    name: "PURCHASE_MATERIALS while resting",
    station: "resting",
    command: () => purchase(),
    expect: ["NOT_PRESENT"],
    partial: () => ({ code: "NOT_PRESENT", requiredLocationId: MILLERS_FEED_LOCATION }),
  },
  {
    name: "START_PRODUCTION while resting beside the still",
    station: "resting",
    command: () => startBatch(),
    expect: ["NOT_PRESENT"],
    partial: () => ({ code: "NOT_PRESENT", requiredLocationId: HOLLOW_CREEK }),
  },
  { name: "TRAVEL while resting", station: "resting", command: () => walk(CROSSROADS), ...exactly(() => ({ code: "FOUNDER_AWAY", whereabouts: "RESTING" })) },
  { name: "REST while resting", station: "resting", command: restValid, ...exactly(() => ({ code: "FOUNDER_AWAY", whereabouts: "RESTING" })) },
  { name: "WAKE while resting", station: "resting", command: () => ({ type: "WAKE" }), ...applied },

  // --- At Hollow Creek, free, with nothing in stock.
  { name: "PURCHASE_MATERIALS from home", station: "home", command: () => purchase(), ...notPresent(MILLERS_FEED_LOCATION, HOLLOW_CREEK) },
  { name: "AGREE_DEAL from home", station: "home", command: agreeWith(CROSSROADS_ROADHOUSE), ...notPresent(CROSSROADS, HOLLOW_CREEK) },
  {
    name: "ACCEPT_CONTRACT for a real offer the founder never learned",
    station: "newOfferHome",
    command: (sim) => ({ type: "ACCEPT_CONTRACT", contractOfferId: unlearnedOffer(sim) }),
    expect: ["OFFER_UNAVAILABLE"],
    reason: (sim) => ({ code: "OFFER_UNAVAILABLE", contractOfferId: unlearnedOffer(sim) }),
  },
  { name: "START_PRODUCTION with no materials", station: "home", command: () => startBatch(), ...code("INSUFFICIENT_MATERIALS") },
  { name: "START_PRODUCTION, a recipe the still can't run", station: "home", command: () => startBatch(1, STANDARD_MOONSHINE_RECIPE), ...code("RECIPE_NOT_SUPPORTED") },
  { name: "SET_WORKFORCE above the maximum", station: "home", command: () => workforce(999), ...code("WORKFORCE_LIMIT_EXCEEDED") },
  { name: "SET_WORKFORCE at home", station: "home", command: () => workforce(2), ...applied },
  {
    name: "PURCHASE_EQUIPMENT already owned",
    station: "home",
    command: () => ({ type: "PURCHASE_EQUIPMENT", facilityId: DISTILLERY_MAIN, equipmentId: COPPER_STILL }),
    ...exactly(() => ({ code: "EQUIPMENT_ALREADY_OWNED", facilityId: DISTILLERY_MAIN, equipmentId: COPPER_STILL })),
  },
  { name: "PURCHASE_EQUIPMENT not unlocked", station: "home", command: () => ({ type: "PURCHASE_EQUIPMENT", facilityId: DISTILLERY_MAIN, equipmentId: IMPROVED_CONDENSER }), ...code("LOCKED") },
  {
    name: "SELL_EQUIPMENT not owned",
    station: "home",
    command: () => ({ type: "SELL_EQUIPMENT", facilityId: DISTILLERY_MAIN, equipmentId: QC_STATION }),
    ...exactly(() => ({ code: "EQUIPMENT_NOT_OWNED", facilityId: DISTILLERY_MAIN, equipmentId: QC_STATION })),
  },
  {
    name: "RELEASE_RESERVATION, a reservation the view doesn't hold",
    station: "home",
    command: () => ({ type: "RELEASE_RESERVATION", facilityId: DISTILLERY_MAIN, reservationId: BOGUS.reservation }),
    ...exactly(() => ({ code: "RESERVATION_NOT_ACTIVE", reservationId: BOGUS.reservation })),
  },
  { name: "DISPATCH_DELIVERY with no driver", station: "home", command: () => transferHome(null), ...exactly(() => ({ code: "NO_DRIVER", vehicleId: TRUCK })) },
  { name: "TRAVEL to where the founder is", station: "home", command: () => walk(HOLLOW_CREEK), ...exactly(() => ({ code: "ALREADY_THERE" })) },
  {
    name: "TRAVEL by a path that doesn't lead there",
    station: "home",
    command: () => ({ type: "TRAVEL", destinationLocationId: CROSSROADS, transport: { kind: "FOOT" }, via: [{ routeId: COUNTY_ROAD, reversed: false }] }),
    ...exactly(() => ({ code: "INVALID_PATH" })),
  },
  {
    name: "REST too short",
    station: "home",
    command: (sim) => ({ type: "REST", untilTick: applyTick(sim.state) }),
    expect: ["INVALID_REST_LENGTH"],
    reason: (sim) => ({ code: "INVALID_REST_LENGTH", min: tick(applyTick(sim.state) + MIN_REST_TICKS), max: tick(applyTick(sim.state) + MAX_REST_TICKS) }),
  },
  { name: "REST at home", station: "home", command: restValid, ...applied },
  { name: "WAKE while awake", station: "home", command: () => ({ type: "WAKE" }), ...exactly(() => ({ code: "NOT_RESTING" })) },

  // --- At the feed store, open.
  { name: "PURCHASE_MATERIALS beyond the supplier's stock (live)", station: "feedStore", command: (sim) => purchase(SUGAR, supplierAvailable(sim, SUGAR) + 1), ...code("SUPPLIER_STOCK_LOW") },
  { name: "PURCHASE_MATERIALS at the open feed store", station: "feedStore", command: () => purchase(), ...applied },
  { name: "START_PRODUCTION from the feed store", station: "feedStore", command: () => startBatch(), ...notPresent(HOLLOW_CREEK, MILLERS_FEED_LOCATION) },
  { name: "SET_WORKFORCE from the feed store", station: "feedStore", command: () => workforce(2), ...notPresent(HOLLOW_CREEK, MILLERS_FEED_LOCATION) },
  {
    name: "PURCHASE_EQUIPMENT from the feed store",
    station: "feedStore",
    command: () => ({ type: "PURCHASE_EQUIPMENT", facilityId: DISTILLERY_MAIN, equipmentId: IMPROVED_CONDENSER }),
    ...notPresent(HOLLOW_CREEK, MILLERS_FEED_LOCATION),
  },
  {
    name: "SELL_EQUIPMENT from the feed store",
    station: "feedStore",
    command: () => ({ type: "SELL_EQUIPMENT", facilityId: DISTILLERY_MAIN, equipmentId: COPPER_STILL }),
    ...notPresent(HOLLOW_CREEK, MILLERS_FEED_LOCATION),
  },
  {
    name: "DISPATCH_DELIVERY from where the truck isn't",
    station: "feedStore",
    command: () => transferHome("FOUNDER"),
    ...exactly(() => ({ code: "VEHICLE_NOT_AT", vehicleId: TRUCK, locationId: MILLERS_FEED_LOCATION })),
  },
  {
    name: "TRAVEL by a truck that isn't here",
    station: "feedStore",
    command: () => ({ type: "TRAVEL", destinationLocationId: HOLLOW_CREEK, transport: { kind: "VEHICLE", vehicleId: TRUCK }, via: null }),
    ...exactly(() => ({ code: "VEHICLE_NOT_AT", vehicleId: TRUCK, locationId: MILLERS_FEED_LOCATION })),
  },
  {
    name: "RELEASE_RESERVATION away from the facility",
    station: "feedStore",
    command: () => ({ type: "RELEASE_RESERVATION", facilityId: DISTILLERY_MAIN, reservationId: BOGUS.reservation }),
    ...oneOf("RESERVATION_NOT_ACTIVE", "NOT_PRESENT"),
  },

  // --- Busy at the feed store (buying): timed commands, travel and rest wait; WAKE still isn't resting.
  { name: "PURCHASE_MATERIALS while busy", station: "busyFeedStore", command: () => purchase(SUGAR), ...busyFor() },
  { name: "TRAVEL while busy", station: "busyFeedStore", command: () => walk(HOLLOW_CREEK), ...busyFor() },
  { name: "REST while busy", station: "busyFeedStore", command: restValid, ...busyFor() },
  { name: "WAKE while busy", station: "busyFeedStore", command: () => ({ type: "WAKE" }), ...exactly(() => ({ code: "NOT_RESTING" })) },

  // --- At the Crossroads, open: AGREE_DEAL against the live view.
  { name: "AGREE_DEAL at the quote", station: "crossroads", command: agreeWith(CROSSROADS_ROADHOUSE), ...applied },
  {
    name: "AGREE_DEAL at a stale price",
    station: "crossroads",
    command: (sim) => ({ ...agreeWith(CROSSROADS_ROADHOUSE)(sim), agreedUnitPrice: cents(worldWant(sim.state, CROSSROADS_ROADHOUSE)!.unitPrice + 1) }),
    expect: ["QUOTE_CHANGED"],
    reason: (sim) => {
      const current = worldWant(sim.state, CROSSROADS_ROADHOUSE)!.unitPrice;
      return { code: "QUOTE_CHANGED", buyerId: CROSSROADS_ROADHOUSE, agreed: cents(current + 1), current };
    },
  },
  {
    name: "AGREE_DEAL for more than the buyer will take (live demand and budget)",
    station: "crossroads",
    command: (sim) => agreeWith(CROSSROADS_ROADHOUSE, acceptableAt(sim.state, CROSSROADS_ROADHOUSE) + 1)(sim),
    expect: ["BUYER_WILL_TAKE_LESS"],
    reason: (sim) => {
      const acceptable = acceptableAt(sim.state, CROSSROADS_ROADHOUSE);
      return { code: "BUYER_WILL_TAKE_LESS", buyerId: CROSSROADS_ROADHOUSE, requested: acceptable + 1, acceptable };
    },
  },
  {
    name: "AGREE_DEAL for a product the buyer doesn't want",
    station: "crossroads",
    command: () => ({ type: "AGREE_DEAL", buyerId: CROSSROADS_ROADHOUSE, productId: WHISKEY, quality: "basic", quantity: 1, agreedUnitPrice: cents(100) }),
    ...exactly(() => ({ code: "PRODUCT_NOT_WANTED", buyerId: CROSSROADS_ROADHOUSE, productId: WHISKEY, quality: "basic" })),
  },
  { name: "PURCHASE_MATERIALS from the Crossroads", station: "crossroads", command: () => purchase(), ...notPresent(MILLERS_FEED_LOCATION, CROSSROADS) },
  { name: "AGREE_DEAL with another buyer, from the Crossroads", station: "crossroads", command: agreeWith(KESSLERS_BACK_ROOM), ...notPresent(KESSLER_PHARMACY, CROSSROADS) },

  // --- At Lakeview, open, below the hotel's reputation.
  {
    name: "AGREE_DEAL below the buyer's minimum reputation",
    station: "lakeview",
    command: agreeWith(LAKEVIEW_HOTEL, 1, "standard"),
    expect: ["REPUTATION_TOO_LOW"],
    reason: (sim) => ({ code: "REPUTATION_TOO_LOW", required: BUYERS.find((b) => b.id === LAKEVIEW_HOTEL)!.minimumReputation, current: sim.state.family.reputation }),
  },

  // --- Kessler's: offers known from a visit (gate 1 resolves them through the record).
  {
    name: "ACCEPT_CONTRACT, a known offer, from home",
    station: "kesslerKnownHome",
    command: (sim) => ({ type: "ACCEPT_CONTRACT", contractOfferId: knownOfferIds(sim, KESSLER_PHARMACY)[0]! }),
    ...notPresent(KESSLER_PHARMACY, HOLLOW_CREEK),
  },
  {
    name: "ACCEPT_CONTRACT, a known offer, at Kessler's after hours (PLACE_CLOSED, not OFFER_UNAVAILABLE)",
    station: "kesslerClosed",
    command: (sim) => ({ type: "ACCEPT_CONTRACT", contractOfferId: knownOfferIds(sim, KESSLER_PHARMACY)[0]! }),
    ...closedAt(KESSLER_PHARMACY),
  },
  { name: "AGREE_DEAL at Kessler's after hours", station: "kesslerClosed", command: agreeWith(KESSLERS_BACK_ROOM), ...closedAt(KESSLER_PHARMACY) },
  { name: "SET_WORKFORCE from Kessler's after hours", station: "kesslerClosed", command: () => workforce(2), ...notPresent(HOLLOW_CREEK, KESSLER_PHARMACY) },
  {
    name: "ACCEPT_CONTRACT, a known offer, at the open pharmacy",
    station: "kesslerKnown",
    command: (sim) => ({ type: "ACCEPT_CONTRACT", contractOfferId: knownOfferIds(sim, KESSLER_PHARMACY)[0]! }),
    ...applied,
  },

  // --- A held deal, at home with stock.
  { name: "DISPATCH_DELIVERY of the deal", station: "dealHome", command: dispatchDeal(STATE_HIGHWAY), ...applied },
  {
    name: "DISPATCH_DELIVERY, cargo not as agreed",
    station: "dealHome",
    command: dispatchDeal(STATE_HIGHWAY, -1),
    expect: ["CARGO_DOES_NOT_MATCH_DEAL"],
    reason: (sim) => ({ code: "CARGO_DOES_NOT_MATCH_DEAL", dealId: heldDealOf(sim).id }),
  },
  {
    name: "DISPATCH_DELIVERY, a deal the founder doesn't hold",
    station: "dealHome",
    command: (sim) => ({ ...dispatchDeal(STATE_HIGHWAY)(sim), purpose: { kind: "SALE", buyerId: CROSSROADS_ROADHOUSE, dealId: BOGUS.deal } }),
    ...exactly(() => ({ code: "DEAL_UNAVAILABLE", dealId: BOGUS.deal })),
  },
  { name: "DISPATCH_DELIVERY by a road that doesn't go there", station: "dealHome", command: dispatchDeal(COUNTY_ROAD), ...exactly(() => ({ code: "NO_ROUTE", vehicleId: TRUCK })) },
  { name: "DISPATCH_DELIVERY over the truck's capacity", station: "dealHome", command: dispatchDeal(STATE_HIGHWAY, TRUCK_CAPACITY), ...oneOf("VEHICLE_CAPACITY_EXCEEDED", "CARGO_DOES_NOT_MATCH_DEAL") },
  {
    name: "REPEAT_OPERATION of a TRAVEL",
    station: "dealHome",
    command: (sim) => ({ type: "REPEAT_OPERATION", sourceCommandId: lastLogged(sim, "TRAVEL") }),
    expect: ["NOT_REPEATABLE"],
    reason: (sim) => ({ code: "NOT_REPEATABLE", sourceCommandId: lastLogged(sim, "TRAVEL") }),
  },
  {
    name: "REPEAT_OPERATION of a purchase, from home",
    station: "dealHome",
    command: (sim) => ({ type: "REPEAT_OPERATION", sourceCommandId: lastLogged(sim, "PURCHASE_MATERIALS") }),
    ...notPresent(MILLERS_FEED_LOCATION, HOLLOW_CREEK),
  },
  {
    name: "DISPATCH_DELIVERY on a road closed in the live view",
    station: "dealHomeClosed",
    command: dispatchDeal(STATE_HIGHWAY),
    expect: ["ROUTE_CLOSED"],
    reason: (sim) => ({ code: "ROUTE_CLOSED", routeId: STATE_HIGHWAY, reopensAt: sim.state.routes.find((r) => r.id === STATE_HIGHWAY)!.closure!.reopensAt }),
  },
  {
    name: "DISPATCH_DELIVERY of a deal with no stock",
    station: "dealNoStock",
    command: dispatchDeal(STATE_HIGHWAY),
    expect: ["INSUFFICIENT_STOCK"],
    reason: (sim) => {
      const deal = heldDealOf(sim);
      return { code: "INSUFFICIENT_STOCK", productId: deal.productId, quality: deal.quality, requested: deal.quantity, available: 0 };
    },
  },

  // --- An accepted contract, at home.
  { name: "DISPATCH_DELIVERY of an installment", station: "contractedHome", command: installment(1), ...applied },
  {
    name: "DISPATCH_DELIVERY, an installment of the wrong product",
    station: "contractedHome",
    command: installment(1, WHISKEY),
    expect: ["CARGO_DOES_NOT_MATCH_CONTRACT"],
    reason: (sim) => ({ code: "CARGO_DOES_NOT_MATCH_CONTRACT", contractId: sim.state.contracts[0]!.id }),
  },
  {
    name: "DISPATCH_DELIVERY, an installment for a contract the founder doesn't have",
    station: "contractedHome",
    command: (sim) => ({ ...installment(1)(sim), purpose: { kind: "CONTRACT_INSTALLMENT", contractId: BOGUS.contract } }),
    ...oneOf("CONTRACT_NOT_ACTIVE", "UNKNOWN_ENTITY"),
  },

  // --- A batch running at home.
  { name: "START_PRODUCTION while a batch runs", station: "jobRunning", command: () => startBatch(), ...code("PRODUCTION_CAPACITY_EXCEEDED") },

  // --- Riding a delivery: commands need PRESENT.
  { name: "PURCHASE_MATERIALS while riding", station: "riding", command: () => purchase(), ...notPresent(MILLERS_FEED_LOCATION, null) },
  { name: "SET_WORKFORCE while riding", station: "riding", command: () => workforce(2), ...notPresent(HOLLOW_CREEK, null) },
  { name: "TRAVEL while riding", station: "riding", command: () => walk(HOLLOW_CREEK), ...exactly(() => ({ code: "FOUNDER_AWAY", whereabouts: "ON_DELIVERY" })) },
  { name: "REST while riding", station: "riding", command: restValid, ...exactly(() => ({ code: "FOUNDER_AWAY", whereabouts: "ON_DELIVERY" })) },
  { name: "DISPATCH_DELIVERY while riding", station: "riding", command: () => onSpec(1), ...oneOf("NOT_PRESENT", "NO_DRIVER", "VEHICLE_NOT_AT", "INVALID_QUANTITY") },
];

/**
 * Where each code is covered (exhaustive over RejectionCode, so a new code
 * fails tsc here). `cases`: a case in CASES pins exactly this code in S₁, and
 * its twins agree. `differential`: not pinned (the ADR leaves an order open,
 * or the First Shipment doesn't reach it cheaply), but checked by the probe
 * battery and the property whenever it arises. `never`: must not be returned
 * with founder rules on (checked on every verdict).
 */
type Coverage = { readonly by: "cases" } | { readonly by: "differential"; readonly why: string } | { readonly by: "never"; readonly why: string };

const COVERAGE: Readonly<Record<RejectionCode, Coverage>> = {
  INVALID_QUANTITY: { by: "cases" },
  SCHEDULED_IN_PAST: { by: "differential", why: "the kernel's scheduling check, before any validator; the focused example below runs it in both worlds" },
  UNKNOWN_ENTITY: { by: "cases" },
  LOCKED: { by: "cases" },
  REPUTATION_TOO_LOW: { by: "cases" },
  INSUFFICIENT_FUNDS: { by: "differential", why: "cash is always known, and the First Shipment's opening cash covers every price a present founder can reach" },
  SUPPLIER_STOCK_LOW: { by: "cases" },
  MATERIAL_NOT_SOLD: { by: "differential", why: "the feed store sells every material; only a bogus material reaches it, and the ADR doesn't say whether that's UNKNOWN_ENTITY" },
  INSUFFICIENT_MATERIALS: { by: "cases" },
  RECIPE_NOT_SUPPORTED: { by: "cases" },
  PRODUCTION_CAPACITY_EXCEEDED: { by: "cases" },
  STORAGE_CAPACITY_EXCEEDED: { by: "differential", why: "the distillery's storage exceeds the still's largest safe batch in the First Shipment" },
  WORKFORCE_LIMIT_EXCEEDED: { by: "cases" },
  NO_EQUIPMENT_SLOT: { by: "differential", why: "needs a tier the First Shipment's start hasn't unlocked" },
  EQUIPMENT_ALREADY_OWNED: { by: "cases" },
  EQUIPMENT_NOT_OWNED: { by: "cases" },
  INSUFFICIENT_STOCK: { by: "cases" },
  RESERVATION_NOT_ACTIVE: { by: "cases" },
  VEHICLE_UNAVAILABLE: { by: "never", why: "flag-off only (decision 9); the flag-off section checks it still arises there" },
  VEHICLE_CAPACITY_EXCEEDED: { by: "differential", why: "its order against CARGO_DOES_NOT_MATCH_DEAL and the installment cap is open; the over-capacity case accepts either" },
  NO_ROUTE: { by: "cases" },
  ROUTE_CLOSED: { by: "cases" },
  QUOTE_CHANGED: { by: "cases" },
  BUYER_WILL_TAKE_LESS: { by: "cases" },
  PRODUCT_NOT_WANTED: { by: "cases" },
  DEAL_UNAVAILABLE: { by: "cases" },
  CARGO_DOES_NOT_MATCH_DEAL: { by: "cases" },
  OFFER_UNAVAILABLE: { by: "cases" },
  CONTRACT_NOT_ACTIVE: { by: "differential", why: "known progress never shows a closed contract in reach; the installment example checks the world's closed contract isn't read" },
  CARGO_DOES_NOT_MATCH_CONTRACT: { by: "cases" },
  NOT_REPEATABLE: { by: "cases" },
  NOT_PRESENT: { by: "cases" },
  FOUNDER_BUSY: { by: "cases" },
  PLACE_CLOSED: { by: "cases" },
  VEHICLE_NOT_AT: { by: "cases" },
  NO_DRIVER: { by: "cases" },
  NO_WAY_TO_REACH: { by: "never", why: "no phones or employees in M002 yet: the communication gate is always in person (decision 4)" },
  FOUNDER_AWAY: { by: "cases" },
  ALREADY_THERE: { by: "cases" },
  INVALID_PATH: { by: "cases" },
  NO_PATH: { by: "differential", why: "needs every road to a place known closed" },
  INVALID_REST_LENGTH: { by: "cases" },
  NOT_RESTING: { by: "cases" },
  // PH1's five codes (ADR 0027 decision 16). C1 (#179) pins them once the phone handlers stop being no-ops.
  NO_PHONE_HERE: { by: "never", why: "PH1's handlers are no-ops; C1 (#179) pins it" },
  NO_PHONE_THERE: { by: "never", why: "PH1's handlers are no-ops; C1 (#179) pins it" },
  PHONE_ALREADY_INSTALLED: { by: "never", why: "PH1's handlers are no-ops; C1 (#179) pins it" },
  PHONE_USE_NOT_GRANTED: { by: "never", why: "PH1's handlers are no-ops; C1 (#179) pins it" },
  NO_ROOMS_HERE: { by: "never", why: "PH1's handlers are no-ops; C1 (#179) pins it" },
};

describe("decision 9: per RejectionCode, the verdict reads only the founder's view", () => {
  it("every code is accounted for; each `cases` code is pinned by a case, and each `never` code is in the never set", () => {
    for (const [c, coverage] of Object.entries(COVERAGE) as [RejectionCode, Coverage][]) {
      const pinning = CASES.filter((k) => k.expect !== "APPLIED" && k.expect.length === 1 && k.expect[0] === c);
      if (coverage.by === "cases") expect(pinning.map((k) => k.name), `${c} is marked as covered by a case, but no case pins it`).not.toEqual([]);
      expect(NEVER_UNDER_FOUNDER_RULES.has(c), `${c}: the never set and COVERAGE disagree`).toBe(coverage.by === "never");
    }
  });

  it.each(CASES.map((k) => [k.name, k] as const))("%s", { timeout: 60_000 }, (_name, k) => {
    const sim = station(k.station);
    const command = k.command(sim);
    const verdict = expectSameVerdict(sim, fixedTwins(sim), command, k.name);
    if (k.expect === "APPLIED") {
      expect(verdict, `${k.name}: S₁`).toEqual({ status: "applied" });
      return;
    }
    if (verdict.status !== "rejected") throw new Error(`${k.name}: expected one of ${k.expect.join(", ")}, got applied`);
    expect(k.expect, `${k.name}: S₁'s code`).toContain(verdict.reason.code);
    if (k.reason) expect(verdict.reason, `${k.name}: S₁'s payload`).toEqual(k.reason(sim));
    if (k.partial) expect(verdict.reason, `${k.name}: S₁'s payload`).toMatchObject(k.partial(sim));
  });

  it.each(STATIONS.map((s) => [s] as const))("the probe battery at %s: every probe, in S₁ and its twins", { timeout: 120_000 }, (name) => {
    const sim = station(name);
    const twins = fixedTwins(sim);
    for (const command of probeCatalog(sim.state)) expectSameVerdict(sim, twins, command, `${name}: ${JSON.stringify(command)}`);
  });

  it("SCHEDULED_IN_PAST is the kernel's, and the same in both worlds", { timeout: 60_000 }, () => {
    for (const name of ["home", "travelling", "riding"] as const) {
      const sim = station(name);
      const request = { command: { type: "WAKE" } as GameCommand, scheduledTick: sim.state.tick };
      const r1 = withState(sim, sim.state).dispatch(request);
      expect(r1.status === "rejected" ? r1.reason : null, name).toEqual({ code: "SCHEDULED_IN_PAST", scheduledTick: sim.state.tick, currentTick: sim.state.tick });
      for (const twin of fixedTwins(sim)) {
        const r2 = twin.sim.dispatch(request);
        expect(canonicalTree(r2.status === "rejected" ? r2.reason : r2), `${name}: ${twin.what}`).toEqual(canonicalTree(r1.status === "rejected" ? r1.reason : r1));
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Focused examples
// ---------------------------------------------------------------------------

describe("decision 3: the presence table, focused", () => {
  it("an instant command at the same place is allowed while busy; a timed one waits", { timeout: 60_000 }, () => {
    const sim = station("contractedHome");
    expectApplied(sim.dispatch({ command: startBatch(SPARE_CASES) }), "start a batch (setting up keeps the founder busy)");
    const until = busyUntil(sim);
    const reservation = sim.state.reservations.find((r) => r.facilityId === DISTILLERY_MAIN && r.holder.kind === "CONTRACT");
    if (!reservation) throw new Error("Construction: the contract reserved stock at the distillery (ADR 0018 decision 4)");
    const twins = fixedTwins(sim);
    expect(expectSameVerdict(sim, twins, { type: "RELEASE_RESERVATION", facilityId: DISTILLERY_MAIN, reservationId: reservation.id }, "release while busy")).toEqual({
      status: "applied",
    });
    // The same crew again: valid in itself (not below the running batch's crew), but it's a timed activity.
    const crew = sim.state.facilities.find((f) => f.id === DISTILLERY_MAIN)!.workerCount;
    expect(expectSameVerdict(sim, twins, workforce(crew), "a timed command while busy")).toEqual({ status: "rejected", reason: { code: "FOUNDER_BUSY", until } });
  });
});

describe("decision 6: AGREE_DEAL in person, against the live view", () => {
  it("the buyer's own world values decide it (they're in the live view), and nothing elsewhere does", { timeout: 60_000 }, () => {
    const sim = station("crossroads");
    const acceptable = acceptableAt(sim.state, CROSSROADS_ROADHOUSE);
    expect(acceptable, "construction: the roadhouse will take something today").toBeGreaterThan(0);
    const command = agreeWith(CROSSROADS_ROADHOUSE, acceptable)(sim);
    // Everything hidden perturbed: the same.
    expect(expectSameVerdict(sim, fixedTwins(sim), command, "AGREE_DEAL at the limit")).toEqual({ status: "applied" });
    // Control: the roadhouse itself broke. It's in the live view, so the verdict follows the world there.
    const broke = withState(sim, {
      ...sim.state,
      buyers: sim.state.buyers.map((b) => (b.id === CROSSROADS_ROADHOUSE ? { ...b, budgetRemaining: cents(0) } : b)),
    });
    expect(judge(broke, command)).toEqual({
      status: "rejected",
      reason: { code: "BUYER_WILL_TAKE_LESS", buyerId: CROSSROADS_ROADHOUSE, requested: acceptable, acceptable: 0 },
    });
    // Control: a new quote there is QUOTE_CHANGED with the live quote.
    const repriced = withState(sim, {
      ...sim.state,
      buyers: sim.state.buyers.map((b) =>
        b.id === CROSSROADS_ROADHOUSE ? { ...b, wants: b.wants.map((w) => ({ ...w, unitPrice: cents(w.unitPrice + 7) })) } : b,
      ),
    });
    expect(judge(repriced, command)).toEqual({
      status: "rejected",
      reason: { code: "QUOTE_CHANGED", buyerId: CROSSROADS_ROADHOUSE, agreed: command.agreedUnitPrice, current: cents(command.agreedUnitPrice + 7) },
    });
  });
});

describe("decision 6: installment checks run on known CONTRACT_PROGRESS", () => {
  it("a contract whose world progress moved on while the founder was away gets the same verdicts", { timeout: 120_000 }, () => {
    const sim = station("contractedHome");
    const contract = sim.state.contracts[0]!;
    expect(presentAt(sim.state, HOLLOW_CREEK), "construction: away from the buyer, so CONTRACT_PROGRESS isn't live").toBe(true);
    const withContract = (c: typeof contract, what: string): Twin => ({
      sim: withState(sim, { ...sim.state, contracts: sim.state.contracts.map((x) => (x.id === c.id ? c : x)) }),
      ids: IDENTITY_IDS,
      what,
    });
    const twins: readonly Twin[] = [
      withContract(
        { ...contract, status: "COMPLETED", installments: contract.installments.map((i) => ({ ...i, delivered: i.required, outcome: "FULFILLED" as const, penalty: null })) },
        "the contract completed in the world",
      ),
      withContract({ ...contract, installments: contract.installments.map((i, n) => (n === 0 ? { ...i, delivered: i.required } : i)) }, "the first installment filled in the world"),
      withContract({ ...contract, installments: contract.installments.map((i) => ({ ...i, delivered: i.required })) }, "every installment filled in the world"),
      ...fixedTwins(sim),
    ];
    for (const quantity of [1, 2, STOCKED_CASES, STOCKED_CASES + 1, TRUCK_CAPACITY, TRUCK_CAPACITY + 1]) {
      for (const routeId of [KESSLER_BACK_ROAD, COUNTY_ROAD, STATE_HIGHWAY]) {
        expectSameVerdict(sim, twins, installment(quantity, MOONSHINE, routeId)(sim), `installment of ${quantity} by ${routeId}`);
      }
    }
    // Known ACTIVE with room: the order is applied, whatever the world says (the outcome comes on arrival).
    expect(judge(twins[0]!.sim, installment(1)(sim))).toEqual({ status: "applied" });
  });
});

/** Moonshine cases at the distillery, reserved or not. */
const moonshineAtHome = (s: GameState): number =>
  s.productPools.filter((p) => p.facilityId === DISTILLERY_MAIN && p.productId === MOONSHINE).reduce((n, p) => n + p.quantity, 0);

describe("decision 6: ROUTE_CLOSED only from the live view or a known closure; ROUTE_FOUND_CLOSED otherwise", () => {
  it("off the live view: a known closure is ROUTE_CLOSED with the record's reopensAt; an unknown one isn't rejected", { timeout: 60_000 }, () => {
    let sim = station("home");
    sim = closeRoute(sim, COUNTY_ROAD, sim.state.tick + 1, 2 * TICKS_PER_DAY);
    sim.advance(2); // closed, and seen from Hollow Creek (its live view), so recorded
    const record = sim.state.knowledge.records.find((r) => r.subject.kind === "ROUTE_CONDITION" && r.subject.routeId === COUNTY_ROAD);
    if (!record || record.value.kind !== "ROUTE_CONDITION" || record.value.status.open) throw new Error("Construction: the founder knows the county road is closed");
    const knownReopensAt = record.value.status.reopensAt;
    expectApplied(
      sim.dispatch({ command: { type: "TRAVEL", destinationLocationId: CROSSROADS, transport: { kind: "VEHICLE", vehicleId: TRUCK }, via: [{ routeId: STATE_HIGHWAY, reversed: false }] } }),
      "drive to the Crossroads",
    );
    advanceUntil(sim, (s) => presentAt(s, CROSSROADS) && isFree(s), TICKS_PER_DAY, "the founder arrives at the Crossroads");
    expect(LIVE_VIEW_ROUTES.find((e) => e.locationId === CROSSROADS)!.routeIds, "construction: the county road isn't in the Crossroads' live view").not.toContain(COUNTY_ROAD);
    expect(sim.state.vehicles.find((v) => v.id === TRUCK)!.parkedAt, "construction: the truck is parked here").toBe(CROSSROADS);

    const via = (second: RouteId): GameCommand => ({
      type: "TRAVEL",
      destinationLocationId: KESSLER_PHARMACY,
      transport: { kind: "VEHICLE", vehicleId: TRUCK },
      via: [
        { routeId: STATE_HIGHWAY, reversed: true },
        { routeId: second, reversed: false },
      ],
    });
    const worldRoutes = (f: (r: GameState["routes"][number]) => GameState["routes"][number], routeId: RouteId, what: string): Twin => ({
      sim: withState(sim, {
        ...sim.state,
        routes: sim.state.routes.map((r) => (r.id === routeId ? f(r) : r)),
        scheduledEvents: sim.state.scheduledEvents.filter((e) => !(e.kind === "ROUTE_REOPENING" && e.routeId === routeId)),
      }),
      ids: IDENTITY_IDS,
      what,
    });
    const known = expectSameVerdict(
      sim,
      [
        worldRoutes((r) => ({ ...r, closure: null }), COUNTY_ROAD, "the county road reopened unseen"),
        worldRoutes((r) => ({ ...r, closure: { reason: "RIVAL", reopensAt: null } }), COUNTY_ROAD, "the closure changed unseen"),
        ...fixedTwins(sim),
      ],
      via(COUNTY_ROAD),
      "TRAVEL through a road known closed",
    );
    expect(known).toEqual({ status: "rejected", reason: { code: "ROUTE_CLOSED", routeId: COUNTY_ROAD, reopensAt: knownReopensAt } });

    const unknown = expectSameVerdict(
      sim,
      [worldRoutes((r) => ({ ...r, closure: { reason: "POLICE", reopensAt: null } }), KESSLER_BACK_ROAD, "the back road closed unseen")],
      via(KESSLER_BACK_ROAD),
      "TRAVEL through a road closed only in the world",
    );
    expect(unknown, "a closure the founder can't see is found on the road, not refused").toEqual({ status: "applied" });
  });

  it("a road that closes while the truck is loaded: ROUTE_FOUND_CLOSED at departure, and nothing leaves", { timeout: 60_000 }, () => {
    const base = station("dealHome");
    const deal = heldDealOf(base);
    const stockBefore = moonshineAtHome(base.state);
    expectApplied(base.dispatch({ command: dispatchDeal(STATE_HIGHWAY)(base) }), "dispatch the deal, the founder driving");
    const departure = busyUntil(base);
    const trip = base.state.vehicles.find((v) => v.id === TRUCK)!.trip;
    if (!trip) throw new Error("Construction: the truck has its trip while loading");
    const sim = closeRoute(base, STATE_HIGHWAY, base.state.tick + 5, 2 * TICKS_PER_DAY);
    expect(base.state.tick + 5, "construction: the road closes during loading").toBeLessThan(departure);
    sim.takeEvents();
    advanceUntil(sim, (s) => s.tick > departure, TICKS_PER_DAY, "loading ends");
    const found = sim.takeEvents().filter((e) => e.type === "ROUTE_FOUND_CLOSED");
    expect(found).toEqual([expect.objectContaining({ type: "ROUTE_FOUND_CLOSED", deliveryId: trip.deliveryId, routeId: STATE_HIGHWAY })]);
    expect(sim.state.founder.whereabouts, "the founder stays present at home").toMatchObject({ kind: "PRESENT", locationId: HOLLOW_CREEK, busy: null });
    const truck = sim.state.vehicles.find((v) => v.id === TRUCK)!;
    expect({ parkedAt: truck.parkedAt, trip: truck.trip }, "the truck doesn't leave").toEqual({ parkedAt: HOLLOW_CREEK, trip: null });
    expect(moonshineAtHome(sim.state), "the cargo is unloaded back into the facility").toBe(stockBefore);
    expect(sim.state.heldDeals.find((d) => d.id === deal.id)?.status, "the deal returns to HELD").toBe("HELD");
  });
});

// ---------------------------------------------------------------------------
// 4 (continued). The property over random plays
// ---------------------------------------------------------------------------

const LOCATION_IDS = LOCATIONS.map((l) => l.id);
const BUYER_IDS = BUYERS.map((b) => b.id);
const ROUTE_IDS = ROUTES.map((r) => r.id);

type Action =
  | { readonly kind: "advance"; readonly ticks: number }
  | { readonly kind: "travel"; readonly destination: LocationId; readonly byTruck: boolean; readonly arrive: boolean }
  | { readonly kind: "buy"; readonly material: "corn" | "sugar"; readonly quantity: number }
  | { readonly kind: "batch"; readonly quantity: number }
  | { readonly kind: "agree"; readonly buyerId: BuyerId; readonly quantity: number }
  | { readonly kind: "accept"; readonly pick: number }
  | { readonly kind: "dispatch"; readonly pick: number; readonly routeId: RouteId | null; readonly contract: boolean; readonly ride: boolean }
  | { readonly kind: "rest"; readonly length: number }
  | { readonly kind: "settle" };

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  { weight: 3, arbitrary: fc.integer({ min: 0, max: 90 }).map((ticks) => ({ kind: "advance", ticks }) as const) },
  { weight: 1, arbitrary: fc.integer({ min: 0, max: TICKS_PER_DAY }).map((ticks) => ({ kind: "advance", ticks }) as const) },
  { weight: 4, arbitrary: fc.record({ destination: fc.constantFrom(...LOCATION_IDS), byTruck: fc.boolean(), arrive: fc.boolean() }).map((a) => ({ kind: "travel", ...a }) as const) },
  {
    weight: 1,
    arbitrary: fc.record({ material: fc.constantFrom("corn" as const, "sugar" as const), quantity: fc.integer({ min: 1, max: 8 }) }).map((a) => ({ kind: "buy", ...a }) as const),
  },
  { weight: 1, arbitrary: fc.integer({ min: 1, max: 3 }).map((quantity) => ({ kind: "batch", quantity }) as const) },
  { weight: 2, arbitrary: fc.record({ buyerId: fc.constantFrom(...BUYER_IDS), quantity: fc.integer({ min: 1, max: 2 }) }).map((a) => ({ kind: "agree", ...a }) as const) },
  { weight: 1, arbitrary: fc.nat().map((pick) => ({ kind: "accept", pick }) as const) },
  {
    weight: 2,
    arbitrary: fc
      .record({ pick: fc.nat(), routeId: fc.option(fc.constantFrom(...ROUTE_IDS), { nil: null }), contract: fc.boolean(), ride: fc.boolean() })
      .map((a) => ({ kind: "dispatch", ...a }) as const),
  },
  { weight: 1, arbitrary: fc.integer({ min: MIN_REST_TICKS, max: MAX_REST_TICKS }).map((length) => ({ kind: "rest", length }) as const) },
  { weight: 1, arbitrary: fc.constant({ kind: "settle" } as const) },
);

/** Applies one action as the player would (eagerly; nothing is queued). Rejections are fine: the player tried. */
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
        command: { type: "TRAVEL", destinationLocationId: action.destination, transport: action.byTruck ? { kind: "VEHICLE", vehicleId: TRUCK } : { kind: "FOOT" }, via: null },
      });
      if (result.status === "applied" && action.arrive) {
        for (let i = 0; i < 2 * TICKS_PER_DAY && !presentAt(sim.state, action.destination); i++) sim.advance(1);
      }
      return;
    }
    case "buy":
      sim.dispatch({ command: purchase(action.material === "corn" ? CORN : SUGAR, action.quantity) });
      return;
    case "batch":
      sim.dispatch({ command: startBatch(action.quantity) });
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
      const active = s.contracts.filter((c) => c.status === "ACTIVE");
      const contract = active[action.pick % Math.max(1, active.length)];
      const held = s.heldDeals.filter((d) => d.status === "HELD");
      const deal = held[action.pick % Math.max(1, held.length)];
      if (action.contract && contract) {
        sim.dispatch({
          command: {
            type: "DISPATCH_DELIVERY",
            vehicleId: TRUCK,
            cargo: [{ productId: contract.productId, quality: "basic", quantity: Math.min(STOCKED_CASES, contract.quantityPerInstallment) }],
            purpose: { kind: "CONTRACT_INSTALLMENT", contractId: contract.id },
            routeId: action.routeId ?? (buyerLocation(contract.buyerId) === KESSLER_PHARMACY ? KESSLER_BACK_ROAD : LAKEVIEW_BACK_ROAD),
            driver: { kind: "FOUNDER" },
          },
        });
      } else if (deal) {
        sim.dispatch({
          command: {
            type: "DISPATCH_DELIVERY",
            vehicleId: TRUCK,
            cargo: [{ productId: deal.productId, quality: deal.quality, quantity: deal.quantity }],
            purpose: { kind: "SALE", buyerId: deal.buyerId, dealId: deal.id },
            routeId: action.routeId ?? CROSSROADS_BACK_ROAD,
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
  }
}

const startStationArb: fc.Arbitrary<Station> = fc.constantFrom("resting", "home", "stockedHome", "dealHome", "contractedHome", "kesslerKnown");

describe("decision 9: the property over random plays", () => {
  it("at every state along a play, random probes get the same verdict in S₁ and a perturbed, renamed twin", { timeout: 60_000 }, () => {
    let probes = 0;
    fc.assert(
      fc.property(startStationArb, fc.array(actionArb, { maxLength: 10 }), hiddenPlanArb, fc.array(fc.nat(), { minLength: 4, maxLength: 4 }), (start, actions, plan, picks) => {
        const sim = station(start);
        for (const action of [null, ...actions]) {
          if (action) act(sim, action);
          if (sim.state.queuedCommands.length !== 0) continue;
          const twin = twinOf(sim, plan, "a random hidden plan");
          const catalog = probeCatalog(sim.state);
          for (const pick of picks) {
            const command = catalog[pick % catalog.length]!;
            expectSameVerdict(sim, [twin], command, `tick ${sim.state.tick}, founder ${JSON.stringify(sim.state.founder.whereabouts)}, after ${JSON.stringify(action)}: ${JSON.stringify(command)}`);
            probes++;
          }
        }
      }),
      { seed: 22_200, numRuns: 200, endOnFailure: true },
    );
    expect(probes).toBeGreaterThan(800);
  });
});

// ---------------------------------------------------------------------------
// 6. Flag off: one validation path, M001's behaviour
// ---------------------------------------------------------------------------

describe("founderRules off: PlayerView is the whole world, and the validators are M001's", () => {
  function m001WithTruckOut(): KernelSimulation {
    const sim = newGame({ scenario: M001_SCENARIO });
    for (const [materialId, quantity] of [
      [CORN, 2],
      [SUGAR, 1],
    ] as const) {
      expectApplied(sim.dispatch({ command: purchase(materialId, quantity) }), `buy ${materialId}`);
    }
    expectApplied(sim.dispatch({ command: startBatch(1) }), "start a batch");
    advanceUntil(sim, (s) => s.productionJobs.length === 0, 2 * TICKS_PER_DAY, "the batch completes");
    expectApplied(agreeAtQuote(sim, CROSSROADS_ROADHOUSE, 1), "agree a deal");
    expectApplied(sim.dispatch({ command: dispatchDeal(STATE_HIGHWAY)(sim) }), "dispatch it");
    return sim;
  }

  it("the tie holds for every probe: the immediate result is the view validator's verdict", { timeout: 120_000 }, () => {
    const fresh = newGame({ scenario: M001_SCENARIO });
    for (const command of probeCatalog(fresh.state, RULES_OFF)) judge(fresh, command, RULES_OFF);
    const out = m001WithTruckOut();
    for (const command of probeCatalog(out.state, RULES_OFF)) judge(out, command, RULES_OFF);
  });

  it("no presence gate; VEHICLE_UNAVAILABLE stays; TRAVEL, REST and WAKE are accepted and change nothing", { timeout: 60_000 }, () => {
    const sim = newGame({ scenario: M001_SCENARIO });
    expect(sim.state.founder.whereabouts, "construction: M001's founder is simply at home").toMatchObject({ kind: "PRESENT", locationId: HOLLOW_CREEK });
    // Buying at the feed store and agreeing at the Crossroads from Hollow Creek: the whole world is the live view.
    expect(judge(sim, purchase(), RULES_OFF)).toEqual({ status: "applied" });
    expect(judge(sim, agreeWith(CROSSROADS_ROADHOUSE)(sim), RULES_OFF)).toEqual({ status: "applied" });
    for (const command of [walk(CROSSROADS), restValid(sim), { type: "WAKE" } as GameCommand]) {
      expect(judge(sim, command, RULES_OFF), JSON.stringify(command)).toEqual({ status: "applied" });
      const copy = withState(sim, sim.state, RULES_OFF);
      copy.dispatch({ command });
      expect(copy.state.founder, `${command.type} changes no founder state with the flag off`).toEqual(sim.state.founder);
    }
    const out = m001WithTruckOut();
    const again: GameCommand = {
      type: "DISPATCH_DELIVERY",
      vehicleId: TRUCK,
      cargo: [{ productId: MOONSHINE, quality: "basic", quantity: 1 }],
      purpose: { kind: "SALE", buyerId: CROSSROADS_ROADHOUSE, dealId: BOGUS.deal },
      routeId: null,
      driver: { kind: "FOUNDER" },
    };
    expect(judge(out, again, RULES_OFF)).toEqual({ status: "rejected", reason: { code: "VEHICLE_UNAVAILABLE", vehicleId: TRUCK } });
  });
});
