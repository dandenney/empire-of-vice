// Sprint Zero, headless (issue #4): one case of moonshine, end to end.
//
// Create game → buy ingredients → produce one case → dispatch truck → deliver →
// sell → record profit → save → reload → continue. Accounting is checked after
// every step. Expected amounts are derived from game-data, so tuning the
// placeholders (T02c, T02d, T03, T05) doesn't invalidate the test's logic.

import { addTicks, multiplyMoney, SAVE_FORMAT, type GameEvent, type SaveGame } from "@eov/contracts";
import {
  BASIC_MOONSHINE_RECIPE,
  CORN,
  CROSSROADS_ROADHOUSE,
  FIRST_SHIPMENT_SCENARIO,
  GAME_DATA,
  MILLERS_FEED,
  STATE_HIGHWAY,
  SUGAR,
} from "@eov/game-data";
import { describe, expect, it } from "vitest";
import { balanceSheet, loadGame, newGame } from "../../src/game/index.ts";
import { hashState } from "../../src/index.ts";
import { advanceTo, balances, buyCorn, buySugar, expectApplied, expectBalanced, produce, roadhouseQuote, sell } from "./helpers.ts";

const recipe = GAME_DATA.recipes.find((r) => r.id === BASIC_MOONSHINE_RECIPE)!;
const supplier = GAME_DATA.suppliers.find((s) => s.id === MILLERS_FEED)!;
const route = GAME_DATA.routes.find((r) => r.id === STATE_HIGHWAY)!;
const priceOf = (m: typeof CORN) => supplier.stock.find((s) => s.materialId === m)!.unitPrice;
const qtyOf = (m: typeof CORN) => recipe.inputsPerCase.find((i) => i.materialId === m)!.quantity;

const cornCost = multiplyMoney(priceOf(CORN), qtyOf(CORN));
const sugarCost = multiplyMoney(priceOf(SUGAR), qtyOf(SUGAR));
const materialsCost = cornCost + sugarCost;
const conversion = recipe.laborPerCase + recipe.overheadPerCase;
const caseCost = materialsCost + conversion;
const openingCash = FIRST_SHIPMENT_SCENARIO.openingBalance.cash;

const typesOf = (events: readonly GameEvent[]) => events.map((e) => e.type);

describe("Sprint Zero: one case of moonshine", () => {
  it("runs create → buy → produce → dispatch → deliver → sell → save → reload with balanced books at every step", () => {
    // 1. Create game: the scenario books an OPENING_BALANCE transaction.
    const sim = newGame();
    const opening = sim.state.ledger.transactions;
    expect(opening.map((t) => t.kind)).toEqual(["OPENING_BALANCE"]);
    expect(sim.state.seed).toBe(FIRST_SHIPMENT_SCENARIO.seed);
    expectBalanced(sim.state);
    const openingNetWorth = balanceSheet(sim.state).netWorth;
    expect(balances(sim.state).CASH).toBe(openingCash);
    expect(openingNetWorth).toBe(balanceSheet(sim.state).equity);

    // 2. Buy ingredients for one case. Cash becomes raw materials; net worth unchanged.
    expectApplied(sim.dispatch({ command: buyCorn(qtyOf(CORN)) }));
    expectBalanced(sim.state);
    expectApplied(sim.dispatch({ command: buySugar(qtyOf(SUGAR)) }));
    expectBalanced(sim.state);
    expect(balances(sim.state).RAW_MATERIALS).toBe(materialsCost);
    expect(balances(sim.state).CASH).toBe(openingCash - materialsCost);
    expect(balanceSheet(sim.state).netWorth).toBe(openingNetWorth);
    expect(typesOf(sim.takeEvents())).toEqual(["MATERIALS_PURCHASED", "MATERIALS_PURCHASED"]);

    // 3. Produce one case. Starting reserves inputs and moves no money.
    const ledgerBeforeStart = balances(sim.state);
    expectApplied(sim.dispatch({ command: produce(1) }));
    expectBalanced(sim.state);
    expect(balances(sim.state)).toEqual(ledgerBeforeStart);
    const job = sim.state.productionJobs[0]!;
    expect(job.completesAt).toBe(addTicks(job.startedAt, recipe.ticksPerCase));
    expect(sim.state.reservations).toHaveLength(recipe.inputsPerCase.length);
    expect(typesOf(sim.takeEvents())).toEqual(["PRODUCTION_STARTED"]);

    // The job completes: cost is capitalized, no profit is recognized (FIN-001).
    advanceTo(sim, job.completesAt - 1);
    expect(sim.state.productionJobs).toHaveLength(1);
    advanceTo(sim, job.completesAt);
    expectBalanced(sim.state);
    expect(sim.state.productionJobs).toEqual([]);
    expect(sim.state.reservations).toEqual([]);
    expect(sim.state.materialPools).toEqual([]);
    expect(sim.state.productPools).toEqual([
      { facilityId: job.facilityId, productId: recipe.productId, quality: recipe.quality, quantity: 1, totalCost: caseCost },
    ]);
    const afterProduction = balanceSheet(sim.state);
    expect(balances(sim.state).FINISHED_GOODS).toBe(caseCost);
    expect(balances(sim.state).RAW_MATERIALS).toBe(0);
    expect(balances(sim.state).CASH).toBe(openingCash - caseCost);
    expect(afterProduction.revenue).toBe(0);
    expect(afterProduction.netIncome).toBe(0);
    expect(afterProduction.netWorth).toBe(openingNetWorth);
    // Each consumed reservation is reported (issue #33), in the completion transaction.
    const completed = sim.takeEvents();
    expect(typesOf(completed)).toEqual([...job.reservationIds.map(() => "RESERVATION_RELEASED"), "PRODUCTION_COMPLETED"]);
    expect(completed.slice(0, -1)).toEqual(
      job.reservationIds.map((reservationId) => expect.objectContaining({ reservationId, reason: "CONSUMED", causedBy: null })),
    );
    expect(completed.at(-1)).toMatchObject({ costBasis: caseCost, quantity: 1, causedBy: null });
    const productionTx = sim.state.ledger.transactions.at(-1)!;
    expect(productionTx.kind).toBe("PRODUCTION");
    expect(productionTx.eventIds).toEqual(completed.map((e) => e.id));

    // 4. Dispatch the truck: a deal struck at dispatch (ADR 0005). Cost moves to goods in transit.
    const price = roadhouseQuote(sim.state);
    const budgetBefore = sim.state.buyers.find((b) => b.id === CROSSROADS_ROADHOUSE)!.budgetRemaining;
    expectApplied(sim.dispatch({ command: sell(1, price) }));
    expectBalanced(sim.state);
    expect(balances(sim.state).FINISHED_GOODS).toBe(0);
    expect(balances(sim.state).GOODS_IN_TRANSIT).toBe(caseCost);
    expect(balanceSheet(sim.state).netWorth).toBe(openingNetWorth);
    const buyer = sim.state.buyers.find((b) => b.id === CROSSROADS_ROADHOUSE)!;
    expect(buyer.budgetRemaining).toBe(budgetBefore - price);
    expect(buyer.commitments).toEqual([{ deliveryId: "delivery-1", productId: recipe.productId, quantity: 1, amount: price }]);
    const trip = sim.state.vehicles[0]!.trip!;
    expect(trip).toMatchObject({ leg: "OUTBOUND", routeId: STATE_HIGHWAY });
    expect(trip.arrivesAt).toBe(addTicks(trip.departedAt, route.durationTicks));
    expect(typesOf(sim.takeEvents())).toEqual(["DELIVERY_DISPATCHED"]);

    // 5. Arrival: cash on delivery, revenue and COGS recognized now.
    advanceTo(sim, trip.arrivesAt - 1);
    expect(balances(sim.state).SALES_REVENUE).toBe(0);
    advanceTo(sim, trip.arrivesAt);
    expectBalanced(sim.state);
    const afterSale = balanceSheet(sim.state);
    expect(balances(sim.state).CASH).toBe(openingCash - caseCost + price);
    expect(balances(sim.state).GOODS_IN_TRANSIT).toBe(0);
    expect(afterSale.revenue).toBe(price);
    expect(balances(sim.state).COST_OF_GOODS_SOLD).toBe(caseCost);
    expect(afterSale.netIncome).toBe(price - caseCost);
    expect(afterSale.netWorth).toBe(openingNetWorth + price - caseCost);
    expect(price - caseCost).toBeGreaterThan(0); // the placeholder numbers make a profit
    const sale = sim.takeEvents();
    expect(typesOf(sale)).toEqual(["SALE_COMPLETED"]);
    expect(sale[0]).toMatchObject({ revenue: price, costOfGoodsSold: caseCost, unitPrice: price, buyerId: CROSSROADS_ROADHOUSE });
    expect(sim.state.buyers.find((b) => b.id === CROSSROADS_ROADHOUSE)!.commitments).toEqual([]);
    expect(sim.state.ledger.transactions.map((t) => t.kind)).toEqual([
      "OPENING_BALANCE",
      "MATERIAL_PURCHASE",
      "MATERIAL_PURCHASE",
      "RESERVATION",
      "PRODUCTION",
      "DISPATCH",
      "SALE",
    ]);

    // 6. Save → reload → continue gives the same future as an uninterrupted run.
    const save: SaveGame = JSON.parse(JSON.stringify(sim.serialize()));
    expect(save.format).toBe(SAVE_FORMAT);
    expect(hashState(save.state)).toBe(sim.stateHash());
    const resumed = loadGame(save);
    expect(resumed.stateHash()).toBe(sim.stateHash());

    const returnAt = sim.state.vehicles[0]!.trip!.arrivesAt;
    expect(sim.state.vehicles[0]!.trip!.leg).toBe("RETURN");
    advanceTo(sim, returnAt + 60);
    advanceTo(resumed, returnAt + 60);
    expect(resumed.stateHash()).toBe(sim.stateHash());
    expect(sim.state.vehicles[0]!.trip).toBeNull();
    const returned = resumed.takeEvents();
    expect(typesOf(returned)).toEqual(["VEHICLE_RETURNED"]);

    // The return goes through the coordinator (issue #32): one VEHICLE_RETURN
    // transaction, no ledger entries, keyed by the delivery.
    const returnTx = resumed.state.ledger.transactions.at(-1)!;
    expect(returnTx).toMatchObject({ kind: "VEHICLE_RETURN", idempotencyKey: "VEHICLE_RETURN:delivery-1", entries: [] });
    expect(returnTx.eventIds).toEqual(returned.map((e) => e.id));
    expectBalanced(resumed.state);

    // The resumed game keeps playing: the truck is free for a second sale.
    expectApplied(resumed.dispatch({ command: buyCorn(qtyOf(CORN)) }));
    expectBalanced(resumed.state);
  });

  it("is deterministic: the same commands give the same state hash", () => {
    const run = () => {
      const sim = newGame();
      sim.dispatch({ command: buyCorn(qtyOf(CORN)) });
      sim.dispatch({ command: buySugar(qtyOf(SUGAR)) });
      sim.dispatch({ command: produce(1) });
      sim.advance(recipe.ticksPerCase + 1);
      sim.dispatch({ command: sell(1, roadhouseQuote(sim.state)) });
      sim.advance(route.durationTicks * 2 + 1);
      return sim.stateHash();
    };
    expect(run()).toBe(run());
  });
});
