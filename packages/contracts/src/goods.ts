// Goods identity shared by commands, inventory, contracts, and snapshots. GDD §6 (PROD-001).
//
// A finished good is identified by product + quality tier ("standard moonshine").
// Product definitions and prices live in game-data. The tier set is a fixed rule
// of the game, so it lives here.

import type { MaterialId, ProductId } from "./ids.ts";

export const QUALITY_TIERS = ["basic", "standard", "premium"] as const;
export type QualityTier = (typeof QUALITY_TIERS)[number];

/** Tiers in ascending order, for "minimum quality" checks: rank("standard") >= rank("basic"). */
export function qualityRank(tier: QualityTier): number {
  return QUALITY_TIERS.indexOf(tier);
}

/** A quantity of one finished good. Quantities are whole cases in M001 (FIN-001). */
export interface CargoLine {
  readonly productId: ProductId;
  readonly quality: QualityTier;
  readonly quantity: number;
}

/** A quantity of one raw material. */
export interface MaterialLine {
  readonly materialId: MaterialId;
  readonly quantity: number;
}
