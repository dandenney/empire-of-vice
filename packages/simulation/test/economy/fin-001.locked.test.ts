// @locked
// FIN-001 acceptance tests for T02b (issue #6): the double-entry ledger, the
// transaction coordinator with property-tested invariants, the standard posting
// builders, finance reports that reconcile with the raw entries, the cash flow
// attribution rule (ADR 0015) and incremental (memoized) balances.
//
// Written ahead of the implementation. Do not edit (CLAUDE.md rule 9).
//
// Re-locked for ADR 0022 decision 7 (issue #197): production's conversion cost is
// paid when the job starts. `PRODUCTION_START:<jobId>` posts Dr PRODUCTION_IN_PROGRESS
// (a new asset) / Cr CASH; completion and failure credit PRODUCTION_IN_PROGRESS with the
// job's `conversionPrepaid` and move no cash. A job migrated from a pre-M002 save
// (`conversionPrepaid: null`) still settles under the old pay-at-settlement rule, so
// `productionEntries` and `productionWriteOffEntries` remain for that path.
// `BalanceSheet.assets` gains `productionInProgress`, and `PRODUCTION_START`'s cash-flow
// kind default is WAGES (ADR 0015). New invariant, checked by `expectLedgerSound`: the
// PRODUCTION_IN_PROGRESS balance equals the sum of `conversionPrepaid` over running jobs.
//
// Imports are limited to `src/economy/ledger/index.ts`, `src/economy/coordinator/index.ts`
// and the public package entry `src/index.ts` (the `Simulation` and its finance
// projection), plus contracts and game-data.
//
// API these tests assume (names the issue doesn't fix are chosen here):
//
// src/economy/ledger/index.ts (existing, unchanged): `accountBalances(transactions)` (full
//   recompute), `balanceSheet(state)`, `entryTotals(entries)`.
// src/economy/ledger/index.ts (new):
//   - `ledgerBalances(transactions: readonly LedgerTransaction[]): AccountBalances`
//     The memoized, incremental balances (WeakMap keyed by the transactions array,
//     extended by each appended transaction). Returns the same object for the same
//     array, and always equals `accountBalances(transactions)`.
//   - Posting builders from `postings.ts`. Each is pure, returns `readonly LedgerEntry[]`,
//     omits zero-amount lines (an all-zero posting returns []), and never returns a
//     single entry. Entry order is free (tests compare sorted).
//       materialPurchaseEntries(cost)                         Dr RAW_MATERIALS / Cr CASH
//       productionStartEntries(conversion)                    Dr PRODUCTION_IN_PROGRESS / Cr CASH
//           (ADR 0022 decision 7: a job's conversion cost, paid at START_PRODUCTION)
//       prepaidProductionEntries({ materials, prepaid })
//           Dr FINISHED_GOODS materials+prepaid / Cr RAW_MATERIALS materials /
//           Cr PRODUCTION_IN_PROGRESS prepaid (no cash)
//       prepaidProductionWriteOffEntries({ materials, prepaid })
//           as prepaidProductionEntries, but the debit goes to LOSSES (a failed run)
//       productionEntries({ materials, conversion, cashAvailable })
//           A migrated job (`conversionPrepaid: null`), settling under the old rule:
//           Dr FINISHED_GOODS materials+conversion / Cr RAW_MATERIALS materials /
//           Cr CASH min(conversion, cashAvailable) / Cr WAGES_PAYABLE the rest
//       productionWriteOffEntries({ materials, conversion, cashAvailable })
//           as productionEntries, but the debit goes to LOSSES (a failed migrated run)
//       dispatchEntries(cost)                                 Dr GOODS_IN_TRANSIT / Cr FINISHED_GOODS
//       returnFromTransitEntries(cost)                        Dr FINISHED_GOODS / Cr GOODS_IN_TRANSIT
//       saleEntries({ revenue, costOfGoodsSold })             Dr CASH / Cr SALES_REVENUE, Dr COST_OF_GOODS_SOLD / Cr GOODS_IN_TRANSIT
//       equipmentPurchaseEntries(cost)                        Dr EQUIPMENT / Cr CASH
//       cargoLossEntries(cost)                                Dr LOSSES / Cr GOODS_IN_TRANSIT
//       impairmentEntries(amount, account: "EQUIPMENT" | "VEHICLES")   Dr LOSSES / Cr account
//       payDownEntries(amount, payable: "WAGES_PAYABLE" | "PENALTIES_PAYABLE")  Dr payable / Cr CASH
//       payOrAccrueEntries({ amount, expense, payable, cashAvailable })
//           Dr expense amount / Cr CASH min(amount, cashAvailable) / Cr payable the rest
// src/economy/coordinator/index.ts (existing): `createCoordinator()`, `checkInvariants(state, transaction)`.
// src/index.ts (existing): `newGame`, `createInitialState`, `hashState`, `projectFinance(state)`,
//   `cashFlowStatement(openingCash, transactions)`, `allocateRemovalCost`.
//
// Cash flow attribution (ADR 0015): a transaction's net cash movement goes to the
// category of its non-cash accounts when every non-cash account maps to the same
// category; otherwise (including any unmapped non-cash account) to the kind's default.

import {
  addMoney,
  cents,
  idempotencyKey,
  InvariantViolationError,
  LEDGER_ACCOUNTS,
  subtractMoney,
  tick,
  TICKS_PER_DAY,
  ZERO_MONEY,
  type CashFlowCategory,
  type FacilityId,
  type FinanceSnapshot,
  type GameCommand,
  type GameState,
  type InvariantViolation,
  type LedgerAccount,
  type LedgerEntry,
  type LedgerTransaction,
  type Money,
  type ProductionJobId,
  type ProductionJobState,
  type ReservationId,
  type TransactionDraft,
  type TransactionId,
  type TransactionKind,
} from "@eov/contracts";
import {
  BASIC_MOONSHINE_RECIPE,
  CORN,
  CROSSROADS_ROADHOUSE,
  DISTILLERY_MAIN,
  FIRST_SHIPMENT_SCENARIO,
  GAME_DATA,
  MILLERS_FEED,
  MODEL_TT_TRUCK,
  MOONSHINE,
  SUGAR,
} from "@eov/game-data";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { checkInvariants, createCoordinator } from "../../src/economy/coordinator/index.ts";
import {
  accountBalances,
  balanceSheet,
  cargoLossEntries,
  dispatchEntries,
  entryTotals,
  equipmentPurchaseEntries,
  impairmentEntries,
  ledgerBalances,
  materialPurchaseEntries,
  payDownEntries,
  payOrAccrueEntries,
  prepaidProductionEntries,
  prepaidProductionWriteOffEntries,
  productionEntries,
  productionStartEntries,
  productionWriteOffEntries,
  returnFromTransitEntries,
  saleEntries,
} from "../../src/economy/ledger/index.ts";
import { allocateRemovalCost, cashFlowStatement, createInitialState, hashState, newGame, projectFinance } from "../../src/index.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const coordinator = createCoordinator();
const ACCOUNTS = Object.keys(LEDGER_ACCOUNTS) as LedgerAccount[];

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as object)) deepFreeze(v);
  }
  return value;
}

const start: GameState = deepFreeze(createInitialState(FIRST_SHIPMENT_SCENARIO, GAME_DATA));

const dr = (account: LedgerAccount, amount: number): LedgerEntry => ({ account, side: "DEBIT", amount: cents(amount) });
const cr = (account: LedgerAccount, amount: number): LedgerEntry => ({ account, side: "CREDIT", amount: cents(amount) });

function sorted(entries: readonly LedgerEntry[]): LedgerEntry[] {
  const key = (e: LedgerEntry) => `${e.side}/${e.account}/${String(e.amount).padStart(20, "0")}`;
  return [...entries].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

function expectEntries(actual: readonly LedgerEntry[], expected: readonly LedgerEntry[]): void {
  expect(sorted(actual)).toEqual(sorted(expected));
}

/** Change in assets − liabilities that `entries` cause. */
function netWorthDelta(entries: readonly LedgerEntry[]): number {
  let delta = 0;
  for (const e of entries) {
    const type = LEDGER_ACCOUNTS[e.account];
    if (type === "asset") delta += e.side === "DEBIT" ? e.amount : -e.amount;
    if (type === "liability") delta -= e.side === "CREDIT" ? e.amount : -e.amount;
  }
  return delta;
}

/** A well-formed posting: empty, or ≥ 2 positive integer lines that balance. */
function expectWellFormed(entries: readonly LedgerEntry[]): void {
  expect(entries.length).not.toBe(1);
  for (const e of entries) {
    expect(Number.isSafeInteger(e.amount)).toBe(true);
    expect(e.amount).toBeGreaterThan(0);
  }
  const { debits, credits } = entryTotals(entries);
  expect(debits).toBe(credits);
}

function draft(state: GameState, kind: TransactionKind, key: string, at = 1): TransactionDraft {
  const tx = coordinator.begin(state, { kind, idempotencyKey: key, tick: tick(at), causedBy: null });
  if (tx.status === "duplicate") throw new Error(`unexpected duplicate ${key}`);
  return tx;
}

function commitOk(tx: TransactionDraft): GameState {
  expect(tx.validate()).toEqual([]);
  const result = tx.commit();
  if (result.status !== "committed") throw new Error(`expected commit, got ${JSON.stringify(result)}`);
  return deepFreeze(result.state);
}

/** Commits `entries` (and optional staged changes) as one transaction. */
function commitEntries(
  state: GameState,
  kind: TransactionKind,
  key: string,
  entries: readonly LedgerEntry[],
  change?: (s: GameState) => GameState,
): GameState {
  const tx = draft(state, kind, key);
  if (change) tx.update(change);
  tx.post(entries);
  return commitOk(tx);
}

const fullBalances = (state: GameState) => accountBalances(state.ledger.transactions);

/** ADR 0022 decision 7: what running jobs have prepaid (a migrated job's null counts as 0). */
const prepaidByJobs = (state: GameState): number => state.productionJobs.reduce((n, j) => n + (j.conversionPrepaid ?? 0), 0);

/**
 * Every committed transaction is empty or ≥ 2 positive lines that balance; keys are unique; the latest passes every invariant;
 * the PRODUCTION_IN_PROGRESS balance equals the sum of `conversionPrepaid` over running jobs (ADR 0022 decision 7).
 */
function expectLedgerSound(state: GameState): void {
  const keys = new Set<string>();
  for (const t of state.ledger.transactions) {
    expect(keys.has(t.idempotencyKey), `duplicate key ${t.idempotencyKey}`).toBe(false);
    keys.add(t.idempotencyKey);
    expect(t.entries.length, `${t.id} (${t.kind})`).not.toBe(1);
    for (const e of t.entries) expect(e.amount, `${t.id} ${e.account}`).toBeGreaterThan(0);
    const { debits, credits } = entryTotals(t.entries);
    expect(debits, `${t.id} (${t.kind})`).toBe(credits);
  }
  const last = state.ledger.transactions.at(-1);
  if (last) expect(checkInvariants(state, last)).toEqual([]);
  const sheet = balanceSheet(state);
  expect(sheet.assets).toBe(sheet.liabilities + sheet.equity + sheet.netIncome);
  expect(sheet.netWorth).toBe(sheet.assets - sheet.liabilities);
  expect(fullBalances(state).CASH).toBeGreaterThanOrEqual(0);
  expect(fullBalances(state).PRODUCTION_IN_PROGRESS).toBe(prepaidByJobs(state));
}

function expectThrowsInvariant(tx: TransactionDraft, code: InvariantViolation["code"]): InvariantViolationError {
  expect(tx.validate().map((v) => v.code)).toContain(code);
  let error: unknown;
  try {
    tx.commit();
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(InvariantViolationError);
  const violation = error as InvariantViolationError;
  expect(violation.violations.map((v) => v.code)).toContain(code);
  return violation;
}

// ---------------------------------------------------------------------------
// Reference reports (independent of the implementation)
// ---------------------------------------------------------------------------

/** ADR 0015: categories of non-cash accounts. Accounts not listed have no category. */
const ACCOUNT_CATEGORY: Partial<Record<LedgerAccount, CashFlowCategory>> = {
  WAGES_EXPENSE: "WAGES",
  WAGES_PAYABLE: "WAGES",
  OVERHEAD_EXPENSE: "OVERHEAD",
  PENALTY_EXPENSE: "PENALTIES",
  PENALTIES_PAYABLE: "PENALTIES",
  TRANSPORT_EXPENSE: "TRANSPORT",
  SALES_REVENUE: "SALES",
  RAW_MATERIALS: "MATERIALS",
  EQUIPMENT: "EQUIPMENT",
  VEHICLES: "EQUIPMENT",
  FACILITIES: "EQUIPMENT",
  GAIN_ON_ASSET_SALE: "ASSET_SALES",
};

/** Kind defaults on main (projection/finance.ts CASH_FLOW_CATEGORY) for the kinds these tests generate with cash. */
const KIND_DEFAULT: Partial<Record<TransactionKind, CashFlowCategory>> = {
  MATERIAL_PURCHASE: "MATERIALS",
  PRODUCTION: "WAGES",
  PRODUCTION_START: "WAGES",
  EQUIPMENT_PURCHASE: "EQUIPMENT",
  DISPATCH: "TRANSPORT",
  SALE: "SALES",
  DAILY_SETTLEMENT: "WAGES",
  INSTALLMENT_SETTLEMENT: "SALES",
  ASSET_SALE: "ASSET_SALES",
};
const CASH_KINDS = Object.keys(KIND_DEFAULT) as TransactionKind[];

const netCash = (entries: readonly LedgerEntry[]): number =>
  entries.reduce((n, e) => (e.account !== "CASH" ? n : e.side === "DEBIT" ? n + e.amount : n - e.amount), 0);

function referenceCategory(t: LedgerTransaction): CashFlowCategory {
  const categories = new Set(t.entries.filter((e) => e.account !== "CASH").map((e) => ACCOUNT_CATEGORY[e.account] ?? null));
  if (categories.size === 1) {
    const [only] = categories;
    if (only) return only;
  }
  const fallback = KIND_DEFAULT[t.kind];
  if (!fallback) throw new Error(`test has no kind default for ${t.kind}`);
  return fallback;
}

/** Normal-side balance of `account` over `transactions`. */
function balanceOf(transactions: readonly LedgerTransaction[], account: LedgerAccount): number {
  const debitNormal = LEDGER_ACCOUNTS[account] === "asset" || LEDGER_ACCOUNTS[account] === "expense";
  let total = 0;
  for (const t of transactions) {
    for (const e of t.entries) {
      if (e.account !== account) continue;
      total += (e.side === "DEBIT") === debitNormal ? e.amount : -e.amount;
    }
  }
  return total;
}

const EXPENSE_ACCOUNT = {
  WAGES: "WAGES_EXPENSE",
  OVERHEAD: "OVERHEAD_EXPENSE",
  TRANSPORT: "TRANSPORT_EXPENSE",
  PENALTIES: "PENALTY_EXPENSE",
  LOSSES: "LOSSES",
} as const;

/** The finance projection reconciles with the raw entries of `state`'s ledger. */
function expectFinanceReconciles(state: GameState, finance: FinanceSnapshot, checkLines = true): void {
  const all = state.ledger.transactions;
  const sheet = finance.balanceSheet;
  const b = (a: LedgerAccount) => balanceOf(all, a);
  expect(sheet.assets).toEqual({
    cash: b("CASH"),
    rawMaterials: b("RAW_MATERIALS"),
    finishedGoods: b("FINISHED_GOODS"),
    goodsInTransit: b("GOODS_IN_TRANSIT"),
    productionInProgress: b("PRODUCTION_IN_PROGRESS"),
    receivables: b("RECEIVABLES"),
    equipment: b("EQUIPMENT"),
    vehicles: b("VEHICLES"),
    facilities: b("FACILITIES"),
  });
  expect(sheet.liabilities).toEqual({ wagesPayable: b("WAGES_PAYABLE"), penaltiesPayable: b("PENALTIES_PAYABLE") });
  const totalAssets = ACCOUNTS.filter((a) => LEDGER_ACCOUNTS[a] === "asset").reduce((n, a) => n + b(a), 0);
  const totalLiabilities = ACCOUNTS.filter((a) => LEDGER_ACCOUNTS[a] === "liability").reduce((n, a) => n + b(a), 0);
  expect(sheet.totalAssets).toBe(totalAssets);
  expect(sheet.totalLiabilities).toBe(totalLiabilities);
  expect(sheet.equity).toBe(totalAssets - totalLiabilities);
  expect(finance.netWorth).toBe(totalAssets - totalLiabilities);
  expect(finance.cash).toBe(b("CASH"));
  expect(fullBalances(state)).toEqual(Object.fromEntries(ACCOUNTS.map((a) => [a, b(a)])));

  const periods = [
    { report: finance.today, closed: false },
    { report: finance.toDate, closed: false },
    ...(finance.previousDay ? [{ report: finance.previousDay, closed: true }] : []),
  ];
  for (const { report, closed } of periods) {
    const inside = all.filter((t) => t.tick > report.fromTick && (!closed || t.tick <= report.toTick));
    const before = all.filter((t) => t.tick <= report.fromTick);
    const p = report.profit;
    const revenue = balanceOf(inside, "SALES_REVENUE");
    const cogs = balanceOf(inside, "COST_OF_GOODS_SOLD");
    const gains = balanceOf(inside, "GAIN_ON_ASSET_SALE");
    const expenses = Object.values(EXPENSE_ACCOUNT).reduce((n, a) => n + balanceOf(inside, a), 0);
    expect(p.revenue).toBe(revenue);
    expect(p.costOfGoodsSold).toBe(cogs);
    expect(p.grossProfit).toBe(revenue - cogs);
    expect(p.gains).toBe(gains);
    for (const line of p.expenses) expect(line.amount, line.category).toBe(balanceOf(inside, EXPENSE_ACCOUNT[line.category]));
    expect(p.netProfit).toBe(revenue - cogs - expenses + gains);

    const cf = report.cashFlow;
    const moved = inside.reduce((n, t) => n + netCash(t.entries), 0);
    expect(cf.openingCash).toBe(balanceOf(before, "CASH"));
    expect(cf.netChange).toBe(moved);
    expect(cf.closingCash).toBe(cf.openingCash + cf.netChange);
    expect(cf.lines.reduce((n, l) => n + l.amount, 0)).toBe(cf.netChange);
    if (checkLines) {
      const expected = new Map<CashFlowCategory, number>();
      for (const t of inside) {
        const c = netCash(t.entries);
        if (c === 0) continue;
        const category = referenceCategory(t);
        expected.set(category, (expected.get(category) ?? 0) + c);
      }
      for (const line of cf.lines) expect(line.amount, line.category).toBe(expected.get(line.category) ?? 0);
    }
  }
}

// ---------------------------------------------------------------------------
// Fixture operations for the coordinator property
// ---------------------------------------------------------------------------

const TEST_FACILITY = "facility-invariant-test" as FacilityId;

function setMaterialPool(s: GameState, materialId: typeof CORN, quantity: number, totalCost: Money): GameState {
  const others = s.materialPools.filter((p) => !(p.facilityId === DISTILLERY_MAIN && p.materialId === materialId));
  const pools = quantity === 0 ? others : [...others, { facilityId: DISTILLERY_MAIN, materialId, quantity, totalCost }];
  return { ...s, materialPools: pools };
}

function setProductPool(s: GameState, quantity: number, totalCost: Money): GameState {
  const others = s.productPools.filter((p) => !(p.facilityId === DISTILLERY_MAIN && p.productId === MOONSHINE && p.quality === "basic"));
  const pools = quantity === 0 ? others : [...others, { facilityId: DISTILLERY_MAIN, productId: MOONSHINE, quality: "basic" as const, quantity, totalCost }];
  return { ...s, productPools: pools };
}

const materialPool = (s: GameState, materialId: typeof CORN) =>
  s.materialPools.find((p) => p.facilityId === DISTILLERY_MAIN && p.materialId === materialId) ?? { quantity: 0, totalCost: ZERO_MONEY };
const productPool = (s: GameState) =>
  s.productPools.find((p) => p.facilityId === DISTILLERY_MAIN && p.productId === MOONSHINE && p.quality === "basic") ?? {
    quantity: 0,
    totalCost: ZERO_MONEY,
  };

type ValidOp =
  | { readonly k: "buy"; readonly sugar: boolean; readonly qty: number; readonly unit: number }
  | { readonly k: "writeOff"; readonly sugar: boolean; readonly qty: number }
  | { readonly k: "produce"; readonly qty: number; readonly conversion: number }
  | { readonly k: "start"; readonly conversion: number }
  | { readonly k: "settle"; readonly qty: number; readonly fail: boolean }
  | { readonly k: "sell"; readonly qty: number; readonly unit: number }
  | { readonly k: "expense"; readonly amount: number; readonly penalty: boolean }
  | { readonly k: "payDown"; readonly amount: number; readonly penalty: boolean }
  | { readonly k: "equipment"; readonly amount: number }
  | { readonly k: "impair"; readonly amount: number; readonly vehicles: boolean }
  | { readonly k: "reputation"; readonly value: number }
  | { readonly k: "empty" }
  | { readonly k: "reject" }
  | { readonly k: "abandon" }
  | { readonly k: "replay"; readonly index: number }
  | { readonly k: "fork"; readonly back: number };

const amountArb = fc.integer({ min: 1, max: 50_000 });
const validOpArb: fc.Arbitrary<ValidOp> = fc.oneof(
  fc.record({ k: fc.constant("buy" as const), sugar: fc.boolean(), qty: fc.integer({ min: 1, max: 40 }), unit: fc.integer({ min: 1, max: 900 }) }),
  fc.record({ k: fc.constant("writeOff" as const), sugar: fc.boolean(), qty: fc.integer({ min: 1, max: 40 }) }),
  fc.record({ k: fc.constant("produce" as const), qty: fc.integer({ min: 1, max: 40 }), conversion: fc.integer({ min: 0, max: 20_000 }) }),
  fc.record({ k: fc.constant("start" as const), conversion: fc.integer({ min: 0, max: 20_000 }) }),
  fc.record({ k: fc.constant("settle" as const), qty: fc.integer({ min: 0, max: 40 }), fail: fc.boolean() }),
  fc.record({ k: fc.constant("sell" as const), qty: fc.integer({ min: 1, max: 40 }), unit: fc.integer({ min: 0, max: 5_000 }) }),
  fc.record({ k: fc.constant("expense" as const), amount: amountArb, penalty: fc.boolean() }),
  fc.record({ k: fc.constant("payDown" as const), amount: amountArb, penalty: fc.boolean() }),
  fc.record({ k: fc.constant("equipment" as const), amount: amountArb }),
  fc.record({ k: fc.constant("impair" as const), amount: amountArb, vehicles: fc.boolean() }),
  fc.record({ k: fc.constant("reputation" as const), value: fc.integer({ min: 0, max: 100 }) }),
  fc.constant({ k: "empty" as const }),
  fc.constant({ k: "reject" as const }),
  fc.constant({ k: "abandon" as const }),
  fc.record({ k: fc.constant("replay" as const), index: fc.nat() }),
  fc.record({ k: fc.constant("fork" as const), back: fc.nat() }),
);

const min = (a: number, b: number) => (a < b ? a : b);

interface Run {
  state: GameState;
  history: GameState[];
  n: number;
}

/** Applies one valid operation through the coordinator; checks it commits cleanly (or changes nothing). */
function applyValid(run: Run, op: ValidOp): void {
  const s = run.state;
  const bal = fullBalances(s);
  const cash = bal.CASH;
  const key = (kind: TransactionKind) => idempotencyKey(kind, "prop", run.n++);
  const hashBefore = hashState(s);
  let next: GameState = s;

  switch (op.k) {
    case "buy": {
      const material = op.sugar ? SUGAR : CORN;
      const cost = min(op.qty * op.unit, cash);
      if (cost === 0) break;
      const pool = materialPool(s, material);
      next = commitEntries(s, "MATERIAL_PURCHASE", key("MATERIAL_PURCHASE"), [dr("RAW_MATERIALS", cost), cr("CASH", cost)], (x) =>
        setMaterialPool(x, material, pool.quantity + op.qty, addMoney(pool.totalCost, cents(cost))),
      );
      break;
    }
    case "writeOff": {
      const material = op.sugar ? SUGAR : CORN;
      const pool = materialPool(s, material);
      const qty = min(op.qty, pool.quantity);
      if (qty === 0) break;
      const cost = allocateRemovalCost(pool.totalCost, pool.quantity, qty);
      const change = (x: GameState) => setMaterialPool(x, material, pool.quantity - qty, subtractMoney(pool.totalCost, cost));
      if (cost === 0) {
        const tx = draft(s, "PRODUCTION_WRITE_OFF", key("PRODUCTION_WRITE_OFF"));
        tx.update(change);
        next = commitOk(tx);
      } else {
        next = commitEntries(s, "PRODUCTION_WRITE_OFF", key("PRODUCTION_WRITE_OFF"), [dr("LOSSES", cost), cr("RAW_MATERIALS", cost)], change);
      }
      break;
    }
    case "produce": {
      // A migrated job (`conversionPrepaid: null`) settling under the old rule: cash first, then WAGES_PAYABLE.
      const pool = materialPool(s, CORN);
      const qty = min(op.qty, pool.quantity);
      if (qty === 0) break;
      const materials = allocateRemovalCost(pool.totalCost, pool.quantity, qty);
      const paid = min(op.conversion, cash);
      const accrued = op.conversion - paid;
      const basis = materials + op.conversion;
      const product = productPool(s);
      const entries = [
        ...(basis > 0 ? [dr("FINISHED_GOODS", basis)] : []),
        ...(materials > 0 ? [cr("RAW_MATERIALS", materials)] : []),
        ...(paid > 0 ? [cr("CASH", paid)] : []),
        ...(accrued > 0 ? [cr("WAGES_PAYABLE", accrued)] : []),
      ];
      next = commitEntries(s, "PRODUCTION", key("PRODUCTION"), entries, (x) =>
        setProductPool(setMaterialPool(x, CORN, pool.quantity - qty, subtractMoney(pool.totalCost, materials)), product.quantity + qty, addMoney(product.totalCost, cents(basis))),
      );
      break;
    }
    case "start": {
      // ADR 0022 decision 7: PRODUCTION_START pays the conversion cost into PRODUCTION_IN_PROGRESS,
      // and the job records what it prepaid. A zero cost posts no entries.
      const prepaid = min(op.conversion, cash);
      const k = key("PRODUCTION_START");
      const job: ProductionJobState = {
        id: `job-prop-${run.n}` as ProductionJobId,
        facilityId: DISTILLERY_MAIN,
        recipeId: BASIC_MOONSHINE_RECIPE,
        quantity: 1,
        startedAt: tick(1),
        completesAt: tick(2),
        reservationIds: [],
        conversionPrepaid: cents(prepaid),
      };
      const entries = prepaid > 0 ? [dr("PRODUCTION_IN_PROGRESS", prepaid), cr("CASH", prepaid)] : [];
      next = commitEntries(s, "PRODUCTION_START", k, entries, (x) => ({ ...x, productionJobs: [...x.productionJobs, job] }));
      expect(fullBalances(next).CASH).toBe(cash - prepaid);
      break;
    }
    case "settle": {
      // Completion or failure of a prepaid job: PRODUCTION_IN_PROGRESS is credited with exactly
      // `conversionPrepaid`, and no cash moves.
      const job = s.productionJobs.find((j) => j.conversionPrepaid !== null);
      if (!job) break;
      const prepaid = job.conversionPrepaid ?? 0;
      const pool = materialPool(s, CORN);
      const qty = min(op.qty, pool.quantity);
      const materials = qty === 0 ? 0 : allocateRemovalCost(pool.totalCost, pool.quantity, qty);
      const basis = materials + prepaid;
      const kind = op.fail ? "PRODUCTION_WRITE_OFF" : "PRODUCTION";
      const entries = [
        ...(basis > 0 ? [dr(op.fail ? "LOSSES" : "FINISHED_GOODS", basis)] : []),
        ...(materials > 0 ? [cr("RAW_MATERIALS", materials)] : []),
        ...(prepaid > 0 ? [cr("PRODUCTION_IN_PROGRESS", prepaid)] : []),
      ];
      const product = productPool(s);
      next = commitEntries(s, kind, key(kind), entries, (x) => {
        let y: GameState = { ...x, productionJobs: x.productionJobs.filter((j) => j.id !== job.id) };
        if (qty > 0) y = setMaterialPool(y, CORN, pool.quantity - qty, subtractMoney(pool.totalCost, cents(materials)));
        if (!op.fail) y = setProductPool(y, product.quantity + job.quantity, addMoney(product.totalCost, cents(basis)));
        return y;
      });
      expect(fullBalances(next).CASH).toBe(cash);
      break;
    }
    case "sell": {
      const product = productPool(s);
      const qty = min(op.qty, product.quantity);
      if (qty === 0) break;
      const cogs = allocateRemovalCost(product.totalCost, product.quantity, qty);
      const revenue = qty * op.unit;
      const entries = [
        ...(revenue > 0 ? [dr("CASH", revenue), cr("SALES_REVENUE", revenue)] : []),
        ...(cogs > 0 ? [dr("COST_OF_GOODS_SOLD", cogs), cr("FINISHED_GOODS", cogs)] : []),
      ];
      next = commitEntries(s, "SALE", key("SALE"), entries, (x) => setProductPool(x, product.quantity - qty, subtractMoney(product.totalCost, cogs)));
      break;
    }
    case "expense": {
      const paid = min(op.amount, cash);
      const accrued = op.amount - paid;
      const [expense, payable] = op.penalty ? (["PENALTY_EXPENSE", "PENALTIES_PAYABLE"] as const) : (["WAGES_EXPENSE", "WAGES_PAYABLE"] as const);
      const entries = [dr(expense, op.amount), ...(paid > 0 ? [cr("CASH", paid)] : []), ...(accrued > 0 ? [cr(payable, accrued)] : [])];
      next = commitEntries(s, "DAILY_SETTLEMENT", key("DAILY_SETTLEMENT"), entries);
      break;
    }
    case "payDown": {
      const payable = op.penalty ? "PENALTIES_PAYABLE" : "WAGES_PAYABLE";
      const amount = min(min(op.amount, bal[payable]), cash);
      if (amount === 0) break;
      next = commitEntries(s, "DAILY_SETTLEMENT", key("DAILY_SETTLEMENT"), [dr(payable, amount), cr("CASH", amount)]);
      break;
    }
    case "equipment": {
      const amount = min(op.amount, cash);
      if (amount === 0) break;
      next = commitEntries(s, "EQUIPMENT_PURCHASE", key("EQUIPMENT_PURCHASE"), [dr("EQUIPMENT", amount), cr("CASH", amount)]);
      break;
    }
    case "impair": {
      const account = op.vehicles ? "VEHICLES" : "EQUIPMENT";
      const amount = min(op.amount, bal[account]);
      if (amount === 0) break;
      next = commitEntries(s, "CARGO_LOSS", key("CARGO_LOSS"), [dr("LOSSES", amount), cr(account, amount)]);
      break;
    }
    case "reputation": {
      const tx = draft(s, "RESERVATION", key("RESERVATION"));
      tx.update((x) => ({ ...x, family: { ...x.family, reputation: op.value } }));
      next = commitOk(tx);
      break;
    }
    case "empty": {
      const tx = draft(s, "VEHICLE_RETURN", key("VEHICLE_RETURN"));
      const eventId = tx.emit({ type: "MARKET_UPDATED", dayIndex: 0 });
      next = commitOk(tx);
      expect(next.ledger.transactions.at(-1)).toMatchObject({ entries: [], eventIds: [eventId] });
      break;
    }
    case "reject": {
      const tx = draft(s, "MATERIAL_PURCHASE", key("MATERIAL_PURCHASE"));
      tx.update((x) => setMaterialPool(x, CORN, materialPool(x, CORN).quantity + 1, addMoney(materialPool(x, CORN).totalCost, cents(1))));
      tx.post([dr("RAW_MATERIALS", 1), cr("CASH", 1)]);
      tx.reject({ code: "INSUFFICIENT_FUNDS", required: cents(1), available: cents(0) });
      tx.post([dr("CASH", 5), cr("OWNER_EQUITY", 9)]);
      expect(tx.status).toBe("rejected");
      expect(tx.commit()).toEqual({ status: "rejected", reason: { code: "INSUFFICIENT_FUNDS", required: 1, available: 0 } });
      break;
    }
    case "abandon": {
      const tx = draft(s, "MATERIAL_PURCHASE", key("MATERIAL_PURCHASE"));
      tx.update((x) => setMaterialPool(x, CORN, 3, cents(3)));
      tx.post([dr("RAW_MATERIALS", 3), cr("CASH", 3)]);
      break; // never committed
    }
    case "replay": {
      const txs = s.ledger.transactions;
      const t = txs[op.index % txs.length]!;
      expect(coordinator.begin(s, { kind: t.kind, idempotencyKey: t.idempotencyKey, tick: tick(1), causedBy: null })).toEqual({
        status: "duplicate",
        transactionId: t.id,
      });
      break;
    }
    case "fork": {
      // Continue from an earlier state: the memoized balances of a sibling branch must not leak.
      next = run.history[run.history.length - 1 - (op.back % run.history.length)]!;
      break;
    }
  }

  expect(hashState(s)).toBe(hashBefore);
  if (next !== s && op.k !== "fork") {
    expect(next.ledger.transactions.length).toBe(s.ledger.transactions.length + 1);
    expect(next.counters.nextId.Transaction).toBe(s.counters.nextId.Transaction + 1);
    run.history.push(next);
  }
  run.state = next;
  expectLedgerSound(run.state);
  expect(ledgerBalances(run.state.ledger.transactions)).toEqual(fullBalances(run.state));
  expect(ledgerBalances(s.ledger.transactions)).toEqual(fullBalances(s));
}

// Invalid stagings: one for every InvariantViolation code (inventory mismatch for each inventory account).
type InvalidStaging = { readonly code: InvariantViolation["code"]; readonly account?: LedgerAccount; readonly stage: (tx: TransactionDraft) => void };

const INVALID_STAGINGS: readonly InvalidStaging[] = [
  { code: "LEDGER_UNBALANCED", stage: (tx) => tx.post([dr("CASH", 1), cr("OWNER_EQUITY", 2)]) },
  { code: "LEDGER_SINGLE_ENTRY", stage: (tx) => tx.post([dr("CASH", 1)]) },
  { code: "NEGATIVE_ENTRY_AMOUNT", stage: (tx) => tx.post([dr("CASH", 0), cr("OWNER_EQUITY", 0)]) },
  { code: "NEGATIVE_ENTRY_AMOUNT", stage: (tx) => tx.post([dr("CASH", -5), cr("OWNER_EQUITY", -5)]) },
  {
    code: "NEGATIVE_CASH",
    stage: (tx) => {
      const over = fullBalances(tx.state).CASH + 1;
      tx.post([dr("OVERHEAD_EXPENSE", over), cr("CASH", over)]);
    },
  },
  {
    code: "NEGATIVE_QUANTITY",
    stage: (tx) =>
      tx.update((s) => ({
        ...s,
        suppliers: s.suppliers.map((sup, i) => (i === 0 ? { ...sup, stock: sup.stock.map((st, j) => (j === 0 ? { ...st, available: -1 } : st)) } : sup)),
      })),
  },
  {
    code: "NEGATIVE_AMOUNT",
    stage: (tx) => tx.update((s) => ({ ...s, buyers: s.buyers.map((b, i) => (i === 0 ? { ...b, budgetRemaining: cents(-1) } : b)) })),
  },
  {
    code: "COST_WITHOUT_QUANTITY",
    stage: (tx) => {
      tx.update((s) => ({ ...s, materialPools: [...s.materialPools, { facilityId: TEST_FACILITY, materialId: CORN, quantity: 0, totalCost: cents(100) }] }));
      tx.post([dr("RAW_MATERIALS", 100), cr("OWNER_EQUITY", 100)]);
    },
  },
  {
    code: "OVER_RESERVED",
    stage: (tx) =>
      tx.update((s) => ({
        ...s,
        reservations: [
          ...s.reservations,
          {
            id: "reservation-9999" as ReservationId,
            facilityId: TEST_FACILITY,
            goods: { kind: "MATERIAL", materialId: CORN },
            quantity: 1,
            holder: { kind: "PRODUCTION_JOB", jobId: "job-9999" as never },
          },
        ],
      })),
  },
  { code: "LEDGER_INVENTORY_MISMATCH", account: "RAW_MATERIALS", stage: (tx) => tx.post([dr("RAW_MATERIALS", 1), cr("OWNER_EQUITY", 1)]) },
  { code: "LEDGER_INVENTORY_MISMATCH", account: "FINISHED_GOODS", stage: (tx) => tx.post([dr("FINISHED_GOODS", 1), cr("OWNER_EQUITY", 1)]) },
  { code: "LEDGER_INVENTORY_MISMATCH", account: "GOODS_IN_TRANSIT", stage: (tx) => tx.post([dr("GOODS_IN_TRANSIT", 1), cr("OWNER_EQUITY", 1)]) },
  {
    // A staged change that corrupts the log itself (an unbalanced transaction slipped in).
    code: "BALANCE_SHEET_MISMATCH",
    stage: (tx) =>
      tx.update((s) => ({
        ...s,
        ledger: {
          ...s.ledger,
          transactions: [
            ...s.ledger.transactions,
            { id: "txn-999999" as TransactionId, tick: tick(1), kind: "TRANSFER", idempotencyKey: "TRANSFER:corrupt", entries: [dr("EQUIPMENT", 7)], eventIds: [] },
          ],
        },
      })),
  },
  { code: "REPUTATION_OUT_OF_RANGE", stage: (tx) => tx.update((s) => ({ ...s, family: { ...s.family, reputation: 101 } })) },
  { code: "REPUTATION_OUT_OF_RANGE", stage: (tx) => tx.update((s) => ({ ...s, family: { ...s.family, reputation: -1 } })) },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FIN-001 coordinator: randomized operation sequences over fixtures", () => {
  // @locked
  it("valid operation sequences never throw and keep every invariant, with incremental balances equal to a full recompute", () => {
    fc.assert(
      fc.property(fc.array(validOpArb, { minLength: 1, maxLength: 30 }), (ops) => {
        const run: Run = { state: start, history: [start], n: 0 };
        for (const op of ops) applyValid(run, op);
      }),
      { numRuns: 150 },
    );
  });

  // @locked
  it("each kind of invalid staging throws InvariantViolationError after any valid prefix and leaves the state untouched", () => {
    fc.assert(
      fc.property(fc.array(validOpArb, { maxLength: 15 }), fc.integer({ min: 0, max: INVALID_STAGINGS.length - 1 }), (ops, which) => {
        const run: Run = { state: start, history: [start], n: 0 };
        for (const op of ops) applyValid(run, op);
        const base = run.state;
        const hash = hashState(base);
        const copy = structuredClone(base);
        const bad = INVALID_STAGINGS[which]!;
        const tx = draft(base, "TRANSFER", idempotencyKey("TRANSFER", "invalid", which));
        bad.stage(tx);
        const error = expectThrowsInvariant(tx, bad.code);
        if (bad.account) {
          expect(error.violations).toContainEqual(expect.objectContaining({ code: "LEDGER_INVENTORY_MISMATCH", account: bad.account }));
        }
        expect(hashState(base)).toBe(hash);
        expect(base).toEqual(copy);
        expect(ledgerBalances(base.ledger.transactions)).toEqual(fullBalances(base));
        // The coordinator still works on the untouched state.
        expect(coordinator.begin(base, { kind: "TRANSFER", idempotencyKey: idempotencyKey("TRANSFER", "invalid", which), tick: tick(1), causedBy: null }).status).toBe(
          "staging",
        );
      }),
      { numRuns: 150 },
    );
  });

  // @locked
  it.each(INVALID_STAGINGS.map((s, i) => [`${s.code}${s.account ? ` (${s.account})` : ""} #${i}`, s] as const))(
    "throws for %s on the opening state",
    (_name, bad) => {
      const hash = hashState(start);
      const tx = draft(start, "TRANSFER", "TRANSFER:invalid-opening");
      bad.stage(tx);
      expectThrowsInvariant(tx, bad.code);
      expect(hashState(start)).toBe(hash);
      expect(() => tx.commit()).toThrow();
    },
  );
});

describe("FIN-001 coordinator: atomicity, cash and net worth", () => {
  // @locked
  it("a rejected transaction leaves the state hash unchanged and mints nothing", () => {
    const hash = hashState(start);
    const tx = draft(start, "MATERIAL_PURCHASE", "MATERIAL_PURCHASE:rejected");
    tx.update((s) => setMaterialPool(s, CORN, 10, cents(1_000)));
    tx.post(materialPurchaseEntries(cents(1_000)));
    tx.emit({ type: "MARKET_UPDATED", dayIndex: 0 });
    tx.reject({ code: "INSUFFICIENT_FUNDS", required: cents(1_000), available: cents(0) });
    expect(tx.commit()).toEqual({ status: "rejected", reason: { code: "INSUFFICIENT_FUNDS", required: 1_000, available: 0 } });
    expect(hashState(start)).toBe(hash);
    // The key was never recorded, so the operation can be retried.
    expect(coordinator.begin(start, { kind: "MATERIAL_PURCHASE", idempotencyKey: "MATERIAL_PURCHASE:rejected", tick: tick(1), causedBy: null }).status).toBe("staging");
  });

  // @locked
  it("an abandoned draft leaves the state hash and balances unchanged", () => {
    const hash = hashState(start);
    const before = fullBalances(start);
    const tx = draft(start, "MATERIAL_PURCHASE", "MATERIAL_PURCHASE:abandoned");
    tx.update((s) => setMaterialPool(s, CORN, 10, cents(1_000)));
    tx.post([dr("RAW_MATERIALS", 1_000), cr("CASH", 1_000)]);
    expect(tx.validate()).toEqual([]);
    expect(hashState(start)).toBe(hash);
    expect(ledgerBalances(start.ledger.transactions)).toEqual(before);
    expect(fullBalances(start)).toEqual(before);
  });

  // @locked
  it("two commits from the same base each get their own balances (memoization doesn't leak between branches)", () => {
    const a = commitEntries(start, "EQUIPMENT_PURCHASE", "EQUIPMENT_PURCHASE:a", equipmentPurchaseEntries(cents(100)));
    const b = commitEntries(start, "DAILY_SETTLEMENT", "DAILY_SETTLEMENT:b", [dr("OVERHEAD_EXPENSE", 250), cr("CASH", 250)]);
    expect(ledgerBalances(a.ledger.transactions)).toEqual(fullBalances(a));
    expect(ledgerBalances(b.ledger.transactions)).toEqual(fullBalances(b));
    expect(ledgerBalances(a.ledger.transactions).CASH).toBe(FIRST_SHIPMENT_SCENARIO.openingBalance.cash - 100);
    expect(ledgerBalances(b.ledger.transactions).CASH).toBe(FIRST_SHIPMENT_SCENARIO.openingBalance.cash - 250);
    expect(ledgerBalances(start.ledger.transactions).CASH).toBe(FIRST_SHIPMENT_SCENARIO.openingBalance.cash);
  });

  // @locked
  it("negative cash is an invariant violation, even by one cent", () => {
    const cash = fullBalances(start).CASH;
    const exact = commitEntries(start, "DAILY_SETTLEMENT", "DAILY_SETTLEMENT:all", [dr("OVERHEAD_EXPENSE", cash), cr("CASH", cash)]);
    expect(fullBalances(exact).CASH).toBe(0);
    const tx = draft(exact, "DAILY_SETTLEMENT", "DAILY_SETTLEMENT:over");
    tx.post([dr("OVERHEAD_EXPENSE", 1), cr("CASH", 1)]);
    const error = expectThrowsInvariant(tx, "NEGATIVE_CASH");
    expect(error.violations).toContainEqual({ code: "NEGATIVE_CASH", cash: -1 });
  });

  // @locked
  it("negative net worth is allowed: a state with liabilities greater than assets commits", () => {
    const cash = fullBalances(start).CASH;
    let s = commitEntries(
      start,
      "DAILY_SETTLEMENT",
      "DAILY_SETTLEMENT:spend",
      payOrAccrueEntries({ amount: cash, expense: "OVERHEAD_EXPENSE", payable: "WAGES_PAYABLE", cashAvailable: cash }),
    );
    const assets = balanceSheet(s).assets;
    const owed = cents(assets + 12_345);
    const entries = payOrAccrueEntries({ amount: owed, expense: "WAGES_EXPENSE", payable: "WAGES_PAYABLE", cashAvailable: ZERO_MONEY });
    expectEntries(entries, [dr("WAGES_EXPENSE", owed), cr("WAGES_PAYABLE", owed)]);
    s = commitEntries(s, "DAILY_SETTLEMENT", "DAILY_SETTLEMENT:accrue", entries);
    const sheet = balanceSheet(s);
    expect(sheet.liabilities).toBeGreaterThan(sheet.assets);
    expect(sheet.netWorth).toBe(-12_345);
    expect(fullBalances(s).CASH).toBe(0);
    expect(projectFinance(s).netWorth).toBe(-12_345);
    expectLedgerSound(s);
  });

  // @locked
  it("pay-or-accrue turns an unaffordable charge into a payable, never negative cash", () => {
    const cash = fullBalances(start).CASH;
    const charge = cents(cash + 7_500);
    const entries = payOrAccrueEntries({ amount: charge, expense: "PENALTY_EXPENSE", payable: "PENALTIES_PAYABLE", cashAvailable: cash });
    expectEntries(entries, [dr("PENALTY_EXPENSE", charge), cr("CASH", cash), cr("PENALTIES_PAYABLE", 7_500)]);
    const s = commitEntries(start, "INSTALLMENT_SETTLEMENT", "INSTALLMENT_SETTLEMENT:contract-1:1", entries);
    expect(fullBalances(s).CASH).toBe(0);
    expect(fullBalances(s).PENALTIES_PAYABLE).toBe(7_500);
    expect(balanceSheet(s).netWorth).toBe(balanceSheet(start).netWorth - charge);
  });
});

describe("FIN-001 posting builders", () => {
  // @locked
  it("material purchase: Dr RAW_MATERIALS / Cr CASH, net worth unchanged", () => {
    const e = materialPurchaseEntries(cents(52_000));
    expectEntries(e, [dr("RAW_MATERIALS", 52_000), cr("CASH", 52_000)]);
    expect(netWorthDelta(e)).toBe(0);
  });

  // @locked
  it("PRODUCTION_IN_PROGRESS is an asset account (ADR 0022 decision 7)", () => {
    expect(LEDGER_ACCOUNTS.PRODUCTION_IN_PROGRESS).toBe("asset");
    expect(fullBalances(start).PRODUCTION_IN_PROGRESS).toBe(0);
  });

  // @locked
  it("production start: Dr PRODUCTION_IN_PROGRESS / Cr CASH for the conversion cost, net worth unchanged; a zero cost posts nothing", () => {
    const e = productionStartEntries(cents(4_000));
    expectEntries(e, [dr("PRODUCTION_IN_PROGRESS", 4_000), cr("CASH", 4_000)]);
    expect(netWorthDelta(e)).toBe(0);
    for (const x of e) expect(["revenue", "expense"]).not.toContain(LEDGER_ACCOUNTS[x.account]);
    expect(productionStartEntries(ZERO_MONEY)).toEqual([]);
  });

  // @locked
  it("production (the FIN-001 example, prepaid): Dr FINISHED_GOODS $120 / Cr RAW_MATERIALS $80 / Cr PRODUCTION_IN_PROGRESS $40, no cash, no profit", () => {
    const done = prepaidProductionEntries({ materials: cents(8_000), prepaid: cents(4_000) });
    expectEntries(done, [dr("FINISHED_GOODS", 12_000), cr("RAW_MATERIALS", 8_000), cr("PRODUCTION_IN_PROGRESS", 4_000)]);
    expect(netWorthDelta(done)).toBe(0);
    expect(netCash(done)).toBe(0);
    for (const e of done) expect(["revenue", "expense"]).not.toContain(LEDGER_ACCOUNTS[e.account]);
    // Nothing prepaid (a zero-cost recipe): materials only.
    expectEntries(prepaidProductionEntries({ materials: cents(8_000), prepaid: ZERO_MONEY }), [dr("FINISHED_GOODS", 8_000), cr("RAW_MATERIALS", 8_000)]);
    // No materials (inputs that cost nothing): the prepaid amount only.
    expectEntries(prepaidProductionEntries({ materials: ZERO_MONEY, prepaid: cents(4_000) }), [dr("FINISHED_GOODS", 4_000), cr("PRODUCTION_IN_PROGRESS", 4_000)]);
    expect(prepaidProductionEntries({ materials: ZERO_MONEY, prepaid: ZERO_MONEY })).toEqual([]);
  });

  // @locked
  it("a prepaid failure: Dr LOSSES / Cr RAW_MATERIALS / Cr PRODUCTION_IN_PROGRESS, no cash (ADR 0017's write-off with the cash leg replaced)", () => {
    const failed = prepaidProductionWriteOffEntries({ materials: cents(8_000), prepaid: cents(4_000) });
    expectEntries(failed, [dr("LOSSES", 12_000), cr("RAW_MATERIALS", 8_000), cr("PRODUCTION_IN_PROGRESS", 4_000)]);
    expect(netWorthDelta(failed)).toBe(-12_000);
    expect(netCash(failed)).toBe(0);
    expectEntries(prepaidProductionWriteOffEntries({ materials: cents(8_000), prepaid: ZERO_MONEY }), [dr("LOSSES", 8_000), cr("RAW_MATERIALS", 8_000)]);
  });

  // @locked
  it("a migrated job (conversionPrepaid: null) settles under the old rule: Dr FINISHED_GOODS $120 / Cr RAW_MATERIALS $80 / Cr CASH $40", () => {
    const paid = productionEntries({ materials: cents(8_000), conversion: cents(4_000), cashAvailable: cents(100_000) });
    expectEntries(paid, [dr("FINISHED_GOODS", 12_000), cr("RAW_MATERIALS", 8_000), cr("CASH", 4_000)]);
    expect(netWorthDelta(paid)).toBe(0);
    for (const e of paid) expect(["revenue", "expense"]).not.toContain(LEDGER_ACCOUNTS[e.account]);
  });

  // @locked
  it("a migrated job with no cash accrues the $40 to WAGES_PAYABLE; with some cash it splits", () => {
    const accrued = productionEntries({ materials: cents(8_000), conversion: cents(4_000), cashAvailable: ZERO_MONEY });
    expectEntries(accrued, [dr("FINISHED_GOODS", 12_000), cr("RAW_MATERIALS", 8_000), cr("WAGES_PAYABLE", 4_000)]);
    const split = productionEntries({ materials: cents(8_000), conversion: cents(4_000), cashAvailable: cents(1_500) });
    expectEntries(split, [dr("FINISHED_GOODS", 12_000), cr("RAW_MATERIALS", 8_000), cr("CASH", 1_500), cr("WAGES_PAYABLE", 2_500)]);
    expect(netWorthDelta(accrued)).toBe(0);
    expect(netWorthDelta(split)).toBe(0);
  });

  // @locked
  it("production commits through the coordinator against real pools: cash moves at the start only, net worth never moves, no profit", () => {
    let s = commitEntries(start, "MATERIAL_PURCHASE", "MATERIAL_PURCHASE:corn", materialPurchaseEntries(cents(8_000)), (x) =>
      setMaterialPool(x, CORN, 10, cents(8_000)),
    );
    const netWorth = balanceSheet(s).netWorth;
    const cash = fullBalances(s).CASH;
    const job: ProductionJobState = {
      id: "job-1" as ProductionJobId,
      facilityId: DISTILLERY_MAIN,
      recipeId: BASIC_MOONSHINE_RECIPE,
      quantity: 10,
      startedAt: tick(1),
      completesAt: tick(2),
      reservationIds: [],
      conversionPrepaid: cents(4_000),
    };

    // Start: PRODUCTION_START:<jobId> pays the conversion cost into PRODUCTION_IN_PROGRESS.
    s = commitEntries(s, "PRODUCTION_START", idempotencyKey("PRODUCTION_START", job.id), productionStartEntries(cents(4_000)), (x) => ({
      ...x,
      productionJobs: [...x.productionJobs, job],
    }));
    expect(fullBalances(s).CASH).toBe(cash - 4_000);
    expect(fullBalances(s).PRODUCTION_IN_PROGRESS).toBe(4_000);
    expect(balanceSheet(s).netWorth).toBe(netWorth);
    expect(projectFinance(s).balanceSheet.assets.productionInProgress).toBe(4_000);
    expectLedgerSound(s);

    // Completion: PRODUCTION_IN_PROGRESS and RAW_MATERIALS become FINISHED_GOODS; cash doesn't move.
    s = commitEntries(
      s,
      "PRODUCTION",
      idempotencyKey("PRODUCTION", job.id),
      prepaidProductionEntries({ materials: cents(8_000), prepaid: cents(4_000) }),
      (x) => ({ ...setProductPool(setMaterialPool(x, CORN, 0, ZERO_MONEY), 10, cents(12_000)), productionJobs: x.productionJobs.filter((j) => j.id !== job.id) }),
    );
    expect(fullBalances(s).FINISHED_GOODS).toBe(12_000);
    expect(fullBalances(s).RAW_MATERIALS).toBe(0);
    expect(fullBalances(s).PRODUCTION_IN_PROGRESS).toBe(0);
    expect(fullBalances(s).CASH).toBe(cash - 4_000);
    expect(projectFinance(s).balanceSheet.assets.productionInProgress).toBe(0);
    expect(balanceSheet(s).netIncome).toBe(0);
    expect(balanceSheet(s).netWorth).toBe(netWorth);
    expectLedgerSound(s);
  });

  // @locked
  it("a migrated job (conversionPrepaid: null) commits its old-rule settlement through the coordinator and recognizes no profit", () => {
    let s = commitEntries(start, "MATERIAL_PURCHASE", "MATERIAL_PURCHASE:corn", materialPurchaseEntries(cents(8_000)), (x) =>
      setMaterialPool(x, CORN, 10, cents(8_000)),
    );
    const job: ProductionJobState = {
      id: "job-1" as ProductionJobId,
      facilityId: DISTILLERY_MAIN,
      recipeId: BASIC_MOONSHINE_RECIPE,
      quantity: 10,
      startedAt: tick(0),
      completesAt: tick(2),
      reservationIds: [],
      conversionPrepaid: null,
    };
    s = { ...s, productionJobs: [job] };
    // A migrated job prepaid nothing, so PRODUCTION_IN_PROGRESS holds nothing for it.
    expectLedgerSound(s);
    const netWorth = balanceSheet(s).netWorth;
    const cash = fullBalances(s).CASH;
    s = commitEntries(
      s,
      "PRODUCTION",
      idempotencyKey("PRODUCTION", job.id),
      productionEntries({ materials: cents(8_000), conversion: cents(4_000), cashAvailable: fullBalances(s).CASH }),
      (x) => ({ ...setProductPool(setMaterialPool(x, CORN, 0, ZERO_MONEY), 10, cents(12_000)), productionJobs: [] }),
    );
    expect(fullBalances(s).FINISHED_GOODS).toBe(12_000);
    expect(fullBalances(s).RAW_MATERIALS).toBe(0);
    expect(fullBalances(s).CASH).toBe(cash - 4_000);
    expect(fullBalances(s).PRODUCTION_IN_PROGRESS).toBe(0);
    expect(balanceSheet(s).netIncome).toBe(0);
    expect(balanceSheet(s).netWorth).toBe(netWorth);
    expectLedgerSound(s);
  });

  // @locked
  it("dispatch to transit and return from transit move cost between FINISHED_GOODS and GOODS_IN_TRANSIT, net worth unchanged", () => {
    const out = dispatchEntries(cents(36_400));
    expectEntries(out, [dr("GOODS_IN_TRANSIT", 36_400), cr("FINISHED_GOODS", 36_400)]);
    const back = returnFromTransitEntries(cents(36_400));
    expectEntries(back, [dr("FINISHED_GOODS", 36_400), cr("GOODS_IN_TRANSIT", 36_400)]);
    expect(netWorthDelta(out)).toBe(0);
    expect(netWorthDelta(back)).toBe(0);
  });

  // @locked
  it("sale with COGS (the FIN-001 weighted-average example: 15 cases at $20 from 50 costing $520)", () => {
    const cogs = allocateRemovalCost(cents(52_000), 50, 15);
    expect(cogs).toBe(15_600);
    const e = saleEntries({ revenue: cents(30_000), costOfGoodsSold: cogs });
    expectEntries(e, [dr("CASH", 30_000), cr("SALES_REVENUE", 30_000), dr("COST_OF_GOODS_SOLD", 15_600), cr("GOODS_IN_TRANSIT", 15_600)]);
    expect(netWorthDelta(e)).toBe(30_000 - 15_600);
  });

  // @locked
  it("equipment purchase: Dr EQUIPMENT / Cr CASH, net worth unchanged", () => {
    const e = equipmentPurchaseEntries(cents(25_000));
    expectEntries(e, [dr("EQUIPMENT", 25_000), cr("CASH", 25_000)]);
    expect(netWorthDelta(e)).toBe(0);
    const s = commitEntries(start, "EQUIPMENT_PURCHASE", "EQUIPMENT_PURCHASE:still-2", e);
    expect(balanceSheet(s).netWorth).toBe(balanceSheet(start).netWorth);
    expect(fullBalances(s).EQUIPMENT).toBe(fullBalances(start).EQUIPMENT + 25_000);
  });

  // @locked
  it("cargo loss and production write-off are recorded explicitly as LOSSES", () => {
    const loss = cargoLossEntries(cents(1_200));
    expectEntries(loss, [dr("LOSSES", 1_200), cr("GOODS_IN_TRANSIT", 1_200)]);
    expect(netWorthDelta(loss)).toBe(-1_200);

    const writeOff = productionWriteOffEntries({ materials: cents(8_000), conversion: cents(4_000), cashAvailable: cents(1_000) });
    expectEntries(writeOff, [dr("LOSSES", 12_000), cr("RAW_MATERIALS", 8_000), cr("CASH", 1_000), cr("WAGES_PAYABLE", 3_000)]);
    expect(netWorthDelta(writeOff)).toBe(-12_000);
    const materialsOnly = productionWriteOffEntries({ materials: cents(8_000), conversion: ZERO_MONEY, cashAvailable: cents(1_000) });
    expectEntries(materialsOnly, [dr("LOSSES", 8_000), cr("RAW_MATERIALS", 8_000)]);
  });

  // @locked
  it("impairment: Dr LOSSES / Cr EQUIPMENT or VEHICLES, and it commits", () => {
    expectEntries(impairmentEntries(cents(900), "EQUIPMENT"), [dr("LOSSES", 900), cr("EQUIPMENT", 900)]);
    expectEntries(impairmentEntries(cents(901), "VEHICLES"), [dr("LOSSES", 901), cr("VEHICLES", 901)]);
    const s = commitEntries(start, "CARGO_LOSS", "CARGO_LOSS:impair", impairmentEntries(cents(900), "EQUIPMENT"));
    expect(fullBalances(s).EQUIPMENT).toBe(fullBalances(start).EQUIPMENT - 900);
    expect(balanceSheet(s).netWorth).toBe(balanceSheet(start).netWorth - 900);
  });

  // @locked
  it("paying down a payable: Dr payable / Cr CASH, net worth unchanged", () => {
    expectEntries(payDownEntries(cents(2_500), "WAGES_PAYABLE"), [dr("WAGES_PAYABLE", 2_500), cr("CASH", 2_500)]);
    expectEntries(payDownEntries(cents(75), "PENALTIES_PAYABLE"), [dr("PENALTIES_PAYABLE", 75), cr("CASH", 75)]);
    expect(netWorthDelta(payDownEntries(cents(2_500), "WAGES_PAYABLE"))).toBe(0);
  });

  // @locked
  it("pay-or-accrue pays in cash where possible and accrues the rest", () => {
    const args = { expense: "WAGES_EXPENSE", payable: "WAGES_PAYABLE" } as const;
    expectEntries(payOrAccrueEntries({ ...args, amount: cents(3_000), cashAvailable: cents(10_000) }), [dr("WAGES_EXPENSE", 3_000), cr("CASH", 3_000)]);
    expectEntries(payOrAccrueEntries({ ...args, amount: cents(3_000), cashAvailable: cents(3_000) }), [dr("WAGES_EXPENSE", 3_000), cr("CASH", 3_000)]);
    expectEntries(payOrAccrueEntries({ ...args, amount: cents(3_000), cashAvailable: cents(1_000) }), [
      dr("WAGES_EXPENSE", 3_000),
      cr("CASH", 1_000),
      cr("WAGES_PAYABLE", 2_000),
    ]);
    expectEntries(payOrAccrueEntries({ ...args, amount: cents(3_000), cashAvailable: ZERO_MONEY }), [dr("WAGES_EXPENSE", 3_000), cr("WAGES_PAYABLE", 3_000)]);
    expect(payOrAccrueEntries({ ...args, amount: ZERO_MONEY, cashAvailable: cents(5) })).toEqual([]);
  });

  // @locked
  it("every builder returns a well-formed posting with the expected net worth effect, for any amounts", () => {
    const m = fc.integer({ min: 0, max: 10_000_000 }).map(cents);
    fc.assert(
      fc.property(m, m, m, m, (a, b, c, d) => {
        const cases: [readonly LedgerEntry[], number][] = [
          [materialPurchaseEntries(a), 0],
          [productionStartEntries(a), 0],
          [prepaidProductionEntries({ materials: a, prepaid: b }), 0],
          [prepaidProductionWriteOffEntries({ materials: a, prepaid: b }), 0 - (a + b)],
          [productionEntries({ materials: a, conversion: b, cashAvailable: c }), 0],
          [productionWriteOffEntries({ materials: a, conversion: b, cashAvailable: c }), 0 - (a + b)],
          [dispatchEntries(a), 0],
          [returnFromTransitEntries(a), 0],
          [saleEntries({ revenue: a, costOfGoodsSold: b }), a - b],
          [equipmentPurchaseEntries(a), 0],
          [cargoLossEntries(a), 0 - a],
          [impairmentEntries(a, "EQUIPMENT"), 0 - a],
          [impairmentEntries(a, "VEHICLES"), 0 - a],
          [payDownEntries(a, "WAGES_PAYABLE"), 0],
          [payOrAccrueEntries({ amount: d, expense: "OVERHEAD_EXPENSE", payable: "WAGES_PAYABLE", cashAvailable: c }), 0 - d],
        ];
        for (const [entries, delta] of cases) {
          expectWellFormed(entries);
          expect(netWorthDelta(entries)).toBe(delta);
        }
        // Decision 7: a start moves exactly the conversion cost out of cash; a prepaid settlement moves none.
        expect(netCash(productionStartEntries(a))).toBe(0 - a);
        expect(netCash(prepaidProductionEntries({ materials: a, prepaid: b }))).toBe(0);
        expect(netCash(prepaidProductionWriteOffEntries({ materials: a, prepaid: b }))).toBe(0);
        // Cash credited by the pay-or-accrue patterns never exceeds what's available.
        for (const entries of [
          productionEntries({ materials: a, conversion: b, cashAvailable: c }),
          payOrAccrueEntries({ amount: d, expense: "OVERHEAD_EXPENSE", payable: "WAGES_PAYABLE", cashAvailable: c }),
        ]) {
          expect(-netCash(entries)).toBeLessThanOrEqual(c);
          expect(-netCash(entries)).toBeGreaterThanOrEqual(0);
        }
      }),
      { numRuns: 300 },
    );
  });
});

// ---------------------------------------------------------------------------
// Reports over random ledgers
// ---------------------------------------------------------------------------

const balancedEntriesArb: fc.Arbitrary<LedgerEntry[]> = fc
  .record({
    debits: fc.array(fc.record({ account: fc.constantFrom(...ACCOUNTS), amount: fc.integer({ min: 1, max: 100_000 }) }), { minLength: 1, maxLength: 3 }),
    creditAccounts: fc.array(fc.constantFrom(...ACCOUNTS), { minLength: 1, maxLength: 3 }),
    cuts: fc.array(fc.nat(), { maxLength: 2 }),
  })
  .map(({ debits, creditAccounts, cuts }) => {
    const total = debits.reduce((n, d) => n + d.amount, 0);
    // Split the total into up to creditAccounts.length positive parts.
    const points = [...new Set(cuts.slice(0, creditAccounts.length - 1).map((c) => 1 + (c % total)))].filter((p) => p < total).sort((x, y) => x - y);
    const parts = [...points, total].map((p, i, arr) => p - (i === 0 ? 0 : arr[i - 1]!));
    return [...debits.map((d) => dr(d.account, d.amount)), ...parts.map((amount, i) => cr(creditAccounts[i % creditAccounts.length]!, amount))];
  });

/** A random ledger after the opening balance, ticks spread over a few days, chronological. */
const randomLedgerStateArb: fc.Arbitrary<GameState> = fc
  .integer({ min: 0, max: 4 * TICKS_PER_DAY })
  .chain((now) =>
    fc
      .array(fc.record({ at: fc.integer({ min: 1, max: now + 1 }), kind: fc.constantFrom(...CASH_KINDS), entries: balancedEntriesArb }), { maxLength: 25 })
      .map((raw) => {
        const opening = start.ledger.transactions;
        const txs: LedgerTransaction[] = [...raw]
          .sort((x, y) => x.at - y.at)
          .map((r, i) => ({
            id: `txn-${opening.length + i + 1}` as TransactionId,
            tick: tick(r.at),
            kind: r.kind,
            idempotencyKey: idempotencyKey(r.kind, "random", i),
            entries: r.entries,
            eventIds: [],
          }));
        return { ...start, tick: tick(now), ledger: { ...start.ledger, transactions: [...opening, ...txs] } };
      }),
  );

describe("FIN-001 reports reconcile with the raw entries", () => {
  // @locked
  it("balance sheet, net worth, period profit and cash flow reconcile for any ledger", () => {
    fc.assert(
      fc.property(randomLedgerStateArb, (state) => {
        expectFinanceReconciles(state, projectFinance(state));
        const sheet = balanceSheet(state);
        expect(sheet.assets).toBe(sheet.liabilities + sheet.equity + sheet.netIncome);
      }),
      { numRuns: 300 },
    );
  });

  // @locked
  it("incremental balances equal a full recompute after every appended transaction, and are memoized per array", () => {
    fc.assert(
      fc.property(randomLedgerStateArb, (state) => {
        let log: readonly LedgerTransaction[] = [];
        for (const t of state.ledger.transactions) {
          log = [...log, t];
          expect(ledgerBalances(log)).toEqual(accountBalances(log));
          expect(ledgerBalances(log)).toBe(ledgerBalances(log));
        }
        // A rebuilt array with the same content (not an extension of a memoized one) is still correct.
        const rebuilt = [...state.ledger.transactions];
        expect(ledgerBalances(rebuilt)).toEqual(accountBalances(rebuilt));
        expect(ledgerBalances([])).toEqual(accountBalances([]));
      }),
      { numRuns: 200 },
    );
  });
});

describe("FIN-001 cash flow attribution (ADR 0015)", () => {
  let n = 0;
  const txn = (kind: TransactionKind, entries: readonly LedgerEntry[]): LedgerTransaction => ({
    id: `txn-${++n + 100}` as TransactionId,
    tick: tick(10),
    kind,
    idempotencyKey: idempotencyKey(kind, "attribution", n),
    entries,
    eventIds: [],
  });
  const linesOf = (transactions: readonly LedgerTransaction[]) => {
    const cf = cashFlowStatement(cents(1_000_000), transactions);
    return Object.fromEntries(cf.lines.filter((l) => l.amount !== 0).map((l) => [l.category, l.amount]));
  };

  // @locked
  it("files cash under the category of the non-cash accounts when they all agree", () => {
    expect(linesOf([txn("DAILY_SETTLEMENT", [dr("OVERHEAD_EXPENSE", 500), cr("CASH", 500)])])).toEqual({ OVERHEAD: -500 });
    expect(linesOf([txn("DAILY_SETTLEMENT", [dr("WAGES_EXPENSE", 700), cr("CASH", 400), cr("WAGES_PAYABLE", 300)])])).toEqual({ WAGES: -400 });
    expect(linesOf([txn("DAILY_SETTLEMENT", [dr("WAGES_PAYABLE", 250), cr("CASH", 250)])])).toEqual({ WAGES: -250 });
    expect(linesOf([txn("DAILY_SETTLEMENT", [dr("PENALTIES_PAYABLE", 90), cr("CASH", 90)])])).toEqual({ PENALTIES: -90 });
    expect(linesOf([txn("INSTALLMENT_SETTLEMENT", [dr("PENALTY_EXPENSE", 300), cr("CASH", 100), cr("PENALTIES_PAYABLE", 200)])])).toEqual({ PENALTIES: -100 });
    expect(linesOf([txn("INSTALLMENT_SETTLEMENT", [dr("CASH", 4_000), cr("SALES_REVENUE", 4_000)])])).toEqual({ SALES: 4_000 });
    expect(linesOf([txn("DISPATCH", [dr("TRANSPORT_EXPENSE", 150), cr("CASH", 150)])])).toEqual({ TRANSPORT: -150 });
    expect(linesOf([txn("MATERIAL_PURCHASE", [dr("RAW_MATERIALS", 1_000), cr("CASH", 1_000)])])).toEqual({ MATERIALS: -1_000 });
    expect(linesOf([txn("EQUIPMENT_PURCHASE", [dr("VEHICLES", 2_000), cr("CASH", 2_000)])])).toEqual({ EQUIPMENT: -2_000 });
    expect(linesOf([txn("EQUIPMENT_PURCHASE", [dr("FACILITIES", 3_000), cr("CASH", 3_000)])])).toEqual({ EQUIPMENT: -3_000 });
    expect(linesOf([txn("ASSET_SALE", [dr("CASH", 600), cr("GAIN_ON_ASSET_SALE", 600)])])).toEqual({ ASSET_SALES: 600 });
  });

  // @locked
  it("falls back to the kind's default when the non-cash accounts disagree or include an unmapped account, with no split", () => {
    // Wages and overhead in one settlement: kind default (WAGES), whole amount, no rounding.
    expect(linesOf([txn("DAILY_SETTLEMENT", [dr("WAGES_EXPENSE", 333), dr("OVERHEAD_EXPENSE", 334), cr("CASH", 667)])])).toEqual({ WAGES: -667 });
    // Production's conversion cost, paid at the start (ADR 0022 decision 7), files under PRODUCTION_START's
    // kind default, WAGES (PRODUCTION_IN_PROGRESS has no category).
    expect(linesOf([txn("PRODUCTION_START", productionStartEntries(cents(4_000)))])).toEqual({ WAGES: -4_000 });
    // A prepaid completion or failure moves no cash, so it reports nothing.
    expect(linesOf([txn("PRODUCTION", prepaidProductionEntries({ materials: cents(8_000), prepaid: cents(4_000) }))])).toEqual({});
    expect(linesOf([txn("PRODUCTION_WRITE_OFF", prepaidProductionWriteOffEntries({ materials: cents(8_000), prepaid: cents(4_000) }))])).toEqual({});
    // A migrated job's capitalized conversion cost stays under WAGES (FINISHED_GOODS has no category).
    expect(linesOf([txn("PRODUCTION", productionEntries({ materials: cents(8_000), conversion: cents(4_000), cashAvailable: cents(10_000) }))])).toEqual({
      WAGES: -4_000,
    });
    expect(linesOf([txn("PRODUCTION", productionEntries({ materials: cents(8_000), conversion: cents(4_000), cashAvailable: cents(1_000) }))])).toEqual({
      WAGES: -1_000,
    });
    // A sale with COGS: SALES_REVENUE plus unmapped accounts → the kind default (SALES).
    expect(linesOf([txn("SALE", saleEntries({ revenue: cents(30_000), costOfGoodsSold: cents(15_600) }))])).toEqual({ SALES: 30_000 });
    // Selling equipment at a gain: EQUIPMENT and ASSET_SALES disagree → the kind default (ASSET_SALES).
    expect(linesOf([txn("ASSET_SALE", [dr("CASH", 1_500), cr("EQUIPMENT", 1_000), cr("GAIN_ON_ASSET_SALE", 500)])])).toEqual({ ASSET_SALES: 1_500 });
  });

  // @locked
  it("separate wage and overhead transactions are reported under their own categories", () => {
    const lines = linesOf([
      txn("DAILY_SETTLEMENT", payOrAccrueEntries({ amount: cents(1_200), expense: "WAGES_EXPENSE", payable: "WAGES_PAYABLE", cashAvailable: cents(1_000) })),
      txn("DAILY_SETTLEMENT", [dr("OVERHEAD_EXPENSE", 450), cr("CASH", 450)]),
      txn("DAILY_SETTLEMENT", [dr("WAGES_PAYABLE", 200), cr("CASH", 200)]),
    ]);
    expect(lines).toEqual({ WAGES: -1_200, OVERHEAD: -450 });
  });

  // @locked
  it("a transaction whose cash nets to zero reports nothing, and lines always sum to the net change", () => {
    const cf = cashFlowStatement(cents(5_000), [txn("TRANSFER", [dr("CASH", 100), cr("CASH", 100)]), txn("SALE", [dr("CASH", 10), cr("SALES_REVENUE", 10)])]);
    expect(cf.netChange).toBe(10);
    expect(cf.closingCash).toBe(5_010);
    expect(cf.lines.reduce((s, l) => s + l.amount, 0)).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("FIN-001 idempotency", () => {
  /** A sale operation as a flow would write it: begin, and on a duplicate do nothing. */
  function settleSale(state: GameState, deliveryId: string, revenue: Money, cogs: Money): GameState {
    const tx = coordinator.begin(state, { kind: "SALE", idempotencyKey: idempotencyKey("SALE", deliveryId), tick: tick(30), causedBy: null });
    if (tx.status === "duplicate") return state;
    tx.update((s) => ({
      ...s,
      deliveries: s.deliveries.map((d) => (d.id === deliveryId ? { ...d, status: "DELIVERED" as const } : d)),
    }));
    tx.post(saleEntries({ revenue, costOfGoodsSold: cogs }));
    return commitOk(tx);
  }

  // @locked
  it("replaying SALE:<deliveryId> books revenue once", () => {
    // Goods in transit on an outbound delivery, as a dispatch would leave them.
    const delivery = {
      id: "delivery-7" as never,
      vehicleId: MODEL_TT_TRUCK,
      fromFacilityId: DISTILLERY_MAIN,
      routeId: GAME_DATA.routes[0]!.id,
      cargo: [{ productId: MOONSHINE, quality: "basic" as const, quantity: 15, cost: cents(15_600) }],
      purpose: { kind: "SALE" as const, buyerId: CROSSROADS_ROADHOUSE, dealId: null },
      status: "OUTBOUND" as const,
      dealDeadline: null,
      driver: { kind: "FOUNDER" as const },
    };
    const loaded = commitEntries(start, "DISPATCH", "DISPATCH:delivery-7", [dr("GOODS_IN_TRANSIT", 15_600), cr("OWNER_EQUITY", 15_600)], (s) => ({
      ...s,
      deliveries: [...s.deliveries, delivery],
    }));
    const once = settleSale(loaded, "delivery-7", cents(30_000), cents(15_600));
    const hash = hashState(once);
    const twice = settleSale(once, "delivery-7", cents(30_000), cents(15_600));
    expect(twice).toBe(once);
    expect(hashState(twice)).toBe(hash);
    expect(fullBalances(twice).SALES_REVENUE).toBe(30_000);
    expect(twice.ledger.transactions.filter((t) => t.idempotencyKey === "SALE:delivery-7")).toHaveLength(1);
    const dup = coordinator.begin(once, { kind: "SALE", idempotencyKey: "SALE:delivery-7", tick: tick(99), causedBy: null });
    expect(dup).toEqual({ status: "duplicate", transactionId: once.ledger.transactions.at(-1)!.id });
    expectLedgerSound(twice);
  });
});

// ---------------------------------------------------------------------------
// The real Simulation: random S0 command and advance sequences
// ---------------------------------------------------------------------------

type SimStep =
  | { readonly k: "buy"; readonly sugar: boolean; readonly qty: number }
  | { readonly k: "produce"; readonly qty: number }
  | { readonly k: "sell"; readonly qty: number; readonly atQuote: boolean; readonly price: number }
  | { readonly k: "advance"; readonly ticks: number };

const simStepArb: fc.Arbitrary<SimStep> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ k: fc.constant("buy" as const), sugar: fc.boolean(), qty: fc.integer({ min: 0, max: 30 }) }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("produce" as const), qty: fc.integer({ min: 0, max: 6 }) }) },
  {
    weight: 2,
    arbitrary: fc.record({ k: fc.constant("sell" as const), qty: fc.integer({ min: 0, max: 4 }), atQuote: fc.boolean(), price: fc.integer({ min: 0, max: 10_000 }) }),
  },
  { weight: 3, arbitrary: fc.record({ k: fc.constant("advance" as const), ticks: fc.integer({ min: 1, max: 720 }) }) },
);

function simCommand(step: Exclude<SimStep, { k: "advance" | "sell" }>): GameCommand {
  switch (step.k) {
    case "buy":
      return { type: "PURCHASE_MATERIALS", supplierId: MILLERS_FEED, materialId: step.sugar ? SUGAR : CORN, quantity: step.qty, facilityId: DISTILLERY_MAIN };
    case "produce":
      return { type: "START_PRODUCTION", facilityId: DISTILLERY_MAIN, recipeId: BASIC_MOONSHINE_RECIPE, quantity: step.qty };
  }
}

/**
 * Dispatches one step. A sale is AGREE_DEAL at the step's price, then a deal dispatch
 * of the same cargo (ADR 0022 decision 6); a rejected agreement dispatches nothing.
 */
function dispatchStep(sim: ReturnType<typeof newGame>, step: Exclude<SimStep, { k: "advance" }>): void {
  if (step.k !== "sell") {
    sim.dispatch({ command: simCommand(step) });
    return;
  }
  const quote = sim.state.buyers.find((b) => b.id === CROSSROADS_ROADHOUSE)?.wants[0]?.unitPrice ?? cents(step.price);
  const agreed = sim.dispatch({
    command: {
      type: "AGREE_DEAL",
      buyerId: CROSSROADS_ROADHOUSE,
      productId: MOONSHINE,
      quality: "basic",
      quantity: step.qty,
      agreedUnitPrice: step.atQuote ? quote : cents(step.price),
    },
  });
  if (agreed.status !== "applied") return;
  sim.dispatch({
    command: {
      type: "DISPATCH_DELIVERY",
      vehicleId: MODEL_TT_TRUCK,
      cargo: [{ productId: MOONSHINE, quality: "basic", quantity: step.qty }],
      purpose: { kind: "SALE", buyerId: CROSSROADS_ROADHOUSE, dealId: sim.state.heldDeals.at(-1)!.id },
      routeId: null,
      driver: { kind: "FOUNDER" },
    },
  });
}

describe("FIN-001 invariants through the real Simulation", () => {
  // @locked
  it("random S0 command and advance sequences leave checkInvariants empty after every step", () => {
    fc.assert(
      fc.property(fc.array(simStepArb, { minLength: 1, maxLength: 25 }), (steps) => {
        const sim = newGame();
        expectLedgerSound(sim.state);
        for (const step of steps) {
          if (step.k === "advance") sim.advance(step.ticks);
          else dispatchStep(sim, step);
          const state = sim.state;
          expectLedgerSound(state);
          expect(ledgerBalances(state.ledger.transactions)).toEqual(fullBalances(state));
          expectFinanceReconciles(state, sim.snapshot().finance);
        }
      }),
      { numRuns: 100 },
    );
  });

  // @locked
  it("START_PRODUCTION pays the conversion cost at the start into PRODUCTION_IN_PROGRESS, which the snapshot reports until the job settles (ADR 0022 decision 7)", () => {
    const sim = newGame();
    const recipe = GAME_DATA.recipes.find((r) => r.id === BASIC_MOONSHINE_RECIPE)!;
    const Q = 2;
    for (const input of recipe.inputsPerCase) {
      sim.dispatch({ command: { type: "PURCHASE_MATERIALS", supplierId: MILLERS_FEED, materialId: input.materialId, quantity: input.quantity * Q, facilityId: DISTILLERY_MAIN } });
    }
    const conversion = (recipe.laborPerCase + recipe.overheadPerCase) * Q;
    expect(conversion).toBeGreaterThan(0);
    const cashBefore = fullBalances(sim.state).CASH;
    const worthBefore = balanceSheet(sim.state).netWorth;
    dispatchStep(sim, { k: "produce", qty: Q });
    const job = sim.state.productionJobs[0]!;
    expect(job.conversionPrepaid).toBe(conversion);
    const started = sim.state.ledger.transactions.filter((t) => t.idempotencyKey === idempotencyKey("PRODUCTION_START", job.id));
    expect(started).toHaveLength(1);
    expect(started[0]!.kind).toBe("PRODUCTION_START");
    expectEntries(started[0]!.entries, [dr("PRODUCTION_IN_PROGRESS", conversion), cr("CASH", conversion)]);
    expect(sim.state.ledger.transactions.filter((t) => t.idempotencyKey === idempotencyKey("RESERVATION", job.id))).toEqual([]);
    expect(fullBalances(sim.state).CASH).toBe(cashBefore - conversion);
    expect(balanceSheet(sim.state).netWorth).toBe(worthBefore);
    expect(sim.snapshot().finance.balanceSheet.assets.productionInProgress).toBe(conversion);
    expectLedgerSound(sim.state);
    expectFinanceReconciles(sim.state, sim.snapshot().finance);

    sim.advance(job.completesAt - sim.state.tick);
    expect(sim.state.productionJobs).toEqual([]);
    const settled = sim.state.ledger.transactions.find((t) => t.idempotencyKey === idempotencyKey("PRODUCTION", job.id))!;
    expect(netCash(settled.entries)).toBe(0);
    expect(settled.entries).toContainEqual(cr("PRODUCTION_IN_PROGRESS", conversion));
    expect(sim.snapshot().finance.balanceSheet.assets.productionInProgress).toBe(0);
    expectLedgerSound(sim.state);
    expectFinanceReconciles(sim.state, sim.snapshot().finance);
  });

  // @locked
  it("a completed sale's idempotency key is recorded, so replaying it is a duplicate and revenue is booked once", () => {
    const sim = newGame();
    const recipe = GAME_DATA.recipes.find((r) => r.id === BASIC_MOONSHINE_RECIPE)!;
    for (const input of recipe.inputsPerCase) {
      sim.dispatch({ command: { type: "PURCHASE_MATERIALS", supplierId: MILLERS_FEED, materialId: input.materialId, quantity: input.quantity, facilityId: DISTILLERY_MAIN } });
    }
    dispatchStep(sim, { k: "produce", qty: 1 });
    sim.advance(recipe.ticksPerCase + 1);
    dispatchStep(sim, { k: "sell", qty: 1, atQuote: true, price: 0 });
    sim.advance(3 * TICKS_PER_DAY);
    const sales = sim.state.ledger.transactions.filter((t) => t.kind === "SALE");
    expect(sales).toHaveLength(1);
    const sale = sales[0]!;
    expect(sale.idempotencyKey).toBe("SALE:delivery-1");
    const revenue = fullBalances(sim.state).SALES_REVENUE;
    expect(revenue).toBeGreaterThan(0);
    expect(coordinator.begin(sim.state, { kind: "SALE", idempotencyKey: sale.idempotencyKey, tick: sim.state.tick, causedBy: null })).toEqual({
      status: "duplicate",
      transactionId: sale.id,
    });
    expectLedgerSound(sim.state);
  });
});
