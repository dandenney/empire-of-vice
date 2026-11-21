// TS1 (#243, ADR 0029 decision 16): `washes` at game creation and in the
// projections, and SET_MASH and START_DISTILLATION as accepted no-ops with
// either flag, until TS2 (#244) gives them behaviour. START_PRODUCTION keeps its
// current behaviour until then.

import { tick, type GameCommand, type GameState } from "@eov/contracts";
import {
  BASIC_MOONSHINE_RECIPE,
  CORN,
  DISTILLERY_MAIN,
  FIRST_SHIPMENT_SCENARIO,
  GAME_DATA,
  MILLERS_FEED,
  STANDARD_MOONSHINE_RECIPE,
  SUGAR,
  THE_FIRST_HIRE_SCENARIO,
  type ScenarioDefinition,
} from "@eov/game-data";
import { describe, expect, it } from "vitest";
import { createGameRegistry, createInitialState, newGame } from "../../src/index.ts";
import { TWO_STAGE_COMMAND_TYPES } from "../../src/production/two-stage.ts";
import { orderValidators, playerViewOf } from "../../src/view/index.ts";

const setMash: GameCommand = { type: "SET_MASH", facilityId: DISTILLERY_MAIN, recipeId: BASIC_MOONSHINE_RECIPE, barrels: 2 };
const distill: GameCommand = { type: "START_DISTILLATION", facilityId: DISTILLERY_MAIN, recipeId: BASIC_MOONSHINE_RECIPE };
const COMMANDS: readonly [string, GameCommand][] = [
  ["SET_MASH", setMash],
  ["START_DISTILLATION", distill],
];

const FOUNDER_RULES: ScenarioDefinition = { ...FIRST_SHIPMENT_SCENARIO, founderRules: true, realMsPerGameHourAt1x: 20_000 };

/** Everything but the command bookkeeping the kernel does for any applied command. */
function domain(state: GameState): Omit<GameState, "commandLog" | "counters" | "knowledge"> {
  const { commandLog, counters, knowledge, ...rest } = state;
  void commandLog;
  void counters;
  void knowledge;
  return rest;
}

describe("washes at game creation and in the projections (ADR 0029 decisions 3 and 8)", () => {
  it.each([
    ["M001 (founder rules off)", FIRST_SHIPMENT_SCENARIO],
    ["founder rules on", FOUNDER_RULES],
    ["the M002 scenario", THE_FIRST_HIRE_SCENARIO],
  ])("%s: no washes", (_label, scenario) => {
    expect(createInitialState(scenario, GAME_DATA).washes).toEqual([]);
  });

  it("M001: washes stay empty over three days, and the snapshots show the barrels but no washes", () => {
    const sim = newGame();
    sim.advance(3 * 1_440);
    expect(sim.state.washes).toEqual([]);
    const snapshot = sim.snapshot();
    expect(snapshot.washes).toEqual([]);
    expect(snapshot.facilities.find((f) => f.id === DISTILLERY_MAIN)!.barrels).toBe(4);
    for (const recipe of snapshot.facilities.flatMap((f) => f.recipes)) expect(recipe.twoStage).toBeNull();
  });

  it("the founder's view of FACILITY_OPERATIONS carries washes ([]), and the player facility its barrels", () => {
    const sim = newGame({ scenario: THE_FIRST_HIRE_SCENARIO });
    sim.advance(400);
    const here = sim.playerSnapshot().places.find((p) => p.kind === "FACILITY");
    if (here?.kind !== "FACILITY") throw new Error("no facility place");
    expect(here.facility.barrels).toBe(4);
    expect(here.facility.operations?.value).toMatchObject({ kind: "FACILITY_OPERATIONS", facilityId: DISTILLERY_MAIN, washes: [] });
    for (const recipe of here.facility.recipes) expect(recipe.twoStage).toBeNull();
  });
});

describe.each([
  ["founder rules off", FIRST_SHIPMENT_SCENARIO, false],
  ["founder rules on (until TS2)", FOUNDER_RULES, true],
] as const)("SET_MASH and START_DISTILLATION with %s", (_label, scenario, founderRules) => {
  const start = () => newGame({ scenario });

  it("are the two-stage system's commands, each with a handler", () => {
    expect(TWO_STAGE_COMMAND_TYPES).toEqual(["SET_MASH", "START_DISTILLATION"]);
    const registry = createGameRegistry(GAME_DATA, undefined, undefined, { founderRules });
    for (const type of TWO_STAGE_COMMAND_TYPES) expect(() => registry.commandHandler(type)).not.toThrow();
  });

  it.each(COMMANDS)("%s is accepted, changes no domain state and posts nothing; the command log grows", (_type, command) => {
    const sim = start();
    sim.advance(600);
    const before = sim.state;
    const result = sim.dispatch({ command });
    expect(result).toMatchObject({ status: "applied", eventIds: [] });
    expect(domain(sim.state)).toEqual(domain(before));
    expect(sim.state.ledger).toBe(before.ledger);
    expect(sim.state.washes).toEqual([]);
    expect(sim.state.commandLog).toEqual([...before.commandLog, { id: result.commandId, scheduledTick: 601, sequence: 1, issuer: { kind: "FOUNDER" }, command }]);
  });

  it("their validators accept every view, even one with no barrels, materials or ready wash", () => {
    const sim = start();
    sim.advance(30);
    const validators = orderValidators(GAME_DATA, { founderRules });
    const view = playerViewOf(sim.state, GAME_DATA, { founderRules }, tick(sim.state.tick + 1));
    for (const [type, command] of COMMANDS) {
      expect(validators[type as (typeof TWO_STAGE_COMMAND_TYPES)[number]](view, command as never), type).toBeNull();
    }
    // More barrels than exist, a recipe the still can't make, a facility that isn't the family's: still accepted.
    for (const odd of [
      { ...setMash, barrels: 99 },
      { ...setMash, recipeId: STANDARD_MOONSHINE_RECIPE },
      { ...distill, facilityId: "riverside-warehouse" as never },
    ] as GameCommand[]) {
      expect(sim.dispatch({ command: odd }).status).toBe("applied");
    }
  });

  it("queued, they apply on their tick as no-ops; a run with them matches a run without them apart from the log", () => {
    const withCommands = start();
    const without = start();
    withCommands.dispatch({ command: setMash, scheduledTick: tick(100) });
    withCommands.dispatch({ command: distill, scheduledTick: tick(200) });
    withCommands.advance(1_440);
    without.advance(1_440);
    expect(withCommands.state.commandLog.map((e) => e.command.type)).toEqual(["SET_MASH", "START_DISTILLATION"]);
    expect(withCommands.state.queuedCommands).toEqual([]);
    expect(withCommands.takeEvents().some((e) => e.type === "COMMAND_REJECTED")).toBe(false);
    expect(domain(withCommands.state)).toEqual(domain(without.state));
  });

  it("don't make the founder busy (activityOf doesn't map them until TS2)", () => {
    const sim = start();
    sim.advance(600);
    sim.dispatch({ command: setMash });
    sim.dispatch({ command: distill });
    const w = sim.state.founder.whereabouts;
    if (w.kind === "PRESENT") expect(w.busy).toBeNull();
  });

  it("can't be repeated", () => {
    const sim = start();
    const mashed = sim.dispatch({ command: setMash });
    expect(sim.dispatch({ command: { type: "REPEAT_OPERATION", sourceCommandId: mashed.commandId } })).toMatchObject({
      status: "rejected",
      reason: { code: "NOT_REPEATABLE", sourceCommandId: mashed.commandId },
    });
  });

  it("replay of the eager commands from the command log reaches the same hash", () => {
    const original = start();
    original.dispatch({ command: setMash });
    original.advance(50);
    original.dispatch({ command: distill });
    original.advance(10);
    const replayed = start();
    for (const envelope of original.state.commandLog) {
      replayed.advance(envelope.scheduledTick - 1 - replayed.state.tick);
      replayed.replay(envelope);
    }
    replayed.advance(original.state.tick - replayed.state.tick);
    expect(replayed.stateHash()).toBe(original.stateHash());
  });
});

describe("START_PRODUCTION keeps its current behaviour until TS2 (ADR 0029 decision 16)", () => {
  it("founder rules off: a batch starts as a single-stage job, with no washes", () => {
    const sim = newGame();
    sim.dispatch({ command: { type: "PURCHASE_MATERIALS", supplierId: MILLERS_FEED, materialId: CORN, quantity: 2, facilityId: DISTILLERY_MAIN } });
    sim.dispatch({ command: { type: "PURCHASE_MATERIALS", supplierId: MILLERS_FEED, materialId: SUGAR, quantity: 1, facilityId: DISTILLERY_MAIN } });
    const started = sim.dispatch({ command: { type: "START_PRODUCTION", facilityId: DISTILLERY_MAIN, recipeId: BASIC_MOONSHINE_RECIPE, quantity: 1 } });
    expect(started.status).toBe("applied");
    expect(sim.state.productionJobs).toHaveLength(1);
    expect(sim.state.washes).toEqual([]);
  });

  it("founder rules on: it's judged by M001's gates, never TWO_STAGE_RECIPE (TS2 changes this)", () => {
    const sim = newGame({ scenario: THE_FIRST_HIRE_SCENARIO });
    sim.advance(400); // awake at Hollow Creek, with no materials
    const started = sim.dispatch({ command: { type: "START_PRODUCTION", facilityId: DISTILLERY_MAIN, recipeId: BASIC_MOONSHINE_RECIPE, quantity: 1 } });
    expect(started).toMatchObject({ status: "rejected", reason: { code: "INSUFFICIENT_MATERIALS" } });
    expect(sim.state.washes).toEqual([]);
  });
});
