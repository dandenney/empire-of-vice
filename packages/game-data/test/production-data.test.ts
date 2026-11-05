// PROD-001 production data (T02c1, issue #7; ADR 0017). The numbers are
// placeholders; these tests pin shape and the relations the simulation relies on.

import { compareIds, isMoney, RATIO_SCALE, TICKS_PER_DAY } from "@eov/contracts";
import { describe, expect, it } from "vitest";
import { BASIC_MOONSHINE_RECIPE, COPPER_STILL, GAME_DATA, MOONSHINE } from "../src/index.ts";

const d = GAME_DATA;
const safeNonNegative = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;

describe("PROD-001 production data", () => {
  it("references equipment that exists from every recipe, and has a spec for every facility", () => {
    for (const r of d.recipes) {
      expect(r.requiredEquipmentIds.length, r.id).toBeGreaterThan(0);
      for (const id of r.requiredEquipmentIds) expect(d.equipment.some((e) => e.id === id), `${r.id} needs ${id}`).toBe(true);
    }
    expect(d.facilityProduction.map((f) => f.facilityId).sort(compareIds)).toEqual(d.facilities.map((f) => f.id).sort(compareIds));
    expect(new Set(d.facilityProduction.map((f) => f.facilityId)).size).toBe(d.facilityProduction.length);
  });

  it("makes exactly basic and standard moonshine producible", () => {
    const producible = d.recipes.map((r) => `${r.productId}/${r.quality}`).sort();
    expect(producible).toEqual([`${MOONSHINE}/basic`, `${MOONSHINE}/standard`]);
  });

  it("has the full 3 × 3 product matrix", () => {
    expect(d.products).toHaveLength(3);
    for (const p of d.products) for (const q of ["basic", "standard", "premium"] as const) expect(isMoney(p.basePrice[q]) && p.basePrice[q] > 0).toBe(true);
  });

  it("runs the basic recipe on the copper still at 10 cases a day (the S0 still's rate)", () => {
    const basic = d.recipes.find((r) => r.id === BASIC_MOONSHINE_RECIPE)!;
    expect(basic.requiredEquipmentIds).toEqual([COPPER_STILL]);
    expect(TICKS_PER_DAY % basic.ticksPerCase).toBe(0);
    expect(TICKS_PER_DAY / basic.ticksPerCase).toBe(10);
  });

  it("keeps ratios in [0, RATIO_SCALE] and counts as non-negative safe integers", () => {
    for (const r of d.recipes) {
      expect(Number.isSafeInteger(r.failureChance) && r.failureChance >= 0 && r.failureChance <= RATIO_SCALE, r.id).toBe(true);
    }
    for (const e of d.equipment) {
      expect(isMoney(e.price) && e.price >= 0, e.id).toBe(true);
      expect(safeNonNegative(e.throughputBonus) && e.throughputBonus <= RATIO_SCALE, e.id).toBe(true);
      expect(safeNonNegative(e.storageBonus), e.id).toBe(true);
      if (e.requiredUnlockId !== null) expect(typeof e.requiredUnlockId).toBe("string");
    }
    for (const f of d.facilityProduction) {
      expect(safeNonNegative(f.equipmentSlots), f.facilityId).toBe(true);
      expect(safeNonNegative(f.baseStorage), f.facilityId).toBe(true);
    }
  });
});
