// FIN-001 finance reports (T02b, issue #6).
//
// The finance section of the snapshot, derived from the ledger log on every
// projection (ADR 0008: reports are computed, never stored). Profit comes from
// revenue, COGS, expense, and gain accounts; cash flow from CASH entries,
// attributed per transaction by ADR 0015 (below).
//
// Periods (SIM-001): a game day runs from just after one midnight tick through
// the next, so a midnight settlement belongs to the day it closes. A period
// (fromTick, toTick) holds transactions with fromTick < tick. Its toTick is
// `state.tick`, but a command applied since the last tick is booked at
// `state.tick + 1` ("the first thing of the next tick", ADR 0004), and it's
// included in the open periods (today and to date) so the money it moved shows
// up at once.
//
// Cash flow attribution (ADR 0015): a transaction's net cash movement is filed
// under the category of its non-cash accounts when they all map to one category
// (ACCOUNT_CATEGORY); otherwise, including when any non-cash account has no
// category, under the kind's default (CASH_FLOW_CATEGORY). Never split, so no
// rounding. Production's capitalized conversion cost (Dr FINISHED_GOODS, which
// has no category) stays under the PRODUCTION default, WAGES.

import {
  addMoney,
  dayIndex,
  subtractMoney,
  sumMoney,
  tick,
  TICKS_PER_DAY,
  ZERO_MONEY,
  type BalanceSheet,
  type CashFlowCategory,
  type CashFlowStatement,
  type ExpenseCategory,
  type FinanceSnapshot,
  type GameState,
  type IncomeStatement,
  type LedgerAccount,
  type LedgerTransaction,
  type Money,
  type PeriodReport,
  type Tick,
  type TransactionKind,
} from "@eov/contracts";
import { accountBalances, ledgerBalances, type AccountBalances } from "../economy/ledger/ledger.ts";

/**
 * Ledger transactions included per snapshot. A UI payload size, not a gameplay
 * value; the contracts define SNAPSHOT_RECENT_EVENTS but no equivalent for
 * transactions (listed as a contract gap in the S0b PR).
 */
export const SNAPSHOT_RECENT_TRANSACTIONS = 50;

const EXPENSE_ACCOUNTS: readonly (readonly [ExpenseCategory, LedgerAccount])[] = [
  ["WAGES", "WAGES_EXPENSE"],
  ["OVERHEAD", "OVERHEAD_EXPENSE"],
  ["TRANSPORT", "TRANSPORT_EXPENSE"],
  ["PENALTIES", "PENALTY_EXPENSE"],
  ["LOSSES", "LOSSES"],
];

const CASH_FLOW_ORDER: readonly CashFlowCategory[] = [
  "SALES",
  "ASSET_SALES",
  "MATERIALS",
  "EQUIPMENT",
  "WAGES",
  "OVERHEAD",
  "TRANSPORT",
  "PENALTIES",
  "LOSSES",
];

/** ADR 0015: the cash flow category of each non-cash account that has one. */
const ACCOUNT_CATEGORY: Readonly<Partial<Record<LedgerAccount, CashFlowCategory>>> = {
  WAGES_EXPENSE: "WAGES",
  WAGES_PAYABLE: "WAGES",
  OVERHEAD_EXPENSE: "OVERHEAD",
  PENALTY_EXPENSE: "PENALTIES",
  PENALTIES_PAYABLE: "PENALTIES",
  TRANSPORT_EXPENSE: "TRANSPORT",
  SALES_REVENUE: "SALES",
  RAW_MATERIALS: "MATERIALS",
  EQUIPMENT: "EQUIPMENT",
  VEHICLES: "EQUIPMENT",
  FACILITIES: "EQUIPMENT",
  GAIN_ON_ASSET_SALE: "ASSET_SALES",
};

/**
 * The kind's default category, used when a transaction's non-cash accounts don't
 * agree on one (ADR 0015). null: the kind never moves cash in a period.
 */
const CASH_FLOW_CATEGORY: Readonly<Record<TransactionKind, CashFlowCategory | null>> = {
  OPENING_BALANCE: null,
  MATERIAL_PURCHASE: "MATERIALS",
  PRODUCTION: "WAGES",
  PRODUCTION_WRITE_OFF: "WAGES",
  EQUIPMENT_PURCHASE: "EQUIPMENT",
  DISPATCH: "TRANSPORT",
  SALE: "SALES",
  TRANSFER: "TRANSPORT",
  CARGO_LOSS: "TRANSPORT",
  DAILY_SETTLEMENT: "WAGES",
  INSTALLMENT_SETTLEMENT: "SALES",
  RESERVATION: null,
  ASSET_SALE: "ASSET_SALES",
  // A truck getting home pays its trip's transport cost (ADR 0019 decision 2).
  VEHICLE_RETURN: "TRANSPORT",
  // A shakedown's cash (Dr LOSSES / Cr CASH; LOSSES has no account category), issue #159.
  LOSS: "LOSSES",
  // Reputation, tier, unlock, and outcome rows never have entries (ADR 0020 decision 14).
  PROGRESSION: null,
};

export class FinanceProjectionError extends Error {
  override readonly name = "FinanceProjectionError";
}

function cashMovement(transaction: LedgerTransaction): Money {
  let net = ZERO_MONEY;
  for (const e of transaction.entries) {
    if (e.account !== "CASH") continue;
    net = e.side === "DEBIT" ? addMoney(net, e.amount) : subtractMoney(net, e.amount);
  }
  return net;
}

/** ADR 0015: the one category all non-cash accounts share, else the kind's default. */
function cashFlowCategoryOf(transaction: LedgerTransaction): CashFlowCategory | null {
  let shared: CashFlowCategory | null = null;
  for (const e of transaction.entries) {
    if (e.account === "CASH") continue;
    const category = ACCOUNT_CATEGORY[e.account];
    if (category === undefined || (shared !== null && shared !== category)) return CASH_FLOW_CATEGORY[transaction.kind];
    shared = category;
  }
  return shared ?? CASH_FLOW_CATEGORY[transaction.kind];
}

export function incomeStatement(balances: AccountBalances): IncomeStatement {
  const revenue = balances.SALES_REVENUE;
  const costOfGoodsSold = balances.COST_OF_GOODS_SOLD;
  const grossProfit = subtractMoney(revenue, costOfGoodsSold);
  const expenses = EXPENSE_ACCOUNTS.map(([category, account]) => ({ category, amount: balances[account] }));
  const gains = balances.GAIN_ON_ASSET_SALE;
  const netProfit = addMoney(subtractMoney(grossProfit, sumMoney(expenses.map((e) => e.amount))), gains);
  return { revenue, costOfGoodsSold, grossProfit, expenses, gains, netProfit };
}

export function cashFlowStatement(openingCash: Money, transactions: readonly LedgerTransaction[]): CashFlowStatement {
  const totals = new Map<CashFlowCategory, Money>(CASH_FLOW_ORDER.map((c) => [c, ZERO_MONEY]));
  for (const t of transactions) {
    const moved = cashMovement(t);
    if (moved === 0) continue;
    const category = cashFlowCategoryOf(t);
    if (category === null) throw new FinanceProjectionError(`${t.id} (${t.kind}) moved cash in a reporting period`);
    totals.set(category, addMoney(totals.get(category)!, moved));
  }
  const lines = CASH_FLOW_ORDER.map((category) => ({ category, amount: totals.get(category)! }));
  const netChange = sumMoney(lines.map((l) => l.amount));
  return { openingCash, lines, netChange, closingCash: addMoney(openingCash, netChange) };
}

/** Transactions after `fromTick` (and through `throughTick`, if given). */
function period(all: readonly LedgerTransaction[], fromTick: Tick, toTick: Tick, throughTick: Tick | null): PeriodReport {
  const before = all.filter((t) => t.tick <= fromTick);
  const inside = all.filter((t) => t.tick > fromTick && (throughTick === null || t.tick <= throughTick));
  return {
    fromTick,
    toTick,
    profit: incomeStatement(accountBalances(inside)),
    cashFlow: cashFlowStatement(accountBalances(before).CASH, inside),
  };
}

export function balanceSheetOf(balances: AccountBalances): BalanceSheet {
  const assets = {
    cash: balances.CASH,
    rawMaterials: balances.RAW_MATERIALS,
    finishedGoods: balances.FINISHED_GOODS,
    goodsInTransit: balances.GOODS_IN_TRANSIT,
    receivables: balances.RECEIVABLES,
    equipment: balances.EQUIPMENT,
    vehicles: balances.VEHICLES,
    facilities: balances.FACILITIES,
  };
  const liabilities = { wagesPayable: balances.WAGES_PAYABLE, penaltiesPayable: balances.PENALTIES_PAYABLE };
  const totalAssets = sumMoney(Object.values(assets));
  const totalLiabilities = sumMoney(Object.values(liabilities));
  return { assets, liabilities, totalAssets, totalLiabilities, equity: subtractMoney(totalAssets, totalLiabilities) };
}

export function projectFinance(state: GameState): FinanceSnapshot {
  const all = state.ledger.transactions;
  const sheet = balanceSheetOf(ledgerBalances(all));
  const now = state.tick;
  const today = dayIndex(now);
  const dayStart = tick(today * TICKS_PER_DAY);
  return {
    cash: sheet.assets.cash,
    netWorth: sheet.equity,
    balanceSheet: sheet,
    today: period(all, dayStart, now, null),
    previousDay: today === 0 ? null : period(all, tick(dayStart - TICKS_PER_DAY), dayStart, dayStart),
    toDate: period(all, tick(0), now, null),
    recentTransactions: all.slice(-SNAPSHOT_RECENT_TRANSACTIONS),
  };
}
