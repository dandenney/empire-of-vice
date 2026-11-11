// The Contracts panel's view helpers (#128). Every figure comes from the
// snapshot; these only pick and format it. Nothing here computes a game value:
// which installment a delivery counts toward, what a reservation holds, and
// whether an offer can be accepted are the simulation's (ADR 0007, ADR 0013).

import { qualityRank, type BuyerId, type ContractTerms, type GameSnapshot, type InventoryPoolSnapshot, type LocationId } from "@eov/contracts";
import { CONTRACTS_COPY as C } from "./copy.ts";

/** Parts per million as a percent: "20" for 200 000; one decimal when it isn't whole. */
export function formatPpmPercent(ppm: number): string {
  const percent = ppm / 10_000;
  return C.percent(Number.isInteger(percent) ? String(percent) : percent.toFixed(1));
}

/** Where a contract's buyer is on the map, from the snapshot's locations. */
export function buyerLocationId(snapshot: GameSnapshot, buyerId: BuyerId): LocationId | null {
  return snapshot.locations.find((l) => l.occupant.kind === "BUYER" && l.occupant.buyerId === buyerId)?.id ?? null;
}

/**
 * The qualities a delivery for these terms can carry: every pool of the
 * contract's product at or above its minimum quality (the contract's own rule,
 * `qualityRank`). With none in stock, the minimum quality alone, so a dispatch
 * shows the simulation's typed reason rather than nothing.
 */
export function deliveryQualities(pools: readonly InventoryPoolSnapshot[], terms: Pick<ContractTerms, "productId" | "minimumQuality">): readonly { readonly quality: InventoryPoolSnapshot["quality"]; readonly pool: InventoryPoolSnapshot | null }[] {
  const matching = pools.filter((p) => p.productId === terms.productId && qualityRank(p.quality) >= qualityRank(terms.minimumQuality));
  if (matching.length === 0) return [{ quality: terms.minimumQuality, pool: null }];
  return matching.map((pool) => ({ quality: pool.quality, pool }));
}

export interface ReservedLine {
  readonly key: string;
  readonly facilityName: string;
  readonly line: string;
  /** Who holds it: contracts (releasable from the contract) or running production (never releasable). */
  readonly holder: "CONTRACT" | "PRODUCTION";
}

/**
 * Every reserved quantity in the snapshot, by facility: finished goods held
 * for contracts, and materials held by running production jobs.
 */
export function reservedLines(snapshot: GameSnapshot, qualityLabel: (q: InventoryPoolSnapshot["quality"]) => string): readonly ReservedLine[] {
  return snapshot.facilities.flatMap((f) => [
    ...f.products
      .filter((p) => p.reservedQuantity > 0)
      .map((p) => ({
        key: `${f.id}-${p.productId}-${p.quality}`,
        facilityName: f.name,
        line: C.productReserved(p.productName, qualityLabel(p.quality), p.reservedQuantity, p.quantity),
        holder: "CONTRACT" as const,
      })),
    ...f.materials
      .filter((m) => m.reservedQuantity > 0)
      .map((m) => ({
        key: `${f.id}-${m.materialId}`,
        facilityName: f.name,
        line: C.materialReserved(m.materialName, m.reservedQuantity, m.quantity),
        holder: "PRODUCTION" as const,
      })),
  ]);
}
