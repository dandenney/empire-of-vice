// The First Shipment scenario lock and scenario-load validation (T05b, issue #101;
// GDD §4; ADR 0020 decisions 1, 2, 3, 4, 12).

import { asId, cents, compareIds, tick, type GameCommand, type RejectionReason, type UnlockId } from "@eov/contracts";
import {
  CAPACITY_EQUIPMENT,
  COPPER_STILL,
  COUNTY_ROAD,
  CROSSROADS_ROADHOUSE,
  DISTILLERY_MAIN,
  FIRST_SHIPMENT_SCENARIO,
  GAME_DATA,
  KERRIGAN,
  KESSLERS_BACK_ROOM,
  LAKEVIEW_HOTEL,
  MODEL_TT_TRUCK,
  MOONSHINE,
  NEXT_REGION,
  QUALITY_EQUIPMENT,
  SPOT_SALES,
  STARTING_OPERATION,
  TRUSTED_SUPPLIER,
  type GameData,
  type ScenarioDefinition,
  type ScenarioRouteClosure,
} from "@eov/game-data";
import { describe, expect, it } from "vitest";
import { createInitialState, newGame, ScenarioSetupError, type KernelSimulation } from "../../src/index.ts";
import { advanceTo } from "../sprint-zero/helpers.ts";

const CLOSES_AT = 12_000;
const REOPENS_AT = 13_440;

const closure = FIRST_SHIPMENT_SCENARIO.scheduledEvents[0] as ScenarioRouteClosure;

function withClosure(patch: Partial<ScenarioRouteClosure>): ScenarioDefinition {
  return { ...FIRST_SHIPMENT_SCENARIO, scheduledEvents: [{ ...closure, ...patch }] };
}

function withFamily(patch: Partial<ScenarioDefinition["family"]>): ScenarioDefinition {
  return { ...FIRST_SHIPMENT_SCENARIO, family: { ...FIRST_SHIPMENT_SCENARIO.family, ...patch } };
}

const load = (scenario: ScenarioDefinition, data: GameData = GAME_DATA) => () => createInitialState(scenario, data);

/**
 * A one-case sale to Kessler's on its default (safe) route, county-road, against a
 * deal held at today's quote (ADR 0022 decision 6). A rejected dispatch leaves its
 * deal held, so the next call reuses it.
 */
function toKessler(sim: KernelSimulation): GameCommand {
  const held = sim.state.heldDeals.find((d) => d.status === "HELD" && d.buyerId === KESSLERS_BACK_ROOM && d.quantity === 1);
  if (!held) {
    const unitPrice = sim.state.buyers.find((b) => b.id === KESSLERS_BACK_ROOM)!.wants.find((w) => w.minimumQuality === "basic")!.unitPrice;
    const agreed = sim.dispatch({
      command: { type: "AGREE_DEAL", buyerId: KESSLERS_BACK_ROOM, productId: MOONSHINE, quality: "basic", quantity: 1, agreedUnitPrice: unitPrice },
    });
    if (agreed.status !== "applied") throw new Error("AGREE_DEAL with Kessler's was rejected");
  }
  return {
    type: "DISPATCH_DELIVERY",
    vehicleId: MODEL_TT_TRUCK,
    cargo: [{ productId: MOONSHINE, quality: "basic", quantity: 1 }],
    purpose: { kind: "SALE", buyerId: KESSLERS_BACK_ROOM, dealId: held?.id ?? sim.state.heldDeals.at(-1)!.id },
    routeId: null,
    driver: { kind: "FOUNDER" },
  };
}

function rejection(sim: KernelSimulation, command: GameCommand): RejectionReason | null {
  const result = sim.dispatch({ command });
  return result.status === "rejected" ? result.reason : null;
}

describe("First Shipment: GDD §4", () => {
  it("starts on 1920-01-17 with seed 1920, the distillery and its copper still, one truck, three buyers, founder and foreman", () => {
    const s = FIRST_SHIPMENT_SCENARIO;
    expect(s.startDate).toEqual({ year: 1920, month: 1, day: 17 });
    expect(s.seed).toBe(1920);
    expect(s.openingBalance.cash).toBe(cents(100_000));
    expect(s.facilities).toEqual([{ id: DISTILLERY_MAIN, equipmentIds: [COPPER_STILL], workerCount: 3 }]);
    expect(s.vehicleIds).toEqual([MODEL_TT_TRUCK]);
    expect([...s.buyerIds].sort(compareIds)).toEqual([CROSSROADS_ROADHOUSE, KESSLERS_BACK_ROOM, LAKEVIEW_HOTEL]);
    const snap = newGame().snapshot();
    expect(snap.family.leaders.map((l) => l.role).sort()).toEqual(["FOREMAN", "FOUNDER"]);
  });

  it("schedules one rival disruption: county-road closed at tick 12 000 for 1 440 ticks", () => {
    expect(FIRST_SHIPMENT_SCENARIO.scheduledEvents).toEqual([
      { kind: "ROUTE_CLOSURE", tick: tick(CLOSES_AT), routeId: COUNTY_ROAD, reason: "RIVAL", durationTicks: 1_440 },
    ]);
    const state = newGame().state;
    expect(state.scheduledEvents).toEqual([
      { kind: "ROUTE_CLOSURE", tick: CLOSES_AT, sequence: 1, routeId: COUNTY_ROAD, reason: "RIVAL", durationTicks: 1_440 },
    ]);
    expect(state.counters.nextScheduleSequence).toBe(2);
  });
});

describe("First Shipment: opening balance sheet (ADR 0020 decision 1)", () => {
  it("is cash $1,000, the scenario's building, still $300, and truck $400, and nothing else", () => {
    const { netWorth, balanceSheet } = newGame().snapshot().finance;
    // The building's book value is a tuning lever (ADR 0020 decision 15), so it's read from the scenario.
    const building = FIRST_SHIPMENT_SCENARIO.openingBalance.buildings;
    const total = cents(100_000 + 30_000 + 40_000 + building);
    expect(balanceSheet.assets).toEqual({
      cash: cents(100_000),
      rawMaterials: cents(0),
      finishedGoods: cents(0),
      goodsInTransit: cents(0),
      productionInProgress: cents(0),
      receivables: cents(0),
      equipment: cents(30_000),
      vehicles: cents(40_000),
      facilities: building,
    });
    expect(balanceSheet.liabilities).toEqual({ wagesPayable: cents(0), penaltiesPayable: cents(0) });
    expect(balanceSheet.totalAssets).toBe(total);
    expect(balanceSheet.totalLiabilities).toBe(cents(0));
    expect(balanceSheet.equity).toBe(total);
    expect(netWorth).toBe(total);
  });
});

describe("First Shipment: starting standing (ADR 0020 decisions 2, 3, 4)", () => {
  it("starts at reputation 0 in starting-operation, holding spot-sales", () => {
    const { family } = newGame().state;
    expect(family.reputation).toBe(0);
    expect(family.tierId).toBe(STARTING_OPERATION);
    expect(family.unlocked).toEqual([SPOT_SALES]);
  });

  it("sorts family.unlocked with compareIds", () => {
    // A ladder whose first tier grants several unlocks, listed out of order.
    const unordered: readonly UnlockId[] = [asId("Unlock", "zeta"), asId("Unlock", "mid-way"), asId("Unlock", "alpha")];
    const data: GameData = {
      ...GAME_DATA,
      progression: {
        ...GAME_DATA.progression,
        tiers: GAME_DATA.progression.tiers.map((t, i) => (i === 0 ? { ...t, unlocks: unordered } : t)),
      },
    };
    const state = createInitialState(withFamily({ unlocked: [unordered[1]!, unordered[0]!, unordered[2]!] }), data);
    expect(state.family.unlocked).toEqual([...unordered].sort(compareIds));
    expect(state.family.unlocked).toEqual(["alpha", "mid-way", "zeta"]);
  });

  it("accepts a later starting tier with every unlock up to it", () => {
    const state = createInitialState(withFamily({ tierId: TRUSTED_SUPPLIER, unlocked: [SPOT_SALES, CAPACITY_EQUIPMENT] }), GAME_DATA);
    expect(state.family.tierId).toBe(TRUSTED_SUPPLIER);
    expect(state.family.unlocked).toEqual([CAPACITY_EQUIPMENT, SPOT_SALES]);
  });
});

describe("scenario-load validation (ADR 0020 decision 12)", () => {
  it("throws ScenarioSetupError for a closure on an unknown route", () => {
    expect(load(withClosure({ routeId: asId("Route", "no-such-road") }))).toThrow(ScenarioSetupError);
  });

  it("throws ScenarioSetupError for a closure at tick < 1", () => {
    expect(load(withClosure({ tick: tick(0) }))).toThrow(ScenarioSetupError);
  });

  it("throws ScenarioSetupError for a closure lasting < 1 tick", () => {
    expect(load(withClosure({ durationTicks: 0 }))).toThrow(ScenarioSetupError);
    expect(load(withClosure({ durationTicks: -5 }))).toThrow(ScenarioSetupError);
  });

  it("throws ScenarioSetupError for an unknown family.tierId", () => {
    expect(load(withFamily({ tierId: asId("Tier", "no-such-tier") }))).toThrow(ScenarioSetupError);
  });

  it("throws ScenarioSetupError when family.unlocked isn't the starting tier's cumulative unlocks", () => {
    expect(load(withFamily({ unlocked: [] }))).toThrow(ScenarioSetupError);
    expect(load(withFamily({ unlocked: [SPOT_SALES, CAPACITY_EQUIPMENT] }))).toThrow(ScenarioSetupError);
    expect(load(withFamily({ unlocked: [SPOT_SALES, SPOT_SALES] }))).toThrow(ScenarioSetupError);
    expect(load(withFamily({ unlocked: [QUALITY_EQUIPMENT] }))).toThrow(ScenarioSetupError);
    expect(load(withFamily({ tierId: TRUSTED_SUPPLIER, unlocked: [SPOT_SALES] }))).toThrow(ScenarioSetupError);
    expect(load(withFamily({ unlocked: [SPOT_SALES, NEXT_REGION] }))).toThrow(ScenarioSetupError);
  });

  it("throws ScenarioSetupError for a family ID missing from FAMILIES", () => {
    expect(load(withFamily({ id: asId("Family", "no-such-family") }))).toThrow(ScenarioSetupError);
    expect(load(FIRST_SHIPMENT_SCENARIO, { ...GAME_DATA, families: [] })).toThrow(ScenarioSetupError);
    expect(GAME_DATA.families.some((f) => f.id === KERRIGAN)).toBe(true);
  });

  it("fails in newGame, before any tick runs", () => {
    expect(() => newGame({ scenario: withClosure({ routeId: asId("Route", "no-such-road") }) })).toThrow(ScenarioSetupError);
  });
});

describe("the rival closure fires (ADR 0019 decision 5, ADR 0020 decision 12)", () => {
  it("closes county-road at tick 12 000, rejects dispatches onto it with ROUTE_CLOSED, and reopens it at 13 440", () => {
    const sim = newGame();
    const countyRoad = () => sim.state.routes.find((r) => r.id === COUNTY_ROAD)!;

    advanceTo(sim, CLOSES_AT - 1);
    expect(countyRoad().closure).toBeNull();
    // Open: the dispatch gets past the route check and stops at the (empty) stock.
    expect(rejection(sim, toKessler(sim))?.code).toBe("INSUFFICIENT_STOCK");

    advanceTo(sim, CLOSES_AT);
    expect(countyRoad().closure).toEqual({ reason: "RIVAL", reopensAt: REOPENS_AT });
    expect(sim.state.eventJournal.filter((e) => e.type === "ROUTE_CLOSED" && e.tick === CLOSES_AT)).toEqual([
      expect.objectContaining({ type: "ROUTE_CLOSED", routeId: COUNTY_ROAD, reason: "RIVAL", reopensAt: REOPENS_AT }),
    ]);
    expect(rejection(sim, toKessler(sim))).toEqual({ code: "ROUTE_CLOSED", routeId: COUNTY_ROAD, reopensAt: REOPENS_AT });
    expect(rejection(sim, { ...toKessler(sim), routeId: COUNTY_ROAD } as GameCommand)).toEqual({
      code: "ROUTE_CLOSED",
      routeId: COUNTY_ROAD,
      reopensAt: REOPENS_AT,
    });
    expect(newGame().snapshot().routes.find((r) => r.id === COUNTY_ROAD)!.status).toEqual({ open: true });
    expect(sim.snapshot().routes.find((r) => r.id === COUNTY_ROAD)!.status).toEqual({ open: false, reopensAt: REOPENS_AT, reason: "RIVAL" });

    advanceTo(sim, REOPENS_AT - 1);
    expect(rejection(sim, toKessler(sim))?.code).toBe("ROUTE_CLOSED");

    advanceTo(sim, REOPENS_AT);
    expect(countyRoad().closure).toBeNull();
    expect(sim.state.eventJournal.filter((e) => e.type === "ROUTE_REOPENED" && e.tick === REOPENS_AT)).toEqual([
      expect.objectContaining({ type: "ROUTE_REOPENED", routeId: COUNTY_ROAD }),
    ]);
    expect(rejection(sim, toKessler(sim))?.code).toBe("INSUFFICIENT_STOCK");
  });
});
