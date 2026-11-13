// The map's scene under founder rules (SK2b, #234), from the player snapshot
// alone (ADR 0021 decision 8, CLAUDE.md rule 7). Same shapes and layout as
// M001's scene (scene.ts), so the renderer, the hit targets and the test
// queries are shared. Pure functions, covered in Node
// (tests/unit/map/player-scene.test.ts).
//
// What's drawn, and from what:
// - Places and roads: geography, always known. Every entity's id is its
//   location's (or route's) id.
// - A road is drawn closed only when its known condition says so: an unknown
//   or stale closure isn't shown (GDD §17's route indicators are a channel).
// - The truck where it was last seen: parked at its known place, or along its
//   known trip at the tick it was seen (`learnedAt`), never projected forward.
//   Unknown whereabouts: not drawn.
// - The founder (always known, ADR 0023 decision 1): beside the place they're
//   at or asleep at; along the current leg at `progressPpm` while travelling;
//   with the truck while riding a delivery (at the stop once it's reached).

import type { PlayerSnapshot, PlayerVehicle, WorldPoint } from "@eov/contracts";
import { MAP_COPY } from "./copy.ts";
import { along, fitPoints, type MapEntity, type MapView } from "./scene.ts";

const DEFAULTS = { locationId: null, facilityKind: null, waypoints: [], open: true, parked: false, delayed: false } as const;
const PPM = 1_000_000;

/** Where a vehicle was last seen, in world units, and whether it was parked; null if never seen. */
function vehicleSeenAt(player: PlayerSnapshot, vehicle: PlayerVehicle): { readonly position: WorldPoint; readonly parked: boolean; readonly delayed: boolean } | null {
  const seen = vehicle.whereabouts;
  if (seen === null) return null;
  const { parkedAt, trip } = seen.value;
  if (parkedAt !== null) {
    const place = player.places.find((p) => p.id === parkedAt);
    return place ? { position: place.position, parked: true, delayed: false } : null;
  }
  if (trip === null) return null;
  const route = player.routes.find((r) => r.id === trip.routeId);
  if (!route || route.waypoints.length === 0) return null;
  const span = trip.arrivesAt - trip.departedAt;
  const progress = span > 0 ? (seen.learnedAt - trip.departedAt) / span : 1;
  const path = trip.leg === "OUTBOUND" ? route.waypoints : [...route.waypoints].reverse();
  return { position: along(path, progress), parked: false, delayed: trip.delayed };
}

/** The founder's token position, and whether they're at a place; null if it can't be placed. */
function founderAt(player: PlayerSnapshot): { readonly position: WorldPoint; readonly parked: boolean } | null {
  const w = player.founder.whereabouts;
  const placeAt = (id: string) => player.places.find((p) => p.id === id)?.position ?? null;
  switch (w.kind) {
    case "PRESENT":
    case "RESTING": {
      const position = placeAt(w.locationId);
      return position ? { position, parked: true } : null;
    }
    case "TRAVELLING": {
      const leg = player.founder.currentLeg;
      if (!leg || leg.waypoints.length === 0) return null;
      return { position: along(leg.waypoints, leg.progressPpm / PPM), parked: false };
    }
    case "ON_DELIVERY": {
      if (w.atStop !== null) {
        const position = placeAt(w.atStop.locationId);
        return position ? { position, parked: true } : null;
      }
      const vehicle = player.vehicles.find((v) => v.id === w.vehicleId);
      const seen = vehicle ? vehicleSeenAt(player, vehicle) : null;
      return seen ? { position: seen.position, parked: seen.parked } : null;
    }
  }
}

/** Every entity the founder-rules map draws: roads, then places, then the truck, then the founder (draw order). */
export function sceneOfPlayer(player: PlayerSnapshot): readonly MapEntity[] {
  const entities: MapEntity[] = [];
  for (const route of player.routes) {
    if (route.waypoints.length === 0) continue;
    const known = route.condition?.value.status ?? null;
    entities.push({
      ...DEFAULTS,
      kind: "ROUTE",
      id: route.id,
      label: route.name,
      position: route.waypoints[0]!,
      waypoints: route.waypoints,
      open: known === null || known.open,
    });
  }
  for (const place of player.places) {
    entities.push({
      ...DEFAULTS,
      kind: place.kind === "NONE" ? "PLACE" : place.kind,
      id: place.id,
      label: place.name,
      position: place.position,
      locationId: place.id,
      facilityKind: place.kind === "FACILITY" ? place.facility.kind : null,
    });
  }
  for (const vehicle of player.vehicles) {
    const seen = vehicleSeenAt(player, vehicle);
    if (!seen) continue;
    entities.push({ ...DEFAULTS, kind: "VEHICLE", id: vehicle.id, label: vehicle.name, position: seen.position, parked: seen.parked, delayed: seen.delayed });
  }
  const founder = founderAt(player);
  if (founder) entities.push({ ...DEFAULTS, kind: "FOUNDER", id: "founder", label: MAP_COPY.founder, position: founder.position, parked: founder.parked });
  return entities;
}

/** The view that fits every place and road into a `width` × `height` map. */
export function fitPlayerView(player: PlayerSnapshot, width: number, height: number): MapView {
  return fitPoints([...player.places.map((p) => p.position), ...player.routes.flatMap((r) => r.waypoints)], width, height);
}
