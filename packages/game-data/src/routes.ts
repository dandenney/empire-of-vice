// S0 stub: extended by T03 (GDD §14.6 route configuration). Definition types per ADR 0012.
// PLACEHOLDER values. T03 decides the real routes.

import { asId, cents, type LocationId, type Money, type RouteId, type WorldPoint } from "@eov/contracts";
import { CROSSROADS, HOLLOW_CREEK, KESSLER_PHARMACY, LAKEVIEW } from "./map.ts";

export interface RouteDefinition {
  readonly id: RouteId;
  readonly name: string;
  readonly fromLocationId: LocationId;
  readonly toLocationId: LocationId;
  readonly waypoints: readonly WorldPoint[];
  /** One-way travel time in ticks. The return leg takes the same time. */
  readonly durationTicks: number;
  /** Not charged yet: transport costs arrive with T03. */
  readonly transportCost: Money;
  /** Disruption risk per trip in parts per million. Not used yet (T03). */
  readonly riskPpm: number;
}

export const STATE_HIGHWAY = asId("Route", "state-highway");
export const COUNTY_ROAD = asId("Route", "county-road");
export const LAKE_SHORE_DRIVE = asId("Route", "lake-shore-drive");

/** The first route listed between two locations is the default (DISPATCH_DELIVERY with routeId null). */
export const ROUTES: readonly RouteDefinition[] = [
  {
    id: STATE_HIGHWAY,
    name: "State highway",
    fromLocationId: HOLLOW_CREEK,
    toLocationId: CROSSROADS,
    waypoints: [{ x: 10, y: 12 }, { x: 24, y: 14 }],
    durationTicks: 120, // PLACEHOLDER
    transportCost: cents(150), // PLACEHOLDER
    riskPpm: 30_000, // PLACEHOLDER
  },
  {
    id: COUNTY_ROAD,
    name: "County road",
    fromLocationId: HOLLOW_CREEK,
    toLocationId: KESSLER_PHARMACY,
    waypoints: [{ x: 10, y: 12 }, { x: 20, y: 8 }, { x: 32, y: 4 }],
    durationTicks: 150, // PLACEHOLDER
    transportCost: cents(200), // PLACEHOLDER
    riskPpm: 80_000, // PLACEHOLDER
  },
  {
    id: LAKE_SHORE_DRIVE,
    name: "Lake Shore Drive",
    fromLocationId: HOLLOW_CREEK,
    toLocationId: LAKEVIEW,
    waypoints: [{ x: 10, y: 12 }, { x: 24, y: 20 }, { x: 38, y: 18 }],
    durationTicks: 300, // PLACEHOLDER
    transportCost: cents(400), // PLACEHOLDER
    riskPpm: 50_000, // PLACEHOLDER
  },
];
