// Shared helpers for the Sprint Zero tests.

import { tick, type CommandResult, type DealId, type GameCommand, type GameState, type Money } from "@eov/contracts";
import {
  BASIC_MOONSHINE_RECIPE,
  CORN,
  CROSSROADS_ROADHOUSE,
  DISTILLERY_MAIN,
  MILLERS_FEED,
  MODEL_TT_TRUCK,
  MOONSHINE,
  SUGAR,
} from "@eov/game-data";
import { expect } from "vitest";
import type { KernelSimulation } from "../../src/index.ts";
import { accountBalances, balanceSheet, checkInvariants, entryTotals } from "../../src/game/index.ts";

/** Every transaction balances, the latest passes every invariant, and assets = liabilities + equity. */
export function expectBalanced(state: GameState): void {
  for (const t of state.ledger.transactions) {
    const { debits, credits } = entryTotals(t.entries);
    expect(debits, `${t.id} (${t.kind})`).toBe(credits);
  }
  const last = state.ledger.transactions.at(-1);
  if (last) expect(checkInvariants(state, last)).toEqual([]);
  const sheet = balanceSheet(state);
  expect(sheet.assets).toBe(sheet.liabilities + sheet.equity + sheet.netIncome);
}

export const balances = (state: GameState) => accountBalances(state.ledger.transactions);

export function buy(materialId: typeof CORN, quantity: number): GameCommand {
  return { type: "PURCHASE_MATERIALS", supplierId: MILLERS_FEED, materialId, quantity, facilityId: DISTILLERY_MAIN };
}

export const buyCorn = (quantity: number) => buy(CORN, quantity);
export const buySugar = (quantity: number) => buy(SUGAR, quantity);

export function produce(quantity: number): GameCommand {
  return { type: "START_PRODUCTION", facilityId: DISTILLERY_MAIN, recipeId: BASIC_MOONSHINE_RECIPE, quantity };
}

/** AGREE_DEAL with the roadhouse for basic moonshine (ADR 0022 decision 6). */
export function agree(quantity: number, agreedUnitPrice: Money): GameCommand {
  return { type: "AGREE_DEAL", buyerId: CROSSROADS_ROADHOUSE, productId: MOONSHINE, quality: "basic", quantity, agreedUnitPrice };
}

/** The truck's dispatch of basic moonshine to the roadhouse against a held deal. */
export function dealSale(quantity: number, dealId: DealId): GameCommand {
  return {
    type: "DISPATCH_DELIVERY",
    vehicleId: MODEL_TT_TRUCK,
    cargo: [{ productId: MOONSHINE, quality: "basic", quantity }],
    purpose: { kind: "SALE", buyerId: CROSSROADS_ROADHOUSE, dealId },
    routeId: null,
    driver: { kind: "FOUNDER" },
  };
}

/** The newest held deal (IDs sort with compareIds, so the last is the latest minted). */
export function lastDealId(state: GameState): DealId {
  const deal = state.heldDeals.at(-1);
  if (!deal) throw new Error("No held deal");
  return deal.id;
}

/**
 * M001's sale, as ADR 0022 decision 6 splits it: AGREE_DEAL at the price, then
 * the deal dispatch. The agreement's result if it wasn't applied, else the dispatch's.
 */
export function sell(sim: KernelSimulation, quantity: number, agreedUnitPrice: Money): CommandResult {
  const agreed = sim.dispatch({ command: agree(quantity, agreedUnitPrice) });
  if (agreed.status !== "applied") return agreed;
  return sim.dispatch({ command: dealSale(quantity, lastDealId(sim.state)) });
}

/** The roadhouse's current quote for basic moonshine. */
export function roadhouseQuote(state: GameState): Money {
  const want = state.buyers.find((b) => b.id === CROSSROADS_ROADHOUSE)?.wants[0];
  if (!want) throw new Error("No roadhouse quote");
  return want.unitPrice;
}

/** Advances until `sim.state.tick` reaches `target`. */
export function advanceTo(sim: KernelSimulation, target: number): void {
  sim.advance(tick(target) - sim.state.tick);
}

export function expectApplied(result: ReturnType<KernelSimulation["dispatch"]>): void {
  if (result.status !== "applied") throw new Error(`Expected applied, got ${JSON.stringify(result)}`);
}
