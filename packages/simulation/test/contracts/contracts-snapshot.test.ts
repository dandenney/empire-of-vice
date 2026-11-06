// Unlocked T02e (issue #9) checks of the snapshot's `contracts` section beyond
// the locked acceptance test: the contract fixtures' shape at each stage of a
// contract played through commands, offer `blockedBy` on the tick before expiry,
// closed contracts most recent first, and save → load.

import { TICKS_PER_DAY, type ContractId, type GameCommand, type GameSnapshot } from "@eov/contracts";
import { midGameSnapshot } from "@eov/contracts/fixtures";
import { BASIC_MOONSHINE_RECIPE, GAME_DATA, KESSLERS_BACK_ROOM, MODEL_TT_TRUCK, MOONSHINE } from "@eov/game-data";
import { describe, expect, it } from "vitest";
import { loadGame, newGame, type KernelSimulation } from "../../src/index.ts";
import { shapeDifferences, undefinedPaths } from "../projection/shape.ts";
import { advanceTo, buyCorn, buySugar, expectApplied, produce } from "../sprint-zero/helpers.ts";

const DAY = TICKS_PER_DAY;

function expectContractShape(snapshot: GameSnapshot, step: string): void {
  expect(shapeDifferences(snapshot.contracts, midGameSnapshot.contracts, "contracts"), step).toEqual([]);
  expect(undefinedPaths(snapshot.contracts, "contracts"), step).toEqual([]);
  expect(JSON.parse(JSON.stringify(snapshot.contracts)), step).toEqual(snapshot.contracts);
}

/** Buys and produces `cases` basic moonshine, then waits for the job to finish. */
function stockUp(sim: KernelSimulation, cases: number): void {
  const recipe = GAME_DATA.recipes.find((r) => r.id === BASIC_MOONSHINE_RECIPE)!;
  for (const input of recipe.inputsPerCase) {
    const quantity = input.quantity * cases;
    expectApplied(sim.dispatch({ command: input.materialId === "corn" ? buyCorn(quantity) : buySugar(quantity) }));
  }
  expectApplied(sim.dispatch({ command: produce(cases) }));
  advanceTo(sim, sim.state.productionJobs[0]!.completesAt);
}

function acceptKesslers(sim: KernelSimulation): GameSnapshot["contracts"]["offers"][number] {
  const offer = sim.snapshot().contracts.offers.find((o) => o.buyerId === KESSLERS_BACK_ROOM)!;
  expect(offer.blockedBy).toBeNull();
  expectApplied(sim.dispatch({ command: { type: "ACCEPT_CONTRACT", contractOfferId: offer.id } }));
  return offer;
}

const deliver = (contractId: ContractId, quantity: number): GameCommand => ({
  type: "DISPATCH_DELIVERY",
  vehicleId: MODEL_TT_TRUCK,
  cargo: [{ productId: MOONSHINE, quality: "basic", quantity }],
  purpose: { kind: "CONTRACT_INSTALLMENT", contractId },
  routeId: null,
});

describe("contracts snapshot", () => {
  it("has the contract fixtures' shape for an offer, an active contract with cargo on the road, and a closed contract", () => {
    const sim = newGame();
    stockUp(sim, 8);
    advanceTo(sim, DAY);
    expectContractShape(sim.snapshot(), "offered");

    acceptKesslers(sim);
    const contractId = sim.state.contracts[0]!.id;
    expect(sim.snapshot().contracts.active[0]!.reservedQuantity).toBe(8);
    expectApplied(sim.dispatch({ command: deliver(contractId, 8) }));
    const onTheRoad = sim.snapshot();
    expectContractShape(onTheRoad, "dispatched");
    expect(onTheRoad.contracts.active[0]!.installments.map((i) => i.inTransit)).toEqual([8, 0, 0]);
    expect(onTheRoad.contracts.active[0]!.reservedQuantity).toBe(0);

    const saved = JSON.parse(JSON.stringify(sim.serialize()));
    expect(loadGame(saved).snapshot()).toEqual(onTheRoad);

    advanceTo(sim, sim.state.contracts[0]!.installments.at(-1)!.deadline);
    const closed = sim.snapshot();
    expectContractShape(closed, "completed");
    expect(closed.contracts.active).toEqual([]);
    expect(closed.contracts.closed.map((c) => c.installments.map((i) => [i.delivered, i.inTransit, i.outcome]))).toEqual([
      [
        [8, 0, "FULFILLED"],
        [0, 0, "MISSED"],
        [0, 0, "MISSED"],
      ],
    ]);
  });

  it("reports OFFER_UNAVAILABLE as an offer's blockedBy on the tick before it expires (accepting would apply on the expiry tick)", () => {
    const sim = newGame();
    advanceTo(sim, DAY);
    const offer = sim.snapshot().contracts.offers[0]!;
    expect(offer.blockedBy).toBeNull();
    advanceTo(sim, offer.expiresAt - 2);
    expect(sim.snapshot().contracts.offers[0]!.blockedBy).toBeNull();
    advanceTo(sim, offer.expiresAt - 1);
    expect(sim.snapshot().contracts.offers[0]!.blockedBy).toEqual({ code: "OFFER_UNAVAILABLE", contractOfferId: offer.id });
  });

  it("lists closed contracts most recent first", () => {
    const sim = newGame();
    advanceTo(sim, DAY);
    acceptKesslers(sim);
    const first = sim.state.contracts[0]!;
    advanceTo(sim, (Math.floor(first.installments.at(-1)!.deadline / DAY) + 1) * DAY);
    acceptKesslers(sim);
    const second = sim.state.contracts[1]!;
    advanceTo(sim, second.installments.at(-1)!.deadline);
    expect(sim.snapshot().contracts.closed.map((c) => c.id)).toEqual([second.id, first.id]);
  });
});
