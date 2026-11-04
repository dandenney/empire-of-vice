// Simulation time. See docs/decisions/0003-identifiers-time-and-coordinates.md and GDD §5 (SIM-001).
//
// Time is an integer tick count: one tick is one game minute, counted from the
// scenario's start (tick 0 = scenario start date at 00:00). `state.tick` is the
// number of ticks completed. `advance(1)` processes tick `state.tick + 1`.
// Converting a tick to a calendar date (Gregorian, leap years) needs the
// scenario start date and is the simulation's job (T01).

declare const tickBrand: unique symbol;

export type Tick = number & { readonly [tickBrand]: true };

// Calendar structure from SIM-001. These are rules of the clock, not tuning values,
// so they live here rather than in game-data.
export const TICKS_PER_HOUR = 60;
export const TICKS_PER_DAY = 1_440;

export class InvalidTickError extends RangeError {
  override readonly name = "InvalidTickError";
}

/** Brands a non-negative safe integer as a Tick. */
export function tick(value: number): Tick {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidTickError(`Not a valid tick: ${value}`);
  }
  return (value === 0 ? 0 : value) as Tick;
}

export function addTicks(t: Tick, ticks: number): Tick {
  if (!Number.isSafeInteger(ticks)) throw new InvalidTickError(`Not a whole number of ticks: ${ticks}`);
  return tick(t + ticks);
}

/** Zero-based game day containing this tick (day 0 = the scenario start date). */
export function dayIndex(t: Tick): number {
  return Math.floor(t / TICKS_PER_DAY);
}

/** Minute of the day, 0–1439. */
export function minuteOfDay(t: Tick): number {
  return t % TICKS_PER_DAY;
}

/** True on the first tick of a game day, when midnight settlement runs (SIM-001 step 5). */
export function isMidnight(t: Tick): boolean {
  return t % TICKS_PER_DAY === 0;
}
