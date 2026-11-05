// The speed scheduler with a fake clock (issue #11, ADR 0014, SIM-001 acceptance).

import { TICKS_PER_DAY } from "@eov/contracts";
import { REAL_MS_PER_GAME_HOUR_AT_1X } from "@eov/game-data";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MAX_TICKS_PER_STEP, SpeedScheduler, type Speed } from "../../src/workers/scheduler.ts";

class FakeClock {
  ms = 0;
  now = (): number => this.ms;
}

/** Steps the scheduler every `stepMs` for `durationMs`, returning the ticks it handed out. */
function run(clock: FakeClock, scheduler: SpeedScheduler, durationMs: number, stepMs = 50): number {
  let ticks = 0;
  const end = clock.ms + durationMs;
  while (clock.ms < end) {
    clock.ms = Math.min(clock.ms + stepMs, end);
    ticks += scheduler.step();
  }
  return ticks;
}

/** Steps until nothing is owed, without moving the clock. */
function drain(scheduler: SpeedScheduler): number {
  let ticks = 0;
  for (let n = scheduler.step(); n > 0; n = scheduler.step()) ticks += n;
  return ticks;
}

function setup(): { clock: FakeClock; scheduler: SpeedScheduler } {
  const clock = new FakeClock();
  return { clock, scheduler: new SpeedScheduler(clock) };
}

describe("SpeedScheduler", () => {
  it("starts paused and hands out nothing", () => {
    const { clock, scheduler } = setup();
    expect(scheduler.status).toEqual({ speed: 0, autoPaused: false });
    expect(run(clock, scheduler, 10_000)).toBe(0);
  });

  it("advances exactly 12 ticks per real second at 1×", () => {
    const { clock, scheduler } = setup();
    scheduler.setSpeed(1);
    for (let second = 1; second <= 30; second++) {
      expect(run(clock, scheduler, 1_000)).toBe(12);
    }
  });

  it("advances 24 and 48 ticks per second at 2× and 4×", () => {
    const { clock, scheduler } = setup();
    scheduler.setSpeed(2);
    expect(run(clock, scheduler, 10_000)).toBe(240);
    scheduler.setSpeed(4);
    expect(run(clock, scheduler, 10_000)).toBe(480);
  });

  it("runs one game hour per 5 s / 2.5 s / 1.25 s, and a game day per 2 real minutes at 1×", () => {
    for (const [speed, ms] of [
      [1, 5_000],
      [2, 2_500],
      [4, 1_250],
    ] as const) {
      const { clock, scheduler } = setup();
      scheduler.setSpeed(speed);
      expect(run(clock, scheduler, ms)).toBe(60);
    }
    const { clock, scheduler } = setup();
    scheduler.setSpeed(1);
    expect(run(clock, scheduler, 120_000)).toBe(TICKS_PER_DAY);
  });

  it("has no float drift with fractional clock readings (performance.now())", () => {
    const { clock, scheduler } = setup();
    scheduler.setSpeed(1);
    // 16.6667 ms frames for an hour of real time.
    expect(run(clock, scheduler, 3_600_000, 1_000 / 60)).toBe(12 * 3_600);
  });

  it("advances 0 ticks while paused for 60 real seconds", () => {
    const { clock, scheduler } = setup();
    scheduler.setSpeed(1);
    run(clock, scheduler, 1_000);
    scheduler.setSpeed(0);
    expect(run(clock, scheduler, 60_000)).toBe(0);
    expect(scheduler.backlog).toBe(0);
  });

  it("keeps the sub-tick remainder across a pause, so pausing loses nothing", () => {
    const { clock, scheduler } = setup();
    scheduler.setSpeed(1);
    // 12 × 50 ms = 600 ms → 7.2 ticks: 7 out, 0.2 carried.
    expect(run(clock, scheduler, 600)).toBe(7);
    scheduler.setSpeed(0);
    run(clock, scheduler, 60_000);
    scheduler.setSpeed(1);
    // 400 ms more → 4.8 + 0.2 = 5.
    expect(run(clock, scheduler, 400)).toBe(5);
  });

  it("auto-pauses when the tab is hidden and doesn't catch up the hidden time", () => {
    const { clock, scheduler } = setup();
    scheduler.setSpeed(4);
    expect(run(clock, scheduler, 1_000)).toBe(48);
    scheduler.setVisible(false);
    expect(scheduler.status).toEqual({ speed: 0, autoPaused: true });
    expect(run(clock, scheduler, 600_000)).toBe(0);
    scheduler.setVisible(true);
    // Stays paused when visible again (ADR 0014 decision 4).
    expect(scheduler.status).toEqual({ speed: 0, autoPaused: true });
    expect(run(clock, scheduler, 10_000)).toBe(0);
    // The player resumes: only time from now on counts.
    expect(scheduler.setSpeed(1)).toBe(true);
    expect(scheduler.status).toEqual({ speed: 1, autoPaused: false });
    expect(run(clock, scheduler, 1_000)).toBe(12);
  });

  it("resets the sub-tick remainder when hidden", () => {
    const { clock, scheduler } = setup();
    scheduler.setSpeed(1);
    expect(run(clock, scheduler, 450)).toBe(5); // 5.4 ticks
    scheduler.setVisible(false);
    scheduler.setVisible(true);
    scheduler.setSpeed(1);
    // Without the reset, 0.4 + 0.6 would make one more tick.
    expect(run(clock, scheduler, 50)).toBe(0);
  });

  it("refuses a running speed while hidden", () => {
    const { clock, scheduler } = setup();
    scheduler.setVisible(false);
    expect(scheduler.setSpeed(2)).toBe(false);
    expect(scheduler.speed).toBe(0);
    expect(run(clock, scheduler, 10_000)).toBe(0);
    expect(scheduler.setSpeed(0)).toBe(true);
  });

  it("doesn't mark a manual pause as auto-paused when the tab hides", () => {
    const { scheduler } = setup();
    scheduler.setVisible(false);
    expect(scheduler.status).toEqual({ speed: 0, autoPaused: false });
  });

  it("processes a backlog in batches of at most 60 ticks and never drops it", () => {
    const { clock, scheduler } = setup();
    scheduler.setSpeed(4);
    // A 10 s stall (e.g. a long GC): 480 ticks owed at once.
    clock.ms += 10_000;
    const batches: number[] = [];
    for (let n = scheduler.step(); n > 0; n = scheduler.step()) batches.push(n);
    expect(Math.max(...batches)).toBe(MAX_TICKS_PER_STEP);
    expect(batches.reduce((a, b) => a + b, 0)).toBe(480);
    expect(batches).toHaveLength(8);
  });

  it("keeps the backlog through a pause and runs it on resume", () => {
    const { clock, scheduler } = setup();
    scheduler.setSpeed(4);
    clock.ms += 5_000; // 240 owed
    expect(scheduler.step()).toBe(60);
    scheduler.setSpeed(0);
    expect(scheduler.step()).toBe(0);
    expect(scheduler.backlog).toBe(180);
    scheduler.setSpeed(1);
    expect(drain(scheduler)).toBe(180);
  });

  it("reset() pauses and clears what's owed", () => {
    const { clock, scheduler } = setup();
    scheduler.setSpeed(4);
    clock.ms += 5_000;
    scheduler.reset();
    expect(scheduler.status).toEqual({ speed: 0, autoPaused: false });
    expect(scheduler.backlog).toBe(0);
    scheduler.setSpeed(1);
    expect(drain(scheduler)).toBe(0);
  });

  it("rejects anything that isn't a speed", () => {
    const { scheduler } = setup();
    expect(() => scheduler.setSpeed(3 as Speed)).toThrow(RangeError);
    expect(() => scheduler.setSpeed(0.5 as Speed)).toThrow(RangeError);
  });

  it("loses and duplicates no ticks across any sequence of speed changes", () => {
    const segment = fc.record({
      speed: fc.constantFrom<Speed>(0, 1, 2, 4),
      durationMs: fc.integer({ min: 0, max: 7_000 }),
      stepMs: fc.integer({ min: 1, max: 300 }),
    });
    fc.assert(
      fc.property(fc.array(segment, { maxLength: 40 }), (segments) => {
        const { clock, scheduler } = setup();
        let handedOut = 0;
        // Exact expectation: total tick units over the whole run, divided once at the end.
        let units = 0;
        for (const s of segments) {
          scheduler.setSpeed(s.speed);
          handedOut += run(clock, scheduler, s.durationMs, s.stepMs);
          units += s.durationMs * s.speed * 60;
        }
        scheduler.setSpeed(1);
        handedOut += drain(scheduler);
        expect(handedOut).toBe(Math.floor(units / REAL_MS_PER_GAME_HOUR_AT_1X));
      }),
    );
  });
});
