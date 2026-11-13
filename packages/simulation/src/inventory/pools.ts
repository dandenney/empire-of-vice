// Inventory pools, reservations, and cargo moves (T02a, GDD §8 FIN-001, §14.8;
// release rules in ADR 0013).
//
// Weighted-average cost pools. A pool stores TOTAL cost, never a unit cost. A
// removal takes cost proportional to quantity, rounded half up to the cent; the
// removal that empties a pool takes whatever cost is left, so rounding residue
// never strands (FIN-001). Everything here is a pure function over GameState,
// meant to be staged through the coordinator (`tx.update`). Nothing here writes
// the ledger, the event journal, or the ID counters: callers post and emit
// through their TransactionDraft.
//
// Pools are kept sorted by (facilityId, productId, quality rank) and
// (facilityId, materialId), unique per key. Empty pools are removed.
// Reservations are kept in `compareIds` order (ADR 0008) and only cover goods
// sitting in a facility pool (ADR 0013 rule 1).

import {
  addMoney,
  cents,
  compareById,
  compareIds,
  qualityRank,
  roundHalfUpToCent,
  subtractMoney,
  type ContractId,
  type FacilityId,
  type GameState,
  type MaterialId,
  type MaterialPoolState,
  type Money,
  type ProductId,
  type ProductPoolState,
  type QualityTier,
  type RejectionReason,
  type ReservationId,
  type ReservationState,
  type ReservedGoods,
} from "@eov/contracts";
import type { WorldSlice } from "../view/world.ts";

export class InventoryError extends Error {
  override readonly name = "InventoryError";
}

const isQuantity = (quantity: number): boolean => Number.isSafeInteger(quantity) && quantity > 0;

function assertQuantity(quantity: number, what: string): void {
  if (!isQuantity(quantity)) throw new InventoryError(`${what}: quantity must be a positive safe integer, got ${quantity}`);
}

function assertCost(cost: Money, what: string): void {
  if (!Number.isSafeInteger(cost) || cost < 0) throw new InventoryError(`${what}: cost must be non-negative integer cents, got ${cost}`);
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

/** The result of taking goods out of a pool: the new state and the cost the goods carry. */
export interface Taken {
  readonly state: GameState;
  readonly cost: Money;
}

/**
 * Removes `quantity` and exactly `cost` from a pool, dropping it when emptied.
 * Shared by the product and material removals so both check the same things.
 */
function removeFromPool<P extends { readonly quantity: number; readonly totalCost: Money }>(
  pools: readonly P[],
  pool: P,
  quantity: number,
  cost: Money,
  where: string,
): readonly P[] {
  assertQuantity(quantity, where);
  assertCost(cost, where);
  if (quantity > pool.quantity) throw new InventoryError(`${where}: cannot remove ${quantity} of ${pool.quantity}`);
  if (cost > pool.totalCost) throw new InventoryError(`${where}: cannot remove cost ${cost} of ${pool.totalCost}`);
  const remaining = pool.quantity - quantity;
  if (remaining === 0) {
    if (cost !== pool.totalCost) throw new InventoryError(`${where}: emptying the pool must take all its cost (${pool.totalCost}), got ${cost}`);
    return pools.filter((p) => p !== pool);
  }
  return pools.map((p) => (p === pool ? { ...p, quantity: remaining, totalCost: subtractMoney(p.totalCost, cost) } : p));
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export function findProductPool(
  state: WorldSlice,
  facilityId: FacilityId,
  productId: ProductId,
  quality: QualityTier,
): ProductPoolState | undefined {
  return state.productPools.find((p) => p.facilityId === facilityId && p.productId === productId && p.quality === quality);
}

/** Cases not spoken for by a reservation. */
export function availableProduct(state: WorldSlice, facilityId: FacilityId, productId: ProductId, quality: QualityTier): number {
  const pool = findProductPool(state, facilityId, productId, quality);
  return (pool?.quantity ?? 0) - sumReserved(state.reservations, (r) => coversProduct(r, facilityId, productId, quality));
}

/** Adds goods with their cost to a pool (also the "put" half of a cargo move). */
export function addProduct(
  state: GameState,
  facilityId: FacilityId,
  productId: ProductId,
  quality: QualityTier,
  quantity: number,
  cost: Money,
): GameState {
  const where = `${quality} ${productId} at ${facilityId}`;
  assertQuantity(quantity, where);
  assertCost(cost, where);
  const existing = findProductPool(state, facilityId, productId, quality);
  if (existing && !Number.isSafeInteger(existing.quantity + quantity)) throw new InventoryError(`${where}: quantity overflows`);
  const pools = existing
    ? state.productPools.map((p) => (p === existing ? { ...p, quantity: p.quantity + quantity, totalCost: addMoney(p.totalCost, cost) } : p))
    : [...state.productPools, { facilityId, productId, quality, quantity, totalCost: cost }].sort(compareProductPools);
  return { ...state, productPools: pools };
}

/**
 * Removes `quantity` cases and exactly `cost` (from `allocateRemovalCost`).
 * Low-level: doesn't look at reservations. Prefer `takeProduct`,
 * `takeForContract`, or `consumeReservations`.
 */
export function removeProduct(
  state: GameState,
  facilityId: FacilityId,
  productId: ProductId,
  quality: QualityTier,
  quantity: number,
  cost: Money,
): GameState {
  const pool = findProductPool(state, facilityId, productId, quality);
  const where = `${quality} ${productId} at ${facilityId}`;
  if (!pool) throw new InventoryError(`No ${where}`);
  return { ...state, productPools: removeFromPool(state.productPools, pool, quantity, cost, where) };
}

/**
 * Takes UNRESERVED cases out of a pool at weighted-average cost: removal for a
 * sale or a transfer, and the "take" half of a cargo move. The returned `cost`
 * is what the goods carry (a CargoLineState's `cost`).
 */
export function takeProduct(state: GameState, facilityId: FacilityId, productId: ProductId, quality: QualityTier, quantity: number): Taken {
  const where = `${quality} ${productId} at ${facilityId}`;
  assertQuantity(quantity, where);
  const pool = findProductPool(state, facilityId, productId, quality);
  const available = availableProduct(state, facilityId, productId, quality);
  if (!pool || quantity > available) throw new InventoryError(`${where}: cannot take ${quantity}, ${available} unreserved`);
  const cost = allocateRemovalCost(pool.totalCost, pool.quantity, quantity);
  return { state: removeProduct(state, facilityId, productId, quality, quantity, cost), cost };
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

export function findMaterialPool(state: WorldSlice, facilityId: FacilityId, materialId: MaterialId): MaterialPoolState | undefined {
  return state.materialPools.find((p) => p.facilityId === facilityId && p.materialId === materialId);
}

/** Units not spoken for by a reservation. */
export function availableMaterial(state: WorldSlice, facilityId: FacilityId, materialId: MaterialId): number {
  const pool = findMaterialPool(state, facilityId, materialId);
  return (pool?.quantity ?? 0) - sumReserved(state.reservations, (r) => coversMaterial(r, facilityId, materialId));
}

export function addMaterial(state: GameState, facilityId: FacilityId, materialId: MaterialId, quantity: number, cost: Money): GameState {
  const where = `${materialId} at ${facilityId}`;
  assertQuantity(quantity, where);
  assertCost(cost, where);
  const existing = findMaterialPool(state, facilityId, materialId);
  if (existing && !Number.isSafeInteger(existing.quantity + quantity)) throw new InventoryError(`${where}: quantity overflows`);
  const pools = existing
    ? state.materialPools.map((p) => (p === existing ? { ...p, quantity: p.quantity + quantity, totalCost: addMoney(p.totalCost, cost) } : p))
    : [...state.materialPools, { facilityId, materialId, quantity, totalCost: cost }].sort(compareMaterialPools);
  return { ...state, materialPools: pools };
}

/** Low-level removal of exactly `quantity` and `cost`; see `removeProduct`. */
export function removeMaterial(state: GameState, facilityId: FacilityId, materialId: MaterialId, quantity: number, cost: Money): GameState {
  const pool = findMaterialPool(state, facilityId, materialId);
  const where = `${materialId} at ${facilityId}`;
  if (!pool) throw new InventoryError(`No ${where}`);
  return { ...state, materialPools: removeFromPool(state.materialPools, pool, quantity, cost, where) };
}

/** Takes UNRESERVED units out of a pool at weighted-average cost; see `takeProduct`. */
export function takeMaterial(state: GameState, facilityId: FacilityId, materialId: MaterialId, quantity: number): Taken {
  const where = `${materialId} at ${facilityId}`;
  assertQuantity(quantity, where);
  const pool = findMaterialPool(state, facilityId, materialId);
  const available = availableMaterial(state, facilityId, materialId);
  if (!pool || quantity > available) throw new InventoryError(`${where}: cannot take ${quantity}, ${available} unreserved`);
  const cost = allocateRemovalCost(pool.totalCost, pool.quantity, quantity);
  return { state: removeMaterial(state, facilityId, materialId, quantity, cost), cost };
}

// ---------------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------------

function coversProduct(r: ReservationState, facilityId: FacilityId, productId: ProductId, quality: QualityTier): boolean {
  return r.facilityId === facilityId && r.goods.kind === "PRODUCT" && r.goods.productId === productId && r.goods.quality === quality;
}

function coversMaterial(r: ReservationState, facilityId: FacilityId, materialId: MaterialId): boolean {
  return r.facilityId === facilityId && r.goods.kind === "MATERIAL" && r.goods.materialId === materialId;
}

function sumReserved(reservations: readonly ReservationState[], match: (r: ReservationState) => boolean): number {
  let total = 0;
  for (const r of reservations) if (match(r)) total += r.quantity;
  return total;
}

/**
 * Whether `quantity` of `goods` can be reserved at a facility: null when
 * 0 < quantity ≤ available (pool quantity minus active reservations on it),
 * otherwise the typed reason the caller rejects with.
 */
export function checkReservation(state: GameState, facilityId: FacilityId, goods: ReservedGoods, quantity: number): RejectionReason | null {
  if (!isQuantity(quantity)) return { code: "INVALID_QUANTITY", field: "quantity", value: quantity };
  if (goods.kind === "PRODUCT") {
    const available = availableProduct(state, facilityId, goods.productId, goods.quality);
    return quantity <= available
      ? null
      : { code: "INSUFFICIENT_STOCK", productId: goods.productId, quality: goods.quality, requested: quantity, available };
  }
  const available = availableMaterial(state, facilityId, goods.materialId);
  return quantity <= available ? null : { code: "INSUFFICIENT_MATERIALS", materialId: goods.materialId, required: quantity, available };
}

/**
 * Adds a reservation, keeping the list in `compareIds` order (ADR 0008).
 * Throws unless its quantity passes `checkReservation` and its ID is new.
 */
export function addReservation(state: GameState, reservation: ReservationState): GameState {
  const rejection = checkReservation(state, reservation.facilityId, reservation.goods, reservation.quantity);
  if (rejection) throw new InventoryError(`Cannot reserve ${reservation.quantity} at ${reservation.facilityId}: ${rejection.code}`);
  if (state.reservations.some((r) => r.id === reservation.id)) throw new InventoryError(`Reservation ${reservation.id} already exists`);
  return { ...state, reservations: [...state.reservations, reservation].sort(compareById) };
}

/**
 * Removes reservations from state; the goods stay in their pools. Doesn't
 * report them: the caller emits RESERVATION_RELEASED (with its reason) in the
 * same transaction (ADR 0013 rule 8).
 */
export function removeReservations(state: GameState, ids: readonly string[]): GameState {
  const remove = new Set(ids);
  return { ...state, reservations: state.reservations.filter((r) => !remove.has(r.id)) };
}

/**
 * Removal for a holder: removes each reservation's goods from its pool at
 * weighted-average cost (in the order given) and removes the reservations.
 * `cost` is the total, e.g. a completed job's materials or a failed job's
 * `writtenOff` (ADR 0013 rules 3 and 4). The caller reports each ID with
 * RESERVATION_RELEASED. Throws for an unknown (or repeated) reservation ID.
 */
export function consumeReservations(state: GameState, reservationIds: readonly ReservationId[]): Taken {
  let s = state;
  let total = cents(0);
  for (const id of reservationIds) {
    const r = s.reservations.find((x) => x.id === id);
    if (!r) throw new InventoryError(`No active reservation ${id}`);
    s = removeReservations(s, [id]);
    if (r.goods.kind === "PRODUCT") {
      const pool = findProductPool(s, r.facilityId, r.goods.productId, r.goods.quality);
      if (!pool) throw new InventoryError(`Reservation ${id} has no pool`);
      const cost = allocateRemovalCost(pool.totalCost, pool.quantity, r.quantity);
      s = removeProduct(s, r.facilityId, r.goods.productId, r.goods.quality, r.quantity, cost);
      total = addMoney(total, cost);
    } else {
      const pool = findMaterialPool(s, r.facilityId, r.goods.materialId);
      if (!pool) throw new InventoryError(`Reservation ${id} has no pool`);
      const cost = allocateRemovalCost(pool.totalCost, pool.quantity, r.quantity);
      s = removeMaterial(s, r.facilityId, r.goods.materialId, r.quantity, cost);
      total = addMoney(total, cost);
    }
  }
  return { state: s, cost: total };
}

const heldBy = (r: ReservationState, contractId: ContractId): boolean => r.holder.kind === "CONTRACT" && r.holder.contractId === contractId;

/**
 * Draws contract cargo (ADR 0013 rule 5): from that contract's reservations on
 * the pool first (in ID order), then from unreserved stock, never another
 * holder's reservation. One removal from the pool, so `cost` is the allocation
 * for the whole quantity. A reservation drawn to 0 is removed and listed in
 * `consumed` (the caller reports it as CONSUMED); a partly drawn one keeps its
 * ID with a smaller quantity.
 */
export function takeForContract(
  state: GameState,
  facilityId: FacilityId,
  contractId: ContractId,
  productId: ProductId,
  quality: QualityTier,
  quantity: number,
): Taken & { readonly consumed: readonly ReservationId[] } {
  const where = `${quality} ${productId} at ${facilityId}`;
  assertQuantity(quantity, where);
  const own = state.reservations.filter((r) => coversProduct(r, facilityId, productId, quality) && heldBy(r, contractId)).sort(compareById);
  const reserved = sumReserved(own, () => true);
  const unreserved = availableProduct(state, facilityId, productId, quality);
  const pool = findProductPool(state, facilityId, productId, quality);
  if (!pool || quantity > reserved + unreserved) {
    throw new InventoryError(`${where}: cannot take ${quantity} for ${contractId}, ${reserved} reserved + ${unreserved} unreserved`);
  }

  let left = quantity;
  const consumed: ReservationId[] = [];
  const drawn = new Map<ReservationId, number>();
  for (const r of own) {
    if (left === 0) break;
    const take = Math.min(r.quantity, left);
    left -= take;
    if (take === r.quantity) consumed.push(r.id);
    else drawn.set(r.id, r.quantity - take);
  }
  const gone = new Set<string>(consumed);
  const reservations = state.reservations.filter((r) => !gone.has(r.id)).map((r) => {
    const remaining = drawn.get(r.id);
    return remaining === undefined ? r : { ...r, quantity: remaining };
  });

  const cost = allocateRemovalCost(pool.totalCost, pool.quantity, quantity);
  const next = removeProduct({ ...state, reservations }, facilityId, productId, quality, quantity, cost);
  return { state: next, cost, consumed };
}

/**
 * A contract ending (ADR 0013 rule 7): removes every reservation it holds; the
 * goods stay in their pools. `released` is in `compareIds` order, for the
 * caller to report each with CONTRACT_ENDED.
 */
export function releaseContractReservations(state: GameState, contractId: ContractId): { readonly state: GameState; readonly released: readonly ReservationId[] } {
  const released = state.reservations.filter((r) => heldBy(r, contractId)).map((r) => r.id).sort(compareIds);
  return { state: released.length === 0 ? state : removeReservations(state, released), released };
}

// ---------------------------------------------------------------------------
// Storage and valuation
// ---------------------------------------------------------------------------

/** Finished-goods cases held at a facility, reserved included; materials don't count. */
export function storageUsed(state: WorldSlice, facilityId: FacilityId): number {
  let total = 0;
  for (const p of state.productPools) if (p.facilityId === facilityId) total += p.quantity;
  return total;
}

/** Total cost of all pools of one kind, for the coordinator's ledger-vs-inventory check. */
export function inventoryValue(pools: readonly { readonly totalCost: Money }[]): Money {
  let total = cents(0);
  for (const p of pools) total = addMoney(total, p.totalCost);
  return total;
}
