// The kernel's journal replay helper (ADR 0004 replay procedure, issue #66;
// T06a, issue #135). It's the one replay implementation: the economy lab's
// replay check and the save/load parity tests both use it.

import { tick, type GameCommand, type GameEvent } from "@eov/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { journalOf, KernelError, replayJournal } from "../../src/index.ts";
import { buyCorn, FACILITIES, fakeSimulation, setWorkforce, unknownFacility } from "./fakes.ts";

type Step =
  | { readonly kind: "advance"; readonly ticks: number }
  | { readonly kind: "now"; readonly command: GameCommand }
  | { readonly kind: "later"; readonly command: GameCommand; readonly offset: number };

const commandArb: fc.Arbitrary<GameCommand> = fc.oneof(
  fc.tuple(fc.constantFrom(...FACILITIES, unknownFacility), fc.integer({ min: -1, max: 9 })).map(([f, n]) => setWorkforce(f, n)),
  fc.integer({ min: -1, max: 120 }).map(buyCorn),
);

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  fc.integer({ min: 0, max: 300 }).map((ticks) => ({ kind: "advance" as const, ticks })),
  commandArb.map((command) => ({ kind: "now" as const, command })),
  fc.tuple(commandArb, fc.integer({ min: 1, max: 900 })).map(([command, offset]) => ({ kind: "later" as const, command, offset })),
);

/** Runs `steps` on a fresh fake simulation. Unlike the T01b property test, it stops wherever the steps end: commands may still be queued. */
function run(steps: readonly Step[]) {
  const sim = fakeSimulation();
  const events: GameEvent[] = [];
  for (const step of steps) {
    if (step.kind === "advance") sim.advance(step.ticks);
    else if (step.kind === "now") sim.dispatch({ command: step.command });
    else sim.dispatch({ command: step.command, scheduledTick: tick(sim.state.tick + step.offset) });
    events.push(...sim.takeEvents());
  }
  return { sim, events };
}

describe("replayJournal (ADR 0004 replay procedure)", () => {
  it("replays an immediate dispatch made on the run's last tick, which an up-front replay misses (issue #66)", () => {
    const { sim: original } = run([
      { kind: "advance", ticks: 1_400 },
      { kind: "now", command: setWorkforce(FACILITIES[0]!, 3) },
    ]);
    const end = original.state.tick;
    const log = journalOf(original.state);
    // The last envelope is due at end + 1: it was applied eagerly on the last tick.
    expect(log.at(-1)!.scheduledTick).toBe(end + 1);

    const replayed = fakeSimulation();
    const results = replayJournal(replayed, log, end);
    expect(results.map((r) => r.status)).not.toContain("rejected");
    expect(replayed.state.tick).toBe(end);
    expect(replayed.stateHash()).toBe(original.stateHash());

    // The naive procedure (every envelope up front, then advance) leaves it queued.
    const naive = fakeSimulation();
    for (const e of log) naive.replay(e);
    naive.advance(end - naive.state.tick);
    expect(naive.stateHash()).not.toBe(original.stateHash());
  });

  it("queues commands still pending at the end tick again, so both runs continue the same way", () => {
    const { sim: original } = run([
      { kind: "advance", ticks: 1_400 },
      { kind: "later", command: setWorkforce(FACILITIES[1]!, 4), offset: 300 },
      { kind: "advance", ticks: 10 },
    ]);
    const end = original.state.tick;
    expect(original.state.queuedCommands.length).toBeGreaterThan(0);

    const replayed = fakeSimulation();
    const results = replayJournal(replayed, journalOf(original.state), end);
    expect(results.at(-1)!.status).toBe("queued");
    expect(replayed.state.queuedCommands).toEqual(original.state.queuedCommands);
    expect(replayed.stateHash()).toBe(original.stateHash());

    original.advance(500);
    replayed.advance(500);
    expect(replayed.stateHash()).toBe(original.stateHash());
  });

  it("refuses a target already past the end tick", () => {
    const target = fakeSimulation();
    target.advance(10);
    expect(() => replayJournal(target, [], tick(5))).toThrow(KernelError);
  });

  it("reproduces the hash and the events of any run, wherever it stops, and both continue the same", () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 30 }), fc.integer({ min: 0, max: 600 }), (steps, more) => {
        const { sim: original, events } = run(steps);
        const replayed = fakeSimulation();
        replayJournal(replayed, journalOf(original.state), original.state.tick);
        expect(replayed.stateHash()).toBe(original.stateHash());
        expect(replayed.takeEvents()).toEqual(events);

        original.advance(more);
        replayed.advance(more);
        expect(replayed.stateHash()).toBe(original.stateHash());
      }),
      { numRuns: 150 },
    );
  });
});
