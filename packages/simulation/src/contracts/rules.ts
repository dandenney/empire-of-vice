// Recurring-contract rules (T02e, issue #9; GDD §7 ECO-001; ADR 0018).
//
// Pure functions over GameState and game-data, shared by the contracts system
// (offers, ACCEPT_CONTRACT, settlement, paydown), logistics (an installment's
// dispatch checks and arrival crediting), and the snapshot projection. Nothing
// here posts to the ledger or emits events: callers stage the results through
// their TransactionDraft. Nothing here draws random numbers (decision 13).

import {
  applyRatios,
  compareById,
  dayIndex,
  multiplyMoney,
  qualityRank,
  ratio,
  TICKS_PER_DAY,
  tick,
  type CargoLine,
  type ContractId,
  type ContractOfferId,
  type ContractOfferState,
  type ContractState,
  type FacilityId,
  type GameState,
  type InstallmentOutcome,
  type Money,
  type RejectionReason,
  type ReservationId,
  type Tick,
} from "@eov/contracts";
import type { ContractBuyerDefinition, GameData } from "@eov/game-data";
import { addReservation, availableProduct } from "../inventory/pools.ts";
import { allocateId } from "../kernel/ids.ts";

export type Installment = ContractState["installments"][number];

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The contract buyers in ID order (decision 2: the midnight hook checks them in this order). */
export function contractBuyers(data: GameData): readonly ContractBuyerDefinition[] {
  return [...data.contracts.buyers].sort((a, b) => byString(a.buyerId, b.buyerId));
}

export function contractBuyer(data: GameData, buyerId: string): ContractBuyerDefinition | undefined {
  return data.contracts.buyers.find((b) => b.buyerId === buyerId);
}

function minimumReputation(data: GameData, buyerId: string): number {
  const def = data.buyers.find((b) => b.id === buyerId);
  if (!def) throw new RangeError(`Contract buyer ${buyerId} has no buyer definition`);
  return def.minimumReputation;
}

/** The unlock or reputation check shared by offers and acceptance (decisions 2 and 3), or null if both pass. */
function gateRejection(state: GameState, data: GameData, buyerId: string): RejectionReason | null {
  const unlockId = data.contracts.terms.requiredUnlockId;
  if (unlockId !== null && !state.family.unlocked.includes(unlockId)) return { code: "LOCKED", unlockId };
  const required = minimumReputation(data, buyerId);
  const current = state.family.reputation;
  return current >= required ? null : { code: "REPUTATION_TOO_LOW", required, current };
}

// ---------------------------------------------------------------------------
// Offers (decision 2)
// ---------------------------------------------------------------------------

/** Whether a buyer gets an offer now: it offers contracts, has no open offer or ACTIVE contract, and passes the gate. */
export function offerEligible(state: GameState, data: GameData, buyerId: string): boolean {
  if (!contractBuyer(data, buyerId)) return false;
  if (state.contractOffers.some((o) => o.buyerId === buyerId)) return false;
  if (state.contracts.some((c) => c.buyerId === buyerId && c.status === "ACTIVE")) return false;
  return gateRejection(state, data, buyerId) === null;
}

/** The offer a buyer makes at `at`, priced from the current spot (read after any midnight update on that tick). */
export function buildOffer(state: GameState, data: GameData, def: ContractBuyerDefinition, id: ContractOfferId, at: Tick): ContractOfferState {
  const { terms } = data.contracts;
  const market = state.markets.find((m) => m.productId === def.productId && m.quality === def.minimumQuality);
  if (!market) throw new RangeError(`Contract buyer ${def.buyerId} has no ${def.productId} ${def.minimumQuality} market`);
  const day = dayIndex(at);
  return {
    id,
    buyerId: def.buyerId,
    productId: def.productId,
    minimumQuality: def.minimumQuality,
    quantityPerInstallment: def.quantityPerInstallment,
    unitPrice: applyRatios(market.spotPrice, [terms.priceRatio]),
    installmentCount: terms.installmentCount,
    intervalTicks: terms.intervalTicks,
    penaltyRatePpm: terms.penaltyRatePpm,
    firstDeadline: tick(day * TICKS_PER_DAY + terms.firstDeadlineOffsetTicks),
    expiresAt: tick((day + 1) * TICKS_PER_DAY),
  };
}

// ---------------------------------------------------------------------------
// Accepting (decision 3)
// ---------------------------------------------------------------------------

/** Why ACCEPT_CONTRACT applied at `at` (the tick being processed) is rejected, or null. Checks in decision 3's order. */
export function acceptRejection(state: GameState, data: GameData, contractOfferId: ContractOfferId, at: Tick): RejectionReason | null {
  const offer = state.contractOffers.find((o) => o.id === contractOfferId);
  if (!offer || at >= offer.expiresAt) return { code: "OFFER_UNAVAILABLE", contractOfferId };
  return gateRejection(state, data, offer.buyerId);
}

/** The ACTIVE contract an accepted offer becomes, with no reservations yet. */
export function contractFromOffer(offer: ContractOfferState, id: ContractId): ContractState {
  return {
    id,
    offerId: offer.id,
    buyerId: offer.buyerId,
    productId: offer.productId,
    minimumQuality: offer.minimumQuality,
    quantityPerInstallment: offer.quantityPerInstallment,
    unitPrice: offer.unitPrice,
    installmentCount: offer.installmentCount,
    intervalTicks: offer.intervalTicks,
    penaltyRatePpm: offer.penaltyRatePpm,
    status: "ACTIVE",
    installments: Array.from({ length: offer.installmentCount }, (_, k) => ({
      deadline: tick(offer.firstDeadline + k * offer.intervalTicks),
      required: offer.quantityPerInstallment,
      delivered: 0,
      outcome: null,
      penalty: null,
    })),
    reservationIds: [],
  };
}

export function withContract(state: GameState, contract: ContractState): GameState {
  const exists = state.contracts.some((c) => c.id === contract.id);
  const contracts = exists ? state.contracts.map((c) => (c.id === contract.id ? contract : c)) : [...state.contracts, contract].sort(compareById);
  return { ...state, contracts };
}

// ---------------------------------------------------------------------------
// Reservations (decision 4)
// ---------------------------------------------------------------------------

const holds = (contractId: ContractId) => (r: GameState["reservations"][number]) => r.holder.kind === "CONTRACT" && r.holder.contractId === contractId;

/** The contract's active reservations (derived by holder; `reservationIds` is append-only history). */
export function activeReservations(state: GameState, contractId: ContractId): GameState["reservations"] {
  return state.reservations.filter(holds(contractId));
}

/**
 * Tops up the contract's reservations toward its current (first unsettled)
 * installment: target = required − delivered − cases already reserved for it.
 * Takes unreserved stock of the product at quality ≥ the minimum, facilities in
 * ID order then lowest quality first, one new reservation per slice. A shortfall
 * is fine. Returns the new state (contract's `reservationIds` appended) and the
 * reservations created.
 */
export function reserveForCurrentInstallment(state: GameState, contractId: ContractId): { readonly state: GameState; readonly created: readonly ReservationId[] } {
  const contract = state.contracts.find((c) => c.id === contractId);
  if (!contract) throw new RangeError(`No contract ${contractId}`);
  const current = contract.installments.find((i) => i.outcome === null);
  if (!current) return { state, created: [] };
  const reserved = activeReservations(state, contractId).reduce((n, r) => n + r.quantity, 0);
  let left = current.required - current.delivered - reserved;
  if (left <= 0) return { state, created: [] };

  const minimum = qualityRank(contract.minimumQuality);
  const slices = state.productPools
    .filter((p) => p.productId === contract.productId && qualityRank(p.quality) >= minimum)
    .sort((a, b) => byString(a.facilityId, b.facilityId) || qualityRank(a.quality) - qualityRank(b.quality));
  let s = state;
  const created: ReservationId[] = [];
  for (const pool of slices) {
    if (left === 0) break;
    const take = Math.min(left, availableProduct(s, pool.facilityId, pool.productId, pool.quality));
    if (take <= 0) continue;
    const minted = allocateId(s, "Reservation");
    s = addReservation(minted.state, {
      id: minted.id,
      facilityId: pool.facilityId,
      goods: { kind: "PRODUCT", productId: pool.productId, quality: pool.quality },
      quantity: take,
      holder: { kind: "CONTRACT", contractId },
    });
    created.push(minted.id);
    left -= take;
  }
  if (created.length === 0) return { state, created };
  return { state: withContract(s, { ...contract, reservationIds: [...contract.reservationIds, ...created] }), created };
}

// ---------------------------------------------------------------------------
// Dispatching an installment (decision 5)
// ---------------------------------------------------------------------------

/** Checks 1–2: the contract is ACTIVE and the cargo matches it. Returns the contract, or why not. */
export function contractForCargo(state: GameState, contractId: ContractId, line: CargoLine): ContractState | RejectionReason {
  const contract = state.contracts.find((c) => c.id === contractId);
  if (!contract || contract.status !== "ACTIVE") return { code: "CONTRACT_NOT_ACTIVE", contractId };
  if (line.productId !== contract.productId || qualityRank(line.quality) < qualityRank(contract.minimumQuality)) {
    return { code: "CARGO_DOES_NOT_MATCH_CONTRACT", contractId };
  }
  return contract;
}

/** Cases of this contract on outbound deliveries. */
export function casesInTransit(state: GameState, contractId: ContractId): number {
  let total = 0;
  for (const d of state.deliveries) {
    if (d.status !== "OUTBOUND" || d.purpose.kind !== "CONTRACT_INSTALLMENT" || d.purpose.contractId !== contractId) continue;
    for (const line of d.cargo) total += line.quantity;
  }
  return total;
}

/**
 * Checks 4–5, after the route checks: the quantity cap (what unsettled
 * installments still need, minus cases in transit), then stock (this contract's
 * reservations at home plus unreserved stock). Null if the load is fine.
 */
export function contractLoadRejection(state: GameState, contract: ContractState, homeId: FacilityId, line: CargoLine): RejectionReason | null {
  let outstanding = 0;
  for (const i of contract.installments) if (i.outcome === null) outstanding += Math.max(0, i.required - i.delivered);
  const acceptable = Math.max(0, outstanding - casesInTransit(state, contract.id));
  if (line.quantity > acceptable) return { code: "BUYER_WILL_TAKE_LESS", buyerId: contract.buyerId, requested: line.quantity, acceptable };

  const own = activeReservations(state, contract.id)
    .filter((r) => r.facilityId === homeId && r.goods.kind === "PRODUCT" && r.goods.productId === line.productId && r.goods.quality === line.quality)
    .reduce((n, r) => n + r.quantity, 0);
  const available = own + availableProduct(state, homeId, line.productId, line.quality);
  if (available < line.quantity) {
    return { code: "INSUFFICIENT_STOCK", productId: line.productId, quality: line.quality, requested: line.quantity, available };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Arrival crediting (decision 6)
// ---------------------------------------------------------------------------

/**
 * Credits `cases` arriving at `at` to unsettled installments whose deadline is
 * still ≥ `at`, in index order, each up to its requirement. Extra cases credit
 * nothing. Returns the cases credited per installment.
 */
export function creditCases(installments: readonly Installment[], cases: number, at: number): readonly number[] {
  let left = cases;
  return installments.map((i) => {
    if (left === 0 || i.outcome !== null || i.deadline < at) return 0;
    const take = Math.min(left, Math.max(0, i.required - i.delivered));
    left -= take;
    return take;
  });
}

export function withCredit(contract: ContractState, credit: readonly number[]): ContractState {
  return { ...contract, installments: contract.installments.map((i, k) => (credit[k] ? { ...i, delivered: i.delivered + credit[k]! } : i)) };
}

// ---------------------------------------------------------------------------
// Settlement (decision 7)
// ---------------------------------------------------------------------------

export function installmentOutcome(required: number, delivered: number): InstallmentOutcome {
  return delivered >= required ? "FULFILLED" : delivered > 0 ? "PARTIAL" : "MISSED";
}

/** 20% (the contract's rate) of the contracted value of missing cases, rounded once (ADR 0002). */
export function installmentPenalty(contract: ContractState, installment: Installment): Money {
  const missing = Math.max(0, installment.required - installment.delivered);
  return applyRatios(multiplyMoney(contract.unitPrice, missing), [ratio(contract.penaltyRatePpm)]);
}
