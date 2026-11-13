// @eov/game-data: gameplay numbers (prices, wages, rates, thresholds) and scenarios.
//
// Each data file is named for the task that owns its real values:
// products/equipment/recipes/personnel (T02c), markets/buyers/suppliers (T02d),
// contracts (T02e), routes/vehicles/map (T03), scenario, progression, and
// families (T05b). Definition types live next to their data (ADR 0012). Every
// number is a PLACEHOLDER until T05g/T07 tune it, unless its file says otherwise.

import firstShipmentJson from "./scenarios/first-shipment.json" with { type: "json" };
import theFirstHireJson from "./scenarios/the-first-hire.json" with { type: "json" };
import { BUYERS, type BuyerDefinition } from "./buyers.ts";
import { CONTRACTS, type ContractsDefinition } from "./contracts.ts";
import { EQUIPMENT, type EquipmentDefinition } from "./equipment.ts";
import { FACILITY_PRODUCTION, type FacilityProductionDefinition } from "./facilities.ts";
import { FACILITIES, LOCATIONS, type FacilityDefinition, type LocationDefinition } from "./map.ts";
import { MARKETS, type MarketDefinition } from "./markets.ts";
import {
  CHARACTERS,
  FAMILIES,
  PERSONNEL_DATA,
  WORKFORCE,
  type CharacterDefinition,
  type FamilyDefinition,
  type PersonnelData,
  type WorkforceDefinition,
} from "./personnel.ts";
import { PHONE_DATA, type PhoneData } from "./phones.ts";
import { MATERIALS, PRODUCTS, type MaterialDefinition, type ProductDefinition } from "./products.ts";
import { PROGRESSION, type ProgressionDefinition } from "./progression.ts";
import { RECIPES, type RecipeDefinition } from "./recipes.ts";
import { ROUTES, type RouteDefinition } from "./routes.ts";
import { parseScenario, type ScenarioDefinition } from "./scenario.ts";
import { SUPPLIERS, type SupplierDefinition } from "./suppliers.ts";
import { VEHICLES, type VehicleDefinition } from "./vehicles.ts";

export * from "./buyers.ts";
export * from "./contracts.ts";
export * from "./deals.ts";
export * from "./equipment.ts";
export * from "./facilities.ts";
export * from "./knowledge.ts";
export * from "./map.ts";
export * from "./markets.ts";
export * from "./pacing.ts";
export * from "./personnel.ts";
export * from "./phones.ts";
export * from "./presence.ts";
export * from "./products.ts";
export * from "./progression.ts";
export * from "./recipes.ts";
export * from "./routes.ts";
export * from "./scenario.ts";
export * from "./suppliers.ts";
export * from "./vehicles.ts";

/**
 * Recorded in saves for diagnostics (ADR 0009). Bump when tuning changes.
 * 0.8.0 (PH1, #205): the phone, room and arrangement tables (ADR 0024, ADR 0027),
 * the MESSAGE visibility rows, and the knowledge tables SK1b started reading
 * (K1 review follow-up 5).
 * 0.9.0 (EM1, #210): the employee tables (ADR 0025, ADR 0028), the HIRE and
 * BRIEF_EMPLOYEE durations, the facility rows of the PHONE, MESSAGE and REPORT
 * visibility, and the scenarios' `firstCandidates`.
 */
export const GAME_DATA_VERSION = "0.9.0-em1-employees";

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
  readonly contracts: ContractsDefinition;
  readonly progression: ProgressionDefinition;
  readonly families: readonly FamilyDefinition[];
  /** Phones, calls, messages and arrangements (ADR 0024, ADR 0027 decision 17). Read only with founder rules on. */
  readonly phones: PhoneData;
  /**
   * Candidates, hiring places, role terms (working hours, estimate spread), the
   * bands and the standing-order tables (ADR 0025, ADR 0028 decision 11). Read
   * only with founder rules on. ADR 0028's `data.roleTerms` is `data.personnel.roleTerms`.
   */
  readonly personnel: PersonnelData;
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
  contracts: CONTRACTS,
  progression: PROGRESSION,
  families: FAMILIES,
  phones: PHONE_DATA,
  personnel: PERSONNEL_DATA,
};

/** The First Shipment scenario (GDD §4; ADR 0020 decisions 1, 2, 12). */
export const FIRST_SHIPMENT_SCENARIO: ScenarioDefinition = parseScenario(firstShipmentJson);

/**
 * The M002 scenario (milestone 002; ADR 0023): founder rules on, the founder
 * alone at Hollow Creek. Id and name PLACEHOLDER pending #232; every number is
 * PLACEHOLDER for R1 (#176).
 */
export const THE_FIRST_HIRE_SCENARIO: ScenarioDefinition = parseScenario(theFirstHireJson);
