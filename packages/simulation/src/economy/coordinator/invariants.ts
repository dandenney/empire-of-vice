// ADR 0010 invariants, FIN-001 accounting acceptance (T02b, issue #6).
//
// Checked against the staged state, with the new transaction already appended.
// Balances come from `ledgerBalances`, memoized per log array outside state
// (decision 2). The coordinator builds the staged log with `appendTransaction`,
// so on commit they're the previous log's balances plus this transaction's
// entries: no recompute of the whole log. A staged change that replaced the log
// itself misses the memo and is recomputed in full, which is what catches a
// corrupted log (BALANCE_SHEET_MISMATCH).

import {
  addMoney,
  isMoney,
  ZERO_MONEY,
  type GameState,
  type InvariantViolation,
  type LedgerTransaction,
  type Money,
} from "@eov/contracts";
import { inventoryValue } from "../../inventory/pools.ts";
import { balanceSheetOfBalances, entryTotals, ledgerBalances } from "../ledger/ledger.ts";

export function checkInvariants(state: GameState, transaction: LedgerTransaction): readonly InvariantViolation[] {
  const violations: InvariantViolation[] = [];

  // The transaction itself: no entries, or at least two, all positive, balanced.
  if (transaction.entries.length === 1) violations.push({ code: "LEDGER_SINGLE_ENTRY" });
  for (const e of transaction.entries) {
    if (!isMoney(e.amount) || e.amount <= 0) violations.push({ code: "NEGATIVE_ENTRY_AMOUNT", account: e.account });
  }
  const { debits, credits } = entryTotals(transaction.entries);
  if (debits !== credits) violations.push({ code: "LEDGER_UNBALANCED", debits, credits });

  const balances = ledgerBalances(state.ledger.transactions);
  if (balances.CASH < 0) violations.push({ code: "NEGATIVE_CASH", cash: balances.CASH });

  // Quantities and amounts that can't go below zero.
  const quantity = (where: string, value: number): void => {
    if (value < 0) violations.push({ code: "NEGATIVE_QUANTITY", where, value });
  };
  const amount = (where: string, value: Money): void => {
    if (value < 0) violations.push({ code: "NEGATIVE_AMOUNT", where, value });
  };
  for (const p of state.productPools) {
    const where = `productPools[${p.facilityId}/${p.productId}/${p.quality}]`;
    quantity(where, p.quantity);
    amount(where, p.totalCost);
    if (p.quantity === 0 && p.totalCost !== 0) violations.push({ code: "COST_WITHOUT_QUANTITY", where, cost: p.totalCost });
  }
  for (const p of state.materialPools) {
    const where = `materialPools[${p.facilityId}/${p.materialId}]`;
    quantity(where, p.quantity);
    amount(where, p.totalCost);
    if (p.quantity === 0 && p.totalCost !== 0) violations.push({ code: "COST_WITHOUT_QUANTITY", where, cost: p.totalCost });
  }
  for (const s of state.suppliers) for (const st of s.stock) quantity(`suppliers[${s.id}/${st.materialId}].available`, st.available);
  for (const b of state.buyers) {
    amount(`buyers[${b.id}].budgetRemaining`, b.budgetRemaining);
    for (const w of b.wants) quantity(`buyers[${b.id}/${w.productId}].demandRemaining`, w.demandRemaining);
  }

  // Nothing reserved beyond what its pool holds.
  const reserved = new Map<string, number>();
  for (const r of state.reservations) {
    const key = r.goods.kind === "PRODUCT" ? `P/${r.facilityId}/${r.goods.productId}/${r.goods.quality}` : `M/${r.facilityId}/${r.goods.materialId}`;
    reserved.set(key, (reserved.get(key) ?? 0) + r.quantity);
  }
  for (const [key, total] of reserved) {
    const [kind, facilityId, goodsId, quality] = key.split("/");
    const pool =
      kind === "P"
        ? state.productPools.find((p) => p.facilityId === facilityId && p.productId === goodsId && p.quality === quality)
        : state.materialPools.find((p) => p.facilityId === facilityId && p.materialId === goodsId);
    const available = pool?.quantity ?? 0;
    if (total > available) violations.push({ code: "OVER_RESERVED", where: key, reserved: total, available });
  }

  // Inventory accounts match the inventory they represent.
  // Goods in transit: outbound cargo, plus a FAILED delivery's cargo while a
  // vehicle's trip still carries it home (a sale that fell through, ADR 0019
  // decision 4; the return unloads it and empties the delivery's cargo).
  const onTrips = new Set(state.vehicles.map((v) => v.trip?.deliveryId));
  let inTransit = ZERO_MONEY;
  for (const d of state.deliveries) {
    if (d.status !== "OUTBOUND" && !(d.status === "FAILED" && onTrips.has(d.id))) continue;
    for (const line of d.cargo) inTransit = addMoney(inTransit, line.cost);
  }
  const inventoryChecks = [
    ["RAW_MATERIALS", inventoryValue(state.materialPools)],
    ["FINISHED_GOODS", inventoryValue(state.productPools)],
    ["GOODS_IN_TRANSIT", inTransit],
  ] as const;
  for (const [account, inventory] of inventoryChecks) {
    if (balances[account] !== inventory) violations.push({ code: "LEDGER_INVENTORY_MISMATCH", account, ledger: balances[account], inventory });
  }

  // Assets = liabilities + equity (including profit to date).
  const sheet = balanceSheetOfBalances(balances);
  const liabilitiesAndEquity = addMoney(addMoney(sheet.liabilities, sheet.equity), sheet.netIncome);
  if (sheet.assets !== liabilitiesAndEquity) {
    violations.push({ code: "BALANCE_SHEET_MISMATCH", assets: sheet.assets, liabilitiesAndEquity });
  }

  const reputation = state.family.reputation;
  if (!Number.isSafeInteger(reputation) || reputation < 0 || reputation > 100) {
    violations.push({ code: "REPUTATION_OUT_OF_RANGE", reputation });
  }

  return violations;
}
