// Projection edge cases from the post-merge review of #40 (issue #43): the
// blockedBy dry run with a queued command, recipes with no inputs, the
// previous day's upper bound, the newest end of the event journal, and the
// cash-flow guard for kinds that never move cash.

import { asId, cents, SNAPSHOT_RECENT_EVENTS, tick, type GameCommand, type GameSnapshot, type LedgerTransaction, type TransactionKind } from "@eov/contracts";
import { BASIC_MOONSHINE_RECIPE, DISTILLERY_MAIN, GAME_DATA, type GameData, type RecipeDefinition } from "@eov/game-data";
import { describe, expect, it } from "vitest";
import { newGame } from "../../src/index.ts";
import { formatId } from "../../src/kernel/ids.ts";
import { cashFlowStatement, FinanceProjectionError } from "../../src/projection/index.ts";
import { advanceTo, buyCorn, buySugar, expectApplied, produce } from "../sprint-zero/helpers.ts";

const recipeIn = (s: GameSnapshot, recipeId: string) =>
  s.facilities.find((f) => f.id === DISTILLERY_MAIN)!.recipes.find((r) => r.recipeId === recipeId)!;
const basicRecipe = (s: GameSnapshot) => recipeIn(s, BASIC_MOONSHINE_RECIPE);
const BASIC = GAME_DATA.recipes.find((r) => r.id === BASIC_MOONSHINE_RECIPE)!;

/** A game at tick 1 with `command` queued for tick 2, the next tick. */
function withQueuedForNextTick(command: GameCommand, setup: (sim: ReturnType<typeof newGame>) => void = () => {}) {
  const sim = newGame();
  setup(sim);
  expect(sim.dispatch({ command, scheduledTick: tick(2) }).status).toBe("queued");
  sim.advance(1);
  expect(sim.state.tick).toBe(1);
  expect(sim.state.queuedCommands.map((e) => e.scheduledTick)).toEqual([2]);
  return sim;
}

describe("blockedBy dry run goes through dispatch", () => {
  it("sees a production start queued for the next tick", () => {
    const sim = withQueuedForNextTick(produce(1), (s) => {
      expectApplied(s.dispatch({ command: buyCorn(4) }));
      expectApplied(s.dispatch({ command: buySugar(2) }));
    });
    const before = sim.stateHash();
    const option = basicRecipe(sim.snapshot());
    expect(sim.stateHash()).toBe(before);
    // The queued start applies first on dispatch, so the facility is busy.
    expect(option).toMatchObject({
      blockedBy: { code: "PRODUCTION_CAPACITY_EXCEEDED", facilityId: DISTILLERY_MAIN, requested: 1, available: 0 },
      maxStartableQuantity: 0,
    });
    const dispatched = sim.dispatch({ command: produce(1) });
    expect(dispatched.status === "rejected" && dispatched.reason).toEqual(option.blockedBy);
  });

  it("counts materials bought by a command queued for the next tick", () => {
    const sim = withQueuedForNextTick(buyCorn(4), (s) => {
      expectApplied(s.dispatch({ command: buyCorn(2) }));
      expectApplied(s.dispatch({ command: buySugar(3) }));
    });
    // The current state has corn for 1 case; with the queued 4 corn it's 3 (sugar allows 3).
    const option = basicRecipe(sim.snapshot());
    expect(option).toMatchObject({ blockedBy: null, maxStartableQuantity: 3 });
    expect(sim.dispatch({ command: produce(4) }).status).toBe("rejected");
    expectApplied(sim.dispatch({ command: produce(3) }));
  });
});

describe("recipes with no inputs", () => {
  const SPRING_WATER = asId("Recipe", "spring-water");
  const dataWith = (recipe: Partial<RecipeDefinition>): GameData => ({
    ...GAME_DATA,
    recipes: [...GAME_DATA.recipes, { ...BASIC, id: SPRING_WATER, name: "Spring water", inputsPerCase: [], ...recipe }],
  });
  const startWater = (quantity: number): GameCommand => ({ type: "START_PRODUCTION", facilityId: DISTILLERY_MAIN, recipeId: SPRING_WATER, quantity });

  it("are bounded by cash when each case costs something", () => {
    const sim = newGame({ data: dataWith({}) });
    const perCase = BASIC.laborPerCase + BASIC.overheadPerCase;
    expect(perCase).toBeGreaterThan(0);
    const expected = Math.floor(sim.snapshot().finance.cash / perCase);
    const option = recipeIn(sim.snapshot(), SPRING_WATER);
    expect(option).toMatchObject({ blockedBy: null, maxStartableQuantity: expected, inputsPerCase: [] });
    expect(sim.dispatch({ command: startWater(expected + 1) }).status).toBe("rejected");
    expectApplied(sim.dispatch({ command: startWater(expected) }));
  });

  it("are bounded by the safe-integer range when they cost nothing", () => {
    const sim = newGame({ data: dataWith({ laborPerCase: cents(0), overheadPerCase: cents(0) }) });
    const option = recipeIn(sim.snapshot(), SPRING_WATER);
    // The completion tick (next tick + ticksPerCase × quantity) has to stay a safe integer.
    const expected = Math.floor((Number.MAX_SAFE_INTEGER - 1) / BASIC.ticksPerCase);
    expect(option).toMatchObject({ blockedBy: null, maxStartableQuantity: expected });
    expectApplied(sim.dispatch({ command: startWater(expected) }));
  });

  it("are bounded even with no cost and no production time", () => {
    const sim = newGame({ data: dataWith({ laborPerCase: cents(0), overheadPerCase: cents(0), ticksPerCase: 0 }) });
    expect(recipeIn(sim.snapshot(), SPRING_WATER)).toMatchObject({ blockedBy: null, maxStartableQuantity: Number.MAX_SAFE_INTEGER });
  });
});

describe("finance periods", () => {
  it("ends the previous day at midnight: today's transactions aren't in it", () => {
    const sim = newGame();
    expectApplied(sim.dispatch({ command: buyCorn(2) }));
    advanceTo(sim, 1_440);
    const atMidnight = sim.snapshot().finance.previousDay!;
    // Booked at tick 1 441, the first thing of day 1.
    expectApplied(sim.dispatch({ command: buyCorn(4) }));
    sim.advance(10);
    const finance = sim.snapshot().finance;
    const materials = (r: typeof finance.today) => r.cashFlow.lines.find((l) => l.category === "MATERIALS")!.amount;
    expect(finance.previousDay).toEqual(atMidnight);
    expect(materials(finance.previousDay!)).toBe(cents(-500));
    expect(materials(finance.today)).toBe(cents(-1_000));
  });
});

describe("recent events", () => {
  it("are the newest end of the journal", () => {
    const sim = newGame();
    for (let i = 0; i < SNAPSHOT_RECENT_EVENTS + 20; i++) expectApplied(sim.dispatch({ command: buyCorn(1) }));
    const journal = sim.state.eventJournal;
    expect(journal.length).toBeGreaterThan(SNAPSHOT_RECENT_EVENTS);
    const recent = sim.snapshot().recentEvents;
    expect(recent).toHaveLength(SNAPSHOT_RECENT_EVENTS);
    expect(recent).toEqual(journal.slice(-SNAPSHOT_RECENT_EVENTS));
    expect(recent.at(-1)!.id).toBe(journal.at(-1)!.id);
  });
});

describe("cash flow guard", () => {
  const movingCash = (kind: TransactionKind): LedgerTransaction => ({
    id: formatId("Transaction", 99),
    tick: tick(5),
    kind,
    idempotencyKey: `${kind}:synthetic`,
    entries: [
      { account: "CASH", side: "DEBIT", amount: cents(100) },
      { account: "OWNER_EQUITY", side: "CREDIT", amount: cents(100) },
    ],
    eventIds: [],
  });

  it.each<TransactionKind>(["OPENING_BALANCE", "RESERVATION", "VEHICLE_RETURN"])("throws when a %s transaction moves cash", (kind) => {
    expect(() => cashFlowStatement(cents(0), [movingCash(kind)])).toThrow(FinanceProjectionError);
  });

  it("doesn't throw for those kinds when they move no cash, or for a kind that does", () => {
    expect(() => cashFlowStatement(cents(0), [{ ...movingCash("VEHICLE_RETURN"), entries: [] }])).not.toThrow();
    expect(cashFlowStatement(cents(0), [movingCash("SALE")]).netChange).toBe(cents(100));
  });
});
