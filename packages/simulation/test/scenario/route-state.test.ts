// Route state only for routes whose two ends the scenario occupies (T03b, #76 option 1).

import { tick } from "@eov/contracts";
import { DEPOT_ROAD, DEPOT_ROAD_RETURN, FIRST_SHIPMENT_SCENARIO, GAME_DATA, RIVERSIDE_WAREHOUSE, type ScenarioDefinition } from "@eov/game-data";
import { describe, expect, it } from "vitest";
import { createInitialState, ScenarioSetupError } from "../../src/index.ts";

const closure = FIRST_SHIPMENT_SCENARIO.scheduledEvents[0]!;

const ownsWarehouse: ScenarioDefinition = {
  ...FIRST_SHIPMENT_SCENARIO,
  facilities: [...FIRST_SHIPMENT_SCENARIO.facilities, { id: RIVERSIDE_WAREHOUSE, equipmentIds: [], workerCount: 0 }],
};

describe("route state at scenario load", () => {
  it("has no state for the depot routes when the scenario doesn't own the warehouse", () => {
    const ids = createInitialState(FIRST_SHIPMENT_SCENARIO, GAME_DATA).routes.map((r) => r.id);
    expect(ids).not.toContain(DEPOT_ROAD);
    expect(ids).not.toContain(DEPOT_ROAD_RETURN);
    expect(ids).toHaveLength(GAME_DATA.routes.length - 2);
  });

  it("has state for every route when the scenario also owns the warehouse", () => {
    const ids = createInitialState(ownsWarehouse, GAME_DATA).routes.map((r) => r.id);
    expect(ids).toHaveLength(GAME_DATA.routes.length);
    expect(ids).toContain(DEPOT_ROAD);
  });

  it("throws ScenarioSetupError for a closure on a route with an end the scenario doesn't occupy", () => {
    const scenario: ScenarioDefinition = { ...FIRST_SHIPMENT_SCENARIO, scheduledEvents: [{ ...closure, routeId: DEPOT_ROAD, tick: tick(100) }] };
    expect(() => createInitialState(scenario, GAME_DATA)).toThrow(ScenarioSetupError);
    expect(() => createInitialState({ ...scenario, facilities: ownsWarehouse.facilities }, GAME_DATA)).not.toThrow();
  });
});
