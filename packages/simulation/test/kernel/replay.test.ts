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

type Seen = Record<"immediate" | "queued" | "dispatchRejected" | "applyRejected" | "rejectedOnApplyReplay" | "rejectedOnApplyAfterDrain", number>;

const newSeen = (): Seen => ({ immediate: 0, queued: 0, dispatchRejected: 0, applyRejected: 0, rejectedOnApplyReplay: 0, rejectedOnApplyAfterDrain: 0 });

/**
 * Runs `steps` on a fresh simulation, then `tail` more ticks past the last queued
 * command, and checks the command log. Then replays the log on two more fresh
 * simulations, once up front and once incrementally (where `catchUp[i]` says to
 * advance to just before entry i's tick first), and checks that both reproduce
 * the hash, the log, and the events.
 *
 * The replay procedure (ADR 0004 amendment, issue #66): place the envelopes due
 * at or before the end tick, advance to the end tick, then place the envelopes
 * due at end tick + 1. Only commands applied on the run's last tick can be due
 * then: immediate dispatches, and any queued commands for end tick + 1 that such
 * a dispatch drained ahead of itself. Placing them after the advance, in log
 * order, applies them at once, as the original run did. Placed before the
 * advance, they'd stay queued and never apply.
 *
 * Returns how many envelopes were due at end tick + 1.
 */
function checkRun(steps: readonly Step[], tail: number, catchUp: readonly boolean[], seen: Seen): number {
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
  // envelopes due by the end tick placed up front, and once incrementally, where
  // fast-check picks which envelopes are placed just before their tick. Those
  // apply at once (eagerly), possibly behind lower-sequence siblings still queued
  // for the same tick, and an apply failure there is `rejected-on-apply`. Either
  // way, the envelopes due at end tick + 1 are placed after advancing to the end.
  const endTick = original.state.tick;
  const due = log.filter((e) => e.scheduledTick <= endTick);
  const trailing = log.filter((e) => e.scheduledTick > endTick);
  for (const envelope of trailing) expect(envelope.scheduledTick).toBe(endTick + 1);
  const finish = (replayed: ReturnType<typeof fakeSimulation>): void => {
    replayed.advance(endTick - replayed.state.tick);
    for (const envelope of trailing) expect(replayed.replay(envelope).status).not.toBe("rejected");
  };

  const upFront = fakeSimulation();
  for (const envelope of due) expect(upFront.replay(envelope).status).not.toBe("rejected");
  finish(upFront);

  const incremental = fakeSimulation();
  due.forEach((envelope, i) => {
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
  finish(incremental);

  for (const replayed of [upFront, incremental]) {
    expect(replayed.state.tick).toBe(endTick);
    expect(replayed.stateHash()).toBe(original.stateHash());
    expect(replayed.state.commandLog).toEqual(log);
    // The same events, with the same IDs: including every COMMAND_REJECTED.
    expect(replayed.takeEvents()).toEqual(events);
  }
  return trailing.length;
}

describe("command log replay (T01b)", () => {
  it("holds every command accepted at dispatch, and replaying it reproduces the hash and the events", () => {
    const seen = newSeen();

    fc.assert(
      fc.property(
        fc.array(stepArb, { maxLength: 40 }),
        fc.integer({ min: 0, max: 600 }),
        // Per log entry: in the incremental replay, advance to just before its tick first?
        fc.array(fc.boolean(), { maxLength: 60 }),
        (steps, tail, catchUp) => {
          checkRun(steps, tail, catchUp, seen);
        },
      ),
      { numRuns: 200 },
    );

    // The generator really did mix every kind of command, and the incremental
    // replay really did reach the eager `rejected-on-apply` path, including with
    // queued commands drained ahead of the failing envelope.
    for (const count of Object.values(seen)) expect(count).toBeGreaterThan(0);
  });

  // Issue #66, found by fast-check seed 1715386024, path "171:2:0:3:2:51:50:50:50".
  // The run ends on an immediate dispatch with no tail, so its envelope is logged
  // for end tick + 1. Replays that placed it before advancing to the end tick left
  // it queued, and came out with a different hash.
  it("replays an immediate dispatch made on the run's last tick (issue #66)", () => {
    const steps: Step[] = [
      { kind: "advance", ticks: 18 },
      { kind: "advance", ticks: 354 },
      { kind: "advance", ticks: 361 },
      { kind: "advance", ticks: 216 },
      { kind: "advance", ticks: 370 },
      { kind: "dispatch", command: setWorkforce(FACILITIES[0]!, 0), when: { kind: "now" } },
    ];
    // The run ends at tick 1919, so the immediate dispatch (due 1920) also drains
    // the start state's queued cmd-2 (due 1920) ahead of itself: two envelopes are
    // due at end tick + 1. As found (no incremental catch-up), and with every
    // incremental placement caught up.
    expect(checkRun(steps, 0, [], newSeen())).toBe(2);
    expect(checkRun(steps, 0, Array<boolean>(steps.length).fill(true), newSeen())).toBe(2);
  });

  // The two ways into end tick + 1 on their own (#68 review), after the start
  // state's queue has run out. The run ends with no tail on an immediate dispatch,
  // which is logged for E + 1 before that tick is processed.
  it("replays an immediate dispatch on the run's last tick, with nothing queued (issue #66)", () => {
    const steps: Step[] = [
      { kind: "advance", ticks: 1_400 },
      { kind: "dispatch", command: setWorkforce(FACILITIES[0]!, 1), when: { kind: "now" } },
    ];
    expect(checkRun(steps, 0, [], newSeen())).toBe(1);
    expect(checkRun(steps, 0, Array<boolean>(steps.length).fill(true), newSeen())).toBe(1);
  });

  // A command queued for E + 1, then an immediate dispatch at E that drains it
  // ahead of itself: the queued command is logged for E + 1 too, before that tick
  // is processed, and both replay after the advance, in log order.
  it("replays a queued command drained by an immediate dispatch on the run's last tick (issue #66)", () => {
    const steps: Step[] = [
      { kind: "advance", ticks: 1_400 },
      { kind: "dispatch", command: setWorkforce(FACILITIES[1]!, 2), when: { kind: "offset", n: 5 } },
      { kind: "advance", ticks: 4 },
      { kind: "dispatch", command: setWorkforce(FACILITIES[0]!, 1), when: { kind: "now" } },
    ];
    expect(checkRun(steps, 0, [], newSeen())).toBe(2);
    expect(checkRun(steps, 0, Array<boolean>(steps.length).fill(true), newSeen())).toBe(2);
  });
});
