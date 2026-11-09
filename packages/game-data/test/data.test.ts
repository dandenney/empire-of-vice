import { isMoney, isValidId, isWorldPoint, RATIO_SCALE } from "@eov/contracts";
import { describe, expect, it } from "vitest";
import { FIRST_SHIPMENT_SCENARIO, GAME_DATA, GAME_DATA_VERSION, parseScenario, ScenarioError } from "../src/index.ts";
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

describe("First Shipment scenario", () => {
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
    for (const e of s.scheduledEvents) if (e.kind === "ROUTE_CLOSURE") expect(has(d.routes, e.routeId)).toBe(true);
    expect(has(d.families, s.family.id)).toBe(true);
    expect(has(d.progression.tiers, s.family.tierId)).toBe(true);
  });

  it("parses the rival closure (ADR 0020 decision 12)", () => {
    expect(FIRST_SHIPMENT_SCENARIO.scheduledEvents).toEqual([
      { kind: "ROUTE_CLOSURE", tick: 12_000, routeId: "county-road", reason: "RIVAL", durationTicks: 1_440 },
    ]);
  });

  it("rejects malformed scenario files", () => {
    expect(() => parseScenario(null)).toThrow(ScenarioError);
    expect(() => parseScenario({ ...firstShipmentJson, seed: 1.5 })).toThrow(ScenarioError);
    expect(() => parseScenario({ ...firstShipmentJson, openingBalance: { cash: 10.5, buildings: 0 } })).toThrow(ScenarioError);
    expect(() => parseScenario({ ...firstShipmentJson, buyerIds: ["Not An Id"] })).toThrow(TypeError);
    expect(() => parseScenario({ ...firstShipmentJson, startDate: undefined })).toThrow(ScenarioError);
  });

  it("rejects malformed scheduledEvents", () => {
    const closure = firstShipmentJson.scheduledEvents[0]!;
    const withEvent = (event: unknown) => ({ ...firstShipmentJson, scheduledEvents: [event] });
    expect(() => parseScenario({ ...firstShipmentJson, scheduledEvents: undefined })).toThrow(ScenarioError);
    expect(() => parseScenario({ ...firstShipmentJson, scheduledEvents: {} })).toThrow(ScenarioError);
    expect(() => parseScenario(withEvent(null))).toThrow(ScenarioError);
    // No open-ended closures: the duration is required and never null.
    expect(() => parseScenario(withEvent({ ...closure, durationTicks: null }))).toThrow(ScenarioError);
    expect(() => parseScenario(withEvent({ ...closure, durationTicks: undefined }))).toThrow(ScenarioError);
    expect(() => parseScenario(withEvent({ ...closure, durationTicks: 1.5 }))).toThrow(ScenarioError);
    // Only ROUTE_CLOSURE; contract offers come from the contracts system (ADR 0018).
    expect(() => parseScenario(withEvent({ ...closure, kind: "CONTRACT_OFFER" }))).toThrow(ScenarioError);
    expect(() => parseScenario(withEvent({ ...closure, kind: "ROUTE_REOPENING" }))).toThrow(ScenarioError);
    expect(() => parseScenario(withEvent({ ...closure, kind: "SOMETHING_ELSE" }))).toThrow(ScenarioError);
    expect(() => parseScenario(withEvent({ ...closure, reason: "WEATHER" }))).toThrow(ScenarioError);
    expect(() => parseScenario(withEvent({ ...closure, tick: -1 }))).toThrow(ScenarioError);
    expect(() => parseScenario(withEvent({ ...closure, tick: "12000" }))).toThrow(ScenarioError);
    expect(() => parseScenario(withEvent({ ...closure, routeId: "Not A Route" }))).toThrow(TypeError);
    // Ranges against tick 1 and a 1-tick duration, and route existence, are checked at load (simulation's createInitialState).
    expect(parseScenario(withEvent({ ...closure, durationTicks: 0 })).scheduledEvents[0]).toMatchObject({ durationTicks: 0 });
  });
});

describe("progression (ADR 0020 decisions 3, 5, 7, 9, 17)", () => {
  const p = GAME_DATA.progression;

  it("has the four GDD tiers, in order, with #99's display names and decision 3's unlocks", () => {
    expect(p.tiers.map((t) => [t.id, t.name, t.netWorthRequired, t.reputationRequired, t.unlocks])).toEqual([
      ["starting-operation", "Starting Operation", null, null, ["spot-sales"]],
      ["trusted-supplier", "Trusted Supplier", 150_000, 10, ["capacity-equipment"]],
      ["established-producer", "Established Producer", 250_000, 20, ["quality-equipment"]],
      ["regional-distributor", "Regional Distributor", 500_000, 30, ["next-region"]],
    ]);
  });

  it("has unique, valid tier IDs, a threshold-free first tier, and non-decreasing thresholds", () => {
    expectUniqueIds(p.tiers);
    expect(p.tiers[0]!.netWorthRequired).toBeNull();
    expect(p.tiers[0]!.reputationRequired).toBeNull();
    for (let i = 1; i < p.tiers.length; i++) {
      const [prev, tier] = [p.tiers[i - 1]!, p.tiers[i]!];
      expect(isMoney(tier.netWorthRequired) && tier.netWorthRequired > 0, tier.id).toBe(true);
      expect(Number.isSafeInteger(tier.reputationRequired) && tier.reputationRequired! >= 0 && tier.reputationRequired! <= 100, tier.id).toBe(true);
      expect(tier.netWorthRequired!, tier.id).toBeGreaterThanOrEqual(prev.netWorthRequired ?? 0);
      expect(tier.reputationRequired!, tier.id).toBeGreaterThanOrEqual(prev.reputationRequired ?? 0);
    }
  });

  it("grants every unlock from exactly one tier, each a valid ID", () => {
    const granted = p.tiers.flatMap((t) => t.unlocks);
    expect(new Set(granted).size).toBe(granted.length);
    for (const u of granted) expect(isValidId(u)).toBe(true);
  });

  it("has decision 5's reputation rules, signed", () => {
    expect(p.reputation).toEqual({
      firstQualifyingDelivery: 2,
      qualifyingDeliveryMinimumCases: 5,
      installmentFulfilled: 7,
      consecutiveInstallmentBonus: 4,
      installmentPartial: -3,
      installmentMissed: -8,
    });
    for (const n of Object.values(p.reputation)) expect(Number.isSafeInteger(n)).toBe(true);
  });

  it("has decision 7's victory targets: $5,000, reputation 30, one completed contract", () => {
    expect(p.victory).toEqual({ netWorth: 500_000, reputation: 30, completedContracts: 1 });
    expect(isMoney(p.victory.netWorth)).toBe(true);
  });

  it("has a resale ratio of 500 000 ppm, inside (0, 1 000 000)", () => {
    expect(p.recovery.equipmentResaleRatio).toBe(500_000);
    expect(p.recovery.equipmentResaleRatio > 0 && p.recovery.equipmentResaleRatio < RATIO_SCALE).toBe(true);
  });
});

describe("families (ADR 0020 decision 12)", () => {
  it("names the Kerrigans (#99, final)", () => {
    expectUniqueIds(GAME_DATA.families);
    expect(GAME_DATA.families).toEqual([{ id: "kerrigan", name: "The Kerrigans" }]);
  });
});

describe("the warehouse (T03b, #76)", () => {
  it("lists the distillery and a storage-only warehouse, which the First Shipment scenario doesn't own", () => {
    expect(GAME_DATA.facilities.map((f) => f.id)).toEqual(["distillery-main", "riverside-warehouse"]);
    // Each facility declares its kind; the snapshot reads it rather than inferring it from equipment (T05i, #148).
    expect(GAME_DATA.facilities.map((f) => [f.id, f.kind])).toEqual([
      ["distillery-main", "DISTILLERY"],
      ["riverside-warehouse", "WAREHOUSE"],
    ]);
    expect(GAME_DATA.locations.map((l) => l.id)).toContain("riverside-depot");
    expect(GAME_DATA.facilityProduction.find((f) => f.facilityId === "riverside-warehouse")).toMatchObject({ equipmentSlots: 0, maximumWorkers: 0 });
    expect(FIRST_SHIPMENT_SCENARIO.facilities.map((f) => f.id)).toEqual(["distillery-main"]);
  });

  it("lists a safe route each way between the distillery and the warehouse", () => {
    const between = GAME_DATA.routes.filter((r) => [r.fromLocationId, r.toLocationId].includes("riverside-depot" as never));
    expect(between.map((r) => [r.id, r.fromLocationId, r.toLocationId, r.riskPpm])).toEqual([
      ["depot-road", "hollow-creek", "riverside-depot", 0],
      ["depot-road-return", "riverside-depot", "hollow-creek", 0],
    ]);
  });
});

describe("GAME_DATA_VERSION", () => {
  it("is bumped for T05i and recorded in GAME_DATA", () => {
    expect(GAME_DATA_VERSION).toBe("0.6.1-t05i-facility-kind");
    expect(GAME_DATA.version).toBe(GAME_DATA_VERSION);
  });
});
