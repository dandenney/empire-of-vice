// Activity (#136): a running record, newest first, of the money transactions
// (cash lines with their effect on cash) and, set between them, the
// Reputation and Standing rows from REPUTATION_CHANGED and TIER_REACHED in the
// #99 wording. Progression rows carry no money figure and are styled apart
// from cash lines (#99 point 4). Everything comes from the snapshot.

import { COMMON_COPY } from "../../components/copy.ts";
import { LedgerTable, MoneyFigure } from "../../ui/ledger.tsx";
import { formatDayTime } from "../../ui/format/time-format.ts";
import type { PanelProps } from "../registry.ts";
import { activityRows, type ActivityRow } from "./activity-view.ts";
import { ACTIVITY_COPY as C } from "./copy.ts";
import "./activity.css";

function Row({ row }: { readonly row: ActivityRow }) {
  const when = (
    <td className="activity-when" data-testid="activity-when">
      {formatDayTime(row.tick)}
    </td>
  );
  if (row.kind === "cash") {
    return (
      <tr className="activity-row" data-kind="cash" data-transaction-kind={row.transactionKind} data-testid="activity-row">
        {when}
        <td data-testid="activity-text">{row.label}</td>
        <td className="figure" data-testid="activity-cash">
          {row.cash === null ? <span className="money-none">{COMMON_COPY.none}</span> : <MoneyFigure amount={row.cash} />}
        </td>
      </tr>
    );
  }
  return (
    <tr className="activity-row activity-note" data-kind={row.kind} data-testid="activity-row">
      {when}
      <td colSpan={2}>
        <span className="activity-category" data-testid="activity-category">
          {row.category}
        </span>
        <span className="activity-note-text" data-testid="activity-text">
          {row.text}
        </span>
      </td>
    </tr>
  );
}

export function ActivityPanel({ snapshot }: PanelProps) {
  const rows = activityRows(snapshot);
  return (
    <section className="panel" data-testid="panel-activity" aria-labelledby="activity-title">
      <h2 className="panel-title" id="activity-title">
        {C.title}
      </h2>
      <p className="activity-intro">{C.intro}</p>
      {rows.length === 0 ? (
        <p className="panel-empty" data-testid="activity-empty">
          {C.empty}
        </p>
      ) : (
        <LedgerTable className="activity-feed" caption={C.caption} testId="activity-feed">
          <thead>
            <tr>
              <th scope="col">{C.when}</th>
              <th scope="col">{C.what}</th>
              <th scope="col" className="figure">
                {C.cash}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <Row key={row.id} row={row} />
            ))}
          </tbody>
        </LedgerTable>
      )}
    </section>
  );
}
