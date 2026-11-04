// S0 stub: extended by T02d (ECO-001 suppliers and shortages). Definition types per ADR 0012.
// PLACEHOLDER values. T02d decides the real numbers.

import { asId, cents, type LocationId, type MaterialId, type Money, type SupplierId } from "@eov/contracts";
import { MILLERS_FEED_LOCATION } from "./map.ts";
import { CORN, SUGAR } from "./products.ts";

export interface SupplierStockDefinition {
  readonly materialId: MaterialId;
  /** Units available at the start of each day. Daily replenishment arrives with T02d. */
  readonly dailyStock: number;
  readonly unitPrice: Money;
}

export interface SupplierDefinition {
  readonly id: SupplierId;
  readonly name: string;
  readonly locationId: LocationId;
  readonly stock: readonly SupplierStockDefinition[];
}

export const MILLERS_FEED = asId("Supplier", "millers-feed");

export const SUPPLIERS: readonly SupplierDefinition[] = [
  {
    id: MILLERS_FEED,
    name: "Miller's Feed & Seed",
    locationId: MILLERS_FEED_LOCATION,
    stock: [
      { materialId: CORN, dailyStock: 160, unitPrice: cents(250) }, // PLACEHOLDER
      { materialId: SUGAR, dailyStock: 100, unitPrice: cents(200) }, // PLACEHOLDER
    ],
  },
];
