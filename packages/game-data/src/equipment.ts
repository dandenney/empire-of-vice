// S0 stub: extended by T02c (PROD-001). Definition types per ADR 0012.
// PLACEHOLDER values: GDD §6 equipment candidates. T02c decides the real numbers.

import { asId, cents, type EquipmentId, type Money } from "@eov/contracts";

export interface EquipmentDefinition {
  readonly id: EquipmentId;
  readonly name: string;
  /** Purchase price, and the book value when owned at the start of a scenario. */
  readonly price: Money;
  /** Basic moonshine throughput this equipment provides. Not enforced yet (T02c). */
  readonly casesPerDay: number;
}

export const COPPER_STILL = asId("Equipment", "copper-still");

export const EQUIPMENT: readonly EquipmentDefinition[] = [
  { id: COPPER_STILL, name: "Copper still", price: cents(30_000), casesPerDay: 10 }, // PLACEHOLDER
];
