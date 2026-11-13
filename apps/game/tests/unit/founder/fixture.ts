// Player snapshots for the founder-rules view-model tests (SK2b, #234): the
// SK1d walking-skeleton path (packages/simulation/test/walking-skeleton),
// played headlessly on The First Hire, stopped at named points.

import { type CommandRequest, type LocationId, type PlayerSnapshot } from "@eov/contracts";
import { BASIC_MOONSHINE_RECIPE, RECIPES, START_WAKE_TICK, THE_FIRST_HIRE_SCENARIO } from "@eov/game-data";
import { newGame } from "@eov/simulation";

export const HOME = THE_FIRST_HIRE_SCENARIO.founderStartLocationId;
export const FEED_STORE = "millers-feed" as LocationId;
export const CROSSROADS = "crossroads" as LocationId;
export const RECIPE = RECIPES.find((r) => r.id === BASIC_MOONSHINE_RECIPE)!;

export type Sim = ReturnType<typeof newGame>;

export function freshGame(): Sim {
  return newGame({ scenario: THE_FIRST_HIRE_SCENARIO });
}

export function send(sim: Sim, command: CommandRequest["command"]): void {
  const result = sim.dispatch({ command });
  if (result.status !== "applied") throw new Error(`${command.type}: ${JSON.stringify(result)}`);
}

/** Advances until the founder is PRESENT and free (or `limit` ticks). */
export function untilFree(sim: Sim, limit = 3_000): void {
  for (let i = 0; i < limit; i++) {
    const w = sim.state.founder.whereabouts;
    if (w.kind === "PRESENT" && w.busy === null) return;
    sim.advance(1);
  }
  throw new Error("the founder never came free");
}

export type Stop = "asleep" | "awake" | "at the feed store" | "buying" | "bought" | "home with materials" | "batch done";

/** The path up to `stop`, and its player snapshot there. */
export function playTo(stop: Stop): { readonly sim: Sim; readonly player: PlayerSnapshot } {
  const sim = freshGame();
  const done = (s: Stop) => s === stop;
  if (!done("asleep")) {
    sim.advance(START_WAKE_TICK);
    if (!done("awake")) {
      send(sim, { type: "TRAVEL", destinationLocationId: FEED_STORE, transport: { kind: "FOOT" }, via: null });
      untilFree(sim);
      if (!done("at the feed store")) {
        const facilityId = THE_FIRST_HIRE_SCENARIO.facilities[0]!.id;
        for (const input of RECIPE.inputsPerCase) {
          send(sim, { type: "PURCHASE_MATERIALS", supplierId: THE_FIRST_HIRE_SCENARIO.supplierIds[0]!, materialId: input.materialId, quantity: input.quantity, facilityId });
          if (done("buying")) return { sim, player: sim.playerSnapshot() };
          untilFree(sim);
        }
        if (!done("bought")) {
          send(sim, { type: "TRAVEL", destinationLocationId: HOME, transport: { kind: "FOOT" }, via: null });
          untilFree(sim);
          if (!done("home with materials")) {
            send(sim, { type: "START_PRODUCTION", facilityId, recipeId: RECIPE.id, quantity: 1 });
            untilFree(sim);
            for (let i = 0; i < 2_000 && sim.state.productionJobs.length > 0; i++) sim.advance(1);
          }
        }
      }
    }
  }
  return { sim, player: sim.playerSnapshot() };
}
