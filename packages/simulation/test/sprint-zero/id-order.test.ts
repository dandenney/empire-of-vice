// State lists of simulation-created records use the shared ID order (issue #34):
// `res-9` before `res-10`, which plain text order gets wrong.

import {
  asId,
  compareIds,
  DYNAMIC_ID_PREFIXES,
  tick,
  type DeliveryState,
  type GameState,
  type ProductionJobState,
  type ReservationState,
} from "@eov/contracts";
import {
  BASIC_MOONSHINE_RECIPE,
  CORN,
  CROSSROADS_ROADHOUSE,
  DISTILLERY_MAIN,
  GAME_DATA,
  MODEL_TT_TRUCK,
  STATE_HIGHWAY,
  SUGAR,
} from "@eov/game-data";
import { describe, expect, it } from "vitest";
import { createSimulation, type KernelSimulation } from "../../src/index.ts";
import { newGame, simulationOptions } from "../../src/game/index.ts";
import { addReservation } from "../../src/inventory/index.ts";
import { ID_PREFIXES } from "../../src/kernel/ids.ts";
import { advanceTo, buyCorn, buySugar, expectApplied, produce, roadhouseQuote, sell } from "./helpers.ts";

const recipe = GAME_DATA.recipes.find((r) => r.id === BASIC_MOONSHINE_RECIPE)!;
const qtyOf = (m: typeof CORN) => recipe.inputsPerCase.find((i) => i.materialId === m)!.quantity;

const reservation = (n: number): ReservationState => ({
  id: asId("Reservation", `res-${n}`),
  facilityId: DISTILLERY_MAIN,
  goods: { kind: "MATERIAL", materialId: CORN },
  quantity: 1,
  holder: { kind: "PRODUCTION_JOB", jobId: asId("ProductionJob", `job-${n}`) },
});

/**
 * A record with the ID `<prefix>-10` already in state while the counter will mint
 * `<prefix>-9` next, so appending the new record lands it out of order. Normal play
 * can't reach this (IDs are minted in increasing order), but a list's order must
 * not depend on that: the sorts after insertion are what keep it in `compareIds` order.
 */
function withHigherIdAhead(sim: KernelSimulation, edit: (state: GameState) => GameState): KernelSimulation {
  return createSimulation(edit(sim.state), simulationOptions());
}

const expectIdOrder = (ids: readonly string[], expected: readonly string[]) => {
  expect(ids).toEqual(expected);
  expect(ids).toEqual([...ids].sort(compareIds));
  expect(ids).not.toEqual([...ids].sort());
};

describe("ID order in state", () => {
  it("mints IDs with the prefixes compareIds recognizes", () => {
    expect(ID_PREFIXES).toBe(DYNAMIC_ID_PREFIXES);
  });

  it("keeps reservations in compareIds order, not text order", () => {
    // addReservation needs the goods in a pool (T02a #5): stock the 4 corn first.
    const stocked = newGame();
    expectApplied(stocked.dispatch({ command: buyCorn(4) }));
    let state = stocked.state;
    for (const n of [10, 9, 2, 100]) state = addReservation(state, reservation(n));
    expectIdOrder(
      state.reservations.map((r) => r.id),
      ["res-2", "res-9", "res-10", "res-100"],
    );
  });

  it("keeps production jobs in compareIds order when a job is inserted out of order", () => {
    const base = newGame();
    expectApplied(base.dispatch({ command: buyCorn(qtyOf(CORN)) }));
    expectApplied(base.dispatch({ command: buySugar(qtyOf(SUGAR)) }));
    // At another facility (one job per facility), and never due, so it's never completed.
    const later: ProductionJobState = {
      id: asId("ProductionJob", "job-10"),
      facilityId: asId("Facility", "second-still"),
      recipeId: BASIC_MOONSHINE_RECIPE,
      quantity: 1,
      startedAt: tick(0),
      completesAt: tick(1_000_000),
      reservationIds: [],
    };
    const sim = withHigherIdAhead(base, (s) => ({
      ...s,
      productionJobs: [later],
      counters: { ...s.counters, nextId: { ...s.counters.nextId, ProductionJob: 9 } },
    }));

    expectApplied(sim.dispatch({ command: produce(1) }));
    expectIdOrder(
      sim.state.productionJobs.map((j) => j.id),
      ["job-9", "job-10"],
    );
  });

  it("keeps deliveries in compareIds order when a delivery is inserted out of order", () => {
    const base = newGame();
    expectApplied(base.dispatch({ command: buyCorn(qtyOf(CORN)) }));
    expectApplied(base.dispatch({ command: buySugar(qtyOf(SUGAR)) }));
    expectApplied(base.dispatch({ command: produce(1) }));
    advanceTo(base, base.state.productionJobs[0]!.completesAt);
    expect(base.state.productPools).toHaveLength(1);

    // Finished and empty, so it holds no goods in transit and no vehicle.
    const later: DeliveryState = {
      id: asId("Delivery", "delivery-10"),
      vehicleId: MODEL_TT_TRUCK,
      fromFacilityId: DISTILLERY_MAIN,
      routeId: STATE_HIGHWAY,
      cargo: [],
      purpose: { kind: "SALE", buyerId: CROSSROADS_ROADHOUSE, dealId: null },
      status: "DELIVERED",
      dealDeadline: null,
      driver: null,
    };
    const sim = withHigherIdAhead(base, (s) => ({
      ...s,
      deliveries: [later],
      counters: { ...s.counters, nextId: { ...s.counters.nextId, Delivery: 9 } },
    }));

    expectApplied(sell(sim, 1, roadhouseQuote(sim.state)));
    expectIdOrder(
      sim.state.deliveries.map((d) => d.id),
      ["delivery-9", "delivery-10"],
    );
  });
});
