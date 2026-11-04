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

/**
 * When a dispatch is scheduled:
 * - `now`: immediate (no scheduledTick);
 * - `offset`: scheduledTick = state.tick + n (≤ 0 is in the past, 1 is the next tick);
 * - `at`: an absolute tick from a small pool, so several commands share a tick
 *   and replay sees lower-sequence siblings still queued when one applies.
 */
type When = { readonly kind: "now" } | { readonly kind: "offset"; readonly n: number } | { readonly kind: "at"; readonly tick: number };

type Step =
  | { readonly kind: "advance"; readonly ticks: number }
  | { readonly kind: "dispatch"; readonly command: GameCommand; readonly when: When };

const whenArb: fc.Arbitrary<When> = fc.oneof(
  fc.constant({ kind: "now" as const }),
  fc.integer({ min: -3, max: 800 }).map((n) => ({ kind: "offset" as const, n })),
  fc.constantFrom(700, 900, 1_500, 1_920, 2_500).map((t) => ({ kind: "at" as const, tick: t })),
);

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { weight: 1, arbitrary: fc.integer({ min: 0, max: 400 }).map((ticks) => ({ kind: "advance" as const, ticks })) },
  {
    weight: 3,
    arbitrary: fc.record({ kind: fc.constant("dispatch" as const), command: commandArb, when: whenArb }),
  },
);

function scheduledTickOf(when: When, current: number): number {
  return when.kind === "now" ? current + 1 : when.kind === "offset" ? current + when.n : when.tick;
}

interface Run {
  readonly results: readonly { readonly result: CommandResult; readonly scheduledTick: number }[];
  readonly events: readonly GameEvent[];
}

describe("command log replay (T01b)", () => {
  it("holds every command accepted at dispatch, and replaying it reproduces the hash and the events", () => {
    const seen = { immediate: 0, queued: 0, dispatchRejected: 0, applyRejected: 0, rejectedOnApplyReplay: 0, rejectedOnApplyAfterDrain: 0 };

    fc.assert(
      fc.property(
        fc.array(stepArb, { maxLength: 40 }),
        fc.integer({ min: 0, max: 600 }),
        // Per log entry: in the incremental replay, advance to just before its tick first?
        fc.array(fc.boolean(), { maxLength: 60 }),
        (steps, tail, catchUp) => {
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
            const scheduledTick = scheduledTickOf(step.when, original.state.tick);
            const hashBefore = original.stateHash();
            const result = original.dispatch(
              step.when.kind === "now" ? { command: step.command } : { command: step.command, scheduledTick: tick(Math.max(0, scheduledTick)) },
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

          // Replay on a fresh simulation from the same start state: once with the
          // whole log placed up front, and once incrementally, where fast-check picks
          // which envelopes are placed just before their tick. Those apply at once
          // (eagerly), possibly behind lower-sequence siblings still queued for the
          // same tick, and an apply failure there is `rejected-on-apply`.
          const upFront = fakeSimulation();
          for (const envelope of log) expect(upFront.replay(envelope).status).not.toBe("rejected");

          const incremental = fakeSimulation();
          log.forEach((envelope, i) => {
            const gap = envelope.scheduledTick - 1 - incremental.state.tick;
            if (catchUp[i] === true && gap > 0) incremental.advance(gap);
            const queuedAhead = incremental.state.queuedCommands.filter((e) => compareEnvelopes(e, envelope) < 0).length;
            const replay = incremental.replay(envelope);
            expect(replay.status).not.toBe("rejected");
            if (replay.status === "rejected-on-apply") {
              seen.rejectedOnApplyReplay++;
              if (queuedAhead > 0) seen.rejectedOnApplyAfterDrain++;
            }
          });

          for (const replayed of [upFront, incremental]) {
            replayed.advance(original.state.tick - replayed.state.tick);
            expect(replayed.stateHash()).toBe(original.stateHash());
            expect(replayed.state.commandLog).toEqual(log);
            // The same events, with the same IDs: including every COMMAND_REJECTED.
            expect(replayed.takeEvents()).toEqual(events);
          }
        },
      ),
      { numRuns: 200 },
    );

    // The generator really did mix every kind of command, and the incremental
    // replay really did reach the eager `rejected-on-apply` path, including with
    // queued commands drained ahead of the failing envelope.
    for (const count of Object.values(seen)) expect(count).toBeGreaterThan(0);
  });
});
