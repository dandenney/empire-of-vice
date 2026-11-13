// Presence, time of day and rest (ADR 0023 decisions 3, 4, 6, 7, 9). Definition
// types per ADR 0012, built from contract primitives. Every value is PLACEHOLDER
// tuning for the playtests (PT1, #175); place hours and rest places are also story.
//
// Read only with `founderRules: true` (the M002 scenario, SK1a). The M001
// scenario plays exactly as before.
//
// Validated when this module loads, like the knowledge tables: a bad table throws
// PresenceDataError before any game starts.

import { ACTIVITY_KINDS, compareIds, TICKS_PER_DAY, TICKS_PER_HOUR, type ActivityKind, type LocationId } from "@eov/contracts";
import { CROSSROADS, HOLLOW_CREEK, KESSLER_PHARMACY, LAKEVIEW, LOCATIONS, MILLERS_FEED_LOCATION, type LocationDefinition } from "./map.ts";

export class PresenceDataError extends Error {
  override readonly name = "PresenceDataError";
}

/**
 * The most ticks an eager command can apply after the snapshot the UI computed
 * from: a scheduler batch in flight (`MAX_TICKS_PER_STEP`, 60, ADR 0014) then
 * `state.tick + 1`. The one-click "rest until morning" clamps into
 * [now + MIN_REST_TICKS + 61, now + MAX_REST_TICKS − 60], so that range must hold
 * at least one tick: MAX_REST_TICKS − MIN_REST_TICKS ≥ 121 (ADR 0023 decision 7).
 */
export const REST_RANGE_MIN_SPAN_TICKS = 121;

// ---------------------------------------------------------------------------
// Activities (decision 4)
// ---------------------------------------------------------------------------

/** How long each timed activity keeps the founder busy, in ticks. PLACEHOLDER. */
export const ACTIVITY_DURATIONS: Readonly<Record<ActivityKind, number>> = {
  BUY_MATERIALS: 30, // PLACEHOLDER: picking, haggling, settling up
  START_BATCH: 30, // PLACEHOLDER: setting up the still
  LOAD_TRUCK: 30, // PLACEHOLDER: loading cases; the truck leaves after
  AGREE_DEAL: 30, // PLACEHOLDER: settling price and quantity face to face
  ACCEPT_CONTRACT: 60, // PLACEHOLDER: a sit-down with the buyer
  BUY_EQUIPMENT: 60, // PLACEHOLDER: a deal plus installation
  SELL_EQUIPMENT: 60, // PLACEHOLDER: a deal plus removal
  SET_WORKFORCE: 30, // PLACEHOLDER: talking to the men
};

// ---------------------------------------------------------------------------
// Travel (decision 3)
// ---------------------------------------------------------------------------

/** A leg on foot takes the route's duration × this / 1 000 000, rounded up. PLACEHOLDER: three times slower than the truck. */
export const FOOT_TRAVEL_PPM = 3_000_000;

// ---------------------------------------------------------------------------
// Place hours (decision 6)
// ---------------------------------------------------------------------------

/**
 * Opening hours as minute-of-day intervals, `[opensAtMinute, closesAtMinute)`.
 * An interval with `closesAtMinute < opensAtMinute` crosses midnight.
 */
export interface PlaceHoursInterval {
  readonly opensAtMinute: number;
  readonly closesAtMinute: number;
}

export interface PlaceHoursDefinition {
  readonly locationId: LocationId;
  readonly intervals: readonly PlaceHoursInterval[];
}

const hours = (opensAtHour: number, closesAtHour: number): PlaceHoursInterval => ({
  opensAtMinute: opensAtHour * 60,
  closesAtMinute: closesAtHour * 60,
});

/**
 * Checks place hours: one entry per location at most, sorted by location ID,
 * for locations that exist; each with at least one interval of whole minutes in
 * 0..1439 whose ends differ. Returns the table unchanged.
 */
export function validatePlaceHours(
  table: readonly PlaceHoursDefinition[],
  locations: readonly LocationDefinition[] = LOCATIONS,
): readonly PlaceHoursDefinition[] {
  const known = new Set<string>(locations.map((l) => l.id));
  table.forEach((entry, i) => {
    if (!known.has(entry.locationId)) throw new PresenceDataError(`PLACE_HOURS: unknown location ${entry.locationId}`);
    const previous = table[i - 1];
    if (previous && compareIds(previous.locationId, entry.locationId) >= 0) {
      throw new PresenceDataError("PLACE_HOURS needs at most one entry per location, sorted by location ID");
    }
    if (entry.intervals.length === 0) throw new PresenceDataError(`PLACE_HOURS.${entry.locationId}: no intervals (leave the place out to keep it always open)`);
    for (const { opensAtMinute, closesAtMinute } of entry.intervals) {
      for (const minute of [opensAtMinute, closesAtMinute]) {
        if (!Number.isSafeInteger(minute) || minute < 0 || minute >= TICKS_PER_DAY) {
          throw new PresenceDataError(`PLACE_HOURS.${entry.locationId}: ${minute} isn't a minute of the day`);
        }
      }
      if (opensAtMinute === closesAtMinute) throw new PresenceDataError(`PLACE_HOURS.${entry.locationId}: an interval opens and closes at the same minute`);
    }
  });
  return table;
}

/**
 * When each place is open. A location with no entry is always open, and so are
 * your own facilities (Hollow Creek, the depot). PLACEHOLDER (story and tuning).
 */
export const PLACE_HOURS: readonly PlaceHoursDefinition[] = validatePlaceHours(
  [
    { locationId: CROSSROADS, intervals: [hours(11, 23)] },
    { locationId: KESSLER_PHARMACY, intervals: [hours(9, 19)] },
    // The back room: 20:00–02:00, across midnight.
    { locationId: LAKEVIEW, intervals: [hours(20, 2)] },
    { locationId: MILLERS_FEED_LOCATION, intervals: [hours(7, 18)] },
  ].sort((a, b) => compareIds(a.locationId, b.locationId)),
);

// ---------------------------------------------------------------------------
// Rest (decision 7)
// ---------------------------------------------------------------------------

/** Places where a full rest takes FULL_REST_TICKS. Anywhere else is sleeping rough. PLACEHOLDER: the cot at Hollow Creek. */
export const REST_PLACES: readonly LocationId[] = [HOLLOW_CREEK];

/** Shortest rest: `untilTick` ≥ apply tick + this. PLACEHOLDER: 2 h. */
export const MIN_REST_TICKS = 2 * TICKS_PER_HOUR;
/** Longest rest: `untilTick` ≤ apply tick + this. PLACEHOLDER: 14 h. */
export const MAX_REST_TICKS = 14 * TICKS_PER_HOUR;
/** A full rest at a rest place. PLACEHOLDER: 8 h. */
export const FULL_REST_TICKS = 8 * TICKS_PER_HOUR;
/** A full rest sleeping rough. PLACEHOLDER: 12 h. */
export const ROUGH_REST_TICKS = 12 * TICKS_PER_HOUR;
/** The founder is tired once `now − awakeSince` exceeds this. PLACEHOLDER: 18 h. */
export const TIRED_AFTER_TICKS = 18 * TICKS_PER_HOUR;
/** While tired, activity durations are multiplied by this / 1 000 000, rounded up. PLACEHOLDER: 50% longer. */
export const TIRED_DURATION_PPM = 1_500_000;
/** "Rest until morning" aims for this hour of the day. PLACEHOLDER: 06:00. */
export const WAKE_HOUR = 6;
/** A new M002 game: the founder rests from tick 0 (00:00) until this tick. PLACEHOLDER: 06:00. */
export const START_WAKE_TICK = 6 * TICKS_PER_HOUR;
/** While the founder rests and the game runs, the scheduler runs at this × 1× (decision 9). PLACEHOLDER. */
export const REST_SPEED_MULTIPLIER = 16;

/** Everything in this module, checked together by `validatePresence`. */
export interface PresenceDefinition {
  readonly activityDurations: Readonly<Record<ActivityKind, number>>;
  readonly footTravelPpm: number;
  readonly placeHours: readonly PlaceHoursDefinition[];
  readonly restPlaces: readonly LocationId[];
  readonly minRestTicks: number;
  readonly maxRestTicks: number;
  readonly fullRestTicks: number;
  readonly roughRestTicks: number;
  readonly tiredAfterTicks: number;
  readonly tiredDurationPpm: number;
  readonly wakeHour: number;
  readonly startWakeTick: number;
  readonly restSpeedMultiplier: number;
}

/**
 * Checks the presence tables (ADR 0023 decision 11, with the round-4 review's
 * rest-range follow-up). Returns them unchanged; throws PresenceDataError.
 * - every activity has a whole, non-negative duration;
 * - the foot and tired factors are whole parts per million, at least 1 000 000
 *   (walking is never faster than driving, tiredness never speeds anything up);
 * - rest places are known locations, unique;
 * - MIN_REST_TICKS ≥ 1, and MAX_REST_TICKS − MIN_REST_TICKS ≥ 121, so the
 *   one-click rest's margins leave a valid `untilTick` (REST_RANGE_MIN_SPAN_TICKS);
 * - full rests are positive; tiredness sets in after a positive time;
 * - WAKE_HOUR is an hour of the day, START_WAKE_TICK is within the first day;
 * - the rest fast-forward is a whole multiplier of at least 1.
 */
export function validatePresence(data: PresenceDefinition, locations: readonly LocationDefinition[] = LOCATIONS): PresenceDefinition {
  const wholeAtLeast = (name: string, value: number, min: number) => {
    if (!Number.isSafeInteger(value) || value < min) throw new PresenceDataError(`${name} must be a whole number of at least ${min}, got ${value}`);
  };
  for (const kind of ACTIVITY_KINDS) wholeAtLeast(`ACTIVITY_DURATIONS.${kind}`, data.activityDurations[kind], 0);
  if (Object.keys(data.activityDurations).length !== ACTIVITY_KINDS.length) throw new PresenceDataError("ACTIVITY_DURATIONS has an unknown activity");
  wholeAtLeast("FOOT_TRAVEL_PPM", data.footTravelPpm, 1_000_000);
  wholeAtLeast("TIRED_DURATION_PPM", data.tiredDurationPpm, 1_000_000);
  validatePlaceHours(data.placeHours, locations);
  const known = new Set<string>(locations.map((l) => l.id));
  for (const id of data.restPlaces) if (!known.has(id)) throw new PresenceDataError(`REST_PLACES: unknown location ${id}`);
  if (new Set(data.restPlaces).size !== data.restPlaces.length) throw new PresenceDataError("REST_PLACES repeats a location");
  wholeAtLeast("MIN_REST_TICKS", data.minRestTicks, 1);
  wholeAtLeast("MAX_REST_TICKS", data.maxRestTicks, data.minRestTicks);
  if (data.maxRestTicks - data.minRestTicks < REST_RANGE_MIN_SPAN_TICKS) {
    throw new PresenceDataError(
      `MAX_REST_TICKS − MIN_REST_TICKS is ${data.maxRestTicks - data.minRestTicks}; it must be at least ${REST_RANGE_MIN_SPAN_TICKS} for the one-click rest's margins`,
    );
  }
  wholeAtLeast("FULL_REST_TICKS", data.fullRestTicks, 1);
  wholeAtLeast("ROUGH_REST_TICKS", data.roughRestTicks, 1);
  wholeAtLeast("TIRED_AFTER_TICKS", data.tiredAfterTicks, 1);
  wholeAtLeast("WAKE_HOUR", data.wakeHour, 0);
  if (data.wakeHour >= TICKS_PER_DAY / TICKS_PER_HOUR) throw new PresenceDataError(`WAKE_HOUR ${data.wakeHour} isn't an hour of the day`);
  wholeAtLeast("START_WAKE_TICK", data.startWakeTick, 0);
  if (data.startWakeTick >= TICKS_PER_DAY) throw new PresenceDataError(`START_WAKE_TICK ${data.startWakeTick} isn't within the first day`);
  wholeAtLeast("REST_SPEED_MULTIPLIER", data.restSpeedMultiplier, 1);
  return data;
}

/** The presence tables, validated. */
export const PRESENCE: PresenceDefinition = validatePresence({
  activityDurations: ACTIVITY_DURATIONS,
  footTravelPpm: FOOT_TRAVEL_PPM,
  placeHours: PLACE_HOURS,
  restPlaces: REST_PLACES,
  minRestTicks: MIN_REST_TICKS,
  maxRestTicks: MAX_REST_TICKS,
  fullRestTicks: FULL_REST_TICKS,
  roughRestTicks: ROUGH_REST_TICKS,
  tiredAfterTicks: TIRED_AFTER_TICKS,
  tiredDurationPpm: TIRED_DURATION_PPM,
  wakeHour: WAKE_HOUR,
  startWakeTick: START_WAKE_TICK,
  restSpeedMultiplier: REST_SPEED_MULTIPLIER,
});
