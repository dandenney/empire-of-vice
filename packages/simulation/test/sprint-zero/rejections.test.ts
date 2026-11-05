// Commands on the Sprint Zero path apply atomically or are rejected with a typed
// reason, leaving the state hash unchanged (CLAUDE.md rule 6). Amounts are derived
// from game-data, so tuning the placeholders doesn't invalidate the tests.

import { cents, multiplyMoney, type GameCommand, type Money, type RejectionCode, type RejectionReason } from "@eov/contracts";
import {
  BASIC_MOONSHINE_RECIPE,
  CORN,
  CROSSROADS_ROADHOUSE,
  FIRST_SHIPMENT_SCENARIO,
  GAME_DATA,
  MILLERS_FEED,
  MODEL_TT_TRUCK,
  MOONSHINE,
  SUGAR,
} from "@eov/game-data";
import { describe, expect, it } from "vitest";
import { newGame } from "../../src/game/index.ts";
import type { KernelSimulation } from "../../src/index.ts";
import { balances, buyCorn, buySugar, expectApplied, produce, roadhouseQuote, sell } from "./helpers.ts";

const recipe = GAME_DATA.recipes.find((r) => r.id === BASIC_MOONSHINE_RECIPE)!;
const supplier = GAME_DATA.suppliers.find((s) => s.id === MILLERS_FEED)!;
const truck = GAME_DATA.vehicles.find((v) => v.id === MODEL_TT_TRUCK)!;
const stockOf = (m: typeof CORN) => supplier.stock.find((s) => s.materialId === m)!;
const qtyOf = (m: typeof CORN) => recipe.inputsPerCase.find((i) => i.materialId === m)!.quantity;

const cornForOneCase = multiplyMoney(stockOf(CORN).unitPrice, qtyOf(CORN));
const materialsForOneCase = cornForOneCase + multiplyMoney(stockOf(SUGAR).unitPrice, qtyOf(SUGAR));
const conversionForOneCase = recipe.laborPerCase + recipe.overheadPerCase;

/** Rejects with `code`, leaves the state hash and event outbox unchanged, and returns the reason. */
function expectRejected(sim: KernelSimulation, command: GameCommand, code: RejectionCode): RejectionReason {
  sim.takeEvents();
  const before = sim.stateHash();
  const result = sim.dispatch({ command });
  if (result.status !== "rejected") throw new Error(`Expected rejected, got ${JSON.stringify(result)}`);
  expect(result.reason.code).toBe(code);
  expect(sim.stateHash()).toBe(before);
  expect(sim.takeEvents()).toEqual([]);
  return result.reason;
}

/** A first-shipment game that opens with exactly `cash` in the bank. */
function withOpeningCash(cash: Money): KernelSimulation {
  const sim = newGame({ scenario: { ...FIRST_SHIPMENT_SCENARIO, openingBalance: { ...FIRST_SHIPMENT_SCENARIO.openingBalance, cash } } });
  expect(balances(sim.state).CASH).toBe(cash);
  return sim;
}

/** A game with one finished case in stock. */
function withOneCase(): KernelSimulation {
  const sim = newGame();
  expectApplied(sim.dispatch({ command: buyCorn(qtyOf(CORN)) }));
  expectApplied(sim.dispatch({ command: buySugar(qtyOf(SUGAR)) }));
  expectApplied(sim.dispatch({ command: produce(1) }));
  sim.advance(recipe.ticksPerCase + 1);
  sim.takeEvents();
  return sim;
}

describe("Sprint Zero rejections", () => {
  it("rejects purchases the player can't make", () => {
    const sim = newGame();
    expectRejected(sim, buyCorn(0), "INVALID_QUANTITY");
    expectRejected(sim, buyCorn(stockOf(CORN).dailyStock + 1), "SUPPLIER_STOCK_LOW");
  });

  it("rejects a purchase the player can't afford, and allows one they exactly can", () => {
    // One cent short of a case's worth of corn, well within the supplier's stock.
    expect(qtyOf(CORN)).toBeLessThanOrEqual(stockOf(CORN).dailyStock);
    const short = withOpeningCash(cents(cornForOneCase - 1));
    expect(expectRejected(short, buyCorn(qtyOf(CORN)), "INSUFFICIENT_FUNDS")).toEqual({
      code: "INSUFFICIENT_FUNDS",
      required: cornForOneCase,
      available: cornForOneCase - 1,
    });

    const exact = withOpeningCash(cents(cornForOneCase));
    expectApplied(exact.dispatch({ command: buyCorn(qtyOf(CORN)) }));
    expect(balances(exact.state).CASH).toBe(0);
  });

  it("rejects production the player can't pay labor and overhead for, and allows it when they exactly can", () => {
    // Enough for one case's materials, one cent short of its conversion cost.
    const short = withOpeningCash(cents(materialsForOneCase + conversionForOneCase - 1));
    expectApplied(short.dispatch({ command: buyCorn(qtyOf(CORN)) }));
    expectApplied(short.dispatch({ command: buySugar(qtyOf(SUGAR)) }));
    expect(expectRejected(short, produce(1), "INSUFFICIENT_FUNDS")).toEqual({
      code: "INSUFFICIENT_FUNDS",
      required: conversionForOneCase,
      available: conversionForOneCase - 1,
    });

    const exact = withOpeningCash(cents(materialsForOneCase + conversionForOneCase));
    expectApplied(exact.dispatch({ command: buyCorn(qtyOf(CORN)) }));
    expectApplied(exact.dispatch({ command: buySugar(qtyOf(SUGAR)) }));
    expectApplied(exact.dispatch({ command: produce(1) }));
  });

  it("rejects production without materials, and a second job at a busy facility", () => {
    const sim = newGame();
    expectRejected(sim, produce(1), "INSUFFICIENT_MATERIALS");
    expectApplied(sim.dispatch({ command: buyCorn(2 * qtyOf(CORN)) }));
    expectApplied(sim.dispatch({ command: buySugar(2 * qtyOf(SUGAR)) }));
    expectApplied(sim.dispatch({ command: produce(1) }));
    expectRejected(sim, produce(1), "PRODUCTION_CAPACITY_EXCEEDED");
  });

  it("rejects deals that don't match the buyer's quote, liquidity, or stock", () => {
    const sim = withOneCase();
    const price = roadhouseQuote(sim.state);
    expectRejected(sim, sell(1, cents(price + 1)), "QUOTE_CHANGED");
    expectRejected(sim, sell(2, price), "INSUFFICIENT_STOCK");
    // A full truckload fits the vehicle but exceeds the one case in stock.
    expectRejected(sim, sell(truck.capacityCases, price), "INSUFFICIENT_STOCK");
    expectRejected(sim, sell(truck.capacityCases + 1, price), "VEHICLE_CAPACITY_EXCEEDED");
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
    expectApplied(sim.dispatch({ command: buyCorn(qtyOf(CORN) * cases) }));
    expectApplied(sim.dispatch({ command: buySugar(qtyOf(SUGAR) * cases) }));
    expectApplied(sim.dispatch({ command: produce(cases) }));
    sim.advance(recipe.ticksPerCase * cases + 1);
    // GDD §7 liquidity: the buyer takes min(demand remaining, budget / price). The
    // roadhouse's budget binds before its demand (T02d decision 1).
    const quote = roadhouseQuote(sim.state);
    const buyer = sim.state.buyers.find((b) => b.id === CROSSROADS_ROADHOUSE)!;
    const acceptable = Math.min(buyer.wants[0]!.demandRemaining, Math.floor(buyer.budgetRemaining / quote));
    expect(acceptable).toBeLessThan(cases);
    const result = sim.dispatch({ command: sell(cases, quote) });
    expect(result).toMatchObject({ status: "rejected", reason: { code: "BUYER_WILL_TAKE_LESS", requested: cases, acceptable } });
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
