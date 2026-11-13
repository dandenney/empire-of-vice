// P1 (#193, ADR 0023 decision 11): the founder state at game creation, the
// founder phase slot, and TRAVEL / REST / WAKE as flag-off no-ops (decision 9).
// Flag-on behaviour (SK1a) is in presence.test.ts and no-trap.locked.test.ts.

import { tick, type GameCommand, type GameState } from "@eov/contracts";
import { FIRST_SHIPMENT_SCENARIO, GAME_DATA, HOLLOW_CREEK, LAKEVIEW, MODEL_TT_TRUCK, START_WAKE_TICK, type ScenarioDefinition } from "@eov/game-data";
import { describe, expect, it } from "vitest";
import { createGameRegistry, createInitialState, newGame, PHASES, ScenarioSetupError } from "../../src/index.ts";
import { FOUNDER_COMMAND_TYPES } from "../../src/founder/founder.ts";

const travel: GameCommand = { type: "TRAVEL", destinationLocationId: LAKEVIEW, transport: { kind: "FOOT" }, via: null };
const drive: GameCommand = { type: "TRAVEL", destinationLocationId: LAKEVIEW, transport: { kind: "VEHICLE", vehicleId: MODEL_TT_TRUCK }, via: null };
const rest: GameCommand = { type: "REST", untilTick: tick(1) }; // out of range under founder rules: flag off doesn't judge it
const wake: GameCommand = { type: "WAKE" };

/** Everything but the command bookkeeping the kernel does for any applied command. */
function domain(state: GameState): Omit<GameState, "commandLog" | "counters"> {
  const { commandLog, counters, ...rest } = state;
  void commandLog;
  void counters;
  return rest;
}

describe("the founder at game creation (decisions 1, 7, 9)", () => {
  it("M001 (founder rules off): present at Hollow Creek, not busy, never changing", () => {
    const sim = newGame();
    const expected = { whereabouts: { kind: "PRESENT", locationId: HOLLOW_CREEK, busy: null, call: null }, awakeSince: 0, room: null };
    expect(sim.state.founder).toEqual(expected);
    sim.advance(3 * 1_440);
    expect(sim.state.founder).toEqual(expected);
  });

  it("parks every vehicle at its home facility's location", () => {
    expect(newGame().state.vehicles).toEqual([{ id: MODEL_TT_TRUCK, parkedAt: HOLLOW_CREEK, tripCount: 0, trip: null }]);
  });

  it("with founder rules on, starts the founder resting at the start location until START_WAKE_TICK", () => {
    const scenario: ScenarioDefinition = { ...FIRST_SHIPMENT_SCENARIO, founderRules: true, realMsPerGameHourAt1x: 20_000 };
    expect(createInitialState(scenario, GAME_DATA).founder).toEqual({
      whereabouts: { kind: "RESTING", locationId: HOLLOW_CREEK, startedAt: 0, until: START_WAKE_TICK },
      awakeSince: 0,
      room: null,
    });
  });

  it("starts the founder at the scenario's start location, which must exist", () => {
    const at = (founderStartLocationId: ScenarioDefinition["founderStartLocationId"]) =>
      createInitialState({ ...FIRST_SHIPMENT_SCENARIO, founderStartLocationId }, GAME_DATA);
    expect(at(LAKEVIEW).founder.whereabouts).toEqual({ kind: "PRESENT", locationId: LAKEVIEW, busy: null, call: null });
    expect(() => at("nowhere" as never)).toThrow(ScenarioSetupError);
  });
});

describe("the founder phase (decision 2a)", () => {
  it("runs after resolution, then the phones phase (ADR 0024 decision 8), then deadlines", () => {
    expect(PHASES).toEqual(["production", "vehicles", "resolution", "founder", "phones", "deadlines", "midnight"]);
  });

  it("has no hooks with founder rules off (presence.test.ts covers them on)", () => {
    expect(createGameRegistry(GAME_DATA).hooks("founder")).toEqual([]);
  });

  it("has no phones hooks yet, flag on or off: C1 (#179) adds them (PH1 is the slot only)", () => {
    expect(createGameRegistry(GAME_DATA).hooks("phones")).toEqual([]);
    expect(createGameRegistry(GAME_DATA, undefined, undefined, { founderRules: true }).hooks("phones")).toEqual([]);
  });
});

describe("TRAVEL, REST and WAKE with founder rules off (decision 9)", () => {
  it("are the founder system's commands", () => {
    expect(FOUNDER_COMMAND_TYPES).toEqual(["TRAVEL", "REST", "WAKE"]);
  });

  it.each([
    ["TRAVEL on foot", travel],
    ["TRAVEL by truck", drive],
    ["REST", rest],
    ["WAKE", wake],
  ])("%s is accepted, changes no domain state and posts nothing; the command log grows", (_label, command) => {
    const sim = newGame();
    sim.advance(600);
    const before = sim.state;
    const result = sim.dispatch({ command });
    expect(result).toMatchObject({ status: "applied", eventIds: [] });
    expect(domain(sim.state)).toEqual(domain(before));
    expect(sim.state.ledger).toBe(before.ledger);
    expect(sim.state.commandLog).toEqual([...before.commandLog, { id: result.commandId, scheduledTick: 601, sequence: 1, issuer: { kind: "FOUNDER" }, command }]);
    expect(sim.stateHash()).not.toBe(newGame().stateHash());
  });

  it("queued, they apply on their tick as no-ops, and a run with them matches a run without them apart from the log", () => {
    const withCommands = newGame();
    const without = newGame();
    withCommands.dispatch({ command: drive, scheduledTick: tick(100) });
    withCommands.dispatch({ command: rest, scheduledTick: tick(200) });
    withCommands.dispatch({ command: wake, scheduledTick: tick(300) });
    withCommands.advance(1_440);
    without.advance(1_440);
    expect(withCommands.state.commandLog.map((e) => e.command.type)).toEqual(["TRAVEL", "REST", "WAKE"]);
    expect(withCommands.state.queuedCommands).toEqual([]);
    expect(withCommands.takeEvents().some((e) => e.type === "COMMAND_REJECTED")).toBe(false);
    expect(domain(withCommands.state)).toEqual(domain(without.state));
  });

  it("can't be repeated: REPEAT_OPERATION repeats only purchases, production and deliveries", () => {
    const sim = newGame();
    const travelled = sim.dispatch({ command: travel });
    expect(sim.dispatch({ command: { type: "REPEAT_OPERATION", sourceCommandId: travelled.commandId } })).toMatchObject({
      status: "rejected",
      reason: { code: "NOT_REPEATABLE", sourceCommandId: travelled.commandId },
    });
  });

  it("replay from the command log reaches the same hash", () => {
    const original = newGame();
    original.dispatch({ command: travel });
    original.advance(50);
    original.dispatch({ command: rest, scheduledTick: tick(400) });
    original.advance(500);
    original.dispatch({ command: wake });
    original.advance(10);
    const replayed = newGame();
    for (const envelope of original.state.commandLog) {
      replayed.advance(envelope.scheduledTick - 1 - replayed.state.tick);
      replayed.replay(envelope);
    }
    replayed.advance(original.state.tick - replayed.state.tick);
    expect(replayed.stateHash()).toBe(original.stateHash());
  });
});
