// The dispatch route picker's view model (#50, #77): Safe or Risky from
// `riskPpm`, descriptions from game-data, closed routes never chosen, the
// default sent as `routeId: null`, and risk worded as a disruption chance.

import { tick, type RouteSnapshot } from "@eov/contracts";
import { CROSSROADS, CROSSROADS_BACK_ROAD, HOLLOW_CREEK, KESSLER_PHARMACY, ROUTES, STATE_HIGHWAY } from "@eov/game-data";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ROUTE_PICKER_COPY } from "../../../../src/ui/route-picker/copy.ts";
import { chosenRoute, closureNote, commandRouteId, formatRisk, formatRiskPercent, formatTicks, routeOptions } from "../../../../src/ui/route-picker/route-options.ts";
import { RoutePicker } from "../../../../src/ui/route-picker/route-picker.tsx";

/** The snapshot game-data's routes would give, all open. */
const SNAPSHOT_ROUTES: readonly RouteSnapshot[] = ROUTES.map((r) => ({
  id: r.id,
  name: r.name,
  fromLocationId: r.fromLocationId,
  toLocationId: r.toLocationId,
  waypoints: r.waypoints,
  durationTicks: r.durationTicks,
  transportCost: r.transportCost,
  status: { open: true },
  riskPpm: r.riskPpm,
}));

const closed = (routes: readonly RouteSnapshot[], id: string, reopensAt: number | null): readonly RouteSnapshot[] =>
  routes.map((r) => (r.id === id ? { ...r, status: { open: false, reason: "RIVAL", reopensAt: reopensAt === null ? null : tick(reopensAt) } } : r));

describe("routeOptions", () => {
  it("lists the routes from the truck's yard to the buyer, Safe first", () => {
    const options = routeOptions(SNAPSHOT_ROUTES, HOLLOW_CREEK, CROSSROADS);
    expect(options.map((o) => o.route.id)).toEqual([STATE_HIGHWAY, CROSSROADS_BACK_ROAD]);
    expect(options.map((o) => o.safety)).toEqual(["SAFE", "RISKY"]);
  });

  it("labels Safe and Risky from riskPpm alone", () => {
    const options = routeOptions(
      SNAPSHOT_ROUTES.map((r) => (r.id === STATE_HIGHWAY ? { ...r, riskPpm: 1 } : r)),
      HOLLOW_CREEK,
      CROSSROADS,
    );
    expect(options.every((o) => o.safety === "RISKY")).toBe(true);
  });

  it("reads descriptions from game-data, and the safe routes have none", () => {
    const [safe, risky] = routeOptions(SNAPSHOT_ROUTES, HOLLOW_CREEK, CROSSROADS);
    expect(safe!.description).toBeNull();
    expect(risky!.description).toBe(ROUTES.find((r) => r.id === CROSSROADS_BACK_ROAD)!.description);
  });

  it("is empty where no road goes", () => {
    expect(routeOptions(SNAPSHOT_ROUTES, CROSSROADS, KESSLER_PHARMACY)).toEqual([]);
  });
});

describe("chosenRoute and commandRouteId", () => {
  it("defaults to the one Safe route, sent as null", () => {
    const options = routeOptions(SNAPSHOT_ROUTES, HOLLOW_CREEK, CROSSROADS);
    const chosen = chosenRoute(options, null)!;
    expect(chosen.route.id).toBe(STATE_HIGHWAY);
    expect(commandRouteId(chosen)).toBeNull();
  });

  it("sends a picked Risky route by id", () => {
    const options = routeOptions(SNAPSHOT_ROUTES, HOLLOW_CREEK, CROSSROADS);
    const chosen = chosenRoute(options, CROSSROADS_BACK_ROAD)!;
    expect(commandRouteId(chosen)).toBe(CROSSROADS_BACK_ROAD);
  });

  it("never chooses a closed route, even when it was picked", () => {
    const options = routeOptions(closed(SNAPSHOT_ROUTES, CROSSROADS_BACK_ROAD, null), HOLLOW_CREEK, CROSSROADS);
    expect(chosenRoute(options, CROSSROADS_BACK_ROAD)!.route.id).toBe(STATE_HIGHWAY);
  });

  it("falls back to an open alternative when the default is closed, sending it by id", () => {
    const options = routeOptions(closed(SNAPSHOT_ROUTES, STATE_HIGHWAY, 500), HOLLOW_CREEK, CROSSROADS);
    const chosen = chosenRoute(options, null)!;
    expect(chosen.route.id).toBe(CROSSROADS_BACK_ROAD);
    expect(commandRouteId(chosen)).toBe(CROSSROADS_BACK_ROAD);
  });

  it("chooses nothing when every route is closed", () => {
    const routes = closed(closed(SNAPSHOT_ROUTES, STATE_HIGHWAY, null), CROSSROADS_BACK_ROAD, null);
    expect(chosenRoute(routeOptions(routes, HOLLOW_CREEK, CROSSROADS), null)).toBeNull();
  });
});

describe("formatting", () => {
  it("words risk as a disruption chance (#77)", () => {
    expect(formatRisk(150_000)).toBe("15% disruption chance");
    expect(formatRisk(0)).toBe("0% disruption chance");
    expect(formatRiskPercent(125_000)).toBe("12.5");
    expect(formatRisk(150_000)).not.toMatch(/los[es]|lose/i);
  });

  it("formats ticks as game hours and minutes", () => {
    expect(formatTicks(150)).toBe("2 h 30 min");
    expect(formatTicks(120)).toBe("2 h");
    expect(formatTicks(40)).toBe("40 min");
  });

  it("notes who closed a route and when it reopens", () => {
    const route = { ...SNAPSHOT_ROUTES[0]!, status: { open: false as const, reason: "POLICE" as const, reopensAt: tick(1_000) } };
    expect(closureNote(route, 880)).toEqual([ROUTE_PICKER_COPY.closedReason.POLICE, "Reopens in 2 h (day 0, 16:40)."]);
    expect(closureNote({ ...route, status: { ...route.status, reopensAt: null } }, 880)).toEqual([ROUTE_PICKER_COPY.closedReason.POLICE, ROUTE_PICKER_COPY.reopensUnknown]);
    expect(closureNote(SNAPSHOT_ROUTES[0]!, 880)).toEqual([]);
  });
});

describe("RoutePicker", () => {
  const render = (routes: readonly RouteSnapshot[]) => {
    const options = routeOptions(routes, HOLLOW_CREEK, CROSSROADS);
    return renderToStaticMarkup(<RoutePicker options={options} chosen={chosenRoute(options, null)} onPick={() => {}} tick={0} name="picker" />);
  };

  it("shows each route's name, label, description, time, cost and risk", () => {
    const html = render(SNAPSHOT_ROUTES);
    const risky = ROUTES.find((r) => r.id === CROSSROADS_BACK_ROAD)!;
    expect(html).toContain(risky.name);
    expect(html).toContain(risky.description!.replace(/'/g, "&#x27;"));
    expect(html).toContain(">Safe<");
    expect(html).toContain(">Risky<");
    expect(html).toContain("15% disruption chance");
    expect(html).toContain("$1.00");
  });

  it("disables a closed route's radio and marks it closed", () => {
    const html = render(closed(SNAPSHOT_ROUTES, CROSSROADS_BACK_ROAD, null));
    expect(html).toMatch(new RegExp(`data-testid="picker-${CROSSROADS_BACK_ROAD}-radio"[^>]*disabled=""|disabled=""[^>]*data-testid="picker-${CROSSROADS_BACK_ROAD}-radio"`));
    expect(html).toContain(`data-testid="picker-${CROSSROADS_BACK_ROAD}-closed"`);
    expect(html).toContain(ROUTE_PICKER_COPY.reopensUnknown);
  });
});
