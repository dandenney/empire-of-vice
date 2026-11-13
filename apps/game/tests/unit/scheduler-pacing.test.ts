// Per-scenario pacing and the (inert) rest fast-forward in the speed scheduler
// (ADR 0023 decision 9, P1 #193).

import { FIRST_SHIPMENT_SCENARIO, REAL_MS_PER_GAME_HOUR_AT_1X, REST_SPEED_MULTIPLIER } from "@eov/game-data";
import { describe, expect, it } from "vitest";
import { DEFAULT_REAL_MS_PER_GAME_HOUR_AT_1X, SpeedScheduler } from "../../src/workers/scheduler.ts";

class FakeClock {
  ms = 0;
  now = (): number => this.ms;
}

/** Steps the scheduler every 50 ms for `durationMs`, returning the ticks it handed out. */
function run(clock: FakeClock, scheduler: SpeedScheduler, durationMs: number): number {
  let ticks = 0;
  const end = clock.ms + durationMs;
  while (clock.ms < end) {
    clock.ms = Math.min(clock.ms + 50, end);
    ticks += scheduler.step();
  }
  return ticks;
}

describe("per-scenario pacing", () => {
  it("defaults to the M001 scenario's 5 000 ms per game hour: 12 ticks per real second at 1×", () => {
    expect(DEFAULT_REAL_MS_PER_GAME_HOUR_AT_1X).toBe(FIRST_SHIPMENT_SCENARIO.realMsPerGameHourAt1x);
    expect(DEFAULT_REAL_MS_PER_GAME_HOUR_AT_1X).toBe(REAL_MS_PER_GAME_HOUR_AT_1X);
    const clock = new FakeClock();
    const scheduler = new SpeedScheduler(clock);
    expect(scheduler.realMsPerGameHourAt1x).toBe(5_000);
    scheduler.setSpeed(1);
    expect(run(clock, scheduler, 10_000)).toBe(120);
  });

  it("runs M002's 20 000 ms per game hour at 3 ticks per real second at 1×, 12 at 4×", () => {
    const clock = new FakeClock();
    const scheduler = new SpeedScheduler(clock, 20_000);
    scheduler.setSpeed(1);
    expect(run(clock, scheduler, 10_000)).toBe(30);
    scheduler.setSpeed(4);
    expect(run(clock, scheduler, 10_000)).toBe(120);
  });

  it("takes a new game's pacing on reset, and keeps it when none is given", () => {
    const clock = new FakeClock();
    const scheduler = new SpeedScheduler(clock);
    scheduler.reset(20_000);
    expect(scheduler.realMsPerGameHourAt1x).toBe(20_000);
    scheduler.reset();
    expect(scheduler.realMsPerGameHourAt1x).toBe(20_000);
    scheduler.setSpeed(2);
    expect(run(clock, scheduler, 5_000)).toBe(30);
  });
});

describe("rest fast-forward (inert until SK1a)", () => {
  it("is off by default, so pacing is exactly the player's speed", () => {
    const clock = new FakeClock();
    const scheduler = new SpeedScheduler(clock);
    scheduler.setSpeed(2);
    expect(scheduler.fastForward).toBe(false);
    expect(scheduler.status).toEqual({ speed: 2, autoPaused: false });
  });

  it("when on, runs at REST_SPEED_MULTIPLIER × 1× whatever the player's speed, without changing it", () => {
    const clock = new FakeClock();
    const scheduler = new SpeedScheduler(clock, 20_000);
    scheduler.setSpeed(4);
    scheduler.setRestFastForward(true);
    expect(scheduler.fastForward).toBe(true);
    expect(scheduler.speed).toBe(4);
    // 8 game hours of sleep in 10 real seconds at 16× and 20 s per game hour.
    expect(REST_SPEED_MULTIPLIER).toBe(16);
    expect(run(clock, scheduler, 10_000)).toBe(480);
    scheduler.setRestFastForward(false);
    expect(run(clock, scheduler, 10_000)).toBe(120);
  });

  it("still pauses, and a reset turns it off", () => {
    const clock = new FakeClock();
    const scheduler = new SpeedScheduler(clock);
    scheduler.setRestFastForward(true);
    expect(scheduler.fastForward).toBe(false);
    expect(run(clock, scheduler, 10_000)).toBe(0);
    scheduler.setSpeed(1);
    expect(scheduler.fastForward).toBe(true);
    scheduler.reset();
    expect(scheduler.fastForward).toBe(false);
  });
});
