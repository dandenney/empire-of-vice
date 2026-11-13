// T02d (issue #8) implementation tests, alongside the locked ECO-001 file:
// edge cases of validation, releaseDeal, and the midnight cycle's RNG use.

import { asId, qualityRank, ratio, TICKS_PER_DAY } from "@eov/contracts";
import { CORN, CROSSROADS_ROADHOUSE, FIRST_SHIPMENT_SCENARIO, GAME_DATA, MILLERS_FEED, SUGAR, type GameData } from "@eov/game-data";
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
    expect(releaseDeal(state, GAME_DATA, CROSSROADS_ROADHOUSE, asId("Deal", "deal-404"))).toBe(state);
    expect(releaseDeal(state, GAME_DATA, asId("Buyer", "nobody"), asId("Deal", "deal-404"))).toBe(state);
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

  it("rolls two configured shortages in supplier, then material, order before the drift draws", () => {
    // A second shortage on sugar with no market effects, so it doesn't share a market with corn's.
    const sugarShortage = { name: "Sugar shortage", earliestStartDay: 2, latestStartDay: 9, durationDays: 1, supplyRatio: ratio(500_000), priceRatio: ratio(1_200_000), marketEffects: [] };
    const data: GameData = {
      ...GAME_DATA,
      suppliers: GAME_DATA.suppliers.map((s) => ({ ...s, stock: s.stock.map((st) => (st.materialId === SUGAR ? { ...st, shortage: sugarShortage } : st)) })),
    };
    expect(() => validateMarketData(data)).not.toThrow();
    const corn = data.suppliers.find((s) => s.id === MILLERS_FEED)!.stock.find((st) => st.materialId === CORN)!.shortage!;
    expect(CORN < SUGAR).toBe(true);

    for (const seed of [1, 2, 3]) {
      const sim = newGame({ scenario: { ...FIRST_SHIPMENT_SCENARIO, seed }, data });
      sim.advance(TICKS_PER_DAY - 1);
      let rng = sim.state.rng.market;
      sim.advance(1);
      const rolls = [
        { materialId: CORN, window: corn },
        { materialId: SUGAR, window: sugarShortage },
      ].map(({ materialId, window }) => {
        const draw = nextIntBetween(rng, window.earliestStartDay, window.latestStartDay);
        rng = draw.rng;
        return { materialId, tick: draw.value * TICKS_PER_DAY };
      });
      for (const m of [...data.markets].sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : qualityRank(a.quality) - qualityRank(b.quality)))) {
        const k = Math.floor((m.baselineDemand * m.demandDriftPpm) / 1_000_000);
        rng = nextIntBetween(rng, -k, k).rng;
      }
      expect(sim.state.rng.market).toEqual(rng);
      for (const r of rolls) {
        const starts = sim.state.scheduledEvents.filter((e) => e.kind === "SHORTAGE_START" && e.materialId === r.materialId);
        expect(starts.map((e) => e.tick)).toEqual([r.tick]);
      }
    }
  });

  it("commits one market transaction per midnight, keyed by the day that is starting", () => {
    const sim = newGame();
    sim.advance(3 * TICKS_PER_DAY);
    const keys = sim.state.ledger.transactions.map((t) => t.idempotencyKey).filter((k) => k.startsWith("DAILY_SETTLEMENT:MARKET:"));
    expect(keys).toEqual(["DAILY_SETTLEMENT:MARKET:1", "DAILY_SETTLEMENT:MARKET:2", "DAILY_SETTLEMENT:MARKET:3"]);
  });
});
