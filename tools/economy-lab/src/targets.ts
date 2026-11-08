// The GDD §13 provisional balance targets, shared by the smoke report (T07a) and
// the balance report (T07c, issue #120).
//
// These are comparison targets for the lab's reports, not gameplay numbers:
// nothing in the game reads them, so they live here rather than in game-data.
// The victory thresholds the game does read (net worth, reputation, completed
// contracts) come from game-data (`progression.victory`), through `victoryOf`.

import { TICKS_PER_HOUR } from "@eov/contracts";
import { GAME_DATA, REAL_MS_PER_GAME_HOUR_AT_1X, type GameData } from "@eov/game-data";

/** Ticks per real minute at 1× (GDD §5: 720), derived from the pacing data. */
export const TICKS_PER_REAL_MINUTE = (TICKS_PER_HOUR * 60_000) / REAL_MS_PER_GAME_HOUR_AT_1X;

/** GDD §13 targets. Times are ticks at 1×; rates and gaps are whole percentages. */
export const TARGETS = {
  /** First profitable sale: within 5 real minutes. */
  firstProfitMaxTicks: 5 * TICKS_PER_REAL_MINUTE,
  /** First meaningful upgrade: 10–15 real minutes. */
  firstUpgradeMinTicks: 10 * TICKS_PER_REAL_MINUTE,
  firstUpgradeMaxTicks: 15 * TICKS_PER_REAL_MINUTE,
  /** M001 victory: 20–30 real minutes. */
  victoryMinTicks: 20 * TICKS_PER_REAL_MINUTE,
  victoryMaxTicks: 30 * TICKS_PER_REAL_MINUTE,
  /** Competent strategy success: 60–85% of runs win. */
  competentSuccessMinPercent: 60,
  competentSuccessMaxPercent: 85,
  /** Dominant strategy advantage: best win rate less worst, under 20 points. */
  dominantAdvantageMaxPoints: 20,
  /**
   * "Recovery from one moderate setback: usually possible." The lab reads
   * "usually" as at least three runs in four (see the balance report's
   * definition of a setback and of recovering from one).
   */
  setbackRecoveryMinPercent: 75,
  /** A setback counts as recovered once net worth is back to its pre-setback level within this many ticks. */
  setbackRecoveryWindowTicks: 6 * TICKS_PER_REAL_MINUTE,
  /** Fewer judged runs than this is too little evidence to call the recovery target MET. */
  setbackMinJudgedRuns: 30,
  /** Financial reconciliation failures and replay divergences: zero. */
  reconciliationFailuresMax: 0,
  replayDivergencesMax: 0,
} as const;

/** The M001 victory thresholds, read from game-data (GDD §4, ADR 0020). */
export function victoryOf(data: GameData = GAME_DATA): GameData["progression"]["victory"] {
  return data.progression.victory;
}
