// Per-facility production specs (T02c1, PROD-001; ADR 0017 decision 4).
// Definition types per ADR 0012. Keyed by FacilityId, one per facility in map.ts.
// T02c2 adds maximum workers and daily overhead. PLACEHOLDER values: T07a/T07 tune them.

import type { FacilityId } from "@eov/contracts";
import { DISTILLERY_MAIN } from "./map.ts";

export interface FacilityProductionDefinition {
  readonly facilityId: FacilityId;
  /** Equipment items the facility can hold; each owned item uses one. */
  readonly equipmentSlots: number;
  /** Finished cases the facility stores before any equipment bonus. */
  readonly baseStorage: number;
}

export const FACILITY_PRODUCTION: readonly FacilityProductionDefinition[] = [
  {
    facilityId: DISTILLERY_MAIN,
    equipmentSlots: 4, // PLACEHOLDER
    baseStorage: 50, // PLACEHOLDER
  },
];
