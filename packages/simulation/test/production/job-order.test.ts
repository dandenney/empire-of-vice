// Settlement order across production jobs (ADR 0017 decision 1; the #70 review
// follow-up, done in T03 #10). Jobs due on the same tick settle in job ID order,
// and so do their rng.production draws. With one facility and one job per
// facility the shipped data can't have two jobs due together, so this uses a
// fixture GameData with a second production facility.
//
// The second facility's ID sorts after the main distillery's, and its job is
// started first (job-1). So job ID order differs from facility ID order, and a
// settlement that sorted by facility, or reversed the sort, would draw for the
// jobs the other way round and swap their outcomes.

import { asId, RATIO_SCALE, ratio, ZERO_MONEY, type FacilityId, type GameEvent } from "@eov/contracts";
import {
  BASIC_MOONSHINE_RECIPE,
  DISTILLERY_MAIN,
  FIRST_SHIPMENT_SCENARIO,
  GAME_DATA,
  HOLLOW_CREEK,
  type GameData,
  type ScenarioDefinition,
} from "@eov/game-data";
import { describe, expect, it } from "vitest";
import { createSimulation, newGame, nextInt, seedRng, simulationOptions, type GameSetup } from "../../src/index.ts";
import { addMaterial } from "../../src/inventory/index.ts";

const SECOND_DISTILLERY: FacilityId = asId("Facility", "distillery-second");

const mainProduction = GAME_DATA.facilityProduction.find((f) => f.facilityId === DISTILLERY_MAIN)!;
const mainScenarioFacility = FIRST_SHIPMENT_SCENARIO.facilities.find((f) => f.id === DISTILLERY_MAIN)!;

/** The shipped data plus a second distillery like the first, and the basic recipe at `failureChance`. */
function twoFacilityData(failureChance: number): GameData {
  return {
    ...GAME_DATA,
    facilities: [...GAME_DATA.facilities, { id: SECOND_DISTILLERY, name: "Second distillery", locationId: HOLLOW_CREEK }],
    facilityProduction: [...GAME_DATA.facilityProduction, { ...mainProduction, facilityId: SECOND_DISTILLERY }],
    recipes: GAME_DATA.recipes.map((r) => (r.id === BASIC_MOONSHINE_RECIPE ? { ...r, failureChance: ratio(failureChance) } : r)),
  };
}

const scenario: ScenarioDefinition = {
  ...FIRST_SHIPMENT_SCENARIO,
  facilities: [...FIRST_SHIPMENT_SCENARIO.facilities, { ...mainScenarioFacility, id: SECOND_DISTILLERY }],
};

const settledTypes = new Set(["PRODUCTION_COMPLETED", "PRODUCTION_FAILED"]);

/** Starts one case at the second distillery (job-1), then one at the main one (job-2), runs both to completion, and returns their settlement events. */
function settleBoth(failureChance: number): readonly GameEvent[] {
  const data = twoFacilityData(failureChance);
  const setup: GameSetup = { scenario, data };
  const recipe = data.recipes.find((r) => r.id === BASIC_MOONSHINE_RECIPE)!;
  let state = newGame(setup).state;
  for (const facilityId of [SECOND_DISTILLERY, DISTILLERY_MAIN]) {
    for (const input of recipe.inputsPerCase) state = addMaterial(state, facilityId, input.materialId, input.quantity, ZERO_MONEY);
  }
  const sim = createSimulation(state, simulationOptions(setup));
  for (const facilityId of [SECOND_DISTILLERY, DISTILLERY_MAIN]) {
    const result = sim.dispatch({ command: { type: "START_PRODUCTION", facilityId, recipeId: BASIC_MOONSHINE_RECIPE, quantity: 1 } });
    expect(result.status, facilityId).toBe("applied");
  }
  const jobs = sim.state.productionJobs;
  expect(jobs.map((j) => [j.id, j.facilityId])).toEqual([
    ["job-1", SECOND_DISTILLERY],
    ["job-2", DISTILLERY_MAIN],
  ]);
  // Both are due on the same tick.
  expect(jobs[0]!.completesAt).toBe(jobs[1]!.completesAt);
  sim.advance(jobs[0]!.completesAt - sim.state.tick);
  expect(sim.state.productionJobs).toEqual([]);
  return sim.state.eventJournal.filter((e) => settledTypes.has(e.type));
}

const jobIdOf = (e: GameEvent) => ("jobId" in e ? e.jobId : null);

describe("PROD-001 settlement order", () => {
  it("settles jobs due on the same tick in job ID order", () => {
    // failureChance 0 draws nothing, so this pins the order alone.
    expect(settleBoth(0).map(jobIdOf)).toEqual(["job-1", "job-2"]);
  });

  it("draws for them in job ID order: job-1 takes the stream's first draw, job-2 the second", () => {
    const first = nextInt(seedRng(FIRST_SHIPMENT_SCENARIO.seed, "production"), RATIO_SCALE);
    const second = nextInt(first.rng, RATIO_SCALE);
    expect(first.value).not.toBe(second.value);
    // A chance equal to the larger draw fails the job with the smaller draw and completes the other
    // (a job fails when its draw is below failureChance), so the outcomes show which job got which draw.
    const chance = Math.max(first.value, second.value);
    const [job1, job2] = first.value < second.value ? ["PRODUCTION_FAILED", "PRODUCTION_COMPLETED"] : ["PRODUCTION_COMPLETED", "PRODUCTION_FAILED"];
    expect(settleBoth(chance).map((e) => [jobIdOf(e), e.type])).toEqual([
      ["job-1", job1],
      ["job-2", job2],
    ]);
  });
});
