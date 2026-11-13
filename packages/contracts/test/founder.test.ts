// The founder and presence contract (ADR 0023 decision 11, task P1).

import { describe, expect, expectTypeOf, it } from "vitest";
import { day0Save, ids } from "../fixtures/index.ts";
import {
  ACTIVITY_IMPORTANCE,
  ACTIVITY_KINDS,
  asId,
  EVENT_CONCERNS_PLACE,
  EVENT_IMPORTANCE,
  founderStateSchema,
  GAME_COMMAND_TYPES,
  gameCommandSchema,
  gameEventSchema,
  gameStateSchema,
  rejectionReasonSchema,
  tick,
  type ActivityItem,
  type ActivityKind,
  type DriverRef,
  type FounderState,
  type GameCommand,
  type GameEvent,
  type PlayerFounder,
  type RejectionCode,
  type RejectionReason,
  type RepeatableCommand,
} from "../src/index.ts";
import type { IsPlainData } from "./plain-data.ts";

const roundTrip = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

function withoutKey(value: object | undefined, key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...value };
  delete copy[key];
  return copy;
}

describe("founder state (decision 1)", () => {
  it("is plain JSON-safe data with no optional fields", () => {
    expectTypeOf<IsPlainData<FounderState>>().toEqualTypeOf<true>();
    expectTypeOf<IsPlainData<PlayerFounder>>().toEqualTypeOf<true>();
    expectTypeOf<IsPlainData<DriverRef>>().toEqualTypeOf<true>();
  });

  it("lists the decision 4 activities, in the ADR's order", () => {
    expect(ACTIVITY_KINDS).toEqual([
      "BUY_MATERIALS",
      "START_BATCH",
      "LOAD_TRUCK",
      "AGREE_DEAL",
      "ACCEPT_CONTRACT",
      "BUY_EQUIPMENT",
      "SELL_EQUIPMENT",
      "SET_WORKFORCE",
    ]);
    expectTypeOf<(typeof ACTIVITY_KINDS)[number]>().toEqualTypeOf<ActivityKind>();
  });

  const states: FounderState[] = [
    { whereabouts: { kind: "PRESENT", locationId: ids.locDistillery, busy: null }, awakeSince: tick(0) },
    { whereabouts: { kind: "PRESENT", locationId: ids.locDistillery, busy: { activity: "LOAD_TRUCK", until: tick(630) } }, awakeSince: tick(360) },
    {
      whereabouts: {
        kind: "TRAVELLING",
        transport: { kind: "VEHICLE", vehicleId: ids.truck },
        path: [
          { routeId: ids.routeSupplier, reversed: true },
          { routeId: ids.routeRoadhouse, reversed: false },
        ],
        legIndex: 1,
        legDepartedAt: tick(700),
        legArrivesAt: tick(820),
        destinationLocationId: ids.locRoadhouse,
      },
      awakeSince: tick(360),
    },
    {
      whereabouts: { kind: "ON_DELIVERY", deliveryId: asId("Delivery", "delivery-2"), vehicleId: ids.truck, atStop: { locationId: ids.locHotel, tick: tick(900) } },
      awakeSince: tick(360),
    },
    { whereabouts: { kind: "ON_DELIVERY", deliveryId: asId("Delivery", "delivery-2"), vehicleId: ids.truck, atStop: null }, awakeSince: tick(360) },
    { whereabouts: { kind: "RESTING", locationId: ids.locDistillery, startedAt: tick(0), until: tick(360) }, awakeSince: tick(0) },
  ];

  it.each(states.map((s) => [s.whereabouts.kind, s] as const))("%s round-trips through JSON", (_kind, state) => {
    expect(founderStateSchema.parse(roundTrip(state))).toEqual(state);
  });

  it.each([
    ["an unknown whereabouts", { ...states[0], whereabouts: { kind: "HIDING", locationId: ids.locDistillery } }],
    ["busy left out", { ...states[0], whereabouts: withoutKey(states[0]!.whereabouts, "busy") }],
    ["an unknown activity", { ...states[1], whereabouts: { ...states[1]!.whereabouts, busy: { activity: "NAP", until: 630 } } }],
    ["an empty path", { ...states[2], whereabouts: { ...states[2]!.whereabouts, path: [] } }],
    ["a leg without a direction", { ...states[2], whereabouts: { ...states[2]!.whereabouts, path: [{ routeId: ids.routeSupplier }] } }],
    ["an unknown transport", { ...states[2], whereabouts: { ...states[2]!.whereabouts, transport: { kind: "HORSE" } } }],
    ["a fractional awakeSince", { ...states[0], awakeSince: 1.5 }],
    ["an extra key", { ...states[0], name: "Kerrigan" }],
  ])("rejects %s", (_label, bad) => {
    expect(founderStateSchema.safeParse(roundTrip(bad)).success).toBe(false);
  });

  it("is required in GameState, and so is every vehicle's parkedAt", () => {
    expect(gameStateSchema.safeParse(roundTrip(day0Save.state)).success).toBe(true);
    expect(gameStateSchema.safeParse(roundTrip(withoutKey(day0Save.state, "founder"))).success).toBe(false);
    const unparked = { ...day0Save.state, vehicles: day0Save.state.vehicles.map((v) => withoutKey(v, "parkedAt")) };
    expect(gameStateSchema.safeParse(roundTrip(unparked)).success).toBe(false);
    const moving = { ...day0Save.state, vehicles: day0Save.state.vehicles.map((v) => ({ ...v, parkedAt: null })) };
    expect(gameStateSchema.safeParse(roundTrip(moving)).success).toBe(true);
  });
});

describe("TRAVEL, REST and WAKE (decisions 3 and 7)", () => {
  it("are commands, after the M001 ones, and not repeatable", () => {
    expect(GAME_COMMAND_TYPES.slice(-3)).toEqual(["TRAVEL", "REST", "WAKE"]);
    expectTypeOf<Extract<RepeatableCommand, { type: "TRAVEL" | "REST" | "WAKE" }>>().toBeNever();
  });

  const travel: GameCommand = { type: "TRAVEL", destinationLocationId: ids.locSupplier, transport: { kind: "FOOT" }, via: null };
  const rest: GameCommand = { type: "REST", untilTick: tick(1_800) };

  it.each([
    ["TRAVEL without via (must be explicit null)", withoutKey(travel, "via")],
    ["TRAVEL with an empty via", { ...travel, via: [] }],
    ["TRAVEL with an unknown transport", { ...travel, transport: { kind: "HORSE" } }],
    ["TRAVEL by vehicle without a vehicle", { ...travel, transport: { kind: "VEHICLE" } }],
    ["TRAVEL to a bad location ID", { ...travel, destinationLocationId: "Miller's" }],
    ["REST with a negative tick", { ...rest, untilTick: -1 }],
    ["REST without untilTick", { type: "REST" }],
    ["WAKE with an extra key", { type: "WAKE", early: true }],
  ])("rejects %s", (_label, bad) => {
    expect(gameCommandSchema.safeParse(bad).success).toBe(false);
  });
});

describe("rejection reasons (ADR 0022 decision 3, ADR 0023 decision 3a)", () => {
  const reasons: RejectionReason[] = [
    { code: "NOT_PRESENT", requiredLocationId: ids.locSupplier, issuerLocationId: ids.locDistillery },
    { code: "NOT_PRESENT", requiredLocationId: ids.locSupplier, issuerLocationId: null },
    { code: "FOUNDER_BUSY", until: tick(630) },
    { code: "PLACE_CLOSED", locationId: ids.locHotel, opensAt: tick(1_200) },
    { code: "VEHICLE_NOT_AT", vehicleId: ids.truck, locationId: ids.locDistillery },
    { code: "NO_DRIVER", vehicleId: ids.truck },
    { code: "FOUNDER_AWAY", whereabouts: "RESTING" },
    { code: "ALREADY_THERE" },
    { code: "INVALID_PATH" },
    { code: "NO_PATH", destinationLocationId: ids.locHotel },
    { code: "INVALID_REST_LENGTH", min: tick(721), max: tick(1_441) },
    { code: "NOT_RESTING" },
  ];

  it("adds the shared presence codes and the founder commands' own codes", () => {
    const added = ["NOT_PRESENT", "FOUNDER_BUSY", "PLACE_CLOSED", "VEHICLE_NOT_AT", "NO_DRIVER", "FOUNDER_AWAY", "ALREADY_THERE", "INVALID_PATH", "NO_PATH", "INVALID_REST_LENGTH", "NOT_RESTING"] as const;
    expectTypeOf<(typeof added)[number]>().toExtend<RejectionCode>();
    expect(new Set(reasons.map((r) => r.code))).toEqual(new Set(added));
    // TRAVEL's other failures reuse existing codes (decision 3a).
    expectTypeOf<"UNKNOWN_ENTITY" | "ROUTE_CLOSED">().toExtend<RejectionCode>();
  });

  it.each(reasons.map((r) => [r.code, r] as const))("%s round-trips through JSON", (_code, reason) => {
    expect(rejectionReasonSchema.parse(roundTrip(reason))).toEqual(reason);
  });

  it.each([
    ["FOUNDER_AWAY while present", { code: "FOUNDER_AWAY", whereabouts: "PRESENT" }],
    ["FOUNDER_BUSY without until", { code: "FOUNDER_BUSY" }],
    ["PLACE_CLOSED with a minute of day", { code: "PLACE_CLOSED", locationId: ids.locHotel, opensAt: 12.5 }],
    ["VEHICLE_NOT_AT without the founder's place", { code: "VEHICLE_NOT_AT", vehicleId: ids.truck }],
    ["ALREADY_THERE with an extra key", { code: "ALREADY_THERE", locationId: ids.locDistillery }],
    ["INVALID_REST_LENGTH without max", { code: "INVALID_REST_LENGTH", min: 721 }],
  ])("rejects %s", (_label, bad) => {
    expect(rejectionReasonSchema.safeParse(bad).success).toBe(false);
  });
});

describe("FOUNDER_* events (decision 11)", () => {
  const meta = { id: asId("Event", "evt-50"), tick: tick(700), causedBy: asId("Command", "cmd-9") };
  const events: GameEvent[] = [
    { ...meta, type: "FOUNDER_DEPARTED", from: ids.locDistillery, to: ids.locSupplier, transport: { kind: "FOOT" } },
    { ...meta, type: "FOUNDER_ARRIVED", locationId: ids.locSupplier, causedBy: null },
    { ...meta, type: "FOUNDER_HALTED", routeId: ids.routeSpeakeasyMain, locationId: ids.locDistillery, causedBy: null },
    { ...meta, type: "FOUNDER_RESTED", locationId: ids.locDistillery, until: tick(1_200) },
    { ...meta, type: "FOUNDER_WOKE", locationId: ids.locDistillery, early: true },
  ];

  it.each(events.map((e) => [e.type, e] as const))("%s round-trips through JSON", (_type, event) => {
    expect(gameEventSchema.parse(roundTrip(event))).toEqual(event);
  });

  it("are logged, never toasted, and never news", () => {
    for (const e of events) {
      expect(EVENT_IMPORTANCE[e.type]).toBe("log");
      expect(EVENT_CONCERNS_PLACE[e.type]).toBeNull();
    }
  });

  it("rejects malformed payloads", () => {
    expect(gameEventSchema.safeParse({ ...events[0], transport: { kind: "HORSE" } }).success).toBe(false);
    expect(gameEventSchema.safeParse(withoutKey(events[4], "early")).success).toBe(false);
    expect(gameEventSchema.safeParse({ ...events[3], until: -5 }).success).toBe(false);
  });
});

describe("ACTIVITY_IMPORTANCE (decision 9)", () => {
  it("classifies every activity item kind, as notify or log", () => {
    expectTypeOf<keyof typeof ACTIVITY_IMPORTANCE>().toEqualTypeOf<ActivityItem["kind"]>();
    expect(Object.keys(ACTIVITY_IMPORTANCE).sort()).toEqual(["CASH_POSTING", "CATCH_UP", "COMMAND"]);
    for (const value of Object.values(ACTIVITY_IMPORTANCE)) expect(["notify", "log"]).toContain(value);
  });
});
