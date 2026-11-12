// The product matrix (T02c1, PROD-001; GDD §6). Definition types per ADR 0012.
// PLACEHOLDER values: GDD §6 base prices, except moonshine's. T05g (#106) raised
// standard (and premium, to keep the ladder in order); T07d (#126) raised basic and
// brought standard down, so with standard's dearer conversion (recipes.ts) a case
// of either earns a similar margin and a basic-only operation can reach the M001
// victory in the session too. Product names are placeholder copy.

import { asId, cents, type MaterialId, type Money, type ProductId, type QualityTier } from "@eov/contracts";

export interface ProductDefinition {
  readonly id: ProductId;
  readonly name: string;
  /** Base spot price per case for each quality tier (GDD §6 product matrix). */
  readonly basePrice: Readonly<Record<QualityTier, Money>>;
}

export interface MaterialDefinition {
  readonly id: MaterialId;
  readonly name: string;
}

export const MOONSHINE = asId("Product", "moonshine");
export const WHISKEY = asId("Product", "whiskey");
export const BEER = asId("Product", "beer");
export const CORN = asId("Material", "corn");
export const SUGAR = asId("Material", "sugar");

export const PRODUCTS: readonly ProductDefinition[] = [
  {
    id: MOONSHINE,
    name: "Moonshine",
    basePrice: { basic: cents(3_120), standard: cents(3_860), premium: cents(7_200) }, // PLACEHOLDER (T07d tuned basic and standard: four viable strategies; T07h raised both to make up the $700 taken off the building and keep victory near 28.5 min)
  },
  {
    id: WHISKEY,
    name: "Whiskey",
    basePrice: { basic: cents(2_200), standard: cents(3_400), premium: cents(5_200) }, // PLACEHOLDER
  },
  {
    id: BEER,
    name: "Beer",
    basePrice: { basic: cents(800), standard: cents(1_200), premium: cents(1_800) }, // PLACEHOLDER
  },
];

export const MATERIALS: readonly MaterialDefinition[] = [
  { id: CORN, name: "Corn" },
  { id: SUGAR, name: "Sugar" },
];
