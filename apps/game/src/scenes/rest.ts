// The one-click "rest until morning" (ADR 0023 decision 7): the REST command's
// `untilTick`, computed from the snapshot's tick and game-data.
//
//   untilTick = the first WAKE_HOUR after now + MIN_REST_TICKS, clamped into
//               [now + MIN_REST_TICKS + margin, now + MAX_REST_TICKS − (margin − 1)]
//
// where margin = MAX_TICKS_PER_STEP + 1: an eager command can apply up to one
// scheduler batch plus one tick after the snapshot it was computed from, and
// the margins keep the one-click form clear of INVALID_REST_LENGTH. While
// paused, the snapshot is exact and the clamp never bites at a normal hour.

import { minuteOfDay, tick, TICKS_PER_DAY, TICKS_PER_HOUR, type Tick } from "@eov/contracts";
import { MAX_REST_TICKS, MIN_REST_TICKS, WAKE_HOUR } from "@eov/game-data";
import { MAX_TICKS_PER_STEP } from "../workers/scheduler.ts";

const MARGIN = MAX_TICKS_PER_STEP + 1;

export function restUntilMorning(now: Tick): Tick {
  const earliest = now + MIN_REST_TICKS;
  let next = earliest - minuteOfDay(tick(earliest)) + WAKE_HOUR * TICKS_PER_HOUR;
  if (next <= earliest) next += TICKS_PER_DAY;
  const lo = earliest + MARGIN;
  const hi = now + MAX_REST_TICKS - (MARGIN - 1);
  return tick(Math.min(Math.max(next, lo), hi));
}
