import { cents, type CommandRequest, type CommandResult, type GameCommand, type GameSnapshot } from "@eov/contracts";
import { FIRST_SHIPMENT_SCENARIO, GAME_DATA } from "@eov/game-data";
import { newGame } from "@eov/simulation";
import { describe, expect, it } from "vitest";
import { CONTRACT_STRATEGY, ContractTakerStrategy } from "../src/contract-taker.ts";
import { GreedySpotStrategy, STRATEGY } from "../src/greedy-spot.ts";
import { distribution, formatSmokeReport, NOT_APPLICABLE } from "../src/smoke-report.ts";
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
    // The upgrade is LOCKED until tier 2 (ADR 0020 decision 3), so the bot skips it
    // (and the hire that goes with it) and only buys and produces.
    const upgrade = sim.snapshot().facilities[0]!.equipmentOptions.find((e) => e.equipmentId === STRATEGY.upgradeId);
    const gate = GAME_DATA.equipment.find((e) => e.id === STRATEGY.upgradeId)!.requiredUnlockId;
    expect(upgrade?.blockedBy).toEqual({ code: "LOCKED", unlockId: gate });
    expect(sent.map((c) => c.type)).toEqual(["PURCHASE_MATERIALS", "PURCHASE_MATERIALS", "START_PRODUCTION"]);
    expect(bot.log.rejections).toEqual({});
    expect(bot.log.upgradeBoughtAt).toBeNull();
    // Nothing is in stock yet, so nothing is sold; acting again with a job running does nothing.
    bot.act(gateway);
    expect(sent).toHaveLength(3);
  });

  it("sells to the best-paying buyer once a run completes", () => {
    const { sim, sent, gateway } = recording();
    const bot = new GreedySpotStrategy(sim.snapshot());
    bot.act(gateway);
    sim.advance(sim.state.productionJobs[0]!.completesAt - sim.state.tick);
    const s = sim.snapshot();
    bot.act(gateway);
    // ADR 0022 decision 6: the deal at the quote, then the dispatch against it.
    const [agreement, sale] = sent.slice(-2);
    if (agreement?.type !== "AGREE_DEAL") throw new Error("expected an agreement");
    expect(sale!.type).toBe("DISPATCH_DELIVERY");
    if (sale!.type !== "DISPATCH_DELIVERY" || sale!.purpose.kind !== "SALE") throw new Error("expected a sale");
    const quotes = s.market.buyers
      .filter((b) => b.willDeal)
      .flatMap((b) => b.wants.filter((w) => w.minimumQuality === "basic").map((w) => ({ id: b.id, price: w.unitPrice })));
    const best = quotes.reduce((a, b) => (b.price > a.price ? b : a));
    expect(sale.purpose.buyerId).toBe(best.id);
    expect(agreement).toMatchObject({ buyerId: best.id, agreedUnitPrice: best.price, quantity: sale.cargo[0]!.quantity });
    expect(sale.purpose.dealId).toBe(sim.state.heldDeals.at(-1)!.id);
    expect(sale.driver).toEqual({ kind: "FOUNDER" });
  });
});

describe("greedy spot report (T05g)", () => {
  it("labels the upgrade metrics not applicable and still counts insolvency and tiers", () => {
    const { summary, reports } = runSmoke({ seeds: 2, firstSeed: 1, days: DEFAULT_DAYS });
    expect(summary.strategy).toBe(STRATEGY.name);
    expect(summary.takesContracts).toBe(false);
    for (const r of reports) {
      expect(r.takesContracts).toBe(false);
      expect(r.firstUpgrade).toBeNull();
      expect(r.contractsAccepted).toBe(0);
      expect(r.victory).toBeNull();
      // Never past the first tier: no contract, so never reputation 10.
      expect(r.tierReached[GAME_DATA.progression.tiers[1]!.id]).toBeNull();
    }
    const text = formatSmokeReport(summary, reports);
    expect(text).toContain(`| First affordable upgrade (bought) | ${NOT_APPLICABLE} |`);
    expect(text).toContain(`| Upgrade earned (profit ≥ price) | ${NOT_APPLICABLE} |`);
    expect(text).toContain("N/A first upgrade and upgrade earned");
    expect(text).toContain("| Insolvent (GAME_LOST) |");
    expect(text).toContain("insolvency (GAME_LOST): 0/2 seeds");
  });

  it("reads the victory net worth from game-data", () => {
    const data = { ...GAME_DATA, progression: { ...GAME_DATA.progression, victory: { ...GAME_DATA.progression.victory, netWorth: cents(123_456) } } };
    const { summary, reports } = runSmoke({ seeds: 1, firstSeed: 1, days: 2 });
    expect(formatSmokeReport(summary, reports, data)).toContain("GDD §4 victory $1,234.56");
  });
});

describe("contract-taking strategy (T05g)", () => {
  const days = 15;
  // Seeds that win inside the 15 days. Since T07d (#126) tuned for a 60–85% win rate,
  // some seeds miss the session (seed 1 does), so these name winning ones.
  const firstSeed = 2;

  it("takes contracts, climbs every tier, buys both upgrades in order, and wins without a rejection", () => {
    const r = runSmokeSeed(firstSeed, { days, strategy: CONTRACT_STRATEGY.name });
    expect(r.strategy).toBe(CONTRACT_STRATEGY.name);
    expect(r.takesContracts).toBe(true);
    expect(r.contractsAccepted).toBeGreaterThanOrEqual(2);
    expect(r.contractsCompleted).toBeGreaterThanOrEqual(1);
    expect(r.installments.MISSED).toBe(0);
    const [, tier2, tier3, tier4] = GAME_DATA.progression.tiers.map((t) => r.tierReached[t.id]);
    expect(tier2).not.toBeNull();
    expect(tier3).not.toBeNull();
    expect(tier4).not.toBeNull();
    // Each upgrade on or after the tier that unlocks it.
    expect(r.firstUpgrade!.tick).toBeGreaterThanOrEqual(tier2!.tick);
    expect(r.qualityUpgrade!.tick).toBeGreaterThanOrEqual(tier3!.tick);
    expect(r.victory).not.toBeNull();
    expect(r.victory!.tick).toBeGreaterThanOrEqual(tier3!.tick);
    expect(r.lost).toBeNull();
    expect(r.rejections).toEqual({});
    expect(r.finalReputation).toBeGreaterThanOrEqual(GAME_DATA.progression.victory.reputation);
  });

  it("is deterministic and reports victory, tiers, and upgrade timing", () => {
    const one = runSmoke({ seeds: 2, firstSeed, days, strategy: CONTRACT_STRATEGY.name });
    const two = runSmoke({ seeds: 2, firstSeed, days, strategy: CONTRACT_STRATEGY.name });
    const text = formatSmokeReport(one.summary, one.reports);
    expect(formatSmokeReport(two.summary, two.reports)).toBe(text);
    expect(one.summary.takesContracts).toBe(true);
    expect(one.summary.victory?.n).toBe(2);
    for (const t of GAME_DATA.progression.tiers) expect(text).toContain(`| Tier reached: ${t.id} |`);
    expect(text).toContain("victory (");
    expect(text).toContain("first meaningful upgrade (condenser bought at tier 2");
    expect(text).not.toContain(NOT_APPLICABLE);
  });

  it("acts only through dispatch: buys inputs and starts a half-day run at the opening", () => {
    const sim = newGame();
    const sent: GameCommand[] = [];
    const gateway = {
      dispatch(request: CommandRequest): CommandResult {
        sent.push(request.command);
        return sim.dispatch(request);
      },
      snapshot: (): GameSnapshot => sim.snapshot(),
    };
    const bot = new ContractTakerStrategy(sim.snapshot());
    bot.act(gateway);
    expect(sent.map((c) => c.type)).toEqual(["PURCHASE_MATERIALS", "PURCHASE_MATERIALS", "START_PRODUCTION"]);
    const start = sent[2]!;
    if (start.type !== "START_PRODUCTION") throw new Error("expected a start");
    expect(start.quantity).toBe(Math.ceil(sim.snapshot().facilities[0]!.productionCapacityPerDay / CONTRACT_STRATEGY.runsPerDay));
    expect(bot.log.rejections).toEqual({});
  });
});

describe("smoke CLI", () => {
  it("parses its flags", () => {
    const greedy = STRATEGY.name;
    expect(parseSmokeArgs([])).toEqual({ seeds: 1, firstSeed: 1, days: DEFAULT_DAYS, strategy: greedy, json: false });
    expect(parseSmokeArgs(["--seeds", "50"])).toEqual({ seeds: 50, firstSeed: 1, days: DEFAULT_DAYS, strategy: greedy, json: false });
    expect(parseSmokeArgs(["--", "--seeds=5", "--days", "3", "--first-seed", "100", "--json"])).toEqual({
      seeds: 5,
      firstSeed: 100,
      days: 3,
      strategy: greedy,
      json: true,
    });
    expect(parseSmokeArgs(["--seeds", "50", "--strategy", "contract-taker", "--days", "15"])).toEqual({
      seeds: 50,
      firstSeed: 1,
      days: 15,
      strategy: CONTRACT_STRATEGY.name,
      json: false,
    });
    expect(parseSmokeArgs(["--strategy=greedy-spot"]).strategy).toBe(greedy);
  });

  it("rejects bad flags", () => {
    expect(() => parseSmokeArgs(["--seeds"])).toThrow(SmokeArgsError);
    expect(() => parseSmokeArgs(["--seeds", "0"])).toThrow(SmokeArgsError);
    expect(() => parseSmokeArgs(["--days", "1.5"])).toThrow(SmokeArgsError);
    expect(() => parseSmokeArgs(["--speed", "4"])).toThrow(SmokeArgsError);
    expect(() => parseSmokeArgs(["--strategy"])).toThrow(SmokeArgsError);
    expect(() => parseSmokeArgs(["--strategy", "volume-producer"])).toThrow(SmokeArgsError);
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
