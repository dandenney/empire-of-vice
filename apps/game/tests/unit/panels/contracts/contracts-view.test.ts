// The Contracts panel's view helpers (#128): the penalty rate from ppm, the buyer's map location, which qualities a
// delivery can carry, and every reserved quantity with who holds it.

import { asId, cents, type GameSnapshot, type InventoryPoolSnapshot } from "@eov/contracts";
import { midGameSnapshot } from "@eov/contracts/fixtures";
import { describe, expect, it } from "vitest";
import { formatQuality } from "../../../../src/components/format.ts";
import { buyerLocationId, deliveryQualities, formatPpmPercent, reservedLines } from "../../../../src/panels/contracts/contracts-view.ts";

const moonshine = asId("Product", "moonshine");
const pool = (quality: InventoryPoolSnapshot["quality"], quantity: number): InventoryPoolSnapshot => ({
  productId: moonshine,
  productName: "Moonshine",
  quality,
  quantity,
  reservedQuantity: 0,
  totalCost: cents(quantity * 1_000),
  averageUnitCost: cents(1_000),
});

describe("rates", () => {
  it("shows a ppm rate as a percent", () => {
    expect(formatPpmPercent(200_000)).toBe("20%");
    expect(formatPpmPercent(125_000)).toBe("12.5%");
  });
});

describe("buyerLocationId", () => {
  it("finds the buyer's location on the snapshot's map, or null", () => {
    const contract = midGameSnapshot.contracts.active[0]!;
    const location = midGameSnapshot.locations.find((l) => l.occupant.kind === "BUYER" && l.occupant.buyerId === contract.buyerId)!;
    expect(buyerLocationId(midGameSnapshot, contract.buyerId)).toBe(location.id);
    expect(buyerLocationId(midGameSnapshot, asId("Buyer", "nobody"))).toBeNull();
  });
});

describe("deliveryQualities", () => {
  it("offers every pool of the product at or above the contract's minimum, never below", () => {
    const pools = [pool("basic", 4), pool("standard", 6), { ...pool("premium", 1), productId: asId("Product", "gin") }];
    expect(deliveryQualities(pools, { productId: moonshine, minimumQuality: "basic" }).map((q) => q.quality)).toEqual(["basic", "standard"]);
    expect(deliveryQualities(pools, { productId: moonshine, minimumQuality: "standard" }).map((q) => q.quality)).toEqual(["standard"]);
    expect(deliveryQualities(pools, { productId: moonshine, minimumQuality: "standard" })[0]!.pool).toEqual(pools[1]);
  });

  it("offers the minimum with no pool when nothing qualifies, so a dispatch shows the typed reason", () => {
    expect(deliveryQualities([pool("basic", 4)], { productId: moonshine, minimumQuality: "premium" })).toEqual([{ quality: "premium", pool: null }]);
  });
});

describe("reservedLines", () => {
  it("lists reserved finished goods (contract-held) and materials (held by running production)", () => {
    const lines = reservedLines(midGameSnapshot, formatQuality);
    const distillery = midGameSnapshot.facilities[0]!;
    const product = distillery.products[0]!;
    expect(lines.filter((l) => l.holder === "CONTRACT").map((l) => l.line)).toEqual([`Moonshine (basic): ${product.reservedQuantity} of ${product.quantity} cases reserved`]);
    expect(lines.filter((l) => l.holder === "PRODUCTION").map((l) => l.line)).toEqual(
      distillery.materials.filter((m) => m.reservedQuantity > 0).map((m) => `${m.materialName}: ${m.reservedQuantity} of ${m.quantity} held by running production`),
    );
    expect(lines.every((l) => l.facilityName === distillery.name)).toBe(true);
  });

  it("is empty when nothing is reserved", () => {
    const none: GameSnapshot = {
      ...midGameSnapshot,
      facilities: midGameSnapshot.facilities.map((f) => ({
        ...f,
        products: f.products.map((p) => ({ ...p, reservedQuantity: 0 })),
        materials: f.materials.map((m) => ({ ...m, reservedQuantity: 0 })),
      })),
    };
    expect(reservedLines(none, formatQuality)).toEqual([]);
  });
});
