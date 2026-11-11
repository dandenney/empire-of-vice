// The route picker's view model (#50, #77). Everything it shows comes from the
// snapshot's RouteSnapshot (name, travel time, transport cost, risk, status),
// except each route's description, which is a static game-data definition
// (RouteDefinition.description; orchestrator decision on #50, so no contract
// change). Nothing here computes a game value: risk and durations are only
// formatted.
//
// Safe or Risky comes from `riskPpm === 0` (decision on #50). The default route
// (DISPATCH_DELIVERY `routeId: null`) is the destination's one Safe route: #77
// makes every default safe, and the snapshot has no default marker yet (#124
// gap 2). With no single Safe route, every pick is sent by id.

import { TICKS_PER_HOUR, type LocationId, type RouteId, type RouteSnapshot } from "@eov/contracts";
import { ROUTES } from "@eov/game-data";
// The shared "day 3, 18:00", so closures and deadlines read alike (#133, #142).
import { formatDayTime } from "../format/time-format.ts";
import { ROUTE_PICKER_COPY as C } from "./copy.ts";

export type RouteSafety = "SAFE" | "RISKY";

export interface RouteOption {
  readonly route: RouteSnapshot;
  /** game-data's player-facing description, or null (the safe routes have none). */
  readonly description: string | null;
  readonly safety: RouteSafety;
  /** The route DISPATCH_DELIVERY takes with `routeId: null`. */
  readonly isDefault: boolean;
  readonly open: boolean;
}

/** A route's game-data description, by id. */
export function routeDescription(routeId: RouteId): string | null {
  return ROUTES.find((r) => r.id === routeId)?.description ?? null;
}

export function routeSafety(route: RouteSnapshot): RouteSafety {
  return route.riskPpm === 0 ? "SAFE" : "RISKY";
}

/** The routes a truck at `from` can take to `to`: Safe first, then by travel time, then by id. */
export function routeOptions(routes: readonly RouteSnapshot[], from: LocationId, to: LocationId): readonly RouteOption[] {
  const candidates = routes.filter((r) => r.fromLocationId === from && r.toLocationId === to);
  const safe = candidates.filter((r) => routeSafety(r) === "SAFE");
  return candidates
    .map((route) => ({
      route,
      description: routeDescription(route.id),
      safety: routeSafety(route),
      isDefault: safe.length === 1 && safe[0] === route,
      open: route.status.open,
    }))
    .sort((a, b) => rank(a) - rank(b) || a.route.durationTicks - b.route.durationTicks || (a.route.id < b.route.id ? -1 : a.route.id > b.route.id ? 1 : 0));
}

const rank = (option: RouteOption) => (option.safety === "SAFE" ? 0 : 1);

/**
 * The route a dispatch would use: the player's pick while it's open, else the
 * default while it's open, else the first open route, else null (nothing can
 * be picked). A closed route is never chosen.
 */
export function chosenRoute(options: readonly RouteOption[], picked: RouteId | null): RouteOption | null {
  const open = options.filter((o) => o.open);
  return open.find((o) => o.route.id === picked) ?? open.find((o) => o.isDefault) ?? open[0] ?? null;
}

/** DISPATCH_DELIVERY's `routeId` for a choice: null for the default route, the id otherwise. */
export function commandRouteId(option: RouteOption): RouteId | null {
  return option.isDefault ? null : option.route.id;
}

/** "15" for 150 000 ppm; one decimal when it isn't a whole percent. */
export function formatRiskPercent(riskPpm: number): string {
  const percent = riskPpm / 10_000;
  return Number.isInteger(percent) ? String(percent) : percent.toFixed(1);
}

/** "15% disruption chance" (#77). */
export function formatRisk(riskPpm: number): string {
  return C.disruption(formatRiskPercent(riskPpm));
}

/** Ticks as game hours and minutes (one tick is one game minute). */
export function formatTicks(ticks: number): string {
  const whole = Math.max(0, ticks);
  return C.duration(Math.floor(whole / TICKS_PER_HOUR), whole % TICKS_PER_HOUR);
}

/** A closed route's note: who closed it, and when it reopens if that's known. */
export function closureNote(route: RouteSnapshot, currentTick: number): readonly string[] {
  if (route.status.open) return [];
  const { reason, reopensAt } = route.status;
  return [C.closedReason[reason], reopensAt === null ? C.reopensUnknown : C.reopensIn(formatTicks(reopensAt - currentTick), formatDayTime(reopensAt))];
}
