// Insolvency (T05f, issue #105; GDD §9 Recovery, §14.9; ADR 0020 decisions 8
// and 10).
//
// Checked in the progression `midnight` hook, which runs last at midnight (after
// payroll, overhead, and penalty paydown), and only while `outcome` is PLAYING.
// The family is insolvent when both hold:
//
// - No goods:
//   - every product pool is empty;
//   - no delivery is OUTBOUND, and no FAILED delivery still holds cargo (a sale
//     that fell through, or a transfer's leftovers, riding home). Equivalently,
//     every delivery whose status isn't DELIVERED has empty cargo. A DELIVERED
//     delivery keeps its cargo for good, so it never counts;
//   - no production job is running.
// - No recipe offers a restart. Recipe R at an owned facility is a restart route
//   when it is feasible and funds(R) ≥ cost(R), at base prices:
//   - cost(R): the price of each required item the facility lacks, plus each
//     input's shortfall against unreserved materials on hand × that material's
//     lowest base `unitPrice` among the suppliers in play (game-data, ignoring
//     shortages), plus one case's conversion cost;
//   - funds(R): cash plus the resale value of the owned equipment R doesn't
//     require;
//   - R is infeasible if a required item it lacks is LOCKED, if no supplier in
//     play sells one of its inputs, or if no buyer in play with
//     `minimumReputation` ≤ the family's reputation wants its product at a
//     minimum quality at or below the recipe's.
//   Base prices on purpose: a shortage can delay a restart, but it can't cause a
//   loss.
//
// The loss is one PROGRESSION transaction with no entries, keyed
// `PROGRESSION:LOST`. It sets `outcome = { LOST, tick, INSOLVENT }` and emits
// GAME_LOST { INSOLVENT }.

import {
  idempotencyKey,
  qualityRank,
  type FacilityState,
  type GameState,
  type MaterialId,
  type TransactionCoordinator,
} from "@eov/contracts";
import type { GameData, RecipeDefinition } from "@eov/game-data";
import { cashBalance } from "../economy/ledger/ledger.ts";
import { availableMaterial } from "../inventory/pools.ts";
import type { TickContext } from "../kernel/registry.ts";
import { conversionCost } from "../production/capacity.ts";
import { resaleValue } from "../production/equipment.ts";

/**
 * Decision 10's "no goods": empty product pools, no OUTBOUND delivery, no FAILED
 * delivery holding cargo (a fallen-through sale or a transfer's leftovers riding
 * home), and no running job.
 */
export function hasNoGoods(state: GameState): boolean {
  if (state.productionJobs.length > 0) return false;
  if (state.productPools.some((p) => p.quantity > 0)) return false;
  return state.deliveries.every((d) => d.status === "DELIVERED" || (d.status !== "OUTBOUND" && d.cargo.every((line) => line.quantity === 0)));
}

/** The lowest base `unitPrice` for a material among the suppliers in play, or null when none sells it. */
function basePrice(state: GameState, data: GameData, materialId: MaterialId): number | null {
  let best: number | null = null;
  for (const supplier of state.suppliers) {
    const line = data.suppliers.find((d) => d.id === supplier.id)?.stock.find((s) => s.materialId === materialId);
    if (line && (best === null || line.unitPrice < best)) best = line.unitPrice;
  }
  return best;
}

/** Some buyer in play the family may sell to wants the recipe's product at its quality. */
function hasBuyer(state: GameState, data: GameData, recipe: RecipeDefinition): boolean {
  const rank = qualityRank(recipe.quality);
  return state.buyers.some((buyer) => {
    const def = data.buyers.find((d) => d.id === buyer.id);
    if (!def || def.minimumReputation > state.family.reputation) return false;
    return buyer.wants.some((w) => w.productId === recipe.productId && qualityRank(w.minimumQuality) <= rank);
  });
}

/** True when recipe R is feasible at the facility and funds(R) ≥ cost(R). */
function offersRestart(state: GameState, data: GameData, facility: FacilityState, recipe: RecipeDefinition, cash: number): boolean {
  let cost: number = conversionCost(recipe, 1);
  for (const id of recipe.requiredEquipmentIds) {
    if (facility.equipment.some((e) => e.equipmentId === id)) continue;
    const item = data.equipment.find((e) => e.id === id);
    if (!item) return false;
    if (item.requiredUnlockId !== null && !state.family.unlocked.includes(item.requiredUnlockId)) return false;
    cost += item.price;
  }
  for (const input of recipe.inputsPerCase) {
    const price = basePrice(state, data, input.materialId);
    if (price === null) return false;
    const shortfall = Math.max(0, input.quantity - availableMaterial(state, facility.id, input.materialId));
    cost += shortfall * price;
  }
  if (!hasBuyer(state, data, recipe)) return false;
  let funds: number = cash;
  for (const owned of facility.equipment) {
    if (!recipe.requiredEquipmentIds.includes(owned.equipmentId)) funds += resaleValue(owned.bookValue, data);
  }
  return funds >= cost;
}

/** Decision 10's insolvency rule: no goods, and no feasible recipe at any owned facility offers a restart. */
export function isInsolvent(state: GameState, data: GameData): boolean {
  if (!hasNoGoods(state)) return false;
  const cash = cashBalance(state);
  for (const facility of state.facilities) {
    for (const recipe of data.recipes) {
      if (offersRestart(state, data, facility, recipe, cash)) return false;
    }
  }
  return true;
}

/** Records the loss at midnight if the family is insolvent while the game is still PLAYING. */
export function checkInsolvency(state: GameState, data: GameData, coordinator: TransactionCoordinator, ctx: TickContext): GameState {
  if (!ctx.isMidnight || state.outcome.status !== "PLAYING" || !isInsolvent(state, data)) return state;
  const tx = coordinator.begin(state, {
    kind: "PROGRESSION",
    idempotencyKey: idempotencyKey("PROGRESSION", "LOST"),
    tick: ctx.tick,
    causedBy: null,
  });
  if (tx.status === "duplicate") return state;
  tx.update((s) => ({ ...s, outcome: { status: "LOST", tick: ctx.tick, reason: "INSOLVENT" } }));
  tx.emit({ type: "GAME_LOST", reason: "INSOLVENT" });
  const result = tx.commit();
  if (result.status !== "committed") throw new Error(`Insolvency was rejected: ${JSON.stringify(result.reason)}`);
  return result.state;
}
