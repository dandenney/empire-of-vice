// The founder's road network (ADR 0023 decision 3): every route, in either
// direction. Paths are simple (no location twice), which keeps the no-trap
// bound finite (decision 8).

import { compareIds, type GameState, type LocationId, type RouteId, type RouteLeg, type Tick } from "@eov/contracts";
import type { GameData, RouteDefinition } from "@eov/game-data";
import type { WorldSlice } from "../view/world.ts";
import { legTicks } from "./time.ts";

export interface LegEnds {
  readonly from: LocationId;
  readonly to: LocationId;
}

export function routeOf(data: GameData, routeId: RouteId): RouteDefinition {
  const route = data.routes.find((r) => r.id === routeId);
  if (!route) throw new RangeError(`Unknown route ${routeId}`);
  return route;
}

/** Where a leg starts and ends. */
export function legEnds(data: GameData, leg: RouteLeg): LegEnds {
  const route = routeOf(data, leg.routeId);
  return leg.reversed ? { from: route.toLocationId, to: route.fromLocationId } : { from: route.fromLocationId, to: route.toLocationId };
}

/** A leg's duration on this transport (decision 3). */
export function pathLegTicks(data: GameData, leg: RouteLeg, onFoot: boolean): number {
  return legTicks(routeOf(data, leg.routeId).durationTicks, onFoot);
}

/**
 * True when `via` is a simple path from `from` to `to`: at least one leg,
 * consecutive legs connect, and no location is visited twice (decision 3).
 * Every route in `via` must exist (checked earlier, as UNKNOWN_ENTITY).
 */
export function isSimplePath(data: GameData, from: LocationId, to: LocationId, via: readonly RouteLeg[]): boolean {
  if (via.length === 0) return false;
  const visited = new Set<LocationId>([from]);
  let at = from;
  for (const leg of via) {
    const ends = legEnds(data, leg);
    if (ends.from !== at || visited.has(ends.to)) return false;
    visited.add(ends.to);
    at = ends.to;
  }
  return at === to;
}

// ---------------------------------------------------------------------------
// What the founder knows about closures (ADR 0021 decisions 4 and 5)
// ---------------------------------------------------------------------------

export interface KnownClosure {
  readonly reopensAt: Tick | null;
}

/**
 * Whether the issuer knows `routeId` to be closed, from their view's routes
 * (decision 3: choosing a path leaks nothing). In the founder's view a route in
 * the live view of the place they're at shows its condition now, and any other
 * route its latest known ROUTE_CONDITION record (`view/issuer-view.ts`). Null:
 * not known to be closed.
 */
export function knownClosure(world: Pick<WorldSlice, "routes">, routeId: RouteId): KnownClosure | null {
  const closure = world.routes.find((r) => r.id === routeId)?.closure ?? null;
  return closure ? { reopensAt: closure.reopensAt } : null;
}

/** Whether the route is closed in the world now. Only for a leg starting where the founder stands (decision 3, "leg by leg"). */
export function closedInWorld(state: GameState, routeId: RouteId): boolean {
  return (state.routes.find((r) => r.id === routeId)?.closure ?? null) !== null;
}

// ---------------------------------------------------------------------------
// The default path (decision 3)
// ---------------------------------------------------------------------------

interface Candidate {
  readonly legs: readonly RouteLeg[];
  readonly ticks: number;
}

function compareCandidates(a: Candidate, b: Candidate): number {
  if (a.ticks !== b.ticks) return a.ticks - b.ticks;
  const n = Math.min(a.legs.length, b.legs.length);
  for (let i = 0; i < n; i++) {
    const byId = compareIds(a.legs[i]!.routeId, b.legs[i]!.routeId);
    if (byId !== 0) return byId;
  }
  return a.legs.length - b.legs.length;
}

/**
 * The shortest simple path by total duration from `from` to `to`, or null if
 * there's none. Ties break by `compareIds` on the route IDs in order. On foot
 * closures are ignored (walkers always get through); by vehicle, routes the
 * founder knows to be closed are left out.
 */
export function defaultPath(world: Pick<WorldSlice, "routes">, data: GameData, from: LocationId, to: LocationId, onFoot: boolean): readonly RouteLeg[] | null {
  let best: Candidate | null = null;
  const usable = data.routes.filter((r) => onFoot || knownClosure(world, r.id) === null);
  const walk = (at: LocationId, visited: Set<LocationId>, legs: RouteLeg[], ticks: number): void => {
    if (at === to) {
      const candidate = { legs: [...legs], ticks };
      if (best === null || compareCandidates(candidate, best) < 0) best = candidate;
      return;
    }
    for (const route of usable) {
      for (const reversed of [false, true]) {
        const ends = reversed ? { from: route.toLocationId, to: route.fromLocationId } : { from: route.fromLocationId, to: route.toLocationId };
        if (ends.from !== at || visited.has(ends.to)) continue;
        visited.add(ends.to);
        legs.push({ routeId: route.id, reversed });
        walk(ends.to, visited, legs, ticks + legTicks(route.durationTicks, onFoot));
        legs.pop();
        visited.delete(ends.to);
      }
    }
  };
  walk(from, new Set([from]), [], 0);
  return (best as Candidate | null)?.legs ?? null;
}
