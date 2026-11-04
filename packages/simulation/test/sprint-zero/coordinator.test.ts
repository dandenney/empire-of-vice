// The S0 coordinator stub against the TransactionCoordinator contract (ADR 0010).

import {
  cents,
  idempotencyKey,
  InvariantViolationError,
  tick,
  type GameState,
  type TransactionDraft,
  type TransactionRequest,
} from "@eov/contracts";
import { CORN, DISTILLERY_MAIN, FIRST_SHIPMENT_SCENARIO, GAME_DATA } from "@eov/game-data";
import { describe, expect, it } from "vitest";
import { createCoordinator, createInitialState } from "../../src/game/index.ts";
import { eventsEmittedBetween, hashState } from "../../src/index.ts";
import { balances } from "./helpers.ts";

const coordinator = createCoordinator();
const start: GameState = createInitialState(FIRST_SHIPMENT_SCENARIO, GAME_DATA);

const request = (key: string): TransactionRequest => ({ kind: "MATERIAL_PURCHASE", idempotencyKey: key, tick: tick(5), causedBy: null });

function draft(state: GameState, key: string): TransactionDraft {
  const tx = coordinator.begin(state, request(key));
  if (tx.status === "duplicate") throw new Error("unexpected duplicate");
  return tx;
}

/** A balanced purchase of 10 corn at $1, staged on `tx`. */
function stagePurchase(tx: TransactionDraft, amount = cents(1_000)): void {
  tx.update((s) => ({
    ...s,
    materialPools: [{ facilityId: DISTILLERY_MAIN, materialId: CORN, quantity: 10, totalCost: amount }],
  }));
  tx.post([
    { account: "RAW_MATERIALS", side: "DEBIT", amount },
    { account: "CASH", side: "CREDIT", amount },
  ]);
}

describe("S0 coordinator stub", () => {
  it("books the opening balance through the coordinator", () => {
    const [opening] = start.ledger.transactions;
    expect(opening).toMatchObject({ id: "txn-1", kind: "OPENING_BALANCE", tick: 0, idempotencyKey: "OPENING_BALANCE:first-shipment" });
    expect(start.counters.nextId.Transaction).toBe(2);
  });

  it("commits staged changes, ledger entries, and events together", () => {
    const tx = draft(start, "MATERIAL_PURCHASE:test-1");
    stagePurchase(tx);
    const eventId = tx.emit({
      type: "MATERIALS_PURCHASED",
      supplierId: GAME_DATA.suppliers[0]!.id,
      materialId: CORN,
      quantity: 10,
      unitPrice: cents(100),
      total: cents(1_000),
      facilityId: DISTILLERY_MAIN,
      transactionId: tx.transactionId,
    });
    expect(tx.validate()).toEqual([]);
    const result = tx.commit();
    if (result.status !== "committed") throw new Error("expected commit");
    expect(result.transactionId).toBe("txn-2");
    expect(result.eventIds).toEqual([eventId]);
    const txn = result.state.ledger.transactions.at(-1)!;
    expect(txn).toMatchObject({ id: "txn-2", tick: 5, eventIds: [eventId], idempotencyKey: "MATERIAL_PURCHASE:test-1" });
    // Events reach the journal the way the kernel expects (minted with emitEvents).
    const emitted = eventsEmittedBetween(start, result.state);
    expect(emitted.map((e) => e.id)).toEqual([eventId]);
    expect(emitted[0]).toMatchObject({ tick: 5, causedBy: null, transactionId: "txn-2" });
    expect(balances(result.state).CASH).toBe(FIRST_SHIPMENT_SCENARIO.openingBalance.cash - 1_000);
    expect(() => tx.commit()).toThrow();
  });

  it("treats a repeated idempotency key as a duplicate", () => {
    const tx = draft(start, "MATERIAL_PURCHASE:test-1");
    stagePurchase(tx);
    const result = tx.commit();
    if (result.status !== "committed") throw new Error("expected commit");
    expect(coordinator.begin(result.state, request("MATERIAL_PURCHASE:test-1"))).toEqual({ status: "duplicate", transactionId: "txn-2" });
    expect(coordinator.begin(start, request(idempotencyKey("OPENING_BALANCE", "first-shipment")))).toEqual({
      status: "duplicate",
      transactionId: "txn-1",
    });
  });

  it("rejects with a typed reason and ignores later staging", () => {
    const before = hashState(start);
    const tx = draft(start, "MATERIAL_PURCHASE:test-2");
    tx.reject({ code: "INSUFFICIENT_FUNDS", required: cents(5), available: cents(0) });
    stagePurchase(tx);
    tx.emit({ type: "MARKET_UPDATED", dayIndex: 0 });
    expect(tx.status).toBe("rejected");
    expect(tx.commit()).toEqual({ status: "rejected", reason: { code: "INSUFFICIENT_FUNDS", required: 5, available: 0 } });
    expect(hashState(start)).toBe(before);
  });

  it.each([
    [
      "an unbalanced transaction",
      (tx: TransactionDraft) => tx.post([{ account: "CASH", side: "DEBIT", amount: cents(1) }, { account: "OWNER_EQUITY", side: "CREDIT", amount: cents(2) }]),
      "LEDGER_UNBALANCED",
    ],
    ["a single-entry transaction", (tx: TransactionDraft) => tx.post([{ account: "CASH", side: "DEBIT", amount: cents(0) }]), "LEDGER_SINGLE_ENTRY"],
    ["negative cash", (tx: TransactionDraft) => stagePurchase(tx, cents(FIRST_SHIPMENT_SCENARIO.openingBalance.cash + 1)), "NEGATIVE_CASH"],
    [
      "ledger that doesn't match inventory",
      (tx: TransactionDraft) =>
        tx.post([
          { account: "RAW_MATERIALS", side: "DEBIT", amount: cents(1) },
          { account: "CASH", side: "CREDIT", amount: cents(1) },
        ]),
      "LEDGER_INVENTORY_MISMATCH",
    ],
  ])("throws InvariantViolationError for %s and leaves state untouched", (_name, stage, code) => {
    const before = hashState(start);
    const tx = draft(start, "MATERIAL_PURCHASE:bad");
    stage(tx);
    expect(tx.validate().map((v) => v.code)).toContain(code);
    let error: unknown;
    try {
      tx.commit();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(InvariantViolationError);
    expect((error as InvariantViolationError).violations.map((v) => v.code)).toContain(code);
    expect(hashState(start)).toBe(before);
  });
});
