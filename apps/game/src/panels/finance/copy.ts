// PLACEHOLDER copy (story decision): Finance panel strings (#48).

import type { BalanceSheet, CashFlowCategory, ExpenseCategory, LedgerAccount, TransactionKind } from "@eov/contracts";

export const FINANCE_COPY = {
  title: "Finance",
  period: "Period",
  today: "Today",
  previousDay: "Previous day",
  toDate: "To date",
  noPreviousDay: "No complete day yet.",
  balanceSheet: "Balance sheet",
  assets: "Assets",
  liabilities: "Liabilities",
  totalAssets: "Total assets",
  totalLiabilities: "Total liabilities",
  equity: "Equity (net worth)",
  incomeStatement: "Income statement",
  revenue: "Revenue",
  costOfGoodsSold: "Cost of goods sold",
  grossProfit: "Gross profit",
  gains: "Gains",
  netProfit: "Net profit",
  cashFlow: "Cash flow",
  openingCash: "Opening cash",
  netChange: "Net change",
  closingCash: "Closing cash",
  ticks: (from: number, to: number) => `ticks ${from}–${to}`,
  /** "Income statement (ticks 0–5)". Separate parts, so each renders as its own text node, as before #58. */
  statementCaption: (title: string, ticks: string): readonly string[] => [title, " (", ticks, ")"],
  transactions: "Recent transactions",
  noTransactions: "No transactions yet.",
  tick: "Tick",
  kind: "Kind",
  entries: "Entries",
  debit: "Dr",
  credit: "Cr",
  /** "Dr Raw materials $10.00". Separate parts, so each renders as its own text node, as before #58. */
  entryLine: (side: string, account: string, amount: string): readonly string[] => [side, " ", account, " ", amount],
} as const;

export const ASSET_COPY: Readonly<Record<keyof BalanceSheet["assets"], string>> = {
  cash: "Cash",
  rawMaterials: "Raw materials",
  finishedGoods: "Finished goods",
  goodsInTransit: "Goods in transit",
  // PLACEHOLDER (story decision): conversion cost prepaid for running batches (ADR 0022 decision 7).
  productionInProgress: "Batches in progress",
  receivables: "Receivables",
  equipment: "Equipment",
  vehicles: "Vehicles",
  facilities: "Facilities",
};

export const LIABILITY_COPY: Readonly<Record<keyof BalanceSheet["liabilities"], string>> = {
  wagesPayable: "Wages payable",
  penaltiesPayable: "Penalties payable",
};

export const EXPENSE_COPY: Readonly<Record<ExpenseCategory, string>> = {
  WAGES: "Wages",
  OVERHEAD: "Overhead",
  TRANSPORT: "Transport",
  PENALTIES: "Penalties",
  LOSSES: "Losses",
};

export const CASH_FLOW_COPY: Readonly<Record<CashFlowCategory, string>> = {
  SALES: "Sales",
  ASSET_SALES: "Asset sales",
  MATERIALS: "Materials",
  EQUIPMENT: "Equipment",
  WAGES: "Wages",
  OVERHEAD: "Overhead",
  TRANSPORT: "Transport",
  PENALTIES: "Penalties",
  LOSSES: "Losses",
};

export const TRANSACTION_KIND_COPY: Readonly<Record<TransactionKind, string>> = {
  OPENING_BALANCE: "Opening balance",
  MATERIAL_PURCHASE: "Material purchase",
  PRODUCTION: "Production",
  PRODUCTION_WRITE_OFF: "Production write-off",
  // PLACEHOLDER (story decision): ADR 0022 decision 7.
  PRODUCTION_START: "Production started",
  EQUIPMENT_PURCHASE: "Equipment purchase",
  DISPATCH: "Dispatch",
  SALE: "Sale",
  TRANSFER: "Transfer",
  CARGO_LOSS: "Cargo loss",
  DAILY_SETTLEMENT: "Daily settlement",
  INSTALLMENT_SETTLEMENT: "Installment settlement",
  RESERVATION: "Reservation",
  ASSET_SALE: "Asset sale",
  VEHICLE_RETURN: "Truck returned",
  LOSS: "Loss",
  // Internal label the type needs; the transactions table skips PROGRESSION rows,
  // so no screen shows it (ADR 0020 decision 14).
  PROGRESSION: "Progression",
  // PLACEHOLDER (story decision): ADR 0024 and ADR 0027 (PH1, #205). Nothing posts
  // either kind until C1 (#179), so no screen shows them yet.
  TELEPHONE: "Telephone",
  LODGING: "Lodging",
};

export const ACCOUNT_COPY: Readonly<Record<LedgerAccount, string>> = {
  CASH: "Cash",
  RAW_MATERIALS: "Raw materials",
  FINISHED_GOODS: "Finished goods",
  GOODS_IN_TRANSIT: "Goods in transit",
  // PLACEHOLDER (story decision): ADR 0022 decision 7.
  PRODUCTION_IN_PROGRESS: "Batches in progress",
  RECEIVABLES: "Receivables",
  EQUIPMENT: "Equipment",
  VEHICLES: "Vehicles",
  FACILITIES: "Facilities",
  WAGES_PAYABLE: "Wages payable",
  PENALTIES_PAYABLE: "Penalties payable",
  OWNER_EQUITY: "Owner equity",
  SALES_REVENUE: "Sales revenue",
  GAIN_ON_ASSET_SALE: "Gain on asset sale",
  COST_OF_GOODS_SOLD: "Cost of goods sold",
  WAGES_EXPENSE: "Wages expense",
  OVERHEAD_EXPENSE: "Overhead expense",
  TRANSPORT_EXPENSE: "Transport expense",
  PENALTY_EXPENSE: "Penalty expense",
  LOSSES: "Losses",
};
