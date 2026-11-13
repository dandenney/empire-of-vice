// How the founder's time is measured (ADR 0023 decisions 3, 4, 6, 7). Pure
// functions over game-data and the always-known founder state. Integer
// arithmetic only: parts-per-million factors round up, recovery rounds down.

import { addTicks, minuteOfDay, tick, TICKS_PER_DAY, type ActivityKind, type FounderState, type LocationId, type Tick } from "@eov/contracts";
import {
  ACTIVITY_DURATIONS,
  FOOT_TRAVEL_PPM,
  FULL_REST_TICKS,
  PLACE_HOURS,
  REST_PLACES,
  ROUGH_REST_TICKS,
  TIRED_AFTER_TICKS,
  TIRED_DURATION_PPM,
} from "@eov/game-data";

const PPM = 1_000_000;

/** `value × ppm / 1 000 000`, rounded up, in integers. */
export function scaleUp(value: number, ppm: number): number {
  return Math.floor((value * ppm + PPM - 1) / PPM);
}

/** Tired at `t`: more than TIRED_AFTER_TICKS since the effective start of the waking day (decision 7). */
export function isTired(founder: FounderState, t: Tick): boolean {
  return t - founder.awakeSince > TIRED_AFTER_TICKS;
}

/** How long an activity applied at `t` keeps the founder busy (decision 4), stretched while tired (decision 7). */
export function activityTicks(founder: FounderState, activity: ActivityKind, t: Tick): number {
  const base = ACTIVITY_DURATIONS[activity];
  return isTired(founder, t) ? scaleUp(base, TIRED_DURATION_PPM) : base;
}

/** A leg's duration (decision 3): the route's by vehicle, × FOOT_TRAVEL_PPM rounded up on foot. Tiredness doesn't change it. */
export function legTicks(routeDurationTicks: number, onFoot: boolean): number {
  return onFoot ? scaleUp(routeDurationTicks, FOOT_TRAVEL_PPM) : routeDurationTicks;
}

// ---------------------------------------------------------------------------
// Place hours (decision 6): geography, always known
// ---------------------------------------------------------------------------

/** Whether `locationId` is open at `t`. No entry: always open (your own facilities, the depot). */
export function isOpenAt(locationId: LocationId, t: Tick): boolean {
  const entry = PLACE_HOURS.find((h) => h.locationId === locationId);
  if (!entry) return true;
  const m = minuteOfDay(t);
  return entry.intervals.some(({ opensAtMinute: o, closesAtMinute: c }) => (o < c ? m >= o && m < c : m >= o || m < c));
}

/** The first tick at or after `t` when `locationId` is open (`PLACE_CLOSED.opensAt`). Every place opens within a day. */
export function opensAt(locationId: LocationId, t: Tick): Tick {
  for (let i = 0; i < TICKS_PER_DAY; i++) {
    const candidate = addTicks(t, i);
    if (isOpenAt(locationId, candidate)) return candidate;
  }
  throw new RangeError(`${locationId} never opens`);
}

// ---------------------------------------------------------------------------
// Rest (decision 7)
// ---------------------------------------------------------------------------

/** A full rest's length where the founder sleeps: FULL_REST_TICKS at a rest place, else ROUGH_REST_TICKS. */
export function fullRestTicks(locationId: LocationId): number {
  return REST_PLACES.includes(locationId) ? FULL_REST_TICKS : ROUGH_REST_TICKS;
}

/**
 * `awakeSince` after waking at `wakeTick` from a rest that started at
 * `startedAt` (decision 7): a full rest for the place resets it to the wake
 * tick; a shorter one moves it forward by `rested × TIRED_AFTER_TICKS /
 * fullRestTicks` (floor), capped at the wake tick.
 */
export function awakeSinceAfterRest(awakeSince: Tick, locationId: LocationId, startedAt: Tick, wakeTick: Tick): Tick {
  const rested = wakeTick - startedAt;
  const full = fullRestTicks(locationId);
  if (rested >= full) return wakeTick;
  const moved = awakeSince + Math.floor((rested * TIRED_AFTER_TICKS) / full);
  return tick(Math.min(moved, wakeTick));
}
