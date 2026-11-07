// Reputation (T05e, issue #104; GDD §9 PROG-001; ADR 0020 decision 5; ADR 0018
// decision 10).
//
// - Source events: this tick's SALE_COMPLETED and INSTALLMENT_SETTLED, read from
//   `state.eventJournal` (entries with `tick === ctx.tick`) in ID order. Reading
//   events as input is limited to the current tick (decision 5).
// - First qualifying delivery: a sale (spot or contract) of at least
//   `qualifyingDeliveryMinimumCases` cases while the flag is unset. One
//   PROGRESSION transaction keyed `PROGRESSION:FIRST_DELIVERY`.
// - Installments: one PROGRESSION transaction per settlement, keyed
//   `PROGRESSION:INSTALLMENT:<contractId>:<index>`. FULFILLED raises the
//   family-wide streak and adds the fulfilled amount, then the consecutive bonus
//   once the streak is at least 2; PARTIAL and MISSED apply their penalties and
//   reset the streak.
// - Every change is clamped to 0–100, and REPUTATION_CHANGED is emitted only when
//   the value moves. A transaction commits only if it changes reputation, the
//   streak, or the flag. PROGRESSION transactions post no entries (decision 14).

import {
  compareIds,
  idempotencyKey,
  type ContractId,
  type DeliveryId,
  type EventOfType,
  type GameEvent,
  type GameState,
  type ReputationChangeReason,
  type TransactionCoordinator,
  type TransactionDraft,
} from "@eov/contracts";
import type { GameData } from "@eov/game-data";
import type { TickContext } from "../kernel/registry.ts";

/** The contract's reputation bounds (ADR 0010), not gameplay data. */
const MIN_REPUTATION = 0;
const MAX_REPUTATION = 100;

const clamp = (value: number): number => Math.min(MAX_REPUTATION, Math.max(MIN_REPUTATION, value));

interface Change {
  readonly amount: number;
  readonly reason: ReputationChangeReason;
}

function commitOrThrow(tx: TransactionDraft, what: string): GameState {
  const result = tx.commit();
  if (result.status !== "committed") throw new Error(`${what} was rejected: ${JSON.stringify(result.reason)}`);
  return result.state;
}

/**
 * Stages `changes` in order, each clamped, emitting REPUTATION_CHANGED for each
 * one that moves the value. Returns whether reputation moved at all.
 */
function stageChanges(tx: TransactionDraft, changes: readonly Change[], deliveryId: DeliveryId | null, contractId: ContractId | null): boolean {
  let moved = false;
  for (const change of changes) {
    const from = tx.state.family.reputation;
    const to = clamp(from + change.amount);
    if (to === from) continue;
    moved = true;
    tx.update((s) => ({ ...s, family: { ...s.family, reputation: to } }));
    tx.emit({ type: "REPUTATION_CHANGED", from, to, reason: change.reason, deliveryId, contractId });
  }
  return moved;
}

function applyFirstDelivery(
  state: GameState,
  event: EventOfType<"SALE_COMPLETED">,
  data: GameData,
  coordinator: TransactionCoordinator,
  ctx: TickContext,
): GameState {
  const rules = data.progression.reputation;
  if (state.family.firstQualifyingDeliveryMade) return state;
  const cases = event.cargo.reduce((n, line) => n + line.quantity, 0);
  if (cases < rules.qualifyingDeliveryMinimumCases) return state;

  const tx = coordinator.begin(state, {
    kind: "PROGRESSION",
    idempotencyKey: idempotencyKey("PROGRESSION", "FIRST_DELIVERY"),
    tick: ctx.tick,
    causedBy: null,
  });
  if (tx.status === "duplicate") return state;
  // Setting the flag is always a change, so this transaction always commits.
  tx.update((s) => ({ ...s, family: { ...s.family, firstQualifyingDeliveryMade: true } }));
  stageChanges(tx, [{ amount: rules.firstQualifyingDelivery, reason: "FIRST_QUALIFYING_DELIVERY" }], event.deliveryId, event.contractId);
  return commitOrThrow(tx, "First qualifying delivery");
}

function applyInstallment(
  state: GameState,
  event: EventOfType<"INSTALLMENT_SETTLED">,
  data: GameData,
  coordinator: TransactionCoordinator,
  ctx: TickContext,
): GameState {
  const rules = data.progression.reputation;
  const tx = coordinator.begin(state, {
    kind: "PROGRESSION",
    idempotencyKey: idempotencyKey("PROGRESSION", "INSTALLMENT", event.contractId, event.installmentIndex),
    tick: ctx.tick,
    causedBy: null,
  });
  if (tx.status === "duplicate") return state;

  const streakBefore = state.family.consecutiveFulfilledInstallments;
  const streak = event.outcome === "FULFILLED" ? streakBefore + 1 : 0;
  const changes: Change[] =
    event.outcome === "FULFILLED"
      ? [
          { amount: rules.installmentFulfilled, reason: "INSTALLMENT_FULFILLED" },
          ...(streak >= 2 ? [{ amount: rules.consecutiveInstallmentBonus, reason: "CONSECUTIVE_INSTALLMENT" as const }] : []),
        ]
      : event.outcome === "PARTIAL"
        ? [{ amount: rules.installmentPartial, reason: "INSTALLMENT_PARTIAL" }]
        : [{ amount: rules.installmentMissed, reason: "INSTALLMENT_MISSED" }];

  if (streak !== streakBefore) tx.update((s) => ({ ...s, family: { ...s.family, consecutiveFulfilledInstallments: streak } }));
  const moved = stageChanges(tx, changes, null, event.contractId);
  // Nothing changed: post nothing (the draft is dropped uncommitted).
  if (!moved && streak === streakBefore) return state;
  return commitOrThrow(tx, `Reputation for ${event.contractId} installment ${event.installmentIndex}`);
}

/** This tick's events, in ID order. Captured before anything here emits more. */
function eventsOfThisTick(state: GameState, ctx: TickContext): readonly GameEvent[] {
  return state.eventJournal.filter((e) => e.tick === ctx.tick).sort((a, b) => compareIds(a.id, b.id));
}

/** Applies reputation from this tick's sales and installment settlements. */
export function applyReputation(state: GameState, data: GameData, coordinator: TransactionCoordinator, ctx: TickContext): GameState {
  let s = state;
  for (const event of eventsOfThisTick(state, ctx)) {
    if (event.type === "SALE_COMPLETED") s = applyFirstDelivery(s, event, data, coordinator, ctx);
    else if (event.type === "INSTALLMENT_SETTLED") s = applyInstallment(s, event, data, coordinator, ctx);
  }
  return s;
}
