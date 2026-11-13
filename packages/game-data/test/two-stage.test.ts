// ADR 0029 decision 2's game-data and load validation (task TS1, #243). PLACEHOLDER values.
import { asId, tick, TICKS_PER_DAY } from "@eov/contracts";
import { describe, expect, it } from "vitest";
import {
  ACTIVITY_DURATIONS,
  BASIC_MOONSHINE_RECIPE,
  COMPETENCE_DURATION_PPM,
  DISTILL_ORDER_DEFAULTS,
  DISTILLERY_MAIN,
  FACILITY_PRODUCTION,
  FacilityDataError,
  FIRST_SHIPMENT_SCENARIO,
  GAME_DATA,
  longestIntervalMinutes,
  PresenceDataError,
  PRESENCE,
  RecipeDataError,
  RECIPES,
  RIVERSIDE_WAREHOUSE,
  ROLE_TERMS,
  STANDARD_MOONSHINE_RECIPE,
  ScenarioError,
  THE_FIRST_HIRE_SCENARIO,
  TIRED_DURATION_PPM,
  parseScenario,
  scaledTicks,
  validateFacilityProduction,
  validateOpeningWashes,
  validatePresence,
  validateRecipes,
  validateTwoStageRuns,
  type RecipeDefinition,
  type ScenarioDefinition,
  type TwoStageRunInputs,
} from "../src/index.ts";
import theFirstHireJson from "../src/scenarios/the-first-hire.json" with { type: "json" };

const basic = RECIPES.find((r) => r.id === BASIC_MOONSHINE_RECIPE)!;
const withTerms = (fermentTicks: number, casesPerBarrel: number): RecipeDefinition => ({ ...basic, twoStage: { fermentTicks, casesPerBarrel } });

const shipped: TwoStageRunInputs = {
  recipes: RECIPES,
  distillTicks: ACTIVITY_DURATIONS.DISTILL,
  tiredDurationPpm: TIRED_DURATION_PPM,
  competenceDurationPpm: COMPETENCE_DURATION_PPM,
  distillerWorkingHours: ROLE_TERMS.DISTILLER.workingHours,
  orderDefaultBatchSize: DISTILL_ORDER_DEFAULTS.batchSize,
};

describe("two-stage values (ADR 0029 decision 2, PLACEHOLDER)", () => {
  it("gives both recipes 4 days 12 h of fermentation and 10 cases a barrel", () => {
    for (const id of [BASIC_MOONSHINE_RECIPE, STANDARD_MOONSHINE_RECIPE]) {
      expect(RECIPES.find((r) => r.id === id)!.twoStage).toEqual({ fermentTicks: 6_480, casesPerBarrel: 10 });
    }
    expect(GAME_DATA.recipes).toBe(RECIPES);
  });

  it("gives Hollow Creek 4 barrels and the warehouse none", () => {
    const barrels = Object.fromEntries(FACILITY_PRODUCTION.map((f) => [f.facilityId, f.barrels]));
    expect(barrels).toEqual({ [DISTILLERY_MAIN]: 4, [RIVERSIDE_WAREHOUSE]: 0 });
  });

  it("makes MASH 30 minutes and DISTILL 8 hours", () => {
    expect(ACTIVITY_DURATIONS.MASH).toBe(30);
    expect(ACTIVITY_DURATIONS.DISTILL).toBe(480);
    expect(PRESENCE.activityDurations).toBe(ACTIVITY_DURATIONS);
  });

  it("keeps every run inside 6–12 hours at the placeholders: 384 to 720 ticks", () => {
    expect(scaledTicks(480, COMPETENCE_DURATION_PPM.atHundred)).toBe(384);
    expect(scaledTicks(480, COMPETENCE_DURATION_PPM.atZero)).toBe(672);
    expect(scaledTicks(480, TIRED_DURATION_PPM)).toBe(720);
    expect(scaledTicks(480, 1_000_000)).toBe(480);
    expect(validateTwoStageRuns(shipped)).toBe(shipped);
  });

  it("has no opening washes in either scenario yet (R1, #176, sets the stagger)", () => {
    for (const s of [FIRST_SHIPMENT_SCENARIO, THE_FIRST_HIRE_SCENARIO]) for (const f of s.facilities) expect(f.washes).toBeUndefined();
  });
});

describe("recipe validation (ADR 0029 decision 2)", () => {
  it.each([
    [5_760, true],
    [7_200, true],
    [5_759, false],
    [7_201, false],
    [6_480.5, false],
  ])("fermentTicks %d: valid %s", (fermentTicks, valid) => {
    const run = () => validateRecipes([withTerms(fermentTicks, 10)]);
    if (valid) expect(run()).toHaveLength(1);
    else expect(run).toThrow(RecipeDataError);
  });

  it("requires a whole casesPerBarrel of at least 1", () => {
    expect(validateRecipes([withTerms(6_480, 1)])).toHaveLength(1);
    expect(() => validateRecipes([withTerms(6_480, 0)])).toThrow(/casesPerBarrel/);
    expect(() => validateRecipes([withTerms(6_480, 2.5)])).toThrow(/casesPerBarrel/);
  });

  it("checks the fermentation range against TICKS_PER_DAY", () => {
    expect(4 * TICKS_PER_DAY).toBe(5_760);
    expect(5 * TICKS_PER_DAY).toBe(7_200);
  });
});

describe("facility and presence validation (ADR 0029 decision 2)", () => {
  it("requires whole, non-negative barrels", () => {
    const spec = FACILITY_PRODUCTION[0]!;
    expect(validateFacilityProduction([{ ...spec, barrels: 0 }])).toHaveLength(1);
    expect(() => validateFacilityProduction([{ ...spec, barrels: -1 }])).toThrow(FacilityDataError);
    expect(() => validateFacilityProduction([{ ...spec, barrels: 1.5 }])).toThrow(FacilityDataError);
  });

  it("requires MASH ≥ 1", () => {
    expect(() => validatePresence({ ...PRESENCE, activityDurations: { ...ACTIVITY_DURATIONS, MASH: 0 } })).toThrow(PresenceDataError);
    expect(validatePresence({ ...PRESENCE, activityDurations: { ...ACTIVITY_DURATIONS, MASH: 1 } }).activityDurations.MASH).toBe(1);
  });
});

describe("run validation across modules (ADR 0029 decision 2)", () => {
  it("allows DISTILL from 449 to 480 with today's factors", () => {
    for (const distillTicks of [449, 460, 480]) expect(() => validateTwoStageRuns({ ...shipped, distillTicks })).not.toThrow();
    // ceil(448 × 0.8) = 359: a competence-100 Distiller's run would be under 6 hours.
    expect(() => validateTwoStageRuns({ ...shipped, distillTicks: 448 })).toThrow(/fastest.*359/);
    // ceil(481 × 1.5) = 722: a tired founder's run would be over 12 hours.
    expect(() => validateTwoStageRuns({ ...shipped, distillTicks: 481 })).toThrow(/slowest.*722/);
  });

  it("counts the rested founder at 1×, so a competence range above 1× still can't go under 6 hours", () => {
    // Both competence ends above 1×: the fastest operator is the rested founder.
    const slowHands = { ...shipped, competenceDurationPpm: { atZero: 1_200_000, atHundred: 1_100_000 }, tiredDurationPpm: 1_200_000, distillTicks: 360 };
    expect(() => validateTwoStageRuns(slowHands)).not.toThrow();
    expect(() => validateTwoStageRuns({ ...slowHands, distillTicks: 359 })).toThrow(/fastest.*359/);
  });

  it("counts every slow factor, including a competence end slower than the tired founder", () => {
    const sluggish = { ...shipped, competenceDurationPpm: { atZero: 1_600_000, atHundred: 800_000 } };
    // ceil(480 × 1.6) = 768 > 720.
    expect(() => validateTwoStageRuns(sluggish)).toThrow(/slowest.*768/);
  });

  it("fits a Distiller's slowest run in their longest working interval", () => {
    expect(longestIntervalMinutes(ROLE_TERMS.DISTILLER.workingHours)).toBe(840);
    expect(longestIntervalMinutes([{ opensAtMinute: 22 * 60, closesAtMinute: 6 * 60 }])).toBe(480);
    // ceil(480 × 1.4) = 672: fits 06:00–18:00 (720), not 06:00–17:00 (660).
    expect(() => validateTwoStageRuns({ ...shipped, distillerWorkingHours: [{ opensAtMinute: 360, closesAtMinute: 1_080 }] })).not.toThrow();
    expect(() => validateTwoStageRuns({ ...shipped, distillerWorkingHours: [{ opensAtMinute: 360, closesAtMinute: 1_020 }] })).toThrow(/doesn't fit/);
    // Two short intervals don't add up to one long one.
    expect(() =>
      validateTwoStageRuns({
        ...shipped,
        distillerWorkingHours: [
          { opensAtMinute: 360, closesAtMinute: 720 },
          { opensAtMinute: 780, closesAtMinute: 1_200 },
        ],
      }),
    ).toThrow(/doesn't fit/);
  });

  it("requires the order form's default batch to fill at least one barrel of every recipe", () => {
    expect(() => validateTwoStageRuns({ ...shipped, orderDefaultBatchSize: 10 })).not.toThrow();
    expect(() => validateTwoStageRuns({ ...shipped, orderDefaultBatchSize: 9 })).toThrow(/batchSize/);
    expect(() => validateTwoStageRuns({ ...shipped, recipes: [withTerms(6_480, 12)] })).toThrow(/casesPerBarrel \(12\)/);
  });
});

describe("opening washes (ADR 0029 decisions 2 and 15)", () => {
  const raw = theFirstHireJson as unknown as Record<string, unknown>;
  const withWashes = (washes: unknown): ScenarioDefinition =>
    parseScenario({ ...raw, facilities: [{ id: "distillery-main", equipmentIds: ["copper-still"], workerCount: 1, washes }] });
  const check = (s: ScenarioDefinition) => validateOpeningWashes(s, RECIPES, FACILITY_PRODUCTION);

  it("parses washes when present, and leaves the field out when absent", () => {
    const s = withWashes([
      { recipeId: "basic-moonshine", barrels: 2, readyAtTick: 1_000 },
      { recipeId: "basic-moonshine", barrels: 2, readyAtTick: 3_000 },
    ]);
    expect(s.facilities[0]!.washes).toEqual([
      { recipeId: BASIC_MOONSHINE_RECIPE, barrels: 2, readyAtTick: tick(1_000) },
      { recipeId: BASIC_MOONSHINE_RECIPE, barrels: 2, readyAtTick: tick(3_000) },
    ]);
    expect(check(s)).toBe(s);
    expect(Object.hasOwn(parseScenario(raw).facilities[0]!, "washes")).toBe(false);
  });

  it("accepts readyAtTick at both ends of [0, fermentTicks]", () => {
    expect(() => check(withWashes([{ recipeId: "basic-moonshine", barrels: 1, readyAtTick: 0 }]))).not.toThrow();
    expect(() => check(withWashes([{ recipeId: "basic-moonshine", barrels: 1, readyAtTick: 6_480 }]))).not.toThrow();
  });

  it.each([
    ["a readyAtTick past fermentTicks", [{ recipeId: "basic-moonshine", barrels: 1, readyAtTick: 6_481 }], /fermentTicks/],
    ["an unknown recipe", [{ recipeId: "gin", barrels: 1, readyAtTick: 0 }], /unknown recipe/],
    [
      "more barrels than the facility has",
      [
        { recipeId: "basic-moonshine", barrels: 3, readyAtTick: 0 },
        { recipeId: "standard-moonshine", barrels: 2, readyAtTick: 0 },
      ],
      /5 barrels, but distillery-main has 4/,
    ],
  ])("rejects %s", (_label, washes, message) => {
    expect(() => check(withWashes(washes))).toThrow(message);
    expect(() => check(withWashes(washes))).toThrow(ScenarioError);
  });

  it("rejects malformed washes when parsing", () => {
    expect(() => withWashes([{ recipeId: "basic-moonshine", barrels: 0, readyAtTick: 0 }])).toThrow(ScenarioError);
    expect(() => withWashes([{ recipeId: "basic-moonshine", barrels: 1, readyAtTick: -1 }])).toThrow(ScenarioError);
    expect(() => withWashes([{ recipeId: "basic-moonshine", barrels: 1 }])).toThrow(ScenarioError);
    expect(() => withWashes({ recipeId: "basic-moonshine" })).toThrow(ScenarioError);
  });

  it("rejects washes at a facility with no production spec", () => {
    const s = withWashes([{ recipeId: "basic-moonshine", barrels: 1, readyAtTick: 0 }]);
    const elsewhere: ScenarioDefinition = { ...s, facilities: [{ ...s.facilities[0]!, id: asId("Facility", "nowhere") }] };
    expect(() => check(elsewhere)).toThrow(/no production spec/);
  });
});
