// The Facility panel's view helpers (#128). Every figure comes from the
// snapshot; these only pick and format it.

import { formatMoney, type GameSnapshot, type RejectionReason, type TierSnapshot, type UnlockId } from "@eov/contracts";
import { describeReason } from "../../components/format.ts";
import { FACILITY_COPY as C } from "./copy.ts";

/** The tier that grants an unlock, from the snapshot's progression, or null if none does. */
export function tierGranting(snapshot: GameSnapshot, unlockId: UnlockId): TierSnapshot | null {
  return snapshot.progression.tiers.find((t) => t.unlocks.includes(unlockId)) ?? null;
}

/** A tier's requirements as the snapshot states them: "net worth $1,500.00 and reputation 10". */
export function tierRequirements(tier: TierSnapshot): string {
  const parts = [
    ...(tier.netWorthRequired === null ? [] : [C.requirementNetWorth(formatMoney(tier.netWorthRequired))]),
    ...(tier.reputationRequired === null ? [] : [C.requirementReputation(tier.reputationRequired)]),
  ];
  return parts.length === 0 ? C.requirementNone : C.requirementList(parts);
}

/**
 * Why an option can't be bought, as lines: the typed reason, as it reads
 * elsewhere. A LOCKED reason names the unlock by id (the snapshot has no
 * unlock display name yet, #124), so a second line names the tier that grants
 * it, with that tier's requirements, all from the snapshot.
 */
export function describeBlocker(snapshot: GameSnapshot, reason: RejectionReason): readonly string[] {
  const tier = reason.code === "LOCKED" ? tierGranting(snapshot, reason.unlockId) : null;
  return [describeReason(reason), ...(tier ? [C.unlockedAt(tier.name, tierRequirements(tier))] : [])];
}
