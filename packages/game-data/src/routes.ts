// M001 routes (ADR 0019 decision 1, GDD §14.6). Definition types per ADR 0012.
// All numbers are PLACEHOLDER tuning for T07a. Route names and waypoints are
// PLACEHOLDER (story): the real ones are a needs-design decision (#77).

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
  /** One charge per round trip, paid or accrued when the truck gets home (ADR 0019 decision 2). */
  readonly transportCost: Money;
  /**
   * Chance per trip, in parts per million, that the outbound leg is disrupted
   * (ADR 0019 decision 3). 0 means the route is safe and draws nothing.
   */
  readonly riskPpm: number;
  /** How much later a delayed trip arrives, in ticks. Read only when `riskPpm` > 0. */
  readonly delayTicks: number;
  /** Share of disruptions, in parts per million, that seize the cargo; the rest delay it. Read only when `riskPpm` > 0. */
  readonly seizureSharePpm: number;
  /** A sale's deal deadline is its dispatch-time arrival plus this many ticks (ADR 0019 decision 4). */
  readonly dealGraceTicks: number;
}

/** The disruption and deadline tuning every M001 route shares. PLACEHOLDER. */
const M001_ROUTE_TUNING = {
  delayTicks: 240, // PLACEHOLDER
  seizureSharePpm: 333_334, // PLACEHOLDER: about a third of disruptions
  dealGraceTicks: 120, // PLACEHOLDER
} as const;

/** Disruption risk of each risky alternative (ADR 0019 decision 1). PLACEHOLDER. */
const RISKY_ROUTE_RISK_PPM = 150_000;

export const STATE_HIGHWAY = asId("Route", "state-highway");
export const COUNTY_ROAD = asId("Route", "county-road");
export const LAKE_SHORE_DRIVE = asId("Route", "lake-shore-drive");
export const CROSSROADS_BACK_ROAD = asId("Route", "crossroads-back-road");
export const KESSLER_BACK_ROAD = asId("Route", "kessler-back-road");
export const LAKEVIEW_BACK_ROAD = asId("Route", "lakeview-back-road");

/**
 * The first route listed between two locations is the default (DISPATCH_DELIVERY
 * with routeId null), and every default is safe. Each buyer also has a risky
 * alternative at about ⅔ of the duration and cost, listed after its default.
 */
export const ROUTES: readonly RouteDefinition[] = [
  // Safe defaults.
  {
    id: STATE_HIGHWAY,
    name: "State highway",
    fromLocationId: HOLLOW_CREEK,
    toLocationId: CROSSROADS,
    waypoints: [{ x: 10, y: 12 }, { x: 24, y: 14 }],
    durationTicks: 120, // PLACEHOLDER
    transportCost: cents(150), // PLACEHOLDER
    riskPpm: 0,
    ...M001_ROUTE_TUNING,
  },
  {
    id: COUNTY_ROAD,
    name: "County road",
    fromLocationId: HOLLOW_CREEK,
    toLocationId: KESSLER_PHARMACY,
    waypoints: [{ x: 10, y: 12 }, { x: 20, y: 8 }, { x: 32, y: 4 }],
    durationTicks: 150, // PLACEHOLDER
    transportCost: cents(200), // PLACEHOLDER
    riskPpm: 0,
    ...M001_ROUTE_TUNING,
  },
  {
    id: LAKE_SHORE_DRIVE,
    name: "Lake Shore Drive",
    fromLocationId: HOLLOW_CREEK,
    toLocationId: LAKEVIEW,
    waypoints: [{ x: 10, y: 12 }, { x: 24, y: 20 }, { x: 38, y: 18 }],
    durationTicks: 300, // PLACEHOLDER
    transportCost: cents(400), // PLACEHOLDER
    riskPpm: 0,
    ...M001_ROUTE_TUNING,
  },
  // Risky alternatives: faster and cheaper, but the cargo can be delayed or seized.
  {
    id: CROSSROADS_BACK_ROAD,
    name: "Crossroads back road", // PLACEHOLDER (story, #77)
    fromLocationId: HOLLOW_CREEK,
    toLocationId: CROSSROADS,
    waypoints: [{ x: 10, y: 12 }, { x: 17, y: 10 }, { x: 24, y: 14 }], // PLACEHOLDER (story, #77)
    durationTicks: 80, // PLACEHOLDER
    transportCost: cents(100), // PLACEHOLDER
    riskPpm: RISKY_ROUTE_RISK_PPM,
    ...M001_ROUTE_TUNING,
  },
  {
    id: KESSLER_BACK_ROAD,
    name: "Kessler's back road", // PLACEHOLDER (story, #77)
    fromLocationId: HOLLOW_CREEK,
    toLocationId: KESSLER_PHARMACY,
    waypoints: [{ x: 10, y: 12 }, { x: 22, y: 5 }, { x: 32, y: 4 }], // PLACEHOLDER (story, #77)
    durationTicks: 100, // PLACEHOLDER
    transportCost: cents(133), // PLACEHOLDER
    riskPpm: RISKY_ROUTE_RISK_PPM,
    ...M001_ROUTE_TUNING,
  },
  {
    id: LAKEVIEW_BACK_ROAD,
    name: "Lakeview back road", // PLACEHOLDER (story, #77)
    fromLocationId: HOLLOW_CREEK,
    toLocationId: LAKEVIEW,
    waypoints: [{ x: 10, y: 12 }, { x: 26, y: 15 }, { x: 38, y: 18 }], // PLACEHOLDER (story, #77)
    durationTicks: 200, // PLACEHOLDER
    transportCost: cents(267), // PLACEHOLDER
    riskPpm: RISKY_ROUTE_RISK_PPM,
    ...M001_ROUTE_TUNING,
  },
];
