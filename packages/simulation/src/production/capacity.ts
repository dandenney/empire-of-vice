// Production capacity rules (T02c1, PROD-001; ADR 0017 decisions 1–3).
//
// Pure helpers over state and game-data. The command handlers and the snapshot
// both call these, so the UI never re-derives a rule. No gameplay number lives
// here: slots, storage, bonuses, and recipe times all come from game-data.
//
// - Throughput is a Ratio: RATIO_SCALE (1×) plus the owned equipment's
//   `throughputBonus`, or 0 when the facility owns none of the equipment any
//   recipe requires. Workers don't affect it until T02c2 (crew factor).
// - A job takes ceil(ticksPerCase × quantity × RATIO_SCALE / throughput) ticks,
//   computed exactly in BigInt. Its `completesAt` is fixed at start (ADR 0008).
// - Storage counts finished cases only: cases held plus the output of running
//   jobs, against baseStorage plus the owned `storageBonus`.

import {
  addMoney,
  multiplyMoney,
  ratio,
  RATIO_SCALE,
  TICKS_PER_DAY,
  type EquipmentId,
  type FacilityId,
  type FacilityState,
  type GameState,
  type Money,
  type Ratio,
} from "@eov/contracts";
import type { EquipmentDefinition, FacilityProductionDefinition, GameData, RecipeDefinition } from "@eov/game-data";
import { storageUsed } from "../inventory/pools.ts";

/** Labor and overhead for `quantity` cases (the run's variable conversion cost, ADR 0017 decision 7). */
export function conversionCost(recipe: RecipeDefinition, quantity: number): Money {
  return multiplyMoney(addMoney(recipe.laborPerCase, recipe.overheadPerCase), quantity);
}

function facilityState(state: GameState, facilityId: FacilityId): FacilityState {
  const facility = state.facilities.find((f) => f.id === facilityId);
  if (!facility) throw new RangeError(`Unknown facility ${facilityId}`);
  return facility;
}

/** The facility's production spec (slots, base storage). Every facility has one (a data test pins it). */
export function facilitySpec(data: GameData, facilityId: FacilityId): FacilityProductionDefinition {
  const spec = data.facilityProduction.find((f) => f.facilityId === facilityId);
  if (!spec) throw new RangeError(`No production spec for facility ${facilityId}`);
  return spec;
}

export function equipmentDefinition(data: GameData, equipmentId: EquipmentId): EquipmentDefinition {
  const def = data.equipment.find((e) => e.id === equipmentId);
  if (!def) throw new RangeError(`Unknown equipment ${equipmentId}`);
  return def;
}

/** Whether the facility owns every item the recipe requires. */
export function supportsRecipe(facility: FacilityState, recipe: RecipeDefinition): boolean {
  return recipe.requiredEquipmentIds.every((id) => facility.equipment.some((e) => e.equipmentId === id));
}

/**
 * The facility's throughput ratio: RATIO_SCALE + Σ owned `throughputBonus`, or
 * 0 if it owns no equipment that any recipe requires.
 */
export function throughput(state: GameState, data: GameData, facilityId: FacilityId): Ratio {
  const facility = facilityState(state, facilityId);
  const producing = facility.equipment.some((e) => data.recipes.some((r) => r.requiredEquipmentIds.includes(e.equipmentId)));
  if (!producing) return ratio(0);
  let total = RATIO_SCALE;
  for (const e of facility.equipment) total += equipmentDefinition(data, e.equipmentId).throughputBonus;
  return ratio(total);
}

/**
 * Ticks a job of `quantity` cases takes at `throughput`:
 * ceil(ticksPerCase × quantity × RATIO_SCALE / throughput), exactly (BigInt).
 * Throws for a zero throughput, which START_PRODUCTION rejects before asking.
 */
export function jobDuration(recipe: RecipeDefinition, quantity: number, throughput: Ratio): number {
  if (!(throughput > 0)) throw new RangeError(`No duration at throughput ${throughput}`);
  const numerator = BigInt(recipe.ticksPerCase) * BigInt(quantity) * BigInt(RATIO_SCALE);
  const denominator = BigInt(throughput);
  const ticks = Number((numerator + denominator - 1n) / denominator);
  if (!Number.isSafeInteger(ticks)) throw new RangeError(`Job duration out of range for ${quantity} × ${recipe.id}`);
  return ticks;
}

/** Finished cases the facility can hold: baseStorage + Σ owned `storageBonus`. */
export function storageCapacity(state: GameState, data: GameData, facilityId: FacilityId): number {
  const facility = facilityState(state, facilityId);
  let total = facilitySpec(data, facilityId).baseStorage;
  for (const e of facility.equipment) total += equipmentDefinition(data, e.equipmentId).storageBonus;
  return total;
}

/** Finished cases held plus the output of jobs running at the facility. Materials don't count. */
export function storageCommitted(state: GameState, facilityId: FacilityId): number {
  let total = storageUsed(state, facilityId);
  for (const job of state.productionJobs) if (job.facilityId === facilityId) total += job.quantity;
  return total;
}

/** Room left for new output: max(0, capacity − committed). */
export function storageAvailable(state: GameState, data: GameData, facilityId: FacilityId): number {
  return Math.max(0, storageCapacity(state, data, facilityId) - storageCommitted(state, facilityId));
}

/**
 * The largest quantity of `recipe` whose derived values all stay safe integers
 * when the job starts at `startTick`: input totals, conversion cost, and the
 * completion tick (rule 6, from #47). The duration is bounded at 1×
 * (ticksPerCase × quantity), which is never shorter than the real one: a
 * facility that can produce runs at RATIO_SCALE or more. Used by
 * START_PRODUCTION's `validate` and `apply` and by the snapshot's search, so
 * the three agree.
 */
export function maxSafeQuantity(recipe: RecipeDefinition, startTick: number): number {
  const safe = Number.MAX_SAFE_INTEGER;
  let bound = safe;
  const perCase = addMoney(recipe.laborPerCase, recipe.overheadPerCase);
  if (perCase > 0) bound = Math.min(bound, Math.floor(safe / perCase));
  if (recipe.ticksPerCase > 0) bound = Math.min(bound, Math.floor((safe - startTick) / recipe.ticksPerCase));
  for (const input of recipe.inputsPerCase) if (input.quantity > 0) bound = Math.min(bound, Math.floor(safe / input.quantity));
  return Math.max(0, bound);
}

/**
 * Cases per game day for the fastest recipe the facility supports at its
 * current throughput: floor(TICKS_PER_DAY × throughput / (ticksPerCase × RATIO_SCALE)).
 * 0 if it supports none or its throughput is 0.
 */
export function productionCapacityPerDay(state: GameState, data: GameData, facilityId: FacilityId): number {
  const facility = facilityState(state, facilityId);
  const rate = throughput(state, data, facilityId);
  if (rate === 0) return 0;
  let best = 0;
  for (const recipe of data.recipes) {
    if (recipe.ticksPerCase <= 0 || !supportsRecipe(facility, recipe)) continue;
    const perDay = Number((BigInt(TICKS_PER_DAY) * BigInt(rate)) / (BigInt(recipe.ticksPerCase) * BigInt(RATIO_SCALE)));
    best = Math.max(best, perDay);
  }
  return best;
}
