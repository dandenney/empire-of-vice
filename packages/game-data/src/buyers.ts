// ECO-001 buyers (T02d, issue #8, decision 1; GDD §14.4; ADR 0016). Definition types per ADR 0012.
//
// Three buyers with distinct roles: a cheap, cash-limited roadhouse (its budget
// binds before its demand), Kessler's with basic and standard wants, and
// Lakeview, the best standard price behind a reputation requirement.

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
  /**
   * The lowest quality the buyer takes for this want. A buyer has at most one
   * want per (product, minimum quality), and a market must exist for it: the
   * want's quote is priced from that market's spot price.
   */
  readonly minimumQuality: QualityTier;
  /** The buyer's quote relative to the market spot price (1_000_000 = spot). Positive. */
  readonly priceRatio: Ratio;
  /** Cases the buyer will take per day. A positive integer. */
  readonly dailyDemand: number;
}

export interface BuyerDefinition {
  readonly id: BuyerId;
  readonly name: string;
  readonly locationId: LocationId;
  /** The family reputation (0–100) the buyer needs before dealing (ADR 0016). */
  readonly minimumReputation: number;
  /** Cash the buyer can spend per day (GDD §7 buyer liquidity). Not negative. */
  readonly dailyBudget: Money;
  readonly wants: readonly BuyerWantDefinition[];
}

export const CROSSROADS_ROADHOUSE = asId("Buyer", "crossroads-roadhouse");
export const KESSLERS_BACK_ROOM = asId("Buyer", "kesslers-back-room");
export const LAKEVIEW_HOTEL = asId("Buyer", "lakeview-hotel");

export const BUYERS: readonly BuyerDefinition[] = [
  {
    id: CROSSROADS_ROADHOUSE,
    name: "The Crossroads Roadhouse", // PLACEHOLDER (story)
    locationId: CROSSROADS, // PLACEHOLDER (story)
    minimumReputation: 0, // PLACEHOLDER (tuning; T07a validates)
    dailyBudget: cents(15_000), // PLACEHOLDER (tuning; T07a validates)
    // wants[0] stays basic moonshine: the T02b locked test reads it.
    wants: [
      { productId: MOONSHINE, minimumQuality: "basic", priceRatio: ratio(1_000_000), dailyDemand: 12 }, // PLACEHOLDER (tuning; T07a validates)
    ],
  },
  {
    id: KESSLERS_BACK_ROOM,
    name: "Kessler's Back Room", // PLACEHOLDER (story)
    locationId: KESSLER_PHARMACY, // PLACEHOLDER (story)
    minimumReputation: 0, // PLACEHOLDER (tuning; T07a validates)
    dailyBudget: cents(25_000), // PLACEHOLDER (tuning; T07a validates)
    wants: [
      { productId: MOONSHINE, minimumQuality: "basic", priceRatio: ratio(1_050_000), dailyDemand: 12 }, // PLACEHOLDER (tuning; T07a validates)
      { productId: MOONSHINE, minimumQuality: "standard", priceRatio: ratio(1_100_000), dailyDemand: 6 }, // PLACEHOLDER (tuning; T07a validates)
    ],
  },
  {
    id: LAKEVIEW_HOTEL,
    name: "Lakeview Hotel", // PLACEHOLDER (story)
    locationId: LAKEVIEW, // PLACEHOLDER (story)
    minimumReputation: 10, // PLACEHOLDER (tuning; T07a validates)
    dailyBudget: cents(30_000), // PLACEHOLDER (tuning; T07a validates)
    wants: [
      { productId: MOONSHINE, minimumQuality: "standard", priceRatio: ratio(1_150_000), dailyDemand: 10 }, // PLACEHOLDER (tuning; T07a validates)
    ],
  },
];
