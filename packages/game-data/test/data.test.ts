import { isMoney, isValidId, isWorldPoint } from "@eov/contracts";
import { describe, expect, it } from "vitest";
import { FIRST_SHIPMENT_SCENARIO, GAME_DATA, parseScenario, ScenarioError } from "../src/index.ts";
import firstShipmentJson from "../src/scenarios/first-shipment.json" with { type: "json" };

const has = <T extends { readonly id: string }>(list: readonly T[], id: string): boolean => list.some((x) => x.id === id);

function expectUniqueIds(list: readonly { readonly id: string }[]): void {
  const seen = new Set(list.map((x) => x.id));
  expect(seen.size).toBe(list.length);
  for (const x of list) expect(isValidId(x.id)).toBe(true);
}

describe("game-data definitions", () => {
  it("has unique, valid IDs in every list", () => {
    const d = GAME_DATA;
    for (const list of [d.products, d.materials, d.equipment, d.recipes, d.characters, d.buyers, d.suppliers, d.routes, d.vehicles, d.locations, d.facilities]) {
      expectUniqueIds(list);
    }
  });

  it("only references definitions that exist", () => {
    const d = GAME_DATA;
    for (const r of d.recipes) {
      expect(has(d.products, r.productId)).toBe(true);
      for (const e of r.requiredEquipmentIds) expect(has(d.equipment, e)).toBe(true);
      for (const input of r.inputsPerCase) expect(has(d.materials, input.materialId)).toBe(true);
    }
    for (const m of d.markets) expect(has(d.products, m.productId)).toBe(true);
    for (const b of d.buyers) {
      expect(has(d.locations, b.locationId)).toBe(true);
      for (const w of b.wants) expect(has(d.products, w.productId)).toBe(true);
    }
    for (const s of d.suppliers) {
      expect(has(d.locations, s.locationId)).toBe(true);
      for (const st of s.stock) expect(has(d.materials, st.materialId)).toBe(true);
    }
    for (const r of d.routes) {
      expect(has(d.locations, r.fromLocationId)).toBe(true);
      expect(has(d.locations, r.toLocationId)).toBe(true);
      for (const p of r.waypoints) expect(isWorldPoint(p)).toBe(true);
    }
    for (const v of d.vehicles) expect(has(d.facilities, v.homeFacilityId)).toBe(true);
    for (const f of d.facilities) expect(has(d.locations, f.locationId)).toBe(true);
  });

  it("keeps money in integer cents and counts as positive integers", () => {
    const d = GAME_DATA;
    for (const p of d.products) for (const price of Object.values(p.basePrice)) expect(isMoney(price) && price > 0).toBe(true);
    for (const r of d.recipes) {
      expect(isMoney(r.laborPerCase) && isMoney(r.overheadPerCase)).toBe(true);
      expect(Number.isSafeInteger(r.ticksPerCase) && r.ticksPerCase > 0).toBe(true);
      for (const input of r.inputsPerCase) expect(Number.isSafeInteger(input.quantity) && input.quantity > 0).toBe(true);
    }
    for (const m of d.markets) expect(m.baselineDemand > 0 && m.baselineSupply > 0).toBe(true);
    for (const r of d.routes) expect(Number.isSafeInteger(r.durationTicks) && r.durationTicks > 0).toBe(true);
    for (const v of d.vehicles) expect(Number.isSafeInteger(v.capacityCases) && v.capacityCases > 0).toBe(true);
  });

  it("gives every route a name and every risky route a description (#77)", () => {
    const singleLine = (text: string | null): boolean => text !== null && text.trim().length > 0 && !/[\r\n]/.test(text);
    for (const r of GAME_DATA.routes) {
      expect(singleLine(r.name), `${r.id} name`).toBe(true);
      if (r.riskPpm > 0) expect(singleLine(r.description), `${r.id} description`).toBe(true);
    }
  });
});

describe("First Shipment scenario (S0 placeholder)", () => {
  it("supplies the start date and seed (closes T01's startDate gap)", () => {
    expect(FIRST_SHIPMENT_SCENARIO.startDate).toEqual({ year: 1920, month: 1, day: 17 });
    expect(FIRST_SHIPMENT_SCENARIO.seed).toBe(1920);
  });

  it("only references definitions that exist", () => {
    const s = FIRST_SHIPMENT_SCENARIO;
    const d = GAME_DATA;
    for (const f of s.facilities) {
      expect(has(d.facilities, f.id)).toBe(true);
      for (const e of f.equipmentIds) expect(has(d.equipment, e)).toBe(true);
    }
    for (const v of s.vehicleIds) expect(has(d.vehicles, v)).toBe(true);
    for (const sup of s.supplierIds) expect(has(d.suppliers, sup)).toBe(true);
    for (const b of s.buyerIds) expect(has(d.buyers, b)).toBe(true);
  });

  it("rejects malformed scenario files", () => {
    expect(() => parseScenario(null)).toThrow(ScenarioError);
    expect(() => parseScenario({ ...firstShipmentJson, seed: 1.5 })).toThrow(ScenarioError);
    expect(() => parseScenario({ ...firstShipmentJson, openingBalance: { cash: 10.5, buildings: 0 } })).toThrow(ScenarioError);
    expect(() => parseScenario({ ...firstShipmentJson, buyerIds: ["Not An Id"] })).toThrow(TypeError);
    expect(() => parseScenario({ ...firstShipmentJson, startDate: undefined })).toThrow(ScenarioError);
  });
});
