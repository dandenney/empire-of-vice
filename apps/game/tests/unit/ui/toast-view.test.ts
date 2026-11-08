// Issue #61: toasts for `notify` events. Every notify event type maps to a
// toast, the #99 strings come out exactly as approved, and the host's queue
// stays bounded.

import { asId, cents, EVENT_IMPORTANCE, GAME_EVENT_TYPES, tick, type GameEvent, type GameSnapshot } from "@eov/contracts";
import { ids, midGameSnapshot } from "@eov/contracts/fixtures";
import { describe, expect, it } from "vitest";
import { MAX_TOASTS, enqueue } from "../../../src/ui/toasts/toast-host.tsx";
import { NOTIFY_EVENT_TYPES, toastsFor, type NotifyEventType, type ToastView } from "../../../src/ui/toasts/toast-view.ts";

let next = 0;
const meta = (at = 100) => ({ id: asId("Event", `evt-${++next}`), tick: tick(at), causedBy: null });

/** One sample event per notify type, using the fixture's entities. */
const SAMPLES: { readonly [T in NotifyEventType]: () => Extract<GameEvent, { type: T }> } = {
  COMMAND_REJECTED: () => ({
    ...meta(),
    type: "COMMAND_REJECTED",
    commandId: asId("Command", "cmd-1"),
    commandType: "START_PRODUCTION",
    reason: { code: "INSUFFICIENT_MATERIALS", materialId: ids.corn, required: 4, available: 0 },
  }),
  PRODUCTION_COMPLETED: () => ({
    ...meta(),
    type: "PRODUCTION_COMPLETED",
    jobId: asId("ProductionJob", "job-1"),
    facilityId: ids.distillery,
    productId: ids.moonshine,
    quality: "basic",
    quantity: 3,
    costBasis: cents(1_200),
    transactionId: asId("Transaction", "txn-1"),
  }),
  PRODUCTION_FAILED: () => ({
    ...meta(),
    type: "PRODUCTION_FAILED",
    jobId: asId("ProductionJob", "job-1"),
    facilityId: ids.distillery,
    reason: "DISRUPTION",
    writtenOff: cents(500),
    transactionId: asId("Transaction", "txn-2"),
  }),
  DELIVERY_DELAYED: () => ({
    ...meta(),
    type: "DELIVERY_DELAYED",
    deliveryId: asId("Delivery", "del-1"),
    routeId: ids.routeHotel,
    previousArrivesAt: tick(200),
    arrivesAt: tick(260),
  }),
  SALE_COMPLETED: () => ({
    ...meta(),
    type: "SALE_COMPLETED",
    deliveryId: asId("Delivery", "del-1"),
    buyerId: ids.hotel,
    cargo: [],
    unitPrice: cents(4_800),
    revenue: cents(14_400),
    costOfGoodsSold: cents(3_000),
    contractId: null,
    transactionId: asId("Transaction", "txn-3"),
  }),
  DEAL_FELL_THROUGH: () => ({ ...meta(), type: "DEAL_FELL_THROUGH", deliveryId: asId("Delivery", "del-1"), buyerId: ids.hotel, reason: "TOO_LATE" }),
  CARGO_LOST: () => ({
    ...meta(),
    type: "CARGO_LOST",
    deliveryId: asId("Delivery", "del-1"),
    vehicleId: ids.truck,
    cargo: [],
    bookValue: cents(2_000),
    transactionId: asId("Transaction", "txn-4"),
  }),
  SHORTAGE_STARTED: () => ({ ...meta(), type: "SHORTAGE_STARTED", supplierId: ids.supplier, materialId: ids.corn, supplyRatioPpm: 500_000, endsAt: tick(3_000) }),
  SHORTAGE_ENDED: () => ({ ...meta(), type: "SHORTAGE_ENDED", supplierId: ids.supplier, materialId: ids.corn }),
  ROUTE_CLOSED: () => ({ ...meta(), type: "ROUTE_CLOSED", routeId: ids.routeHotel, reason: "POLICE", reopensAt: null }),
  ROUTE_REOPENED: () => ({ ...meta(), type: "ROUTE_REOPENED", routeId: ids.routeHotel }),
  CONTRACT_OFFERED: () => ({ ...meta(), type: "CONTRACT_OFFERED", contractOfferId: asId("ContractOffer", "offer-2"), buyerId: ids.speakeasy, expiresAt: tick(5_000) }),
  INSTALLMENT_SETTLED: () => ({
    ...meta(),
    type: "INSTALLMENT_SETTLED",
    contractId: asId("Contract", "contract-1"),
    installmentIndex: 0,
    required: 4,
    delivered: 4,
    outcome: "FULFILLED",
    penalty: cents(0),
    transactionId: asId("Transaction", "txn-5"),
  }),
  CONTRACT_COMPLETED: () => ({ ...meta(), type: "CONTRACT_COMPLETED", contractId: asId("Contract", "contract-1"), outcomes: ["FULFILLED"] }),
  TIER_REACHED: () => ({ ...meta(), type: "TIER_REACHED", tierId: ids.tierTrusted }),
  UNLOCK_GRANTED: () => ({ ...meta(), type: "UNLOCK_GRANTED", unlockId: ids.unlockContracts }),
  VICTORY_ACHIEVED: () => ({ ...meta(), type: "VICTORY_ACHIEVED", netWorth: cents(500_000), reputation: 30, completedContractId: asId("Contract", "contract-1") }),
  GAME_LOST: () => ({ ...meta(), type: "GAME_LOST", reason: "INSOLVENT" }),
};

const snapshot: GameSnapshot = midGameSnapshot;
const one = (event: GameEvent, s: GameSnapshot | null = snapshot): ToastView => {
  const toasts = toastsFor([event], s);
  expect(toasts).toHaveLength(1);
  return toasts[0]!;
};

const rivalClosure = (at: number): GameEvent => ({ ...meta(at), type: "ROUTE_CLOSED", routeId: ids.routeSpeakeasyMain, reason: "RIVAL", reopensAt: tick(at + 1_440) });
const policeClosure = (at: number): GameEvent => ({ ...meta(at), type: "ROUTE_CLOSED", routeId: ids.routeSpeakeasyMain, reason: "POLICE", reopensAt: null });
const countyReopened = (at: number): GameEvent => ({ ...meta(at), type: "ROUTE_REOPENED", routeId: ids.routeSpeakeasyMain });
const withRecent = (events: readonly GameEvent[]): GameSnapshot => ({ ...snapshot, recentEvents: [...snapshot.recentEvents, ...events] });

describe("toast mapping (issue #61)", () => {
  it("covers exactly the notify events in EVENT_IMPORTANCE", () => {
    const notify = GAME_EVENT_TYPES.filter((t) => EVENT_IMPORTANCE[t] === "notify");
    expect([...NOTIFY_EVENT_TYPES].sort()).toEqual([...notify].sort());
  });

  it.each(NOTIFY_EVENT_TYPES)("%s maps to a toast with a title and a line of text", (type) => {
    const toast = one(SAMPLES[type]());
    expect(toast.eventType).toBe(type);
    expect(toast.title.trim()).not.toBe("");
    expect(toast.body.trim()).not.toBe("");
    expect(["good", "bad", "neutral"]).toContain(toast.tone);
  });

  it("log events get no toast", () => {
    const log: GameEvent = { ...meta(), type: "MARKET_UPDATED", dayIndex: 1 };
    expect(toastsFor([log], snapshot)).toEqual([]);
  });

  it("names come from the snapshot, and fall back to the id without one", () => {
    expect(one(SAMPLES.SALE_COMPLETED()).body).toBe("Lakeview Hotel paid $144.00.");
    expect(one(SAMPLES.SALE_COMPLETED(), null).body).toBe("lakeview-hotel paid $144.00.");
    expect(one(SAMPLES.PRODUCTION_COMPLETED()).body).toContain("Hollow Creek Distillery");
    expect(one(SAMPLES.CONTRACT_COMPLETED()).body).toContain("The Crossroads Roadhouse");
  });

  it("keeps the event's id and holds display text only", () => {
    const event = SAMPLES.TIER_REACHED();
    expect(Object.keys(one(event)).sort()).toEqual(["body", "eventType", "id", "title", "tone"]);
    expect(one(event).id).toBe(event.id);
  });
});

describe("#99 strings, verbatim", () => {
  it("TIER_REACHED: New standing: {tierName}.", () => {
    expect(one(SAMPLES.TIER_REACHED()).body).toBe("New standing: Trusted Supplier.");
  });

  it("the rival ROUTE_CLOSED on county-road: its title and notification", () => {
    const toast = one(rivalClosure(12_000));
    expect(toast.title).toBe("Dwyer's Roadblock");
    expect(toast.body).toBe("Word from Kessler's: Dwyer's boys have blocked the County Road. Find another way in, or wait them out.");
  });

  it("the ROUTE_REOPENED after it, whether the closure is in the same batch or in the snapshot's recent events", () => {
    const reopening = "The County Road is clear again. Dwyer's boys have moved on.";
    const [, sameBatch] = toastsFor([rivalClosure(12_000), countyReopened(13_440)], snapshot);
    expect(sameBatch!.body).toBe(reopening);
    expect(one(countyReopened(13_440), withRecent([rivalClosure(12_000)])).body).toBe(reopening);
  });

  it("other closures and reopenings get the placeholder wording", () => {
    expect(one(policeClosure(12_000)).title).not.toBe("Dwyer's Roadblock");
    expect(one(countyReopened(13_440), withRecent([rivalClosure(10_000), policeClosure(12_000)])).body).toBe("County road is open again.");
    expect(one(countyReopened(13_440)).body).toBe("County road is open again.");
    expect(one(SAMPLES.ROUTE_REOPENED()).body).not.toContain("Dwyer");
  });
});

describe("toast queue", () => {
  const view = (id: string): ToastView => ({ id, eventType: "GAME_LOST", tone: "bad", title: "t", body: "b" });

  it("keeps the newest MAX_TOASTS and skips repeats", () => {
    const ids = Array.from({ length: MAX_TOASTS + 2 }, (_, i) => `e${i}`);
    const queue = enqueue([], ids.map(view));
    expect(queue.map((t) => t.id)).toEqual(ids.slice(-MAX_TOASTS));
    expect(enqueue(queue, [view(ids.at(-1)!)])).toEqual(queue);
  });
});
