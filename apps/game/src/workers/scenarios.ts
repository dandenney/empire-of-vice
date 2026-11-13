// The scenarios this build plays (SK2a, #174): the First Shipment (M001, world
// rules) and the First Hire (M002, founder rules; ADR 0023 decision 9). A new
// game names one; a save resumes in its own (`save.scenarioId`), because
// `loadGame` takes the rules and the pacing from the scenario it's given.
// Plain data from game-data, so the worker and the UI can both import it.

import { FIRST_SHIPMENT_SCENARIO, THE_FIRST_HIRE_SCENARIO, type ScenarioDefinition } from "@eov/game-data";

/** Every scenario a new game can start in or a save can resume in. The first is the default. */
export const PLAYABLE_SCENARIOS: readonly ScenarioDefinition[] = [FIRST_SHIPMENT_SCENARIO, THE_FIRST_HIRE_SCENARIO];

/** The scenario with this id, or null if this build doesn't play it. */
export function playableScenario(id: string): ScenarioDefinition | null {
  return PLAYABLE_SCENARIOS.find((s) => s.id === id) ?? null;
}
