// S0 stub: extended by T02c (PROD-001). Definition types per ADR 0012.
// PLACEHOLDER values: chosen so one case costs $11 to make and sells for $14
// (close to the GDD §8 production example). T02c decides recipes and costs (GDD §14.3).

import {
  asId,
  cents,
  type EquipmentId,
  type MaterialLine,
  type Money,
  type ProductId,
  type QualityTier,
  type RecipeId,
} from "@eov/contracts";
import { COPPER_STILL } from "./equipment.ts";
import { CORN, MOONSHINE, SUGAR } from "./products.ts";

export interface RecipeDefinition {
  readonly id: RecipeId;
  readonly name: string;
  readonly productId: ProductId;
  readonly quality: QualityTier;
  /** Raw materials consumed per output case. */
  readonly inputsPerCase: readonly MaterialLine[];
  /** Production time per output case, in ticks (game minutes). */
  readonly ticksPerCase: number;
  /** Labor capitalized into each case (FIN-001 production accounting). */
  readonly laborPerCase: Money;
  /** Overhead capitalized into each case. */
  readonly overheadPerCase: Money;
  /** The facility must own this equipment to run the recipe. */
  readonly requiredEquipmentId: EquipmentId;
}

export const BASIC_MOONSHINE_RECIPE = asId("Recipe", "basic-moonshine");

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
    ticksPerCase: 144, // PLACEHOLDER: 10 cases per game day
    laborPerCase: cents(300), // PLACEHOLDER
    overheadPerCase: cents(100), // PLACEHOLDER
    requiredEquipmentId: COPPER_STILL,
  },
];
