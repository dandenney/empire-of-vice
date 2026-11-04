// The system registry and the snapshot hook.

import { startOfGameSnapshot } from "@eov/contracts/fixtures";
import { describe, expect, it } from "vitest";
import { createRegistry, createSimulation, RegistryError } from "../../src/index.ts";
import { day0State, fakeSimulation, GAME_DATA_VERSION, START_DATE } from "./fakes.ts";

describe("system registry", () => {
  it("rejects duplicate registrations", () => {
    const registry = createRegistry();
    registry.onPhase("production", "a", (s) => s);
    expect(() => registry.onPhase("vehicles", "a", (s) => s)).toThrow(RegistryError);
    registry.onCommand("SET_WORKFORCE", { apply: (state) => ({ status: "applied", state }) });
    expect(() => registry.onCommand("SET_WORKFORCE", { apply: (state) => ({ status: "applied", state }) })).toThrow(RegistryError);
    registry.onWorldEvent("ROUTE_REOPENING", (s) => s);
    expect(() => registry.onWorldEvent("ROUTE_REOPENING", (s) => s)).toThrow(RegistryError);
  });

  it("is sealed once a simulation is created", () => {
    const registry = createRegistry();
    createSimulation(day0State, { registry, startDate: START_DATE, gameDataVersion: GAME_DATA_VERSION });
    expect(() => registry.onPhase("production", "late", (s) => s)).toThrow(RegistryError);
  });
});

describe("snapshot()", () => {
  it("delegates to the registered projection with the current clock", () => {
    const sim = fakeSimulation(day0State, (r) => r.setProjection((_state, ctx) => ({ ...startOfGameSnapshot, clock: ctx.clock })));
    sim.advance(1_440 * 43 + 1_440 - 600); // to 00:00 on day 44
    expect(sim.snapshot().clock).toEqual({
      tick: 1_440 * 44,
      dayIndex: 44,
      date: { year: 1920, month: 3, day: 1, hour: 0, minute: 0 },
    });
  });

  it("throws without a projection (S0 provides the real one)", () => {
    expect(() => fakeSimulation().snapshot()).toThrow(RegistryError);
  });
});

describe("environment", () => {
  it("runs in plain Node with no DOM", () => {
    expect("window" in globalThis).toBe(false);
    expect("document" in globalThis).toBe(false);
    const sim = fakeSimulation();
    sim.advance(1_440);
    expect(sim.state.tick).toBe(2_040);
  });
});
