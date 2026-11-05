// T02d (issue #8) implementation tests, alongside the locked ECO-001 file:
// edge cases of validation, releaseDeal, and the midnight cycle's RNG use.

import { asId, TICKS_PER_DAY } from "@eov/contracts";
import { CROSSROADS_ROADHOUSE, GAME_DATA, type GameData } from "@eov/game-data";
import { describe, expect, it } from "vitest";
import { MarketDataError, releaseDeal, validateMarketData } from "../../../src/economy/market/index.ts";
import { createSimulation, newGame, nextIntBetween, simulationOptions } from "../../../src/index.ts";

describe("market data validation (extra cases)", () => {
  it("rejects a market defined twice", () => {
    const data: GameData = { ...GAME_DATA, markets: [...GAME_DATA.markets, GAME_DATA.markets[0]!] };
    expect(() => validateMarketData(data)).toThrow(MarketDataError);
  });

  it("rejects a non-integer drift, demand, or reputation", () => {
    const market = { ...GAME_DATA, markets: GAME_DATA.markets.map((m, i) => (i === 0 ? { ...m, demandDriftPpm: 0.5 } : m)) };
    expect(() => validateMarketData(market)).toThrow(MarketDataError);
    const buyers = (patch: object): GameData => ({
      ...GAME_DATA,
      buyers: GAME_DATA.buyers.map((b) => (b.id === CROSSROADS_ROADHOUSE ? { ...b, ...patch } : b)),
    });
    expect(() => validateMarketData(buyers({ minimumReputation: 2.5 }))).toThrow(MarketDataError);
    const roadhouse = GAME_DATA.buyers.find((b) => b.id === CROSSROADS_ROADHOUSE)!;
    expect(() => validateMarketData(buyers({ wants: [{ ...roadhouse.wants[0]!, dailyDemand: 1.5 }] }))).toThrow(MarketDataError);
  });
});

describe("releaseDeal (extra cases)", () => {
  it("returns the state unchanged when the buyer has no such commitment", () => {
    const state = newGame().state;
    expect(releaseDeal(state, GAME_DATA, CROSSROADS_ROADHOUSE, asId("Delivery", "delivery-404"))).toBe(state);
    expect(releaseDeal(state, GAME_DATA, asId("Buyer", "nobody"), asId("Delivery", "delivery-404"))).toBe(state);
  });
});

describe("midnight cycle (extra cases)", () => {
  it("draws once per market even when the drift bound is 0", () => {
    const data: GameData = { ...GAME_DATA, markets: GAME_DATA.markets.map((m) => ({ ...m, demandDriftPpm: 0 })) };
    const sim = createSimulation(newGame().state, simulationOptions({ data }));
    sim.advance(2 * TICKS_PER_DAY - 1);
    const before = sim.state.rng.market;
    sim.advance(1);
    let rng = before;
    for (let i = 0; i < data.markets.length; i++) rng = nextIntBetween(rng, 0, 0).rng;
    expect(sim.state.rng.market).toEqual(rng);
    for (const m of sim.state.markets) expect(m.demand).toBe(data.markets.find((d) => d.productId === m.productId && d.quality === m.quality)!.baselineDemand);
  });

  it("commits one market transaction per midnight, keyed by the day that is starting", () => {
    const sim = newGame();
    sim.advance(3 * TICKS_PER_DAY);
    const keys = sim.state.ledger.transactions.map((t) => t.idempotencyKey).filter((k) => k.startsWith("DAILY_SETTLEMENT:MARKET:"));
    expect(keys).toEqual(["DAILY_SETTLEMENT:MARKET:1", "DAILY_SETTLEMENT:MARKET:2", "DAILY_SETTLEMENT:MARKET:3"]);
  });
});
