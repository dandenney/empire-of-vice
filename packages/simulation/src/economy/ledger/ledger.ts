// S0 stub: extended by T02b (FIN-001 ledger and reports).
//
// The ledger is the transaction log in `state.ledger` (ADR 0008). Balances and
// the balance sheet are derived from it on demand, never stored, so they can't
// drift. Only the coordinator appends to the log.

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

export function cashBalance(state: GameState): Money {
  return accountBalances(state.ledger.transactions).CASH;
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
  const balances = accountBalances(state.ledger.transactions);
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
