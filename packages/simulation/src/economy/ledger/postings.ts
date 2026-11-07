// FIN-001 standard postings (T02b, issue #6, decision 1).
//
// Pure entry builders for the chart-of-accounts patterns every flow uses, so
// purchase, production, dispatch, sale, settlement and loss flows can't each
// invent a slightly different entry. Each builder:
//
// - returns `readonly LedgerEntry[]` that balance (debits = credits);
// - omits zero-amount lines, so an all-zero posting returns `[]` (a valid empty
//   transaction) and a posting is never a single line;
// - takes amounts in integer cents (checked `Money`) and does no rounding.
//
// The cash-or-accrue patterns (production, write-off, pay-or-accrue) credit CASH
// only up to `cashAvailable` and the rest to a payable, so a charge that can't be
// paid becomes a liability, never negative cash (FIN-001).

import { addMoney, subtractMoney, ZERO_MONEY, type LedgerAccount, type LedgerEntry, type Money } from "@eov/contracts";

type Line = readonly [account: LedgerAccount, side: LedgerEntry["side"], amount: Money];

/** Builds entries from lines, dropping zero amounts. */
function entries(...lines: readonly Line[]): readonly LedgerEntry[] {
  const out: LedgerEntry[] = [];
  for (const [account, side, amount] of lines) if (amount !== 0) out.push({ account, side, amount });
  return out;
}

const smaller = (a: Money, b: Money): Money => (a < b ? a : b);

/** Splits `amount` into what `cashAvailable` covers and the remainder to accrue. */
function payOrAccrue(amount: Money, cashAvailable: Money): { readonly paid: Money; readonly accrued: Money } {
  const paid = smaller(amount, cashAvailable < 0 ? ZERO_MONEY : cashAvailable);
  return { paid, accrued: subtractMoney(amount, paid) };
}

/** Buying materials for cash: Dr RAW_MATERIALS / Cr CASH. */
export function materialPurchaseEntries(cost: Money): readonly LedgerEntry[] {
  return entries(["RAW_MATERIALS", "DEBIT", cost], ["CASH", "CREDIT", cost]);
}

export interface ProductionCosts {
  /** Cost of the materials consumed (weighted average, FIN-001). */
  readonly materials: Money;
  /** Labor and overhead capitalized into the goods. */
  readonly conversion: Money;
  /** Cash that can pay the conversion cost; the rest accrues to WAGES_PAYABLE. */
  readonly cashAvailable: Money;
}

function conversionPosting(debit: LedgerAccount, costs: ProductionCosts): readonly LedgerEntry[] {
  const { paid, accrued } = payOrAccrue(costs.conversion, costs.cashAvailable);
  return entries(
    [debit, "DEBIT", addMoney(costs.materials, costs.conversion)],
    ["RAW_MATERIALS", "CREDIT", costs.materials],
    ["CASH", "CREDIT", paid],
    ["WAGES_PAYABLE", "CREDIT", accrued],
  );
}

/**
 * A completed production run (the FIN-001 example): Dr FINISHED_GOODS
 * materials + conversion / Cr RAW_MATERIALS materials / Cr CASH what's affordable /
 * Cr WAGES_PAYABLE the rest. Capitalizes cost; recognizes no profit.
 */
export function productionEntries(costs: ProductionCosts): readonly LedgerEntry[] {
  return conversionPosting("FINISHED_GOODS", costs);
}

/** A failed run: as `productionEntries`, but the cost is written off to LOSSES. */
export function productionWriteOffEntries(costs: ProductionCosts): readonly LedgerEntry[] {
  return conversionPosting("LOSSES", costs);
}

/** Loading goods on a truck: Dr GOODS_IN_TRANSIT / Cr FINISHED_GOODS. */
export function dispatchEntries(cost: Money): readonly LedgerEntry[] {
  return entries(["GOODS_IN_TRANSIT", "DEBIT", cost], ["FINISHED_GOODS", "CREDIT", cost]);
}

/** Unsold goods coming home: Dr FINISHED_GOODS / Cr GOODS_IN_TRANSIT. */
export function returnFromTransitEntries(cost: Money): readonly LedgerEntry[] {
  return entries(["FINISHED_GOODS", "DEBIT", cost], ["GOODS_IN_TRANSIT", "CREDIT", cost]);
}

export interface SaleAmounts {
  /** Cash received on delivery (ADR 0005: no receivables in M001). */
  readonly revenue: Money;
  /** Weighted-average cost of the goods delivered. */
  readonly costOfGoodsSold: Money;
}

/** A delivered sale: Dr CASH / Cr SALES_REVENUE, and Dr COST_OF_GOODS_SOLD / Cr GOODS_IN_TRANSIT. */
export function saleEntries(sale: SaleAmounts): readonly LedgerEntry[] {
  return entries(
    ["CASH", "DEBIT", sale.revenue],
    ["SALES_REVENUE", "CREDIT", sale.revenue],
    ["COST_OF_GOODS_SOLD", "DEBIT", sale.costOfGoodsSold],
    ["GOODS_IN_TRANSIT", "CREDIT", sale.costOfGoodsSold],
  );
}

/** Buying equipment for cash: Dr EQUIPMENT / Cr CASH (net worth unchanged). */
export function equipmentPurchaseEntries(cost: Money): readonly LedgerEntry[] {
  return entries(["EQUIPMENT", "DEBIT", cost], ["CASH", "CREDIT", cost]);
}

export interface AssetSaleAmounts {
  /** The item's book value, taken off the EQUIPMENT account. */
  readonly bookValue: Money;
  /** Cash received. At most the book value: M001 has no gain on a sale (ADR 0020 decision 9). */
  readonly proceeds: Money;
}

/**
 * Selling equipment below book value: Dr CASH the proceeds / Dr LOSSES the
 * shortfall / Cr EQUIPMENT the book value. Net worth falls by the shortfall.
 */
export function assetSaleEntries(sale: AssetSaleAmounts): readonly LedgerEntry[] {
  if (sale.proceeds > sale.bookValue) throw new RangeError(`Asset sale proceeds ${sale.proceeds} exceed book value ${sale.bookValue}`);
  return entries(["CASH", "DEBIT", sale.proceeds], ["LOSSES", "DEBIT", subtractMoney(sale.bookValue, sale.proceeds)], ["EQUIPMENT", "CREDIT", sale.bookValue]);
}

/** Cargo lost on the road: Dr LOSSES / Cr GOODS_IN_TRANSIT. */
export function cargoLossEntries(cost: Money): readonly LedgerEntry[] {
  return entries(["LOSSES", "DEBIT", cost], ["GOODS_IN_TRANSIT", "CREDIT", cost]);
}

/** Writing down a long-lived asset: Dr LOSSES / Cr EQUIPMENT or VEHICLES. */
export function impairmentEntries(amount: Money, account: "EQUIPMENT" | "VEHICLES"): readonly LedgerEntry[] {
  return entries(["LOSSES", "DEBIT", amount], [account, "CREDIT", amount]);
}

/** Paying off what's owed: Dr payable / Cr CASH (net worth unchanged). */
export function payDownEntries(amount: Money, payable: "WAGES_PAYABLE" | "PENALTIES_PAYABLE"): readonly LedgerEntry[] {
  return entries([payable, "DEBIT", amount], ["CASH", "CREDIT", amount]);
}

/** Expense accounts a pay-or-accrue charge can debit (COGS only moves with a sale). */
export type ExpenseAccount = "WAGES_EXPENSE" | "OVERHEAD_EXPENSE" | "TRANSPORT_EXPENSE" | "PENALTY_EXPENSE" | "LOSSES";

export interface PayOrAccrueCharge {
  readonly amount: Money;
  readonly expense: ExpenseAccount;
  readonly payable: "WAGES_PAYABLE" | "PENALTIES_PAYABLE";
  readonly cashAvailable: Money;
}

/** A charge paid in cash where possible: Dr expense / Cr CASH up to `cashAvailable` / Cr payable the rest. */
export function payOrAccrueEntries(charge: PayOrAccrueCharge): readonly LedgerEntry[] {
  const { paid, accrued } = payOrAccrue(charge.amount, charge.cashAvailable);
  return entries([charge.expense, "DEBIT", charge.amount], ["CASH", "CREDIT", paid], [charge.payable, "CREDIT", accrued]);
}
