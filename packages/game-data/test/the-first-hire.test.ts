// The M002 scenario file parses (SK1d, issue #173). Its values are PLACEHOLDER
// for R1 (#176); the walking skeleton (packages/simulation/test/walking-skeleton)
// checks it plays.
import { describe, expect, it } from "vitest";
import { FIRST_SHIPMENT_SCENARIO, HOLLOW_CREEK, parseScenario, THE_FIRST_HIRE_SCENARIO, type ScenarioDefinition } from "../src/index.ts";
import theFirstHireJson from "../src/scenarios/the-first-hire.json" with { type: "json" };

/** A parsed scenario as it would be written back to a file: plain JSON. */
const toJson = (s: ScenarioDefinition): unknown => JSON.parse(JSON.stringify(s));

describe("THE_FIRST_HIRE_SCENARIO", () => {
  it("is the parsed the-first-hire.json, and round-trips as JSON", () => {
    expect(THE_FIRST_HIRE_SCENARIO).toEqual(parseScenario(theFirstHireJson));
    expect(toJson(THE_FIRST_HIRE_SCENARIO)).toEqual(theFirstHireJson);
  });

  it("is a separate scenario with founder rules on, slower pacing, starting at Hollow Creek", () => {
    expect(THE_FIRST_HIRE_SCENARIO.id).toBe("the-first-hire");
    expect(THE_FIRST_HIRE_SCENARIO.id).not.toBe(FIRST_SHIPMENT_SCENARIO.id);
    expect(THE_FIRST_HIRE_SCENARIO.founderRules).toBe(true);
    expect(THE_FIRST_HIRE_SCENARIO.realMsPerGameHourAt1x).toBe(20_000);
    expect(THE_FIRST_HIRE_SCENARIO.founderStartLocationId).toBe(HOLLOW_CREEK);
    expect(THE_FIRST_HIRE_SCENARIO.notes).toContain("PLACEHOLDER");
  });

  it("leaves the First Shipment as it was", () => {
    expect(FIRST_SHIPMENT_SCENARIO.id).toBe("first-shipment");
    expect(FIRST_SHIPMENT_SCENARIO.founderRules).toBe(false);
    expect(FIRST_SHIPMENT_SCENARIO.realMsPerGameHourAt1x).toBe(5_000);
  });
});
