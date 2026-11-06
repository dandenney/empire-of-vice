// The map's scene and layout (issue #17): built from the snapshot alone, fitted
// to the map's size, with hit testing for clicks and the test queries.

import { tick, type GameSnapshot, type VehicleSnapshot } from "@eov/contracts";
import { newGame } from "@eov/simulation";
import { describe, expect, it } from "vitest";
import { along, entitiesAt, fitView, MAP_METRICS, place, sceneOf, toScreen, type MapView, type PlacedEntity } from "../../../src/map/scene.ts";

const snapshot: GameSnapshot = newGame().snapshot();

/** The frontmost location under a point: what a click there selects. */
const locationAt = (placed: readonly PlacedEntity[], view: MapView, x: number, y: number) =>
  entitiesAt(placed, view, x, y).find((p) => p.entity.locationId !== null)?.entity.locationId ?? null;
const WIDTH = 800;
const HEIGHT = 500;

/** The snapshot with its first truck partway along its first route. */
function onTheRoad(progressTicks: number, span: number, leg: "OUTBOUND" | "RETURN" = "OUTBOUND"): GameSnapshot {
  const route = snapshot.routes[0]!;
  const vehicle = snapshot.vehicles[0]!;
  const trip = {
    deliveryId: "d1",
    routeId: route.id,
    leg,
    departedAt: 100,
    arrivesAt: 100 + span,
    cargo: [],
    purpose: { kind: "SALE", buyerId: "b", agreedUnitPrice: 0 },
    delayed: false,
  } as unknown as NonNullable<VehicleSnapshot["trip"]>;
  return {
    ...snapshot,
    clock: { ...snapshot.clock, tick: tick(100 + progressTicks) },
    vehicles: [{ ...vehicle, trip }, ...snapshot.vehicles.slice(1)],
  };
}

describe("map scene", () => {
  it("has every location, route, and vehicle in the snapshot, and nothing else", () => {
    const scene = sceneOf(snapshot);
    expect(scene.filter((e) => e.kind === "ROUTE").map((e) => e.id)).toEqual(snapshot.routes.map((r) => r.id));
    expect(scene.filter((e) => e.locationId !== null).map((e) => e.locationId)).toEqual(snapshot.locations.map((l) => l.id));
    expect(scene.filter((e) => e.kind === "VEHICLE").map((e) => e.id)).toEqual(snapshot.vehicles.map((v) => v.id));
    expect(scene).toHaveLength(snapshot.routes.length + snapshot.locations.length + snapshot.vehicles.length);
  });

  it("draws the distillery, the supplier, and every buyer", () => {
    const kinds = sceneOf(snapshot).map((e) => e.kind);
    expect(kinds).toContain("FACILITY");
    expect(kinds).toContain("SUPPLIER");
    expect(kinds.filter((k) => k === "BUYER")).toHaveLength(snapshot.market.buyers.length);
    const distillery = sceneOf(snapshot).find((e) => e.kind === "FACILITY")!;
    expect(distillery.facilityKind).toBe("DISTILLERY");
  });

  it("parks an idle truck at its home location", () => {
    const vehicle = snapshot.vehicles[0]!;
    const home = snapshot.locations.find((l) => l.id === vehicle.homeLocationId)!;
    const truck = sceneOf(snapshot).find((e) => e.kind === "VEHICLE")!;
    expect(truck.parked).toBe(true);
    expect(truck.position).toEqual(home.position);
  });

  it("moves a truck along its route as the ticks advance, and back on the return leg", () => {
    const route = snapshot.routes[0]!;
    const truck = (s: GameSnapshot) => sceneOf(s).find((e) => e.kind === "VEHICLE")!;
    expect(truck(onTheRoad(0, 40)).position).toEqual(route.waypoints[0]);
    expect(truck(onTheRoad(40, 40)).position).toEqual(route.waypoints.at(-1));
    expect(truck(onTheRoad(20, 40)).position).toEqual(along(route.waypoints, 0.5));
    expect(truck(onTheRoad(20, 40)).position).not.toEqual(truck(onTheRoad(10, 40)).position);
    expect(truck(onTheRoad(0, 40, "RETURN")).position).toEqual(route.waypoints.at(-1));
    expect(truck(onTheRoad(20, 40)).parked).toBe(false);
  });

  it("interpolates along waypoints, each segment an equal share, clamped to the ends", () => {
    const path = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 20 },
    ];
    expect(along(path, 0.25)).toEqual({ x: 5, y: 0 });
    expect(along(path, 0.75)).toEqual({ x: 10, y: 10 });
    expect(along(path, -1)).toEqual({ x: 0, y: 0 });
    expect(along(path, 2)).toEqual({ x: 10, y: 20 });
  });
});

describe("map layout and hit testing", () => {
  const view = fitView(snapshot, WIDTH, HEIGHT);
  const placed = place(sceneOf(snapshot), view);

  it("fits every location and waypoint inside the map, clear of the padding", () => {
    const points = [...snapshot.locations.map((l) => l.position), ...snapshot.routes.flatMap((r) => r.waypoints)];
    for (const p of points) {
      const s = toScreen(view, p);
      expect(s.x).toBeGreaterThanOrEqual(MAP_METRICS.padding - 1e-9);
      expect(s.x).toBeLessThanOrEqual(WIDTH - MAP_METRICS.padding + 1e-9);
      expect(s.y).toBeGreaterThanOrEqual(MAP_METRICS.padding - 1e-9);
      expect(s.y).toBeLessThanOrEqual(HEIGHT - MAP_METRICS.padding + 1e-9);
    }
  });

  it("finds each location at its own screen position", () => {
    for (const p of placed.filter((e) => e.entity.locationId !== null)) {
      expect(locationAt(placed, view, p.screen.x, p.screen.y)).toBe(p.entity.locationId);
      expect(entitiesAt(placed, view, p.screen.x + 3, p.screen.y - 3).map((e) => e.entity.id)).toContain(p.entity.id);
    }
  });

  it("finds nothing in an empty corner", () => {
    expect(entitiesAt(placed, view, 1, 1)).toEqual([]);
    expect(locationAt(placed, view, 1, 1)).toBeNull();
  });

  it("finds a route along its line, and puts a truck in front of what's under it", () => {
    const route = placed.find((e) => e.entity.kind === "ROUTE")!;
    const [a, b] = route.entity.waypoints.map((w) => toScreen(view, w));
    const mid = { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 };
    expect(entitiesAt(placed, view, mid.x, mid.y).map((e) => e.entity.id)).toContain(route.entity.id);

    const moving = place(sceneOf(onTheRoad(20, 40)), view);
    const truck = moving.find((e) => e.entity.kind === "VEHICLE")!;
    const under = entitiesAt(moving, view, truck.screen.x, truck.screen.y);
    expect(under[0]!.entity.kind).toBe("VEHICLE");
  });

  it("draws a parked truck beside its home location, so a click on the location still selects it", () => {
    const truck = placed.find((e) => e.entity.kind === "VEHICLE")!;
    const home = placed.find((e) => e.entity.locationId === snapshot.vehicles[0]!.homeLocationId)!;
    expect(truck.screen).toEqual({ x: home.screen.x + MAP_METRICS.parkedOffset.x, y: home.screen.y + MAP_METRICS.parkedOffset.y });
    expect(locationAt(placed, view, home.screen.x, home.screen.y)).toBe(home.entity.locationId);
  });

  it("refits when the map is resized", () => {
    const wide = fitView(snapshot, WIDTH * 2, HEIGHT * 2);
    expect(wide.scale).toBeGreaterThan(view.scale);
  });
});
