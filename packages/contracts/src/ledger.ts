// Double-entry ledger types. GDD §8 (FIN-001). The ledger itself is implemented in T02b.
//
// Every economic change is one balanced transaction: total debits = total credits.
// Accounts follow the usual sides: assets and expenses increase with debits;
// liabilities, equity, and revenue increase with credits.

import type { EventId, TransactionId } from "./ids.ts";
import type { Money } from "./money.ts";
import type { Tick } from "./time.ts";

export const LEDGER_ACCOUNTS = {
  // Assets
  CASH: "asset",
  RAW_MATERIALS: "asset",
  FINISHED_GOODS: "asset",
  /** Owned goods on a truck. Moving goods between owned locations doesn't change net worth. */
  GOODS_IN_TRANSIT: "asset",
  /** Kept for later credit terms; unused in M001 (ADR 0005: cash on delivery). */
  RECEIVABLES: "asset",
  EQUIPMENT: "asset",
  VEHICLES: "asset",
  FACILITIES: "asset",
  // Liabilities
  WAGES_PAYABLE: "liability",
  PENALTIES_PAYABLE: "liability",
  // Equity
  /** The scenario's starting book value (GDD §14.1, decided in T05). */
  OWNER_EQUITY: "equity",
  // Revenue and gains
  SALES_REVENUE: "revenue",
  GAIN_ON_ASSET_SALE: "revenue",
  // Expenses and losses
  COST_OF_GOODS_SOLD: "expense",
  WAGES_EXPENSE: "expense",
  OVERHEAD_EXPENSE: "expense",
  TRANSPORT_EXPENSE: "expense",
  PENALTY_EXPENSE: "expense",
  /** Cargo loss, failed production, impairment: always recorded explicitly (FIN-001). */
  LOSSES: "expense",
} as const;

export type LedgerAccount = keyof typeof LEDGER_ACCOUNTS;
export type AccountType = (typeof LEDGER_ACCOUNTS)[LedgerAccount];

export interface LedgerEntry {
  readonly account: LedgerAccount;
  readonly side: "DEBIT" | "CREDIT";
  /** Always positive. The side carries the direction. */
  readonly amount: Money;
}

/** What kind of operation a transaction records, for grouping and explanations. */
export type TransactionKind =
  | "OPENING_BALANCE"
  | "MATERIAL_PURCHASE"
  | "PRODUCTION"
  | "PRODUCTION_WRITE_OFF"
  | "EQUIPMENT_PURCHASE"
  | "DISPATCH"
  | "SALE"
  | "TRANSFER"
  | "CARGO_LOSS"
  | "DAILY_SETTLEMENT"
  | "CONTRACT_PENALTY"
  | "ASSET_SALE";

export interface LedgerTransaction {
  readonly id: TransactionId;
  readonly tick: Tick;
  readonly kind: TransactionKind;
  /** Balanced: debits = credits. At least two entries. */
  readonly entries: readonly LedgerEntry[];
  /** The event that reported this transaction. */
  readonly eventId: EventId;
}
