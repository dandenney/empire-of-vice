// T05c (issue #102): how REPEAT_OPERATION judges a START_PRODUCTION or
// DISPATCH_DELIVERY source "applied", per the amended ADR 0020 decision 11: once
// it's in the command log. The copy is then fully validated by its own handler.
// (PURCHASE_MATERIALS sources are judged exactly by key; the locked test covers that.)

import { tick, type GameCommand } from "@eov/contracts";
import { BASIC_MOONSHINE_RECIPE, DISTILLERY_MAIN, GAME_DATA, MILLERS_FEED } from "@eov/game-data";
import { describe, expect, it } from "vitest";
import { resolveRepeatSource } from "../../src/commands/repeat.ts";
import { newGame } from "../../src/index.ts";

const recipe = GAME_DATA.recipes.find((r) => r.id === BASIC_MOONSHINE_RECIPE)!;
const produce: GameCommand = { type: "START_PRODUCTION", facilityId: DISTILLERY_MAIN, recipeId: BASIC_MOONSHINE_RECIPE, quantity: 1 };

describe("REPEAT_OPERATION source rule (ADR 0020 decision 11, amended)", () => {
  it("a production run rejected when its tick came is in the log, so it resolves, and the copy is validated on its own", () => {
    const sim = newGame();
    const at = sim.state.tick + 5;
    const queued = sim.dispatch({ command: produce, scheduledTick: tick(at) });
    expect(queued.status).toBe("queued");
    sim.advance(at - sim.state.tick);
    const events = sim.takeEvents();
    expect(events.some((e) => e.type === "COMMAND_REJECTED" && e.commandId === queued.commandId)).toBe(true);
    expect(resolveRepeatSource(sim.state, queued.commandId)).toEqual(produce);

    // Without inputs the copy fails with the handler's own reason.
    const without = sim.dispatch({ command: { type: "REPEAT_OPERATION", sourceCommandId: queued.commandId } });
    expect(without.status).toBe("rejected");
    if (without.status === "rejected") expect(without.reason.code).toBe("INSUFFICIENT_MATERIALS");

    // With inputs it applies.
    for (const input of recipe.inputsPerCase) {
      const bought = sim.dispatch({
        command: { type: "PURCHASE_MATERIALS", supplierId: MILLERS_FEED, materialId: input.materialId, quantity: input.quantity, facilityId: DISTILLERY_MAIN },
      });
      expect(bought.status).toBe("applied");
    }
    const repeated = sim.dispatch({ command: { type: "REPEAT_OPERATION", sourceCommandId: queued.commandId } });
    expect(repeated.status).toBe("applied");
    expect(sim.state.productionJobs).toHaveLength(1);
  });
});
