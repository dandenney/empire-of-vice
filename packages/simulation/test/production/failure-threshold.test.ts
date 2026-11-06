// The job failure threshold's boundary (ADR 0017 decision 5; a follow-up from
// #70's review, in scope for T02c2 #63). A job fails when its one draw,
// nextInt(rng.production, RATIO_SCALE), is below the recipe's failureChance:
// a chance equal to the draw completes, one above it fails.

import { RATIO_SCALE, ratio, ZERO_MONEY } from "@eov/contracts";
import { BASIC_MOONSHINE_RECIPE, DISTILLERY_MAIN, FIRST_SHIPMENT_SCENARIO, GAME_DATA, type GameData } from "@eov/game-data";
import { describe, expect, it } from "vitest";
import { createSimulation, newGame, nextInt, seedRng, simulationOptions, type GameSetup } from "../../src/index.ts";
import { addMaterial } from "../../src/inventory/index.ts";

const QUANTITY = 1;

function withFailureChance(chance: number): GameData {
  return { ...GAME_DATA, recipes: GAME_DATA.recipes.map((r) => (r.id === BASIC_MOONSHINE_RECIPE ? { ...r, failureChance: ratio(chance) } : r)) };
}

/** Runs one case of the basic recipe (materials given free) to its completion tick and returns the outcome's event type. */
function outcome(chance: number): string {
  const data = withFailureChance(chance);
  const setup: GameSetup = { scenario: FIRST_SHIPMENT_SCENARIO, data };
  const recipe = data.recipes.find((r) => r.id === BASIC_MOONSHINE_RECIPE)!;
  let state = newGame(setup).state;
  for (const input of recipe.inputsPerCase) state = addMaterial(state, DISTILLERY_MAIN, input.materialId, input.quantity * QUANTITY, ZERO_MONEY);
  // No draw has been taken yet: the job's draw is the stream's first.
  expect(state.rng.production).toEqual(seedRng(FIRST_SHIPMENT_SCENARIO.seed, "production"));
  const sim = createSimulation(state, simulationOptions(setup));
  const started = sim.dispatch({ command: { type: "START_PRODUCTION", facilityId: DISTILLERY_MAIN, recipeId: BASIC_MOONSHINE_RECIPE, quantity: QUANTITY } });
  expect(started.status).toBe("applied");
  sim.advance(sim.state.productionJobs[0]!.completesAt - sim.state.tick);
  expect(sim.state.productionJobs).toEqual([]);
  const settled = sim.state.eventJournal.filter((e) => e.type === "PRODUCTION_COMPLETED" || e.type === "PRODUCTION_FAILED");
  expect(settled).toHaveLength(1);
  return settled[0]!.type;
}

describe("PROD-001 failure threshold", () => {
  it("fails only when the draw is below failureChance: a chance equal to the draw completes, one more fails", () => {
    const v = nextInt(seedRng(FIRST_SHIPMENT_SCENARIO.seed, "production"), RATIO_SCALE).value;
    // A 0 draw would need a chance of 0, which draws nothing; the shipped seed doesn't give one.
    expect(v).toBeGreaterThan(0);
    expect(v + 1).toBeLessThanOrEqual(RATIO_SCALE);
    expect(outcome(v)).toBe("PRODUCTION_COMPLETED");
    expect(outcome(v + 1)).toBe("PRODUCTION_FAILED");
  });
});
