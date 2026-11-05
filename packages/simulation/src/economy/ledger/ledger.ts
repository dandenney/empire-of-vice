// FIN-001 double-entry ledger (T02b, issue #6).
//
// The ledger is the transaction log in `state.ledger` (ADR 0008). Balances and
// the balance sheet are derived from it on demand, never stored in `GameState`,
// so they can't drift. Only the coordinator appends to the log.
//
// Incremental balances (issue #6, decision 2): `ledgerBalances` memoizes each
// log's balances in a module-level WeakMap keyed by the transactions array
// itself. `appendTransaction` builds the next log and seeds its memo entry from
// the previous log's balances plus the new transaction's entries, so a commit
// costs O(accounts + entries), not O(whole log). The memo lives outside state,
// never changes a result (a miss falls back to the full recompute in
// `accountBalances`), and is collected with the arrays it describes. Logs are
// immutable arrays (the coordinator always builds a new one), so a memo entry
// stays valid for the life of its array; the length check is a cheap guard
// against an array appended to in place.

import {
  addMoney,
  LEDGER_ACCOUNTS,
  subtractMoney,
  ZERO_MONEY,
  type GameState,
  type LedgerAccount,
  type LedgerEntry,
  type LedgerTransaction,
  type Money,
} from "@eov/contracts";

export type AccountBalances = Readonly<Record<LedgerAccount, Money>>;

const ACCOUNTS = Object.keys(LEDGER_ACCOUNTS) as readonly LedgerAccount[];

/** True for accounts that increase with debits (assets and expenses). */
export function isDebitNormal(account: LedgerAccount): boolean {
  const type = LEDGER_ACCOUNTS[account];
  return type === "asset" || type === "expense";
}

/** Total debits and credits of a set of entries. */
export function entryTotals(entries: readonly LedgerEntry[]): { readonly debits: Money; readonly credits: Money } {
  let debits = ZERO_MONEY;
  let credits = ZERO_MONEY;
  for (const e of entries) {
    if (e.side === "DEBIT") debits = addMoney(debits, e.amount);
    else credits = addMoney(credits, e.amount);
  }
  return { debits, credits };
}

/** Each account's balance on its normal side (assets: debits − credits; liabilities: credits − debits). */
export function accountBalances(transactions: readonly LedgerTransaction[]): AccountBalances {
  const balances = Object.fromEntries(ACCOUNTS.map((a) => [a, ZERO_MONEY])) as Record<LedgerAccount, Money>;
  for (const t of transactions) {
    for (const e of t.entries) {
      const increases = (e.side === "DEBIT") === isDebitNormal(e.account);
      balances[e.account] = increases ? addMoney(balances[e.account], e.amount) : subtractMoney(balances[e.account], e.amount);
    }
  }
  return balances;
}

/** `balances` with `entries` applied (a new object). */
function withEntries(balances: AccountBalances, entries: readonly LedgerEntry[]): AccountBalances {
  const next: Record<LedgerAccount, Money> = { ...balances };
  for (const e of entries) {
    const increases = (e.side === "DEBIT") === isDebitNormal(e.account);
    next[e.account] = increases ? addMoney(next[e.account], e.amount) : subtractMoney(next[e.account], e.amount);
  }
  return next;
}

interface MemoizedBalances {
  readonly length: number;
  readonly balances: AccountBalances;
}

/** Balances per transactions array. Outside state: a cache, never authoritative. */
const memo = new WeakMap<readonly LedgerTransaction[], MemoizedBalances>();

function remember(transactions: readonly LedgerTransaction[], balances: AccountBalances): AccountBalances {
  const frozen = Object.freeze(balances);
  memo.set(transactions, { length: transactions.length, balances: frozen });
  return frozen;
}

/**
 * The balances of a log, memoized per array: the same array gives the same
 * (frozen) object, always equal to `accountBalances(transactions)`. A log built
 * by `appendTransaction` is already memoized; any other array (a fresh game, a
 * loaded save, a staged change that rewrote the log) is recomputed in full once.
 */
export function ledgerBalances(transactions: readonly LedgerTransaction[]): AccountBalances {
  const hit = memo.get(transactions);
  if (hit !== undefined && hit.length === transactions.length) return hit.balances;
  return remember(transactions, accountBalances(transactions));
}

/**
 * The log with `transaction` appended, as a new array whose balances are
 * memoized incrementally from the previous log's. This is how the coordinator
 * extends the ledger, so commit never recomputes the whole log.
 */
export function appendTransaction(
  transactions: readonly LedgerTransaction[],
  transaction: LedgerTransaction,
): readonly LedgerTransaction[] {
  const next = [...transactions, transaction];
  remember(next, withEntries(ledgerBalances(transactions), transaction.entries));
  return next;
}

export function cashBalance(state: GameState): Money {
  return ledgerBalances(state.ledger.transactions).CASH;
}

export interface BalanceSheet {
  readonly assets: Money;
  readonly liabilities: Money;
  /** Contributed equity (OWNER_EQUITY), excluding current profit. */
  readonly equity: Money;
  readonly revenue: Money;
  readonly expenses: Money;
  /** Revenue − expenses since the start (no period closing yet). */
  readonly netIncome: Money;
  /** Assets − liabilities (FIN-001). */
  readonly netWorth: Money;
}

function sumOfType(balances: AccountBalances, type: (typeof LEDGER_ACCOUNTS)[LedgerAccount]): Money {
  let total = ZERO_MONEY;
  for (const a of ACCOUNTS) if (LEDGER_ACCOUNTS[a] === type) total = addMoney(total, balances[a]);
  return total;
}

export function balanceSheet(state: GameState): BalanceSheet {
  return balanceSheetOfBalances(ledgerBalances(state.ledger.transactions));
}

export function balanceSheetOfBalances(balances: AccountBalances): BalanceSheet {
  const assets = sumOfType(balances, "asset");
  const liabilities = sumOfType(balances, "liability");
  const revenue = sumOfType(balances, "revenue");
  const expenses = sumOfType(balances, "expense");
  return {
    assets,
    liabilities,
    equity: sumOfType(balances, "equity"),
    revenue,
    expenses,
    netIncome: subtractMoney(revenue, expenses),
    netWorth: subtractMoney(assets, liabilities),
  };
}
