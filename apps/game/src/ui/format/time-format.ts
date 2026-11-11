// Game times and spans as the UI writes them (#142). Shared by the panels, the
// route picker, and the end screen, so deadlines, closures, and the activity
// log read alike. Only formatting: the tick comes from the snapshot.

import { dayIndex, minuteOfDay, TICKS_PER_DAY, TICKS_PER_HOUR, type Tick } from "@eov/contracts";
import { TIME_FORMAT_COPY as C } from "./copy.ts";

const pad2 = (n: number) => String(n).padStart(2, "0");

/** A tick as "day 3, 18:00": the game day (as the Dashboard counts it) and the time of day. */
export function formatDayTime(t: Tick): string {
  const minute = minuteOfDay(t);
  return C.dayTime(dayIndex(t), pad2(Math.floor(minute / TICKS_PER_HOUR)), pad2(minute % TICKS_PER_HOUR));
}

/** A span of ticks as "2 days", "1 day 6 h", "45 min". */
export function formatSpan(ticks: number): string {
  const whole = Math.max(0, ticks);
  const days = Math.floor(whole / TICKS_PER_DAY);
  const rest = whole % TICKS_PER_DAY;
  return C.span(days, Math.floor(rest / TICKS_PER_HOUR), rest % TICKS_PER_HOUR);
}
