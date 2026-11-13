// Production jobs (T02c1, PROD-001; ADR 0017 decisions 1–3, 5, 7).
//
// - START_PRODUCTION checks, in order: INVALID_QUANTITY (including any quantity
//   whose derived values would leave the safe-integer range, rule 6) →
//   UNKNOWN_ENTITY facility, then recipe → RECIPE_NOT_SUPPORTED →
//   PRODUCTION_CAPACITY_EXCEEDED (a job already running there, or zero
//   throughput) → STORAGE_CAPACITY_EXCEEDED → INSUFFICIENT_MATERIALS →
//   INSUFFICIENT_FUNDS. The overflow bound and the duration are crew-aware
//   (T02c2, ADR 0017 decision 1). On success it reserves the inputs and schedules the job
//   (`completesAt` lives on the job, ADR 0008), in one `PRODUCTION_START:<jobId>`
//   transaction that also pays the conversion cost (ADR 0022 decision 7):
//   Dr PRODUCTION_IN_PROGRESS / Cr CASH, no entries when that cost is 0. The job
//   records what it paid in `conversionPrepaid`.
// - With founder rules on (ADR 0022 decision 3): shape and identity, then the
//   founder present at the facility and free, then the checks above against the
//   view. The job's clock starts when the batch is set up: `startedAt` is the
//   end of START_BATCH (ADR 0023 decision 4), and `completesAt` counts from it.
// - The production phase settles due jobs in ID order. A recipe with a
//   failureChance above 0 draws once from `rng.production`; at 0 nothing is
//   drawn. Either way the reserved inputs are consumed at weighted-average cost
//   and the conversion cost is capitalized or written off. A prepaid job credits
//   PRODUCTION_IN_PROGRESS with exactly `conversionPrepaid` and moves no cash; a
//   job migrated from a pre-M002 save (`conversionPrepaid: null`) pays the
//   recipe's current conversion cost then, cash first, then WAGES_PAYABLE:
//   - completed: capitalized into finished goods (PRODUCTION; no profit, FIN-001),
//     reservations reported CONSUMED, then PRODUCTION_COMPLETED;
//   - failed: written off to LOSSES (PRODUCTION_WRITE_OFF), reservations reported
//     PRODUCTION_FAILED, then PRODUCTION_FAILED with writtenOff = the LOSSES debit.

import {
  addMoney,
  addTicks,
  compareById,
  idempotencyKey,
  RATIO_SCALE,
  tick,
  ZERO_MONEY,
  type GameState,
  type ProductionJobState,
  type RejectionReason,
  type ReservationId,
  type StartProductionCommand,
  type TransactionCoordinator,
} from "@eov/contracts";
import type { GameData, RecipeDefinition } from "@eov/game-data";
import {
  prepaidProductionEntries,
  prepaidProductionWriteOffEntries,
  productionEntries,
  productionStartEntries,
  productionWriteOffEntries,
} from "../economy/ledger/postings.ts";
import { addProduct, addReservation, availableMaterial, consumeReservations } from "../inventory/pools.ts";
import { allocateId, formatId } from "../kernel/ids.ts";
import { activityTicks } from "../founder/time.ts";
import type { CommandHandler, TickContext } from "../kernel/registry.ts";
import { M001_RULES, type GameRules } from "../kernel/rules.ts";
import type { IssuerView } from "../view/issuer-view.ts";
import { judgeOrder, type OrderValidator } from "../view/order.ts";
import { presenceRejection } from "../view/presence.ts";
import { cashOf, type WorldSlice } from "../view/world.ts";
import { nextInt } from "../rng/xoshiro128.ts";
import {
  conversionCost,
  facilityJobDuration,
  facilityMaxSafeQuantity,
  fullCrewMaxSafeQuantity,
  storageAvailable,
  supportsRecipe,
  throughput,
} from "./capacity.ts";

/**
 * INVALID_QUANTITY for a quantity that isn't a positive safe integer, or (for a
 * known recipe) is above `bound(recipe)`, the rule 6 overflow bound.
 */
function quantityRejection(
  quantity: number,
  recipe: RecipeDefinition | undefined,
  bound: (recipe: RecipeDefinition) => number,
): RejectionReason | null {
  const invalid: RejectionReason = { code: "INVALID_QUANTITY", field: "quantity", value: quantity };
  if (!Number.isSafeInteger(quantity) || quantity <= 0) return invalid;
  if (recipe && quantity > bound(recipe)) return invalid;
  return null;
}

/** The first rule START_PRODUCTION breaks at `tick`, or null. Never throws. */
function startRejection(state: WorldSlice, command: StartProductionCommand, data: GameData, tick: number): RejectionReason | null {
  const { facilityId, recipeId, quantity } = command;
  const facility = state.facilities.find((f) => f.id === facilityId);
  const recipe = data.recipes.find((r) => r.id === recipeId);
  // Crew-aware (ADR 0017 decision 1): a short-handed job runs longer, so fewer cases fit.
  const invalid = quantityRejection(quantity, recipe, (r) => facilityMaxSafeQuantity(state, data, facilityId, r, tick));
  if (invalid) return invalid;
  if (!facility) return { code: "UNKNOWN_ENTITY", kind: "Facility", id: facilityId };
  if (!recipe) return { code: "UNKNOWN_ENTITY", kind: "Recipe", id: recipeId };
  if (!supportsRecipe(facility, recipe)) return { code: "RECIPE_NOT_SUPPORTED", facilityId, recipeId };
  if (throughput(state, data, facilityId) === 0 || state.productionJobs.some((j) => j.facilityId === facilityId)) {
    return { code: "PRODUCTION_CAPACITY_EXCEEDED", facilityId, requested: quantity, available: 0 };
  }
  const room = storageAvailable(state, data, facilityId);
  if (quantity > room) return { code: "STORAGE_CAPACITY_EXCEEDED", facilityId, requested: quantity, available: room };
  for (const input of recipe.inputsPerCase) {
    const required = input.quantity * quantity;
    const available = availableMaterial(state, facilityId, input.materialId);
    if (available < required) return { code: "INSUFFICIENT_MATERIALS", materialId: input.materialId, required, available };
  }
  const conversion = conversionCost(recipe, quantity);
  const cash = cashOf(state);
  if (cash < conversion) return { code: "INSUFFICIENT_FUNDS", required: conversion, available: cash };
  return null;
}

/**
 * When a job applied at `at` starts: when the batch is set up (ADR 0023 decision
 * 4, `startedAt = busy.until`) for a founder present to set it up, else at once
 * (founder rules off, M001).
 */
function startTick(view: Pick<IssuerView, "founderRules" | "at"> & { readonly world: Pick<WorldSlice, "founder"> }): number {
  if (!view.founderRules || view.world.founder.whereabouts.kind !== "PRESENT") return view.at;
  return view.at + activityTicks(view.world.founder, "START_BATCH", view.at);
}

/**
 * START_PRODUCTION (ADR 0022 decision 3): gate 1 is the quantity's shape, the
 * facility (owned) and the recipe (game-data); the founder must be at the
 * facility and free; then M001's checks against the facility as seen, the
 * crew-aware quantity bound first (it reads the crew, so it's judged where the
 * crew can be seen).
 */
export function startProductionValidator(data: GameData): OrderValidator<"START_PRODUCTION"> {
  return (view, command) => {
    if (view.founderRules) {
      const { facilityId, recipeId, quantity } = command;
      const invalid = quantityRejection(quantity, undefined, () => quantity);
      if (invalid) return invalid;
      const def = data.facilities.find((f) => f.id === facilityId);
      if (!def || !view.world.facilities.some((f) => f.id === facilityId)) return { code: "UNKNOWN_ENTITY", kind: "Facility", id: facilityId };
      if (!data.recipes.some((r) => r.id === recipeId)) return { code: "UNKNOWN_ENTITY", kind: "Recipe", id: recipeId };
      const absent = presenceRejection(view, { locationId: def.locationId, activity: "START_BATCH", party: false });
      if (absent) return absent;
    }
    return startRejection(view.world, command, data, startTick(view));
  };
}

export function startProductionHandler(data: GameData, coordinator: TransactionCoordinator, rules: GameRules = M001_RULES): CommandHandler<"START_PRODUCTION"> {
  const validateStart = startProductionValidator(data);
  return {
    // Dispatch time, for a command queued for a later tick: only the quantity
    // rules. It starts no earlier than the next tick, so a quantity that
    // overflows then overflows at any later tick too. Workers can be hired
    // before it applies, so this assumes a full crew. Apply checks everything.
    // With founder rules on, only the shape: the facility's equipment is known
    // only where it can be seen (ADR 0022 decision 2).
    validate: (state, command) =>
      rules.founderRules
        ? quantityRejection(command.quantity, undefined, () => command.quantity)
        : quantityRejection(
            command.quantity,
            data.recipes.find((r) => r.id === command.recipeId),
            (r) => fullCrewMaxSafeQuantity(state, data, command.facilityId, r, state.tick + 1),
          ),
    apply: (state, command, ctx) => {
      const rejection = judgeOrder(validateStart, state, data, rules, command, ctx.tick);
      if (rejection) return { status: "rejected", reason: rejection };
      const { facilityId, recipeId, quantity } = command;
      const recipe = data.recipes.find((r) => r.id === recipeId);
      if (!recipe) throw new RangeError(`START_PRODUCTION: unknown recipe ${recipeId} after validation`);
      const jobId = formatId("ProductionJob", state.counters.nextId.ProductionJob);
      const tx = coordinator.begin(state, {
        kind: "PRODUCTION_START",
        idempotencyKey: idempotencyKey("PRODUCTION_START", jobId),
        tick: ctx.tick,
        causedBy: ctx.envelope.id,
      });
      if (tx.status === "duplicate") return { status: "applied", state };

      // IDs are minted in order from the counters, so they're known before staging.
      const firstReservation = tx.state.counters.nextId.Reservation;
      const reservationIds: readonly ReservationId[] = recipe.inputsPerCase.map((_, i) => formatId("Reservation", firstReservation + i));
      // The job's clock starts when the batch is set up (ADR 0023 decision 4).
      const startedAt = tick(startTick({ founderRules: rules.founderRules, at: ctx.tick, world: state }));
      const completesAt = addTicks(startedAt, facilityJobDuration(tx.state, data, facilityId, recipe, quantity));
      // ADR 0022 decision 7: the conversion cost is paid now. The validator checked cash covers it.
      const conversionPrepaid = conversionCost(recipe, quantity);
      const job: ProductionJobState = { id: jobId, facilityId, recipeId, quantity, startedAt, completesAt, reservationIds, conversionPrepaid };
      tx.update((s) => {
        let next = allocateId(s, "ProductionJob").state;
        recipe.inputsPerCase.forEach((input, i) => {
          next = addReservation(allocateId(next, "Reservation").state, {
            id: reservationIds[i]!,
            facilityId,
            goods: { kind: "MATERIAL", materialId: input.materialId },
            quantity: input.quantity * quantity,
            holder: { kind: "PRODUCTION_JOB", jobId },
          });
        });
        return { ...next, productionJobs: [...next.productionJobs, job].sort(compareById) };
      });
      tx.post(productionStartEntries(conversionPrepaid));
      tx.emit({ type: "PRODUCTION_STARTED", jobId, facilityId, recipeId, quantity, completesAt });

      const result = tx.commit();
      return result.status === "committed" ? { status: "applied", state: result.state } : { status: "rejected", reason: result.reason };
    },
  };
}

/** Completes or fails a due job in one transaction (ADR 0017 decision 5). */
function settleJob(state: GameState, job: ProductionJobState, data: GameData, coordinator: TransactionCoordinator, ctx: TickContext): GameState {
  const recipe = data.recipes.find((r) => r.id === job.recipeId);
  if (!recipe) throw new RangeError(`Job ${job.id} uses unknown recipe ${job.recipeId}`);

  // One draw only when the recipe can fail, so a 0 chance leaves rng.production untouched.
  const draw = recipe.failureChance > 0 ? nextInt(state.rng.production, RATIO_SCALE) : null;
  const failed = draw !== null && draw.value < recipe.failureChance;
  const kind = failed ? "PRODUCTION_WRITE_OFF" : "PRODUCTION";

  const tx = coordinator.begin(state, { kind, idempotencyKey: idempotencyKey(kind, job.id), tick: ctx.tick, causedBy: null });
  if (tx.status === "duplicate") return state;
  if (draw) tx.update((s) => ({ ...s, rng: { ...s.rng, production: draw.rng } }));

  // Consume the reserved materials at their weighted-average cost (ADR 0013 rules 3 and 4).
  let materials = ZERO_MONEY;
  tx.update((s) => {
    const taken = consumeReservations(s, job.reservationIds);
    materials = taken.cost;
    return taken.state;
  });
  const reason = failed ? "PRODUCTION_FAILED" : "CONSUMED";
  for (const reservationId of job.reservationIds) tx.emit({ type: "RESERVATION_RELEASED", reservationId, reason });

  // Conversion cost (ADR 0022 decision 7): a prepaid job credits exactly what it paid at the start
  // and moves no cash. A migrated job (null) pays the recipe's cost now, in cash where possible and
  // accrued otherwise (cash never goes negative).
  const prepaid = job.conversionPrepaid;
  const migrated = prepaid === null ? { materials, conversion: conversionCost(recipe, job.quantity), cashAvailable: cashOf(tx.state) } : null;
  const total = addMoney(materials, migrated ? migrated.conversion : (prepaid ?? ZERO_MONEY));
  const settlement = migrated
    ? (failed ? productionWriteOffEntries : productionEntries)(migrated)
    : (failed ? prepaidProductionWriteOffEntries : prepaidProductionEntries)({ materials, prepaid: prepaid ?? ZERO_MONEY });
  tx.update((s) => ({ ...s, productionJobs: s.productionJobs.filter((j) => j.id !== job.id) }));

  if (failed) {
    tx.post(settlement);
    tx.emit({ type: "PRODUCTION_FAILED", jobId: job.id, facilityId: job.facilityId, reason: "DISRUPTION", writtenOff: total, transactionId: tx.transactionId });
  } else {
    tx.update((s) => addProduct(s, job.facilityId, recipe.productId, recipe.quality, job.quantity, total));
    tx.post(settlement);
    tx.emit({
      type: "PRODUCTION_COMPLETED",
      jobId: job.id,
      facilityId: job.facilityId,
      productId: recipe.productId,
      quality: recipe.quality,
      quantity: job.quantity,
      costBasis: total,
      transactionId: tx.transactionId,
    });
  }
  const result = tx.commit();
  if (result.status !== "committed") throw new RangeError(`Settling ${job.id} was rejected: ${result.reason.code}`);
  return result.state;
}

/** The production phase hook: settles every job due by this tick, in job ID order. */
export function settleDueJobs(data: GameData, coordinator: TransactionCoordinator) {
  return (state: GameState, ctx: TickContext): GameState => {
    let s = state;
    const due = state.productionJobs.filter((j) => j.completesAt <= ctx.tick).sort(compareById);
    for (const job of due) s = settleJob(s, job, data, coordinator, ctx);
    return s;
  };
}
