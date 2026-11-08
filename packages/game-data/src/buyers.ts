// ECO-001 buyers (T02d, issue #8, decision 1; GDD §14.4; ADR 0016). Definition types per ADR 0012.
//
// Three buyers with distinct roles: a cheap, cash-limited roadhouse (its budget
// binds before its demand), Kessler's with basic and standard wants, and
// Lakeview, the best standard price behind a reputation requirement. T05g (#106)
// set that requirement to tier 3's reputation (20): Lakeview is GDD §9's tier-3
// "improved buyer", and it offers its standard contract only once standard
// moonshine can be made.

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
  /** One line of in-world period flavor, shown in the Market panel. No mechanics or numbers. */
  readonly flavor: string;
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
    name: "The Crossroads Roadhouse",
    flavor: "Sawdust floors, a piano missing keys, and a proprietor who counts his cash twice before spending it.",
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
    name: "Kessler's Back Room",
    flavor: "Past the soda fountain and the cough syrup, Kessler fills \"prescriptions\" for anyone who knows to ask.",
    locationId: KESSLER_PHARMACY, // PLACEHOLDER (story)
    minimumReputation: 0, // PLACEHOLDER (tuning; T07a validates)
    dailyBudget: cents(45_000), // PLACEHOLDER (T05g tuned; T07 tunes next)
    wants: [
      { productId: MOONSHINE, minimumQuality: "basic", priceRatio: ratio(1_100_000), dailyDemand: 12 }, // PLACEHOLDER (T07d tuned ratio)
      { productId: MOONSHINE, minimumQuality: "standard", priceRatio: ratio(1_050_000), dailyDemand: 6 }, // PLACEHOLDER (T07d tuned ratio: standard quoted above basic on nearly every day)
    ],
  },
  {
    id: LAKEVIEW_HOTEL,
    name: "Lakeview Hotel",
    flavor: "Marble lobby, lake breeze, an orchestra in the ballroom; the bell captain deals only with names he knows.",
    locationId: LAKEVIEW, // PLACEHOLDER (story)
    minimumReputation: 20, // PLACEHOLDER (T05g tuned; T07 tunes next)
    dailyBudget: cents(60_000), // PLACEHOLDER (T05g tuned; T07 tunes next)
    wants: [
      { productId: MOONSHINE, minimumQuality: "standard", priceRatio: ratio(1_225_000), dailyDemand: 10 }, // PLACEHOLDER (T07d tuned ratio: the best standard quote)
    ],
  },
];
