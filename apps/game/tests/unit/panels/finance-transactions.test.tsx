// T05a (#100): the finance panel's transactions table is a money ledger, so it
// skips PROGRESSION rows (reputation, tier, unlock, and outcome changes), and its
// empty state applies after that filter (ADR 0020 decision 14).

import { asId, tick, type GameSnapshot, type LedgerTransaction } from "@eov/contracts";
import { midGameSnapshot } from "@eov/contracts/fixtures";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FINANCE_COPY } from "../../../src/panels/finance/copy.ts";
import { FinancePanel } from "../../../src/panels/finance/finance-panel.tsx";

const progression: LedgerTransaction = {
  id: asId("Transaction", "txn-99"),
  tick: tick(5_200),
  kind: "PROGRESSION",
  idempotencyKey: "PROGRESSION:delivery-9",
  entries: [],
  eventIds: [asId("Event", "evt-99")],
};

function withTransactions(transactions: readonly LedgerTransaction[]): GameSnapshot {
  return { ...midGameSnapshot, finance: { ...midGameSnapshot.finance, recentTransactions: transactions } };
}

const render = (snapshot: GameSnapshot) => renderToStaticMarkup(<FinancePanel snapshot={snapshot} />);
const rowCount = (html: string) => html.match(/data-testid="finance-transaction"/g)?.length ?? 0;

describe("finance transactions table", () => {
  it("skips PROGRESSION rows and keeps every money row", () => {
    const money = midGameSnapshot.finance.recentTransactions;
    expect(money.length).toBeGreaterThan(0);
    expect(money.some((t) => t.kind === "PROGRESSION")).toBe(false);

    const html = render(withTransactions([...money, progression]));
    expect(rowCount(html)).toBe(money.length);
    expect(html).not.toContain('data-kind="PROGRESSION"');
  });

  it("shows the empty state when only PROGRESSION rows remain", () => {
    const html = render(withTransactions([progression]));
    expect(rowCount(html)).toBe(0);
    expect(html).not.toContain('data-testid="finance-transactions"');
    expect(html).toContain(FINANCE_COPY.noTransactions);
  });
});
