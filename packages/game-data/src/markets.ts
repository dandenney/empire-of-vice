// S0 stub: extended by T02d (ECO-001). Definition types per ADR 0012.
// PLACEHOLDER values. Base prices come from products.ts; this file holds the
// market baselines D₀ and S₀ (GDD §7). T02d decides the real numbers.

import type { ProductId, QualityTier } from "@eov/contracts";
import { MOONSHINE } from "./products.ts";

export interface MarketDefinition {
  readonly productId: ProductId;
  readonly quality: QualityTier;
  /** D₀: baseline daily demand. Must be > 0 (GDD §7). */
  readonly baselineDemand: number;
  /** S₀: baseline daily supply. Must be > 0 (GDD §7). */
  readonly baselineSupply: number;
}

export const MARKETS: readonly MarketDefinition[] = [
  { productId: MOONSHINE, quality: "basic", baselineDemand: 30, baselineSupply: 30 }, // PLACEHOLDER
  { productId: MOONSHINE, quality: "standard", baselineDemand: 12, baselineSupply: 12 }, // PLACEHOLDER
];
