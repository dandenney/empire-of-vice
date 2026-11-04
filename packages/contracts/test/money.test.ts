import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  addMoney,
  applyRatios,
  cents,
  clampRatio,
  compareMoney,
  divideMoney,
  formatMoney,
  multiplyMoney,
  MoneyRangeError,
  negateMoney,
  ratio,
  ratioOf,
  RATIO_ONE,
  roundHalfUpToCent,
  subtractMoney,
  sumMoney,
  ZERO_MONEY,
} from "../src/money.ts";

const MAX = Number.MAX_SAFE_INTEGER;
const safeCents = fc.integer({ min: -1_000_000_000_000, max: 1_000_000_000_000 }).map(cents);

describe("cents", () => {
  it("accepts safe integers and normalizes -0", () => {
    expect(cents(123)).toBe(123);
    expect(Object.is(cents(-0), 0)).toBe(true);
  });

  it.each([0.5, Number.NaN, Infinity, -Infinity, MAX + 1])("rejects %s", (bad) => {
    expect(() => cents(bad)).toThrow(MoneyRangeError);
  });
});

describe("checked arithmetic", () => {
  it("adds, subtracts, negates, multiplies, sums", () => {
    expect(addMoney(cents(150), cents(-50))).toBe(100);
    expect(subtractMoney(cents(100), cents(250))).toBe(-150);
    expect(negateMoney(cents(5))).toBe(-5);
    expect(multiplyMoney(cents(1_200), 10)).toBe(12_000);
    expect(sumMoney([cents(8_000), cents(3_000), cents(1_000)])).toBe(12_000);
    expect(sumMoney([])).toBe(ZERO_MONEY);
  });

  it("throws instead of losing precision", () => {
    expect(() => addMoney(cents(MAX), cents(1))).toThrow(MoneyRangeError);
    expect(() => subtractMoney(cents(-MAX), cents(1))).toThrow(MoneyRangeError);
    expect(() => multiplyMoney(cents(MAX), 2)).toThrow(MoneyRangeError);
    expect(() => multiplyMoney(cents(100), 1.5)).toThrow(MoneyRangeError);
    expect(() => sumMoney([cents(MAX), cents(1)])).toThrow(MoneyRangeError);
  });

  it("addition is commutative and subtraction inverts it", () => {
    fc.assert(
      fc.property(safeCents, safeCents, (a, b) => {
        expect(addMoney(a, b)).toBe(addMoney(b, a));
        expect(subtractMoney(addMoney(a, b), b)).toBe(a);
      }),
    );
  });

  it("orders amounts", () => {
    expect([cents(3), cents(-1), cents(2)].sort(compareMoney)).toEqual([-1, 2, 3]);
  });
});

describe("roundHalfUpToCent", () => {
  it.each([
    [5n, 2n, 3], // 2.5 → 3
    [-5n, 2n, -3], // -2.5 → -3 (away from zero)
    [7n, 3n, 2], // 2.333 → 2
    [8n, 3n, 3], // 2.667 → 3
    [-7n, 3n, -2],
    [5n, -2n, -3], // negative denominator
    [0n, 7n, 0],
  ])("%s / %s → %s", (n, d, expected) => {
    expect(roundHalfUpToCent(n, d)).toBe(expected);
  });

  it("is symmetric under negation", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n }), fc.bigInt({ min: 1n, max: 10n ** 6n }), (n, d) => {
        expect(roundHalfUpToCent(-n, d)).toBe(-roundHalfUpToCent(n, d) || 0);
      }),
    );
  });

  it("rejects division by zero and out-of-range results", () => {
    expect(() => roundHalfUpToCent(1n, 0n)).toThrow(MoneyRangeError);
    expect(() => roundHalfUpToCent(BigInt(MAX) + 1n, 1n)).toThrow(MoneyRangeError);
  });

  it("divideMoney rounds to the nearest cent", () => {
    expect(divideMoney(cents(52_000), 50)).toBe(1_040); // FIN-001: $520 / 50 cases = $10.40
    expect(divideMoney(cents(100), 3)).toBe(33);
    expect(() => divideMoney(cents(100), 0)).toThrow(MoneyRangeError);
  });
});

describe("ratios", () => {
  it("builds ratios from fractions, rounding to parts per million", () => {
    expect(ratioOf(11, 10)).toBe(1_100_000);
    expect(ratioOf(1, 3)).toBe(333_333);
    expect(ratioOf(2, 3)).toBe(666_667);
    expect(() => ratioOf(1, 0)).toThrow(MoneyRangeError);
  });

  it("clamps", () => {
    const lo = ratio(800_000);
    const hi = ratio(1_250_000);
    expect(clampRatio(ratio(1_400_000), lo, hi)).toBe(hi);
    expect(clampRatio(ratio(500_000), lo, hi)).toBe(lo);
    expect(clampRatio(RATIO_ONE, lo, hi)).toBe(RATIO_ONE);
  });

  it("reproduces the GDD §7 spot price example: $20 × 1.10 × 1.25 = $27.50", () => {
    const base = cents(2_000);
    const mD = clampRatio(ratioOf(110, 100), ratio(800_000), ratio(1_250_000));
    // Supply 20% below baseline: S₀ / S = 100 / 80 = 1.25, at the clamp limit.
    const mS = clampRatio(ratioOf(100, 80), ratio(800_000), ratio(1_250_000));
    expect(applyRatios(base, [mD, mS, RATIO_ONE])).toBe(2_750);
  });

  it("rounds once at the end, not per multiplier", () => {
    // 1¢ × 1.5 × 1.5 = 2.25¢ → 2¢. Rounding after each step would give 1.5→2, 2×1.5=3.
    expect(applyRatios(cents(1), [ratio(1_500_000), ratio(1_500_000)])).toBe(2);
  });

  it("applies a contract discount: 95% of $27.50 = $26.13 (half up from 26.125)", () => {
    expect(applyRatios(cents(2_750), [ratio(950_000)])).toBe(2_613);
  });

  it("with no ratios, returns the amount unchanged", () => {
    fc.assert(
      fc.property(safeCents, (a) => {
        expect(applyRatios(a, [])).toBe(a);
      }),
    );
  });
});

describe("formatMoney", () => {
  it.each([
    [0, "$0.00"],
    [5, "$0.05"],
    [-5, "-$0.05"],
    [2_750, "$27.50"],
    [123_456_789, "$1,234,567.89"],
    [-100_000, "-$1,000.00"],
  ])("%s → %s", (value, expected) => {
    expect(formatMoney(cents(value))).toBe(expected);
  });
});
