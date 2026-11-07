// Finance (FIN-001, GDD §8): the balance sheet, the income statement and cash
// flow by category for a chosen period, and the recent ledger transactions, so
// the player can see why money was earned or lost. Every figure comes from the
// snapshot; the panel only formats it.

import { formatMoney, type BalanceSheet, type FinanceSnapshot, type LedgerTransaction, type Money, type PeriodReport } from "@eov/contracts";
import { useState } from "react";
import type { PanelProps } from "../registry.ts";
import { ACCOUNT_COPY, ASSET_COPY, CASH_FLOW_COPY, EXPENSE_COPY, FINANCE_COPY as C, LIABILITY_COPY, TRANSACTION_KIND_COPY } from "./copy.ts";

type PeriodKey = "today" | "previousDay" | "toDate";

const PERIODS: readonly { readonly key: PeriodKey; readonly label: string }[] = [
  { key: "today", label: C.today },
  { key: "previousDay", label: C.previousDay },
  { key: "toDate", label: C.toDate },
];

function Line({ label, amount, testId, total }: { readonly label: string; readonly amount: Money; readonly testId: string; readonly total?: boolean }) {
  return (
    <tr className={total ? "total" : undefined}>
      <th scope="row">{label}</th>
      <td data-testid={testId}>{formatMoney(amount)}</td>
    </tr>
  );
}

function BalanceSheetTable({ sheet }: { readonly sheet: BalanceSheet }) {
  const assets = Object.keys(ASSET_COPY) as (keyof BalanceSheet["assets"])[];
  const liabilities = Object.keys(LIABILITY_COPY) as (keyof BalanceSheet["liabilities"])[];
  return (
    <table data-testid="finance-balance-sheet">
      <caption>{C.balanceSheet}</caption>
      <tbody>
        <tr>
          <th colSpan={2} scope="rowgroup">
            {C.assets}
          </th>
        </tr>
        {assets.map((k) => (
          <Line key={k} label={ASSET_COPY[k]} amount={sheet.assets[k]} testId={`finance-asset-${k}`} />
        ))}
        <Line label={C.totalAssets} amount={sheet.totalAssets} testId="finance-total-assets" total />
        <tr>
          <th colSpan={2} scope="rowgroup">
            {C.liabilities}
          </th>
        </tr>
        {liabilities.map((k) => (
          <Line key={k} label={LIABILITY_COPY[k]} amount={sheet.liabilities[k]} testId={`finance-liability-${k}`} />
        ))}
        <Line label={C.totalLiabilities} amount={sheet.totalLiabilities} testId="finance-total-liabilities" total />
        <Line label={C.equity} amount={sheet.equity} testId="finance-equity" total />
      </tbody>
    </table>
  );
}

function IncomeStatementTable({ report }: { readonly report: PeriodReport }) {
  const p = report.profit;
  return (
    <table data-testid="finance-income-statement">
      <caption>{C.statementCaption(C.incomeStatement, C.ticks(report.fromTick, report.toTick))}</caption>
      <tbody>
        <Line label={C.revenue} amount={p.revenue} testId="finance-revenue" />
        <Line label={C.costOfGoodsSold} amount={p.costOfGoodsSold} testId="finance-cogs" />
        <Line label={C.grossProfit} amount={p.grossProfit} testId="finance-gross-profit" total />
        {p.expenses.map((e) => (
          <Line key={e.category} label={EXPENSE_COPY[e.category]} amount={e.amount} testId={`finance-expense-${e.category}`} />
        ))}
        <Line label={C.gains} amount={p.gains} testId="finance-gains" />
        <Line label={C.netProfit} amount={p.netProfit} testId="finance-net-profit" total />
      </tbody>
    </table>
  );
}

function CashFlowTable({ report }: { readonly report: PeriodReport }) {
  const c = report.cashFlow;
  return (
    <table data-testid="finance-cash-flow">
      <caption>{C.statementCaption(C.cashFlow, C.ticks(report.fromTick, report.toTick))}</caption>
      <tbody>
        <Line label={C.openingCash} amount={c.openingCash} testId="finance-opening-cash" />
        {c.lines.map((l) => (
          <Line key={l.category} label={CASH_FLOW_COPY[l.category]} amount={l.amount} testId={`finance-cash-${l.category}`} />
        ))}
        <Line label={C.netChange} amount={c.netChange} testId="finance-net-change" total />
        <Line label={C.closingCash} amount={c.closingCash} testId="finance-closing-cash" total />
      </tbody>
    </table>
  );
}

function TransactionsTable({ transactions }: { readonly transactions: FinanceSnapshot["recentTransactions"] }) {
  // The money ledger skips PROGRESSION rows: reputation, tier, unlock, and outcome
  // changes aren't financial transactions (ADR 0020 decision 14, #99 point 4).
  const money = transactions.filter((t) => t.kind !== "PROGRESSION");
  if (money.length === 0) return <p>{C.noTransactions}</p>;
  // Newest first; the snapshot lists them oldest first.
  const rows: readonly LedgerTransaction[] = [...money].reverse();
  return (
    <table data-testid="finance-transactions">
      <caption>{C.transactions}</caption>
      <thead>
        <tr>
          <th scope="col">{C.tick}</th>
          <th scope="col">{C.kind}</th>
          <th scope="col">{C.entries}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((t) => (
          <tr key={t.id} data-testid="finance-transaction" data-kind={t.kind}>
            <td>{t.tick}</td>
            <td>{TRANSACTION_KIND_COPY[t.kind]}</td>
            <td>
              <ul>
                {t.entries.map((e, i) => (
                  <li key={i}>{C.entryLine(e.side === "DEBIT" ? C.debit : C.credit, ACCOUNT_COPY[e.account], formatMoney(e.amount))}</li>
                ))}
              </ul>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function FinancePanel({ snapshot }: PanelProps) {
  const { finance } = snapshot;
  const [period, setPeriod] = useState<PeriodKey>("today");
  const report = finance[period];
  return (
    <section data-testid="panel-finance" aria-labelledby="finance-title">
      <h2 id="finance-title">{C.title}</h2>
      <BalanceSheetTable sheet={finance.balanceSheet} />
      <fieldset>
        <legend>{C.period}</legend>
        {PERIODS.map((p) => (
          <label key={p.key}>
            <input type="radio" name="finance-period" value={p.key} checked={period === p.key} onChange={() => setPeriod(p.key)} data-testid={`finance-period-${p.key}`} />
            {p.label}
          </label>
        ))}
      </fieldset>
      {report ? (
        <div className="statements">
          <IncomeStatementTable report={report} />
          <CashFlowTable report={report} />
        </div>
      ) : (
        <p data-testid="finance-no-period">{C.noPreviousDay}</p>
      )}
      <TransactionsTable transactions={finance.recentTransactions} />
    </section>
  );
}
