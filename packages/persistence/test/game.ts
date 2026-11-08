// A game mid-way through the Sprint Zero path, for the persistence tests.

import { tick, type SaveMeta } from "@eov/contracts";
import { BASIC_MOONSHINE_RECIPE, CORN, CROSSROADS_ROADHOUSE, DISTILLERY_MAIN, MILLERS_FEED, MODEL_TT_TRUCK, MOONSHINE, SUGAR } from "@eov/game-data";
import { newGame, type KernelSimulation } from "@eov/simulation";

export const meta: SaveMeta = { slot: "slot-1", label: "Day 1", savedAt: "2026-11-04T18:30:00.000Z", appVersion: "0.0.0-test" };

/** Materials bought, a case made, and the truck on its way to the roadhouse; a purchase queued for later. */
export function gameInProgress(): KernelSimulation {
  const sim = newGame();
  sim.dispatch({ command: { type: "PURCHASE_MATERIALS", supplierId: MILLERS_FEED, materialId: CORN, quantity: 2, facilityId: DISTILLERY_MAIN } });
  sim.dispatch({ command: { type: "PURCHASE_MATERIALS", supplierId: MILLERS_FEED, materialId: SUGAR, quantity: 1, facilityId: DISTILLERY_MAIN } });
  sim.dispatch({ command: { type: "START_PRODUCTION", facilityId: DISTILLERY_MAIN, recipeId: BASIC_MOONSHINE_RECIPE, quantity: 1 } });
  sim.advance(200);
  const price = sim.state.buyers.find((b) => b.id === CROSSROADS_ROADHOUSE)!.wants[0]!.unitPrice;
  const result = sim.dispatch({
    command: {
      type: "DISPATCH_DELIVERY",
      vehicleId: MODEL_TT_TRUCK,
      cargo: [{ productId: MOONSHINE, quality: "basic", quantity: 1 }],
      purpose: { kind: "SALE", buyerId: CROSSROADS_ROADHOUSE, agreedUnitPrice: price },
      routeId: null,
    },
  });
  if (result.status !== "applied") throw new Error(`dispatch: ${JSON.stringify(result)}`);
  // Queued for the next morning, so the save holds a pending command too.
  sim.dispatch({
    command: { type: "PURCHASE_MATERIALS", supplierId: MILLERS_FEED, materialId: CORN, quantity: 2, facilityId: DISTILLERY_MAIN },
    scheduledTick: tick(sim.state.tick + 900),
  });
  sim.advance(30);
  return sim;
}
