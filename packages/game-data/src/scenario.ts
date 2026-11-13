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
  type CharacterId,
  type EquipmentId,
  type FacilityId,
  type FamilyId,
  type LocationId,
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
 * A route closure the scenario schedules at tick 0, always with a duration, so
 * M001 has no open-ended closures (ADR 0020 decision 12; an open-ended closure is
 * ended by any reopening of its route, ADR 0019).
 */
export interface ScenarioRouteClosure {
  readonly kind: "ROUTE_CLOSURE";
  readonly tick: Tick;
  readonly routeId: RouteId;
  readonly reason: Extract<ScheduledWorldEvent, { kind: "ROUTE_CLOSURE" }>["reason"];
  readonly durationTicks: number;
}

/**
 * A scheduled setback (issue #129): at `tick`, a loss of `netWorthSharePpm` parts
 * per million of net worth, capped at cash. The First Shipment doesn't schedule
 * one; the economy lab's setback scenario does. The range (1..1 000 000) is
 * checked at load.
 */
export interface ScenarioShakedown {
  readonly kind: "SHAKEDOWN";
  readonly tick: Tick;
  readonly reason: Extract<ScheduledWorldEvent, { kind: "SHAKEDOWN" }>["reason"];
  readonly netWorthSharePpm: number;
}

/** A world event the scenario schedules at tick 0: a route closure or a shakedown. */
export type ScenarioScheduledEvent = ScenarioRouteClosure | ScenarioShakedown;

const CLOSURE_REASONS: readonly ScenarioRouteClosure["reason"][] = ["RIVAL", "POLICE"];
const SCHEDULED_KINDS: readonly ScenarioScheduledEvent["kind"][] = ["ROUTE_CLOSURE", "SHAKEDOWN"];

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
  /**
   * Real milliseconds one game hour takes at 1× (ADR 0023 decision 9). The
   * worker's scheduler reads it from the loaded scenario. M001: 5 000
   * (REAL_MS_PER_GAME_HOUR_AT_1X); M002: 20 000.
   */
  readonly realMsPerGameHourAt1x: number;
  /**
   * Whether the founder's presence, time and rest rules apply (ADR 0023). Off,
   * the founder state exists but never gates anything and never changes, and
   * TRAVEL, REST and WAKE are accepted no-ops (decision 9). M001: false.
   */
  readonly founderRules: boolean;
  /** Where the founder starts (ADR 0023 decision 7). Checked against game-data at load. */
  readonly founderStartLocationId: LocationId;
  /**
   * Candidates on the first slate (slate index 0) of each of their roles, in this
   * order, ahead of the drawn ones (ADR 0025 decision 3). Read only with founder
   * rules on. M001: none; M002: Walt Hagen. Checked against the candidate pool at load.
   */
  readonly firstCandidates: readonly CharacterId[];
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

function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new ScenarioError(`${path}: expected true or false`);
  return value;
}

function ids<K extends Parameters<typeof asId>[0]>(kind: K, value: unknown, path: string) {
  return arr(value, path).map((v, i) => asId(kind, str(v, `${path}[${i}]`)));
}

function scheduledEvent(value: unknown, path: string): ScenarioScheduledEvent {
  const e = obj(value, path);
  const kind = str(e["kind"], `${path}.kind`);
  if (!SCHEDULED_KINDS.some((k) => k === kind)) throw new ScenarioError(`${path}.kind: expected one of ${SCHEDULED_KINDS.join(", ")}, got ${kind}`);
  const reason = str(e["reason"], `${path}.reason`);
  const known = CLOSURE_REASONS.find((r) => r === reason);
  if (known === undefined) throw new ScenarioError(`${path}.reason: expected one of ${CLOSURE_REASONS.join(", ")}`);
  if (kind === "SHAKEDOWN") {
    return {
      kind: "SHAKEDOWN",
      tick: tick(int(e["tick"], `${path}.tick`, 0)),
      reason: known,
      // The range (1..1 000 000 ppm) is checked at load, like the other ranges.
      netWorthSharePpm: int(e["netWorthSharePpm"], `${path}.netWorthSharePpm`, Number.MIN_SAFE_INTEGER),
    };
  }
  return {
    kind: "ROUTE_CLOSURE",
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
    realMsPerGameHourAt1x: int(s["realMsPerGameHourAt1x"], "realMsPerGameHourAt1x", 1),
    founderRules: bool(s["founderRules"], "founderRules"),
    founderStartLocationId: asId("Location", str(s["founderStartLocationId"], "founderStartLocationId")),
    firstCandidates: ids("Character", s["firstCandidates"], "firstCandidates"),
  };
}
