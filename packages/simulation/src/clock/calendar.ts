// Tick ↔ calendar conversion (SIM-001, ADR 0003). One tick is one game minute,
// tick 0 is 00:00 on the scenario start date, and the calendar is proleptic
// Gregorian with leap years. Integer math only (Math.floor on exact integer
// quotients), never the platform Date object, so the result can't depend on the
// host's time zone or engine.

import {
  dayIndex,
  minuteOfDay,
  TICKS_PER_HOUR,
  type ClockSnapshot,
  type GameDate,
  type Tick,
} from "@eov/contracts";

/** A calendar day: the date part of GameDate. The scenario start date has this shape. */
export type CalendarDay = Pick<GameDate, "year" | "month" | "day">;

export class InvalidDateError extends RangeError {
  override readonly name = "InvalidDateError";
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

export function daysInMonth(year: number, month: number): number {
  if (!Number.isSafeInteger(month) || month < 1 || month > 12) throw new InvalidDateError(`Invalid month ${month}`);
  return month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1]!;
}

export function assertValidCalendarDay(date: CalendarDay): void {
  const { year, month, day } = date;
  if (!Number.isSafeInteger(year)) throw new InvalidDateError(`Invalid year ${year}`);
  if (!Number.isSafeInteger(day) || day < 1 || day > daysInMonth(year, month)) {
    throw new InvalidDateError(`Invalid date ${year}-${month}-${day}`);
  }
}

/** Days since 1970-01-01 (negative before). Howard Hinnant's days_from_civil. */
export function daysFromCivil(date: CalendarDay): number {
  const { month, day } = date;
  const y = month <= 2 ? date.year - 1 : date.year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const shiftedMonth = month > 2 ? month - 3 : month + 9; // March = 0
  const dayOfYear = Math.floor((153 * shiftedMonth + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

/** Inverse of daysFromCivil. Howard Hinnant's civil_from_days. */
export function civilFromDays(days: number): CalendarDay {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const dayOfEra = z - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1_460) + Math.floor(dayOfEra / 36_524) - Math.floor(dayOfEra / 146_096)) / 365,
  );
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const shiftedMonth = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * shiftedMonth + 2) / 5) + 1;
  const month = shiftedMonth < 10 ? shiftedMonth + 3 : shiftedMonth - 9;
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);
  return { year, month, day };
}

/** Adds whole days to a calendar day. */
export function addDays(date: CalendarDay, days: number): CalendarDay {
  return civilFromDays(daysFromCivil(date) + days);
}

/** The calendar date and time of day at the start of `t`, given the scenario start date. */
export function dateOfTick(startDate: CalendarDay, t: Tick): GameDate {
  const { year, month, day } = addDays(startDate, dayIndex(t));
  const minute = minuteOfDay(t);
  return { year, month, day, hour: Math.floor(minute / TICKS_PER_HOUR), minute: minute % TICKS_PER_HOUR };
}

export function clockAt(startDate: CalendarDay, t: Tick): ClockSnapshot {
  return { tick: t, dayIndex: dayIndex(t), date: dateOfTick(startDate, t) };
}
