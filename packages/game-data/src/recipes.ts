// Recipes (T02c1, PROD-001). Definition types per ADR 0012.
// PLACEHOLDER values. Basic moonshine keeps its S0 numbers: one case costs $11 to
// make (the GDD §8 production example's $30 + $10 labor and overhead per 10 cases);
// T07d (#126) moved its price, not its cost. T07d raised standard moonshine's labor
// so its price can sit well above basic's (a buyer almost never quotes basic higher)
// while its margin stays close; a case stays dearer than basic, so basic is still the
// cheapest restart (ADR 0020 decision 10). T07 tunes both recipes next (GDD §14.3).
//
// ADR 0029 (TS1, #243) gives every recipe its two-stage terms, read only under
// founder rules: fermentation in barrels, then a distillation run. PLACEHOLDER
// values for R1 (#176), PT2 and T-LAB, inside the human's ranges (decision 2).

import {
  asId,
  cents,
  ratio,
  TICKS_PER_DAY,
  TICKS_PER_HOUR,
  type EquipmentId,
  type MaterialLine,
  type Money,
  type ProductId,
  type QualityTier,
  type Ratio,
  type RecipeId,
} from "@eov/contracts";
import { COPPER_STILL, QC_STATION } from "./equipment.ts";
import type { CompetencePpm } from "./personnel.ts";
import type { PlaceHoursInterval } from "./presence.ts";
import { CORN, MOONSHINE, SUGAR } from "./products.ts";

/** A recipe's two-stage terms (ADR 0029 decision 2). Read only under founder rules. */
export interface TwoStageTerms {
  /** Fermentation: from the mash being set to the wash being ready, in ticks. Passive; nobody's competence or tiredness changes it. */
  readonly fermentTicks: number;
  /** Cases one barrel of this recipe's mash yields when distilled (the yield). Inputs per barrel = inputsPerCase × this. */
  readonly casesPerBarrel: number;
}

export interface RecipeDefinition {
  readonly id: RecipeId;
  readonly name: string;
  readonly productId: ProductId;
  readonly quality: QualityTier;
  /** Raw materials consumed per output case. */
  readonly inputsPerCase: readonly MaterialLine[];
  /** Production time per output case at 1× throughput, in ticks (game minutes). */
  readonly ticksPerCase: number;
  /** Labor capitalized into each case (FIN-001 production accounting). */
  readonly laborPerCase: Money;
  /** Overhead capitalized into each case. */
  readonly overheadPerCase: Money;
  /** The facility must own every one of these to run the recipe. */
  readonly requiredEquipmentIds: readonly EquipmentId[];
  /** Chance a run fails at completion (ADR 0017 decision 5). At 0 nothing is drawn. */
  readonly failureChance: Ratio;
  /** Read only under founder rules (ADR 0029). With them on, `ticksPerCase` isn't read. */
  readonly twoStage: TwoStageTerms;
}

export const BASIC_MOONSHINE_RECIPE = asId("Recipe", "basic-moonshine");
export const STANDARD_MOONSHINE_RECIPE = asId("Recipe", "standard-moonshine");

const RECIPE_TABLE: readonly RecipeDefinition[] = [
  {
    id: BASIC_MOONSHINE_RECIPE,
    name: "Basic moonshine",
    productId: MOONSHINE,
    quality: "basic",
    inputsPerCase: [
      { materialId: CORN, quantity: 2 }, // PLACEHOLDER
      { materialId: SUGAR, quantity: 1 }, // PLACEHOLDER
    ],
    ticksPerCase: 144, // PLACEHOLDER: 10 cases per game day at 1×
    laborPerCase: cents(300), // PLACEHOLDER
    overheadPerCase: cents(100), // PLACEHOLDER
    requiredEquipmentIds: [COPPER_STILL],
    failureChance: ratio(0), // PLACEHOLDER
    twoStage: { fermentTicks: 6_480, casesPerBarrel: 10 }, // PLACEHOLDER (ADR 0029 decision 2): 4 days 12 h; 20 corn + 10 sugar a barrel
  },
  {
    id: STANDARD_MOONSHINE_RECIPE,
    name: "Standard moonshine",
    productId: MOONSHINE,
    quality: "standard",
    inputsPerCase: [
      { materialId: CORN, quantity: 2 }, // PLACEHOLDER
      { materialId: SUGAR, quantity: 2 }, // PLACEHOLDER
    ],
    ticksPerCase: 144, // PLACEHOLDER
    laborPerCase: cents(950), // PLACEHOLDER (T07d tuned: standard priced well above basic, margin close to it; T07h trimmed it from $10.00 to keep the standard strategies level with volume-producer)
    overheadPerCase: cents(100), // PLACEHOLDER (T05g tuned; T07 tunes next)
    requiredEquipmentIds: [COPPER_STILL, QC_STATION],
    failureChance: ratio(0), // PLACEHOLDER
    twoStage: { fermentTicks: 6_480, casesPerBarrel: 10 }, // PLACEHOLDER (ADR 0029 decision 2)
  },
];

export class RecipeDataError extends Error {
  override readonly name = "RecipeDataError";
}

/** The human's fermentation range (ADR 0029 decision 2): 4–5 in-game days. Leaving it needs a new decision. */
export const FERMENT_TICKS_RANGE = { min: 4 * TICKS_PER_DAY, max: 5 * TICKS_PER_DAY } as const;
/** The human's distillation range (ADR 0029 decision 2): 6–12 in-game hours, whoever operates the still. */
export const DISTILL_RUN_TICKS_RANGE = { min: 6 * TICKS_PER_HOUR, max: 12 * TICKS_PER_HOUR } as const;

const PPM = 1_000_000;

function wholeAtLeast(name: string, value: number, min: number): void {
  if (!Number.isSafeInteger(value) || value < min) throw new RecipeDataError(`${name} must be a whole number of at least ${min}, got ${value}`);
}

/**
 * Checks each recipe's two-stage terms (ADR 0029 decision 2): `fermentTicks` a
 * whole number in [4, 5] days (5 760–7 200 ticks), `casesPerBarrel` a whole
 * number ≥ 1. Returns the recipes unchanged; throws RecipeDataError.
 */
export function validateRecipes(recipes: readonly RecipeDefinition[]): readonly RecipeDefinition[] {
  for (const recipe of recipes) {
    const where = `${recipe.id}.twoStage`;
    const { fermentTicks, casesPerBarrel } = recipe.twoStage;
    if (!Number.isSafeInteger(fermentTicks) || fermentTicks < FERMENT_TICKS_RANGE.min || fermentTicks > FERMENT_TICKS_RANGE.max) {
      throw new RecipeDataError(`${where}.fermentTicks must be a whole number in [${FERMENT_TICKS_RANGE.min}, ${FERMENT_TICKS_RANGE.max}] (4–5 days), got ${fermentTicks}`);
    }
    wholeAtLeast(`${where}.casesPerBarrel`, casesPerBarrel, 1);
  }
  return recipes;
}

/** `ceil(ticks × ppm / 1 000 000)`: a duration scaled by a factor, as the simulation rounds it. */
export function scaledTicks(ticks: number, ppm: number): number {
  return Math.ceil((ticks * ppm) / PPM);
}

/** The longest single interval of a set of minute-of-day intervals, in minutes (one crossing midnight wraps). */
export function longestIntervalMinutes(intervals: readonly PlaceHoursInterval[]): number {
  let longest = 0;
  for (const { opensAtMinute, closesAtMinute } of intervals) {
    const length = closesAtMinute > opensAtMinute ? closesAtMinute - opensAtMinute : closesAtMinute + TICKS_PER_DAY - opensAtMinute;
    longest = Math.max(longest, length);
  }
  return longest;
}

/** What ADR 0029 decision 2's cross-module checks read, gathered by `index.ts` from each module. */
export interface TwoStageRunInputs {
  readonly recipes: readonly RecipeDefinition[];
  /** ACTIVITY_DURATIONS.DISTILL: a run at 1×. */
  readonly distillTicks: number;
  /** The founder tired (presence.ts). */
  readonly tiredDurationPpm: number;
  /** A Distiller's pace at competence 0 and 100 (personnel.ts). */
  readonly competenceDurationPpm: CompetencePpm;
  /** ROLE_TERMS.DISTILLER.workingHours (personnel.ts). */
  readonly distillerWorkingHours: readonly PlaceHoursInterval[];
  /** DISTILL_ORDER_DEFAULTS.batchSize (personnel.ts). */
  readonly orderDefaultBatchSize: number;
}

/**
 * ADR 0029 decision 2's checks across modules. Returns the inputs unchanged;
 * throws RecipeDataError.
 * - Every run is 6–12 hours, whoever operates it: the fastest operator's run
 *   `ceil(DISTILL × min(atZero, atHundred, 1 000 000) / 1 000 000)` ≥ 360, and the
 *   slowest `ceil(DISTILL × max(atZero, atHundred, TIRED_DURATION_PPM, 1 000 000) / 1 000 000)`
 *   ≤ 720. The factors are the competence ends, the founder tired, and the
 *   founder rested at 1×.
 * - A Distiller's slowest run fits in a shift: `ceil(DISTILL × max(atZero,
 *   atHundred) / 1 000 000)` ≤ the longest single interval of the Distiller's
 *   working hours (decision 9).
 * - The order form's default `batchSize` is at least every recipe's
 *   `casesPerBarrel`, so the defaults always mash at least one barrel.
 */
export function validateTwoStageRuns(inputs: TwoStageRunInputs): TwoStageRunInputs {
  const { distillTicks, tiredDurationPpm, competenceDurationPpm: c } = inputs;
  const fastest = scaledTicks(distillTicks, Math.min(c.atZero, c.atHundred, PPM));
  const slowest = scaledTicks(distillTicks, Math.max(c.atZero, c.atHundred, tiredDurationPpm, PPM));
  if (fastest < DISTILL_RUN_TICKS_RANGE.min) {
    throw new RecipeDataError(`The fastest distillation run is ${fastest} ticks (ACTIVITY_DURATIONS.DISTILL ${distillTicks}); it must be at least ${DISTILL_RUN_TICKS_RANGE.min} (6 hours)`);
  }
  if (slowest > DISTILL_RUN_TICKS_RANGE.max) {
    throw new RecipeDataError(`The slowest distillation run is ${slowest} ticks (ACTIVITY_DURATIONS.DISTILL ${distillTicks}); it must be at most ${DISTILL_RUN_TICKS_RANGE.max} (12 hours)`);
  }
  const slowestDistiller = scaledTicks(distillTicks, Math.max(c.atZero, c.atHundred));
  const shift = longestIntervalMinutes(inputs.distillerWorkingHours);
  if (slowestDistiller > shift) {
    throw new RecipeDataError(`A Distiller's slowest run (${slowestDistiller} ticks) doesn't fit their longest working interval (${shift} minutes)`);
  }
  for (const recipe of inputs.recipes) {
    if (inputs.orderDefaultBatchSize < recipe.twoStage.casesPerBarrel) {
      throw new RecipeDataError(
        `DISTILL_ORDER_DEFAULTS.batchSize (${inputs.orderDefaultBatchSize}) is below ${recipe.id}'s casesPerBarrel (${recipe.twoStage.casesPerBarrel})`,
      );
    }
  }
  return inputs;
}

/** Every recipe, validated (ADR 0029 decision 2's per-recipe checks). */
export const RECIPES: readonly RecipeDefinition[] = validateRecipes(RECIPE_TABLE);
