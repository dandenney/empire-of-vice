// The kernel's reference replay scenario. Its hash is quoted in PRs (factory.md
// §4) so later changes to the kernel or the hash algorithm are visible. If this
// pin changes, the PR must say why.
//
// Scenario: day0Save (seed 1920, tick 600 = 10:00 on January 17, 1920) with the
// fake systems in fakes.ts, this command script, then 10 game days.

import { tick } from "@eov/contracts";
import { ids } from "@eov/contracts/fixtures";
import { describe, expect, it } from "vitest";
import type { KernelSimulation } from "../../src/index.ts";
import { buyCorn, fakeSimulation, setWorkforce, unknownFacility } from "./fakes.ts";

function runReferenceScenario(): KernelSimulation {
  const sim = fakeSimulation();
  sim.dispatch({ command: setWorkforce(ids.distillery, 5) }); // immediate, applies at 601
  sim.dispatch({ command: buyCorn(30), scheduledTick: tick(900) });
  sim.dispatch({ command: setWorkforce(ids.barn, 2), scheduledTick: tick(1_440) }); // at midnight
  sim.dispatch({ command: buyCorn(500), scheduledTick: tick(3_000) }); // fails when it applies
  sim.dispatch({ command: setWorkforce(unknownFacility, 1) }); // rejected now
  sim.advance(1_440 * 3);
  sim.dispatch({ command: buyCorn(20) });
  sim.advance(1_440 * 7);
  return sim;
}

describe("reference scenario", () => {
  it("exercises commands, world events, RNG streams, and midnight", () => {
    const sim = runReferenceScenario();
    const types = new Set(sim.state.eventJournal.map((e) => e.type));
    expect(sim.state.tick).toBe(600 + 14_400);
    for (const type of ["WORKFORCE_CHANGED", "MATERIALS_PURCHASED", "COMMAND_REJECTED", "MARKET_UPDATED", "SHORTAGE_STARTED", "SHORTAGE_ENDED"]) {
      expect(types).toContain(type);
    }
  });

  it("has a pinned state hash", () => {
    expect(runReferenceScenario().stateHash()).toMatchInlineSnapshot(`"fnv1a64:e473f4f783ba20b5"`);
  });
});
