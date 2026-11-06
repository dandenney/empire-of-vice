// ECO-001 recurring contracts (T02e, issue #9; GDD §7 "Contracts (M001)";
// ADR 0018 decision 1). Definition types per ADR 0012.
//
// Shared terms for every contract, and which buyers offer one. All numbers are
// PLACEHOLDER tuning that T07a (#12) validates; T05 (#13) sets the unlock.

import { ratio, TICKS_PER_DAY, TICKS_PER_HOUR, type BuyerId, type ProductId, type QualityTier, type Ratio, type UnlockId } from "@eov/contracts";
import { KESSLERS_BACK_ROOM, LAKEVIEW_HOTEL } from "./buyers.ts";
import { MOONSHINE } from "./products.ts";

/** Terms every M001 contract shares (GDD §7). */
export interface ContractTermsDefinition {
  /** Installments per contract. A positive integer. */
  readonly installmentCount: number;
  /** Ticks between installment deadlines. Positive. */
  readonly intervalTicks: number;
  /** The contract's unit price relative to the spot price when offered (1_000_000 = spot). */
  readonly priceRatio: Ratio;
  /** Penalty on the contracted value of missing cases, in parts per million. */
  readonly penaltyRatePpm: number;
  /**
   * The first deadline, in ticks after the start of the offer's day (ADR 0018
   * decision 9): 2 days + 18:00 puts installments at 18:00 on days d+2, d+4, d+6.
   */
  readonly firstDeadlineOffsetTicks: number;
  /** An unlock the family must hold to get or accept offers, or null (T05 sets it). */
  readonly requiredUnlockId: UnlockId | null;
}

/** A buyer that offers contracts, and what it contracts for. */
export interface ContractBuyerDefinition {
  readonly buyerId: BuyerId;
  readonly productId: ProductId;
  /** The lowest quality accepted. The price is 95% of this (product, quality) market's spot. */
  readonly minimumQuality: QualityTier;
  /** Cases due per installment. A positive integer. */
  readonly quantityPerInstallment: number;
}

export interface ContractsDefinition {
  readonly terms: ContractTermsDefinition;
  readonly buyers: readonly ContractBuyerDefinition[];
}

export const CONTRACTS: ContractsDefinition = {
  terms: {
    installmentCount: 3, // PLACEHOLDER (GDD §7; T07a validates)
    intervalTicks: 2 * TICKS_PER_DAY, // PLACEHOLDER (GDD §7: every 2 game days; T07a validates)
    priceRatio: ratio(950_000), // PLACEHOLDER (GDD §7: 95% of spot; T07a validates)
    penaltyRatePpm: 200_000, // PLACEHOLDER (GDD §7: 20% of missing cases' value; T07a validates)
    firstDeadlineOffsetTicks: 2 * TICKS_PER_DAY + 18 * TICKS_PER_HOUR, // PLACEHOLDER (GDD §14.5, ADR 0018 decision 9; T07a validates)
    requiredUnlockId: null, // PLACEHOLDER (T05 sets it)
  },
  // The roadhouse offers no contract.
  buyers: [
    { buyerId: KESSLERS_BACK_ROOM, productId: MOONSHINE, minimumQuality: "basic", quantityPerInstallment: 8 }, // PLACEHOLDER (tuning; T07a validates)
    { buyerId: LAKEVIEW_HOTEL, productId: MOONSHINE, minimumQuality: "standard", quantityPerInstallment: 6 }, // PLACEHOLDER (tuning; T07a validates)
  ],
};
