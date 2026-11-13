import { TICKS_PER_DAY, TICKS_PER_HOUR } from "@eov/contracts";
import { describe, expect, it } from "vitest";
import { FIRST_SHIPMENT_SCENARIO, parseScenario, REAL_MS_PER_GAME_HOUR_AT_1X, ScenarioError, SPEED_MULTIPLIERS } from "../src/index.ts";
import firstShipmentJson from "../src/scenarios/first-shipment.json" with { type: "json" };

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

describe("per-scenario pacing (ADR 0023 decision 9)", () => {
  it("keeps the M001 scenario at the default 5 000 ms per game hour, with founder rules off", () => {
    expect(FIRST_SHIPMENT_SCENARIO.realMsPerGameHourAt1x).toBe(REAL_MS_PER_GAME_HOUR_AT_1X);
    expect(FIRST_SHIPMENT_SCENARIO.realMsPerGameHourAt1x).toBe(5_000);
    expect(FIRST_SHIPMENT_SCENARIO.founderRules).toBe(false);
    expect(FIRST_SHIPMENT_SCENARIO.founderStartLocationId).toBe("hollow-creek");
  });

  it("reads M002's hypothesis from a scenario file: 20 000 ms is 3 ticks per real second and 8 real minutes per day", () => {
    const m002 = parseScenario({ ...firstShipmentJson, realMsPerGameHourAt1x: 20_000, founderRules: true });
    expect(m002.realMsPerGameHourAt1x).toBe(20_000);
    expect(m002.founderRules).toBe(true);
    expect((TICKS_PER_HOUR * 1_000) / m002.realMsPerGameHourAt1x).toBe(3);
    expect((TICKS_PER_DAY / TICKS_PER_HOUR) * m002.realMsPerGameHourAt1x).toBe(8 * 60_000);
  });

  it.each([
    ["missing pacing", { realMsPerGameHourAt1x: undefined }],
    ["zero pacing", { realMsPerGameHourAt1x: 0 }],
    ["fractional pacing", { realMsPerGameHourAt1x: 5_000.5 }],
    ["missing founderRules", { founderRules: undefined }],
    ["founderRules as a string", { founderRules: "false" }],
    ["missing founderStartLocationId", { founderStartLocationId: undefined }],
  ])("rejects a scenario with %s", (_label, patch) => {
    expect(() => parseScenario({ ...firstShipmentJson, ...patch })).toThrow(ScenarioError);
  });

  it("rejects a malformed start location ID", () => {
    expect(() => parseScenario({ ...firstShipmentJson, founderStartLocationId: "Hollow Creek" })).toThrow(TypeError);
  });
});
