// The Activity feed (#136): money transactions as cash lines, Reputation and
// Standing rows from REPUTATION_CHANGED and TIER_REACHED in the #99 wording,
// newest first, and nothing for PROGRESSION transactions, unlocks, victory,
// or loss.

import { asId, cents, tick, type GameEvent, type GameSnapshot, type LedgerTransaction } from "@eov/contracts";
import { ids, midGameSnapshot } from "@eov/contracts/fixtures";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActivityPanel } from "../../../../src/panels/activity/activity-panel.tsx";
import { activityRows, cashChange, eventRow } from "../../../../src/panels/activity/activity-view.ts";

let next = 0;
const meta = (at: number) => ({ id: asId("Event", `evt-a${++next}`), tick: tick(at), causedBy: null });

const reputation = (at: number, from: number, to: number): GameEvent => ({
  ...meta(at),
  type: "REPUTATION_CHANGED",
  from,
  to,
  reason: "INSTALLMENT_FULFILLED",
  deliveryId: null,
  contractId: null,
});
const tierReached = (at: number): GameEvent => ({ ...meta(at), type: "TIER_REACHED", tierId: ids.tierTrusted });

const sale = (at: number, amount: number): LedgerTransaction => ({
  id: asId("Transaction", `txn-a${++next}`),
  tick: tick(at),
  kind: "SALE",
  idempotencyKey: `SALE:a${next}`,
  entries: [
    { account: "CASH", side: "DEBIT", amount: cents(amount) },
    { account: "SALES_REVENUE", side: "CREDIT", amount: cents(amount) },
  ],
  eventIds: [],
});
const progressionTxn = (at: number): LedgerTransaction => ({
  id: asId("Transaction", `txn-a${++next}`),
  tick: tick(at),
  kind: "PROGRESSION",
  idempotencyKey: `PROGRESSION:a${next}`,
  entries: [],
  eventIds: [],
});

function with_(events: readonly GameEvent[], transactions: readonly LedgerTransaction[]): GameSnapshot {
  return { ...midGameSnapshot, recentEvents: events, finance: { ...midGameSnapshot.finance, recentTransactions: transactions } };
}

describe("the #99 strings, verbatim", () => {
  it("reputation up and down, with the delta from the event", () => {
    expect(eventRow(reputation(10, 4, 9), midGameSnapshot)).toMatchObject({ kind: "reputation", category: "Reputation", text: "Word gets around. Reputation +5." });
    expect(eventRow(reputation(10, 9, 6), midGameSnapshot)).toMatchObject({ kind: "reputation", category: "Reputation", text: "Word gets around. Reputation −3." });
  });

  it("a new standing, named from the snapshot", () => {
    expect(eventRow(tierReached(10), midGameSnapshot)).toMatchObject({ kind: "standing", category: "Standing", text: "New standing: Trusted Supplier." });
  });
});

describe("what's left out", () => {
  it("unlocks, victory, loss, and every other event get no row", () => {
    const others: GameEvent[] = [
      { ...meta(1), type: "UNLOCK_GRANTED", unlockId: ids.unlockContracts },
      { ...meta(1), type: "VICTORY_ACHIEVED", netWorth: cents(1), reputation: 30, completedContractId: asId("Contract", "c-1") },
      { ...meta(1), type: "GAME_LOST", reason: "INSOLVENT" },
      reputation(1, 3, 3),
      ...midGameSnapshot.recentEvents,
    ];
    for (const e of others) expect(eventRow(e, midGameSnapshot)).toBeNull();
  });

  it("PROGRESSION transactions are never cash lines", () => {
    expect(activityRows(with_([], [progressionTxn(5)]))).toEqual([]);
  });
});

describe("cash lines", () => {
  it("carry the transaction's net effect on cash, or null when cash didn't move", () => {
    expect(cashChange(sale(1, 1_500))).toBe(1_500);
    const production: LedgerTransaction = { ...sale(1, 1), kind: "PRODUCTION", entries: [{ account: "FINISHED_GOODS", side: "DEBIT", amount: cents(9) }, { account: "RAW_MATERIALS", side: "CREDIT", amount: cents(9) }] };
    expect(cashChange(production)).toBeNull();
    const paid: LedgerTransaction = { ...sale(1, 1), kind: "MATERIAL_PURCHASE", entries: [{ account: "RAW_MATERIALS", side: "DEBIT", amount: cents(700) }, { account: "CASH", side: "CREDIT", amount: cents(700) }] };
    expect(cashChange(paid)).toBe(-700);
  });
});

describe("the feed", () => {
  it("is newest first, with a progression row above the cash line it followed on the same tick", () => {
    const s1 = sale(100, 500);
    const s2 = sale(300, 800);
    const r = reputation(300, 0, 2);
    const t = tierReached(400);
    const rows = activityRows(with_([r, t], [s1, s2, progressionTxn(300)]));
    expect(rows.map((x) => x.id)).toEqual([t.id, r.id, s2.id, s1.id]);
  });

  it("styles progression rows apart from cash lines and gives them no figure", () => {
    const html = renderToStaticMarkup(<ActivityPanel snapshot={with_([reputation(300, 0, 2)], [sale(100, 500)])} />);
    expect(html).toMatch(/<tr class="activity-row activity-note" data-kind="reputation"[^>]*>(?:(?!<\/tr>).)*Word gets around\. Reputation \+2\.(?:(?!<\/tr>).)*<\/tr>/);
    expect(html).not.toMatch(/data-kind="reputation"(?:(?!<\/tr>).)*class="money"/);
    expect(html).toMatch(/data-kind="cash"(?:(?!<\/tr>).)*\$5\.00/);
  });

  it("shows the empty state with nothing to list", () => {
    expect(renderToStaticMarkup(<ActivityPanel snapshot={with_([], [])} />)).toContain('data-testid="activity-empty"');
  });
});
