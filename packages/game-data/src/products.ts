// The product matrix (T02c1, PROD-001; GDD §6). Definition types per ADR 0012.
// PLACEHOLDER values: GDD §6 base prices, except moonshine's standard (and premium,
// to keep the ladder in order), which T05g (#106) raised so standard moonshine
// carries the M001 victory. T07 tunes them next. Product names are placeholder copy.

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
    basePrice: { basic: cents(1_400), standard: cents(4_800), premium: cents(7_200) }, // PLACEHOLDER (T05g tuned standard and premium; T07 tunes next)
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
