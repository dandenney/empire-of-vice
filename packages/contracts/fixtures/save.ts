// A valid save at 10:00 on day 0. The player has bought 40 corn ($100) and queued
// a sugar purchase for tomorrow morning; a sugar shortage is scheduled for day 2.
// Exercises every top-level part of GameState for schema round-trip tests.
// PLACEHOLDER content (see world.ts).

import {
  asId,
  cents,
  ratio,
  RATIO_ONE,
  SAVE_FORMAT,
  SAVE_SCHEMA_VERSION,
  tick,
  type CommandEnvelope,
  type SaveFile,
  type SaveGame,
} from "../src/index.ts";
import { ids, opening } from "./world.ts";

const buyCorn: CommandEnvelope = {
  id: asId("Command", "cmd-1"),
  scheduledTick: tick(541),
  sequence: 1,
  issuer: { kind: "FOUNDER" },
  command: {
    type: "PURCHASE_MATERIALS",
    supplierId: ids.supplier,
    materialId: ids.corn,
    quantity: 40,
    facilityId: ids.distillery,
  },
};

const buySugarTomorrow: CommandEnvelope = {
  id: asId("Command", "cmd-2"),
  scheduledTick: tick(1_920),
  sequence: 2,
  issuer: { kind: "FOUNDER" },
  command: {
    type: "PURCHASE_MATERIALS",
    supplierId: ids.supplier,
    materialId: ids.sugar,
    quantity: 20,
    facilityId: ids.distillery,
  },
};

const rng = (a: number) => ({ algorithm: "xoshiro128**" as const, words: [a, a + 1, a + 2, a + 3] as const });

export const day0Save: SaveGame = {
  format: SAVE_FORMAT,
  schemaVersion: SAVE_SCHEMA_VERSION,
  scenarioId: ids.scenario,
  gameDataVersion: "0.0.0-fixture",
  state: {
    scenarioId: ids.scenario,
    seed: 1920,
    tick: tick(600),
    outcome: { status: "PLAYING" },
    counters: {
      nextCommandSequence: 3,
      nextScheduleSequence: 2,
      nextId: {
        Command: 3,
        Event: 2,
        Transaction: 3,
        ProductionJob: 1,
        Delivery: 1,
        ContractOffer: 1,
        Contract: 1,
        Reservation: 1,
        Deal: 1,
        StandingOrder: 1,
      },
    },
    rng: { market: rng(1_001), contracts: rng(2_002), routes: rng(3_003), production: rng(4_004) },
    family: {
      id: ids.family,
      reputation: 0,
      tierId: ids.tierStart,
      unlocked: [ids.unlockSpot],
      firstQualifyingDeliveryMade: false,
      consecutiveFulfilledInstallments: 0,
    },
    facilities: [
      { id: ids.distillery, equipment: [{ equipmentId: ids.copperStill, bookValue: opening.copperStill }], workerCount: 3, phoneLine: null },
      { id: ids.barn, equipment: [], workerCount: 0, phoneLine: null },
    ],
    productPools: [],
    materialPools: [{ facilityId: ids.distillery, materialId: ids.corn, quantity: 40, totalCost: cents(10_000) }],
    reservations: [],
    productionJobs: [],
    vehicles: [{ id: ids.truck, parkedAt: ids.locDistillery, tripCount: 0, trip: null }],
    deliveries: [],
    heldDeals: [],
    markets: [
      { productId: ids.moonshine, quality: "basic", demand: 30, supply: 30, eventRatio: RATIO_ONE, spotPrice: cents(1_400), previousSpotPrice: null },
      { productId: ids.moonshine, quality: "standard", demand: 12, supply: 12, eventRatio: RATIO_ONE, spotPrice: cents(2_000), previousSpotPrice: null },
    ],
    suppliers: [
      {
        id: ids.supplier,
        stock: [
          { materialId: ids.corn, available: 160, unitPrice: cents(250), shortage: null },
          { materialId: ids.sugar, available: 100, unitPrice: cents(200), shortage: null },
        ],
      },
    ],
    buyers: [
      {
        id: ids.roadhouse,
        budgetRemaining: cents(30_000),
        wants: [{ productId: ids.moonshine, minimumQuality: "basic", unitPrice: cents(1_400), demandRemaining: 15 }],
        commitments: [],
      },
      {
        id: ids.speakeasy,
        budgetRemaining: cents(45_000),
        wants: [{ productId: ids.moonshine, minimumQuality: "basic", unitPrice: cents(1_520), demandRemaining: 20 }],
        commitments: [],
      },
      {
        id: ids.hotel,
        budgetRemaining: cents(60_000),
        wants: [{ productId: ids.moonshine, minimumQuality: "standard", unitPrice: cents(2_300), demandRemaining: 12 }],
        commitments: [],
      },
    ],
    routes: [
      { id: ids.routeSpeakeasyBack, closure: null },
      { id: ids.routeSpeakeasyMain, closure: null },
      { id: ids.routeBarn, closure: null },
      { id: ids.routeHotel, closure: null },
      { id: ids.routeSupplier, closure: null },
      { id: ids.routeRoadhouse, closure: null },
    ],
    contractOffers: [],
    contracts: [],
    ledger: {
      transactions: [
        {
          id: asId("Transaction", "txn-1"),
          tick: tick(0),
          kind: "OPENING_BALANCE",
          idempotencyKey: "OPENING_BALANCE:first-shipment",
          entries: [
            { account: "CASH", side: "DEBIT", amount: opening.cash },
            { account: "EQUIPMENT", side: "DEBIT", amount: opening.copperStill },
            { account: "VEHICLES", side: "DEBIT", amount: opening.truck },
            { account: "FACILITIES", side: "DEBIT", amount: opening.buildings },
            { account: "OWNER_EQUITY", side: "CREDIT", amount: opening.equity },
          ],
          eventIds: [],
        },
        {
          id: asId("Transaction", "txn-2"),
          tick: tick(541),
          kind: "MATERIAL_PURCHASE",
          idempotencyKey: "MATERIAL_PURCHASE:cmd-1",
          entries: [
            { account: "RAW_MATERIALS", side: "DEBIT", amount: cents(10_000) },
            { account: "CASH", side: "CREDIT", amount: cents(10_000) },
          ],
          eventIds: [asId("Event", "evt-1")],
        },
      ],
    },
    queuedCommands: [buySugarTomorrow],
    commandLog: [buyCorn],
    scheduledEvents: [
      {
        tick: tick(2_880),
        sequence: 1,
        kind: "SHORTAGE_START",
        supplierId: ids.supplier,
        materialId: ids.sugar,
        supplyRatio: ratio(400_000),
        durationTicks: 2_880,
      },
    ],
    eventJournal: [
      {
        id: asId("Event", "evt-1"),
        tick: tick(541),
        causedBy: buyCorn.id,
        type: "MATERIALS_PURCHASED",
        supplierId: ids.supplier,
        materialId: ids.corn,
        quantity: 40,
        unitPrice: cents(250),
        total: cents(10_000),
        facilityId: ids.distillery,
        transactionId: asId("Transaction", "txn-2"),
      },
    ],
    // The founder caught up at the feed store at 09:00 and bought the corn there (ADR 0021).
    knowledge: {
      records: [
        {
          subject: { kind: "SUPPLIER_OFFER", supplierId: ids.supplier },
          value: {
            kind: "SUPPLIER_OFFER",
            supplierId: ids.supplier,
            materials: [
              { materialId: ids.corn, materialName: "Corn", unitPrice: cents(250), available: 160, shortage: false },
              { materialId: ids.sugar, materialName: "Sugar", unitPrice: cents(200), available: 100, shortage: false },
            ],
          },
          learnedAt: tick(541),
          source: { kind: "IN_PERSON", locationId: ids.locSupplier },
        },
        {
          subject: { kind: "STANDING" },
          value: { kind: "STANDING", reputation: 0, tierId: ids.tierStart, unlocked: [ids.unlockSpot] },
          learnedAt: tick(541),
          source: { kind: "IN_PERSON", locationId: ids.locSupplier },
        },
      ],
      pendingNews: [],
      pendingBooks: [],
      activity: [
        { kind: "CATCH_UP", tick: tick(540), locationId: ids.locSupplier, sinceTick: null },
        { kind: "COMMAND", tick: tick(541), command: buyCorn.command, status: "APPLIED", reason: null },
        // The first sack earns the use of the feed store's phone (ADR 0027 decision 3).
        { kind: "ARRANGEMENT_GRANTED", tick: tick(541), locationId: ids.locSupplier, privilege: "PHONE_USE" },
      ],
      lastCatchUp: {
        locationId: ids.locSupplier,
        tick: tick(540),
        sinceTick: null,
        lines: [
          {
            subject: { kind: "STANDING" },
            before: null,
            after: { kind: "STANDING", reputation: 0, tierId: ids.tierStart, unlocked: [ids.unlockSpot] },
          },
        ],
        news: [],
        droppedNews: 0,
      },
      pendingMessages: [],
    },
    // Up at 06:00, and still at the feed store after buying the corn (ADR 0023).
    founder: {
      whereabouts: { kind: "PRESENT", locationId: ids.locSupplier, busy: null, call: null },
      awakeSince: tick(360),
      room: null,
    },
    // One day of dealings at the feed store, counted inside the purchase (ADR 0027 decision 3).
    arrangements: [{ locationId: ids.locSupplier, dealingDays: 1, lastDealingAt: tick(541) }],
    // No one hired yet (ADR 0025); test/employees.test.ts exercises the shapes.
    employees: [],
    formerEmployees: [],
  },
};

export const day0SaveFile: SaveFile = {
  save: day0Save,
  meta: { slot: "autosave", label: "Day 1, 10:00", savedAt: "2026-11-04T18:30:00.000Z", appVersion: "0.0.0-fixture" },
  stateHash: "fixture-hash-not-computed",
};
