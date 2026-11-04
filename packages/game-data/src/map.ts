// S0 stub: extended by T03 (logistics and the small-area map). Definition types per ADR 0012.
// PLACEHOLDER places and coordinates, in logical world units (ADR 0003). T03 decides the real map.

import { asId, type FacilityId, type LocationId, type WorldPoint } from "@eov/contracts";

export interface LocationDefinition {
  readonly id: LocationId;
  readonly name: string;
  readonly position: WorldPoint;
}

export interface FacilityDefinition {
  readonly id: FacilityId;
  readonly name: string;
  readonly locationId: LocationId;
}

export const HOLLOW_CREEK = asId("Location", "hollow-creek");
export const MILLERS_FEED_LOCATION = asId("Location", "millers-feed");
export const CROSSROADS = asId("Location", "crossroads");
export const KESSLER_PHARMACY = asId("Location", "kessler-pharmacy");
export const LAKEVIEW = asId("Location", "lakeview");

export const DISTILLERY_MAIN = asId("Facility", "distillery-main");

export const LOCATIONS: readonly LocationDefinition[] = [
  { id: HOLLOW_CREEK, name: "Hollow Creek", position: { x: 10, y: 12 } },
  { id: MILLERS_FEED_LOCATION, name: "Miller's Feed & Seed", position: { x: 4, y: 6 } },
  { id: CROSSROADS, name: "The Crossroads", position: { x: 24, y: 14 } },
  { id: KESSLER_PHARMACY, name: "Kessler's Pharmacy", position: { x: 32, y: 4 } },
  { id: LAKEVIEW, name: "Lakeview Hotel", position: { x: 38, y: 18 } },
];

export const FACILITIES: readonly FacilityDefinition[] = [
  { id: DISTILLERY_MAIN, name: "Hollow Creek distillery", locationId: HOLLOW_CREEK },
];
