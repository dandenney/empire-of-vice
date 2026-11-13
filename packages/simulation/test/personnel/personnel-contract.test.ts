// EM1 (#210, ADR 0025 decision 16 as restated by ADR 0028 decision 11): the new
// state at game creation, the `employees` phase slot, the command context's
// issuer, and HIRE_EMPLOYEE, SET_STANDING_ORDER and DISMISS_EMPLOYEE as accepted
// no-ops: with founder rules off (ADR 0025 decision 13), and with them on until
// E1 (#180) gives them behaviour (the orchestrator's decision on #210).

import { cents, tick, type GameCommand, type GameState } from "@eov/contracts";
import {
  BASIC_MOONSHINE_RECIPE,
  DISTILLERY_MAIN,
  FIRST_SHIPMENT_SCENARIO,
  GAME_DATA,
  THE_FIRST_HIRE_SCENARIO,
  type ScenarioDefinition,
} from "@eov/game-data";
import { describe, expect, it } from "vitest";
import { createGameRegistry, createInitialState, newGame, ScenarioSetupError } from "../../src/index.ts";
import { PHASES, type CommandContext, founderCommandId } from "../../src/kernel/registry.ts";
import { PERSONNEL_COMMAND_TYPES } from "../../src/personnel/personnel.ts";
import { orderValidators, playerViewOf } from "../../src/view/index.ts";

const terms = { kind: "DISTILL", recipeId: BASIC_MOONSHINE_RECIPE, keepOnHand: 20, batchSize: 10, spendingCap: cents(30_000), callWhen: "PROBLEMS" } as const;
const hire: GameCommand = { type: "HIRE_EMPLOYEE", characterId: "walt-hagen" as never, role: "DISTILLER", stationId: DISTILLERY_MAIN, dailyWage: cents(450), standingOrder: terms };
const order: GameCommand = { type: "SET_STANDING_ORDER", characterId: "walt-hagen" as never, terms };
const dismiss: GameCommand = { type: "DISMISS_EMPLOYEE", characterId: "walt-hagen" as never };
const COMMANDS: readonly [string, GameCommand][] = [
  ["HIRE_EMPLOYEE", hire],
  ["SET_STANDING_ORDER", order],
  ["DISMISS_EMPLOYEE", dismiss],
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

describe("the new state at game creation (ADR 0025 decision 14)", () => {
  it.each([
    ["M001 (founder rules off)", FIRST_SHIPMENT_SCENARIO],
    ["founder rules on", FOUNDER_RULES],
    ["the M002 scenario", THE_FIRST_HIRE_SCENARIO],
  ])("%s: no employees, no former employees, the StandingOrder counter at 1", (_label, scenario) => {
    const state = createInitialState(scenario, GAME_DATA);
    expect(state.employees).toEqual([]);
    expect(state.formerEmployees).toEqual([]);
    expect(state.counters.nextId.StandingOrder).toBe(1);
  });

  it("M001: none of them changes over three days, and the world snapshot shows no employees", () => {
    const sim = newGame();
    sim.advance(3 * 1_440);
    expect(sim.state.employees).toEqual([]);
    expect(sim.state.formerEmployees).toEqual([]);
    expect(sim.state.counters.nextId.StandingOrder).toBe(1);
    expect(sim.snapshot().employees).toEqual([]);
    expect(sim.playerSnapshot()).toMatchObject({ employees: [], hiring: null });
  });

  it("checks the scenario's first candidates against the pool", () => {
    expect(() => createInitialState({ ...THE_FIRST_HIRE_SCENARIO, firstCandidates: ["al-capone" as never] }, GAME_DATA)).toThrow(ScenarioSetupError);
    expect(() => createInitialState({ ...THE_FIRST_HIRE_SCENARIO, firstCandidates: ["walt-hagen", "walt-hagen"] as never }, GAME_DATA)).toThrow(/repeats/);
    expect(() => createInitialState({ ...THE_FIRST_HIRE_SCENARIO, firstCandidates: ["walt-hagen", "eddie-novak", "mae-brennan"] as never }, GAME_DATA)).toThrow(
      /3 DISTILLER candidates; a slate holds 2/,
    );
  });
});

describe("the employees phase and the command context (ADR 0025 decisions 6 and 10)", () => {
  it("runs right after production, before vehicles", () => {
    expect(PHASES).toEqual(["production", "employees", "vehicles", "resolution", "founder", "phones", "deadlines", "midnight"]);
  });

  it("has no hooks yet, flag on or off: E1 (#180) adds them (EM1 is the slot only)", () => {
    expect(createGameRegistry(GAME_DATA).hooks("employees")).toEqual([]);
    expect(createGameRegistry(GAME_DATA, undefined, undefined, { founderRules: true }).hooks("employees")).toEqual([]);
  });

  it("a founder-only handler needs the envelope; an employee's context has none", () => {
    const base = { tick: tick(1), dayIndex: 0, isMidnight: false, clock: newGame().snapshot().clock };
    const envelope = { id: "cmd-4" as never, scheduledTick: tick(1), sequence: 4, issuer: { kind: "FOUNDER" } as const, command: dismiss };
    const founder: CommandContext = { ...base, issuer: { kind: "FOUNDER" }, envelope };
    const employee: CommandContext = { ...base, issuer: { kind: "EMPLOYEE", characterId: "walt-hagen" as never, standingOrderId: "standing-1" as never }, envelope: null };
    expect(founderCommandId(founder)).toBe("cmd-4");
    expect(() => founderCommandId(employee)).toThrow(/EMPLOYEE/);
  });
});

describe.each([
  ["founder rules off", FIRST_SHIPMENT_SCENARIO, false],
  ["founder rules on (until E1)", FOUNDER_RULES, true],
] as const)("HIRE_EMPLOYEE, SET_STANDING_ORDER and DISMISS_EMPLOYEE with %s", (_label, scenario, founderRules) => {
  const start = () => newGame({ scenario });

  it("are the personnel system's commands, each with a handler", () => {
    expect(PERSONNEL_COMMAND_TYPES).toEqual(["HIRE_EMPLOYEE", "SET_STANDING_ORDER", "DISMISS_EMPLOYEE"]);
    const registry = createGameRegistry(GAME_DATA, undefined, undefined, { founderRules });
    for (const type of PERSONNEL_COMMAND_TYPES) expect(() => registry.commandHandler(type)).not.toThrow();
  });

  it.each(COMMANDS)("%s is accepted, changes no domain state and posts nothing; the command log grows", (_type, command) => {
    const sim = start();
    sim.advance(600);
    const before = sim.state;
    const result = sim.dispatch({ command });
    expect(result).toMatchObject({ status: "applied", eventIds: [] });
    expect(domain(sim.state)).toEqual(domain(before));
    expect(sim.state.ledger).toBe(before.ledger);
    expect(sim.state.counters.nextId.StandingOrder).toBe(1);
    expect(sim.state.commandLog).toEqual([...before.commandLog, { id: result.commandId, scheduledTick: 601, sequence: 1, issuer: { kind: "FOUNDER" }, command }]);
  });

  it("their validators accept every view: with no one hired, nothing is judged", () => {
    const sim = start();
    sim.advance(30);
    const validators = orderValidators(GAME_DATA, { founderRules });
    const view = playerViewOf(sim.state, GAME_DATA, { founderRules }, tick(sim.state.tick + 1));
    for (const [type, command] of COMMANDS) {
      expect(validators[type as (typeof PERSONNEL_COMMAND_TYPES)[number]](view, command as never), type).toBeNull();
    }
    // A stranger, a facility that isn't the family's, a wage nobody asked for: still accepted.
    const odd: GameCommand = { ...hire, characterId: "al-capone" as never, stationId: "riverside-warehouse" as never, dailyWage: cents(1) } as GameCommand;
    expect(sim.dispatch({ command: odd }).status).toBe("applied");
  });

  it("queued, they apply on their tick as no-ops; a run with them matches a run without them apart from the log", () => {
    const withCommands = start();
    const without = start();
    withCommands.dispatch({ command: hire, scheduledTick: tick(100) });
    withCommands.dispatch({ command: order, scheduledTick: tick(200) });
    withCommands.dispatch({ command: dismiss, scheduledTick: tick(300) });
    withCommands.advance(1_440);
    without.advance(1_440);
    expect(withCommands.state.commandLog.map((e) => e.command.type)).toEqual(["HIRE_EMPLOYEE", "SET_STANDING_ORDER", "DISMISS_EMPLOYEE"]);
    expect(withCommands.state.queuedCommands).toEqual([]);
    expect(withCommands.takeEvents().some((e) => e.type === "COMMAND_REJECTED")).toBe(false);
    expect(domain(withCommands.state)).toEqual(domain(without.state));
  });

  it("don't make the founder busy", () => {
    const sim = start();
    sim.advance(600);
    sim.dispatch({ command: hire });
    const w = sim.state.founder.whereabouts;
    if (w.kind === "PRESENT") expect(w.busy).toBeNull();
  });

  it("can't be repeated", () => {
    const sim = start();
    const hired = sim.dispatch({ command: hire });
    expect(sim.dispatch({ command: { type: "REPEAT_OPERATION", sourceCommandId: hired.commandId } })).toMatchObject({
      status: "rejected",
      reason: { code: "NOT_REPEATABLE", sourceCommandId: hired.commandId },
    });
  });

  it("replay of the eager commands from the command log reaches the same hash", () => {
    const original = start();
    original.dispatch({ command: hire });
    original.advance(50);
    original.dispatch({ command: order });
    original.advance(500);
    original.dispatch({ command: dismiss });
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
