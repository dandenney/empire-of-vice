// S0 stub: extended by T05 (progression, scenario, victory). Definition types per ADR 0012.
//
// A scenario is the versioned starting configuration: seed, start date (ADR 0012
// closes T01's gap: the scenario supplies `createSimulation`'s startDate), the
// opening balance sheet, and which static definitions are in play. Scenario files
// are JSON, so `parseScenario` checks them and brands their IDs and money.

import {
  asId,
  cents,
  type BuyerId,
  type EquipmentId,
  type FacilityId,
  type FamilyId,
  type Money,
  type ScenarioId,
  type SupplierId,
  type TierId,
  type UnlockId,
  type VehicleId,
} from "@eov/contracts";

/** A Gregorian calendar day. Structurally the simulation's `CalendarDay`. */
export interface ScenarioStartDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export interface ScenarioFacility {
  readonly id: FacilityId;
  /** Owned at the start, valued at each equipment definition's price. */
  readonly equipmentIds: readonly EquipmentId[];
  readonly workerCount: number;
}

export interface ScenarioDefinition {
  readonly id: ScenarioId;
  readonly name: string;
  readonly notes: string;
  readonly seed: number;
  /** Tick 0 is 00:00 on this day. */
  readonly startDate: ScenarioStartDate;
  /**
   * The parts of the opening balance sheet that aren't valued by a definition.
   * Equipment and vehicles are valued from their definitions; owner equity is
   * whatever balances the sheet (no opening liabilities in M001's stub).
   */
  readonly openingBalance: { readonly cash: Money; readonly buildings: Money };
  readonly family: {
    readonly id: FamilyId;
    readonly reputation: number;
    readonly tierId: TierId;
    readonly unlocked: readonly UnlockId[];
  };
  readonly facilities: readonly ScenarioFacility[];
  readonly vehicleIds: readonly VehicleId[];
  readonly supplierIds: readonly SupplierId[];
  readonly buyerIds: readonly BuyerId[];
}

export class ScenarioError extends TypeError {
  override readonly name = "ScenarioError";
}

type Raw = Readonly<Record<string, unknown>>;

function obj(value: unknown, path: string): Raw {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ScenarioError(`${path}: expected an object`);
  return value as Raw;
}

function arr(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new ScenarioError(`${path}: expected an array`);
  return value;
}

function str(value: unknown, path: string): string {
  if (typeof value !== "string") throw new ScenarioError(`${path}: expected a string`);
  return value;
}

function int(value: unknown, path: string, min: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
    throw new ScenarioError(`${path}: expected an integer >= ${min}`);
  }
  return value;
}

function ids<K extends Parameters<typeof asId>[0]>(kind: K, value: unknown, path: string) {
  return arr(value, path).map((v, i) => asId(kind, str(v, `${path}[${i}]`)));
}

/** Checks a scenario file and brands its values. Throws ScenarioError (or InvalidIdError) on bad input. */
export function parseScenario(raw: unknown): ScenarioDefinition {
  const s = obj(raw, "scenario");
  const date = obj(s["startDate"], "startDate");
  const opening = obj(s["openingBalance"], "openingBalance");
  const family = obj(s["family"], "family");
  return {
    id: asId("Scenario", str(s["id"], "id")),
    name: str(s["name"], "name"),
    notes: str(s["notes"], "notes"),
    seed: int(s["seed"], "seed", Number.MIN_SAFE_INTEGER),
    startDate: {
      year: int(date["year"], "startDate.year", 1),
      month: int(date["month"], "startDate.month", 1),
      day: int(date["day"], "startDate.day", 1),
    },
    openingBalance: {
      cash: cents(int(opening["cash"], "openingBalance.cash", 0)),
      buildings: cents(int(opening["buildings"], "openingBalance.buildings", 0)),
    },
    family: {
      id: asId("Family", str(family["id"], "family.id")),
      reputation: int(family["reputation"], "family.reputation", 0),
      tierId: asId("Tier", str(family["tierId"], "family.tierId")),
      unlocked: ids("Unlock", family["unlocked"], "family.unlocked"),
    },
    facilities: arr(s["facilities"], "facilities").map((f, i) => {
      const facility = obj(f, `facilities[${i}]`);
      return {
        id: asId("Facility", str(facility["id"], `facilities[${i}].id`)),
        equipmentIds: ids("Equipment", facility["equipmentIds"], `facilities[${i}].equipmentIds`),
        workerCount: int(facility["workerCount"], `facilities[${i}].workerCount`, 0),
      };
    }),
    vehicleIds: ids("Vehicle", s["vehicleIds"], "vehicleIds"),
    supplierIds: ids("Supplier", s["supplierIds"], "supplierIds"),
    buyerIds: ids("Buyer", s["buyerIds"], "buyerIds"),
  };
}
