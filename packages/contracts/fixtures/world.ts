// The small fictional world every fixture uses. PLACEHOLDER content: names,
// prices, and coordinates are illustrative, not the real First Shipment
// scenario (T05 decides that). Money is in cents.

import { asId, cents, tick, type RouteSnapshot, type LocationSnapshot } from "../src/index.ts";

export const ids = {
  scenario: asId("Scenario", "first-shipment"),
  family: asId("Family", "kerrigan"),
  founder: asId("Character", "thomas-kerrigan"),
  foreman: asId("Character", "walt-hagen"),

  distillery: asId("Facility", "distillery-main"),
  barn: asId("Facility", "storage-barn"),
  supplier: asId("Supplier", "millers-feed"),
  roadhouse: asId("Buyer", "crossroads-roadhouse"),
  speakeasy: asId("Buyer", "kesslers-back-room"),
  hotel: asId("Buyer", "lakeview-hotel"),

  locDistillery: asId("Location", "hollow-creek"),
  locBarn: asId("Location", "old-barn"),
  locSupplier: asId("Location", "millers-feed"),
  locRoadhouse: asId("Location", "crossroads"),
  locSpeakeasy: asId("Location", "kessler-pharmacy"),
  locHotel: asId("Location", "lakeview"),

  routeSupplier: asId("Route", "mill-road"),
  routeBarn: asId("Route", "farm-track"),
  routeRoadhouse: asId("Route", "state-highway"),
  routeSpeakeasyMain: asId("Route", "county-road"),
  routeSpeakeasyBack: asId("Route", "back-roads"),
  routeHotel: asId("Route", "lake-shore-drive"),

  truck: asId("Vehicle", "model-tt-truck"),

  moonshine: asId("Product", "moonshine"),
  corn: asId("Material", "corn"),
  sugar: asId("Material", "sugar"),
  basicRecipe: asId("Recipe", "basic-moonshine"),
  standardRecipe: asId("Recipe", "standard-moonshine"),

  copperStill: asId("Equipment", "copper-still"),
  condenser: asId("Equipment", "improved-condenser"),
  qcStation: asId("Equipment", "quality-control-station"),
  storageExpansion: asId("Equipment", "storage-expansion"),

  tierStart: asId("Tier", "starting-operation"),
  tierTrusted: asId("Tier", "trusted-supplier"),
  tierEstablished: asId("Tier", "established-producer"),
  tierRegional: asId("Tier", "regional-distributor"),
  unlockSpot: asId("Unlock", "spot-sales"),
  unlockContracts: asId("Unlock", "recurring-contracts"),
  unlockQuality: asId("Unlock", "quality-equipment"),
  unlockRegion: asId("Unlock", "next-region"),
} as const;

/** Opening balance sheet (placeholder; GDD §14.1 is decided in T05). */
export const opening = {
  cash: cents(100_000),
  copperStill: cents(30_000),
  truck: cents(40_000),
  buildings: cents(80_000),
  equity: cents(250_000),
} as const;

export const locations: readonly LocationSnapshot[] = [
  { id: ids.locRoadhouse, name: "The Crossroads", position: { x: 24, y: 14 }, occupant: { kind: "BUYER", buyerId: ids.roadhouse } },
  { id: ids.locDistillery, name: "Hollow Creek", position: { x: 10, y: 12 }, occupant: { kind: "FACILITY", facilityId: ids.distillery } },
  { id: ids.locSpeakeasy, name: "Kessler's Pharmacy", position: { x: 32, y: 4 }, occupant: { kind: "BUYER", buyerId: ids.speakeasy } },
  { id: ids.locHotel, name: "Lakeview Hotel", position: { x: 38, y: 18 }, occupant: { kind: "BUYER", buyerId: ids.hotel } },
  { id: ids.locSupplier, name: "Miller's Feed & Seed", position: { x: 4, y: 6 }, occupant: { kind: "SUPPLIER", supplierId: ids.supplier } },
  { id: ids.locBarn, name: "Old Barn", position: { x: 14, y: 6 }, occupant: { kind: "FACILITY", facilityId: ids.barn } },
];

const open = { open: true } as const;

export function routes(closedCountyRoadUntil: number | null): readonly RouteSnapshot[] {
  return [
    {
      id: ids.routeSpeakeasyBack,
      name: "Back roads",
      fromLocationId: ids.locDistillery,
      toLocationId: ids.locSpeakeasy,
      waypoints: [{ x: 10, y: 12 }, { x: 12, y: 2 }, { x: 26, y: 0 }, { x: 32, y: 4 }],
      durationTicks: 240,
      transportCost: cents(300),
      status: open,
      riskPpm: 20_000,
    },
    {
      id: ids.routeSpeakeasyMain,
      name: "County road",
      fromLocationId: ids.locDistillery,
      toLocationId: ids.locSpeakeasy,
      waypoints: [{ x: 10, y: 12 }, { x: 20, y: 8 }, { x: 32, y: 4 }],
      durationTicks: 150,
      transportCost: cents(200),
      status:
        closedCountyRoadUntil === null ? open : { open: false, reopensAt: tick(closedCountyRoadUntil), reason: "POLICE" },
      riskPpm: 80_000,
    },
    {
      id: ids.routeBarn,
      name: "Farm track",
      fromLocationId: ids.locDistillery,
      toLocationId: ids.locBarn,
      waypoints: [{ x: 10, y: 12 }, { x: 14, y: 6 }],
      durationTicks: 45,
      transportCost: cents(50),
      status: open,
      riskPpm: 0,
    },
    {
      id: ids.routeHotel,
      name: "Lake Shore Drive",
      fromLocationId: ids.locDistillery,
      toLocationId: ids.locHotel,
      waypoints: [{ x: 10, y: 12 }, { x: 24, y: 20 }, { x: 38, y: 18 }],
      durationTicks: 300,
      transportCost: cents(400),
      status: open,
      riskPpm: 50_000,
    },
    {
      id: ids.routeSupplier,
      name: "Mill road",
      fromLocationId: ids.locDistillery,
      toLocationId: ids.locSupplier,
      waypoints: [{ x: 10, y: 12 }, { x: 4, y: 6 }],
      durationTicks: 60,
      transportCost: cents(100),
      status: open,
      riskPpm: 0,
    },
    {
      id: ids.routeRoadhouse,
      name: "State highway",
      fromLocationId: ids.locDistillery,
      toLocationId: ids.locRoadhouse,
      waypoints: [{ x: 10, y: 12 }, { x: 24, y: 14 }],
      durationTicks: 120,
      transportCost: cents(150),
      status: open,
      riskPpm: 30_000,
    },
  ];
}
