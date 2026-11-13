// PH1 (#205, ADR 0024 decision 15 as restated by ADR 0027 decision 17): the new
// state at game creation, the `phones` phase slot, and PLACE_CALL, INSTALL_PHONE
// and RENT_ROOM as accepted no-ops with founder rules off (ADR 0024 decision 12,
// ADR 0027 decision 14). The phone behaviour is C1's (#179).

import { tick, type GameCommand, type GameState } from "@eov/contracts";
import { DISTILLERY_MAIN, FIRST_SHIPMENT_SCENARIO, GAME_DATA, KESSLER_PHARMACY, LAKEVIEW, type ScenarioDefinition } from "@eov/game-data";
import { describe, expect, it } from "vitest";
import { createGameRegistry, createInitialState, newGame } from "../../src/index.ts";
import { PHONE_COMMAND_TYPES } from "../../src/phones/phones.ts";

const call: GameCommand = { type: "PLACE_CALL", locationId: KESSLER_PHARMACY };
const install: GameCommand = { type: "INSTALL_PHONE", facilityId: DISTILLERY_MAIN };
const rent: GameCommand = { type: "RENT_ROOM", locationId: LAKEVIEW };

/** Everything but the command bookkeeping the kernel does for any applied command. */
function domain(state: GameState): Omit<GameState, "commandLog" | "counters"> {
  const { commandLog, counters, ...rest } = state;
  void commandLog;
  void counters;
  return rest;
}

describe("the new state at game creation (ADR 0024 decision 13, ADR 0027 decision 15)", () => {
  it.each([
    ["M001 (founder rules off)", FIRST_SHIPMENT_SCENARIO],
    ["founder rules on", { ...FIRST_SHIPMENT_SCENARIO, founderRules: true, realMsPerGameHourAt1x: 20_000 } satisfies ScenarioDefinition],
  ])("%s: no line, no room, no call, no messages, no arrangements", (_label, scenario) => {
    const state = createInitialState(scenario, GAME_DATA);
    expect(state.facilities.map((f) => f.phoneLine)).toEqual(state.facilities.map(() => null));
    expect(state.founder.room).toBeNull();
    if (state.founder.whereabouts.kind === "PRESENT") expect(state.founder.whereabouts.call).toBeNull();
    expect(state.knowledge.pendingMessages).toEqual([]);
    expect(state.arrangements).toEqual([]);
  });

  it("M001: none of them changes over three days", () => {
    const sim = newGame();
    sim.advance(3 * 1_440);
    expect(sim.state.facilities.every((f) => f.phoneLine === null)).toBe(true);
    expect(sim.state.founder).toEqual({ whereabouts: { kind: "PRESENT", locationId: sim.state.founder.whereabouts.kind === "PRESENT" ? sim.state.founder.whereabouts.locationId : null, busy: null, call: null }, awakeSince: 0, room: null });
    expect(sim.state.knowledge.pendingMessages).toEqual([]);
    expect(sim.state.arrangements).toEqual([]);
  });

  it("the world snapshot shows each facility's line, for the debug view", () => {
    expect(newGame().snapshot().facilities.map((f) => f.phoneLine)).toEqual([null]);
  });
});

describe("PLACE_CALL, INSTALL_PHONE and RENT_ROOM with founder rules off", () => {
  it("are the phone system's commands", () => {
    expect(PHONE_COMMAND_TYPES).toEqual(["PLACE_CALL", "INSTALL_PHONE", "RENT_ROOM"]);
  });

  it.each([
    ["PLACE_CALL", call],
    ["INSTALL_PHONE", install],
    ["RENT_ROOM", rent],
  ])("%s is accepted, changes no domain state and posts nothing; the command log grows", (_label, command) => {
    const sim = newGame();
    sim.advance(600);
    const before = sim.state;
    const result = sim.dispatch({ command });
    expect(result).toMatchObject({ status: "applied", eventIds: [] });
    expect(domain(sim.state)).toEqual(domain(before));
    expect(sim.state.ledger).toBe(before.ledger);
    expect(sim.state.commandLog).toEqual([...before.commandLog, { id: result.commandId, scheduledTick: 601, sequence: 1, issuer: { kind: "FOUNDER" }, command }]);
  });

  it("are accepted even where they'd fail with founder rules on: flag off judges nothing", () => {
    const sim = newGame();
    // The Crossroads has no phone; the feed store rents no rooms; a facility that isn't the family's.
    for (const command of [
      { type: "PLACE_CALL", locationId: "crossroads" },
      { type: "RENT_ROOM", locationId: "millers-feed" },
      { type: "INSTALL_PHONE", facilityId: "riverside-warehouse" },
    ] as GameCommand[]) {
      expect(sim.dispatch({ command }).status).toBe("applied");
    }
  });

  it("queued, they apply on their tick as no-ops, and a run with them matches a run without them apart from the log", () => {
    const withCommands = newGame();
    const without = newGame();
    withCommands.dispatch({ command: call, scheduledTick: tick(100) });
    withCommands.dispatch({ command: install, scheduledTick: tick(200) });
    withCommands.dispatch({ command: rent, scheduledTick: tick(300) });
    withCommands.advance(1_440);
    without.advance(1_440);
    expect(withCommands.state.commandLog.map((e) => e.command.type)).toEqual(["PLACE_CALL", "INSTALL_PHONE", "RENT_ROOM"]);
    expect(withCommands.state.queuedCommands).toEqual([]);
    expect(withCommands.takeEvents().some((e) => e.type === "COMMAND_REJECTED")).toBe(false);
    expect(domain(withCommands.state)).toEqual(domain(without.state));
  });

  it("can't be repeated", () => {
    const sim = newGame();
    const called = sim.dispatch({ command: call });
    expect(sim.dispatch({ command: { type: "REPEAT_OPERATION", sourceCommandId: called.commandId } })).toMatchObject({
      status: "rejected",
      reason: { code: "NOT_REPEATABLE", sourceCommandId: called.commandId },
    });
  });

  it("replay from the command log reaches the same hash", () => {
    const original = newGame();
    original.dispatch({ command: call });
    original.advance(50);
    original.dispatch({ command: install, scheduledTick: tick(400) });
    original.advance(500);
    original.dispatch({ command: rent });
    original.advance(10);
    const replayed = newGame();
    for (const envelope of original.state.commandLog) {
      replayed.advance(envelope.scheduledTick - 1 - replayed.state.tick);
      replayed.replay(envelope);
    }
    replayed.advance(original.state.tick - replayed.state.tick);
    expect(replayed.stateHash()).toBe(original.stateHash());
  });

  it("have a handler with founder rules on too (C1 replaces it), so dispatching one never hits an unregistered command", () => {
    const registry = createGameRegistry(GAME_DATA, undefined, undefined, { founderRules: true });
    for (const type of PHONE_COMMAND_TYPES) expect(() => registry.commandHandler(type)).not.toThrow();
  });
});
