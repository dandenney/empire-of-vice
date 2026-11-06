import type { CommandRequest, CommandResult, GameCommand, GameSnapshot } from "@eov/contracts";
import { FIRST_SHIPMENT_SCENARIO, GAME_DATA } from "@eov/game-data";
import { newGame } from "@eov/simulation";
import { describe, expect, it } from "vitest";
import { GreedySpotStrategy, STRATEGY } from "../src/greedy-spot.ts";
import { distribution, formatSmokeReport } from "../src/smoke-report.ts";
import { DEFAULT_DAYS, NET_WORTH_DAY, runSmokeSeed, TICKS_PER_REAL_MINUTE } from "../src/smoke-run.ts";
import { parseSmokeArgs, runSmoke, SmokeArgsError } from "../src/smoke.ts";

describe("smoke run", () => {
  it("is deterministic: one seed twice gives the same full report", () => {
    const a = runSmokeSeed(7);
    const b = runSmokeSeed(7);
    expect(b).toEqual(a);
    const one = runSmoke({ seeds: 3, firstSeed: 7, days: DEFAULT_DAYS });
    const two = runSmoke({ seeds: 3, firstSeed: 7, days: DEFAULT_DAYS });
    expect(formatSmokeReport(two.summary, two.reports)).toBe(formatSmokeReport(one.summary, one.reports));
  });

  it("overrides the scenario seed with the run's seed", () => {
    const a = runSmokeSeed(1);
    const b = runSmokeSeed(2);
    expect(a.seed).toBe(1);
    expect(b.seed).toBe(2);
    expect(a.stateHash).not.toBe(b.stateHash);
    // The scenario's own seed gives yet another run.
    expect(runSmokeSeed(FIRST_SHIPMENT_SCENARIO.seed).stateHash).not.toBe(a.stateHash);
  });

  it("reports consistent metrics", () => {
    const r = runSmokeSeed(3);
    expect(r.days).toBe(DEFAULT_DAYS);
    expect(r.netWorthByDay).toHaveLength(DEFAULT_DAYS + 1);
    expect(r.daily.map((d) => d.day)).toEqual([...Array(DEFAULT_DAYS).keys()]);
    expect(r.daily.map((d) => d.netWorth)).toEqual(r.netWorthByDay.slice(1));
    expect(r.netWorthAtDay5).toBe(r.netWorthByDay[NET_WORTH_DAY]);
    expect(r.unitsSold).toBeGreaterThan(0);
    expect(r.unitsSold).toBeLessThanOrEqual(r.casesProduced);
    expect(Object.values(r.unitsByBuyer).reduce((a, b) => a + b, 0)).toBe(r.unitsSold);
    expect(r.daily.reduce((n, d) => n + d.unitsSold, 0)).toBe(r.unitsSold);
    for (const d of r.daily) expect(r.cashTrough.cash).toBeLessThanOrEqual(d.cash);
    expect(r.cashTrough.cash).toBeGreaterThanOrEqual(0);
    expect(r.firstProfitableSale).not.toBeNull();
    expect(r.firstProfitableSale!.realMinutes).toBe(r.firstProfitableSale!.tick / TICKS_PER_REAL_MINUTE);
    expect(r.rejections).toEqual({});
    expect(r.market).toHaveLength(DEFAULT_DAYS);
  });

  it("reports day-5 net worth as null when the run is shorter", () => {
    const r = runSmokeSeed(1, { days: 2 });
    expect(r.netWorthByDay).toHaveLength(3);
    expect(r.netWorthAtDay5).toBeNull();
  });

  it("records a crashing seed as a failure and keeps going", () => {
    const result = runSmoke({ seeds: 2, firstSeed: 1, days: 0 });
    expect(result.reports).toHaveLength(0);
    expect(result.summary.failures.map((f) => [f.seed, f.error])).toEqual([
      [1, "RangeError"],
      [2, "RangeError"],
    ]);
    expect(formatSmokeReport(result.summary, result.reports)).toContain("2 seed(s) failed");
  });

  it("runs several seeds without a failure and reports every target", () => {
    const { summary, reports } = runSmoke({ seeds: 5, firstSeed: 1, days: DEFAULT_DAYS });
    expect(summary.failures).toEqual([]);
    expect(summary.seeds).toBe(5);
    const text = formatSmokeReport(summary, reports);
    for (const label of ["First profitable sale", "First affordable upgrade", "Cash trough", "Units sold", "Net worth at day 5", "D₀/S₀", "demandDriftPpm", "shortage window", "buyer budgets"]) {
      expect(text).toContain(label);
    }
  });
});

describe("greedy spot strategy", () => {
  /** A gateway that records what the bot sends, passing it to a real game. */
  function recording() {
    const sim = newGame();
    const sent: GameCommand[] = [];
    const gateway = {
      dispatch(request: CommandRequest): CommandResult {
        sent.push(request.command);
        return sim.dispatch(request);
      },
      snapshot: (): GameSnapshot => sim.snapshot(),
    };
    return { sim, sent, gateway };
  }

  it("acts only through dispatch: upgrade, hire, buy, produce at the opening", () => {
    const { sim, sent, gateway } = recording();
    const bot = new GreedySpotStrategy(sim.snapshot());
    bot.act(gateway);
    expect(sent.map((c) => c.type)).toEqual(["PURCHASE_EQUIPMENT", "SET_WORKFORCE", "PURCHASE_MATERIALS", "PURCHASE_MATERIALS", "START_PRODUCTION"]);
    expect(sent[0]).toMatchObject({ equipmentId: STRATEGY.upgradeId });
    const crew = GAME_DATA.equipment.filter((e) => e.id === STRATEGY.upgradeId || FIRST_SHIPMENT_SCENARIO.facilities[0]!.equipmentIds.includes(e.id));
    expect(sent[1]).toMatchObject({ workerCount: crew.reduce((n, e) => n + e.crew, 0) });
    expect(bot.log.rejections).toEqual({});
    expect(bot.log.upgradeBoughtAt).toBe(1);
    // Nothing is in stock yet, so nothing is sold; acting again with a job running does nothing.
    bot.act(gateway);
    expect(sent).toHaveLength(5);
  });

  it("sells to the best-paying buyer once a run completes", () => {
    const { sim, sent, gateway } = recording();
    const bot = new GreedySpotStrategy(sim.snapshot());
    bot.act(gateway);
    sim.advance(sim.state.productionJobs[0]!.completesAt - sim.state.tick);
    const s = sim.snapshot();
    bot.act(gateway);
    const sale = sent.at(-1)!;
    expect(sale.type).toBe("DISPATCH_DELIVERY");
    if (sale.type !== "DISPATCH_DELIVERY" || sale.purpose.kind !== "SALE") throw new Error("expected a sale");
    const quotes = s.market.buyers
      .filter((b) => b.willDeal)
      .flatMap((b) => b.wants.filter((w) => w.minimumQuality === "basic").map((w) => ({ id: b.id, price: w.unitPrice })));
    const best = quotes.reduce((a, b) => (b.price > a.price ? b : a));
    expect(sale.purpose.buyerId).toBe(best.id);
    expect(sale.purpose.agreedUnitPrice).toBe(best.price);
  });
});

describe("smoke CLI", () => {
  it("parses its flags", () => {
    expect(parseSmokeArgs([])).toEqual({ seeds: 1, firstSeed: 1, days: DEFAULT_DAYS, json: false });
    expect(parseSmokeArgs(["--seeds", "50"])).toEqual({ seeds: 50, firstSeed: 1, days: DEFAULT_DAYS, json: false });
    expect(parseSmokeArgs(["--", "--seeds=5", "--days", "3", "--first-seed", "100", "--json"])).toEqual({
      seeds: 5,
      firstSeed: 100,
      days: 3,
      json: true,
    });
  });

  it("rejects bad flags", () => {
    expect(() => parseSmokeArgs(["--seeds"])).toThrow(SmokeArgsError);
    expect(() => parseSmokeArgs(["--seeds", "0"])).toThrow(SmokeArgsError);
    expect(() => parseSmokeArgs(["--days", "1.5"])).toThrow(SmokeArgsError);
    expect(() => parseSmokeArgs(["--speed", "4"])).toThrow(SmokeArgsError);
  });
});

describe("distribution", () => {
  it("takes the median, min, and max", () => {
    expect(distribution([])).toBeNull();
    expect(distribution([5, 1, 3])).toEqual({ n: 3, median: 3, min: 1, max: 5 });
    expect(distribution([4, 1, 2, 9])).toEqual({ n: 4, median: 3, min: 1, max: 9 });
    expect(distribution([1, 2])).toEqual({ n: 2, median: 1, min: 1, max: 2 });
  });
});
