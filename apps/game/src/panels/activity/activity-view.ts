// Activity feed rows (#136): the snapshot's recent money transactions as cash
// lines, with Reputation rows (REPUTATION_CHANGED) and Standing rows
// (TIER_REACHED) from its recent events set between them by tick. Display
// only: names come from the snapshot, figures from the transactions and
// events as given. Nothing here is kept between snapshots.
//
// Kept out, as #99 point 4 and ADR 0020 decision 14 ask: PROGRESSION
// transactions (they're never money lines; the event rows stand in for them),
// and unlocks, victory, and loss, which get no ledger category.
// TIER_REACHED is already a toast (#61); here it's a row in the record, not a
// second notification.

import type { GameEvent, GameSnapshot, LedgerTransaction, Money, Tick, TransactionKind } from "@eov/contracts";
import { TRANSACTION_KIND_COPY } from "../finance/copy.ts";
import { ACTIVITY_COPY as C } from "./copy.ts";

export type ActivityRow =
  | {
      readonly kind: "cash";
      readonly id: string;
      readonly tick: Tick;
      readonly transactionKind: TransactionKind;
      readonly label: string;
      /** The transaction's net effect on cash, or null if it didn't touch cash. */
      readonly cash: Money | null;
    }
  | { readonly kind: "reputation" | "standing"; readonly id: string; readonly tick: Tick; readonly category: string; readonly text: string };

/** Net cash moved by one transaction: CASH debits in, CASH credits out. Null when no entry touches cash. */
export function cashChange(transaction: LedgerTransaction): Money | null {
  const lines = transaction.entries.filter((e) => e.account === "CASH");
  if (lines.length === 0) return null;
  return lines.reduce((sum, e) => sum + (e.side === "DEBIT" ? e.amount : -e.amount), 0) as Money;
}

function tierName(snapshot: GameSnapshot, tierId: string): string {
  return snapshot.progression.tiers.find((t) => t.id === tierId)?.name ?? tierId;
}

/** The row for a progression event, or null for every other event. */
export function eventRow(event: GameEvent, snapshot: GameSnapshot): ActivityRow | null {
  switch (event.type) {
    case "REPUTATION_CHANGED": {
      const delta = event.to - event.from;
      if (delta === 0) return null;
      return { kind: "reputation", id: event.id, tick: event.tick, category: C.reputationCategory, text: delta > 0 ? C.reputationUp(delta) : C.reputationDown(-delta) };
    }
    case "TIER_REACHED":
      return { kind: "standing", id: event.id, tick: event.tick, category: C.standingCategory, text: C.tierReached(tierName(snapshot, event.tierId)) };
    default:
      return null;
  }
}

/** A money transaction's cash line, or null for PROGRESSION rows and transactions that move nothing. */
export function transactionRow(transaction: LedgerTransaction): ActivityRow | null {
  if (transaction.kind === "PROGRESSION" || transaction.entries.length === 0) return null;
  return {
    kind: "cash",
    id: transaction.id,
    tick: transaction.tick,
    transactionKind: transaction.kind,
    label: TRANSACTION_KIND_COPY[transaction.kind],
    cash: cashChange(transaction),
  };
}

/**
 * Every row, newest first. On the same tick a progression row follows the cash
 * line that caused it (a sale, then the reputation it earned), so newest-first
 * it sits above it.
 */
export function activityRows(snapshot: GameSnapshot): readonly ActivityRow[] {
  const cash = snapshot.finance.recentTransactions.map(transactionRow).filter((r): r is ActivityRow => r !== null);
  const progression = snapshot.recentEvents.map((e) => eventRow(e, snapshot)).filter((r): r is ActivityRow => r !== null);
  // Oldest first: merge the two (each already oldest first), cash before progression on a tie.
  const merged: ActivityRow[] = [];
  let i = 0;
  let j = 0;
  while (i < cash.length || j < progression.length) {
    const c = cash[i];
    const p = progression[j];
    if (c && (!p || c.tick <= p.tick)) {
      merged.push(c);
      i++;
    } else {
      merged.push(p!);
      j++;
    }
  }
  return merged.reverse();
}
