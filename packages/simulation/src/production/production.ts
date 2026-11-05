// S0 stub: extended by T02c (PROD-001 production, equipment, workforce).
//
// - START_PRODUCTION reserves the recipe's inputs and schedules the job
//   (`completesAt` lives on the job, ADR 0008). It moves no money, so its
//   transaction has no entries (ADR 0010).
// - The production phase completes due jobs: reserved materials are consumed at
//   their pool cost, labor and overhead are added, and the total is capitalized
//   into finished goods. No profit is recognized (FIN-001 production accounting).
//   Each consumed reservation is reported with RESERVATION_RELEASED { reason:
//   "CONSUMED" } in the completion transaction, before PRODUCTION_COMPLETED.
//
// Stub limits (T02c): one active job per facility, no throughput or storage
// capacity, no workforce effect, no failure.

import {
  addMoney,
  addTicks,
  compareById,
  idempotencyKey,
  multiplyMoney,
  subtractMoney,
  ZERO_MONEY,
  type GameState,
  type LedgerEntry,
  type Money,
  type ProductionJobState,
  type ReservationId,
  type TransactionCoordinator,
} from "@eov/contracts";
import type { GameData, RecipeDefinition } from "@eov/game-data";
import { cashBalance } from "../economy/ledger/ledger.ts";
import { addProduct, addReservation, allocateRemovalCost, availableMaterial, findMaterialPool, removeMaterial, removeReservations } from "../inventory/pools.ts";
import { allocateId, formatId } from "../kernel/ids.ts";
import type { SystemRegistry, TickContext } from "../kernel/registry.ts";

/** Labor and overhead for `quantity` cases. */
export function conversionCost(recipe: RecipeDefinition, quantity: number): Money {
  return multiplyMoney(addMoney(recipe.laborPerCase, recipe.overheadPerCase), quantity);
}

function completeJob(state: GameState, job: ProductionJobState, data: GameData, coordinator: TransactionCoordinator, ctx: TickContext): GameState {
  const recipe = data.recipes.find((r) => r.id === job.recipeId);
  if (!recipe) throw new RangeError(`Job ${job.id} uses unknown recipe ${job.recipeId}`);
  const tx = coordinator.begin(state, {
    kind: "PRODUCTION",
    idempotencyKey: idempotencyKey("PRODUCTION", job.id),
    tick: ctx.tick,
    causedBy: null,
  });
  if (tx.status === "duplicate") return state;

  // Consume the reserved materials at their weighted-average cost.
  let materials = ZERO_MONEY;
  for (const reservationId of job.reservationIds) {
    const reservation = tx.state.reservations.find((r) => r.id === reservationId);
    if (!reservation || reservation.goods.kind !== "MATERIAL") throw new RangeError(`Job ${job.id} lost reservation ${reservationId}`);
    const { materialId } = reservation.goods;
    const pool = findMaterialPool(tx.state, job.facilityId, materialId);
    if (!pool) throw new RangeError(`Job ${job.id}: no ${materialId} pool to consume`);
    const cost = allocateRemovalCost(pool.totalCost, pool.quantity, reservation.quantity);
    materials = addMoney(materials, cost);
    tx.update((s) => removeMaterial(s, job.facilityId, materialId, reservation.quantity, cost));
  }
  tx.update((s) => removeReservations(s, job.reservationIds));
  for (const reservationId of job.reservationIds) tx.emit({ type: "RESERVATION_RELEASED", reservationId, reason: "CONSUMED" });

  // Labor and overhead: paid in cash where possible, accrued otherwise (cash never goes negative).
  const conversion = conversionCost(recipe, job.quantity);
  const cash = cashBalance(tx.state);
  const paid = cash < conversion ? cash : conversion;
  const accrued = subtractMoney(conversion, paid);
  const costBasis = addMoney(materials, conversion);

  tx.update((s) => addProduct(s, job.facilityId, recipe.productId, recipe.quality, job.quantity, costBasis));
  tx.update((s) => ({ ...s, productionJobs: s.productionJobs.filter((j) => j.id !== job.id) }));

  const entries: LedgerEntry[] = [];
  if (costBasis > 0) entries.push({ account: "FINISHED_GOODS", side: "DEBIT", amount: costBasis });
  if (materials > 0) entries.push({ account: "RAW_MATERIALS", side: "CREDIT", amount: materials });
  if (paid > 0) entries.push({ account: "CASH", side: "CREDIT", amount: paid });
  if (accrued > 0) entries.push({ account: "WAGES_PAYABLE", side: "CREDIT", amount: accrued });
  tx.post(entries);
  tx.emit({
    type: "PRODUCTION_COMPLETED",
    jobId: job.id,
    facilityId: job.facilityId,
    productId: recipe.productId,
    quality: recipe.quality,
    quantity: job.quantity,
    costBasis,
    transactionId: tx.transactionId,
  });
  const result = tx.commit();
  if (result.status !== "committed") throw new RangeError(`Completing ${job.id} was rejected: ${result.reason.code}`);
  return result.state;
}

export function registerProduction(registry: SystemRegistry, data: GameData, coordinator: TransactionCoordinator): void {
  registry.onCommand("START_PRODUCTION", {
    validate: (_state, command) =>
      Number.isSafeInteger(command.quantity) && command.quantity > 0
        ? null
        : { code: "INVALID_QUANTITY", field: "quantity", value: command.quantity },
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

      const facility = tx.state.facilities.find((f) => f.id === facilityId);
      const recipe = data.recipes.find((r) => r.id === recipeId);
      if (!Number.isSafeInteger(quantity) || quantity <= 0) {
        tx.reject({ code: "INVALID_QUANTITY", field: "quantity", value: quantity });
      } else if (!facility) {
        tx.reject({ code: "UNKNOWN_ENTITY", kind: "Facility", id: facilityId });
      } else if (!recipe) {
        tx.reject({ code: "UNKNOWN_ENTITY", kind: "Recipe", id: recipeId });
      } else if (!facility.equipment.some((e) => e.equipmentId === recipe.requiredEquipmentId)) {
        tx.reject({ code: "RECIPE_NOT_SUPPORTED", facilityId, recipeId });
      } else if (tx.state.productionJobs.some((j) => j.facilityId === facilityId)) {
        tx.reject({ code: "PRODUCTION_CAPACITY_EXCEEDED", facilityId, requested: quantity, available: 0 });
      } else {
        for (const input of recipe.inputsPerCase) {
          const required = input.quantity * quantity;
          const available = availableMaterial(tx.state, facilityId, input.materialId);
          if (available < required) {
            tx.reject({ code: "INSUFFICIENT_MATERIALS", materialId: input.materialId, required, available });
            break;
          }
        }
        const conversion = conversionCost(recipe, quantity);
        const cash = cashBalance(tx.state);
        if (cash < conversion) tx.reject({ code: "INSUFFICIENT_FUNDS", required: conversion, available: cash });
      }

      if (recipe && tx.status === "staging") {
        // IDs are minted in order from the counters, so they're known before staging.
        const firstReservation = tx.state.counters.nextId.Reservation;
        const reservationIds: readonly ReservationId[] = recipe.inputsPerCase.map((_, i) => formatId("Reservation", firstReservation + i));
        const completesAt = addTicks(ctx.tick, recipe.ticksPerCase * quantity);
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
  });

  registry.onPhase("production", "production-jobs", (state, ctx) => {
    let s = state;
    for (const job of state.productionJobs) {
      if (job.completesAt <= ctx.tick) s = completeJob(s, job, data, coordinator, ctx);
    }
    return s;
  });
}
