// S0 stub: extended by T02c (PROD-001). Definition types per ADR 0012.
// PLACEHOLDER values: GDD §6 illustrative prices. T02c/T02d decide the real numbers.

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
export const CORN = asId("Material", "corn");
export const SUGAR = asId("Material", "sugar");

export const PRODUCTS: readonly ProductDefinition[] = [
  {
    id: MOONSHINE,
    name: "Moonshine",
    basePrice: { basic: cents(1_400), standard: cents(2_000), premium: cents(3_000) }, // PLACEHOLDER
  },
];

export const MATERIALS: readonly MaterialDefinition[] = [
  { id: CORN, name: "Corn" },
  { id: SUGAR, name: "Sugar" },
];
