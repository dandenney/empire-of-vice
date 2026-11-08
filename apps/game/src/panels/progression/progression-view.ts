// Progression view helpers (#136). Everything is read from the snapshot's
// progression, family, finance, and buyers; nothing here decides a promotion.
// "Met" only compares a figure the snapshot gives with the threshold it gives;
// whether a tier is reached is the snapshot's `reached`.

import { formatMoney, type BuyerSnapshot, type GameSnapshot, type Money, type TierSnapshot, type UnlockId } from "@eov/contracts";
import { PROGRESSION_COPY as C, UNLOCK_COPY } from "./copy.ts";

export function unlockLabel(id: UnlockId): string {
  return UNLOCK_COPY[id] ?? id;
}

export function unlockList(ids: readonly UnlockId[]): string {
  return C.list(ids.map(unlockLabel));
}

/** The tier the family holds, from `progression.currentTierId`. */
export function currentTier(snapshot: GameSnapshot): TierSnapshot | null {
  return snapshot.progression.tiers.find((t) => t.id === snapshot.progression.currentTierId) ?? null;
}

/** The tier after the current one in the snapshot's ascending ladder, or null at the top. */
export function nextTier(snapshot: GameSnapshot): TierSnapshot | null {
  const { tiers, currentTierId } = snapshot.progression;
  const index = tiers.findIndex((t) => t.id === currentTierId);
  return index >= 0 ? (tiers[index + 1] ?? null) : null;
}

export type Requirement =
  | { readonly kind: "net-worth"; readonly required: Money | null; readonly current: Money; readonly met: boolean }
  | { readonly kind: "reputation"; readonly required: number | null; readonly current: number; readonly met: boolean };

/** A tier's two thresholds beside the family's current figures. A null threshold always passes. */
export function requirements(tier: TierSnapshot, snapshot: GameSnapshot): readonly Requirement[] {
  const netWorth = snapshot.finance.netWorth;
  const reputation = snapshot.family.reputation;
  return [
    { kind: "net-worth", required: tier.netWorthRequired, current: netWorth, met: tier.netWorthRequired === null || netWorth >= tier.netWorthRequired },
    { kind: "reputation", required: tier.reputationRequired, current: reputation, met: tier.reputationRequired === null || reputation >= tier.reputationRequired },
  ];
}

/** "net worth $1,500.00, reputation 10", "Nothing" for a tier without thresholds. */
export function describeNeeds(tier: TierSnapshot): string {
  const parts = [
    ...(tier.netWorthRequired === null ? [] : [C.needsNetWorth(formatMoney(tier.netWorthRequired))]),
    ...(tier.reputationRequired === null ? [] : [C.needsReputation(tier.reputationRequired)]),
  ];
  return parts.length === 0 ? C.needsNothing : C.needsList(parts);
}

export type TierStatus = "current" | "reached" | "not-reached";

export function tierStatus(tier: TierSnapshot, snapshot: GameSnapshot): TierStatus {
  if (tier.id === snapshot.progression.currentTierId) return "current";
  return tier.reached ? "reached" : "not-reached";
}

export type VictoryCondition =
  | { readonly kind: "net-worth"; readonly current: Money; readonly target: Money; readonly met: boolean }
  | { readonly kind: "reputation" | "completed-contracts"; readonly current: number; readonly target: number; readonly met: boolean };

/** The three victory conditions (GDD §4), current against target, as the snapshot gives them. */
export function victoryConditions(snapshot: GameSnapshot): readonly VictoryCondition[] {
  const v = snapshot.progression.victory;
  return [
    { kind: "net-worth", current: v.netWorth.current, target: v.netWorth.target, met: v.netWorth.current >= v.netWorth.target },
    { kind: "reputation", current: v.reputation.current, target: v.reputation.target, met: v.reputation.current >= v.reputation.target },
    {
      kind: "completed-contracts",
      current: v.completedContracts.current,
      target: v.completedContracts.target,
      met: v.completedContracts.current >= v.completedContracts.target,
    },
  ];
}

/** Buyers with a reputation minimum, in the snapshot's order. */
export function reputationGatedBuyers(snapshot: GameSnapshot): readonly BuyerSnapshot[] {
  return snapshot.market.buyers.filter((b) => b.minimumReputation > 0);
}
