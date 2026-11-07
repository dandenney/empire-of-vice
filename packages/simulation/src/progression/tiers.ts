// Tier promotion (T05e, issue #104; GDD §9 PROG-001; ADR 0020 decision 4).
//
// - Tiers are ordered as game-data lists them. The family is promoted to tier k
//   when it holds tier k−1 and meets k's net worth and reputation thresholds (a
//   null threshold always passes). Several tiers can be reached on one tick, in
//   ascending order.
// - Each promotion is one PROGRESSION transaction with no entries, keyed
//   `PROGRESSION:TIER:<tierId>`. It sets `family.tierId`, adds the tier's new
//   unlocks to `family.unlocked` (no duplicates, sorted with `compareIds`), and
//   emits TIER_REACHED then one UNLOCK_GRANTED per new unlock in listed order.
// - Tiers and unlocks are never revoked. The starting tier emits nothing.

import { compareIds, idempotencyKey, type GameState, type TransactionCoordinator, type UnlockId } from "@eov/contracts";
import type { GameData, TierDefinition } from "@eov/game-data";
import { balanceSheet } from "../economy/ledger/ledger.ts";
import type { TickContext } from "../kernel/registry.ts";

function qualifies(tier: TierDefinition, state: GameState): boolean {
  if (tier.reputationRequired !== null && state.family.reputation < tier.reputationRequired) return false;
  return tier.netWorthRequired === null || balanceSheet(state).netWorth >= tier.netWorthRequired;
}

function promote(state: GameState, tier: TierDefinition, coordinator: TransactionCoordinator, ctx: TickContext): GameState {
  const tx = coordinator.begin(state, {
    kind: "PROGRESSION",
    idempotencyKey: idempotencyKey("PROGRESSION", "TIER", tier.id),
    tick: ctx.tick,
    causedBy: null,
  });
  if (tx.status === "duplicate") return state;

  const held = new Set<UnlockId>(state.family.unlocked);
  const granted: UnlockId[] = [];
  for (const unlockId of tier.unlocks) {
    if (held.has(unlockId)) continue;
    held.add(unlockId);
    granted.push(unlockId);
  }
  const unlocked = [...held].sort(compareIds);
  tx.update((s) => ({ ...s, family: { ...s.family, tierId: tier.id, unlocked } }));
  tx.emit({ type: "TIER_REACHED", tierId: tier.id });
  for (const unlockId of granted) tx.emit({ type: "UNLOCK_GRANTED", unlockId });

  const result = tx.commit();
  if (result.status !== "committed") throw new Error(`Promotion to ${tier.id} was rejected: ${JSON.stringify(result.reason)}`);
  return result.state;
}

/** Promotes the family through every tier it now qualifies for, in ascending order. */
export function promoteTiers(state: GameState, data: GameData, coordinator: TransactionCoordinator, ctx: TickContext): GameState {
  const { tiers } = data.progression;
  const current = tiers.findIndex((t) => t.id === state.family.tierId);
  if (current < 0) throw new RangeError(`Progression: unknown tier ${state.family.tierId}`);
  let s = state;
  for (let k = current + 1; k < tiers.length; k++) {
    const tier = tiers[k]!;
    if (!qualifies(tier, s)) break;
    s = promote(s, tier, coordinator, ctx);
  }
  return s;
}
