// S0 stub: extended by T03 (logistics and the small-area map). Definition types per ADR 0012.
// PLACEHOLDER places and coordinates, in logical world units (ADR 0003). T03 decides the real map.
// T03b (#76) adds a warehouse. The First Shipment scenario doesn't own it (ADR 0020
// decision 13), and the snapshot shows only occupied locations, so it never shows in M001.

import { asId, type FacilityId, type FacilitySnapshot, type LocationId, type WorldPoint } from "@eov/contracts";

export interface LocationDefinition {
  readonly id: LocationId;
  readonly name: string;
  readonly position: WorldPoint;
}

export interface FacilityDefinition {
  readonly id: FacilityId;
  readonly name: string;
  readonly locationId: LocationId;
  /** What the facility is, whatever equipment it holds now (T05i, #148). */
  readonly kind: FacilityKind;
}

/** The contract's facility kind (`FacilitySnapshot["kind"]`); game-data doesn't redefine it (ADR 0012). */
export type FacilityKind = FacilitySnapshot["kind"];

export const HOLLOW_CREEK = asId("Location", "hollow-creek");
export const MILLERS_FEED_LOCATION = asId("Location", "millers-feed");
export const CROSSROADS = asId("Location", "crossroads");
export const KESSLER_PHARMACY = asId("Location", "kessler-pharmacy");
export const LAKEVIEW = asId("Location", "lakeview");
/** The warehouse's location (T03b, #76). PLACEHOLDER name and position. */
export const RIVERSIDE_DEPOT = asId("Location", "riverside-depot");

export const DISTILLERY_MAIN = asId("Facility", "distillery-main");
/** A storage-only facility (T03b, #76): no equipment slots, no workers. PLACEHOLDER name. */
export const RIVERSIDE_WAREHOUSE = asId("Facility", "riverside-warehouse");

export const LOCATIONS: readonly LocationDefinition[] = [
  { id: HOLLOW_CREEK, name: "Hollow Creek", position: { x: 10, y: 12 } },
  { id: MILLERS_FEED_LOCATION, name: "Miller's Feed & Seed", position: { x: 4, y: 6 } },
  { id: CROSSROADS, name: "The Crossroads", position: { x: 24, y: 14 } },
  { id: KESSLER_PHARMACY, name: "Kessler's Pharmacy", position: { x: 32, y: 4 } },
  { id: LAKEVIEW, name: "Lakeview Hotel", position: { x: 38, y: 18 } },
  { id: RIVERSIDE_DEPOT, name: "Riverside Depot", position: { x: 16, y: 20 } }, // PLACEHOLDER (T03b, #76)
];

export const FACILITIES: readonly FacilityDefinition[] = [
  { id: DISTILLERY_MAIN, name: "Hollow Creek distillery", locationId: HOLLOW_CREEK, kind: "DISTILLERY" },
  { id: RIVERSIDE_WAREHOUSE, name: "Riverside warehouse", locationId: RIVERSIDE_DEPOT, kind: "WAREHOUSE" }, // PLACEHOLDER (T03b, #76)
];
