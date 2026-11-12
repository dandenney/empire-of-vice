// The SHAKEDOWN world event (T07f, issue #129): a scheduled setback that takes a
// share of net worth in cash.
//
// At its tick it books `min(cash, netWorth × netWorthSharePpm / 1 000 000)` as one
// balanced transaction (Dr LOSSES / Cr CASH) and emits LOSS_BOOKED. The share is
// integer ppm math on integer cents, rounded once (half away from zero, ADR 0002).
//
// The transaction is a LOSS keyed `LOSS:SHAKEDOWN:…`. T07f posted it as a
// DAILY_SETTLEMENT, which put the cash on the WAGES cash flow line; #159 gives it
// its own kind, whose cash flow default is LOSSES (ADR 0015), so the cash flow
// statement and the income statement both show it under LOSSES.
//
// Capping at cash (orchestrator decision on #129) keeps it one atomic transaction
// with no new liability: cash never goes negative (FIN-001). Net worth at or below
// zero, or no cash, books nothing but still emits LOSS_BOOKED with amount 0, so a
// reader can always see the event happened. Once the game is over (WON or LOST)
// it's a no-op with no transaction.

import { applyRatios, idempotencyKey, ratio, ZERO_MONEY, type GameState, type Money, type TransactionCoordinator } from "@eov/contracts";
import type { GameData } from "@eov/game-data";
import { balanceSheet, cashBalance } from "../economy/ledger/ledger.ts";
import { cashLossEntries } from "../economy/ledger/postings.ts";
import type { SystemRegistry } from "../kernel/registry.ts";

/** The share a shakedown assesses: `netWorth × ppm / 1 000 000` in cents, rounded once, and zero when net worth isn't positive. */
export function shakedownAssessment(netWorth: Money, netWorthSharePpm: number): Money {
  if (!Number.isSafeInteger(netWorthSharePpm) || netWorthSharePpm < 0) throw new RangeError(`netWorthSharePpm must be a non-negative integer, got ${netWorthSharePpm}`);
  return netWorth <= 0 ? ZERO_MONEY : applyRatios(netWorth, [ratio(netWorthSharePpm)]);
}

export function registerShakedown(registry: SystemRegistry, _data: GameData, coordinator: TransactionCoordinator): void {
  registry.onWorldEvent("SHAKEDOWN", (state: GameState, event, ctx) => {
    if (state.outcome.status !== "PLAYING") return state;
    const tx = coordinator.begin(state, {
      kind: "LOSS",
      idempotencyKey: idempotencyKey("LOSS", "SHAKEDOWN", event.reason, ctx.tick, event.sequence),
      tick: ctx.tick,
      causedBy: null,
    });
    if (tx.status === "duplicate") return state;
    const netWorthBefore = balanceSheet(state).netWorth;
    const cash = cashBalance(state);
    const assessed = shakedownAssessment(netWorthBefore, event.netWorthSharePpm);
    const amount = assessed < cash ? assessed : cash < 0 ? ZERO_MONEY : cash;
    tx.post(cashLossEntries(amount));
    tx.emit({ type: "LOSS_BOOKED", reason: event.reason, assessed, amount, netWorthBefore, transactionId: tx.transactionId });
    const result = tx.commit();
    if (result.status !== "committed") throw new RangeError(`SHAKEDOWN at tick ${ctx.tick} was rejected: ${JSON.stringify(result.reason)}`);
    return result.state;
  });
}
