import { tick, TICKS_PER_DAY } from "@eov/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  addDays,
  assertValidCalendarDay,
  civilFromDays,
  clockAt,
  dateOfTick,
  daysFromCivil,
  daysInMonth,
  isLeapYear,
  type CalendarDay,
} from "../../src/index.ts";
import { START_DATE } from "./fakes.ts";

const atDay = (day: number, minute = 0) => tick(day * TICKS_PER_DAY + minute);

/** Naive reference: step one day at a time. */
function stepDays(start: CalendarDay, days: number): CalendarDay {
  let { year, month, day } = start;
  for (let i = 0; i < days; i++) {
    day++;
    if (day > daysInMonth(year, month)) {
      day = 1;
      month++;
      if (month > 12) {
        month = 1;
        year++;
      }
    }
  }
  return { year, month, day };
}

describe("Gregorian calendar", () => {
  it("knows the leap-year rule", () => {
    expect(isLeapYear(1920)).toBe(true);
    expect(isLeapYear(1921)).toBe(false);
    expect(isLeapYear(1900)).toBe(false);
    expect(isLeapYear(2000)).toBe(true);
    expect(daysInMonth(1920, 2)).toBe(29);
    expect(daysInMonth(1921, 2)).toBe(28);
  });

  it("starts the scenario at 00:00 on January 17, 1920", () => {
    expect(dateOfTick(START_DATE, tick(0))).toEqual({ year: 1920, month: 1, day: 17, hour: 0, minute: 0 });
  });

  it("1,440 ticks advance exactly one game day", () => {
    expect(dateOfTick(START_DATE, tick(1_439))).toEqual({ year: 1920, month: 1, day: 17, hour: 23, minute: 59 });
    expect(dateOfTick(START_DATE, tick(1_440))).toEqual({ year: 1920, month: 1, day: 18, hour: 0, minute: 0 });
    expect(dateOfTick(START_DATE, tick(600))).toEqual({ year: 1920, month: 1, day: 17, hour: 10, minute: 0 });
  });

  it("has February 29, 1920 (day 43), then March 1", () => {
    expect(dateOfTick(START_DATE, atDay(42))).toMatchObject({ year: 1920, month: 2, day: 28 });
    expect(dateOfTick(START_DATE, atDay(43))).toMatchObject({ year: 1920, month: 2, day: 29 });
    expect(dateOfTick(START_DATE, atDay(43, 1_439))).toEqual({ year: 1920, month: 2, day: 29, hour: 23, minute: 59 });
    expect(dateOfTick(START_DATE, atDay(44))).toMatchObject({ year: 1920, month: 3, day: 1 });
  });

  it("rolls into 1921 after 350 days (1920 has 366) and skips February 29, 1921", () => {
    expect(dateOfTick(START_DATE, atDay(349))).toMatchObject({ year: 1920, month: 12, day: 31 });
    expect(dateOfTick(START_DATE, atDay(350))).toMatchObject({ year: 1921, month: 1, day: 1 });
    expect(addDays({ year: 1921, month: 2, day: 28 }, 1)).toEqual({ year: 1921, month: 3, day: 1 });
  });

  it("clockAt carries tick, day index, and date", () => {
    expect(clockAt(START_DATE, atDay(43, 61))).toEqual({
      tick: atDay(43, 61),
      dayIndex: 43,
      date: { year: 1920, month: 2, day: 29, hour: 1, minute: 1 },
    });
  });

  it("agrees with day-by-day stepping", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 40_000 }), (days) => {
        expect(addDays(START_DATE, days)).toEqual(stepDays(START_DATE, days));
      }),
      { seed: 1920, numRuns: 200 },
    );
  });

  it("daysFromCivil and civilFromDays are inverses, including before 1970 and year 0", () => {
    expect(daysFromCivil({ year: 1970, month: 1, day: 1 })).toBe(0);
    expect(daysFromCivil({ year: 1920, month: 1, day: 17 })).toBe(-18_247);
    fc.assert(
      fc.property(fc.integer({ min: -1_000_000, max: 1_000_000 }), (days) => {
        const date = civilFromDays(days);
        assertValidCalendarDay(date);
        expect(daysFromCivil(date)).toBe(days);
      }),
      { seed: 1920 },
    );
  });

  it("rejects invalid start dates", () => {
    expect(() => assertValidCalendarDay({ year: 1921, month: 2, day: 29 })).toThrow(RangeError);
    expect(() => assertValidCalendarDay({ year: 1920, month: 13, day: 1 })).toThrow(RangeError);
  });
});
