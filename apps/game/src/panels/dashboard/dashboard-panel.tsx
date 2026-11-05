// Dashboard (FIN-001, GDD §8): profit, cash flow, and net worth as distinct
// figures, plus cash and the game date. Every figure comes from the snapshot;
// the panel only formats it.

import { formatMoney, type Money, type PeriodReport } from "@eov/contracts";
import { COMMON_COPY } from "../../components/copy.ts";
import { formatGameDate } from "../../components/format.ts";
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
    <section data-testid="panel-dashboard" aria-labelledby="dashboard-title">
      <h2 id="dashboard-title">{C.title}</h2>
      <dl>
        <dt>{C.date}</dt>
        <dd data-testid="dashboard-date">
          {formatGameDate(clock.date)} ({C.day(clock.dayIndex)}, {COMMON_COPY.tick(clock.tick)})
        </dd>
        <dt>{C.cash}</dt>
        <dd data-testid="dashboard-cash">{formatMoney(finance.cash)}</dd>
        <dt>{C.netWorth}</dt>
        <dd data-testid="dashboard-net-worth" title={C.netWorthNote}>
          {formatMoney(finance.netWorth)}
        </dd>
      </dl>
      <table>
        <caption>{C.periodsCaption}</caption>
        <thead>
          <tr>
            <th scope="col">{C.metric}</th>
            {PERIODS.map((p) => (
              <th scope="col" key={p.key}>
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
                  <td key={p.key} data-testid={`dashboard-${row.key}-${p.key}`}>
                    {report ? formatMoney(row.value(report)) : COMMON_COPY.none}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
