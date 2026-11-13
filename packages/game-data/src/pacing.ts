// Real-time pacing (GDD §5, SIM-001): how fast game time runs at each speed.
//
// The browser's speed scheduler (apps/game/src/workers/scheduler.ts, ADR 0014)
// reads these to decide how many ticks to run. They never change the economic
// rules, only how much real time a game hour takes. They're tuning values, so
// they live here and not in the scheduler (CLAUDE.md rule 3).
//
// Pacing is per scenario (ADR 0023 decision 9): each scenario sets
// `realMsPerGameHourAt1x`, and the scheduler reads the loaded scenario's value.

/**
 * The default real milliseconds one game hour (60 ticks) takes at 1×, which the
 * M001 scenario uses. At 1×: 12 ticks per real second, 2 real minutes per game day.
 */
export const REAL_MS_PER_GAME_HOUR_AT_1X = 5_000;

/** The running speeds the player can pick, as multipliers of 1×. Pause is separate (no ticks run). */
export const SPEED_MULTIPLIERS = [1, 2, 4] as const;

export type SpeedMultiplier = (typeof SPEED_MULTIPLIERS)[number];
