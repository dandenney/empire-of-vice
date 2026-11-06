// Production capacity rules (T02c1 and T02c2, PROD-001; ADR 0017 decisions 1–3).
//
// Pure helpers over state and game-data. The command handlers and the snapshot
// both call these, so the UI never re-derives a rule. No gameplay number lives
// here: slots, storage, bonuses, and recipe times all come from game-data.
//
// - Throughput is a Ratio: RATIO_SCALE (1×) plus the owned equipment's
//   `throughputBonus`, or 0 when the facility owns none of the equipment any
//   recipe requires, scaled by the crew factor (T02c2): staffed / crew, where
//   crew = Σ owned `crew` and staffed = min(workers, crew); 1× when crew = 0.
// - A job takes ceil(ticksPerCase × quantity × RATIO_SCALE × crew / (base × staffed))
//   ticks, computed exactly in BigInt. Its `completesAt` is fixed at start (ADR 0008).
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
 * The terms of ADR 0017 decision 1 at a facility:
 * - `producing`: it owns equipment some recipe requires;
 * - `base`: RATIO_SCALE + Σ owned `throughputBonus`;
 * - `crew`: Σ owned `crew`;
 * - `staffed`: min(workerCount, crew).
 */
export interface CrewTerms {
  readonly producing: boolean;
  readonly base: number;
  readonly crew: number;
  readonly staffed: number;
}

export function crewTerms(state: GameState, data: GameData, facilityId: FacilityId): CrewTerms {
  const facility = facilityState(state, facilityId);
  const producing = facility.equipment.some((e) => data.recipes.some((r) => r.requiredEquipmentIds.includes(e.equipmentId)));
  let base = RATIO_SCALE;
  let crew = 0;
  for (const e of facility.equipment) {
    const def = equipmentDefinition(data, e.equipmentId);
    base += def.throughputBonus;
    crew += def.crew;
  }
  return { producing, base, crew, staffed: Math.min(facility.workerCount, crew) };
}

/** Whether the facility can run a job at all: it owns recipe equipment, and someone staffs a crewed facility. */
function canProduce(t: CrewTerms): boolean {
  return t.producing && (t.crew === 0 || t.staffed > 0);
}

/**
 * The facility's displayed throughput ratio: floor(base × staffed / crew), or
 * `base` when the crew is 0. 0 when it owns no recipe equipment, or when a
 * crewed facility has no one staffing it. For display and
 * `productionCapacityPerDay` only: durations never pass through it.
 */
export function throughput(state: GameState, data: GameData, facilityId: FacilityId): Ratio {
  const t = crewTerms(state, data, facilityId);
  if (!canProduce(t)) return ratio(0);
  if (t.crew === 0) return ratio(t.base);
  return ratio(Number((BigInt(t.base) * BigInt(t.staffed)) / BigInt(t.crew)));
}

/**
 * Ticks a job of `quantity` cases takes at base ratio `throughput` with
 * `staffed` of `crew` workers:
 * ceil(ticksPerCase × quantity × RATIO_SCALE × crew / (throughput × staffed)),
 * exactly (BigInt). The defaults (crew = staffed = 1) are a full crew, and also
 * what a crew of 0 means. Throws for a zero throughput or no one staffed, which
 * START_PRODUCTION rejects before asking.
 */
export function jobDuration(recipe: RecipeDefinition, quantity: number, throughput: Ratio, crew = 1, staffed = 1): number {
  if (!(throughput > 0)) throw new RangeError(`No duration at throughput ${throughput}`);
  const [c, w] = crew === 0 ? [1, 1] : [crew, staffed];
  if (!(w > 0)) throw new RangeError(`No duration with ${staffed} of ${crew} workers`);
  const numerator = BigInt(recipe.ticksPerCase) * BigInt(quantity) * BigInt(RATIO_SCALE) * BigInt(c);
  const denominator = BigInt(throughput) * BigInt(w);
  const ticks = Number((numerator + denominator - 1n) / denominator);
  if (!Number.isSafeInteger(ticks)) throw new RangeError(`Job duration out of range for ${quantity} × ${recipe.id}`);
  return ticks;
}

/** Ticks a job of `quantity` cases of `recipe` takes at the facility as it stands (ADR 0017 decision 1). */
export function facilityJobDuration(state: GameState, data: GameData, facilityId: FacilityId, recipe: RecipeDefinition, quantity: number): number {
  const t = crewTerms(state, data, facilityId);
  return jobDuration(recipe, quantity, ratio(t.base), t.crew, t.staffed);
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

/** The duration terms of a full crew at 1×: what `maxSafeQuantity` assumes without a facility. */
export const ONE_X: CrewTerms = { producing: true, base: RATIO_SCALE, crew: 1, staffed: 1 };

/**
 * The largest quantity of `recipe` whose derived values all stay safe integers
 * when the job starts at `startTick` with duration terms `terms`: input totals,
 * conversion cost, and the completion tick (rule 6, from #47). The completion
 * bound is exact and crew-aware (ADR 0017 decision 1):
 * floor((MAX − startTick) × base × staffed / (ticksPerCase × RATIO_SCALE × crew)),
 * with crew = staffed = 1 when the crew is 0. Terms that can't produce (no
 * recipe equipment, or no one staffed) fall back to 1×; START_PRODUCTION
 * rejects them on capacity anyway.
 */
export function maxSafeQuantity(recipe: RecipeDefinition, startTick: number, terms: CrewTerms = ONE_X): number {
  const safe = Number.MAX_SAFE_INTEGER;
  let bound = safe;
  const perCase = addMoney(recipe.laborPerCase, recipe.overheadPerCase);
  if (perCase > 0) bound = Math.min(bound, Math.floor(safe / perCase));
  if (recipe.ticksPerCase > 0) {
    const t = canProduce(terms) ? terms : ONE_X;
    const [crew, staffed] = t.crew === 0 ? [1, 1] : [t.crew, t.staffed];
    const room = BigInt(Math.max(0, safe - startTick));
    const byTime = (room * BigInt(t.base) * BigInt(staffed)) / (BigInt(recipe.ticksPerCase) * BigInt(RATIO_SCALE) * BigInt(crew));
    bound = Math.min(bound, byTime > BigInt(safe) ? safe : Number(byTime));
  }
  for (const input of recipe.inputsPerCase) if (input.quantity > 0) bound = Math.min(bound, Math.floor(safe / input.quantity));
  return Math.max(0, bound);
}

/** `maxSafeQuantity` for a start at the facility as it stands, or at 1× for an unknown facility. */
export function facilityMaxSafeQuantity(state: GameState, data: GameData, facilityId: FacilityId, recipe: RecipeDefinition, startTick: number): number {
  const known = state.facilities.some((f) => f.id === facilityId);
  return maxSafeQuantity(recipe, startTick, known ? crewTerms(state, data, facilityId) : ONE_X);
}

/**
 * The most generous `maxSafeQuantity` the facility's current equipment allows:
 * as if fully staffed. Workers can change before a queued command applies, so
 * dispatch-time checks use this; apply uses the exact one.
 */
export function fullCrewMaxSafeQuantity(state: GameState, data: GameData, facilityId: FacilityId, recipe: RecipeDefinition, startTick: number): number {
  if (!state.facilities.some((f) => f.id === facilityId)) return maxSafeQuantity(recipe, startTick);
  const t = crewTerms(state, data, facilityId);
  return maxSafeQuantity(recipe, startTick, { ...t, staffed: t.crew });
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
