import { describe, expect, expectTypeOf, it } from "vitest";
import { asId, idempotencyKey, InvariantViolationError, type GameEventInput } from "../src/index.ts";

describe("idempotencyKey", () => {
  it("builds keys from domain identity", () => {
    expect(idempotencyKey("SALE", asId("Delivery", "delivery-3"))).toBe("SALE:delivery-3");
    expect(idempotencyKey("INSTALLMENT_SETTLEMENT", asId("Contract", "contract-2"), 1)).toBe(
      "INSTALLMENT_SETTLEMENT:contract-2:1",
    );
    expect(idempotencyKey("DAILY_SETTLEMENT", 4)).toBe("DAILY_SETTLEMENT:4");
  });

  it("rejects keys that could collide or carry nothing", () => {
    expect(() => idempotencyKey("SALE")).toThrow(TypeError);
    expect(() => idempotencyKey("SALE", "")).toThrow(TypeError);
    expect(() => idempotencyKey("SALE", "a:b")).toThrow(TypeError);
    expect(() => idempotencyKey("DAILY_SETTLEMENT", 1.5)).toThrow(TypeError);
  });
});

describe("coordinator types", () => {
  it("GameEventInput strips the metadata the coordinator fills in, per event type", () => {
    type SaleInput = Extract<GameEventInput, { type: "SALE_COMPLETED" }>;
    expectTypeOf<SaleInput>().not.toHaveProperty("id");
    expectTypeOf<SaleInput>().not.toHaveProperty("tick");
    expectTypeOf<SaleInput>().toHaveProperty("revenue");
  });

  it("InvariantViolationError lists the violated invariants", () => {
    const error = new InvariantViolationError(asId("Transaction", "txn-1"), [
      { code: "NEGATIVE_CASH", cash: -5 as never },
      { code: "LEDGER_SINGLE_ENTRY" },
    ]);
    expect(error.message).toContain("NEGATIVE_CASH, LEDGER_SINGLE_ENTRY");
    expect(error.violations).toHaveLength(2);
  });
});
