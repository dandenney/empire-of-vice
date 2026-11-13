// The knowledge contract (ADR 0021 decision 11): types, schemas, ordering and tags.

import { describe, expect, expectTypeOf, it } from "vitest";
import { day0Save, ids } from "../fixtures/index.ts";
import {
  asId,
  cents,
  compareKnowledgeSubjects,
  EMPTY_KNOWLEDGE,
  EVENT_CONCERNS_PLACE,
  gameEventSchema,
  knowledgeRecordSchema,
  knowledgeStateSchema,
  PARTY_KINDS,
  playerCommandResultSchema,
  playerSnapshotSchema,
  SOURCE_KINDS,
  SUBJECT_KINDS,
  catchUpLineSchema,
  tick,
  type ActivityItem,
  type CatchUp,
  type CommandResult,
  type EventOfType,
  type GameEvent,
  type KnowledgeRecord,
  type KnowledgeSource,
  type KnowledgeState,
  type KnowledgeSubject,
  type KnowledgeSubjectOf,
  type KnowledgeValue,
  type KnowledgeValueOf,
  type LocationOccupant,
  type NewsItem,
  type PartyKind,
  type PlaceTaggedEventType,
  type PlayerCommandResult,
  type PlayerSnapshot,
  type SourceKind,
  type SubjectKind,
} from "../src/index.ts";
import type { IsPlainData } from "./plain-data.ts";

const roundTrip = <T>(value: T): unknown => JSON.parse(JSON.stringify(value)) as unknown;

describe("knowledge types (ADR 0021 decision 4)", () => {
  it("are plain JSON-safe data with no optional fields", () => {
    expectTypeOf<IsPlainData<KnowledgeState>>().toEqualTypeOf<true>();
    expectTypeOf<IsPlainData<KnowledgeRecord>>().toEqualTypeOf<true>();
    expectTypeOf<IsPlainData<CatchUp>>().toEqualTypeOf<true>();
    expectTypeOf<IsPlainData<ActivityItem>>().toEqualTypeOf<true>();
    expectTypeOf<IsPlainData<NewsItem>>().toEqualTypeOf<true>();
    expectTypeOf<IsPlainData<PlayerSnapshot>>().toEqualTypeOf<true>();
    expectTypeOf<IsPlainData<PlayerCommandResult>>().toEqualTypeOf<true>();
  });

  it("lists every subject, source and party kind exactly once", () => {
    expectTypeOf<(typeof SUBJECT_KINDS)[number]>().toEqualTypeOf<KnowledgeValue["kind"]>();
    expectTypeOf<KnowledgeSubject["kind"]>().toEqualTypeOf<KnowledgeValue["kind"]>();
    expectTypeOf<(typeof SOURCE_KINDS)[number]>().toEqualTypeOf<SourceKind>();
    expectTypeOf<(typeof PARTY_KINDS)[number]>().toEqualTypeOf<LocationOccupant["kind"]>();
    expectTypeOf<PartyKind>().toEqualTypeOf<"FACILITY" | "SUPPLIER" | "BUYER">();
    for (const list of [SUBJECT_KINDS, SOURCE_KINDS, PARTY_KINDS]) expect(new Set(list).size).toBe(list.length);
  });

  it("gives every value its subject's key", () => {
    type KeyOf<K extends SubjectKind> = Pick<KnowledgeValueOf<K>, keyof KnowledgeSubjectOf<K>>;
    type AllMatch = { [K in SubjectKind]: KeyOf<K> extends KnowledgeSubjectOf<K> ? (KnowledgeSubjectOf<K> extends KeyOf<K> ? true : false) : false }[SubjectKind];
    expectTypeOf<AllMatch>().toEqualTypeOf<true>();
  });

  it("stores observed data only: no world-computed affordances", () => {
    expectTypeOf<KnowledgeValueOf<"BUYER_WANTS">["wants"][number]>().not.toHaveProperty("maxAcceptableQuantity");
    expectTypeOf<KnowledgeValueOf<"CONTRACT_OFFERS">["offers"][number]>().not.toHaveProperty("blockedBy");
    expectTypeOf<KnowledgeValueOf<"CONTRACT_PROGRESS">["installments"][number]>().not.toHaveProperty("inTransit");
  });

  it("player command results carry no event IDs (decision 2)", () => {
    expectTypeOf<Extract<PlayerCommandResult, { status: "applied" }>>().not.toHaveProperty("eventIds");
    expectTypeOf<PlayerCommandResult["status"]>().toEqualTypeOf<CommandResult["status"]>();
    const applied: PlayerCommandResult = { status: "applied", commandId: asId("Command", "cmd-3"), tick: tick(42) };
    expect(playerCommandResultSchema.parse(roundTrip(applied))).toEqual(applied);
    expect(playerCommandResultSchema.safeParse({ ...applied, eventIds: [] }).success).toBe(false);
  });

  it("starts empty", () => {
    expect(EMPTY_KNOWLEDGE).toEqual({ records: [], pendingNews: [], pendingBooks: [], activity: [], lastCatchUp: null, pendingMessages: [] });
    expect(knowledgeStateSchema.parse(roundTrip(EMPTY_KNOWLEDGE))).toEqual(EMPTY_KNOWLEDGE);
  });
});

describe("record order (decision 4)", () => {
  it("sorts by subject kind, then by key with compareIds", () => {
    const subjects: KnowledgeSubject[] = [
      { kind: "STANDING" },
      { kind: "CONTRACT_PROGRESS", contractId: asId("Contract", "contract-10") },
      { kind: "CONTRACT_PROGRESS", contractId: asId("Contract", "contract-9") },
      { kind: "MARKET_PRICES" },
      { kind: "FACILITY_STOCK", facilityId: ids.distillery },
      { kind: "FACILITY_OPERATIONS", facilityId: ids.barn },
      { kind: "FACILITY_STOCK", facilityId: ids.barn },
    ];
    expect([...subjects].sort(compareKnowledgeSubjects)).toEqual([
      { kind: "FACILITY_STOCK", facilityId: ids.distillery },
      { kind: "FACILITY_STOCK", facilityId: ids.barn },
      { kind: "FACILITY_OPERATIONS", facilityId: ids.barn },
      { kind: "CONTRACT_PROGRESS", contractId: asId("Contract", "contract-9") },
      { kind: "CONTRACT_PROGRESS", contractId: asId("Contract", "contract-10") },
      { kind: "MARKET_PRICES" },
      { kind: "STANDING" },
    ]);
  });
});

describe("news place tags (decision 7)", () => {
  it("tags facility events and road events, and nothing else", () => {
    expectTypeOf<PlaceTaggedEventType>().toEqualTypeOf<"PRODUCTION_FAILED" | "DELIVERY_DELAYED" | "DEAL_FELL_THROUGH" | "CARGO_LOST" | "ROUTE_FOUND_CLOSED">();
    const tagged = Object.entries(EVENT_CONCERNS_PLACE).filter(([, tag]) => tag !== null);
    expect(Object.fromEntries(tagged)).toEqual({
      PRODUCTION_FAILED: "FACILITY",
      DELIVERY_DELAYED: "DELIVERY_ORIGIN",
      DEAL_FELL_THROUGH: "DELIVERY_ORIGIN",
      CARGO_LOST: "DELIVERY_ORIGIN",
      // ADR 0022 decision 9: news at the delivery's origin facility.
      ROUTE_FOUND_CLOSED: "DELIVERY_ORIGIN",
    });
  });

  it("each tag names a field the event has", () => {
    type Tagged<Tag> = { [T in PlaceTaggedEventType]: (typeof EVENT_CONCERNS_PLACE)[T] extends Tag ? T : never }[PlaceTaggedEventType];
    expectTypeOf<EventOfType<Tagged<"FACILITY">>>().toHaveProperty("facilityId");
    expectTypeOf<EventOfType<Tagged<"DELIVERY_ORIGIN">>>().toHaveProperty("deliveryId");
  });
});

// A state with every part of knowledge in use.
const millers: KnowledgeSource = { kind: "IN_PERSON", locationId: ids.locSupplier };
const standing = { kind: "STANDING", reputation: 4, tierId: ids.tierStart, unlocked: [ids.unlockSpot] } as const;
const delayed: NewsItem = {
  tick: tick(700),
  event: {
    type: "DELIVERY_DELAYED",
    deliveryId: asId("Delivery", "delivery-2"),
    routeId: ids.routeSpeakeasyBack,
    previousArrivesAt: tick(760),
    arrivesAt: tick(1_000),
  },
};
const lost: NewsItem = {
  tick: tick(720),
  event: {
    type: "CARGO_LOST",
    deliveryId: asId("Delivery", "delivery-3"),
    vehicleId: ids.truck,
    cargo: [{ productId: ids.moonshine, quality: "basic", quantity: 8 }],
    bookValue: cents(6_400),
    transactionId: asId("Transaction", "txn-14"),
  },
};
const catchUp: CatchUp = {
  locationId: ids.locDistillery,
  tick: tick(900),
  sinceTick: tick(600),
  lines: [
    {
      subject: { kind: "FACILITY_OPERATIONS", facilityId: ids.distillery },
      before: { kind: "FACILITY_OPERATIONS", facilityId: ids.distillery, jobs: [], workersPresent: 3 },
      after: { kind: "FACILITY_OPERATIONS", facilityId: ids.distillery, jobs: [], workersPresent: 2 },
    },
  ],
  news: [delayed],
  droppedNews: 1,
};
const rich: KnowledgeState = {
  records: [
    {
      subject: { kind: "VEHICLE_WHEREABOUTS", vehicleId: ids.truck },
      value: {
        kind: "VEHICLE_WHEREABOUTS",
        vehicleId: ids.truck,
        parkedAt: null,
        trip: {
          deliveryId: asId("Delivery", "delivery-3"),
          routeId: ids.routeSpeakeasyBack,
          leg: "OUTBOUND",
          departedAt: tick(650),
          arrivesAt: tick(760),
          cargo: [{ productId: ids.moonshine, quality: "basic", quantity: 8 }],
          purpose: { kind: "SALE", buyerId: ids.speakeasy, dealId: asId("Deal", "deal-2") },
          delayed: false,
        },
      },
      learnedAt: tick(650),
      source: { kind: "IN_PERSON", locationId: ids.locDistillery },
    },
    {
      subject: { kind: "ROUTE_CONDITION", routeId: ids.routeSpeakeasyMain },
      value: { kind: "ROUTE_CONDITION", routeId: ids.routeSpeakeasyMain, status: { open: false, reopensAt: null, reason: "RIVAL" } },
      learnedAt: tick(800),
      source: { kind: "PHONE", partyLocationId: ids.locSpeakeasy },
    },
    { subject: { kind: "STANDING" }, value: standing, learnedAt: tick(600), source: millers },
  ],
  pendingNews: [{ locationId: ids.locDistillery, items: [lost], dropped: 0 }],
  pendingBooks: [
    { transactionId: asId("Transaction", "txn-14"), concerns: { kind: "NEWS", locationId: ids.locDistillery } },
    { transactionId: asId("Transaction", "txn-15"), concerns: { kind: "FACILITY_STOCK", facilityId: ids.barn } },
  ],
  activity: [
    { kind: "CATCH_UP", tick: tick(900), locationId: ids.locDistillery, sinceTick: tick(600) },
    {
      kind: "CASH_POSTING",
      tick: tick(910),
      producer: "LOSS:SHAKEDOWN",
      cashChange: cents(-5_000),
      revealed: [],
      news: [],
    },
    {
      kind: "COMMAND",
      tick: tick(911),
      command: { type: "SET_WORKFORCE", facilityId: ids.distillery, workerCount: 9 },
      status: "REJECTED",
      reason: { code: "WORKFORCE_LIMIT_EXCEEDED", facilityId: ids.distillery, requested: 9, maximum: 6 },
    },
  ],
  lastCatchUp: catchUp,
  // ADR 0024 decision 6: Kessler called the feed store while the founder was out.
  pendingMessages: [
    {
      locationId: ids.locSupplier,
      items: [
        {
          takenAt: tick(840),
          callerLocationId: ids.locSpeakeasy,
          takenBy: null,
          reason: "NEW_CONTRACT_OFFER",
          values: [{ subject: { kind: "CONTRACT_OFFERS", buyerId: ids.speakeasy }, value: { kind: "CONTRACT_OFFERS", buyerId: ids.speakeasy, offers: [] } }],
        },
      ],
      dropped: 0,
    },
  ],
};

describe("knowledge schemas", () => {
  it("round-trip a state with every part in use", () => {
    expect(knowledgeStateSchema.parse(roundTrip(rich))).toEqual(rich);
    expect(knowledgeStateSchema.parse(roundTrip(day0Save.state.knowledge))).toEqual(day0Save.state.knowledge);
  });

  it("reject a record whose value doesn't belong to its subject", () => {
    const [truck] = rich.records;
    const otherKind: KnowledgeRecord = { ...truck!, value: standing };
    expect(knowledgeRecordSchema.safeParse(roundTrip(otherKind)).success).toBe(false);
    const otherKey = { ...truck!, subject: { kind: "VEHICLE_WHEREABOUTS", vehicleId: "another-truck" } };
    expect(knowledgeRecordSchema.safeParse(roundTrip(otherKey)).success).toBe(false);
    expect(catchUpLineSchema.safeParse(roundTrip({ ...catchUp.lines[0], before: standing })).success).toBe(false);
  });

  it.each([
    ["an unknown subject kind", { ...rich, records: [{ ...rich.records[2], subject: { kind: "RUMOURS" } }] }],
    ["a fractional learnedAt", { ...rich, records: [{ ...rich.records[2], learnedAt: 1.5 }] }],
    ["an unknown source", { ...rich, records: [{ ...rich.records[2], source: { kind: "PIGEON" } }] }],
    ["negative dropped news", { ...rich, pendingNews: [{ ...rich.pendingNews[0], dropped: -1 }] }],
    ["an unknown producer", { ...rich, activity: [{ ...rich.activity[1], producer: "BRIBE" }] }],
    ["a news item that isn't place news", { ...rich, pendingNews: [{ ...rich.pendingNews[0], items: [{ tick: 1, event: { type: "MARKET_UPDATED", dayIndex: 1 } }] }] }],
    ["an optional field left out", { ...rich, lastCatchUp: undefined }],
  ])("reject %s", (_label, bad) => {
    expect(knowledgeStateSchema.safeParse(roundTrip(bad)).success).toBe(false);
  });

  it("accept KNOWLEDGE_CAUGHT_UP with the catch-up's content", () => {
    const { locationId, sinceTick, lines, news, droppedNews } = catchUp;
    const event: GameEvent = {
      id: asId("Event", "evt-40"),
      tick: catchUp.tick,
      causedBy: null,
      type: "KNOWLEDGE_CAUGHT_UP",
      locationId,
      sinceTick,
      lines,
      news,
      droppedNews,
    };
    expect(gameEventSchema.parse(roundTrip(event))).toEqual(event);
    expect(gameEventSchema.safeParse({ ...event, lines: undefined }).success).toBe(false);
  });
});

describe("player snapshot schema (decision 8)", () => {
  const known = <T>(value: T, source: KnowledgeSource = millers) => ({ value, learnedAt: tick(600), source });
  const snapshot: PlayerSnapshot = {
    clock: { tick: tick(900), dayIndex: 0, date: { year: 1920, month: 1, day: 17, hour: 15, minute: 0 } },
    outcome: { status: "PLAYING" },
    founder: {
      whereabouts: { kind: "PRESENT", locationId: ids.locDistillery, busy: { activity: "START_BATCH", until: tick(920) }, call: null },
      awakeSince: tick(360),
      room: null,
      tired: false,
      currentLeg: null,
    },
    here: ids.locDistillery,
    places: [
      {
        kind: "FACILITY",
        id: ids.locDistillery,
        name: "Hollow Creek",
        position: { x: 10, y: -4 },
        phone: null,
        arrangement: null,
        rooms: null,
        facility: {
          id: ids.distillery,
          name: "The Still",
          kind: "DISTILLERY",
          equipment: [{ id: ids.copperStill, name: "Copper still", bookValue: cents(30_000), resaleValue: cents(15_000) }],
          equipmentSlots: { used: 1, total: 3 },
          equipmentOptions: [
            { equipmentId: ids.condenser, name: "Condenser", description: "Faster", price: cents(35_000), blockedBy: { code: "LOCKED", unlockId: ids.unlockSpot } },
          ],
          workforce: { workers: 3, maximum: 6, dailyWagePerWorker: cents(300) },
          productionCapacityPerDay: 12,
          recipes: [
            {
              recipeId: ids.basicRecipe,
              name: "Basic",
              productId: ids.moonshine,
              quality: "basic",
              inputsPerCase: [{ materialId: ids.corn, quantity: 4 }],
              ticksPerCase: 60,
              maxStartableQuantity: 10,
              blockedBy: null,
            },
          ],
          storageCapacity: 200,
          stock: known({ kind: "FACILITY_STOCK", facilityId: ids.distillery, products: [], materials: [], storageUsed: 0 }),
          operations: null,
        },
      },
      {
        kind: "BUYER",
        id: ids.locSpeakeasy,
        name: "Kessler's",
        position: { x: 0, y: 0 },
        // Kessler's private line: he answers for business, the founder never uses it (ADR 0027 decision 2).
        phone: {
          familyLine: false,
          use: { rule: "PRIVATE", allowed: false },
          callCharge: cents(5),
          open: true,
          opensAt: null,
          takesMessages: false,
        },
        arrangement: null,
        rooms: null,
        buyer: {
          id: ids.speakeasy,
          name: "Kessler's back room",
          minimumReputation: 0,
          wants: known({
            kind: "BUYER_WANTS",
            buyerId: ids.speakeasy,
            willDeal: true,
            wants: [
              { productId: ids.moonshine, productName: "Moonshine", minimumQuality: "basic", unitPrice: cents(1_520), demandRemaining: 20, maxAcceptableQuantity: 20 },
            ],
          }, { kind: "PHONE", partyLocationId: ids.locSpeakeasy }),
          budget: null,
          offers: null,
        },
      },
      {
        kind: "SUPPLIER",
        id: ids.locSupplier,
        name: "Miller's",
        position: { x: 3, y: 3 },
        phone: {
          familyLine: false,
          use: { rule: "ARRANGEMENT", allowed: true },
          callCharge: cents(5),
          open: true,
          opensAt: null,
          takesMessages: false,
        },
        arrangement: {
          contactName: "Miller",
          dealingDays: 1,
          holdsUntil: tick(10_621),
          lapsed: false,
          milestones: [
            { privilege: "PHONE_USE", dealingDaysNeeded: 1, granted: true },
            { privilege: "TAKES_MESSAGES", dealingDaysNeeded: 3, granted: false },
          ],
        },
        rooms: null,
        supplier: { id: ids.supplier, name: "Miller's Feed", offer: null },
      },
      // A place with a phone and no occupant (ADR 0024 decision 1): the hotel lobby, closed at night.
      {
        kind: "NONE",
        id: ids.locHotel,
        name: "Lakeview",
        position: { x: 38, y: 18 },
        phone: {
          familyLine: false,
          use: { rule: "GUEST", allowed: false },
          callCharge: cents(5),
          open: false,
          opensAt: tick(1_860),
          takesMessages: false,
        },
        arrangement: null,
        rooms: { nightlyRate: cents(200), deskOpen: false, deskOpensAt: tick(1_860) },
      },
    ],
    routes: [
      {
        id: ids.routeSpeakeasyMain,
        name: "County Road",
        fromLocationId: ids.locDistillery,
        toLocationId: ids.locSpeakeasy,
        waypoints: [{ x: 10, y: -4 }, { x: 0, y: 0 }],
        durationTicks: 120,
        transportCost: cents(800),
        riskPpm: 0,
        condition: null,
      },
    ],
    vehicles: [{ id: ids.truck, name: "Model TT", capacity: 20, homeLocationId: ids.locDistillery, whereabouts: null }],
    market: null,
    standing: known(standing),
    contracts: [
      {
        id: asId("Contract", "contract-1"),
        buyerId: ids.speakeasy,
        buyerName: "Kessler's back room",
        productId: ids.moonshine,
        productName: "Moonshine",
        minimumQuality: "basic",
        quantityPerInstallment: 10,
        unitPrice: cents(1_600),
        installmentCount: 3,
        intervalTicks: 2_880,
        penaltyRatePpm: 200_000,
        progress: known({
          kind: "CONTRACT_PROGRESS",
          contractId: asId("Contract", "contract-1"),
          status: "ACTIVE",
          installments: [{ index: 0, deadline: tick(3_000), required: 10, delivered: 0, inTransit: 8, outcome: null, penalty: null }],
        }),
      },
    ],
    deals: [
      {
        id: asId("Deal", "deal-2"),
        buyerId: ids.speakeasy,
        productId: ids.moonshine,
        quality: "basic",
        quantity: 8,
        unitPrice: cents(1_520),
        agreedAt: tick(640),
        expiresAt: tick(3_520),
        budgetCommitted: true,
        status: "DISPATCHED",
        deliveryId: asId("Delivery", "delivery-3"),
      },
      {
        id: asId("Deal", "deal-3"),
        buyerId: ids.speakeasy,
        productId: ids.moonshine,
        quality: "basic",
        quantity: 4,
        unitPrice: cents(1_520),
        agreedAt: tick(880),
        expiresAt: tick(3_760),
        budgetCommitted: false,
        status: "HELD",
        deliveryId: null,
      },
    ],
    finance: {
      cash: cents(120_000),
      books: [
        {
          tick: tick(541),
          kind: "MATERIAL_PURCHASE",
          cashFlowCategory: "MATERIALS",
          entries: [
            { account: "RAW_MATERIALS", side: "DEBIT", amount: cents(10_000) },
            { account: "CASH", side: "CREDIT", amount: cents(10_000) },
          ],
        },
      ],
      knownNetWorth: { amount: cents(160_000), asOf: tick(600) },
      victory: {
        netWorth: { current: cents(160_000), target: cents(500_000) },
        reputation: { current: 4, target: 30 },
        completedContracts: { current: 0, target: 1 },
      },
    },
    activity: rich.activity,
    catchUp,
  };

  it("round-trips a player snapshot", () => {
    expect(playerSnapshotSchema.parse(roundTrip(snapshot))).toEqual(snapshot);
  });

  it.each([
    ["a world event feed", { ...snapshot, recentEvents: [] }],
    ["a book row with an idempotency key", { ...snapshot, finance: { ...snapshot.finance, books: [{ ...snapshot.finance.books[0], idempotencyKey: "MATERIAL_PURCHASE:cmd-1" }] } }],
    ["a stored affordance missing", { ...snapshot, contracts: [{ ...snapshot.contracts[0], progress: { ...snapshot.contracts[0]!.progress, value: { ...snapshot.contracts[0]!.progress!.value, installments: [{ index: 0, deadline: 3_000, required: 10, delivered: 0, outcome: null, penalty: null }] } } }] }],
    // The player's list shows only what the founder knows: never a world-side terminal status (ADR 0022 round-3 follow-up).
    ["a deal shown SETTLED", { ...snapshot, deals: [{ ...snapshot.deals[0], status: "SETTLED" }] }],
    ["no deal list", withoutDeals(snapshot)],
    // ADR 0027 decision 12: no `public`, no `holdsMessages`, and never whether messages are waiting.
    ["a phone with ADR 0024's public flag", { ...snapshot, places: [{ ...snapshot.places[1], phone: { ...snapshot.places[1]!.phone, public: false } }] }],
    ["a phone showing messages waiting", { ...snapshot, places: [{ ...snapshot.places[2], phone: { ...snapshot.places[2]!.phone, messagesWaiting: 1 } }] }],
    ["a place without its phone field", { ...snapshot, places: [Object.fromEntries(Object.entries(snapshot.places[3]!).filter(([k]) => k !== "phone"))] }],
    ["an unknown use rule", { ...snapshot, places: [{ ...snapshot.places[2], phone: { ...snapshot.places[2]!.phone, use: { rule: "BORROWED", allowed: true } } }] }],
    ["an unknown privilege", { ...snapshot, places: [{ ...snapshot.places[2], arrangement: { ...snapshot.places[2]!.arrangement, milestones: [{ privilege: "CREDIT", dealingDaysNeeded: 5, granted: false }] } }] }],
  ])("rejects %s", (_label, bad) => {
    expect(playerSnapshotSchema.safeParse(roundTrip(bad)).success).toBe(false);
  });
});

function withoutDeals(snapshot: PlayerSnapshot): Record<string, unknown> {
  return Object.fromEntries(Object.entries(snapshot).filter(([key]) => key !== "deals"));
}
