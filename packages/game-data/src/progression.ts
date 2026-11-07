// Progression (T05b, issue #101; GDD §9 PROG-001; ADR 0020 decisions 3, 5, 7, 9, 17).
// Definition types per ADR 0012.
//
// The tier thresholds and display names are GDD §9's (names final per #99,
// point 1). Recurring contracts are open from tier 1, a deliberate deviation the
// user approved on #99 (point 6). Victory's thresholds are GDD §2 assumption 5
// and aren't tuning levers. Every other number is a PLACEHOLDER that T05g tunes.

import { asId, cents, ratio, type Money, type Ratio, type TierId, type UnlockId } from "@eov/contracts";

export interface TierDefinition {
  readonly id: TierId;
  /** Display name. */
  readonly name: string;
  /** Net worth needed to reach this tier, or null (always passes). */
  readonly netWorthRequired: Money | null;
  /** Reputation (0–100) needed to reach this tier, or null (always passes). */
  readonly reputationRequired: number | null;
  /** What reaching this tier grants, in grant order. */
  readonly unlocks: readonly UnlockId[];
}

/** Signed reputation amounts (ADR 0020 decision 5). The 0–100 bounds are the contract's invariant, not data. */
export interface ReputationRulesDefinition {
  /** Once per game, for the first delivery of at least `qualifyingDeliveryMinimumCases` cases. */
  readonly firstQualifyingDelivery: number;
  readonly qualifyingDeliveryMinimumCases: number;
  readonly installmentFulfilled: number;
  /** Added to a fulfilled installment once the streak is at least 2. */
  readonly consecutiveInstallmentBonus: number;
  /** Negative. */
  readonly installmentPartial: number;
  /** Negative. */
  readonly installmentMissed: number;
}

export interface VictoryDefinition {
  readonly netWorth: Money;
  readonly reputation: number;
  /** Contracts with status COMPLETED (every installment settled). */
  readonly completedContracts: number;
}

export interface RecoveryDefinition {
  /** Applied to an owned item's book value when it's sold (SELL_EQUIPMENT). In (0, RATIO_SCALE). */
  readonly equipmentResaleRatio: Ratio;
}

export interface ProgressionDefinition {
  /** In ascending order. The first tier has null thresholds. */
  readonly tiers: readonly TierDefinition[];
  readonly reputation: ReputationRulesDefinition;
  readonly victory: VictoryDefinition;
  readonly recovery: RecoveryDefinition;
}

export const STARTING_OPERATION = asId("Tier", "starting-operation");
export const TRUSTED_SUPPLIER = asId("Tier", "trusted-supplier");
export const ESTABLISHED_PRODUCER = asId("Tier", "established-producer");
export const REGIONAL_DISTRIBUTOR = asId("Tier", "regional-distributor");

/** Descriptive: spot sales are never gated. */
export const SPOT_SALES = asId("Unlock", "spot-sales");
/** The improved condenser and storage expansion (T05e sets their `requiredUnlockId`). */
export const CAPACITY_EQUIPMENT = asId("Unlock", "capacity-equipment");
/** The QC station, and so standard moonshine (T05e sets its `requiredUnlockId`). */
export const QUALITY_EQUIPMENT = asId("Unlock", "quality-equipment");
/** Gates nothing in M001. */
export const NEXT_REGION = asId("Unlock", "next-region");

export const TIERS: readonly TierDefinition[] = [
  { id: STARTING_OPERATION, name: "Starting Operation", netWorthRequired: null, reputationRequired: null, unlocks: [SPOT_SALES] },
  { id: TRUSTED_SUPPLIER, name: "Trusted Supplier", netWorthRequired: cents(150_000), reputationRequired: 10, unlocks: [CAPACITY_EQUIPMENT] }, // PLACEHOLDER thresholds (GDD §9)
  { id: ESTABLISHED_PRODUCER, name: "Established Producer", netWorthRequired: cents(250_000), reputationRequired: 20, unlocks: [QUALITY_EQUIPMENT] }, // PLACEHOLDER thresholds (GDD §9)
  { id: REGIONAL_DISTRIBUTOR, name: "Regional Distributor", netWorthRequired: cents(500_000), reputationRequired: 30, unlocks: [NEXT_REGION] }, // PLACEHOLDER thresholds (GDD §9)
];

export const REPUTATION_RULES: ReputationRulesDefinition = {
  firstQualifyingDelivery: 3, // PLACEHOLDER
  qualifyingDeliveryMinimumCases: 5, // PLACEHOLDER
  installmentFulfilled: 5, // PLACEHOLDER
  consecutiveInstallmentBonus: 2, // PLACEHOLDER
  installmentPartial: -3, // PLACEHOLDER
  installmentMissed: -8, // PLACEHOLDER
};

/** GDD §2 assumption 5 (GDD §4 victory). Not a tuning lever (ADR 0020 decision 15). */
export const VICTORY: VictoryDefinition = {
  netWorth: cents(500_000),
  reputation: 30,
  completedContracts: 1,
};

export const RECOVERY: RecoveryDefinition = {
  equipmentResaleRatio: ratio(500_000), // PLACEHOLDER (50%)
};

export const PROGRESSION: ProgressionDefinition = {
  tiers: TIERS,
  reputation: REPUTATION_RULES,
  victory: VICTORY,
  recovery: RECOVERY,
};
