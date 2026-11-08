// Recipes (T02c1, PROD-001). Definition types per ADR 0012.
// PLACEHOLDER values. Basic moonshine keeps its S0 numbers: one case costs $11 to
// make (the GDD §8 production example's $30 + $10 labor and overhead per 10 cases);
// T07d (#126) moved its price, not its cost. T07d raised standard moonshine's labor
// so its price can sit well above basic's (a buyer almost never quotes basic higher)
// while its margin stays close; a case stays dearer than basic, so basic is still the
// cheapest restart (ADR 0020 decision 10). T07 tunes both recipes next (GDD §14.3).

import {
  asId,
  cents,
  ratio,
  type EquipmentId,
  type MaterialLine,
  type Money,
  type ProductId,
  type QualityTier,
  type Ratio,
  type RecipeId,
} from "@eov/contracts";
import { COPPER_STILL, QC_STATION } from "./equipment.ts";
import { CORN, MOONSHINE, SUGAR } from "./products.ts";

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
}

export const BASIC_MOONSHINE_RECIPE = asId("Recipe", "basic-moonshine");
export const STANDARD_MOONSHINE_RECIPE = asId("Recipe", "standard-moonshine");

export const RECIPES: readonly RecipeDefinition[] = [
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
    laborPerCase: cents(1_000), // PLACEHOLDER (T07d tuned: standard priced well above basic, margin close to it)
    overheadPerCase: cents(100), // PLACEHOLDER (T05g tuned; T07 tunes next)
    requiredEquipmentIds: [COPPER_STILL, QC_STATION],
    failureChance: ratio(0), // PLACEHOLDER
  },
];
