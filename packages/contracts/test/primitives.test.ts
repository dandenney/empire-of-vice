import { describe, expect, expectTypeOf, it } from "vitest";
import {
  addTicks,
  asId,
  dayIndex,
  InvalidIdError,
  InvalidTickError,
  isMidnight,
  isWorldPoint,
  minuteOfDay,
  qualityRank,
  tick,
  TICKS_PER_DAY,
  type BuyerId,
  type FacilityId,
} from "../src/index.ts";

describe("ids", () => {
  it("accepts kebab-case ids", () => {
    expect(asId("Facility", "distillery-main")).toBe("distillery-main");
    expect(asId("ProductionJob", "job-17")).toBe("job-17");
  });

  it.each(["", "Distillery", "has space", "trailing-", "-leading", "double--hyphen", "a".repeat(65)])(
    "rejects %j",
    (bad) => {
      expect(() => asId("Buyer", bad)).toThrow(InvalidIdError);
    },
  );

  it("keeps kinds apart at compile time", () => {
    expectTypeOf(asId("Buyer", "buyer-1")).toEqualTypeOf<BuyerId>();
    expectTypeOf<BuyerId>().not.toEqualTypeOf<FacilityId>();
  });
});

describe("time", () => {
  it("has 1,440 ticks per day (SIM-001)", () => {
    expect(TICKS_PER_DAY).toBe(1_440);
    expect(dayIndex(tick(1_439))).toBe(0);
    expect(dayIndex(tick(1_440))).toBe(1);
    expect(minuteOfDay(tick(1_441))).toBe(1);
    expect(isMidnight(tick(2_880))).toBe(true);
    expect(isMidnight(tick(2_881))).toBe(false);
  });

  it("rejects negative, fractional, and unsafe ticks", () => {
    for (const bad of [-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => tick(bad)).toThrow(InvalidTickError);
    }
    expect(() => addTicks(tick(0), -1)).toThrow(InvalidTickError);
    expect(addTicks(tick(10), 5)).toBe(15);
  });
});

describe("geometry and goods", () => {
  it("validates world points as integer coordinates", () => {
    expect(isWorldPoint({ x: 3, y: -2 })).toBe(true);
    expect(isWorldPoint({ x: 1.5, y: 0 })).toBe(false);
    expect(isWorldPoint(null)).toBe(false);
  });

  it("ranks quality tiers", () => {
    expect(qualityRank("standard")).toBeGreaterThan(qualityRank("basic"));
    expect(qualityRank("premium")).toBeGreaterThan(qualityRank("standard"));
  });
});
