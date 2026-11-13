// The employee tables (ADR 0025 decisions 1, 3, 5–8, as amended by ADR 0028; task EM1, #210).

import { asId, cents, EMPLOYEE_ROLES, TICKS_PER_DAY } from "@eov/contracts";
import { describe, expect, it } from "vitest";
import {
  ACTIVITY_DURATIONS,
  CANDIDATE_POOL,
  CANDIDATE_SLATE_TICKS,
  CHARACTERS,
  COMPETENCE_BANDS,
  COMPETENCE_DURATION_PPM,
  COMPETENCE_REVEAL_BATCHES,
  DISTILL_ORDER_DEFAULTS,
  FIRST_SHIPMENT_SCENARIO,
  FULL_REST_TICKS,
  GAME_DATA,
  HIRING_PLACES,
  KNOWLEDGE_VISIBILITY,
  MILLERS_FEED_LOCATION,
  onDutyMinutesPerDay,
  parseScenario,
  PERSONNEL_DATA,
  ScenarioError,
  PersonnelDataError,
  REPORT_LINE_LIMIT,
  ROLE_TERMS,
  SPENDING_PERIOD_TICKS,
  THE_FIRST_HIRE_SCENARIO,
  validatePersonnel,
  type PersonnelData,
  type RoleTerms,
} from "../src/index.ts";

const distiller: RoleTerms = PERSONNEL_DATA.roleTerms.DISTILLER;
const withDistiller = (terms: Partial<RoleTerms>): PersonnelData => ({ ...PERSONNEL_DATA, roleTerms: { DISTILLER: { ...distiller, ...terms } } });

describe("the candidate pool (ADR 0025 decision 1, ADR 0028 decision 4)", () => {
  it("holds the five Distillers #209 approved, sorted by ID", () => {
    expect(CANDIDATE_POOL.map((c) => c.name).sort()).toEqual(["Eddie Novak", "Gus Lindqvist", "Mae Brennan", "Otto Krause", "Walt Hagen"]);
    expect(CANDIDATE_POOL.map((c) => c.id)).toEqual(["eddie-novak", "gus-lindqvist", "mae-brennan", "otto-krause", "walt-hagen"]);
    for (const c of CANDIDATE_POOL) expect(c.roles).toEqual(["DISTILLER"]);
  });

  it("keeps Walt's M001 identity: the foreman's ID and name, and his skill as a fixed competence", () => {
    const foreman = CHARACTERS.find((c) => c.role === "FOREMAN")!;
    const walt = CANDIDATE_POOL.find((c) => c.id === foreman.id)!;
    expect(walt.name).toBe(foreman.name);
    expect(walt.competence).toEqual({ min: foreman.skill, max: foreman.skill });
  });

  it("has ADR 0025's PLACEHOLDER ranges, and inert reliability and loyalty", () => {
    expect(Object.fromEntries(CANDIDATE_POOL.map((c) => [c.id, c.competence]))).toEqual({
      "eddie-novak": { min: 30, max: 80 },
      "gus-lindqvist": { min: 20, max: 70 },
      "mae-brennan": { min: 40, max: 90 },
      "otto-krause": { min: 35, max: 75 },
      "walt-hagen": { min: 55, max: 55 },
    });
    for (const c of CANDIDATE_POOL) expect([c.reliability, c.loyalty]).toEqual([50, 50]);
  });
});

describe("hiring places, terms and the order form (PLACEHOLDER tuning)", () => {
  it("hires Distillers at Miller's Feed & Seed (#209 §1, approved)", () => {
    expect(HIRING_PLACES).toEqual([{ locationId: MILLERS_FEED_LOCATION, roles: ["DISTILLER"] }]);
  });

  it("has ADR 0025's Distiller terms, with ADR 0028's spread and working hours", () => {
    expect(ROLE_TERMS).toEqual({
      DISTILLER: {
        dailyWage: { min: cents(300), max: cents(600) },
        signingCost: cents(2_500),
        slateSize: 2,
        estimateSpread: { min: 20, max: 50 },
        reportingDelayTicks: 120,
        workingHours: [{ opensAtMinute: 6 * 60, closesAtMinute: 20 * 60 }],
      },
    });
    expect(Object.keys(ROLE_TERMS)).toEqual([...EMPLOYEE_ROLES]);
  });

  it("has the bands, periods, defaults and limits of ADR 0025 decision 17 and ADR 0028 decision 12", () => {
    expect(COMPETENCE_BANDS).toEqual({ uncertainAtLeast: 40, moderateFrom: 40, highFrom: 65 });
    expect(CANDIDATE_SLATE_TICKS).toBe(3 * TICKS_PER_DAY);
    expect(SPENDING_PERIOD_TICKS).toBe(7 * TICKS_PER_DAY);
    expect(DISTILL_ORDER_DEFAULTS).toEqual({ keepOnHand: 20, batchSize: 10, spendingCap: cents(30_000), callWhen: "PROBLEMS" });
    expect(COMPETENCE_DURATION_PPM).toEqual({ atZero: 1_400_000, atHundred: 800_000 });
    expect(COMPETENCE_REVEAL_BATCHES).toBe(1);
    expect(REPORT_LINE_LIMIT).toBe(20);
    expect([ACTIVITY_DURATIONS.HIRE, ACTIVITY_DURATIONS.BRIEF_EMPLOYEE]).toEqual([60, 15]);
  });

  it("bundles them in GAME_DATA.personnel", () => {
    expect(GAME_DATA.personnel).toBe(PERSONNEL_DATA);
    expect(PERSONNEL_DATA).toMatchObject({
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
  });

  it("counts on-duty minutes, across midnight too", () => {
    expect(onDutyMinutesPerDay(distiller.workingHours)).toBe(14 * 60);
    expect(onDutyMinutesPerDay([{ opensAtMinute: 22 * 60, closesAtMinute: 2 * 60 }])).toBe(4 * 60);
  });
});

describe("the reports' visibility rows (ADR 0025 decisions 7 and 8)", () => {
  it("shows a station's employees' performance in person, and the facility-party subjects by phone, message and report", () => {
    const facilityParty = ["FACILITY_STOCK", "FACILITY_OPERATIONS", "EMPLOYEE_PERFORMANCE"];
    expect(KNOWLEDGE_VISIBILITY.IN_PERSON.FACILITY).toContain("EMPLOYEE_PERFORMANCE");
    expect(KNOWLEDGE_VISIBILITY.PHONE.FACILITY).toEqual(facilityParty);
    expect(KNOWLEDGE_VISIBILITY.MESSAGE.FACILITY).toEqual(facilityParty);
    expect(KNOWLEDGE_VISIBILITY.REPORT).toEqual({ FACILITY: facilityParty, SUPPLIER: [], BUYER: [] });
  });
});

describe("the scenarios' first candidates (ADR 0025 decision 3)", () => {
  it("puts Walt on M002's first slate, and nobody on M001's", () => {
    expect(FIRST_SHIPMENT_SCENARIO.firstCandidates).toEqual([]);
    expect(THE_FIRST_HIRE_SCENARIO.firstCandidates).toEqual([asId("Character", "walt-hagen")]);
  });

  it("is required in a scenario file, as character IDs", () => {
    const json = JSON.parse(JSON.stringify(FIRST_SHIPMENT_SCENARIO)) as Record<string, unknown>;
    expect(parseScenario(json).firstCandidates).toEqual([]);
    expect(() => parseScenario({ ...json, firstCandidates: undefined })).toThrow(ScenarioError);
    expect(() => parseScenario({ ...json, firstCandidates: ["Walt Hagen"] })).toThrow(TypeError);
  });
});

describe("validatePersonnel (load validation)", () => {
  it("accepts the shipped tables", () => {
    expect(validatePersonnel(PERSONNEL_DATA)).toBe(PERSONNEL_DATA);
  });

  const bad: [string, PersonnelData, RegExp][] = [
    ["an unsorted pool", { ...PERSONNEL_DATA, candidatePool: [...CANDIDATE_POOL].reverse() }, /sorted/],
    ["a repeated candidate", { ...PERSONNEL_DATA, candidatePool: [CANDIDATE_POOL[0]!, CANDIDATE_POOL[0]!] }, /unique/],
    ["the founder as a candidate", { ...PERSONNEL_DATA, candidatePool: [{ ...CANDIDATE_POOL[0]!, id: asId("Character", "thomas-kerrigan") }] }, /founder/],
    ["Walt under another name", { ...PERSONNEL_DATA, candidatePool: CANDIDATE_POOL.map((c) => (c.id === "walt-hagen" ? { ...c, name: "Walter" } : c)) }, /CHARACTERS/],
    ["a candidate with no role", { ...PERSONNEL_DATA, candidatePool: CANDIDATE_POOL.map((c, i) => (i === 0 ? { ...c, roles: [] } : c)) }, /no roles/],
    ["a competence range upside down", { ...PERSONNEL_DATA, candidatePool: CANDIDATE_POOL.map((c, i) => (i === 0 ? { ...c, competence: { min: 80, max: 30 } } : c)) }, /competence/],
    ["a competence above 100", { ...PERSONNEL_DATA, candidatePool: CANDIDATE_POOL.map((c, i) => (i === 0 ? { ...c, competence: { min: 30, max: 101 } } : c)) }, /competence/],
    ["a loyalty above 100", { ...PERSONNEL_DATA, candidatePool: CANDIDATE_POOL.map((c, i) => (i === 0 ? { ...c, loyalty: 101 } : c)) }, /loyalty/],
    ["a pool smaller than a slate", { ...PERSONNEL_DATA, candidatePool: CANDIDATE_POOL.slice(0, 1) }, /slate needs 2/],
    ["a hiring place nowhere", { ...PERSONNEL_DATA, hiringPlaces: [{ locationId: asId("Location", "nowhere"), roles: ["DISTILLER"] }] }, /unknown location/],
    ["a hiring place twice", { ...PERSONNEL_DATA, hiringPlaces: [...HIRING_PLACES, ...HIRING_PLACES] }, /repeats/],
    ["no hiring place for the role", { ...PERSONNEL_DATA, hiringPlaces: [] }, /no place for DISTILLER/],
    ["a wage range upside down", withDistiller({ dailyWage: { min: cents(600), max: cents(300) } }), /dailyWage.max/],
    ["a negative signing cost", withDistiller({ signingCost: cents(-1) }), /signingCost/],
    ["an empty slate", withDistiller({ slateSize: 0 }), /slateSize/],
    ["a spread above 100", withDistiller({ estimateSpread: { min: 20, max: 101 } }), /estimateSpread.max/],
    ["a spread that's always uncertain", withDistiller({ estimateSpread: { min: 40, max: 50 } }), /uncertainAtLeast/],
    ["a spread that's never uncertain", withDistiller({ estimateSpread: { min: 20, max: 39 } }), /uncertainAtLeast/],
    ["no working hours", withDistiller({ workingHours: [] }), /no intervals/],
    ["working hours that aren't minutes", withDistiller({ workingHours: [{ opensAtMinute: 360, closesAtMinute: 1_440 }] }), /minute of the day/],
    [
      "on duty day and night",
      withDistiller({ workingHours: [{ opensAtMinute: 0, closesAtMinute: 1_439 }] }),
      new RegExp(`on duty 1439 minutes a day; it must be 1..${TICKS_PER_DAY - FULL_REST_TICKS}`),
    ],
    ["bands out of order", { ...PERSONNEL_DATA, competenceBands: { uncertainAtLeast: 40, moderateFrom: 65, highFrom: 40 } }, /moderateFrom/],
    ["a band threshold of 0", { ...PERSONNEL_DATA, competenceBands: { uncertainAtLeast: 0, moderateFrom: 40, highFrom: 65 } }, /uncertainAtLeast/],
    ["a slate period of 0", { ...PERSONNEL_DATA, candidateSlateTicks: 0 }, /CANDIDATE_SLATE_TICKS/],
    ["a spending period of 0", { ...PERSONNEL_DATA, spendingPeriodTicks: 0 }, /SPENDING_PERIOD_TICKS/],
    ["a default batch of 0", { ...PERSONNEL_DATA, distillOrderDefaults: { ...DISTILL_ORDER_DEFAULTS, batchSize: 0 } }, /batchSize/],
    ["a pace of 0", { ...PERSONNEL_DATA, competenceDurationPpm: { atZero: 0, atHundred: 800_000 } }, /atZero/],
    ["a report line limit of 0", { ...PERSONNEL_DATA, reportLineLimit: 0 }, /REPORT_LINE_LIMIT/],
  ];

  it.each(bad)("rejects %s", (_label, data, message) => {
    expect(() => validatePersonnel(data)).toThrow(PersonnelDataError);
    expect(() => validatePersonnel(data)).toThrow(message);
  });

  it("allows an off-duty window that crosses midnight", () => {
    const night = withDistiller({ workingHours: [{ opensAtMinute: 22 * 60, closesAtMinute: 6 * 60 }] });
    expect(validatePersonnel(night)).toBe(night);
  });
});
