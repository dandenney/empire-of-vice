// The two-stage production contract (ADR 0029 decision 16; task TS1, #243).

import { describe, expect, expectTypeOf, it } from "vitest";
import { day0Save, ids } from "../fixtures/index.ts";
import {
  ACTIVITY_KINDS,
  asId,
  cents,
  EVENT_CONCERNS_PLACE,
  EVENT_IMPORTANCE,
  GAME_COMMAND_TYPES,
  gameCommandSchema,
  gameEventSchema,
  gameStateSchema,
  knowledgeValueSchema,
  recipeTwoStageOptionSchema,
  rejectionReasonSchema,
  reservationHolderSchema,
  tick,
  washSnapshotSchema,
  washStateSchema,
  type ActivityKind,
  type GameCommand,
  type GameEvent,
  type GameSnapshot,
  type GameState,
  type KnowledgeValue,
  type PlayerFacility,
  type RecipeOption,
  type RecipeTwoStageOption,
  type RejectionReason,
  type RepeatableCommand,
  type ReservationHolder,
  type SetMashCommand,
  type StartDistillationCommand,
  type WashSnapshot,
  type WashState,
} from "../src/index.ts";
import type { IsPlainData } from "./plain-data.ts";

const roundTrip = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

const wash: WashState = {
  facilityId: ids.distillery,
  barrel: 0,
  recipeId: ids.basicRecipe,
  quantity: 10,
  mashedAt: tick(630),
  readyAt: tick(7_110),
  reservationIds: [asId("Reservation", "res-1"), asId("Reservation", "res-2")],
  conversionPrepaid: cents(4_000),
};

const washSnapshot: WashSnapshot = {
  facilityId: ids.distillery,
  barrel: 0,
  recipeId: ids.basicRecipe,
  productId: ids.moonshine,
  quality: "basic",
  quantity: 10,
  mashedAt: tick(630),
  readyAt: tick(7_110),
};

const setMash: SetMashCommand = { type: "SET_MASH", facilityId: ids.distillery, recipeId: ids.basicRecipe, barrels: 2 };
const distill: StartDistillationCommand = { type: "START_DISTILLATION", facilityId: ids.distillery, recipeId: ids.basicRecipe };

const reasons: RejectionReason[] = [
  { code: "TWO_STAGE_RECIPE", facilityId: ids.distillery, recipeId: ids.basicRecipe },
  { code: "NO_READY_WASH", facilityId: ids.distillery, recipeId: ids.basicRecipe, readyAt: tick(7_110) },
  { code: "NO_READY_WASH", facilityId: ids.distillery, recipeId: ids.basicRecipe, readyAt: null },
];

const events: GameEvent[] = [
  {
    id: asId("Event", "evt-9"),
    tick: tick(600),
    causedBy: asId("Command", "cmd-4"),
    type: "MASH_SET",
    facilityId: ids.distillery,
    recipeId: ids.basicRecipe,
    barrels: [0, 1],
    quantity: 20,
    readyAt: tick(7_110),
    conversionPrepaid: cents(8_000),
  },
  {
    id: asId("Event", "evt-10"),
    tick: tick(7_200),
    causedBy: asId("Command", "cmd-5"),
    type: "DISTILLATION_STARTED",
    jobId: asId("ProductionJob", "job-1"),
    facilityId: ids.distillery,
    recipeId: ids.basicRecipe,
    barrels: [0, 1],
    quantity: 20,
    operator: { kind: "FOUNDER" },
    completesAt: tick(7_680),
  },
  {
    id: asId("Event", "evt-11"),
    tick: tick(8_000),
    causedBy: null,
    type: "DISTILLATION_STARTED",
    jobId: asId("ProductionJob", "job-2"),
    facilityId: ids.distillery,
    recipeId: ids.basicRecipe,
    barrels: [2],
    quantity: 10,
    operator: { kind: "EMPLOYEE", characterId: ids.foreman },
    completesAt: tick(8_514),
  },
];

const option: RecipeTwoStageOption = {
  casesPerBarrel: 10,
  fermentTicks: 6_480,
  maxMashBarrels: 2,
  mashBlockedBy: null,
  readyQuantity: 20,
  distillBlockedBy: { code: "FOUNDER_BUSY", until: tick(900) },
};

const operations: KnowledgeValue = {
  kind: "FACILITY_OPERATIONS",
  facilityId: ids.distillery,
  jobs: [],
  workersPresent: 0,
  washes: [washSnapshot, { ...washSnapshot, barrel: 1 }],
};

/** A state with a wash in barrel 0 and its two reservations held by the barrel. */
const stateWithWash: GameState = {
  ...day0Save.state,
  materialPools: [],
  reservations: [
    { id: asId("Reservation", "res-1"), facilityId: ids.distillery, goods: { kind: "MATERIAL", materialId: ids.corn }, quantity: 20, holder: { kind: "BARREL", facilityId: ids.distillery, barrel: 0 } },
    { id: asId("Reservation", "res-2"), facilityId: ids.distillery, goods: { kind: "MATERIAL", materialId: ids.sugar }, quantity: 10, holder: { kind: "BARREL", facilityId: ids.distillery, barrel: 0 } },
  ],
  washes: [wash],
};

describe("two-stage shapes (ADR 0029 decision 16)", () => {
  it("are plain data", () => {
    expectTypeOf<IsPlainData<WashState>>().toEqualTypeOf<true>();
    expectTypeOf<IsPlainData<WashSnapshot>>().toEqualTypeOf<true>();
    expectTypeOf<IsPlainData<RecipeTwoStageOption>>().toEqualTypeOf<true>();
    expectTypeOf<IsPlainData<SetMashCommand>>().toEqualTypeOf<true>();
    expectTypeOf<IsPlainData<StartDistillationCommand>>().toEqualTypeOf<true>();
    expectTypeOf<IsPlainData<Extract<GameEvent, { type: "MASH_SET" | "DISTILLATION_STARTED" }>>>().toEqualTypeOf<true>();
    expectTypeOf<IsPlainData<GameState>>().toEqualTypeOf<true>();
  });

  it("adds washes to state and the snapshots", () => {
    expectTypeOf<GameState["washes"]>().toEqualTypeOf<readonly WashState[]>();
    expectTypeOf<GameSnapshot["washes"]>().toEqualTypeOf<readonly WashSnapshot[]>();
    expectTypeOf<GameSnapshot["facilities"][number]["barrels"]>().toEqualTypeOf<number>();
    expectTypeOf<PlayerFacility["barrels"]>().toEqualTypeOf<number>();
    expectTypeOf<RecipeOption["twoStage"]>().toEqualTypeOf<RecipeTwoStageOption | null>();
    expectTypeOf<Extract<KnowledgeValue, { kind: "FACILITY_OPERATIONS" }>["washes"]>().toEqualTypeOf<readonly WashSnapshot[]>();
    expect(day0Save.state.washes).toEqual([]);
  });

  it("appends MASH and DISTILL to the activities", () => {
    expect(ACTIVITY_KINDS.slice(-2)).toEqual(["MASH", "DISTILL"]);
    expectTypeOf<"MASH" | "DISTILL">().toExtend<ActivityKind>();
  });

  it("adds a BARREL reservation holder", () => {
    const holder: ReservationHolder = { kind: "BARREL", facilityId: ids.distillery, barrel: 3 };
    expect(reservationHolderSchema.parse(roundTrip(holder))).toEqual(holder);
    expect(reservationHolderSchema.safeParse({ kind: "BARREL", facilityId: ids.distillery, barrel: -1 }).success).toBe(false);
    expect(reservationHolderSchema.safeParse({ kind: "BARREL", facilityId: ids.distillery, barrel: 0.5 }).success).toBe(false);
    expect(reservationHolderSchema.safeParse({ kind: "BARREL", facilityId: ids.distillery }).success).toBe(false);
  });

  it("round-trips a wash, and rejects a malformed one", () => {
    expect(washStateSchema.parse(roundTrip(wash))).toEqual(wash);
    expect(washSnapshotSchema.parse(roundTrip(washSnapshot))).toEqual(washSnapshot);
    for (const bad of [
      { ...wash, quantity: 0 },
      { ...wash, barrel: -1 },
      { ...wash, readyAt: -1 },
      { ...wash, conversionPrepaid: 1.5 },
      { ...wash, extra: 1 },
      { ...washSnapshot, reservationIds: [] },
    ]) {
      expect(washStateSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(washSnapshotSchema.safeParse({ ...washSnapshot, quality: "top-shelf" }).success).toBe(false);
  });

  it("round-trips a state holding a wash and its barrel reservations", () => {
    expect(gameStateSchema.parse(roundTrip(stateWithWash))).toEqual(stateWithWash);
    expect(gameStateSchema.safeParse({ ...day0Save.state, washes: undefined }).success).toBe(false);
  });

  it("round-trips FACILITY_OPERATIONS with washes, and requires the field", () => {
    expect(knowledgeValueSchema.parse(roundTrip(operations))).toEqual(operations);
    const { washes, ...withoutWashes } = operations as Extract<KnowledgeValue, { kind: "FACILITY_OPERATIONS" }>;
    expect(washes).toHaveLength(2);
    expect(knowledgeValueSchema.safeParse(withoutWashes).success).toBe(false);
  });

  it("round-trips RecipeOption.twoStage", () => {
    expect(recipeTwoStageOptionSchema.parse(roundTrip(option))).toEqual(option);
    expect(recipeTwoStageOptionSchema.safeParse({ ...option, maxMashBarrels: -1 }).success).toBe(false);
    expect(recipeTwoStageOptionSchema.safeParse({ ...option, casesPerBarrel: 0 }).success).toBe(false);
  });
});

describe("SET_MASH and START_DISTILLATION (ADR 0029 decision 4)", () => {
  it("are commands, last in GAME_COMMAND_TYPES, and not repeatable", () => {
    expect(GAME_COMMAND_TYPES.slice(-2)).toEqual(["SET_MASH", "START_DISTILLATION"]);
    expectTypeOf<Extract<RepeatableCommand, { type: "SET_MASH" | "START_DISTILLATION" }>>().toBeNever();
  });

  it.each([setMash, distill] as GameCommand[])("$type round-trips through JSON", (command) => {
    expect(gameCommandSchema.parse(roundTrip(command))).toEqual(command);
  });

  it("rejects malformed commands", () => {
    for (const bad of [
      { ...setMash, barrels: 0 },
      { ...setMash, barrels: 1.5 },
      { ...setMash, quantity: 10 },
      { type: "SET_MASH", facilityId: ids.distillery, recipeId: ids.basicRecipe },
      { ...distill, barrels: 1 },
      { type: "START_DISTILLATION", facilityId: ids.distillery },
    ]) {
      expect(gameCommandSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("rejection reasons (ADR 0029 decision 14)", () => {
  it.each(reasons)("$code round-trips", (reason) => {
    expect(rejectionReasonSchema.parse(roundTrip(reason))).toEqual(reason);
  });

  it("requires NO_READY_WASH's readyAt, which may be null", () => {
    expect(rejectionReasonSchema.safeParse({ code: "NO_READY_WASH", facilityId: ids.distillery, recipeId: ids.basicRecipe }).success).toBe(false);
    expect(rejectionReasonSchema.safeParse({ code: "TWO_STAGE_RECIPE", facilityId: ids.distillery }).success).toBe(false);
  });
});

describe("MASH_SET and DISTILLATION_STARTED (ADR 0029 decision 4)", () => {
  it.each(events.map((e) => [e.id, e] as const))("%s round-trips", (_id, event) => {
    expect(gameEventSchema.parse(roundTrip(event))).toEqual(event);
  });

  it("are log events that concern no place", () => {
    expect(EVENT_IMPORTANCE.MASH_SET).toBe("log");
    expect(EVENT_IMPORTANCE.DISTILLATION_STARTED).toBe("log");
    expect(EVENT_CONCERNS_PLACE.MASH_SET).toBeNull();
    expect(EVENT_CONCERNS_PLACE.DISTILLATION_STARTED).toBeNull();
  });

  it("reject a missing or wrongly typed field", () => {
    const [mash, run] = events as [GameEvent, GameEvent];
    expect(gameEventSchema.safeParse({ ...mash, barrels: [-1] }).success).toBe(false);
    expect(gameEventSchema.safeParse({ ...mash, readyAt: undefined }).success).toBe(false);
    expect(gameEventSchema.safeParse({ ...run, operator: { kind: "EMPLOYEE" } }).success).toBe(false);
    expect(gameEventSchema.safeParse({ ...run, operator: undefined }).success).toBe(false);
  });
});
