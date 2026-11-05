// ECO-001 suppliers and shortages (T02d, issue #8, decision 3; ADR 0016). Definition types per ADR 0012.

import {
  asId,
  cents,
  ratio,
  type LocationId,
  type MaterialId,
  type Money,
  type ProductId,
  type QualityTier,
  type Ratio,
  type SupplierId,
} from "@eov/contracts";
import { MILLERS_FEED_LOCATION } from "./map.ts";
import { CORN, MOONSHINE, SUGAR } from "./products.ts";

/** A shortage's effect on one product market's M_E. */
export interface ShortageMarketEffect {
  readonly productId: ProductId;
  readonly quality: QualityTier;
  /** M_E while the shortage lasts. Within the GDD §7 event bounds [0.90, 1.10]. */
  readonly eventRatio: Ratio;
}

/**
 * A seeded ingredient shortage on one stock line (ADR 0016). At the midnight that
 * starts day 1 its start day is rolled in `[earliestStartDay, latestStartDay]`
 * from the market RNG stream; it then lasts `durationDays`.
 */
export interface ShortageDefinition {
  /** At least 2, so the start is always after the day-1 roll. */
  readonly earliestStartDay: number;
  /** At least `earliestStartDay`. */
  readonly latestStartDay: number;
  /** At least 1. */
  readonly durationDays: number;
  /** Share of the daily stock still available: 0 < supplyRatio ≤ 1. */
  readonly supplyRatio: Ratio;
  /** Supplier price multiplier: at least 1. */
  readonly priceRatio: Ratio;
  /** Markets whose M_E the shortage moves. At most one configured shortage may affect a market. */
  readonly marketEffects: readonly ShortageMarketEffect[];
}

export interface SupplierStockDefinition {
  readonly materialId: MaterialId;
  /** Units available at the start of each day. Stock resets to this at midnight, with no carry-over. */
  readonly dailyStock: number;
  readonly unitPrice: Money;
  /** The stock line's configured shortage, if any (at most one per line). */
  readonly shortage: ShortageDefinition | null;
}

export interface SupplierDefinition {
  readonly id: SupplierId;
  readonly name: string;
  readonly locationId: LocationId;
  readonly stock: readonly SupplierStockDefinition[];
}

export const MILLERS_FEED = asId("Supplier", "millers-feed");

export const SUPPLIERS: readonly SupplierDefinition[] = [
  {
    id: MILLERS_FEED,
    name: "Miller's Feed & Seed", // PLACEHOLDER (story)
    locationId: MILLERS_FEED_LOCATION, // PLACEHOLDER (story)
    stock: [
      {
        materialId: CORN,
        dailyStock: 160, // PLACEHOLDER (tuning; T07a validates)
        unitPrice: cents(250), // PLACEHOLDER (tuning; T07a validates)
        shortage: {
          earliestStartDay: 4, // PLACEHOLDER (tuning; T07a validates)
          latestStartDay: 7, // PLACEHOLDER (tuning; T07a validates)
          durationDays: 3, // PLACEHOLDER (tuning; T07a validates)
          supplyRatio: ratio(400_000), // PLACEHOLDER (tuning; T07a validates)
          priceRatio: ratio(1_500_000), // PLACEHOLDER (tuning; T07a validates)
          marketEffects: [
            { productId: MOONSHINE, quality: "basic", eventRatio: ratio(1_100_000) }, // PLACEHOLDER (tuning; T07a validates)
            { productId: MOONSHINE, quality: "standard", eventRatio: ratio(1_100_000) }, // PLACEHOLDER (tuning; T07a validates)
          ],
        },
      },
      { materialId: SUGAR, dailyStock: 100, unitPrice: cents(200), shortage: null }, // PLACEHOLDER (tuning; T07a validates)
    ],
  },
];
