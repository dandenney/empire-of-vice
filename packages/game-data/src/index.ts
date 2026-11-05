// @eov/game-data: gameplay numbers (prices, wages, rates, thresholds) and scenarios.
//
// S0 stub (issue #4). Each data file is named for the task that owns its real
// values: products/equipment/recipes/personnel (T02c), markets/buyers/suppliers
// (T02d), routes/vehicles/map (T03), scenario (T05). Definition types live next
// to their data (ADR 0012). Every number is a PLACEHOLDER until its owner tunes it.

import firstShipmentJson from "./scenarios/first-shipment.json" with { type: "json" };
import { BUYERS, type BuyerDefinition } from "./buyers.ts";
import { EQUIPMENT, type EquipmentDefinition } from "./equipment.ts";
import { FACILITY_PRODUCTION, type FacilityProductionDefinition } from "./facilities.ts";
import { FACILITIES, LOCATIONS, type FacilityDefinition, type LocationDefinition } from "./map.ts";
import { MARKETS, type MarketDefinition } from "./markets.ts";
import { CHARACTERS, WORKFORCE, type CharacterDefinition, type WorkforceDefinition } from "./personnel.ts";
import { MATERIALS, PRODUCTS, type MaterialDefinition, type ProductDefinition } from "./products.ts";
import { RECIPES, type RecipeDefinition } from "./recipes.ts";
import { ROUTES, type RouteDefinition } from "./routes.ts";
import { parseScenario, type ScenarioDefinition } from "./scenario.ts";
import { SUPPLIERS, type SupplierDefinition } from "./suppliers.ts";
import { VEHICLES, type VehicleDefinition } from "./vehicles.ts";

export * from "./buyers.ts";
export * from "./equipment.ts";
export * from "./facilities.ts";
export * from "./map.ts";
export * from "./markets.ts";
export * from "./pacing.ts";
export * from "./personnel.ts";
export * from "./products.ts";
export * from "./recipes.ts";
export * from "./routes.ts";
export * from "./scenario.ts";
export * from "./suppliers.ts";
export * from "./vehicles.ts";

/** Recorded in saves for diagnostics (ADR 0009). Bump when tuning changes. */
export const GAME_DATA_VERSION = "0.1.0-t02d-market";

/** Every static definition, in one object the simulation's systems are built from. */
export interface GameData {
  readonly version: string;
  readonly products: readonly ProductDefinition[];
  readonly materials: readonly MaterialDefinition[];
  readonly equipment: readonly EquipmentDefinition[];
  readonly recipes: readonly RecipeDefinition[];
  readonly characters: readonly CharacterDefinition[];
  readonly workforce: WorkforceDefinition;
  readonly markets: readonly MarketDefinition[];
  readonly buyers: readonly BuyerDefinition[];
  readonly suppliers: readonly SupplierDefinition[];
  readonly routes: readonly RouteDefinition[];
  readonly vehicles: readonly VehicleDefinition[];
  readonly locations: readonly LocationDefinition[];
  readonly facilities: readonly FacilityDefinition[];
  readonly facilityProduction: readonly FacilityProductionDefinition[];
}

export const GAME_DATA: GameData = {
  version: GAME_DATA_VERSION,
  products: PRODUCTS,
  materials: MATERIALS,
  equipment: EQUIPMENT,
  recipes: RECIPES,
  characters: CHARACTERS,
  workforce: WORKFORCE,
  markets: MARKETS,
  buyers: BUYERS,
  suppliers: SUPPLIERS,
  routes: ROUTES,
  vehicles: VEHICLES,
  locations: LOCATIONS,
  facilities: FACILITIES,
  facilityProduction: FACILITY_PRODUCTION,
};

/** The First Shipment scenario (S0 placeholder; T05 owns the real one). */
export const FIRST_SHIPMENT_SCENARIO: ScenarioDefinition = parseScenario(firstShipmentJson);
