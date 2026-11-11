// The lab's setback scenario (T07f, issue #129): The First Shipment with one
// scheduled SHAKEDOWN, so every strategy meets the same moderate loss on the
// same day and GDD §13's "recovery from one moderate setback" can be judged for
// all of them, not only for the strategies that happen to book a large loss.
//
// The shakedown takes a share of net worth, capped at cash (orchestrator decision
// on #129). A capped loss can fall under the moderate threshold; the report
// counts those runs apart rather than judging them.
//
// These are lab settings, not gameplay numbers: the game never schedules this
// event (FIRST_SHIPMENT_SCENARIO doesn't), so they live here, like TARGETS.

import { TICKS_PER_DAY, tick } from "@eov/contracts";
import { FIRST_SHIPMENT_SCENARIO, type ScenarioDefinition, type ScenarioShakedown } from "@eov/game-data";
import { TARGETS } from "./targets.ts";

/** The parts-per-million scale of `netWorthSharePpm`. */
const PPM = 1_000_000;

/**
 * The scheduled shakedown: 16% of net worth at noon on game day 5 (tick 7 920).
 * One point over the moderate threshold (issue #129's floor is 150 000 ppm): at
 * exactly 15% the simulation's rounding to the cent would put about half the
 * losses a fraction of a cent under it, and the report would skip them as not
 * moderate. With the extra point a loss is under 15% only when it was capped at
 * cash. Day 5 is before every strategy's usual victory, and leaves the recovery
 * window inside the win cutoff.
 */
export const SETBACK_SHAKEDOWN: ScenarioShakedown = {
  kind: "SHAKEDOWN",
  tick: tick(5 * TICKS_PER_DAY + TICKS_PER_DAY / 2),
  reason: "RIVAL",
  netWorthSharePpm: ((TARGETS.moderateSetbackMinPercent + 1) * PPM) / 100,
};

/** The First Shipment plus `SETBACK_SHAKEDOWN`, its other scheduled events kept in file order. */
export function setbackScenario(base: ScenarioDefinition = FIRST_SHIPMENT_SCENARIO, shakedown: ScenarioShakedown = SETBACK_SHAKEDOWN): ScenarioDefinition {
  return { ...base, scheduledEvents: [...base.scheduledEvents, shakedown] };
}

export const SETBACK_SCENARIO: ScenarioDefinition = setbackScenario();
