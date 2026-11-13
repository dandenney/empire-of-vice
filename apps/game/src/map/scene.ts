// The map's scene, from the snapshot alone (CLAUDE.md rule 7): what the map
// draws, where it sits in world units, and where that lands on screen. Pure
// functions, no PixiJS or DOM, so Vitest covers them in Node
// (tests/unit/map/scene.test.ts) and the renderer, the DOM hit targets, and the
// test queries all share one layout.
//
// A truck on the road is positioned at (tick − departedAt) / (arrivesAt −
// departedAt) along its route's waypoints (ADR 0003, VehicleTrip), reversed on
// the return leg. Each waypoint segment gets an equal share of the trip. A
// parked truck sits at its home location in world units; on screen it's drawn
// beside the location so it doesn't hide it.

import type { GameSnapshot, LocationId, LocationSnapshot, WorldPoint } from "@eov/contracts";

/**
 * One drawn shape, in world units. The test hook exposes these as the map scene query (architecture §4).
 * PLACE (a location with nobody of ours or the scenario's on it, such as the
 * depot) and FOUNDER (the founder's token) appear only under founder rules
 * (player-scene.ts); M001's scene never has them.
 */
export interface SceneShape {
  readonly kind: "FACILITY" | "SUPPLIER" | "BUYER" | "PLACE" | "ROUTE" | "VEHICLE" | "FOUNDER";
  readonly id: string;
  readonly label: string;
  readonly position: WorldPoint;
}

/** A scene shape plus what the renderer and the click handling need. */
export interface MapEntity extends SceneShape {
  /** The location a click on this entity selects. Null for routes and vehicles. */
  readonly locationId: LocationId | null;
  /** Facilities only: which kind, so a warehouse is drawn apart from the distillery. */
  readonly facilityKind: "DISTILLERY" | "WAREHOUSE" | null;
  /** Routes only: the path, in world units. */
  readonly waypoints: readonly WorldPoint[];
  /** Routes only: false while the route is closed. */
  readonly open: boolean;
  /** Vehicles: true when parked at home (no trip). The founder: true when at a place (not on a road). */
  readonly parked: boolean;
  /** Vehicles only: true when the trip is running late. */
  readonly delayed: boolean;
}

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

/** World → screen: screen = offset + world × scale, in CSS pixels from the map's top-left corner. */
export interface MapView {
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly width: number;
  readonly height: number;
}

/** An entity with its on-screen position and hit radius, in CSS pixels. */
export interface PlacedEntity {
  readonly entity: MapEntity;
  readonly screen: ScreenPoint;
  readonly radius: number;
}

/** Screen-space sizes, in CSS pixels. Rendering detail, not gameplay numbers. */
export const MAP_METRICS = {
  /**
   * Space kept clear around the outermost shapes, so edge labels fit. Half the
   * widest edge label ("Miller's Feed & Seed", about 125px at the 12px label
   * size) plus a little air (#123 review, #50).
   */
  padding: 72,
  locationRadius: 16,
  vehicleRadius: 9,
  /** How close to a route's line a point must be to hit it. */
  routeHitDistance: 6,
  /** Where a parked truck is drawn relative to its home location. */
  parkedOffset: { x: -34, y: 0 },
  /** Founder rules: the founder's token, and where it sits relative to the place they're at. */
  founderRadius: 9,
  founderOffset: { x: 24, y: -20 },
} as const;

function occupantId(location: LocationSnapshot): string {
  const o = location.occupant;
  return o.kind === "FACILITY" ? o.facilityId : o.kind === "SUPPLIER" ? o.supplierId : o.buyerId;
}

/** The point `progress` (0..1) of the way along a path, each segment getting an equal share. */
export function along(points: readonly WorldPoint[], progress: number): WorldPoint {
  if (points.length === 1) return points[0]!;
  const segments = points.length - 1;
  const clamped = Math.min(Math.max(progress, 0), 1);
  const index = Math.min(Math.floor(clamped * segments), segments - 1);
  const local = clamped * segments - index;
  const a = points[index]!;
  const b = points[index + 1]!;
  return { x: a.x + (b.x - a.x) * local, y: a.y + (b.y - a.y) * local };
}

const ENTITY_DEFAULTS = { locationId: null, facilityKind: null, waypoints: [], open: true, parked: false, delayed: false } as const;

/** Every entity the map draws for a snapshot: routes, then locations, then vehicles (draw order). */
export function sceneOf(snapshot: GameSnapshot): readonly MapEntity[] {
  const entities: MapEntity[] = [];
  const locations = new Map(snapshot.locations.map((l) => [l.id, l]));
  const facilities = new Map(snapshot.facilities.map((f) => [f.id, f]));
  for (const route of snapshot.routes) {
    if (route.waypoints.length === 0) continue;
    entities.push({
      ...ENTITY_DEFAULTS,
      kind: "ROUTE",
      id: route.id,
      label: route.name,
      position: route.waypoints[0]!,
      waypoints: route.waypoints,
      open: route.status.open,
    });
  }
  for (const location of snapshot.locations) {
    const o = location.occupant;
    entities.push({
      ...ENTITY_DEFAULTS,
      kind: o.kind,
      id: occupantId(location),
      label: location.name,
      position: location.position,
      locationId: location.id,
      facilityKind: o.kind === "FACILITY" ? (facilities.get(o.facilityId)?.kind ?? "DISTILLERY") : null,
    });
  }
  for (const vehicle of snapshot.vehicles) {
    let position = locations.get(vehicle.homeLocationId)?.position ?? { x: 0, y: 0 };
    const trip = vehicle.trip;
    if (trip) {
      const route = snapshot.routes.find((r) => r.id === trip.routeId);
      if (route && route.waypoints.length > 0) {
        const span = trip.arrivesAt - trip.departedAt;
        const progress = span > 0 ? (snapshot.clock.tick - trip.departedAt) / span : 1;
        position = along(trip.leg === "OUTBOUND" ? route.waypoints : [...route.waypoints].reverse(), progress);
      }
    }
    entities.push({
      ...ENTITY_DEFAULTS,
      kind: "VEHICLE",
      id: vehicle.id,
      label: vehicle.name,
      position,
      parked: trip === null,
      delayed: trip?.delayed ?? false,
    });
  }
  return entities;
}

/** The view that fits every location and waypoint into a `width` × `height` map, centred, with padding. */
export function fitView(snapshot: GameSnapshot, width: number, height: number): MapView {
  return fitPoints([...snapshot.locations.map((l) => l.position), ...snapshot.routes.flatMap((r) => r.waypoints)], width, height);
}

/** The view that fits `points` (world units) into a `width` × `height` map, centred, with padding. */
export function fitPoints(points: readonly WorldPoint[], width: number, height: number): MapView {
  if (points.length === 0) return { scale: 1, offsetX: width / 2, offsetY: height / 2, width, height };
  const minX = Math.min(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y));
  const maxX = Math.max(...points.map((p) => p.x));
  const maxY = Math.max(...points.map((p) => p.y));
  const pad = MAP_METRICS.padding;
  const spanX = Math.max(maxX - minX, 1);
  const spanY = Math.max(maxY - minY, 1);
  const scale = Math.max(Math.min((width - 2 * pad) / spanX, (height - 2 * pad) / spanY), 0.01);
  return {
    scale,
    offsetX: width / 2 - ((minX + maxX) / 2) * scale,
    offsetY: height / 2 - ((minY + maxY) / 2) * scale,
    width,
    height,
  };
}

export function toScreen(view: MapView, point: WorldPoint): ScreenPoint {
  return { x: view.offsetX + point.x * view.scale, y: view.offsetY + point.y * view.scale };
}

/** Screen positions and hit radii for a scene. */
export function place(scene: readonly MapEntity[], view: MapView): readonly PlacedEntity[] {
  return scene.map((entity) => {
    const at = toScreen(view, entity.position);
    if (entity.kind === "VEHICLE") {
      const screen = entity.parked ? { x: at.x + MAP_METRICS.parkedOffset.x, y: at.y + MAP_METRICS.parkedOffset.y } : at;
      return { entity, screen, radius: MAP_METRICS.vehicleRadius };
    }
    if (entity.kind === "FOUNDER") {
      // At a place (not on a road), the token sits beside it so it doesn't hide it.
      const screen = entity.parked ? { x: at.x + MAP_METRICS.founderOffset.x, y: at.y + MAP_METRICS.founderOffset.y } : at;
      return { entity, screen, radius: MAP_METRICS.founderRadius };
    }
    if (entity.kind === "ROUTE") return { entity, screen: at, radius: MAP_METRICS.routeHitDistance };
    return { entity, screen: at, radius: MAP_METRICS.locationRadius };
  });
}

function distanceSquaredToSegment(p: ScreenPoint, a: ScreenPoint, b: ScreenPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.min(Math.max(((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared, 0), 1);
  const cx = a.x + t * dx - p.x;
  const cy = a.y + t * dy - p.y;
  return cx * cx + cy * cy;
}

function hits(placed: PlacedEntity, view: MapView, x: number, y: number): boolean {
  const r2 = placed.radius * placed.radius;
  if (placed.entity.kind !== "ROUTE") {
    const dx = placed.screen.x - x;
    const dy = placed.screen.y - y;
    return dx * dx + dy * dy <= r2;
  }
  const path = placed.entity.waypoints.map((w) => toScreen(view, w));
  for (let i = 0; i + 1 < path.length; i++) {
    if (distanceSquaredToSegment({ x, y }, path[i]!, path[i + 1]!) <= r2) return true;
  }
  return false;
}

/** Draw order, front to back: what a click at a point lands on first. */
const FRONT_TO_BACK: Readonly<Record<SceneShape["kind"], number>> = { FOUNDER: 0, VEHICLE: 0, FACILITY: 1, SUPPLIER: 1, BUYER: 1, PLACE: 1, ROUTE: 2 };

/** Every entity under the screen point (CSS pixels from the map's top-left), frontmost first. */
export function entitiesAt(placed: readonly PlacedEntity[], view: MapView, x: number, y: number): readonly PlacedEntity[] {
  return placed
    .filter((p) => hits(p, view, x, y))
    .sort((a, b) => FRONT_TO_BACK[a.entity.kind] - FRONT_TO_BACK[b.entity.kind]);
}
