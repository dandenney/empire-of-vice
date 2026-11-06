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
//     One tick costs REAL_MS_PER_GAME_HOUR_AT_1X units at every speed, so the
//     remainder carries across speed changes unchanged.
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
import { REAL_MS_PER_GAME_HOUR_AT_1X, SPEED_MULTIPLIERS, type SpeedMultiplier } from "@eov/game-data";
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

export const PAUSED_STATUS: SchedulerStatus = { speed: 0, autoPaused: false };

export function isSpeed(value: unknown): value is Speed {
  return value === 0 || (SPEED_MULTIPLIERS as readonly unknown[]).includes(value);
}

export class SpeedScheduler {
  readonly #clock: SchedulerClock;
  #speed: Speed = 0;
  #autoPaused = false;
  #visible = true;
  /** Last clock reading, in whole ms. */
  #lastMs: number;
  /** Sub-tick time, in tick units (ms × speed × TICKS_PER_HOUR). Always < REAL_MS_PER_GAME_HOUR_AT_1X. */
  #remainder = 0;
  /** Whole ticks earned but not yet handed out. */
  #backlog = 0;

  constructor(clock: SchedulerClock) {
    this.#clock = clock;
    this.#lastMs = this.#read();
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

  /** A new or loaded game: paused, nothing owed. Visibility is the tab's and is kept. */
  reset(): void {
    this.#accrue();
    this.#speed = 0;
    this.#autoPaused = false;
    this.#remainder = 0;
    this.#backlog = 0;
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
    this.#remainder += elapsed * this.#speed * TICKS_PER_HOUR;
    const ticks = Math.floor(this.#remainder / REAL_MS_PER_GAME_HOUR_AT_1X);
    this.#remainder -= ticks * REAL_MS_PER_GAME_HOUR_AT_1X;
    this.#backlog += ticks;
  }
}
