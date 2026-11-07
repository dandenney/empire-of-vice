// Per-facility production specs (T02c1, PROD-001; ADR 0017 decision 4).
// Definition types per ADR 0012. Keyed by FacilityId, one per facility in map.ts.
// T02c2 (issue #63) adds maximum workers and daily overhead. PLACEHOLDER values: T07a/T07 tune them.

import { cents, type FacilityId, type Money } from "@eov/contracts";
import { DISTILLERY_MAIN, RIVERSIDE_WAREHOUSE } from "./map.ts";

export interface FacilityProductionDefinition {
  readonly facilityId: FacilityId;
  /** Equipment items the facility can hold; each owned item uses one. */
  readonly equipmentSlots: number;
  /** Finished cases the facility stores before any equipment bonus. */
  readonly baseStorage: number;
  /** The most workers the facility can employ (SET_WORKFORCE's WORKFORCE_LIMIT_EXCEEDED). */
  readonly maximumWorkers: number;
  /** Overhead expensed at each midnight, whatever the facility produced (ADR 0017 decisions 7 and 9). */
  readonly dailyOverhead: Money;
}

export const FACILITY_PRODUCTION: readonly FacilityProductionDefinition[] = [
  {
    facilityId: DISTILLERY_MAIN,
    equipmentSlots: 4, // PLACEHOLDER
    baseStorage: 50, // PLACEHOLDER
    maximumWorkers: 8, // PLACEHOLDER
    dailyOverhead: cents(200), // PLACEHOLDER: $2.00 a day
  },
  {
    // Storage only (T03b, #76): no equipment, no crew. Not owned in M001.
    facilityId: RIVERSIDE_WAREHOUSE,
    equipmentSlots: 0,
    baseStorage: 200, // PLACEHOLDER
    maximumWorkers: 0,
    dailyOverhead: cents(100), // PLACEHOLDER: $1.00 a day
  },
];
