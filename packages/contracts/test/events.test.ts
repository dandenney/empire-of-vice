import { describe, expect, expectTypeOf, it } from "vitest";
import {
  asId,
  cents,
  EVENT_IMPORTANCE,
  GAME_EVENT_TYPES,
  tick,
  type EventOfType,
  type GameEvent,
  type GameEventType,
} from "../src/index.ts";

describe("events", () => {
  it("classifies every event type exactly once", () => {
    expectTypeOf<keyof typeof EVENT_IMPORTANCE>().toEqualTypeOf<GameEventType>();
    expect(new Set(GAME_EVENT_TYPES).size).toBe(GAME_EVENT_TYPES.length);
    expect(GAME_EVENT_TYPES.length).toBe(55);
  });

  it("has no unknown or any payloads", () => {
    // If any member's field were `unknown`/`any`, it would absorb other types and this would fail.
    expectTypeOf<GameEvent>().not.toBeAny();
    expectTypeOf<EventOfType<"SALE_COMPLETED">["revenue"]>().not.toBeUnknown();
  });

  it("narrows by type", () => {
    const event: GameEvent = {
      id: asId("Event", "evt-1"),
      tick: tick(1_500),
      causedBy: null,
      type: "SALE_COMPLETED",
      deliveryId: asId("Delivery", "delivery-1"),
      buyerId: asId("Buyer", "roadhouse"),
      cargo: [{ productId: asId("Product", "moonshine"), quality: "basic", quantity: 15 }],
      unitPrice: cents(2_000),
      revenue: cents(30_000),
      costOfGoodsSold: cents(15_600),
      contractId: null,
      transactionId: asId("Transaction", "txn-9"),
    };
    if (event.type === "SALE_COMPLETED") {
      expectTypeOf(event).toEqualTypeOf<EventOfType<"SALE_COMPLETED">>();
      expect(event.revenue - event.costOfGoodsSold).toBe(14_400); // FIN-001 example: $144 gross profit
    }
  });
});
