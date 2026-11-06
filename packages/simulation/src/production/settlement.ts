// The midnight wage and overhead settlement (T02c2, PROD-001; SIM-001 step 5;
// FIN-001; ADR 0017 decisions 7 and 9, ADR 0015, ADR 0016).
//
// The production system's midnight hook. It runs after the market's (system
// registration order) and after the production phase, so a job completing on
// the midnight tick has already paid its conversion cost. `<day>` is the day
// that just ended, dayIndex(tick) − 1. Three DAILY_SETTLEMENT transactions, in
// order, each reading cash as the previous one left it, so cash never goes
// negative:
//
//   1. WAGES:<day>: the leaders' dailyWage plus each facility's
//      workerCount × workerDailyWage (the workforce as it stands at midnight),
//      paid or accrued to WAGES_PAYABLE. Skipped when the amount is 0.
//   2. OVERHEAD:<day>: each facility's dailyOverhead, paid or accrued to
//      WAGES_PAYABLE. Skipped when the amount is 0. Kept apart from wages so
//      that fully paid overhead files under OVERHEAD in cash flow (ADR 0015).
//   3. PAYROLL:<day>: earlier WAGES_PAYABLE paid down by
//      min(balance, cash). Always commits, even with no entries, and carries
//      DAY_SETTLED.
//
// Period costs are expensed, never capitalized (decision 7). Each key commits
// once, so a day is settled once even if the tick is re-entered.

import {
  addMoney,
  idempotencyKey,
  multiplyMoney,
  ZERO_MONEY,
  type GameState,
  type LedgerEntry,
  type Money,
  type TransactionCoordinator,
} from "@eov/contracts";
import type { GameData } from "@eov/game-data";
import { payDownEntries, payOrAccrueEntries } from "../economy/ledger/postings.ts";
import { cashBalance, ledgerBalances } from "../economy/ledger/ledger.ts";
import type { TickContext } from "../kernel/registry.ts";
import { facilitySpec } from "./capacity.ts";

/** Tonight's wages: Σ leaders' dailyWage + Σ facilities' workerCount × workerDailyWage. */
export function dailyWagesDue(state: GameState, data: GameData): Money {
  let total = ZERO_MONEY;
  for (const c of data.characters) total = addMoney(total, c.dailyWage);
  for (const f of state.facilities) total = addMoney(total, multiplyMoney(data.workforce.workerDailyWage, f.workerCount));
  return total;
}

/** Tonight's overhead: Σ facilities' dailyOverhead. */
export function dailyOverheadDue(state: GameState, data: GameData): Money {
  let total = ZERO_MONEY;
  for (const f of state.facilities) total = addMoney(total, facilitySpec(data, f.id).dailyOverhead);
  return total;
}

const credited = (entries: readonly LedgerEntry[], account: LedgerEntry["account"]): Money =>
  entries.reduce((n, e) => (e.account === account && e.side === "CREDIT" ? addMoney(n, e.amount) : n), ZERO_MONEY);

interface Charged {
  readonly state: GameState;
  readonly paid: Money;
  readonly accrued: Money;
}

/** Commits one pay-or-accrue charge as its own transaction, or nothing when the amount is 0. */
function charge(
  state: GameState,
  ctx: TickContext,
  coordinator: TransactionCoordinator,
  key: string,
  amount: Money,
  expense: "WAGES_EXPENSE" | "OVERHEAD_EXPENSE",
): Charged {
  if (amount === 0) return { state, paid: ZERO_MONEY, accrued: ZERO_MONEY };
  const tx = coordinator.begin(state, { kind: "DAILY_SETTLEMENT", idempotencyKey: key, tick: ctx.tick, causedBy: null });
  if (tx.status === "duplicate") return { state, paid: ZERO_MONEY, accrued: ZERO_MONEY };
  const entries = payOrAccrueEntries({ amount, expense, payable: "WAGES_PAYABLE", cashAvailable: cashBalance(tx.state) });
  tx.post(entries);
  const result = tx.commit();
  if (result.status !== "committed") throw new RangeError(`Settling ${key} was rejected: ${result.reason.code}`);
  return { state: result.state, paid: credited(entries, "CASH"), accrued: credited(entries, "WAGES_PAYABLE") };
}

/** The production system's midnight hook (ADR 0017 decision 9). */
export function settleDay(data: GameData, coordinator: TransactionCoordinator) {
  return (state: GameState, ctx: TickContext): GameState => {
    // The day that just ended (the market keys its cycle by the day starting, ADR 0016).
    const day = ctx.dayIndex - 1;
    const keyOf = (part: "WAGES" | "OVERHEAD" | "PAYROLL") => idempotencyKey("DAILY_SETTLEMENT", part, day);
    if (state.ledger.transactions.some((t) => t.idempotencyKey === keyOf("PAYROLL"))) return state;

    const wagesDue = dailyWagesDue(state, data);
    const overheadDue = dailyOverheadDue(state, data);
    const wages = charge(state, ctx, coordinator, keyOf("WAGES"), wagesDue, "WAGES_EXPENSE");
    const overhead = charge(wages.state, ctx, coordinator, keyOf("OVERHEAD"), overheadDue, "OVERHEAD_EXPENSE");

    const tx = coordinator.begin(overhead.state, { kind: "DAILY_SETTLEMENT", idempotencyKey: keyOf("PAYROLL"), tick: ctx.tick, causedBy: null });
    if (tx.status === "duplicate") return overhead.state;
    // Anything accrued tonight left cash at 0, so this only ever pays down earlier WAGES_PAYABLE.
    const owed = ledgerBalances(tx.state.ledger.transactions).WAGES_PAYABLE;
    const cash = cashBalance(tx.state);
    const paydown = owed < cash ? owed : cash;
    tx.post(payDownEntries(paydown, "WAGES_PAYABLE"));
    tx.emit({
      type: "DAY_SETTLED",
      dayIndex: day,
      wagesDue,
      overheadDue,
      paidInCash: addMoney(wages.paid, overhead.paid),
      addedToLiabilities: addMoney(wages.accrued, overhead.accrued),
      liabilitiesPaid: paydown,
      transactionId: tx.transactionId,
    });
    const result = tx.commit();
    if (result.status !== "committed") throw new RangeError(`Settling ${keyOf("PAYROLL")} was rejected: ${result.reason.code}`);
    return result.state;
  };
}
