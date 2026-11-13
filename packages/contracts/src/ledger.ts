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
  /**
   * Production conversion cost paid when a job starts and not yet settled (ADR 0022
   * decision 7). A prepaid cost, not an expense. Its balance equals the sum of
   * `ProductionJobState.conversionPrepaid` over running jobs.
   */
  PRODUCTION_IN_PROGRESS: "asset",
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
  /**
   * Starting a production job (ADR 0022 decision 7): reserves its inputs and pays its
   * conversion cost, Dr PRODUCTION_IN_PROGRESS / Cr CASH (no entries when that cost is 0).
   * Its cash-flow kind default is WAGES (ADR 0015).
   */
  | "PRODUCTION_START"
  | "EQUIPMENT_PURCHASE"
  | "DISPATCH"
  | "SALE"
  | "TRANSFER"
  | "CARGO_LOSS"
  | "DAILY_SETTLEMENT"
  /** Settling one installment, including any penalty. */
  | "INSTALLMENT_SETTLEMENT"
  | "RESERVATION"
  | "ASSET_SALE"
  /**
   * A truck back at its home facility. Carries the trip's transport cost (paid,
   * or accrued to WAGES_PAYABLE) and any cargo it brings home (ADR 0019 decision 2).
   */
  | "VEHICLE_RETURN"
  /**
   * A loss of cash booked by a scheduled world event (a SHAKEDOWN, T07f): Dr LOSSES /
   * Cr CASH. Its cash flow line is LOSSES (#159).
   */
  | "LOSS"
  /**
   * Reputation, tier, unlock, and outcome changes (ADR 0020 decision 14). It never
   * has entries and isn't a money line: the finance ledger skips these rows, and the
   * player-facing category comes from the event, not this kind (#99 point 4).
   */
  | "PROGRESSION"
  /**
   * Telephones (ADR 0024 decisions 2, 3 and 5): installing a line (Dr EQUIPMENT /
   * Cr CASH, filed under EQUIPMENT by its account), a connected call out (Dr
   * OVERHEAD_EXPENSE / Cr CASH, at the public fee or CALL_COST), and the
   * entry-less records of calls in. Its cash-flow kind default is OVERHEAD.
   */
  | "TELEPHONE"
  /** A room rented for a stay (ADR 0027 decision 4): Dr OVERHEAD_EXPENSE / Cr CASH. Its cash-flow kind default is OVERHEAD. */
  | "LODGING"
  /**
   * Employees (ADR 0025 decision 4): a hire's signing cost (Dr WAGES_EXPENSE /
   * Cr CASH, none at cost 0), and the entry-less records of standing orders,
   * dismissals and reports. Its cash-flow kind default is WAGES.
   */
  | "PERSONNEL";

/**
 * One committed coordinator transaction (ADR 0010). The ledger log doubles as the
 * coordinator's record of what has been applied, so its idempotency keys are how
 * duplicates are caught.
 */
export interface LedgerTransaction {
  readonly id: TransactionId;
  readonly tick: Tick;
  readonly kind: TransactionKind;
  /** Unique per real-world operation, e.g. "SALE:delivery-3". A second commit with the same key is a no-op. */
  readonly idempotencyKey: string;
  /**
   * Balanced (debits = credits) with at least two entries, or empty for an
   * operation that moves no money (e.g. reserving inventory, a fully fulfilled installment).
   */
  readonly entries: readonly LedgerEntry[];
  /** Events emitted by this transaction, in order. */
  readonly eventIds: readonly EventId[];
}
