// The employee contract (ADR 0025 decision 16, as restated by ADR 0028 decision 11; task EM1, #210).

import { describe, expect, expectTypeOf, it } from "vitest";
import { day0Save, ids } from "../fixtures/index.ts";
import {
  ACTIVITY_IMPORTANCE,
  ACTIVITY_KINDS,
  activityItemSchema,
  asId,
  cents,
  commandEnvelopeSchema,
  commandIssuerSchema,
  compareIds,
  compareKnowledgeSubjects,
  DYNAMIC_ID_KINDS,
  DYNAMIC_ID_PREFIXES,
  EMPLOYEE_ROLES,
  EVENT_CONCERNS_PLACE,
  EVENT_IMPORTANCE,
  GAME_COMMAND_TYPES,
  gameCommandSchema,
  gameEventSchema,
  gameStateSchema,
  knowledgeRecordSchema,
  knowledgeSubjectKey,
  playerEmployeeSchema,
  playerHiringSchema,
  rejectionReasonSchema,
  saveGameSchema,
  SUBJECT_KINDS,
  tick,
  TRANSACTION_PRODUCERS,
  transactionProducerOf,
  type ActivityItem,
  type BatchLimit,
  type CallInReason,
  type CommandEnvelope,
  type CommandIssuer,
  type CompetenceBand,
  type DeliveredMessage,
  type EmployeeSnapshot,
  type EmployeeState,
  type GameCommand,
  type GameEvent,
  type HeldMessage,
  type HoldReason,
  type KnowledgeRecord,
  type PlayerEmployee,
  type PlayerHiring,
  type RejectionReason,
  type RepeatableCommand,
  type ReportContent,
  type ReportLine,
  type StandingOrderTerms,
  type TransactionKind,
} from "../src/index.ts";
import type { IsPlainData } from "./plain-data.ts";

const roundTrip = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

const walt = ids.foreman;
const eddie = asId("Character", "eddie-novak");
const order1 = asId("StandingOrder", "standing-1");
const order2 = asId("StandingOrder", "standing-2");

const terms: StandingOrderTerms = {
  kind: "DISTILL",
  recipeId: ids.basicRecipe,
  keepOnHand: 20,
  batchSize: 10,
  spendingCap: cents(30_000),
  callWhen: "PROBLEMS",
};

const startProduction: GameCommand = { type: "START_PRODUCTION", facilityId: ids.distillery, recipeId: ids.basicRecipe, quantity: 4 };

/** One line of every kind, and a short batch for each BatchLimit. */
const lines: ReportLine[] = [
  { kind: "BATCH_STARTED", tick: tick(700), standingOrderId: order2, recipeId: ids.basicRecipe, quantity: 10, conversionCost: cents(4_000), limitedBy: null },
  { kind: "BATCH_STARTED", tick: tick(701), standingOrderId: order2, recipeId: ids.basicRecipe, quantity: 3, conversionCost: cents(1_200), limitedBy: { kind: "STORAGE" } },
  {
    kind: "BATCH_STARTED",
    tick: tick(702),
    standingOrderId: order2,
    recipeId: ids.basicRecipe,
    quantity: 4,
    conversionCost: cents(1_600),
    limitedBy: { kind: "MATERIALS", materialId: ids.corn },
  },
  { kind: "BATCH_STARTED", tick: tick(703), standingOrderId: order2, recipeId: ids.basicRecipe, quantity: 2, conversionCost: cents(800), limitedBy: { kind: "CASH" } },
  { kind: "BATCH_STARTED", tick: tick(704), standingOrderId: order2, recipeId: ids.basicRecipe, quantity: 1, conversionCost: cents(400), limitedBy: { kind: "SPENDING_CAP" } },
  { kind: "BATCH_FINISHED", tick: tick(900), recipeId: ids.basicRecipe, quantity: 10, outcome: "COMPLETED" },
  { kind: "BATCH_FINISHED", tick: tick(901), recipeId: ids.basicRecipe, quantity: 4, outcome: "FAILED" },
  { kind: "HELD_BACK", tick: tick(902), standingOrderId: order2, hold: { kind: "RECIPE_NOT_SUPPORTED" } },
  { kind: "HELD_BACK", tick: tick(903), standingOrderId: order2, hold: { kind: "NO_STORAGE" } },
  { kind: "HELD_BACK", tick: tick(904), standingOrderId: order2, hold: { kind: "NO_MATERIALS", materialId: ids.corn } },
  { kind: "HELD_BACK", tick: tick(905), standingOrderId: order2, hold: { kind: "NO_CASH" } },
  { kind: "HELD_BACK", tick: tick(906), standingOrderId: order2, hold: { kind: "SPENDING_CAP" } },
  {
    kind: "ORDER_REFUSED",
    tick: tick(907),
    standingOrderId: order2,
    command: startProduction,
    reason: { code: "OUTSIDE_AUTHORITY", characterId: walt, standingOrderId: order2, limit: "SPENDING_CAP" },
  },
  { kind: "ORDER_REFUSED", tick: tick(908), standingOrderId: order2, command: startProduction, reason: { code: "INSUFFICIENT_FUNDS", required: cents(1_600), available: cents(100) } },
];

const report: ReportContent = { characterId: walt, lines: lines.slice(5, 8), dropped: 2 };

const employee: EmployeeState = {
  characterId: walt,
  role: "DISTILLER",
  stationId: ids.distillery,
  dailyWage: cents(450),
  hiredAt: tick(541),
  startsAt: tick(661),
  competenceEstimate: { low: 40, high: 70 },
  standingOrder: { id: order2, givenAt: tick(600), terms },
  competence: 55,
  reliability: 50,
  loyalty: 50,
  work: {
    currentJobId: asId("ProductionJob", "job-3"),
    batchesRun: 2,
    lastHold: { kind: "NO_MATERIALS", materialId: ids.corn },
    lastRefusal: { code: "INSUFFICIENT_FUNDS", required: cents(1_600), available: cents(100) },
    spending: { periodIndex: 0, spent: cents(5_600) },
  },
  report: { lines, dropped: 3, callPending: true },
};

const heldReport: HeldMessage = {
  takenAt: tick(960),
  callerLocationId: ids.locDistillery,
  takenBy: null,
  reason: "EMPLOYEE_REPORT",
  values: [
    {
      subject: { kind: "EMPLOYEE_PERFORMANCE", characterId: walt },
      value: { kind: "EMPLOYEE_PERFORMANCE", characterId: walt, batchesRun: 2, competence: 55 },
    },
  ],
  report,
};

const deliveredReport: DeliveredMessage = {
  takenAt: tick(960),
  heldAtLocationId: ids.locSupplier,
  callerLocationId: ids.locDistillery,
  takenBy: null,
  reason: "EMPLOYEE_REPORT",
  subjects: [{ kind: "EMPLOYEE_PERFORMANCE", characterId: walt }],
  report,
};

const reportItems: ActivityItem[] = [
  { kind: "REPORT", tick: tick(1_000), characterId: walt, via: "IN_PERSON", report, atArrival: true },
  { kind: "REPORT", tick: tick(1_001), characterId: walt, via: "CALL_OUT", report, atArrival: false },
  { kind: "REPORT", tick: tick(1_002), characterId: walt, via: "CALL_IN", report: { characterId: walt, lines: [], dropped: 4 }, atArrival: false },
  { kind: "MESSAGE_DELIVERED", tick: tick(1_003), message: deliveredReport },
];

/** day0Save's state with an employee, a former employee, a report message and report items in use. */
const staffed = {
  ...day0Save.state,
  counters: { ...day0Save.state.counters, nextId: { ...day0Save.state.counters.nextId, StandingOrder: 3 } },
  knowledge: {
    ...day0Save.state.knowledge,
    activity: [...day0Save.state.knowledge.activity, ...reportItems],
    pendingMessages: [{ locationId: ids.locSupplier, items: [heldReport], dropped: 0 }],
  },
  employees: [employee],
  formerEmployees: [{ characterId: eddie, batchesRun: 5 }],
};

describe("shapes (ADR 0028 decision 11)", () => {
  it("are plain JSON-safe data with no optional fields", () => {
    expectTypeOf<IsPlainData<EmployeeState>>().toEqualTypeOf<true>();
    expectTypeOf<IsPlainData<EmployeeSnapshot>>().toEqualTypeOf<true>();
    expectTypeOf<IsPlainData<ReportLine>>().toEqualTypeOf<true>();
    expectTypeOf<IsPlainData<PlayerEmployee>>().toEqualTypeOf<true>();
    expectTypeOf<IsPlainData<PlayerHiring>>().toEqualTypeOf<true>();
    expectTypeOf<IsPlainData<HeldMessage>>().toEqualTypeOf<true>();
  });

  it("has the Distiller as M002's only role, the four bands, and DISTILL as the only order", () => {
    expect(EMPLOYEE_ROLES).toEqual(["DISTILLER"]);
    expectTypeOf<CompetenceBand>().toEqualTypeOf<"LOW" | "MODERATE" | "HIGH" | "UNCERTAIN">();
    expectTypeOf<StandingOrderTerms["kind"]>().toEqualTypeOf<"DISTILL">();
  });

  it("issues employee commands outside the envelope: CommandIssuer has EMPLOYEE, an envelope only FOUNDER", () => {
    expectTypeOf<CommandIssuer["kind"]>().toEqualTypeOf<"FOUNDER" | "EMPLOYEE">();
    expectTypeOf<CommandEnvelope["issuer"]>().toEqualTypeOf<{ readonly kind: "FOUNDER" }>();
    const employeeIssuer: CommandIssuer = { kind: "EMPLOYEE", characterId: walt, standingOrderId: order1 };
    expect(commandIssuerSchema.parse(roundTrip(employeeIssuer))).toEqual(employeeIssuer);
    const envelope = { id: asId("Command", "cmd-9"), scheduledTick: tick(9), sequence: 9, issuer: employeeIssuer, command: startProduction };
    expect(commandEnvelopeSchema.safeParse(roundTrip(envelope)).success).toBe(false);
    expect(commandEnvelopeSchema.safeParse(roundTrip({ ...envelope, issuer: { kind: "FOUNDER" } })).success).toBe(true);
  });

  it("adds the StandingOrder ID kind, minted as standing-<n>", () => {
    expect(DYNAMIC_ID_KINDS).toContain("StandingOrder");
    expect(DYNAMIC_ID_PREFIXES.StandingOrder).toBe("standing");
    expect(compareIds("standing-2", "standing-10")).toBeLessThan(0);
  });

  it("adds the two timed activities", () => {
    // ADR 0029 (TS1) appends MASH and DISTILL after them.
    expect(ACTIVITY_KINDS.slice(-4, -2)).toEqual(["HIRE", "BRIEF_EMPLOYEE"]);
  });

  it("adds the PERSONNEL transaction kind, whose producers land with their call sites in E1 (#180)", () => {
    expectTypeOf<"PERSONNEL">().toExtend<TransactionKind>();
    for (const family of Object.keys(TRANSACTION_PRODUCERS)) expect(family.startsWith("PERSONNEL"), family).toBe(false);
    expect(Object.hasOwn(TRANSACTION_PRODUCERS, "PRODUCTION_START:EMPLOYEE")).toBe(false);
    expect(transactionProducerOf("PERSONNEL:HIRE:cmd-3")).toBeNull();
  });
});

describe("EMPLOYEE_PERFORMANCE (ADR 0025 decision 8)", () => {
  it("is the last subject kind, keyed by character", () => {
    expect(SUBJECT_KINDS.at(-1)).toBe("EMPLOYEE_PERFORMANCE");
    expect(knowledgeSubjectKey({ kind: "EMPLOYEE_PERFORMANCE", characterId: walt })).toBe("walt-hagen");
    expect(compareKnowledgeSubjects({ kind: "STANDING" }, { kind: "EMPLOYEE_PERFORMANCE", characterId: walt })).toBeLessThan(0);
  });

  it("round-trips as a record, with or without the revealed competence", () => {
    for (const competence of [null, 55]) {
      const record: KnowledgeRecord = {
        subject: { kind: "EMPLOYEE_PERFORMANCE", characterId: walt },
        value: { kind: "EMPLOYEE_PERFORMANCE", characterId: walt, batchesRun: competence === null ? 0 : 1, competence },
        learnedAt: tick(900),
        source: { kind: "REPORT", characterId: walt },
      };
      expect(knowledgeRecordSchema.parse(roundTrip(record))).toEqual(record);
    }
    const wrongKey = {
      subject: { kind: "EMPLOYEE_PERFORMANCE", characterId: eddie },
      value: { kind: "EMPLOYEE_PERFORMANCE", characterId: walt, batchesRun: 0, competence: null },
      learnedAt: tick(900),
      source: { kind: "REPORT", characterId: walt },
    };
    expect(knowledgeRecordSchema.safeParse(roundTrip(wrongKey)).success).toBe(false);
  });
});

describe("state and saves (ADR 0025 decision 14)", () => {
  it("round-trips a state with an employee, a former employee, a report message and report items", () => {
    expect(gameStateSchema.parse(roundTrip(staffed))).toEqual(staffed);
    expect(saveGameSchema.parse(roundTrip({ ...day0Save, state: staffed }))).toEqual({ ...day0Save, state: staffed });
  });

  it.each([
    ["an estimate whose low is above its high", { ...employee, competenceEstimate: { low: 70, high: 40 } }],
    ["a competence above 100", { ...employee, competence: 101 }],
    ["a fractional loyalty", { ...employee, loyalty: 50.5 }],
    ["an unknown role", { ...employee, role: "RUNNER" }],
    ["a batch size of 0", { ...employee, standingOrder: { id: order2, givenAt: tick(600), terms: { ...terms, batchSize: 0 } } }],
    ["a negative keepOnHand", { ...employee, standingOrder: { id: order2, givenAt: tick(600), terms: { ...terms, keepOnHand: -1 } } }],
    ["an order of an unknown kind", { ...employee, standingOrder: { id: order2, givenAt: tick(600), terms: { ...terms, kind: "BUY" } } }],
    ["a standing order ID of another kind", { ...employee, standingOrder: { id: "order 2", givenAt: tick(600), terms } }],
    ["an unknown hold", { ...employee, work: { ...employee.work, lastHold: { kind: "TIRED" } } }],
    ["a report line of an unknown kind", { ...employee, report: { ...employee.report, lines: [{ kind: "GOSSIP", tick: 1 }] } }],
    ["a short batch without limitedBy", { ...employee, report: { ...employee.report, lines: [{ ...lines[0], limitedBy: undefined }] } }],
    ["a missing callPending", { ...employee, report: { lines: [], dropped: 0 } }],
  ])("rejects an employee with %s", (_label, bad) => {
    expect(gameStateSchema.safeParse(roundTrip({ ...staffed, employees: [bad] })).success).toBe(false);
  });

  it("rejects a message whose report doesn't match its reason", () => {
    const state = (m: unknown) => ({ ...staffed, knowledge: { ...staffed.knowledge, pendingMessages: [{ locationId: ids.locSupplier, items: [m], dropped: 0 }] } });
    expect(gameStateSchema.safeParse(roundTrip(state(heldReport))).success).toBe(true);
    expect(gameStateSchema.safeParse(roundTrip(state({ ...heldReport, report: null }))).success).toBe(false);
    expect(gameStateSchema.safeParse(roundTrip(state({ ...heldReport, reason: "INSTALLMENT_DUE" }))).success).toBe(false);
    expect(activityItemSchema.safeParse(roundTrip({ ...reportItems[3], message: { ...deliveredReport, report: null } })).success).toBe(false);
    expect(activityItemSchema.safeParse(roundTrip({ ...reportItems[3], message: { ...deliveredReport, reason: "NEW_CONTRACT_OFFER" } })).success).toBe(false);
  });

  it("rejects a REPORT item without atArrival or with an unknown channel", () => {
    expect(activityItemSchema.safeParse(roundTrip({ ...reportItems[0], atArrival: undefined })).success).toBe(false);
    expect(activityItemSchema.safeParse(roundTrip({ ...reportItems[0], via: "MESSAGE" })).success).toBe(false);
  });
});

describe("the #224 report triggers each have a line (ADR 0028 decision 8)", () => {
  it("maps every approved trigger to a line kind and reason", () => {
    const has = (pick: (l: ReportLine) => boolean) => lines.some(pick);
    // Batch failed.
    expect(has((l) => l.kind === "BATCH_FINISHED" && l.outcome === "FAILED")).toBe(true);
    // A batch limited by available ingredients, by the spending cap, or by cash.
    const limits = (k: BatchLimit["kind"]) => has((l) => l.kind === "BATCH_STARTED" && l.limitedBy?.kind === k);
    expect([limits("MATERIALS"), limits("SPENDING_CAP"), limits("CASH")]).toEqual([true, true, true]);
    // Can't start because ingredients are short.
    expect(has((l) => l.kind === "HELD_BACK" && l.hold.kind === "NO_MATERIALS")).toBe(true);
    // An order that couldn't be followed, with a typed reason.
    expect(has((l) => l.kind === "ORDER_REFUSED" && typeof l.reason.code === "string")).toBe(true);
    // Cash shortage and the spending cap stay distinct (#209 §4).
    expectTypeOf<Extract<HoldReason, { kind: "NO_CASH" | "SPENDING_CAP" }>["kind"]>().toEqualTypeOf<"NO_CASH" | "SPENDING_CAP">();
  });
});

describe("HIRE_EMPLOYEE, SET_STANDING_ORDER and DISMISS_EMPLOYEE", () => {
  const commands: GameCommand[] = [
    { type: "HIRE_EMPLOYEE", characterId: walt, role: "DISTILLER", stationId: ids.distillery, dailyWage: cents(450), standingOrder: terms },
    { type: "HIRE_EMPLOYEE", characterId: walt, role: "DISTILLER", stationId: ids.distillery, dailyWage: cents(450), standingOrder: null },
    { type: "SET_STANDING_ORDER", characterId: walt, terms },
    { type: "SET_STANDING_ORDER", characterId: walt, terms: null },
    { type: "DISMISS_EMPLOYEE", characterId: walt },
  ];

  it("are commands, last in GAME_COMMAND_TYPES, and not repeatable", () => {
    // ADR 0029 (TS1) appends SET_MASH and START_DISTILLATION after them.
    expect(GAME_COMMAND_TYPES.slice(-5, -2)).toEqual(["HIRE_EMPLOYEE", "SET_STANDING_ORDER", "DISMISS_EMPLOYEE"]);
    expectTypeOf<Extract<RepeatableCommand, { type: "HIRE_EMPLOYEE" | "SET_STANDING_ORDER" | "DISMISS_EMPLOYEE" }>>().toBeNever();
  });

  it.each(commands.map((c, i) => [`${c.type} #${i}`, c] as const))("%s round-trips through JSON", (_label, command) => {
    expect(gameCommandSchema.parse(roundTrip(command))).toEqual(command);
  });

  it.each([
    ["a hire without a standing order field", { type: "HIRE_EMPLOYEE", characterId: walt, role: "DISTILLER", stationId: ids.distillery, dailyWage: 450 }],
    ["a hire with a fractional wage", { ...commands[0], dailyWage: 4.5 }],
    ["a hire for an unknown role", { ...commands[0], role: "RUNNER" }],
    ["an order with a batch size of 0", { ...commands[2], terms: { ...terms, batchSize: 0 } }],
    ["an order calling when ALWAYS", { ...commands[2], terms: { ...terms, callWhen: "ALWAYS" } }],
    ["a dismissal of a bad ID", { type: "DISMISS_EMPLOYEE", characterId: "Walt Hagen" }],
  ])("rejects %s", (_label, bad) => {
    expect(gameCommandSchema.safeParse(roundTrip(bad)).success).toBe(false);
  });
});

describe("rejection reasons (ADR 0025 decision 15)", () => {
  const reasons: RejectionReason[] = [
    { code: "CANDIDATE_UNAVAILABLE", characterId: walt },
    { code: "CANDIDATE_TERMS_CHANGED", characterId: walt, agreed: cents(450), current: cents(480) },
    { code: "STATION_UNSUITABLE", facilityId: ids.barn, role: "DISTILLER" },
    { code: "POSITION_FILLED", facilityId: ids.distillery, role: "DISTILLER" },
    ...(["COMMAND", "STATION", "RECIPE", "BATCH_SIZE", "SPENDING_CAP"] as const).map(
      (limit): RejectionReason => ({ code: "OUTSIDE_AUTHORITY", characterId: walt, standingOrderId: order1, limit }),
    ),
  ];

  it.each(reasons.map((r, i) => [`${r.code} #${i}`, r] as const))("%s round-trips through JSON", (_label, reason) => {
    expect(rejectionReasonSchema.parse(roundTrip(reason))).toEqual(reason);
  });

  it("rejects an unknown authority limit", () => {
    expect(rejectionReasonSchema.safeParse({ code: "OUTSIDE_AUTHORITY", characterId: walt, standingOrderId: order1, limit: "VEHICLE" }).success).toBe(false);
  });
});

describe("events (ADR 0025 decision 16)", () => {
  const meta = { id: asId("Event", "evt-9"), tick: tick(600), causedBy: asId("Command", "cmd-3") };
  const txn = asId("Transaction", "txn-4");
  const events: GameEvent[] = [
    { ...meta, type: "EMPLOYEE_HIRED", characterId: walt, role: "DISTILLER", stationId: ids.distillery, dailyWage: cents(450), signingCost: cents(2_500), startsAt: tick(720), transactionId: txn },
    { ...meta, type: "STANDING_ORDER_SET", characterId: walt, standingOrderId: order1, terms, transactionId: txn },
    { ...meta, type: "STANDING_ORDER_SET", characterId: walt, standingOrderId: null, terms: null, transactionId: txn },
    { ...meta, type: "EMPLOYEE_DISMISSED", characterId: walt, transactionId: txn },
    { ...meta, causedBy: null, type: "EMPLOYEE_ACTED", characterId: walt, standingOrderId: order1, command: startProduction, status: "APPLIED", reason: null },
    {
      ...meta,
      causedBy: null,
      type: "EMPLOYEE_ACTED",
      characterId: walt,
      standingOrderId: order1,
      command: startProduction,
      status: "REJECTED",
      reason: { code: "OUTSIDE_AUTHORITY", characterId: walt, standingOrderId: order1, limit: "BATCH_SIZE" },
    },
    { ...meta, causedBy: null, type: "REPORT_DELIVERED", characterId: walt, via: "IN_PERSON", lineCount: 3, dropped: 0 },
  ];

  it.each(events.map((e, i) => [`${e.type} #${i}`, e] as const))("%s round-trips through JSON", (_label, event) => {
    expect(gameEventSchema.parse(roundTrip(event))).toEqual(event);
  });

  it("are all log and never news (ADR 0028 decision 8)", () => {
    for (const type of ["EMPLOYEE_HIRED", "STANDING_ORDER_SET", "EMPLOYEE_DISMISSED", "EMPLOYEE_ACTED", "REPORT_DELIVERED"] as const) {
      expect(EVENT_IMPORTANCE[type], type).toBe("log");
      expect(EVENT_CONCERNS_PLACE[type], type).toBeNull();
    }
  });

  it("a REPORT item is notify; it comes through a channel (ADR 0025 decision 16)", () => {
    expect(ACTIVITY_IMPORTANCE.REPORT).toBe("notify");
    expectTypeOf<CallInReason>().toEqualTypeOf<"NEW_CONTRACT_OFFER" | "INSTALLMENT_DUE" | "EMPLOYEE_REPORT">();
  });
});

describe("the player snapshot's employees and hiring (ADR 0025 decision 2, ADR 0028 decision 4)", () => {
  it("round-trips an employee and a slate", () => {
    const playerEmployee: PlayerEmployee = {
      characterId: walt,
      name: "Walt Hagen",
      role: "DISTILLER",
      stationId: ids.distillery,
      dailyWage: cents(450),
      hiredAt: tick(541),
      startsAt: tick(661),
      competenceEstimate: { low: 40, high: 70 },
      competenceBand: "MODERATE",
      standingOrder: { id: order2, givenAt: tick(600), terms },
      performance: {
        value: { kind: "EMPLOYEE_PERFORMANCE", characterId: walt, batchesRun: 1, competence: 55 },
        learnedAt: tick(900),
        source: { kind: "IN_PERSON", locationId: ids.locDistillery },
      },
    };
    const hiring: PlayerHiring = {
      locationId: ids.locSupplier,
      slateEndsAt: tick(4_320),
      candidates: [
        { characterId: walt, name: "Walt Hagen", role: "DISTILLER", competenceEstimate: { low: 40, high: 85 }, competenceBand: "UNCERTAIN", dailyWage: cents(487), signingCost: cents(2_500) },
        { characterId: eddie, name: "Eddie Novak", role: "DISTILLER", competenceEstimate: { low: 20, high: 45 }, competenceBand: "LOW", dailyWage: cents(397), signingCost: cents(2_500) },
      ],
    };
    expect(playerEmployeeSchema.parse(roundTrip(playerEmployee))).toEqual(playerEmployee);
    expect(playerEmployeeSchema.parse(roundTrip({ ...playerEmployee, performance: null }))).toEqual({ ...playerEmployee, performance: null });
    expect(playerHiringSchema.parse(roundTrip(hiring))).toEqual(hiring);
    expect(playerHiringSchema.safeParse(roundTrip({ ...hiring, candidates: [{ ...hiring.candidates[0], competenceBand: "WIDE" }] })).success).toBe(false);
    expect(playerEmployeeSchema.safeParse(roundTrip({ ...playerEmployee, competence: 55 })).success).toBe(false);
  });
});
