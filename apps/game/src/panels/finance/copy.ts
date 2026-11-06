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
  statementCaption: (title: string, ticks: string) => `${title} (${ticks})`,
  transactions: "Recent transactions",
  noTransactions: "No transactions yet.",
  tick: "Tick",
  kind: "Kind",
  entries: "Entries",
  debit: "Dr",
  credit: "Cr",
  entryLine: (side: string, account: string, amount: string) => `${side} ${account} ${amount}`,
} as const;

export const ASSET_COPY: Readonly<Record<keyof BalanceSheet["assets"], string>> = {
  cash: "Cash",
  rawMaterials: "Raw materials",
  finishedGoods: "Finished goods",
  goodsInTransit: "Goods in transit",
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
};

export const TRANSACTION_KIND_COPY: Readonly<Record<TransactionKind, string>> = {
  OPENING_BALANCE: "Opening balance",
  MATERIAL_PURCHASE: "Material purchase",
  PRODUCTION: "Production",
  PRODUCTION_WRITE_OFF: "Production write-off",
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
};

export const ACCOUNT_COPY: Readonly<Record<LedgerAccount, string>> = {
  CASH: "Cash",
  RAW_MATERIALS: "Raw materials",
  FINISHED_GOODS: "Finished goods",
  GOODS_IN_TRANSIT: "Goods in transit",
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
