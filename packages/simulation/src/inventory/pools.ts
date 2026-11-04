// S0 stub: extended by T02a (inventory and weighted-average costing, FIN-001).
//
// Weighted-average cost pools. A pool stores TOTAL cost, never a unit cost. A
// removal takes cost proportional to quantity, rounded half up to the cent; the
// removal that empties a pool takes whatever cost is left, so rounding residue
// never strands (FIN-001). Everything here is a pure function over GameState,
// meant to be staged through the coordinator (`tx.update`).
//
// Pools are kept sorted by (facilityId, productId, quality rank) and
// (facilityId, materialId). Empty pools are removed.

import {
  addMoney,
  cents,
  qualityRank,
  roundHalfUpToCent,
  subtractMoney,
  type FacilityId,
  type GameState,
  type MaterialId,
  type MaterialPoolState,
  type Money,
  type ProductId,
  type ProductPoolState,
  type QualityTier,
  type ReservationState,
} from "@eov/contracts";

export class InventoryError extends Error {
  override readonly name = "InventoryError";
}

/** Cost of removing `quantity` of a pool's `poolQuantity` units totalling `totalCost`. */
export function allocateRemovalCost(totalCost: Money, poolQuantity: number, quantity: number): Money {
  if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > poolQuantity) {
    throw new InventoryError(`Cannot remove ${quantity} of ${poolQuantity}`);
  }
  if (quantity === poolQuantity) return totalCost;
  return roundHalfUpToCent(BigInt(totalCost) * BigInt(quantity), BigInt(poolQuantity));
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function compareProductPools(a: ProductPoolState, b: ProductPoolState): number {
  return byString(a.facilityId, b.facilityId) || byString(a.productId, b.productId) || qualityRank(a.quality) - qualityRank(b.quality);
}

function compareMaterialPools(a: MaterialPoolState, b: MaterialPoolState): number {
  return byString(a.facilityId, b.facilityId) || byString(a.materialId, b.materialId);
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export function findProductPool(
  state: GameState,
  facilityId: FacilityId,
  productId: ProductId,
  quality: QualityTier,
): ProductPoolState | undefined {
  return state.productPools.find((p) => p.facilityId === facilityId && p.productId === productId && p.quality === quality);
}

/** Cases not spoken for by a reservation. */
export function availableProduct(state: GameState, facilityId: FacilityId, productId: ProductId, quality: QualityTier): number {
  const pool = findProductPool(state, facilityId, productId, quality);
  const reserved = sumReserved(
    state.reservations,
    (r) => r.facilityId === facilityId && r.goods.kind === "PRODUCT" && r.goods.productId === productId && r.goods.quality === quality,
  );
  return (pool?.quantity ?? 0) - reserved;
}

export function addProduct(
  state: GameState,
  facilityId: FacilityId,
  productId: ProductId,
  quality: QualityTier,
  quantity: number,
  cost: Money,
): GameState {
  const existing = findProductPool(state, facilityId, productId, quality);
  const pools = existing
    ? state.productPools.map((p) => (p === existing ? { ...p, quantity: p.quantity + quantity, totalCost: addMoney(p.totalCost, cost) } : p))
    : [...state.productPools, { facilityId, productId, quality, quantity, totalCost: cost }].sort(compareProductPools);
  return { ...state, productPools: pools };
}

/** Removes `quantity` cases and exactly `cost` (from `allocateRemovalCost`). */
export function removeProduct(
  state: GameState,
  facilityId: FacilityId,
  productId: ProductId,
  quality: QualityTier,
  quantity: number,
  cost: Money,
): GameState {
  const pool = findProductPool(state, facilityId, productId, quality);
  if (!pool) throw new InventoryError(`No ${quality} ${productId} at ${facilityId}`);
  const remaining = pool.quantity - quantity;
  const productPools =
    remaining === 0
      ? state.productPools.filter((p) => p !== pool)
      : state.productPools.map((p) => (p === pool ? { ...p, quantity: remaining, totalCost: subtractMoney(p.totalCost, cost) } : p));
  return { ...state, productPools };
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

export function findMaterialPool(state: GameState, facilityId: FacilityId, materialId: MaterialId): MaterialPoolState | undefined {
  return state.materialPools.find((p) => p.facilityId === facilityId && p.materialId === materialId);
}

/** Units not spoken for by a reservation. */
export function availableMaterial(state: GameState, facilityId: FacilityId, materialId: MaterialId): number {
  const pool = findMaterialPool(state, facilityId, materialId);
  const reserved = sumReserved(
    state.reservations,
    (r) => r.facilityId === facilityId && r.goods.kind === "MATERIAL" && r.goods.materialId === materialId,
  );
  return (pool?.quantity ?? 0) - reserved;
}

export function addMaterial(state: GameState, facilityId: FacilityId, materialId: MaterialId, quantity: number, cost: Money): GameState {
  const existing = findMaterialPool(state, facilityId, materialId);
  const pools = existing
    ? state.materialPools.map((p) => (p === existing ? { ...p, quantity: p.quantity + quantity, totalCost: addMoney(p.totalCost, cost) } : p))
    : [...state.materialPools, { facilityId, materialId, quantity, totalCost: cost }].sort(compareMaterialPools);
  return { ...state, materialPools: pools };
}

export function removeMaterial(state: GameState, facilityId: FacilityId, materialId: MaterialId, quantity: number, cost: Money): GameState {
  const pool = findMaterialPool(state, facilityId, materialId);
  if (!pool) throw new InventoryError(`No ${materialId} at ${facilityId}`);
  const remaining = pool.quantity - quantity;
  const materialPools =
    remaining === 0
      ? state.materialPools.filter((p) => p !== pool)
      : state.materialPools.map((p) => (p === pool ? { ...p, quantity: remaining, totalCost: subtractMoney(p.totalCost, cost) } : p));
  return { ...state, materialPools };
}

// ---------------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------------

function sumReserved(reservations: readonly ReservationState[], match: (r: ReservationState) => boolean): number {
  let total = 0;
  for (const r of reservations) if (match(r)) total += r.quantity;
  return total;
}

/**
 * Adds a reservation. Reservation IDs are minted in increasing order, so appending
 * keeps the list in ID-number order (see the PR's contract-gap note on ID ordering).
 */
export function addReservation(state: GameState, reservation: ReservationState): GameState {
  return { ...state, reservations: [...state.reservations, reservation] };
}

export function removeReservations(state: GameState, ids: readonly string[]): GameState {
  const remove = new Set(ids);
  return { ...state, reservations: state.reservations.filter((r) => !remove.has(r.id)) };
}

/** Total cost of all pools of one kind, for the coordinator's ledger-vs-inventory check. */
export function inventoryValue(pools: readonly { readonly totalCost: Money }[]): Money {
  let total = cents(0);
  for (const p of pools) total = addMoney(total, p.totalCost);
  return total;
}
