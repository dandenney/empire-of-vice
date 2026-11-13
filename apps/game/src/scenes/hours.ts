// A place's opening hours as the scenes show them (SK2b, #234). Place hours
// are static game-data (PLACE_HOURS, ADR 0023 decision 6) and the clock is
// always known (ADR 0021 decision 3), so whether a place is open now is known
// without being there. This is a display: the simulation's presence gate
// decides (PLACE_CLOSED), and the scene reports its answer.

import { minuteOfDay, tick, TICKS_PER_DAY, type LocationId, type Tick } from "@eov/contracts";
import { PLACE_HOURS, type PlaceHoursInterval } from "@eov/game-data";

export type HoursView =
  /** No PLACE_HOURS entry: always open (the family's own places, the depot). */
  | { readonly kind: "ALWAYS" }
  | {
      readonly kind: "HOURS";
      readonly intervals: readonly PlaceHoursInterval[];
      readonly open: boolean;
      /** While closed, the next tick it opens; null while open. */
      readonly opensAt: Tick | null;
    };

function openAtMinute(intervals: readonly PlaceHoursInterval[], minute: number): boolean {
  return intervals.some(({ opensAtMinute: o, closesAtMinute: c }) => (o < c ? minute >= o && minute < c : minute >= o || minute < c));
}

/** The place's hours at tick `now`. */
export function hoursAt(locationId: LocationId, now: Tick): HoursView {
  const entry = PLACE_HOURS.find((h) => h.locationId === locationId);
  if (!entry) return { kind: "ALWAYS" };
  const open = openAtMinute(entry.intervals, minuteOfDay(now));
  let opensAt: Tick | null = null;
  if (!open) {
    for (let t = now + 1; t <= now + TICKS_PER_DAY; t++) {
      if (openAtMinute(entry.intervals, minuteOfDay(tick(t)))) {
        opensAt = tick(t);
        break;
      }
    }
  }
  return { kind: "HOURS", intervals: entry.intervals, open, opensAt };
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** A minute of the day as "07:00". */
export function clockTime(minute: number): string {
  return `${pad2(Math.floor(minute / 60))}:${pad2(minute % 60)}`;
}
