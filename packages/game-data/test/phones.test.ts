// ADR 0027 decision 17's game-data (PH1): the phone, room and arrangement tables,
// with their load validation. Every value is PLACEHOLDER tuning; the places and
// privileges are #203's.
import { ARRANGEMENT_PRIVILEGES, cents, compareIds, TICKS_PER_DAY, TICKS_PER_HOUR } from "@eov/contracts";
import { describe, expect, it } from "vitest";
import {
  ARRANGEMENTS,
  CALL_ANSWER_PPM,
  CALL_COST,
  CALL_IN_INTERVAL_TICKS,
  CALL_IN_RULES,
  GAME_DATA,
  KESSLER_PHARMACY,
  KNOWLEDGE_VISIBILITY,
  LAKEVIEW,
  LAKEVIEW_LOBBY_HOURS,
  MESSAGE_LIMIT,
  MILLERS_FEED_LOCATION,
  PHONE_DATA,
  PHONE_LINE,
  PhoneDataError,
  PHONES,
  PRESENCE,
  PresenceDataError,
  RIVERSIDE_DEPOT,
  ROOMS,
  validatePhones,
  validatePresence,
  type PhoneData,
  type PhoneDefinition,
  type RoomDefinition,
} from "../src/index.ts";

const withPhone = (patch: Partial<PhoneDefinition>, at = MILLERS_FEED_LOCATION): PhoneData => ({
  ...PHONE_DATA,
  phones: PHONES.map((p) => (p.locationId === at ? { ...p, ...patch } : p)),
});

describe("the phone table (ADR 0027 decision 2)", () => {
  it("has #203's places and privileges, sorted by location", () => {
    expect(PHONES).toEqual([
      { locationId: KESSLER_PHARMACY, hours: null, use: { kind: "PRIVATE" }, messages: "NEVER" },
      { locationId: LAKEVIEW, hours: LAKEVIEW_LOBBY_HOURS, use: { kind: "GUEST" }, messages: "NEVER" },
      { locationId: MILLERS_FEED_LOCATION, hours: null, use: { kind: "ARRANGEMENT" }, messages: "ARRANGEMENT" },
      { locationId: RIVERSIDE_DEPOT, hours: null, use: { kind: "PUBLIC", fee: cents(10) }, messages: "NEVER" },
    ]);
    expect(PHONES.map((p) => p.locationId)).toEqual(PHONES.map((p) => p.locationId).sort(compareIds));
  });

  it("puts the lobby phone on the lobby's hours, not the back room's", () => {
    expect(LAKEVIEW_LOBBY_HOURS).toEqual([{ opensAtMinute: 7 * 60, closesAtMinute: 23 * 60 }]);
  });

  it("has ADR 0024's PLACEHOLDER numbers", () => {
    expect(PHONE_LINE).toEqual({ price: cents(5_000), requiredUnlockId: null });
    expect(CALL_COST).toBe(cents(5));
    expect(CALL_ANSWER_PPM).toEqual({ BUYER: 850_000, SUPPLIER: 900_000 });
    expect(CALL_IN_INTERVAL_TICKS).toBe(60);
    expect(MESSAGE_LIMIT).toBe(10);
    expect(CALL_IN_RULES.map((r) => [r.partyKind, r.reason, r.subjectKind])).toEqual([
      ["BUYER", "NEW_CONTRACT_OFFER", "CONTRACT_OFFERS"],
      ["BUYER", "INSTALLMENT_DUE", "CONTRACT_PROGRESS"],
    ]);
  });

  it("has Miller's arrangement: the phone with the first sack, messages after three days, lapsing after a week", () => {
    expect(ARRANGEMENTS).toEqual([
      { locationId: MILLERS_FEED_LOCATION, contactName: "Miller", dealing: "SUPPLY_PURCHASE", dealingDaysNeeded: { PHONE_USE: 1, TAKES_MESSAGES: 3 }, lapseTicks: 7 * TICKS_PER_DAY },
    ]);
  });

  it("is bundled into GAME_DATA", () => {
    expect(GAME_DATA.phones).toBe(PHONE_DATA);
    expect(PHONE_DATA).toEqual({
      phones: PHONES,
      phoneLine: PHONE_LINE,
      callCost: CALL_COST,
      callAnswerPpm: CALL_ANSWER_PPM,
      callInRules: CALL_IN_RULES,
      callInIntervalTicks: CALL_IN_INTERVAL_TICKS,
      messageLimit: MESSAGE_LIMIT,
      arrangements: ARRANGEMENTS,
    });
  });

  it("messages from a buyer carry the contract, never the price or the standing (ADR 0024 decision 6)", () => {
    expect(KNOWLEDGE_VISIBILITY.MESSAGE).toEqual({ FACILITY: [], SUPPLIER: [], BUYER: ["CONTRACT_OFFERS", "CONTRACT_PROGRESS"] });
    for (const rule of CALL_IN_RULES) {
      expect(KNOWLEDGE_VISIBILITY.PHONE[rule.partyKind]).toContain(rule.subjectKind);
      expect(KNOWLEDGE_VISIBILITY.MESSAGE[rule.partyKind]).toContain(rule.subjectKind);
    }
  });
});

describe("validatePhones (ADR 0024 decision 15, ADR 0027 decisions 1 and 3)", () => {
  it("accepts the tables as they are", () => {
    expect(validatePhones(PHONE_DATA)).toBe(PHONE_DATA);
  });

  it.each<[string, PhoneData]>([
    ["two phones at one place", { ...PHONE_DATA, phones: [PHONES[0]!, PHONES[0]!] }],
    ["phones out of order", { ...PHONE_DATA, phones: [...PHONES].reverse() }],
    ["a phone at an unknown place", { ...PHONE_DATA, phones: [...PHONES, { locationId: "zz-nowhere" as never, hours: null, use: { kind: "PRIVATE" }, messages: "NEVER" }] }],
    ["phone hours with no intervals", withPhone({ hours: [] })],
    ["phone hours past midnight's minute", withPhone({ hours: [{ opensAtMinute: 0, closesAtMinute: 1_440 }] })],
    ["phone hours that open and close together", withPhone({ hours: [{ opensAtMinute: 60, closesAtMinute: 60 }] })],
    ["a free public phone", withPhone({ use: { kind: "PUBLIC", fee: cents(0) } }, RIVERSIDE_DEPOT)],
    ["a fractional public fee", withPhone({ use: { kind: "PUBLIC", fee: 2.5 as never } }, RIVERSIDE_DEPOT)],
    ["a guest phone where there are no rooms", withPhone({ use: { kind: "GUEST" } }, KESSLER_PHARMACY)],
    ["phone use by arrangement where there's none", withPhone({ use: { kind: "ARRANGEMENT" } }, KESSLER_PHARMACY)],
    ["messages by arrangement where there's none", withPhone({ messages: "ARRANGEMENT" }, RIVERSIDE_DEPOT)],
    ["a free line", { ...PHONE_DATA, phoneLine: { ...PHONE_LINE, price: cents(0) } }],
    ["free calls", { ...PHONE_DATA, callCost: cents(0) }],
    ["an answer chance over 100%", { ...PHONE_DATA, callAnswerPpm: { ...CALL_ANSWER_PPM, BUYER: 1_000_001 } }],
    ["a call-in chance below 0", { ...PHONE_DATA, callInRules: [{ ...CALL_IN_RULES[0]!, chancePpm: -1 }] }],
    ["a call-in subject a message can't carry", { ...PHONE_DATA, callInRules: [{ ...CALL_IN_RULES[0]!, subjectKind: "BUYER_WANTS" }] }],
    ["a call-in subject a call can't carry", { ...PHONE_DATA, callInRules: [{ ...CALL_IN_RULES[0]!, subjectKind: "BUYER_BUDGET" }] }],
    ["INSTALLMENT_DUE without withinTicks", { ...PHONE_DATA, callInRules: [{ ...CALL_IN_RULES[1]!, withinTicks: null }] }],
    ["withinTicks on another reason", { ...PHONE_DATA, callInRules: [{ ...CALL_IN_RULES[0]!, withinTicks: 60 }] }],
    ["no call-in window", { ...PHONE_DATA, callInIntervalTicks: 0 }],
    ["no room for messages", { ...PHONE_DATA, messageLimit: 0 }],
    ["two arrangements at one place", { ...PHONE_DATA, arrangements: [ARRANGEMENTS[0]!, ARRANGEMENTS[0]!] }],
    ["an arrangement for supply purchases where nobody sells", { ...PHONE_DATA, arrangements: [{ ...ARRANGEMENTS[0]!, locationId: RIVERSIDE_DEPOT }] }],
    ["an arrangement with no contact name", { ...PHONE_DATA, arrangements: [{ ...ARRANGEMENTS[0]!, contactName: " " }] }],
    ["a milestone needing no dealings", { ...PHONE_DATA, arrangements: [{ ...ARRANGEMENTS[0]!, dealingDaysNeeded: { PHONE_USE: 0, TAKES_MESSAGES: 3 } }] }],
    ["a milestone needing half a day", { ...PHONE_DATA, arrangements: [{ ...ARRANGEMENTS[0]!, dealingDaysNeeded: { PHONE_USE: 1, TAKES_MESSAGES: 2.5 } }] }],
    ["a lapse shorter than two days", { ...PHONE_DATA, arrangements: [{ ...ARRANGEMENTS[0]!, lapseTicks: 2 * TICKS_PER_DAY - 1 }] }],
  ])("rejects %s", (_label, bad) => {
    expect(() => validatePhones(bad)).toThrow(PhoneDataError);
  });

  it("accepts a lapse of exactly two days: a founder who buys every calendar day never lapses", () => {
    const twoDays = { ...PHONE_DATA, arrangements: [{ ...ARRANGEMENTS[0]!, lapseTicks: 2 * TICKS_PER_DAY }] };
    expect(validatePhones(twoDays)).toBe(twoDays);
  });

  it("checks a guest phone against the rooms it's given", () => {
    expect(() => validatePhones(PHONE_DATA, [])).toThrow(PhoneDataError);
  });

  it("checks an arrangement against the suppliers it's given", () => {
    expect(() => validatePhones(PHONE_DATA, ROOMS, undefined, [])).toThrow(PhoneDataError);
  });

  it("an arrangement phone with message-taking by arrangement needs only the one entry", () => {
    expect(PHONES.find((p) => p.locationId === MILLERS_FEED_LOCATION)).toMatchObject({ use: { kind: "ARRANGEMENT" }, messages: "ARRANGEMENT" });
    expect(ARRANGEMENT_PRIVILEGES).toEqual(Object.keys(ARRANGEMENTS[0]!.dealingDaysNeeded));
  });
});

describe("rooms and the phone durations in the presence tables (ADR 0027 decisions 4 and 10)", () => {
  const lakeview: RoomDefinition = ROOMS[0]!;

  it("has one room table entry, Lakeview's, at $2.00 a night with checkout at 11:00 and at least 8 hours", () => {
    expect(ROOMS).toEqual([
      { locationId: LAKEVIEW, nightlyRate: cents(200), deskHours: LAKEVIEW_LOBBY_HOURS, checkoutMinute: 11 * 60, minStayTicks: 8 * TICKS_PER_HOUR },
    ]);
    expect(PRESENCE.rooms).toBe(ROOMS);
  });

  it.each<[string, Partial<typeof PRESENCE>]>([
    ["a room at an unknown place", { rooms: [{ ...lakeview, locationId: "zz-nowhere" as never }] }],
    ["two room entries for one place", { rooms: [lakeview, lakeview] }],
    ["a free room", { rooms: [{ ...lakeview, nightlyRate: cents(0) }] }],
    ["a desk that never opens", { rooms: [{ ...lakeview, deskHours: [] }] }],
    ["desk hours outside the day", { rooms: [{ ...lakeview, deskHours: [{ opensAtMinute: -60, closesAtMinute: 60 }] }] }],
    ["checkout past the end of the day", { rooms: [{ ...lakeview, checkoutMinute: 1_440 }] }],
    ["a fractional checkout", { rooms: [{ ...lakeview, checkoutMinute: 660.5 }] }],
    ["a stay of no time", { rooms: [{ ...lakeview, minStayTicks: 0 }] }],
    ["an unanswered call that takes no time", { activityDurations: { ...PRESENCE.activityDurations, PHONE_NO_ANSWER: 0 } }],
    ["an unanswered call as long as a connected one", { activityDurations: { ...PRESENCE.activityDurations, PHONE_NO_ANSWER: 15 } }],
  ])("rejects %s", (_label, patch) => {
    expect(() => validatePresence({ ...PRESENCE, ...patch })).toThrow(PresenceDataError);
  });

  it("accepts no rooms at all", () => {
    expect(validatePresence({ ...PRESENCE, rooms: [] }).rooms).toEqual([]);
  });
});
