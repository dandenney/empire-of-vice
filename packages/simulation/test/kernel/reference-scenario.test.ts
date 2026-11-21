// The kernel's reference replay scenario. Its hash is quoted in PRs (factory.md
// §4) so later changes to the kernel or the hash algorithm are visible. If this
// pin changes, the PR must say why.
//
// Scenario: day0Save (seed 1920, tick 600 = 10:00 on January 17, 1920) with the
// fake systems in fakes.ts, this command script, then 10 game days.
//
// History: fnv1a64:e473f4f783ba20b5 (PR #23 initial) → fnv1a64:cfdf13437433feb0
// (review round 1: dispatch-time rejections no longer advance the command counters)
// → fnv1a64:0f3c258a09c81be8 (T01b, #25: the command log also holds queued commands
// rejected when their tick arrives, here the buyCorn(500) at tick 3000)
// → fnv1a64:9735a76874ff3340 (K1, #188: `GameState.knowledge`, which day0Save fills
// with two records, two activity items and a catch-up; nothing reads it yet)
// → fnv1a64:50e6c1bee8ce01c8 (P1, #193: `GameState.founder` and
// `VehicleState.parkedAt`, which day0Save now carries; the fake systems never
// read or write them)
// → fnv1a64:43ff79f6e9801b39 (O1a, #192: `heldDeals`, the `Deal` counter and
// `VehicleState.tripCount` in day0Save, and `issuer` on every command envelope;
// removing them gives 50e6c1bee8ce01c8 again)
// → fnv1a64:e8f7a70e236e492d (PH1, #205: `arrangements`, `phoneLine` on each facility,
// `founder.room`, `PRESENT.call` and `knowledge.pendingMessages` in day0Save, which also
// gains Miller's first dealing day and its ARRANGEMENT_GRANTED activity item; the fake
// systems never read or write any of them. Removing them gives 43ff79f6e9801b39 again)
// → fnv1a64:51b2d190ea8e303b (EM1, #210: `employees: []`, `formerEmployees: []` and the
// `StandingOrder` counter in day0Save; nothing hires. Removing them gives e8f7a70e236e492d again)
// → fnv1a64:1e781de9736a6ef4 (TS1, #243: `washes: []` in day0Save; nothing sets a mash.
// Removing it gives 51b2d190ea8e303b again).

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
    expect(runReferenceScenario().stateHash()).toMatchInlineSnapshot(`"fnv1a64:1e781de9736a6ef4"`);
  });

  it("replays from its command log to the same hash", () => {
    const original = runReferenceScenario();
    const replayed = fakeSimulation();
    for (const envelope of original.state.commandLog) replayed.replay(envelope);
    replayed.advance(original.state.tick - replayed.state.tick);
    expect(replayed.stateHash()).toBe(original.stateHash());
  });
});
