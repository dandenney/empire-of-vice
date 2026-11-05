import { TICKS_PER_DAY, TICKS_PER_HOUR } from "@eov/contracts";
import { describe, expect, it } from "vitest";
import { REAL_MS_PER_GAME_HOUR_AT_1X, SPEED_MULTIPLIERS } from "../src/index.ts";

describe("pacing (SIM-001)", () => {
  it("runs one game hour per 5 real seconds at 1×, 2.5 s at 2×, 1.25 s at 4×", () => {
    expect(REAL_MS_PER_GAME_HOUR_AT_1X).toBe(5_000);
    expect(SPEED_MULTIPLIERS).toEqual([1, 2, 4]);
    expect(SPEED_MULTIPLIERS.map((m) => REAL_MS_PER_GAME_HOUR_AT_1X / m)).toEqual([5_000, 2_500, 1_250]);
  });

  it("gives 12 ticks per real second at 1× and 48 at 4× (architecture §8)", () => {
    const ticksPerSecond = (m: number) => (TICKS_PER_HOUR * 1_000 * m) / REAL_MS_PER_GAME_HOUR_AT_1X;
    expect(ticksPerSecond(1)).toBe(12);
    expect(ticksPerSecond(4)).toBe(48);
  });

  it("makes a game day last 2 real minutes at 1×", () => {
    expect((TICKS_PER_DAY / TICKS_PER_HOUR) * REAL_MS_PER_GAME_HOUR_AT_1X).toBe(120_000);
  });

  it("uses whole numbers, so the scheduler's integer accumulator has no rounding", () => {
    expect(Number.isSafeInteger(REAL_MS_PER_GAME_HOUR_AT_1X)).toBe(true);
    for (const m of SPEED_MULTIPLIERS) expect(Number.isSafeInteger(m)).toBe(true);
  });
});
