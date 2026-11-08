// The Market panel's view helpers (#50): flavor and shortage names from
// game-data, the shortages behind a spot price, repeat offers from the
// snapshot's recent events, and QUOTE_CHANGED / BUYER_WILL_TAKE_LESS with their
// numbers, and the sale form's quality list (#128: nothing below the want's
// minimum).

import { asId, cents, tick, type GameEvent, type GameSnapshot, type InventoryPoolSnapshot, type QualityTier } from "@eov/contracts";
import { midGameSnapshot } from "@eov/contracts/fixtures";
import { BUYERS, SUPPLIERS } from "@eov/game-data";
import { describe, expect, it } from "vitest";
import { buyerFlavor, describeMarketOutcome, formatRatio, repeatOffers, saleQualities, shortageName, shortagesMoving, supplierFlavor } from "../../../../src/panels/market/market-view.ts";

const miller = SUPPLIERS[0]!;
const corn = miller.stock.find((l) => l.shortage !== null)!;

describe("game-data flavor", () => {
  it("reads supplier and buyer flavor lines by id", () => {
    expect(supplierFlavor(miller.id)).toBe(miller.flavor);
    expect(buyerFlavor(BUYERS[0]!.id)).toBe(BUYERS[0]!.flavor);
    expect(supplierFlavor(asId("Supplier", "nobody"))).toBeNull();
  });

  it("names a stock line's shortage, or null when it has none", () => {
    expect(shortageName(miller.id, corn.materialId)).toBe(corn.shortage!.name);
    expect(shortageName(miller.id, asId("Material", "nothing"))).toBeNull();
  });
});

describe("shortagesMoving", () => {
  const withCornShortage = (shortage: boolean): GameSnapshot => ({
    ...midGameSnapshot,
    market: {
      ...midGameSnapshot.market,
      suppliers: [{ ...midGameSnapshot.market.suppliers[0]!, id: miller.id, materials: [{ materialId: corn.materialId, materialName: "Corn", unitPrice: cents(375), available: 64, shortage }] }],
    },
  });

  it("names the shortage behind a market's event multiplier", () => {
    const effect = corn.shortage!.marketEffects[0]!;
    expect(shortagesMoving(withCornShortage(true), effect.productId, effect.quality)).toEqual([corn.shortage!.name]);
  });

  it("names nothing when no shortage is on", () => {
    const effect = corn.shortage!.marketEffects[0]!;
    expect(shortagesMoving(withCornShortage(false), effect.productId, effect.quality)).toEqual([]);
  });
});

describe("formatRatio", () => {
  it("shows a ppm multiplier to two places", () => {
    expect(formatRatio(1_000_000)).toBe("1.00");
    expect(formatRatio(1_050_000)).toBe("1.05");
    expect(formatRatio(950_000)).toBe("0.95");
  });
});

describe("repeatOffers", () => {
  const purchase = (id: string, causedBy: string | null, quantity: number): GameEvent => ({
    id: asId("Event", id),
    tick: tick(100),
    causedBy: causedBy === null ? null : asId("Command", causedBy),
    type: "MATERIALS_PURCHASED",
    supplierId: midGameSnapshot.market.suppliers[0]!.id,
    materialId: midGameSnapshot.market.suppliers[0]!.materials[0]!.materialId,
    quantity,
    unitPrice: cents(250),
    total: cents(250 * quantity),
    facilityId: midGameSnapshot.facilities[0]!.id,
    transactionId: asId("Transaction", `txn-${id}`),
  });
  const withEvents = (events: readonly GameEvent[]): GameSnapshot => ({ ...midGameSnapshot, recentEvents: events });

  it("offers the last purchase and the last sale dispatch by their causedBy", () => {
    const offers = repeatOffers(withEvents([purchase("e1", "cmd-1", 4), purchase("e2", "cmd-2", 6), ...midGameSnapshot.recentEvents]));
    expect(offers.purchase).toEqual({ sourceCommandId: "cmd-2", line: "6 × Corn from Miller's Feed & Seed" });
    expect(offers.sale?.sourceCommandId).toBe("cmd-10");
    expect(offers.sale?.line).toMatch(/^8 × Moonshine \(basic\) to Kessler/);
  });

  it("offers nothing without player commands", () => {
    expect(repeatOffers(withEvents([purchase("e1", null, 4)]))).toEqual({ purchase: null, sale: null });
  });
});

describe("describeMarketOutcome", () => {
  const rejected = (reason: object) => describeMarketOutcome({ kind: "result", result: { status: "rejected", reason } as never });

  it("spells out QUOTE_CHANGED with both prices", () => {
    const text = rejected({ code: "QUOTE_CHANGED", buyerId: "b", agreed: cents(1_400), current: cents(1_330) });
    expect(text).toContain("$14.00");
    expect(text).toContain("$13.30");
    expect(text).toContain("QUOTE_CHANGED");
  });

  it("spells out BUYER_WILL_TAKE_LESS with both counts", () => {
    const text = rejected({ code: "BUYER_WILL_TAKE_LESS", buyerId: "b", requested: 12, acceptable: 9 });
    expect(text).toContain("12");
    expect(text).toContain("9");
    expect(text).toContain("BUYER_WILL_TAKE_LESS");
  });

  it("shows any other rejection with its typed reason", () => {
    expect(rejected({ code: "NOT_REPEATABLE", sourceCommandId: "cmd-1" })).toContain("NOT_REPEATABLE");
  });
});

describe("saleQualities", () => {
  const moonshine = asId("Product", "moonshine");
  const pool = (quality: QualityTier, quantity: number): InventoryPoolSnapshot => ({
    productId: moonshine,
    productName: "Moonshine",
    quality,
    quantity,
    reservedQuantity: 0,
    totalCost: cents(quantity * 1_000),
    averageUnitCost: cents(1_000),
  });
  const qualities = (pools: readonly InventoryPoolSnapshot[], minimumQuality: QualityTier) => saleQualities(pools, { productId: moonshine, minimumQuality }).map((q) => q.quality);

  it("offers nothing below the want's minimum quality", () => {
    expect(qualities([pool("basic", 3)], "standard")).toEqual(["standard"]);
    expect(saleQualities([pool("basic", 3)], { productId: moonshine, minimumQuality: "standard" })[0]!.pool).toBeNull();
  });

  it("puts the want's own quality first, in stock or not, then every higher quality in stock", () => {
    expect(qualities([pool("standard", 2)], "basic")).toEqual(["basic", "standard"]);
    expect(qualities([pool("basic", 1), pool("premium", 2)], "basic")).toEqual(["basic", "premium"]);
    expect(qualities([pool("premium", 2)], "standard")).toEqual(["standard", "premium"]);
  });

  it("ignores other products' pools", () => {
    expect(qualities([{ ...pool("premium", 2), productId: asId("Product", "gin") }], "basic")).toEqual(["basic"]);
  });
});
