// The event journal (ADR 0006) and takeEvents().

import { EVENT_JOURNAL_CAPACITY } from "@eov/contracts";
import { ids } from "@eov/contracts/fixtures";
import { describe, expect, it } from "vitest";
import { emitEvents, EventEmissionError, type PhaseHook } from "../../src/index.ts";
import { day0State, fakeSimulation } from "./fakes.ts";

/** Emits three log events every tick. */
const chatty: PhaseHook = (state, ctx) =>
  emitEvents(
    state,
    [0, 1, 2].map((n) => ({ type: "WORKFORCE_CHANGED" as const, facilityId: ids.barn, from: n, to: n + 1 })),
    { tick: ctx.tick, causedBy: null },
  ).state;

describe("event journal", () => {
  it(`keeps the most recent ${EVENT_JOURNAL_CAPACITY} events, dropping the oldest`, () => {
    const sim = fakeSimulation(day0State, (r) => r.onPhase("production", "chatty", chatty));
    sim.advance(500); // 1,500 events, no midnight in 601..1100
    const journal = sim.state.eventJournal;
    expect(journal).toHaveLength(EVENT_JOURNAL_CAPACITY);
    expect(journal.at(-1)!.id).toBe("evt-1501"); // day0's next event was evt-2
    expect(journal[0]!.id).toBe("evt-502");
    expect(sim.state.counters.nextId.Event).toBe(1_502);
  });

  it("takeEvents returns everything since the last call, oldest first, even beyond the journal's capacity", () => {
    const sim = fakeSimulation(day0State, (r) => r.onPhase("production", "chatty", chatty));
    sim.advance(400);
    sim.advance(100);
    const events = sim.takeEvents();
    expect(events).toHaveLength(1_500);
    expect(events[0]!.id).toBe("evt-2");
    expect(events.at(-1)!.id).toBe("evt-1501");
    expect(sim.takeEvents()).toEqual([]);
    sim.advance(1);
    expect(sim.takeEvents().map((e) => e.id)).toEqual(["evt-1502", "evt-1503", "evt-1504"]);
  });

  it("keeps the journal bounded when loading an oversized state", () => {
    const big = emitEvents(
      day0State,
      Array.from({ length: EVENT_JOURNAL_CAPACITY + 5 }, () => ({ type: "WORKFORCE_CHANGED" as const, facilityId: ids.barn, from: 0, to: 1 })),
      { tick: day0State.tick, causedBy: null },
    ).state;
    expect(fakeSimulation(big).state.eventJournal).toHaveLength(EVENT_JOURNAL_CAPACITY);
  });

  it("rejects journal edits that bypass emitEvents", () => {
    const sim = fakeSimulation(day0State, (r) =>
      r.onPhase("production", "forger", (state) => ({ ...state, eventJournal: [...state.eventJournal, state.eventJournal[0]!] })),
    );
    expect(() => sim.advance(1)).toThrow(EventEmissionError);
  });
});
