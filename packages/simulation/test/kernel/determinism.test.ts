// SIM-001: same seed + same timed commands → identical state hash, however ticks
// are batched into advance() calls (1× vs 4× just changes the batching), and
// save → load → continue matches an uninterrupted run.

import { SAVE_SCHEMA_VERSION, tick, type GameCommand, type SaveGame } from "@eov/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { loadSimulation, type KernelSimulation } from "../../src/index.ts";
import {
  buyCorn,
  day0State,
  FACILITIES,
  fakeRegistry,
  fakeSimulation,
  GAME_DATA_VERSION,
  setWorkforce,
  START_DATE,
  unknownFacility,
} from "./fakes.ts";

const START = day0State.tick; // 600

const commandArb: fc.Arbitrary<GameCommand> = fc.oneof(
  fc.tuple(fc.constantFrom(...FACILITIES, unknownFacility), fc.integer({ min: -2, max: 12 })).map(([f, n]) => setWorkforce(f, n)),
  fc.integer({ min: -1, max: 70 }).map(buyCorn),
);

/** Commands with absolute target ticks, some in the past, within a run of `ticks`. */
const scriptArb = (maxTicks: number) =>
  fc.integer({ min: 1, max: maxTicks }).chain((ticks) =>
    fc.record({
      ticks: fc.constant(ticks),
      commands: fc.array(
        fc.record({ command: commandArb, at: fc.integer({ min: START - 5, max: START + ticks }) }),
        { maxLength: 25 },
      ),
      cuts: fc.array(fc.integer({ min: 1, max: ticks }), { maxLength: 12 }),
    }),
  );

/** Splits `total` ticks into batch sizes at the given cut points. */
function batches(total: number, cuts: readonly number[]): number[] {
  const points = [...new Set(cuts.filter((c) => c > 0 && c < total))].sort((a, b) => a - b);
  const sizes: number[] = [];
  let last = 0;
  for (const p of [...points, total]) {
    sizes.push(p - last);
    last = p;
  }
  return sizes;
}

function dispatchAll(sim: KernelSimulation, commands: readonly { command: GameCommand; at: number }[]): void {
  for (const { command, at } of commands) sim.dispatch({ command, scheduledTick: tick(Math.max(0, at)) });
}

describe("determinism (SIM-001)", () => {
  it("same timed commands give the same hash and events however advance() is batched", () => {
    fc.assert(
      fc.property(scriptArb(4_000), ({ ticks, commands, cuts }) => {
        const single = fakeSimulation();
        dispatchAll(single, commands);
        single.advance(ticks);

        const batched = fakeSimulation();
        dispatchAll(batched, commands);
        const batchedEvents = [...batched.takeEvents()];
        for (const size of batches(ticks, cuts)) {
          batched.advance(size);
          batchedEvents.push(...batched.takeEvents());
        }

        expect(batched.state.tick).toBe(START + ticks);
        expect(batched.stateHash()).toBe(single.stateHash());
        expect(batchedEvents).toEqual(single.takeEvents());
      }),
      { numRuns: 40 },
    );
  });

  it("tick-by-tick (advance(1) every time) matches one big advance", () => {
    fc.assert(
      fc.property(scriptArb(3_000), ({ ticks, commands }) => {
        const single = fakeSimulation();
        dispatchAll(single, commands);
        single.advance(ticks);

        const stepped = fakeSimulation();
        dispatchAll(stepped, commands);
        for (let i = 0; i < ticks; i++) stepped.advance(1);
        expect(stepped.stateHash()).toBe(single.stateHash());
      }),
      { numRuns: 10 },
    );
  });

  it("an immediate dispatch between batches equals the same command queued in advance for the next tick", () => {
    // Commands chosen to always apply, so the immediate and queued paths can't
    // differ in how a rejection is reported (sync result vs COMMAND_REJECTED).
    const alwaysValid = fc.oneof(
      fc.tuple(fc.constantFrom(...FACILITIES), fc.integer({ min: 0, max: 12 })).map(([f, n]) => setWorkforce(f, n)),
      fc.integer({ min: 1, max: 5 }).map(buyCorn),
    );
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 3_000 }).chain((ticks) =>
          fc.record({
            ticks: fc.constant(ticks),
            commands: fc.array(fc.record({ command: alwaysValid, at: fc.integer({ min: START, max: START + ticks - 1 }) }), {
              maxLength: 20,
            }),
          }),
        ),
        ({ ticks, commands }) => {
          const ordered = [...commands].sort((a, b) => a.at - b.at);

          const live = fakeSimulation();
          for (const { command, at } of ordered) {
            live.advance(at - live.state.tick);
            const result = live.dispatch({ command });
            expect(result.status).toBe("applied");
          }
          live.advance(START + ticks - live.state.tick);

          const scripted = fakeSimulation();
          for (const { command, at } of ordered) scripted.dispatch({ command, scheduledTick: tick(at + 1) });
          scripted.advance(ticks);

          expect(live.stateHash()).toBe(scripted.stateHash());
        },
      ),
      { numRuns: 30 },
    );
  });
});

describe("save → load → continue (SIM-001, ADR 0008)", () => {
  it("matches an uninterrupted run, with the save passed through JSON", () => {
    fc.assert(
      fc.property(
        scriptArb(4_000).chain((script) => fc.record({ script: fc.constant(script), saveAt: fc.integer({ min: 0, max: script.ticks }) })),
        ({ script: { ticks, commands }, saveAt }) => {
          const uninterrupted = fakeSimulation();
          dispatchAll(uninterrupted, commands);
          uninterrupted.advance(ticks);

          const first = fakeSimulation();
          dispatchAll(first, commands);
          first.advance(saveAt);
          const save = JSON.parse(JSON.stringify(first.serialize())) as ReturnType<typeof first.serialize>;
          const resumed = loadSimulation(save, { registry: fakeRegistry(), startDate: START_DATE, gameDataVersion: GAME_DATA_VERSION });
          expect(resumed.stateHash()).toBe(first.stateHash());
          resumed.advance(ticks - saveAt);

          expect(resumed.stateHash()).toBe(uninterrupted.stateHash());
        },
      ),
      { numRuns: 40 },
    );
  });

  it("saving exactly at midnight doesn't settle that midnight twice", () => {
    const uninterrupted = fakeSimulation();
    uninterrupted.advance(3_000);

    const first = fakeSimulation();
    first.advance(1_440 - START); // tick 1440 (midnight) has just been processed
    expect(first.state.tick).toBe(1_440);
    const resumed = loadSimulation(first.serialize(), { registry: fakeRegistry(), startDate: START_DATE, gameDataVersion: GAME_DATA_VERSION });
    resumed.advance(3_000 - (1_440 - START));

    const settled = [...first.takeEvents(), ...resumed.takeEvents()].filter((e) => e.type === "MARKET_UPDATED");
    expect(settled.map((e) => e.tick)).toEqual([1_440, 2_880]);
    expect(resumed.stateHash()).toBe(uninterrupted.stateHash());
  });

  it("serialize() produces a SaveGame around the authoritative state", () => {
    const sim = fakeSimulation();
    const save: SaveGame = sim.serialize();
    expect(save).toMatchObject({ format: "empire-of-vice/save", schemaVersion: SAVE_SCHEMA_VERSION, scenarioId: day0State.scenarioId, gameDataVersion: GAME_DATA_VERSION });
    expect(save.state).toBe(sim.state);
  });
});

describe("immutability", () => {
  const deepFreeze = <T>(value: T): T => {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const child of Object.values(value)) deepFreeze(child);
    }
    return value;
  };

  it("the kernel never mutates a state it was given or has published", () => {
    const initial = deepFreeze(structuredClone(day0State));
    const sim = fakeSimulation(initial);
    sim.dispatch({ command: buyCorn(10) });
    sim.dispatch({ command: setWorkforce(FACILITIES[0]!, 4), scheduledTick: tick(2_000) });
    deepFreeze(sim.state);
    sim.advance(1_500);
    deepFreeze(sim.state);
    sim.dispatch({ command: buyCorn(5) });
    sim.advance(3_000); // ES modules are strict, so writing to a frozen object throws
    expect(sim.state.tick).toBe(5_100);
  });
});
