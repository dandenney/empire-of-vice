// S0 stub: extended by T03 (vehicles and cargo capacity). Definition types per ADR 0012.
// PLACEHOLDER values. T03 decides the real numbers.

import { asId, cents, type FacilityId, type Money, type VehicleId } from "@eov/contracts";
import { DISTILLERY_MAIN } from "./map.ts";

export interface VehicleDefinition {
  readonly id: VehicleId;
  readonly name: string;
  /** Maximum cases per trip. */
  readonly capacityCases: number;
  /** Book value when owned at the start of a scenario. */
  readonly bookValue: Money;
  /** Where the vehicle loads cargo and returns to after each trip. */
  readonly homeFacilityId: FacilityId;
}

export const MODEL_TT_TRUCK = asId("Vehicle", "model-tt-truck");

export const VEHICLES: readonly VehicleDefinition[] = [
  { id: MODEL_TT_TRUCK, name: "Model TT truck", capacityCases: 20, bookValue: cents(40_000), homeFacilityId: DISTILLERY_MAIN }, // PLACEHOLDER
];
