// S0 stub: extended by T02d (ECO-001, GDD §14.4 buyer configuration). Definition types per ADR 0012.
// PLACEHOLDER values. T02d decides the real buyers.

import {
  asId,
  cents,
  ratio,
  type BuyerId,
  type LocationId,
  type Money,
  type ProductId,
  type QualityTier,
  type Ratio,
} from "@eov/contracts";
import { CROSSROADS, KESSLER_PHARMACY, LAKEVIEW } from "./map.ts";
import { MOONSHINE } from "./products.ts";

export interface BuyerWantDefinition {
  readonly productId: ProductId;
  readonly minimumQuality: QualityTier;
  /** The buyer's quote relative to the market spot price (1_000_000 = spot). */
  readonly priceRatio: Ratio;
  /** Cases the buyer will take per day. */
  readonly dailyDemand: number;
}

export interface BuyerDefinition {
  readonly id: BuyerId;
  readonly name: string;
  readonly locationId: LocationId;
  /** Cash the buyer can spend per day (GDD §7 buyer liquidity). */
  readonly dailyBudget: Money;
  readonly wants: readonly BuyerWantDefinition[];
}

export const CROSSROADS_ROADHOUSE = asId("Buyer", "crossroads-roadhouse");
export const KESSLERS_BACK_ROOM = asId("Buyer", "kesslers-back-room");
export const LAKEVIEW_HOTEL = asId("Buyer", "lakeview-hotel");

export const BUYERS: readonly BuyerDefinition[] = [
  {
    id: CROSSROADS_ROADHOUSE,
    name: "The Crossroads Roadhouse",
    locationId: CROSSROADS,
    dailyBudget: cents(30_000), // PLACEHOLDER
    wants: [{ productId: MOONSHINE, minimumQuality: "basic", priceRatio: ratio(1_000_000), dailyDemand: 15 }], // PLACEHOLDER
  },
  {
    id: KESSLERS_BACK_ROOM,
    name: "Kessler's Back Room",
    locationId: KESSLER_PHARMACY,
    dailyBudget: cents(45_000), // PLACEHOLDER
    wants: [{ productId: MOONSHINE, minimumQuality: "basic", priceRatio: ratio(1_085_000), dailyDemand: 20 }], // PLACEHOLDER
  },
  {
    id: LAKEVIEW_HOTEL,
    name: "Lakeview Hotel",
    locationId: LAKEVIEW,
    dailyBudget: cents(60_000), // PLACEHOLDER
    wants: [{ productId: MOONSHINE, minimumQuality: "standard", priceRatio: ratio(1_150_000), dailyDemand: 12 }], // PLACEHOLDER
  },
];
