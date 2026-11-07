// Equipment catalog (T02c1, PROD-001; GDD §6 equipment table). Definition types per ADR 0012.
// PLACEHOLDER values: prices and bonuses from GDD §6. Names and descriptions are
// placeholder copy. T07a/T07 tune the numbers; T05 sets the QC station's unlock.

import { asId, cents, ratio, type EquipmentId, type Money, type Ratio, type UnlockId } from "@eov/contracts";
import { CAPACITY_EQUIPMENT, QUALITY_EQUIPMENT } from "./progression.ts";

export interface EquipmentDefinition {
  readonly id: EquipmentId;
  readonly name: string;
  /** What the item does, for the purchase list. */
  readonly description: string;
  /** Purchase price, and the book value when owned (bought, or at the start of a scenario). */
  readonly price: Money;
  /**
   * Added to the facility's throughput ratio (ADR 0017 decision 1): a facility
   * runs at RATIO_SCALE + Σ throughputBonus of what it owns.
   */
  readonly throughputBonus: Ratio;
  /** Finished cases of storage this item adds to the facility (ADR 0017 decision 3). */
  readonly storageBonus: number;
  /**
   * Workers this item needs to run at full speed (ADR 0017 decision 1). The
   * facility's crew is Σ crew of what it owns; it runs at min(workers, crew) / crew
   * of its throughput, or 1× when the crew is 0.
   */
  readonly crew: number;
  /** An unlock the family must hold to buy it (`LOCKED` otherwise), or null. */
  readonly requiredUnlockId: UnlockId | null;
}

export const COPPER_STILL = asId("Equipment", "copper-still");
export const IMPROVED_CONDENSER = asId("Equipment", "improved-condenser");
export const QC_STATION = asId("Equipment", "qc-station");
export const STORAGE_EXPANSION = asId("Equipment", "storage-expansion");

export const EQUIPMENT: readonly EquipmentDefinition[] = [
  {
    id: COPPER_STILL,
    name: "Copper still",
    description: "Runs moonshine recipes.", // PLACEHOLDER copy
    price: cents(30_000), // PLACEHOLDER
    throughputBonus: ratio(0), // PLACEHOLDER
    storageBonus: 0, // PLACEHOLDER
    crew: 3, // PLACEHOLDER
    requiredUnlockId: null,
  },
  {
    id: IMPROVED_CONDENSER,
    name: "Improved condenser",
    description: "Faster runs on every recipe.", // PLACEHOLDER copy
    price: cents(45_000), // PLACEHOLDER
    throughputBonus: ratio(400_000), // PLACEHOLDER: +40%
    storageBonus: 0, // PLACEHOLDER
    crew: 1, // PLACEHOLDER
    requiredUnlockId: CAPACITY_EQUIPMENT, // ADR 0020 decision 3: tier 2
  },
  {
    id: QC_STATION,
    name: "Quality-control station",
    description: "Needed for standard-quality recipes.", // PLACEHOLDER copy
    price: cents(65_000), // PLACEHOLDER
    throughputBonus: ratio(0), // PLACEHOLDER
    storageBonus: 0, // PLACEHOLDER
    crew: 0, // PLACEHOLDER
    requiredUnlockId: QUALITY_EQUIPMENT, // ADR 0020 decision 3: tier 3
  },
  {
    id: STORAGE_EXPANSION,
    name: "Storage expansion",
    description: "Room for more finished cases.", // PLACEHOLDER copy
    price: cents(35_000), // PLACEHOLDER
    throughputBonus: ratio(0), // PLACEHOLDER
    storageBonus: 100, // PLACEHOLDER: +100 cases
    crew: 0, // PLACEHOLDER
    requiredUnlockId: CAPACITY_EQUIPMENT, // ADR 0020 decision 3: tier 2
  },
];
