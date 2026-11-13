// The founder (ADR 0023): TRAVEL, REST and WAKE, the busy gate, and the founder
// phase.
//
// With `founderRules: false` (M001, the lab) the three commands apply as no-ops
// (decision 9): accepted, no domain state changes, no transaction, no event.
// Like any applied command, the kernel still appends the envelope to
// `commandLog`, so `stateHash` moves. Nothing else is registered: no busy gate
// and no founder-phase hook, so the founder state never changes.
//
// With `founderRules: true`:
// - TRAVEL (decision 3) checks decision 3a's reasons in its gate order, then
//   sets out on the given simple path or the default one. By vehicle, the truck
//   is no longer parked (`parkedAt: null`).
// - REST (decision 7) starts RESTING where the founder is until `untilTick`.
// - WAKE ends a rest early and applies the recovery for what was rested.
// - Timed commands (decision 4) pass the busy gate and the party's hours, and
//   make the founder busy (activities.ts).
// - The founder phase (decision 2a), in order: busy ends (a finished
//   LOAD_TRUCK is the truck's departure), travel legs (the next leg, a halt at a
//   closure, or the arrival), delivery stops and the return, and waking.
// The knowledge side of every departure, arrival and waking is SK1b's: see the
// named hook points in hooks.ts.

import {
  addTicks,
  type DeliveryState,
  type FounderState,
  type FounderWhereabouts,
  type GameEventInput,
  type GameState,
  type LocationId,
  type RejectionReason,
  type RestCommand,
  type RouteLeg,
  type Tick,
  type TransactionCoordinator,
  type TravelCommand,
  type VehicleId,
  type WakeCommand,
} from "@eov/contracts";
import { MAX_REST_TICKS, MIN_REST_TICKS, type GameData } from "@eov/game-data";
import { emitEvent } from "../events/journal.ts";
import type { CommandContext, CommandOutcome, SystemRegistry, TickContext } from "../kernel/registry.ts";
import type { GameRules } from "../kernel/rules.ts";
import { turnBackAtDeparture } from "../logistics/logistics.ts";
import { playerViewOf, type IssuerView } from "../view/issuer-view.ts";
import { judgeOrder, type OrderValidator } from "../view/order.ts";
import { busyRejection } from "../view/presence.ts";
import { startActivity } from "./activities.ts";
import { founderArrived, founderDeparting, founderSawRoute, founderWoke } from "./hooks.ts";
import { closedInWorld, defaultPath, isSimplePath, knownClosure, legEnds, pathLegTicks } from "./paths.ts";
import { awakeSinceAfterRest } from "./time.ts";

/** The founder's commands (ADR 0023), in GAME_COMMAND_TYPES order. */
export const FOUNDER_COMMAND_TYPES = ["TRAVEL", "REST", "WAKE"] as const;

/** Accepted, and nothing changes (ADR 0023 decision 9, `founderRules: false`). */
function acceptedNoOp(state: GameState): CommandOutcome {
  return { status: "applied", state };
}

const rejected = (reason: RejectionReason): CommandOutcome => ({ status: "rejected", reason });

function withWhereabouts(state: GameState, whereabouts: FounderWhereabouts, awakeSince: Tick = state.founder.awakeSince): GameState {
  const founder: FounderState = { whereabouts, awakeSince };
  return { ...state, founder };
}

function withParkedAt(state: GameState, vehicleId: VehicleId, parkedAt: LocationId | null): GameState {
  return { ...state, vehicles: state.vehicles.map((v) => (v.id === vehicleId ? { ...v, parkedAt } : v)) };
}

function emit(state: GameState, event: GameEventInput, t: Tick, causedBy: CommandContext["envelope"]["id"] | null): GameState {
  return emitEvent(state, event, { tick: t, causedBy }).state;
}

// ---------------------------------------------------------------------------
// TRAVEL (decision 3)
// ---------------------------------------------------------------------------

/** What a valid TRAVEL sets out on: the path, and the truck if the founder drives. */
interface TravelPlan {
  readonly here: LocationId;
  readonly path: readonly RouteLeg[];
}

/**
 * TRAVEL's checks, in decision 3a's order, against the founder's view:
 * 1. shape and identity: UNKNOWN_ENTITY for the destination, a route in `via`,
 *    or the vehicle (owned);
 * 2. presence and busy: FOUNDER_AWAY, FOUNDER_BUSY;
 * 3. validity against what the founder can see: ALREADY_THERE, INVALID_PATH,
 *    VEHICLE_NOT_AT (the truck isn't parked here with no trip), ROUTE_CLOSED (a
 *    leg of `via` known closed), NO_PATH.
 */
function planTravel(view: IssuerView, command: TravelCommand, data: GameData): TravelPlan | RejectionReason {
  const world = view.world;
  const { destinationLocationId: destination, transport, via } = command;
  if (!data.locations.some((l) => l.id === destination)) return { code: "UNKNOWN_ENTITY", kind: "Location", id: destination };
  for (const leg of via ?? []) {
    if (!data.routes.some((r) => r.id === leg.routeId)) return { code: "UNKNOWN_ENTITY", kind: "Route", id: leg.routeId };
  }
  const vehicle = transport.kind === "VEHICLE" ? world.vehicles.find((v) => v.id === transport.vehicleId) : undefined;
  if (transport.kind === "VEHICLE" && !vehicle) return { code: "UNKNOWN_ENTITY", kind: "Vehicle", id: transport.vehicleId };
  const w = world.founder.whereabouts;
  if (w.kind !== "PRESENT") return { code: "FOUNDER_AWAY", whereabouts: w.kind };
  const busy = busyRejection(view);
  if (busy) return busy;
  const here = w.locationId;
  if (destination === here) return { code: "ALREADY_THERE" };
  if (via !== null && !isSimplePath(data, here, destination, via)) return { code: "INVALID_PATH" };
  if (vehicle && (vehicle.trip !== null || vehicle.parkedAt !== here)) return { code: "VEHICLE_NOT_AT", vehicleId: vehicle.id, locationId: here };
  const onFoot = transport.kind === "FOOT";
  if (!onFoot && via !== null) {
    for (const leg of via) {
      const closure = knownClosure(world, leg.routeId);
      if (closure) return { code: "ROUTE_CLOSED", routeId: leg.routeId, reopensAt: closure.reopensAt };
    }
  }
  const path = via ?? defaultPath(world, data, here, destination, onFoot);
  if (path === null) return { code: "NO_PATH", destinationLocationId: destination };
  return { here, path };
}

/** TRAVEL's order validator: decision 3a's checks; with founder rules off, an accepted no-op (decision 9). */
export function travelValidator(data: GameData, rules: GameRules): OrderValidator<"TRAVEL"> {
  return (view, command) => {
    if (!rules.founderRules) return null;
    const plan = planTravel(view, command, data);
    return "code" in plan ? plan : null;
  };
}

function applyTravel(state: GameState, command: TravelCommand, ctx: CommandContext, data: GameData, rules: GameRules): CommandOutcome {
  const t = ctx.tick;
  const plan = planTravel(playerViewOf(state, data, rules, t), command, data);
  if ("code" in plan) return rejected(plan);
  const { here, path } = plan;
  const { destinationLocationId: destination, transport } = command;
  const onFoot = transport.kind === "FOOT";
  const first = path[0]!;
  // Leg by leg: a truck can't enter a route that's actually closed. The first leg
  // starts here, where the founder can see it, so this only happens for a route
  // outside the place's live view: the founder sets out and halts at once.
  if (!onFoot && closedInWorld(state, first.routeId)) {
    let s = emit(state, { type: "FOUNDER_HALTED", routeId: first.routeId, locationId: here }, t, ctx.envelope.id);
    s = founderArrived(s, here, { kind: "HALTED", routeId: first.routeId }, t);
    return { status: "applied", state: s };
  }
  let s = founderDeparting(state, here, "TRAVEL", t);
  if (transport.kind === "VEHICLE") s = withParkedAt(s, transport.vehicleId, null);
  s = withWhereabouts(s, {
    kind: "TRAVELLING",
    transport,
    path,
    legIndex: 0,
    legDepartedAt: t,
    legArrivesAt: addTicks(t, pathLegTicks(data, first, onFoot)),
    destinationLocationId: destination,
  });
  s = emit(s, { type: "FOUNDER_DEPARTED", from: here, to: destination, transport }, t, ctx.envelope.id);
  return { status: "applied", state: s };
}

// ---------------------------------------------------------------------------
// REST and WAKE (decision 7)
// ---------------------------------------------------------------------------

/** REST's checks (decision 3a): INVALID_REST_LENGTH (shape), then FOUNDER_AWAY and FOUNDER_BUSY. */
export function restValidator(rules: GameRules): OrderValidator<"REST"> {
  return (view, command) => {
    if (!rules.founderRules) return null;
    const min = addTicks(view.at, MIN_REST_TICKS);
    const max = addTicks(view.at, MAX_REST_TICKS);
    const until = command.untilTick;
    if (!Number.isSafeInteger(until) || until < min || until > max) return { code: "INVALID_REST_LENGTH", min, max };
    const w = view.world.founder.whereabouts;
    if (w.kind !== "PRESENT") return { code: "FOUNDER_AWAY", whereabouts: w.kind };
    return busyRejection(view);
  };
}

/** WAKE's check (decision 3a): NOT_RESTING. */
export function wakeValidator(rules: GameRules): OrderValidator<"WAKE"> {
  return (view) => (!rules.founderRules || view.world.founder.whereabouts.kind === "RESTING" ? null : { code: "NOT_RESTING" });
}

function applyRest(state: GameState, command: RestCommand, ctx: CommandContext, data: GameData, rules: GameRules): CommandOutcome {
  const t = ctx.tick;
  const rejection = judgeOrder(restValidator(rules), state, data, rules, command, t);
  if (rejection) return rejected(rejection);
  const w = state.founder.whereabouts;
  if (w.kind !== "PRESENT") throw new RangeError("unreachable: the founder is present here");
  const until = command.untilTick;
  let s = founderDeparting(state, w.locationId, "REST", t);
  s = withWhereabouts(s, { kind: "RESTING", locationId: w.locationId, startedAt: t, until });
  s = emit(s, { type: "FOUNDER_RESTED", locationId: w.locationId, until }, t, ctx.envelope.id);
  return { status: "applied", state: s };
}

/** The founder wakes at `t` where they rested (decision 7): PRESENT, not busy, with the recovery for what was rested. */
function wake(state: GameState, t: Tick, early: boolean, causedBy: CommandContext["envelope"]["id"] | null): GameState {
  const w = state.founder.whereabouts;
  if (w.kind !== "RESTING") throw new RangeError("Only a resting founder wakes");
  const awakeSince = awakeSinceAfterRest(state.founder.awakeSince, w.locationId, w.startedAt, t);
  let s = withWhereabouts(state, { kind: "PRESENT", locationId: w.locationId, busy: null }, awakeSince);
  s = emit(s, { type: "FOUNDER_WOKE", locationId: w.locationId, early }, t, causedBy);
  return founderWoke(s, w.locationId, early, t);
}

function applyWake(state: GameState, command: WakeCommand, ctx: CommandContext, data: GameData, rules: GameRules): CommandOutcome {
  const rejection = judgeOrder(wakeValidator(rules), state, data, rules, command, ctx.tick);
  if (rejection) return rejected(rejection);
  return { status: "applied", state: wake(state, ctx.tick, true, ctx.envelope.id) };
}

// ---------------------------------------------------------------------------
// The founder phase (decision 2a)
// ---------------------------------------------------------------------------

/** The delivery the founder is loading: an outbound trip they drive whose truck hasn't left yet. */
function deliveryBeingLoaded(state: GameState): DeliveryState | null {
  for (const vehicle of state.vehicles) {
    if (vehicle.trip?.leg !== "OUTBOUND" || vehicle.parkedAt === null) continue;
    const delivery = state.deliveries.find((d) => d.id === vehicle.trip!.deliveryId);
    if (delivery?.driver?.kind === "FOUNDER") return delivery;
  }
  return null;
}

/**
 * 1. Busy ends. A finished LOAD_TRUCK is the truck's departure, with the founder
 * aboard (decision 5). If the trip's route is closed then (a closure since
 * dispatch, this tick's included), the truck doesn't set out: ADR 0022's
 * ROUTE_FOUND_CLOSED at departure. The cargo goes back into the facility, a
 * sale's deal is HELD again, and the founder stays PRESENT, standing there, so
 * the route's condition is recorded IN_PERSON (decisions 2a and 4).
 */
function endBusy(state: GameState, coordinator: TransactionCoordinator, ctx: TickContext): GameState {
  const w = state.founder.whereabouts;
  if (w.kind !== "PRESENT" || w.busy === null || w.busy.until > ctx.tick) return state;
  const free = withWhereabouts(state, { ...w, busy: null });
  if (w.busy.activity !== "LOAD_TRUCK") return free;
  const delivery = deliveryBeingLoaded(state);
  if (!delivery) return free;
  if (closedInWorld(free, delivery.routeId)) {
    const s = turnBackAtDeparture(free, delivery.id, coordinator, ctx.tick);
    return founderSawRoute(s, w.locationId, delivery.routeId, ctx.tick);
  }
  let s = founderDeparting(free, w.locationId, "DELIVERY", ctx.tick);
  s = withParkedAt(s, delivery.vehicleId, null);
  return withWhereabouts(s, { kind: "ON_DELIVERY", deliveryId: delivery.id, vehicleId: delivery.vehicleId, atStop: null });
}

/** 2. Travel legs: the next leg, a halt where a truck can't go on, or the arrival (decision 3). */
function advanceTravel(state: GameState, data: GameData, ctx: TickContext): GameState {
  const w = state.founder.whereabouts;
  if (w.kind !== "TRAVELLING" || w.legArrivesAt > ctx.tick) return state;
  const at = legEnds(data, w.path[w.legIndex]!).to;
  const vehicleId = w.transport.kind === "VEHICLE" ? w.transport.vehicleId : null;
  const next = w.path[w.legIndex + 1];
  if (next && !(vehicleId !== null && closedInWorld(state, next.routeId))) {
    return withWhereabouts(state, {
      ...w,
      legIndex: w.legIndex + 1,
      legDepartedAt: ctx.tick,
      legArrivesAt: addTicks(ctx.tick, pathLegTicks(data, next, vehicleId === null)),
    });
  }
  let s = withWhereabouts(state, { kind: "PRESENT", locationId: at, busy: null });
  if (vehicleId !== null) s = withParkedAt(s, vehicleId, at);
  if (next) {
    // A vehicle leg that's closed when it should start halts the trip at the junction.
    s = emit(s, { type: "FOUNDER_HALTED", routeId: next.routeId, locationId: at }, ctx.tick, null);
    return founderArrived(s, at, { kind: "HALTED", routeId: next.routeId }, ctx.tick);
  }
  s = emit(s, { type: "FOUNDER_ARRIVED", locationId: at }, ctx.tick, null);
  return founderArrived(s, at, { kind: "DESTINATION" }, ctx.tick);
}

/** 3. Delivery stops: observing at the destination on the outbound leg's resolution tick, and the return (decision 5). */
function followDelivery(state: GameState, data: GameData, ctx: TickContext): GameState {
  const w = state.founder.whereabouts;
  if (w.kind !== "ON_DELIVERY") return state;
  const delivery = state.deliveries.find((d) => d.id === w.deliveryId);
  if (!delivery) throw new RangeError(`The founder is riding unknown delivery ${w.deliveryId}`);
  const trip = state.vehicles.find((v) => v.id === w.vehicleId)?.trip ?? null;
  if (trip === null || trip.deliveryId !== delivery.id) {
    // VEHICLE_RETURNED this tick: the founder steps down where the trip started.
    const origin = data.facilities.find((f) => f.id === delivery.fromFacilityId);
    if (!origin) throw new RangeError(`Delivery ${delivery.id} left from unknown facility ${delivery.fromFacilityId}`);
    const s = withWhereabouts(state, { kind: "PRESENT", locationId: origin.locationId, busy: null });
    return founderArrived(s, origin.locationId, { kind: "RETURNED" }, ctx.tick);
  }
  // The outbound leg resolved at its destination this tick (the truck turned home
  // now), and the cargo wasn't seized: a seizure is the one FAILED outcome that
  // empties the cargo.
  const resolvedHere = trip.leg === "RETURN" && trip.departedAt === ctx.tick;
  const seized = delivery.status === "FAILED" && delivery.cargo.length === 0;
  if (!resolvedHere || seized || w.atStop !== null) return state;
  const route = data.routes.find((r) => r.id === delivery.routeId);
  if (!route) throw new RangeError(`Delivery ${delivery.id} uses unknown route ${delivery.routeId}`);
  const stop = route.toLocationId;
  const s = withWhereabouts(state, { ...w, atStop: { locationId: stop, tick: ctx.tick } });
  return founderArrived(s, stop, { kind: "STOP" }, ctx.tick);
}

/** 4. Waking at the rest's end (decision 7). */
function wakeOnTime(state: GameState, ctx: TickContext): GameState {
  const w = state.founder.whereabouts;
  if (w.kind !== "RESTING" || w.until > ctx.tick) return state;
  return wake(state, ctx.tick, false, null);
}

function founderPhase(state: GameState, data: GameData, coordinator: TransactionCoordinator, ctx: TickContext): GameState {
  let s = endBusy(state, coordinator, ctx);
  s = advanceTravel(s, data, ctx);
  s = followDelivery(s, data, ctx);
  return wakeOnTime(s, ctx);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerFounder(registry: SystemRegistry, data: GameData, coordinator: TransactionCoordinator, rules: GameRules): void {
  if (!rules.founderRules) {
    registry
      .onCommand("TRAVEL", { apply: acceptedNoOp })
      .onCommand("REST", { apply: acceptedNoOp })
      .onCommand("WAKE", { apply: acceptedNoOp });
    return;
  }
  registry
    .onCommand("TRAVEL", { apply: (state, command, ctx) => applyTravel(state, command, ctx, data, rules) })
    .onCommand("REST", { apply: (state, command, ctx) => applyRest(state, command, ctx, data, rules) })
    .onCommand("WAKE", { apply: (state, command, ctx) => applyWake(state, command, ctx, data, rules) })
    // The presence gate (busy and hours included) is part of every command's
    // order validator (ADR 0022 decision 1, `view/presence.ts`), so this gate
    // rejects nothing. It makes the founder busy once a timed command applies.
    .onCommandGate("founder-activities", {
      check: () => null,
      after: (before, after, envelope, ctx) => startActivity(before, after, envelope, ctx.tick),
    })
    .onPhase("founder", "founder-transitions", (state, ctx) => founderPhase(state, data, coordinator, ctx));
}
