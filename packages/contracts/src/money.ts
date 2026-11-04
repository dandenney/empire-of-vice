// Money and fixed-point ratios. See docs/decisions/0002-money-rounding-and-fixed-point.md.
//
// Money is always an integer number of cents, branded so a plain `number`
// (a quantity, a tick, a float) can't be passed where cents are expected.
// Every operation is checked: a result outside the safe-integer range throws
// MoneyRangeError instead of silently losing precision.
//
// Multipliers (market modifiers, contract discounts, penalty rates) are
// fixed-point `Ratio`s in parts per million. Applying them to money uses
// exact BigInt arithmetic and rounds once, at the end, with roundHalfUpToCent.
// No floating-point math touches money anywhere in this module.

declare const moneyBrand: unique symbol;
declare const ratioBrand: unique symbol;

/** Signed integer cents. Negative values are allowed (deltas, net worth, liabilities). */
export type Money = number & { readonly [moneyBrand]: true };

/** Fixed-point multiplier in parts per million: 1_000_000 = 1.0×. */
export type Ratio = number & { readonly [ratioBrand]: true };

/** Thrown when a value isn't a safe integer or an operation leaves the safe-integer range. */
export class MoneyRangeError extends RangeError {
  override readonly name = "MoneyRangeError";
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/** Brands an integer as cents. Throws on fractions, NaN, Infinity, or unsafe integers. */
export function cents(value: number): Money {
  if (!Number.isSafeInteger(value)) {
    throw new MoneyRangeError(`Not a safe integer number of cents: ${value}`);
  }
  // Normalize -0 so it never leaks into saves or hashes.
  return (value === 0 ? 0 : value) as Money;
}

export function isMoney(value: unknown): value is Money {
  return typeof value === "number" && Number.isSafeInteger(value);
}

export const ZERO_MONEY: Money = cents(0);

export function addMoney(a: Money, b: Money): Money {
  return cents(a + b);
}

export function subtractMoney(a: Money, b: Money): Money {
  return cents(a - b);
}

export function negateMoney(a: Money): Money {
  return cents(-a);
}

/**
 * Multiplies money by a whole number, e.g. a per-case price by a case count.
 * Exact: if the true product exceeds the safe range, the float result does too, and `cents` throws.
 */
export function multiplyMoney(a: Money, factor: number): Money {
  if (!Number.isSafeInteger(factor)) {
    throw new MoneyRangeError(`Money can only be multiplied by a safe integer, got ${factor}`);
  }
  return cents(a * factor);
}

/** Sums a list of amounts, checking every partial sum. */
export function sumMoney(amounts: readonly Money[]): Money {
  let total = ZERO_MONEY;
  for (const amount of amounts) total = addMoney(total, amount);
  return total;
}

/** Returns -1, 0, or 1. Suitable for Array.prototype.sort. */
export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Rounding
// ---------------------------------------------------------------------------

/**
 * Rounds the exact rational number of cents `numerator / denominator` to whole cents.
 * Ties round away from zero: 0.5 → 1, -0.5 → -1. That's "half up" for the positive
 * amounts the GDD prices with, and stays symmetric so negating never changes a magnitude.
 */
export function roundHalfUpToCent(numerator: bigint, denominator: bigint): Money {
  return cents(toSafeNumber(divideRoundHalfAwayFromZero(numerator, denominator)));
}

/**
 * Divides money by a whole number, rounding to the nearest cent (ties away from zero).
 * For display values like average unit cost. Allocating cost across removals is T02a's
 * job, because it has to hand the rounding residue to the final removal.
 */
export function divideMoney(a: Money, divisor: number): Money {
  if (!Number.isSafeInteger(divisor) || divisor === 0) {
    throw new MoneyRangeError(`Money can only be divided by a non-zero safe integer, got ${divisor}`);
  }
  return roundHalfUpToCent(BigInt(a), BigInt(divisor));
}

// ---------------------------------------------------------------------------
// Ratios
// ---------------------------------------------------------------------------

export const RATIO_SCALE = 1_000_000;
const RATIO_SCALE_BIG = BigInt(RATIO_SCALE);

/** Brands an integer number of parts per million as a Ratio, e.g. `ratio(1_250_000)` = 1.25×. */
export function ratio(partsPerMillion: number): Ratio {
  if (!Number.isSafeInteger(partsPerMillion)) {
    throw new MoneyRangeError(`Not a safe integer ratio: ${partsPerMillion}`);
  }
  return (partsPerMillion === 0 ? 0 : partsPerMillion) as Ratio;
}

export const RATIO_ONE: Ratio = ratio(RATIO_SCALE);

/**
 * The ratio `numerator / denominator` of two integers (e.g. demand D / D₀), rounded to
 * the nearest part per million (ties away from zero). Throws if the denominator is 0;
 * callers validate configuration (GDD §7 requires D₀ > 0 and S₀ > 0) before getting here.
 */
export function ratioOf(numerator: number, denominator: number): Ratio {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator === 0) {
    throw new MoneyRangeError(`Invalid ratio ${numerator}/${denominator}`);
  }
  const scaled = BigInt(numerator) * RATIO_SCALE_BIG;
  return ratio(toSafeNumber(divideRoundHalfAwayFromZero(scaled, BigInt(denominator))));
}

export function clampRatio(value: Ratio, min: Ratio, max: Ratio): Ratio {
  if (min > max) throw new MoneyRangeError(`clampRatio: min ${min} > max ${max}`);
  return value < min ? min : value > max ? max : value;
}

/**
 * Applies multipliers to money with a single rounding at the end:
 * `roundHalfUpToCent(amount × r₁ × r₂ × …)`. This is the GDD §7 spot price formula
 * `P_base × M_D × M_S × M_E`. Intermediates are exact BigInts, so no precision is lost.
 */
export function applyRatios(amount: Money, ratios: readonly Ratio[]): Money {
  let numerator = BigInt(amount);
  let denominator = BigInt(1);
  for (const r of ratios) {
    numerator *= BigInt(r);
    denominator *= RATIO_SCALE_BIG;
  }
  return roundHalfUpToCent(numerator, denominator);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Formats cents as US dollars: `$1,234.56`, `-$0.05`. Locale-independent on purpose
 * (no Intl), so output is identical in every engine and in snapshot tests.
 */
export function formatMoney(amount: Money): string {
  const negative = amount < 0;
  const abs = negative ? -amount : amount;
  const dollars = Math.trunc(abs / 100);
  const rest = abs - dollars * 100;
  const grouped = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}$${grouped}.${String(rest).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function divideRoundHalfAwayFromZero(numerator: bigint, denominator: bigint): bigint {
  if (denominator === BigInt(0)) throw new MoneyRangeError("Division by zero");
  // Normalize so the denominator is positive; the sign lives in the numerator.
  if (denominator < BigInt(0)) {
    numerator = -numerator;
    denominator = -denominator;
  }
  const quotient = numerator / denominator; // BigInt division truncates toward zero.
  const remainder = numerator % denominator; // Same sign as the numerator.
  const absRemainder = remainder < BigInt(0) ? -remainder : remainder;
  if (absRemainder * BigInt(2) >= denominator) {
    return numerator < BigInt(0) ? quotient - BigInt(1) : quotient + BigInt(1);
  }
  return quotient;
}

function toSafeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new MoneyRangeError(`Result out of safe-integer range: ${value}`);
  }
  return Number(value);
}
