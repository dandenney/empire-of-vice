// Dashboard (FIN-001, GDD §8): profit, cash flow, and net worth as distinct
// figures, plus cash and the game date. Every figure comes from the snapshot;
// the panel only formats it.

import type { Money, PeriodReport } from "@eov/contracts";
import { COMMON_COPY } from "../../components/copy.ts";
import { formatGameDate } from "../../components/format.ts";
import { LedgerTable, MoneyFigure } from "../../ui/ledger.tsx";
import type { PanelProps } from "../registry.ts";
import { DASHBOARD_COPY as C } from "./copy.ts";

type PeriodKey = "today" | "previousDay" | "toDate";

const PERIODS: readonly { readonly key: PeriodKey; readonly label: string }[] = [
  { key: "today", label: C.today },
  { key: "previousDay", label: C.previousDay },
  { key: "toDate", label: C.toDate },
];

const ROWS: readonly { readonly key: string; readonly label: string; readonly value: (p: PeriodReport) => Money }[] = [
  { key: "revenue", label: C.revenue, value: (p) => p.profit.revenue },
  { key: "profit", label: C.netProfit, value: (p) => p.profit.netProfit },
  { key: "cash-flow", label: C.netCashFlow, value: (p) => p.cashFlow.netChange },
];

export function DashboardPanel({ snapshot }: PanelProps) {
  const { clock, finance } = snapshot;
  return (
    <section className="panel" data-testid="panel-dashboard" aria-labelledby="dashboard-title">
      <h2 className="panel-title" id="dashboard-title">
        {C.title}
      </h2>
      <dl className="stats">
        <div className="stat stat-wide">
          <dt>{C.date}</dt>
          <dd className="stat-mono" data-testid="dashboard-date">
            {C.dateLine(formatGameDate(clock.date), C.day(clock.dayIndex), COMMON_COPY.tick(clock.tick))}
          </dd>
        </div>
        <div className="stat">
          <dt>{C.cash}</dt>
          <dd className="stat-figure" data-testid="dashboard-cash">
            <MoneyFigure amount={finance.cash} />
          </dd>
        </div>
        <div className="stat">
          <dt>{C.netWorth}</dt>
          <dd className="stat-figure" data-testid="dashboard-net-worth" title={C.netWorthNote}>
            <MoneyFigure amount={finance.netWorth} />
          </dd>
        </div>
      </dl>
      <LedgerTable caption={C.periodsCaption} className="ledger-columns ledger-note">
        <thead>
          <tr>
            <th scope="col">{C.metric}</th>
            {PERIODS.map((p) => (
              <th scope="col" className="figure" key={p.key}>
                {p.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row) => (
            <tr key={row.key}>
              <th scope="row">{row.label}</th>
              {PERIODS.map((p) => {
                const report = finance[p.key];
                return (
                  <td key={p.key} className="figure" data-testid={`dashboard-${row.key}-${p.key}`}>
                    {report ? <MoneyFigure amount={row.value(report)} /> : <span className="money-none">{COMMON_COPY.none}</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </LedgerTable>
    </section>
  );
}
