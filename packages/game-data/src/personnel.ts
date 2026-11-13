// Leaders and the generic workforce (T02c2, issue #63; GDD §10; ADR 0017 decisions 7, 9, 10),
// families (T05b, issue #101; ADR 0020 decision 12), and employees and hiring
// (EM1, #210; ADR 0025 decisions 1, 3, 5, 6, 7 and 8, as amended by ADR 0028).
// Definition types per ADR 0012. With founder rules off, the family's leaders
// are every character here; with them on, the founder plus the employees.
// PLACEHOLDER values: T07a/T07 tune wages; skill and loyalty have no mechanical
// effect in M001. The employee tables are PLACEHOLDER tuning for R1 (#176),
// PT2 and PT3, except where a comment says #209 approved them.
//
// The employee tables are read only with `founderRules: true` (E1, #180), and
// validated when this module loads: a bad table throws PersonnelDataError
// before any game starts.

import {
  asId,
  cents,
  compareIds,
  EMPLOYEE_ROLES,
  isValidId,
  TICKS_PER_DAY,
  type CharacterId,
  type DistillOrderTerms,
  type EmployeeRole,
  type FamilyId,
  type LocationId,
  type Money,
} from "@eov/contracts";
import { LOCATIONS, MILLERS_FEED_LOCATION, type LocationDefinition } from "./map.ts";
import { FULL_REST_TICKS, hoursIntervalsProblem, type PlaceHoursInterval } from "./presence.ts";

/** A family's display name, kept apart from its ID so custom names stay possible (#99, point 2). */
export interface FamilyDefinition {
  readonly id: FamilyId;
  readonly name: string;
}

export const KERRIGAN = asId("Family", "kerrigan");

/** "The Kerrigans" is final for M001 (#99, point 2). */
export const FAMILIES: readonly FamilyDefinition[] = [{ id: KERRIGAN, name: "The Kerrigans" }];

export interface CharacterDefinition {
  readonly id: CharacterId;
  readonly name: string;
  readonly role: "FOUNDER" | "FOREMAN";
  /** 0–100. Shown in the snapshot; no mechanical effect in M001. */
  readonly skill: number;
  /** 0–100. Shown in the snapshot; no mechanical effect in M001. */
  readonly loyalty: number;
  /** Expensed at each midnight (ADR 0017 decision 9). */
  readonly dailyWage: Money;
}

export interface WorkforceDefinition {
  /** Daily wage of one generic worker, expensed at each midnight. */
  readonly workerDailyWage: Money;
}

export const CHARACTERS: readonly CharacterDefinition[] = [
  { id: asId("Character", "thomas-kerrigan"), name: "Thomas Kerrigan", role: "FOUNDER", skill: 60, loyalty: 100, dailyWage: cents(0) }, // PLACEHOLDER
  { id: asId("Character", "walt-hagen"), name: "Walt Hagen", role: "FOREMAN", skill: 55, loyalty: 70, dailyWage: cents(300) }, // PLACEHOLDER
];

export const WORKFORCE: WorkforceDefinition = {
  workerDailyWage: cents(200), // PLACEHOLDER
};

// ---------------------------------------------------------------------------
// Employees and hiring (ADR 0025, as amended by ADR 0028)
// ---------------------------------------------------------------------------

export class PersonnelDataError extends Error {
  override readonly name = "PersonnelDataError";
}

/** Someone the family might hire (ADR 0025 decision 1). Static identity; being employed is state. */
export interface CandidateDefinition {
  readonly id: CharacterId;
  readonly name: string;
  readonly roles: readonly EmployeeRole[];
  /** The true competence is drawn once per game in [min, max] (ADR 0025 decision 3). min === max fixes it. 0–100. */
  readonly competence: { readonly min: number; readonly max: number };
  /** Reserved for later milestones. Copied into EmployeeState at hire; no rule reads them in M002. 0–100. */
  readonly reliability: number;
  readonly loyalty: number;
}

/**
 * The people who might be met at a hiring place (ADR 0025 decision 1), sorted by
 * ID. Names only: no biography, trait or flavour field (ADR 0028 decision 4).
 * Walt Hagen keeps his M001 identity: the FOREMAN entry's CharacterId and name,
 * and his M001 skill as a fixed competence. The competence ranges, reliability
 * and loyalty are PLACEHOLDER tuning.
 */
export const CANDIDATE_POOL: readonly CandidateDefinition[] = [
  // #209: approved name
  { id: asId("Character", "eddie-novak"), name: "Eddie Novak", roles: ["DISTILLER"], competence: { min: 30, max: 80 }, reliability: 50, loyalty: 50 },
  // #209: approved name
  { id: asId("Character", "gus-lindqvist"), name: "Gus Lindqvist", roles: ["DISTILLER"], competence: { min: 20, max: 70 }, reliability: 50, loyalty: 50 },
  // #209: approved name
  { id: asId("Character", "mae-brennan"), name: "Mae Brennan", roles: ["DISTILLER"], competence: { min: 40, max: 90 }, reliability: 50, loyalty: 50 },
  // #209: approved name
  { id: asId("Character", "otto-krause"), name: "Otto Krause", roles: ["DISTILLER"], competence: { min: 35, max: 75 }, reliability: 50, loyalty: 50 },
  // #209: approved name
  { id: asId("Character", "walt-hagen"), name: "Walt Hagen", roles: ["DISTILLER"], competence: { min: 55, max: 55 }, reliability: 50, loyalty: 50 },
];

/** Where candidates for a role can be met (ADR 0025 decision 3, ADR 0028 decision 4). */
export interface HiringPlaceDefinition {
  readonly locationId: LocationId;
  readonly roles: readonly EmployeeRole[];
}

export const HIRING_PLACES: readonly HiringPlaceDefinition[] = [
  // #209 §1, approved: Miller's Feed & Seed, by word of mouth. Miller knows who's looking for work.
  { locationId: MILLERS_FEED_LOCATION, roles: ["DISTILLER"] },
];

/** A role's terms of employment (ADR 0025 decision 3, amended by ADR 0028 decisions 1 and 4). */
export interface RoleTerms {
  /** The asking wage runs from min to max with the estimate's midpoint. */
  readonly dailyWage: { readonly min: Money; readonly max: Money };
  /** Paid in cash at hire: the signing payment. */
  readonly signingCost: Money;
  readonly slateSize: number;
  /** The width (high − low) of a candidate's estimate, drawn per meeting in [min, max] (ADR 0028 decision 4). */
  readonly estimateSpread: { readonly min: number; readonly max: number };
  /** Time from hire until they're at the station and acting. */
  readonly reportingDelayTicks: number;
  /**
   * When people in this role work, answer the phone and call in: minute-of-day
   * intervals, read as PLACE_HOURS is (ADR 0023 decision 6). Outside them they're
   * off duty (ADR 0028 decision 1).
   */
  readonly workingHours: readonly PlaceHoursInterval[];
}

/** Whole hours to a minute-of-day interval, as presence.ts's own (unexported) helper does. */
const hours = (opensAtHour: number, closesAtHour: number): PlaceHoursInterval => ({
  opensAtMinute: opensAtHour * 60,
  closesAtMinute: closesAtHour * 60,
});

export const ROLE_TERMS: Readonly<Record<EmployeeRole, RoleTerms>> = {
  DISTILLER: {
    dailyWage: { min: cents(300), max: cents(600) }, // PLACEHOLDER (R1)
    signingCost: cents(2_500), // PLACEHOLDER (R1)
    slateSize: 2, // PLACEHOLDER
    estimateSpread: { min: 20, max: 50 }, // PLACEHOLDER (ADR 0028 decision 4)
    reportingDelayTicks: 120, // PLACEHOLDER: two hours to get out to the still
    workingHours: [hours(6, 20)], // PLACEHOLDER (ADR 0028 decision 1): 06:00–20:00
  },
};

/** How an estimate's shape reads as a band (ADR 0028 decision 4). The band copy is the human's (#209). */
export interface CompetenceBandThresholds {
  /** An estimate at least this wide (high − low) is UNCERTAIN, whatever its midpoint. */
  readonly uncertainAtLeast: number;
  /** A narrower estimate whose midpoint is below this is LOW. */
  readonly moderateFrom: number;
  /** A narrower estimate whose midpoint is at or above this is HIGH; in between, MODERATE. */
  readonly highFrom: number;
}

/** PLACEHOLDER thresholds (R1, PT2). */
export const COMPETENCE_BANDS: CompetenceBandThresholds = { uncertainAtLeast: 40, moderateFrom: 40, highFrom: 65 };

/** A new slate every this many ticks (ADR 0025 decision 3). PLACEHOLDER: three days. */
export const CANDIDATE_SLATE_TICKS = 4_320;

/** A standing order's spending cap is per this many ticks, counted from tick 0 (ADR 0025 decision 5). PLACEHOLDER: a week. */
export const SPENDING_PERIOD_TICKS = 10_080;

/** What the order form starts from (ADR 0025 decision 5, ADR 0028 decision 5). The simulation reads only the terms sent. */
export type DistillOrderDefaults = Omit<DistillOrderTerms, "kind" | "recipeId">;

/** PLACEHOLDER (R1): keep 20 on hand, batches of 10, a $300 cap a week (batch costs only), phone about problems. */
export const DISTILL_ORDER_DEFAULTS: DistillOrderDefaults = {
  keepOnHand: 20,
  batchSize: 10,
  spendingCap: cents(30_000),
  callWhen: "PROBLEMS",
};

/** Interpolation ends for a competence-scaled factor, in parts per million. */
export interface CompetencePpm {
  readonly atZero: number;
  readonly atHundred: number;
}

/**
 * Competence sets an employee's batch time (ADR 0025 decision 6): the duration ×
 * ppm / 1 000 000, rounded up, with ppm interpolated from atZero (competence 0)
 * to atHundred (competence 100). PLACEHOLDER: 1.4× to 0.8× of the founder's time.
 */
export const COMPETENCE_DURATION_PPM: CompetencePpm = { atZero: 1_400_000, atHundred: 800_000 };

/** EMPLOYEE_PERFORMANCE reveals the true competence once batchesRun reaches this (ADR 0025 decision 8). PLACEHOLDER. */
export const COMPETENCE_REVEAL_BATCHES = 1;

/** Lines kept in a pending report; older ones drop and are counted (ADR 0025 decision 7). PLACEHOLDER. */
export const REPORT_LINE_LIMIT = 20;

/** The employee tables, in one bundle `GameData.personnel` carries (camelCase, as `PhoneData` does). */
export interface PersonnelData {
  readonly candidatePool: readonly CandidateDefinition[];
  readonly hiringPlaces: readonly HiringPlaceDefinition[];
  readonly roleTerms: Readonly<Record<EmployeeRole, RoleTerms>>;
  readonly competenceBands: CompetenceBandThresholds;
  readonly candidateSlateTicks: number;
  readonly spendingPeriodTicks: number;
  readonly distillOrderDefaults: DistillOrderDefaults;
  readonly competenceDurationPpm: CompetencePpm;
  readonly competenceRevealBatches: number;
  readonly reportLineLimit: number;
}

/** The minutes of the day (0..1439) inside some interval, counted minute by minute (ADR 0028 decision 1). */
export function onDutyMinutesPerDay(intervals: readonly PlaceHoursInterval[]): number {
  let minutes = 0;
  for (let minute = 0; minute < TICKS_PER_DAY; minute++) {
    const inside = intervals.some(({ opensAtMinute: open, closesAtMinute: close }) =>
      open < close ? minute >= open && minute < close : minute >= open || minute < close,
    );
    if (inside) minutes++;
  }
  return minutes;
}

/**
 * Checks the employee tables (ADR 0025 decisions 1 and 3, ADR 0028 decisions 1 and
 * 4). Returns them unchanged; throws PersonnelDataError.
 * - the pool: valid IDs, sorted and unique; at least one known role each;
 *   competence ranges whole, within 0–100 with min ≤ max; reliability and loyalty
 *   whole, 0–100; an entry sharing an ID with CHARACTERS has its name; none is the
 *   FOUNDER; and for each role, at least `slateSize` people, so a slate drawn with
 *   no one employed is never short;
 * - hiring places: known locations, at most one entry each, known roles; every
 *   role has at least one;
 * - role terms, for every role: whole, non-negative wages with min ≤ max, signing
 *   cost and reporting delay; a slate of at least 1; an estimate spread with
 *   0 ≤ min ≤ max ≤ 100 and min < uncertainAtLeast ≤ max, so the fourth band can
 *   appear and doesn't always; working hours that pass the place-hours interval
 *   checks, on duty at least 1 and at most TICKS_PER_DAY − FULL_REST_TICKS minutes
 *   a day (no role is on duty day and night, #209 §5);
 * - bands: 0 < moderateFrom < highFrom ≤ 100 and 1 ≤ uncertainAtLeast ≤ 100;
 * - the slate and spending periods are at least 1 tick; the order defaults are
 *   in shape (keepOnHand ≥ 0, batchSize ≥ 1, spendingCap ≥ 0); the competence
 *   pace factors are at least 1 ppm; the reveal count is at least 0 and the
 *   report line limit at least 1.
 */
export function validatePersonnel(
  data: PersonnelData,
  characters: readonly CharacterDefinition[] = CHARACTERS,
  locations: readonly LocationDefinition[] = LOCATIONS,
): PersonnelData {
  const whole = (name: string, value: number, min: number, max = Number.MAX_SAFE_INTEGER) => {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new PersonnelDataError(`${name} must be a whole number in ${min}..${max}, got ${value}`);
  };
  const knownRole = (name: string, role: EmployeeRole) => {
    if (!EMPLOYEE_ROLES.includes(role)) throw new PersonnelDataError(`${name}: unknown role ${role}`);
  };

  // The bands first: the role terms' spread check reads them.
  const bands = data.competenceBands;
  whole("COMPETENCE_BANDS.uncertainAtLeast", bands.uncertainAtLeast, 1, 100);
  whole("COMPETENCE_BANDS.moderateFrom", bands.moderateFrom, 1, 100);
  whole("COMPETENCE_BANDS.highFrom", bands.highFrom, 1, 100);
  if (bands.moderateFrom >= bands.highFrom) throw new PersonnelDataError("COMPETENCE_BANDS: moderateFrom must be below highFrom");

  if (Object.keys(data.roleTerms).length !== EMPLOYEE_ROLES.length) throw new PersonnelDataError("ROLE_TERMS has an unknown role");
  for (const role of EMPLOYEE_ROLES) {
    const terms = data.roleTerms[role] as RoleTerms | undefined;
    const where = `ROLE_TERMS.${role}`;
    if (!terms) throw new PersonnelDataError(`${where} is missing`);
    whole(`${where}.dailyWage.min`, terms.dailyWage.min, 0);
    whole(`${where}.dailyWage.max`, terms.dailyWage.max, terms.dailyWage.min);
    whole(`${where}.signingCost`, terms.signingCost, 0);
    whole(`${where}.slateSize`, terms.slateSize, 1);
    whole(`${where}.reportingDelayTicks`, terms.reportingDelayTicks, 0);
    whole(`${where}.estimateSpread.min`, terms.estimateSpread.min, 0, 100);
    whole(`${where}.estimateSpread.max`, terms.estimateSpread.max, terms.estimateSpread.min, 100);
    if (!(terms.estimateSpread.min < bands.uncertainAtLeast && bands.uncertainAtLeast <= terms.estimateSpread.max)) {
      throw new PersonnelDataError(
        `${where}.estimateSpread ${terms.estimateSpread.min}..${terms.estimateSpread.max} must have min < COMPETENCE_BANDS.uncertainAtLeast (${bands.uncertainAtLeast}) ≤ max`,
      );
    }
    const problem = hoursIntervalsProblem(terms.workingHours);
    if (problem !== null) throw new PersonnelDataError(`${where}.workingHours: ${problem}`);
    const onDuty = onDutyMinutesPerDay(terms.workingHours);
    const most = TICKS_PER_DAY - FULL_REST_TICKS;
    if (onDuty < 1 || onDuty > most) throw new PersonnelDataError(`${where}.workingHours: on duty ${onDuty} minutes a day; it must be 1..${most}`);
  }

  const founderIds = new Set<string>(characters.filter((c) => c.role === "FOUNDER").map((c) => c.id));
  const characterNames = new Map<string, string>(characters.map((c) => [c.id, c.name]));
  data.candidatePool.forEach((candidate, i) => {
    const where = `CANDIDATE_POOL.${candidate.id}`;
    if (!isValidId(candidate.id)) throw new PersonnelDataError(`CANDIDATE_POOL: invalid ID ${candidate.id}`);
    const previous = data.candidatePool[i - 1];
    if (previous && compareIds(previous.id, candidate.id) >= 0) throw new PersonnelDataError("CANDIDATE_POOL needs unique IDs, sorted with compareIds");
    if (founderIds.has(candidate.id)) throw new PersonnelDataError(`${where} is the founder`);
    const known = characterNames.get(candidate.id);
    if (known !== undefined && known !== candidate.name) throw new PersonnelDataError(`${where} is named ${candidate.name}, but CHARACTERS names them ${known}`);
    if (candidate.roles.length === 0) throw new PersonnelDataError(`${where} has no roles`);
    for (const role of candidate.roles) knownRole(where, role);
    if (new Set(candidate.roles).size !== candidate.roles.length) throw new PersonnelDataError(`${where} repeats a role`);
    whole(`${where}.competence.min`, candidate.competence.min, 0, 100);
    whole(`${where}.competence.max`, candidate.competence.max, candidate.competence.min, 100);
    whole(`${where}.reliability`, candidate.reliability, 0, 100);
    whole(`${where}.loyalty`, candidate.loyalty, 0, 100);
  });
  for (const role of EMPLOYEE_ROLES) {
    const pool = data.candidatePool.filter((c) => c.roles.includes(role)).length;
    const slateSize = data.roleTerms[role].slateSize;
    if (pool < slateSize) throw new PersonnelDataError(`CANDIDATE_POOL has ${pool} ${role} candidates; a slate needs ${slateSize}`);
  }

  const knownLocations = new Set<string>(locations.map((l) => l.id));
  const places = new Set<string>();
  for (const place of data.hiringPlaces) {
    const where = `HIRING_PLACES.${place.locationId}`;
    if (!knownLocations.has(place.locationId)) throw new PersonnelDataError(`HIRING_PLACES: unknown location ${place.locationId}`);
    if (places.has(place.locationId)) throw new PersonnelDataError(`HIRING_PLACES repeats ${place.locationId}`);
    places.add(place.locationId);
    if (place.roles.length === 0) throw new PersonnelDataError(`${where} hires for no role`);
    for (const role of place.roles) knownRole(where, role);
  }
  for (const role of EMPLOYEE_ROLES) {
    if (!data.hiringPlaces.some((p) => p.roles.includes(role))) throw new PersonnelDataError(`HIRING_PLACES has no place for ${role}`);
  }

  whole("CANDIDATE_SLATE_TICKS", data.candidateSlateTicks, 1);
  whole("SPENDING_PERIOD_TICKS", data.spendingPeriodTicks, 1);
  whole("DISTILL_ORDER_DEFAULTS.keepOnHand", data.distillOrderDefaults.keepOnHand, 0);
  whole("DISTILL_ORDER_DEFAULTS.batchSize", data.distillOrderDefaults.batchSize, 1);
  whole("DISTILL_ORDER_DEFAULTS.spendingCap", data.distillOrderDefaults.spendingCap, 0);
  whole("COMPETENCE_DURATION_PPM.atZero", data.competenceDurationPpm.atZero, 1);
  whole("COMPETENCE_DURATION_PPM.atHundred", data.competenceDurationPpm.atHundred, 1);
  whole("COMPETENCE_REVEAL_BATCHES", data.competenceRevealBatches, 0);
  whole("REPORT_LINE_LIMIT", data.reportLineLimit, 1);
  return data;
}

/** The employee tables, validated. */
export const PERSONNEL_DATA: PersonnelData = validatePersonnel({
  candidatePool: CANDIDATE_POOL,
  hiringPlaces: HIRING_PLACES,
  roleTerms: ROLE_TERMS,
  competenceBands: COMPETENCE_BANDS,
  candidateSlateTicks: CANDIDATE_SLATE_TICKS,
  spendingPeriodTicks: SPENDING_PERIOD_TICKS,
  distillOrderDefaults: DISTILL_ORDER_DEFAULTS,
  competenceDurationPpm: COMPETENCE_DURATION_PPM,
  competenceRevealBatches: COMPETENCE_REVEAL_BATCHES,
  reportLineLimit: REPORT_LINE_LIMIT,
});
