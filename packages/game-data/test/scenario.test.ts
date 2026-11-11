// SHAKEDOWN in scenario files (T07f, issue #129).
import { describe, expect, it } from "vitest";
import { FIRST_SHIPMENT_SCENARIO, parseScenario, ScenarioError, type ScenarioDefinition } from "../src/index.ts";
import firstShipmentJson from "../src/scenarios/first-shipment.json" with { type: "json" };

const shakedown = { kind: "SHAKEDOWN", tick: 7_920, reason: "RIVAL", netWorthSharePpm: 150_000 };
const withEvents = (...events: unknown[]) => ({ ...firstShipmentJson, scheduledEvents: [...firstShipmentJson.scheduledEvents, ...events] });

/** A parsed scenario as it would be written back to a file: plain JSON. */
const toJson = (s: ScenarioDefinition): unknown => JSON.parse(JSON.stringify(s));

describe("SHAKEDOWN scheduled events", () => {
  it("parses a shakedown next to the rival closure, in file order", () => {
    const s = parseScenario(withEvents(shakedown));
    expect(s.scheduledEvents).toEqual([
      { kind: "ROUTE_CLOSURE", tick: 12_000, routeId: "county-road", reason: "RIVAL", durationTicks: 1_440 },
      { kind: "SHAKEDOWN", tick: 7_920, reason: "RIVAL", netWorthSharePpm: 150_000 },
    ]);
  });

  it("round-trips: parse, write as JSON, parse again gives the same scenario", () => {
    const once = parseScenario(withEvents(shakedown, { ...shakedown, tick: 9_000, reason: "POLICE", netWorthSharePpm: 1_000_000 }));
    expect(parseScenario(toJson(once))).toEqual(once);
    expect(toJson(parseScenario(toJson(once)))).toEqual(toJson(once));
  });

  it("rejects a malformed shakedown", () => {
    expect(() => parseScenario(withEvents({ ...shakedown, reason: "WEATHER" }))).toThrow(ScenarioError);
    expect(() => parseScenario(withEvents({ ...shakedown, reason: undefined }))).toThrow(ScenarioError);
    expect(() => parseScenario(withEvents({ ...shakedown, netWorthSharePpm: undefined }))).toThrow(ScenarioError);
    expect(() => parseScenario(withEvents({ ...shakedown, netWorthSharePpm: 0.15 }))).toThrow(ScenarioError);
    expect(() => parseScenario(withEvents({ ...shakedown, netWorthSharePpm: "150000" }))).toThrow(ScenarioError);
    expect(() => parseScenario(withEvents({ ...shakedown, tick: -1 }))).toThrow(ScenarioError);
    expect(() => parseScenario(withEvents({ ...shakedown, tick: 1.5 }))).toThrow(ScenarioError);
    // The range (1..1 000 000 ppm) is checked at load, like the closure's duration.
    expect(parseScenario(withEvents({ ...shakedown, netWorthSharePpm: 0 })).scheduledEvents[1]).toMatchObject({ netWorthSharePpm: 0 });
  });

  it("isn't scheduled by the First Shipment", () => {
    expect(FIRST_SHIPMENT_SCENARIO.scheduledEvents.some((e) => e.kind === "SHAKEDOWN")).toBe(false);
  });
});
