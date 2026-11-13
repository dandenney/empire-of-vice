// The wall-clock speed scheduler (GDD §5 SIM-001, architecture §8, ADR 0014).
//
// A pure fixed-timestep accumulator: it reads an injected clock and says how
// many ticks to run now. It never touches the simulation, so it decides only
// *how many* ticks run, never what they do.
//
// Integer arithmetic only, so there's no float drift:
//   - The clock is read as whole milliseconds (floored). Successive floored
//     readings telescope, so flooring loses no time over a run.
//   - Elapsed time is accumulated in "tick units": ms × speed × TICKS_PER_HOUR.
//     One tick costs the scenario's `realMsPerGameHourAt1x` units at every
//     speed, so the remainder carries across speed changes unchanged.
//
// Pacing is per scenario (ADR 0023 decision 9): the scheduler runs at the
// loaded scenario's `realMsPerGameHourAt1x`, set when it's created and on
// `reset` for a new or loaded game. The default is the M001 scenario's (5 000).
//
// Rest fast-forward (ADR 0023 decision 9): while it's on and the game is
// running, time accrues at REST_SPEED_MULTIPLIER × 1× whatever speed the player
// picked. It isn't a player Speed: `speed` stays 0 | 1 | 2 | 4. `followFounder`
// is the rule (SK1a): on while the founder rests, off when they wake, and off
// for the rest of that rest once a `notify` activity item lands. The host feeds
// it from the player snapshot after each batch. That wiring waits for the
// player snapshot (SK1b), and the `fastForward` flag on SchedulerStatus waits
// for the host and its tests. With `founderRules` off the founder never rests,
// so it stays inert.
//   - Whole ticks move from the accumulator into a backlog. Each step takes at
//     most MAX_TICKS_PER_STEP from the backlog; the rest waits for the next
//     step. Ticks are never dropped (SIM-001).
//
// Pause and hidden tab:
//   - Paused: no time accrues and no ticks are handed out. The backlog and
//     sub-tick remainder are kept, so pausing and resuming loses nothing.
//   - Hidden tab: accrues up to the moment it hides, then auto-pauses and
//     resets the sub-tick remainder, so hidden time is never caught up. It stays
//     paused when the tab is visible again (ADR 0014 decision 4); the player
//     resumes it. Speed requests while hidden are refused.

import { TICKS_PER_HOUR } from "@eov/contracts";
import { FIRST_SHIPMENT_SCENARIO, REST_SPEED_MULTIPLIER, SPEED_MULTIPLIERS, type SpeedMultiplier } from "@eov/game-data";
import { WORKER_COPY } from "./copy.ts";

/** 0 is paused; otherwise a speed multiplier from game-data. */
export type Speed = 0 | SpeedMultiplier;

/**
 * Most ticks run in one timer step: 1 game hour. An engineering bound that keeps
 * each step short (architecture §8), not a gameplay number.
 */
export const MAX_TICKS_PER_STEP = 60;

export interface SchedulerClock {
  /** Milliseconds, monotonic. May be fractional (performance.now()). */
  now(): number;
}

export interface SchedulerStatus {
  readonly speed: Speed;
  /** True when the game was paused because the tab was hidden, until the player picks a speed. */
  readonly autoPaused: boolean;
}

/**
 * What the rest fast-forward follows (ADR 0023 decision 9), read from the player
 * snapshot: always-known founder state and the activity, never world events.
 */
export interface FounderPacing {
  /** The current rest's start tick (`RESTING.startedAt`), or null when the founder isn't resting. */
  readonly restStartedAt: number | null;
  /**
   * An activity item whose importance is `notify` landed since this rest's
   * fast-forward began. The host counts only items newer than its start, so the
   * REST command's own COMMAND item doesn't count.
   */
  readonly notifyLanded: boolean;
}

export const PAUSED_STATUS: SchedulerStatus = { speed: 0, autoPaused: false };

export function isSpeed(value: unknown): value is Speed {
  return value === 0 || (SPEED_MULTIPLIERS as readonly unknown[]).includes(value);
}

/**
 * The pacing a scheduler starts with: the M001 scenario's, the one the game
 * plays. A scenario's pacing is a whole number of ms, at least 1, checked when
 * the scenario file is parsed (game-data `parseScenario`).
 */
export const DEFAULT_REAL_MS_PER_GAME_HOUR_AT_1X = FIRST_SHIPMENT_SCENARIO.realMsPerGameHourAt1x;

export class SpeedScheduler {
  readonly #clock: SchedulerClock;
  #speed: Speed = 0;
  #autoPaused = false;
  #visible = true;
  /** Last clock reading, in whole ms. */
  #lastMs: number;
  /** Real ms per game hour at 1×: what one tick costs, in tick units. The loaded scenario's. */
  #msPerHour: number;
  /** Sub-tick time, in tick units (ms × speed × TICKS_PER_HOUR). Always < #msPerHour. */
  #remainder = 0;
  /** Whole ticks earned but not yet handed out. */
  #backlog = 0;
  /** The rest fast-forward is requested (ADR 0023 decision 9). */
  #restFastForward = false;
  /** The rest `followFounder` last saw (its start tick), and whether a notify item ended its fast-forward. */
  #followedRest: { readonly startedAt: number; readonly ended: boolean } | null = null;

  constructor(clock: SchedulerClock, realMsPerGameHourAt1x: number = DEFAULT_REAL_MS_PER_GAME_HOUR_AT_1X) {
    this.#clock = clock;
    this.#msPerHour = realMsPerGameHourAt1x;
    this.#lastMs = this.#read();
  }

  /** The pacing in use: real ms per game hour at 1× (ADR 0023 decision 9). */
  get realMsPerGameHourAt1x(): number {
    return this.#msPerHour;
  }

  get status(): SchedulerStatus {
    return { speed: this.#speed, autoPaused: this.#autoPaused };
  }

  get speed(): Speed {
    return this.#speed;
  }

  get visible(): boolean {
    return this.#visible;
  }

  /** True while the rest fast-forward is on and the game is running (ADR 0023 decision 9). */
  get fastForward(): boolean {
    return this.#restFastForward && this.#speed !== 0;
  }

  /**
   * Turns the rest fast-forward on or off. Time up to now accrues at the old
   * rate first. Pausing still pauses; the player's speed is kept for when it
   * turns off. `followFounder` is the rule that drives it.
   */
  setRestFastForward(on: boolean): void {
    this.#accrue();
    this.#restFastForward = on;
  }

  /**
   * The rest fast-forward rule (ADR 0023 decision 9): on from the moment a rest
   * is seen, off when the founder wakes, and off for the rest of that rest once a
   * `notify` item lands. A new rest (a different start tick) turns it on again.
   */
  followFounder(pacing: FounderPacing): void {
    const { restStartedAt, notifyLanded } = pacing;
    const previous = this.#followedRest;
    if (restStartedAt === null) {
      this.#followedRest = null;
    } else {
      const same = previous !== null && previous.startedAt === restStartedAt;
      this.#followedRest = { startedAt: restStartedAt, ended: (same && previous.ended) || notifyLanded };
    }
    const on = this.#followedRest !== null && !this.#followedRest.ended;
    if (on !== this.#restFastForward) this.setRestFastForward(on);
  }

  /** Whole ticks owed but not yet handed out by `step()`. */
  get backlog(): number {
    return this.#backlog;
  }

  /**
   * Sets the speed (0 pauses). Time up to now accrues at the old speed first.
   * Clears the auto-paused flag. Refused (returns false) for a running speed
   * while the tab is hidden.
   */
  setSpeed(speed: Speed): boolean {
    if (!isSpeed(speed)) throw new RangeError(WORKER_COPY.notASpeed(String(speed)));
    this.#accrue();
    if (speed !== 0 && !this.#visible) return false;
    this.#speed = speed;
    this.#autoPaused = false;
    return true;
  }

  /** Tab visibility. Hiding a running game auto-pauses it and resets the sub-tick remainder. */
  setVisible(visible: boolean): void {
    this.#accrue();
    if (!visible) {
      if (this.#speed !== 0) {
        this.#speed = 0;
        this.#autoPaused = true;
      }
      this.#remainder = 0;
    }
    this.#visible = visible;
  }

  /**
   * A new or loaded game: paused, nothing owed, no fast-forward. Visibility is
   * the tab's and is kept. Pass the game's scenario pacing to change it (ADR 0023 decision 9);
   * omitted, the pacing stays as it was.
   */
  reset(realMsPerGameHourAt1x: number = this.#msPerHour): void {
    this.#accrue();
    this.#msPerHour = realMsPerGameHourAt1x;
    this.#speed = 0;
    this.#autoPaused = false;
    this.#remainder = 0;
    this.#backlog = 0;
    this.#restFastForward = false;
    this.#followedRest = null;
  }

  /** Ticks to run now: whatever is owed, at most MAX_TICKS_PER_STEP. 0 while paused. */
  step(): number {
    this.#accrue();
    if (this.#speed === 0) return 0;
    const ticks = Math.min(this.#backlog, MAX_TICKS_PER_STEP);
    this.#backlog -= ticks;
    return ticks;
  }

  #read(): number {
    return Math.floor(this.#clock.now());
  }

  #accrue(): void {
    const nowMs = this.#read();
    const elapsed = nowMs - this.#lastMs;
    this.#lastMs = nowMs;
    if (elapsed <= 0 || this.#speed === 0 || !this.#visible) return;
    const rate = this.#restFastForward ? REST_SPEED_MULTIPLIER : this.#speed;
    this.#remainder += elapsed * rate * TICKS_PER_HOUR;
    const ticks = Math.floor(this.#remainder / this.#msPerHour);
    this.#remainder -= ticks * this.#msPerHour;
    this.#backlog += ticks;
  }
}
