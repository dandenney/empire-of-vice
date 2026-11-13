// The telephone contract (ADR 0024 decision 15, as restated by ADR 0027 decision 17; task PH1).

import { describe, expect, expectTypeOf, it } from "vitest";
import { day0Save, ids } from "../fixtures/index.ts";
import {
  ACTIVITY_IMPORTANCE,
  activityItemSchema,
  ARRANGEMENT_PRIVILEGES,
  asId,
  cents,
  EMPTY_KNOWLEDGE,
  EVENT_CONCERNS_PLACE,
  EVENT_IMPORTANCE,
  GAME_COMMAND_TYPES,
  gameCommandSchema,
  gameEventSchema,
  gameStateSchema,
  rejectionReasonSchema,
  tick,
  TRANSACTION_PRODUCERS,
  type ActiveCall,
  type ActivityItem,
  type ArrangementPrivilege,
  type ArrangementState,
  type CallAnswerer,
  type CallInReason,
  type CallParty,
  type DeliveredMessage,
  type GameCommand,
  type GameEvent,
  type HeldMessage,
  type LocationOccupant,
  type PendingMessages,
  type PlacePhone,
  type PlaceRooms,
  type PlayerArrangement,
  type PlayerPlace,
  type RejectionCode,
  type RejectionReason,
  type RepeatableCommand,
  type RoomStay,
  type TransactionKind,
} from "../src/index.ts";
import type { IsPlainData } from "./plain-data.ts";

const roundTrip = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

function withoutKey(value: object | undefined, key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...value };
  delete copy[key];
  return copy;
}

describe("shapes (ADR 0027 decision 17)", () => {
  it("are plain JSON-safe data with no optional fields", () => {
    expectTypeOf<IsPlainData<ActiveCall>>().toEqualTypeOf<true>();
    expectTypeOf<IsPlainData<RoomStay>>().toEqualTypeOf<true>();
    expectTypeOf<IsPlainData<ArrangementState>>().toEqualTypeOf<true>();
    expectTypeOf<IsPlainData<HeldMessage>>().toEqualTypeOf<true>();
    expectTypeOf<IsPlainData<PendingMessages>>().toEqualTypeOf<true>();
    expectTypeOf<IsPlainData<DeliveredMessage>>().toEqualTypeOf<true>();
    expectTypeOf<IsPlainData<PlacePhone>>().toEqualTypeOf<true>();
    expectTypeOf<IsPlainData<PlayerArrangement>>().toEqualTypeOf<true>();
    expectTypeOf<IsPlainData<PlaceRooms>>().toEqualTypeOf<true>();
  });

  it("a call party is never one of the family's facilities", () => {
    expectTypeOf<CallParty>().toEqualTypeOf<Exclude<LocationOccupant, { readonly kind: "FACILITY" }>>();
    expectTypeOf<CallParty["kind"]>().toEqualTypeOf<"SUPPLIER" | "BUYER">();
    expectTypeOf<CallAnswerer["kind"]>().toEqualTypeOf<"PARTY" | "EMPLOYEE" | "PROPRIETOR">();
  });

  it("lists the arrangement privileges in decision 3's order", () => {
    expect(ARRANGEMENT_PRIVILEGES).toEqual(["PHONE_USE", "TAKES_MESSAGES"]);
    expectTypeOf<(typeof ARRANGEMENT_PRIVILEGES)[number]>().toEqualTypeOf<ArrangementPrivilege>();
  });

  it("has ADR 0024's call-in reasons (ADR 0025 adds EMPLOYEE_REPORT later)", () => {
    expectTypeOf<CallInReason>().toEqualTypeOf<"NEW_CONTRACT_OFFER" | "INSTALLMENT_DUE">();
  });

  it("has a fourth place variant for a location with no occupant", () => {
    expectTypeOf<PlayerPlace["kind"]>().toEqualTypeOf<"FACILITY" | "SUPPLIER" | "BUYER" | "NONE">();
    // ADR 0027 decision 12: ADR 0024's `public` and `holdsMessages` are gone.
    expectTypeOf<PlacePhone>().not.toHaveProperty("public");
    expectTypeOf<PlacePhone>().not.toHaveProperty("holdsMessages");
  });

  it("adds the TELEPHONE and LODGING kinds, whose producers land with their call sites in C1", () => {
    expectTypeOf<"TELEPHONE" | "LODGING">().toExtend<TransactionKind>();
    const families = Object.keys(TRANSACTION_PRODUCERS);
    expect(families.filter((f) => f.startsWith("TELEPHONE") || f.startsWith("LODGING"))).toEqual([]);
  });
});

describe("state and saves (ADR 0024 decision 13, ADR 0027 decision 15)", () => {
  it("a new knowledge state holds no messages", () => {
    expect(EMPTY_KNOWLEDGE.pendingMessages).toEqual([]);
  });

  it.each([
    ["facilities[].phoneLine", { ...day0Save.state, facilities: day0Save.state.facilities.map((f) => withoutKey(f, "phoneLine")) }],
    ["knowledge.pendingMessages", { ...day0Save.state, knowledge: withoutKey(day0Save.state.knowledge, "pendingMessages") }],
    ["founder.room", { ...day0Save.state, founder: withoutKey(day0Save.state.founder, "room") }],
    ["founder.whereabouts.call", { ...day0Save.state, founder: { ...day0Save.state.founder, whereabouts: withoutKey(day0Save.state.founder.whereabouts, "call") } }],
    ["arrangements", withoutKey(day0Save.state, "arrangements")],
  ])("requires %s", (_field, bad) => {
    expect(gameStateSchema.safeParse(roundTrip(day0Save.state)).success).toBe(true);
    expect(gameStateSchema.safeParse(roundTrip(bad)).success).toBe(false);
  });

  it("accepts an installed line and rejects a malformed one", () => {
    const withLine = { ...day0Save.state, facilities: day0Save.state.facilities.map((f) => ({ ...f, phoneLine: { bookValue: cents(5_000) } })) };
    expect(gameStateSchema.safeParse(roundTrip(withLine)).success).toBe(true);
    const fractional = { ...day0Save.state, facilities: day0Save.state.facilities.map((f) => ({ ...f, phoneLine: { bookValue: 12.5 } })) };
    expect(gameStateSchema.safeParse(roundTrip(fractional)).success).toBe(false);
  });

  it.each([
    ["no dealing days", { locationId: ids.locSupplier, dealingDays: 0, lastDealingAt: 541 }],
    ["a fractional dealing day", { locationId: ids.locSupplier, dealingDays: 1.5, lastDealingAt: 541 }],
    ["no last dealing", { locationId: ids.locSupplier, dealingDays: 1 }],
    ["an extra key", { locationId: ids.locSupplier, dealingDays: 1, lastDealingAt: 541, granted: ["PHONE_USE"] }],
  ])("rejects an arrangement with %s", (_label, bad) => {
    expect(gameStateSchema.safeParse(roundTrip({ ...day0Save.state, arrangements: [bad] })).success).toBe(false);
  });

  it("rejects a held message whose value isn't its subject's", () => {
    const message: HeldMessage = {
      takenAt: tick(840),
      callerLocationId: ids.locSpeakeasy,
      takenBy: ids.foreman,
      reason: "INSTALLMENT_DUE",
      values: [{ subject: { kind: "CONTRACT_OFFERS", buyerId: ids.speakeasy }, value: { kind: "CONTRACT_OFFERS", buyerId: ids.speakeasy, offers: [] } }],
    };
    const state = (m: unknown) => ({ ...day0Save.state, knowledge: { ...day0Save.state.knowledge, pendingMessages: [{ locationId: ids.locDistillery, items: [m], dropped: 2 }] } });
    expect(gameStateSchema.safeParse(roundTrip(state(message))).success).toBe(true);
    const mismatched = { ...message, values: [{ ...message.values[0], subject: { kind: "CONTRACT_OFFERS", buyerId: ids.hotel } }] };
    expect(gameStateSchema.safeParse(roundTrip(state(mismatched))).success).toBe(false);
    expect(gameStateSchema.safeParse(roundTrip(state({ ...message, reason: "GOSSIP" }))).success).toBe(false);
  });
});

describe("PLACE_CALL, INSTALL_PHONE and RENT_ROOM", () => {
  const commands: GameCommand[] = [
    { type: "PLACE_CALL", locationId: ids.locSpeakeasy },
    { type: "INSTALL_PHONE", facilityId: ids.distillery },
    { type: "RENT_ROOM", locationId: ids.locHotel },
  ];

  it("are commands, after AGREE_DEAL, and not repeatable", () => {
    expect(GAME_COMMAND_TYPES.slice(GAME_COMMAND_TYPES.indexOf("AGREE_DEAL") + 1)).toEqual(["PLACE_CALL", "INSTALL_PHONE", "RENT_ROOM"]);
    expectTypeOf<Extract<RepeatableCommand, { type: "PLACE_CALL" | "INSTALL_PHONE" | "RENT_ROOM" }>>().toBeNever();
  });

  it.each(commands.map((c) => [c.type, c] as const))("%s round-trips through JSON", (_type, command) => {
    expect(gameCommandSchema.parse(roundTrip(command))).toEqual(command);
  });

  it.each([
    ["PLACE_CALL without a place", { type: "PLACE_CALL" }],
    ["PLACE_CALL naming a party instead of a place", { type: "PLACE_CALL", buyerId: ids.speakeasy }],
    ["INSTALL_PHONE at a bad facility ID", { type: "INSTALL_PHONE", facilityId: "The Still" }],
    ["RENT_ROOM with a number of nights", { type: "RENT_ROOM", locationId: ids.locHotel, nights: 2 }],
  ])("rejects %s", (_label, bad) => {
    expect(gameCommandSchema.safeParse(bad).success).toBe(false);
  });
});

describe("rejection reasons (ADR 0024 decision 14, ADR 0027 decision 16)", () => {
  const reasons: RejectionReason[] = [
    { code: "NO_PHONE_HERE", locationId: ids.locRoadhouse },
    { code: "NO_PHONE_THERE", locationId: ids.locRoadhouse },
    { code: "PHONE_ALREADY_INSTALLED", facilityId: ids.distillery },
    { code: "PHONE_USE_NOT_GRANTED", locationId: ids.locSpeakeasy, rule: "PRIVATE" },
    { code: "PHONE_USE_NOT_GRANTED", locationId: ids.locHotel, rule: "GUEST" },
    { code: "PHONE_USE_NOT_GRANTED", locationId: ids.locSupplier, rule: "ARRANGEMENT" },
    { code: "NO_ROOMS_HERE", locationId: ids.locSupplier },
  ];

  it("adds five codes", () => {
    const added = ["NO_PHONE_HERE", "NO_PHONE_THERE", "PHONE_ALREADY_INSTALLED", "PHONE_USE_NOT_GRANTED", "NO_ROOMS_HERE"] as const;
    expectTypeOf<(typeof added)[number]>().toExtend<RejectionCode>();
    expect(new Set(reasons.map((r) => r.code))).toEqual(new Set(added));
  });

  it.each(reasons.map((r, i) => [`${r.code} #${i}`, r] as const))("%s round-trips through JSON", (_code, reason) => {
    expect(rejectionReasonSchema.parse(roundTrip(reason))).toEqual(reason);
  });

  it.each([
    ["PHONE_USE_NOT_GRANTED for a public phone", { code: "PHONE_USE_NOT_GRANTED", locationId: ids.locSupplier, rule: "PUBLIC" }],
    ["PHONE_USE_NOT_GRANTED for the family's line", { code: "PHONE_USE_NOT_GRANTED", locationId: ids.locDistillery, rule: "FAMILY_LINE" }],
    ["PHONE_USE_NOT_GRANTED without a rule", { code: "PHONE_USE_NOT_GRANTED", locationId: ids.locSupplier }],
    ["NO_PHONE_HERE without the founder's place", { code: "NO_PHONE_HERE" }],
    ["PHONE_ALREADY_INSTALLED naming a place", { code: "PHONE_ALREADY_INSTALLED", locationId: ids.locDistillery }],
    ["NO_ROOMS_HERE with an extra key", { code: "NO_ROOMS_HERE", locationId: ids.locSupplier, nightlyRate: 200 }],
  ])("rejects %s", (_label, bad) => {
    expect(rejectionReasonSchema.safeParse(bad).success).toBe(false);
  });
});

describe("events", () => {
  const meta = { id: asId("Event", "evt-70"), tick: tick(900), causedBy: asId("Command", "cmd-12") };
  const kessler: CallAnswerer = { kind: "PARTY", party: { kind: "BUYER", buyerId: ids.speakeasy } };
  const events: GameEvent[] = [
    { ...meta, type: "CALL_PLACED", fromLocationId: ids.locSupplier, locationId: ids.locSpeakeasy, answered: true, answeredBy: kessler, transactionId: asId("Transaction", "txn-20") },
    { ...meta, type: "CALL_PLACED", fromLocationId: ids.locSupplier, locationId: ids.locHotel, answered: false, answeredBy: null, transactionId: asId("Transaction", "txn-21") },
    { ...meta, causedBy: null, type: "CALL_RECEIVED", callerLocationId: ids.locSpeakeasy, phoneLocationId: ids.locSupplier, reason: "NEW_CONTRACT_OFFER" },
    { ...meta, causedBy: null, type: "MESSAGE_TAKEN", callerLocationId: ids.locSpeakeasy, heldAtLocationId: ids.locSupplier, takenBy: null, reason: "INSTALLMENT_DUE" },
    { ...meta, causedBy: null, type: "MESSAGES_DELIVERED", locationId: ids.locSupplier, count: 2, dropped: 1, via: "ARRIVAL" },
    { ...meta, type: "PHONE_INSTALLED", facilityId: ids.distillery, price: cents(5_000), transactionId: asId("Transaction", "txn-22") },
    { ...meta, type: "ROOM_RENTED", locationId: ids.locHotel, until: tick(2_100), price: cents(200), transactionId: asId("Transaction", "txn-23") },
    { ...meta, type: "ARRANGEMENT_GRANTED", locationId: ids.locSupplier, privilege: "TAKES_MESSAGES" },
  ];

  it.each(events.map((e, i) => [`${e.type} #${i}`, e] as const))("%s round-trips through JSON", (_type, event) => {
    expect(gameEventSchema.parse(roundTrip(event))).toEqual(event);
  });

  it("are logged, never toasted, and never news: the founder learns them through the player snapshot", () => {
    for (const e of events) {
      expect(EVENT_IMPORTANCE[e.type]).toBe("log");
      expect(EVENT_CONCERNS_PLACE[e.type]).toBeNull();
    }
  });

  it.each([
    ["CALL_PLACED without a transaction", withoutKey(events[0], "transactionId")],
    ["CALL_PLACED answered by a facility", { ...events[0], answeredBy: { kind: "PARTY", party: { kind: "FACILITY", facilityId: ids.distillery } } }],
    ["MESSAGES_DELIVERED by an unknown channel", { ...events[4], via: "TELEGRAM" }],
    ["MESSAGES_DELIVERED with a negative count", { ...events[4], count: -1 }],
    ["ROOM_RENTED without checkout", withoutKey(events[6], "until")],
    ["ARRANGEMENT_GRANTED for an unknown privilege", { ...events[7], privilege: "CREDIT" }],
  ])("rejects %s", (_label, bad) => {
    expect(gameEventSchema.safeParse(roundTrip(bad)).success).toBe(false);
  });
});

describe("activity items (ADR 0024 decision 15, ADR 0027 decision 17)", () => {
  const delivered: DeliveredMessage = {
    takenAt: tick(840),
    heldAtLocationId: ids.locSupplier,
    callerLocationId: ids.locSpeakeasy,
    takenBy: null,
    reason: "NEW_CONTRACT_OFFER",
    subjects: [{ kind: "CONTRACT_OFFERS", buyerId: ids.speakeasy }],
  };
  const items: ActivityItem[] = [
    { kind: "CALL_PLACED", tick: tick(900), locationId: ids.locSpeakeasy, answered: true, answeredBy: "PARTY" },
    { kind: "CALL_PLACED", tick: tick(900), locationId: ids.locHotel, answered: false, answeredBy: null },
    { kind: "CALL_RECEIVED", tick: tick(960), callerLocationId: ids.locSpeakeasy, phoneLocationId: ids.locSupplier, reason: "INSTALLMENT_DUE" },
    { kind: "MESSAGE_DELIVERED", tick: tick(1_020), message: delivered },
    { kind: "MESSAGES_DROPPED", tick: tick(1_020), locationId: ids.locSupplier, count: 3 },
    { kind: "PHONE_INSTALLED", tick: tick(1_100), facilityId: ids.distillery },
    { kind: "ARRANGEMENT_GRANTED", tick: tick(541), locationId: ids.locSupplier, privilege: "PHONE_USE" },
  ];

  it.each(items.map((item, i) => [`${item.kind} #${i}`, item] as const))("%s round-trips through JSON", (_kind, item) => {
    expect(activityItemSchema.parse(roundTrip(item))).toEqual(item);
  });

  it("notify for a call in and a delivered message, log for the rest (PLACEHOLDER)", () => {
    expect(ACTIVITY_IMPORTANCE.CALL_RECEIVED).toBe("notify");
    expect(ACTIVITY_IMPORTANCE.MESSAGE_DELIVERED).toBe("notify");
    for (const kind of ["CALL_PLACED", "MESSAGES_DROPPED", "PHONE_INSTALLED", "ARRANGEMENT_GRANTED"] as const) expect(ACTIVITY_IMPORTANCE[kind]).toBe("log");
  });

  it.each([
    ["CALL_PLACED naming the answerer's character", { ...items[0], answeredBy: { kind: "EMPLOYEE", characterId: ids.foreman } }],
    ["MESSAGE_DELIVERED carrying the values", { ...items[3], message: { ...delivered, values: [] } }],
    ["MESSAGES_DROPPED of nothing", { ...items[4], count: 0 }],
    ["ARRANGEMENT_GRANTED without a privilege", withoutKey(items[6], "privilege")],
  ])("rejects %s", (_label, bad) => {
    expect(activityItemSchema.safeParse(roundTrip(bad)).success).toBe(false);
  });
});
