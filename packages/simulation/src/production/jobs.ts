// Production jobs (T02c1, PROD-001; ADR 0017 decisions 1–3, 5, 7).
//
// - START_PRODUCTION checks, in order: INVALID_QUANTITY (including any quantity
//   whose derived values would leave the safe-integer range, rule 6) →
//   UNKNOWN_ENTITY facility, then recipe → RECIPE_NOT_SUPPORTED →
//   PRODUCTION_CAPACITY_EXCEEDED (a job already running there, or zero
//   throughput) → STORAGE_CAPACITY_EXCEEDED → INSUFFICIENT_MATERIALS →
//   INSUFFICIENT_FUNDS. On success it reserves the inputs and schedules the job
//   (`completesAt` lives on the job, ADR 0008). It moves no money, so its
//   RESERVATION transaction has no entries (ADR 0010).
// - The production phase settles due jobs in ID order. A recipe with a
//   failureChance above 0 draws once from `rng.production`; at 0 nothing is
//   drawn. Either way the reserved inputs are consumed at weighted-average cost
//   and the conversion cost is charged (cash first, then WAGES_PAYABLE):
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
  ZERO_MONEY,
  type GameState,
  type ProductionJobState,
  type RejectionReason,
  type ReservationId,
  type StartProductionCommand,
  type TransactionCoordinator,
} from "@eov/contracts";
import type { GameData, RecipeDefinition } from "@eov/game-data";
import { productionEntries, productionWriteOffEntries } from "../economy/ledger/postings.ts";
import { cashBalance } from "../economy/ledger/ledger.ts";
import { addProduct, addReservation, availableMaterial, consumeReservations } from "../inventory/pools.ts";
import { allocateId, formatId } from "../kernel/ids.ts";
import type { CommandHandler, TickContext } from "../kernel/registry.ts";
import { nextInt } from "../rng/xoshiro128.ts";
import { conversionCost, jobDuration, maxSafeQuantity, storageAvailable, supportsRecipe, throughput } from "./capacity.ts";

/**
 * INVALID_QUANTITY for a quantity that isn't a positive safe integer, or (for a
 * known recipe) is above `maxSafeQuantity` when started at `startTick`.
 */
function quantityRejection(quantity: number, recipe: RecipeDefinition | undefined, startTick: number): RejectionReason | null {
  const invalid: RejectionReason = { code: "INVALID_QUANTITY", field: "quantity", value: quantity };
  if (!Number.isSafeInteger(quantity) || quantity <= 0) return invalid;
  if (recipe && quantity > maxSafeQuantity(recipe, startTick)) return invalid;
  return null;
}

/** The first rule START_PRODUCTION breaks at `tick`, or null. Never throws. */
function startRejection(state: GameState, command: StartProductionCommand, data: GameData, tick: number): RejectionReason | null {
  const { facilityId, recipeId, quantity } = command;
  const facility = state.facilities.find((f) => f.id === facilityId);
  const recipe = data.recipes.find((r) => r.id === recipeId);
  const invalid = quantityRejection(quantity, recipe, tick);
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
  const cash = cashBalance(state);
  if (cash < conversion) return { code: "INSUFFICIENT_FUNDS", required: conversion, available: cash };
  return null;
}

export function startProductionHandler(data: GameData, coordinator: TransactionCoordinator): CommandHandler<"START_PRODUCTION"> {
  return {
    // Dispatch time, for a command queued for a later tick: only the quantity
    // rules. It starts no earlier than the next tick, so a quantity that
    // overflows then overflows at any later tick too. Apply checks everything.
    validate: (state, command) =>
      quantityRejection(
        command.quantity,
        data.recipes.find((r) => r.id === command.recipeId),
        state.tick + 1,
      ),
    apply: (state, command, ctx) => {
      const { facilityId, recipeId, quantity } = command;
      const jobId = formatId("ProductionJob", state.counters.nextId.ProductionJob);
      const tx = coordinator.begin(state, {
        kind: "RESERVATION",
        idempotencyKey: idempotencyKey("RESERVATION", jobId),
        tick: ctx.tick,
        causedBy: ctx.envelope.id,
      });
      if (tx.status === "duplicate") return { status: "applied", state };

      const rejection = startRejection(tx.state, command, data, ctx.tick);
      const recipe = data.recipes.find((r) => r.id === recipeId);
      if (rejection || !recipe) {
        tx.reject(rejection ?? { code: "UNKNOWN_ENTITY", kind: "Recipe", id: recipeId });
      } else {
        // IDs are minted in order from the counters, so they're known before staging.
        const firstReservation = tx.state.counters.nextId.Reservation;
        const reservationIds: readonly ReservationId[] = recipe.inputsPerCase.map((_, i) => formatId("Reservation", firstReservation + i));
        const completesAt = addTicks(ctx.tick, jobDuration(recipe, quantity, throughput(tx.state, data, facilityId)));
        const job: ProductionJobState = { id: jobId, facilityId, recipeId, quantity, startedAt: ctx.tick, completesAt, reservationIds };
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
        tx.emit({ type: "PRODUCTION_STARTED", jobId, facilityId, recipeId, quantity, completesAt });
      }

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

  // Conversion cost: paid in cash where possible, accrued otherwise (cash never goes negative).
  const costs = { materials, conversion: conversionCost(recipe, job.quantity), cashAvailable: cashBalance(tx.state) };
  const total = addMoney(costs.materials, costs.conversion);
  tx.update((s) => ({ ...s, productionJobs: s.productionJobs.filter((j) => j.id !== job.id) }));

  if (failed) {
    tx.post(productionWriteOffEntries(costs));
    tx.emit({ type: "PRODUCTION_FAILED", jobId: job.id, facilityId: job.facilityId, reason: "DISRUPTION", writtenOff: total, transactionId: tx.transactionId });
  } else {
    tx.update((s) => addProduct(s, job.facilityId, recipe.productId, recipe.quality, job.quantity, total));
    tx.post(productionEntries(costs));
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
