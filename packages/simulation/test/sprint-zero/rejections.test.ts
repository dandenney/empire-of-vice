// Commands on the Sprint Zero path apply atomically or are rejected with a typed
// reason, leaving the state hash unchanged (CLAUDE.md rule 6).

import { cents, type GameCommand, type RejectionCode } from "@eov/contracts";
import { CROSSROADS_ROADHOUSE, FIRST_SHIPMENT_SCENARIO, GAME_DATA, MODEL_TT_TRUCK, MOONSHINE } from "@eov/game-data";
import { describe, expect, it } from "vitest";
import { newGame } from "../../src/game/index.ts";
import type { KernelSimulation } from "../../src/index.ts";
import { buyCorn, buySugar, expectApplied, produce, roadhouseQuote, sell } from "./helpers.ts";

function expectRejected(sim: KernelSimulation, command: GameCommand, code: RejectionCode): void {
  sim.takeEvents();
  const before = sim.stateHash();
  const result = sim.dispatch({ command });
  expect(result.status).toBe("rejected");
  if (result.status === "rejected") expect(result.reason.code).toBe(code);
  expect(sim.stateHash()).toBe(before);
  expect(sim.takeEvents()).toEqual([]);
}

/** A game with one finished case in stock. */
function withOneCase(): KernelSimulation {
  const sim = newGame();
  expectApplied(sim.dispatch({ command: buyCorn(2) }));
  expectApplied(sim.dispatch({ command: buySugar(1) }));
  expectApplied(sim.dispatch({ command: produce(1) }));
  sim.advance(GAME_DATA.recipes[0]!.ticksPerCase + 1);
  sim.takeEvents();
  return sim;
}

describe("Sprint Zero rejections", () => {
  it("rejects purchases the player can't make", () => {
    const sim = newGame();
    expectRejected(sim, buyCorn(0), "INVALID_QUANTITY");
    expectRejected(sim, buyCorn(161), "SUPPLIER_STOCK_LOW");
    const corn = GAME_DATA.suppliers[0]!.stock[0]!;
    // More than the opening cash buys, within the supplier's stock.
    const unaffordable = Math.floor(FIRST_SHIPMENT_SCENARIO.openingBalance.cash / corn.unitPrice) + 1;
    if (unaffordable <= corn.dailyStock) expectRejected(sim, buyCorn(unaffordable), "INSUFFICIENT_FUNDS");
  });

  it("rejects production without materials, and a second job at a busy facility", () => {
    const sim = newGame();
    expectRejected(sim, produce(1), "INSUFFICIENT_MATERIALS");
    expectApplied(sim.dispatch({ command: buyCorn(4) }));
    expectApplied(sim.dispatch({ command: buySugar(2) }));
    expectApplied(sim.dispatch({ command: produce(1) }));
    expectRejected(sim, produce(1), "PRODUCTION_CAPACITY_EXCEEDED");
  });

  it("rejects deals that don't match the buyer's quote, liquidity, or stock", () => {
    const sim = withOneCase();
    const price = roadhouseQuote(sim.state);
    expectRejected(sim, sell(1, cents(price + 1)), "QUOTE_CHANGED");
    expectRejected(sim, sell(2, price), "INSUFFICIENT_STOCK");
    expectRejected(sim, sell(16, price), "INSUFFICIENT_STOCK");
    expectRejected(sim, sell(21, price), "VEHICLE_CAPACITY_EXCEEDED");
    expectRejected(
      sim,
      { ...sell(1, price), cargo: [{ productId: MOONSHINE, quality: "basic", quantity: 1 }, { productId: MOONSHINE, quality: "basic", quantity: 1 }] } as GameCommand,
      "INVALID_QUANTITY",
    );
    expectApplied(sim.dispatch({ command: sell(1, price) }));
    expectRejected(sim, sell(1, price), "VEHICLE_UNAVAILABLE");
  });

  it("rejects more cases than the buyer will take", () => {
    // Fill the warehouse with enough cases to exceed the roadhouse's demand.
    const sim = newGame();
    const demand = sim.state.buyers.find((b) => b.id === CROSSROADS_ROADHOUSE)!.wants[0]!.demandRemaining;
    const cases = demand + 1;
    expectApplied(sim.dispatch({ command: buyCorn(2 * cases) }));
    expectApplied(sim.dispatch({ command: buySugar(cases) }));
    expectApplied(sim.dispatch({ command: produce(cases) }));
    sim.advance(GAME_DATA.recipes[0]!.ticksPerCase * cases + 1);
    const result = sim.dispatch({ command: sell(cases, roadhouseQuote(sim.state)) });
    expect(result).toMatchObject({ status: "rejected", reason: { code: "BUYER_WILL_TAKE_LESS", requested: cases, acceptable: demand } });
  });

  it("rejects purposes the S0 stub doesn't support with typed reasons", () => {
    const sim = withOneCase();
    const base = sell(1, roadhouseQuote(sim.state));
    expectRejected(
      sim,
      { ...base, purpose: { kind: "TRANSFER", destinationFacilityId: GAME_DATA.facilities[0]!.id } } as GameCommand,
      "NO_ROUTE",
    );
    expectRejected(sim, { ...base, vehicleId: "no-such-truck" } as unknown as GameCommand, "UNKNOWN_ENTITY");
    expect(MODEL_TT_TRUCK).toBe(sim.state.vehicles[0]!.id);
  });
});
