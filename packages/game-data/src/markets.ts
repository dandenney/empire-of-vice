// ECO-001 markets (T02d, issue #8; ADR 0016). Definition types per ADR 0012.
// Base prices come from products.ts. This file holds each market's baselines D₀
// and S₀, its daily demand drift, and the GDD §7 clamp bounds of the spot price
// multipliers.

import { ratio, type ProductId, type QualityTier, type Ratio } from "@eov/contracts";
import { MOONSHINE } from "./products.ts";

export interface MarketDefinition {
  readonly productId: ProductId;
  readonly quality: QualityTier;
  /** D₀: baseline daily demand. A positive integer (GDD §7). */
  readonly baselineDemand: number;
  /** S₀: baseline daily supply. A positive integer (GDD §7). */
  readonly baselineSupply: number;
  /**
   * Daily demand drift bound, in parts per million of D₀: each midnight
   * `D = D₀ + nextIntBetween(−k, k)` with `k = floor(D₀ × demandDriftPpm / 10⁶)`
   * (ADR 0016). An integer, `0 ≤ demandDriftPpm < 1 000 000`.
   */
  readonly demandDriftPpm: number;
}

export interface RatioBounds {
  readonly min: Ratio;
  readonly max: Ratio;
}

/** GDD §7 clamps on the spot price multipliers M_D, M_S, and M_E. */
export interface MarketPriceBounds {
  readonly demand: RatioBounds;
  readonly supply: RatioBounds;
  readonly event: RatioBounds;
}

/** GDD §7: M_D and M_S in [0.80, 1.25], M_E in [0.90, 1.10]. Rules, not tuning. */
export const MARKET_PRICE_BOUNDS: MarketPriceBounds = {
  demand: { min: ratio(800_000), max: ratio(1_250_000) },
  supply: { min: ratio(800_000), max: ratio(1_250_000) },
  event: { min: ratio(900_000), max: ratio(1_100_000) },
};

export const MARKETS: readonly MarketDefinition[] = [
  { productId: MOONSHINE, quality: "basic", baselineDemand: 55, baselineSupply: 150, demandDriftPpm: 100_000 }, // PLACEHOLDER (T05g tuned S₀; T07h raised D₀ from 40 for more slack)
  { productId: MOONSHINE, quality: "standard", baselineDemand: 20, baselineSupply: 150, demandDriftPpm: 100_000 }, // PLACEHOLDER (T05g tuned S₀; T07h raised D₀ from 15 for more slack)
];
