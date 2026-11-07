// Scenarios (T05b, issue #101; GDD §4; ADR 0020 decisions 1, 2, 12). Definition types per ADR 0012.
//
// A scenario is the versioned starting configuration: seed, start date (ADR 0012
// closes T01's gap: the scenario supplies `createSimulation`'s startDate), the
// opening balance sheet, the family's starting standing, which static
// definitions are in play, and the world events it schedules. Scenario files
// are JSON, so `parseScenario` checks their shape and brands their IDs and
// money. Checks against game-data (known routes, tiers, families, the starting
// unlocks) and the ranges of scheduled events happen when the simulation loads
// the scenario (`createInitialState`, ADR 0020 decision 12).

import {
  asId,
  cents,
  tick,
  type BuyerId,
  type EquipmentId,
  type FacilityId,
  type FamilyId,
  type Money,
  type RouteId,
  type ScenarioId,
  type ScheduledWorldEvent,
  type SupplierId,
  type Tick,
  type TierId,
  type UnlockId,
  type VehicleId,
} from "@eov/contracts";

/**
 * A world event the scenario schedules at tick 0. Only route closures, each with
 * a duration, so M001 has no open-ended closures (ADR 0020 decision 12; an
 * open-ended closure is ended by any reopening of its route, ADR 0019).
 */
export interface ScenarioRouteClosure {
  readonly kind: "ROUTE_CLOSURE";
  readonly tick: Tick;
  readonly routeId: RouteId;
  readonly reason: Extract<ScheduledWorldEvent, { kind: "ROUTE_CLOSURE" }>["reason"];
  readonly durationTicks: number;
}

export type ScenarioScheduledEvent = ScenarioRouteClosure;

const CLOSURE_REASONS: readonly ScenarioRouteClosure["reason"][] = ["RIVAL", "POLICE"];

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
   * whatever balances the sheet. No opening inventory or liabilities in M001
   * (ADR 0020 decision 1).
   */
  readonly openingBalance: { readonly cash: Money; readonly buildings: Money };
  readonly family: {
    readonly id: FamilyId;
    readonly reputation: number;
    /** The starting tier. It emits nothing (ADR 0020 decision 4). */
    readonly tierId: TierId;
    /** Exactly the unlocks of every tier up to and including `tierId`. */
    readonly unlocked: readonly UnlockId[];
  };
  readonly facilities: readonly ScenarioFacility[];
  readonly vehicleIds: readonly VehicleId[];
  readonly supplierIds: readonly SupplierId[];
  readonly buyerIds: readonly BuyerId[];
  /** Scheduled at tick 0, in this order. No `CONTRACT_OFFER`s: the contracts system supplies offers (ADR 0018). */
  readonly scheduledEvents: readonly ScenarioScheduledEvent[];
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

function scheduledEvent(value: unknown, path: string): ScenarioScheduledEvent {
  const e = obj(value, path);
  const kind = str(e["kind"], `${path}.kind`);
  if (kind !== "ROUTE_CLOSURE") throw new ScenarioError(`${path}.kind: expected ROUTE_CLOSURE, got ${kind}`);
  const reason = str(e["reason"], `${path}.reason`);
  const known = CLOSURE_REASONS.find((r) => r === reason);
  if (known === undefined) throw new ScenarioError(`${path}.reason: expected one of ${CLOSURE_REASONS.join(", ")}`);
  return {
    kind,
    tick: tick(int(e["tick"], `${path}.tick`, 0)),
    routeId: asId("Route", str(e["routeId"], `${path}.routeId`)),
    reason: known,
    // Ranges (tick ≥ 1, duration ≥ 1) are checked at load with the rest of the scenario.
    durationTicks: int(e["durationTicks"], `${path}.durationTicks`, Number.MIN_SAFE_INTEGER),
  };
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
    scheduledEvents: arr(s["scheduledEvents"], "scheduledEvents").map((e, i) => scheduledEvent(e, `scheduledEvents[${i}]`)),
  };
}
