// The command log is complete enough to replay any run (ADR 0004 amendment, T01b,
// issue #25). Property test over random command scripts that mix immediate,
// queued, dispatch-rejected, and apply-rejected commands.

import { tick, type CommandResult, type GameCommand, type GameEvent } from "@eov/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compareEnvelopes } from "../../src/index.ts";
import { buyCorn, day0State, FACILITIES, fakeSimulation, setWorkforce, unknownFacility } from "./fakes.ts";

// Wide enough to fail in every way: invalid counts are rejected by `validate` (at
// dispatch), an unknown facility passes `validate` but fails in `apply`, and large
// corn orders drain the supplier, so queued orders can fail when their tick arrives.
const commandArb: fc.Arbitrary<GameCommand> = fc.oneof(
  fc.tuple(fc.constantFrom(...FACILITIES, unknownFacility), fc.integer({ min: -2, max: 12 })).map(([f, n]) => setWorkforce(f, n)),
  fc.integer({ min: -1, max: 120 }).map(buyCorn),
);

type Step =
  | { readonly kind: "advance"; readonly ticks: number }
  /** `offset` null: immediate (no scheduledTick). Otherwise scheduledTick = state.tick + offset; ≤ 0 is in the past, 1 is the next tick. */
  | { readonly kind: "dispatch"; readonly command: GameCommand; readonly offset: number | null };

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { weight: 1, arbitrary: fc.integer({ min: 0, max: 400 }).map((ticks) => ({ kind: "advance" as const, ticks })) },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("dispatch" as const),
      command: commandArb,
      offset: fc.option(fc.integer({ min: -3, max: 800 }), { nil: null }),
    }),
  },
);

interface Run {
  readonly results: readonly { readonly result: CommandResult; readonly scheduledTick: number }[];
  readonly events: readonly GameEvent[];
}

describe("command log replay (T01b)", () => {
  it("holds every command accepted at dispatch, and replaying it reproduces the hash and the events", () => {
    const seen = { immediate: 0, queued: 0, dispatchRejected: 0, applyRejected: 0 };

    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 40 }), fc.integer({ min: 0, max: 600 }), (steps, tail) => {
        const original = fakeSimulation();
        const run: Run = { results: [], events: [] };
        const results = run.results as Run["results"][number][];
        const events = run.events as GameEvent[];

        for (const step of steps) {
          if (step.kind === "advance") {
            original.advance(step.ticks);
            events.push(...original.takeEvents());
            continue;
          }
          const scheduledTick = step.offset === null ? original.state.tick + 1 : original.state.tick + step.offset;
          const hashBefore = original.stateHash();
          const result = original.dispatch(
            step.offset === null ? { command: step.command } : { command: step.command, scheduledTick: tick(Math.max(0, scheduledTick)) },
          );
          if (result.status === "rejected") {
            // Rejected at dispatch: nothing changed (#23 round 1).
            expect(original.stateHash()).toBe(hashBefore);
            seen.dispatchRejected++;
          } else if (result.status === "applied") {
            seen.immediate++;
          } else {
            seen.queued++;
          }
          results.push({ result, scheduledTick });
          events.push(...original.takeEvents());
        }
        // Run past every queued command, so the log is the whole story.
        const lastQueued = original.state.queuedCommands.at(-1)?.scheduledTick ?? original.state.tick;
        original.advance(Math.max(0, lastQueued - original.state.tick) + tail);
        events.push(...original.takeEvents());
        expect(original.state.queuedCommands).toEqual([]);

        const log = original.state.commandLog;
        const applyRejected = events.filter((e) => e.type === "COMMAND_REJECTED");
        seen.applyRejected += applyRejected.length;

        // Every command accepted at dispatch is logged once, as its original envelope,
        // in (scheduledTick, sequence) order; dispatch-time rejections never are.
        const accepted = results.filter(({ result }) => result.status !== "rejected").map(({ result }) => result.commandId);
        const expectedIds = [...day0State.commandLog, ...day0State.queuedCommands].map((e) => e.id).concat(accepted);
        expect([...log.map((e) => e.id)].sort()).toEqual([...expectedIds].sort());
        expect(new Set(log.map((e) => e.sequence)).size).toBe(log.length);
        for (let i = 1; i < log.length; i++) expect(compareEnvelopes(log[i - 1]!, log[i]!)).toBeLessThan(0);
        for (const { result, scheduledTick } of results) {
          if (result.status === "rejected") continue;
          expect(log.find((e) => e.id === result.commandId)).toMatchObject({ scheduledTick });
        }
        // Apply-time rejections are in the log too.
        for (const rejection of applyRejected) expect(log.map((e) => e.id)).toContain(rejection.causedBy);

        // Replay on a fresh simulation from the same start state.
        const replayed = fakeSimulation();
        for (const envelope of log) {
          const replay = replayed.replay(envelope);
          expect(replay.status).not.toBe("rejected");
        }
        replayed.advance(original.state.tick - replayed.state.tick);
        expect(replayed.stateHash()).toBe(original.stateHash());
        // The same events, with the same IDs: including every COMMAND_REJECTED.
        expect(replayed.takeEvents()).toEqual(events);
      }),
      { numRuns: 100 },
    );

    // The generator really did mix every kind of command.
    for (const count of Object.values(seen)) expect(count).toBeGreaterThan(0);
  });
});
