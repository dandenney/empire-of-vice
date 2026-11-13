// The ledger (SK2b, #234; GDD §17): what the founder knows, written like a
// period account book, each entry dated with its source. PLACEHOLDER layout:
// the look is the human's call (factory.md §8).

import type { PlayerSnapshot } from "@eov/contracts";
import { useMemo } from "react";
import { LEDGER_COPY as C } from "./copy.ts";
import { ledgerGroups, type LedgerEntryView } from "./ledger-view.ts";
import "./ledger.css";

function Entry({ entry }: { readonly entry: LedgerEntryView }) {
  return (
    <li className="kledger-entry" data-testid="ledger-entry" data-subject={entry.subject} data-key={entry.key}>
      <div className="kledger-entry-head">
        <span className="kledger-entry-title">{entry.title}</span>
        <span className="kledger-entry-when" data-testid="ledger-entry-when">
          <span>{entry.updated}</span> <span data-testid="ledger-entry-source">{C.inParens(entry.source)}</span>
        </span>
      </div>
      <p className="kledger-entry-age" data-testid="ledger-entry-age">
        {entry.age}
      </p>
      <dl className="kledger-lines">
        {entry.lines.map((line, i) =>
          typeof line === "string" ? (
            <div key={i} className="kledger-line kledger-line-note">
              <dd>{line}</dd>
            </div>
          ) : (
            <div key={i} className="kledger-line">
              <dt>{line[0]}</dt>
              <dd>{line[1]}</dd>
            </div>
          ),
        )}
      </dl>
    </li>
  );
}

export function LedgerPanel({ player }: { readonly player: PlayerSnapshot }) {
  const groups = useMemo(() => ledgerGroups(player), [player]);
  return (
    <section className="kledger" data-testid="ledger" aria-label={C.title}>
      <h2 className="section-title kledger-title">
        {C.title} <span className="placeholder-tag">{C.placeholder}</span>
      </h2>
      <p className="kledger-intro">{C.intro}</p>
      {groups.length === 0 && (
        <p className="panel-empty" data-testid="ledger-empty">
          {C.empty}
        </p>
      )}
      {groups.map((group) => (
        <section key={group.key} className="kledger-group" data-testid="ledger-group" data-key={group.key}>
          <h3 className="group-title">{group.title}</h3>
          <ol className="kledger-entries">
            {group.entries.map((e) => (
              <Entry key={e.key} entry={e} />
            ))}
          </ol>
        </section>
      ))}
    </section>
  );
}
