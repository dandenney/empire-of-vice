import { tick, TICKS_PER_DAY, type CommandRequest, type GameEvent, type Money, type CommandResult, type EquipmentId, type GameCommand, type GameSnapshot, type RouteId } from "@eov/contracts";
import { BASIC_MOONSHINE_RECIPE, COUNTY_ROAD, FIRST_SHIPMENT_SCENARIO, GAME_DATA, QC_STATION, STATE_HIGHWAY, type ScenarioDefinition } from "@eov/game-data";
import type { KernelSimulation } from "@eov/simulation";
import { describe, expect, it } from "vitest";
import { isModerateLoss, replayStateHash, runBatchSeed, RunObserver, type BatchRunResult } from "../src/batch-run.ts";
import { batchMain, batchTasks, formatBatchFile, parseBatchArgs, runBatch, runBatchParallel, runBatchTask, BatchArgsError, DEFAULT_BATCH_OUT, type BatchIo } from "../src/batch.ts";
import { HEADLESS_STRATEGY_NAMES } from "../src/headless-strategy.ts";
import { StrategyRng } from "../src/prng.ts";
import { SETBACK_SCENARIO, SETBACK_SHAKEDOWN } from "../src/setback-scenario.ts";
import { TICKS_PER_REAL_MINUTE } from "../src/smoke-run.ts";
import { TARGETS } from "../src/targets.ts";

interface Sent {
  readonly command: GameCommand;
  readonly result: CommandResult;
  readonly tick: number;
}

/** A gateway that records every command and its result, passing it to the real game. */
function recorder(): { sent: Sent[]; wrap: (sim: KernelSimulation) => { dispatch(r: CommandRequest): CommandResult; snapshot(): GameSnapshot } } {
  const sent: Sent[] = [];
  return {
    sent,
    wrap: (sim) => ({
      dispatch(request) {
        const tick = sim.state.tick;
        const result = sim.dispatch(request);
        sent.push({ command: request.command, result, tick });
        return result;
      },
      snapshot: () => sim.snapshot(),
    }),
  };
}

const tierId = (index: number): string => GAME_DATA.progression.tiers[index]!.id;
const qcUnlock = GAME_DATA.equipment.find((e) => e.id === QC_STATION)!.requiredUnlockId;

describe("strategy PRNG", () => {
  it("is a pure function of seed and stream, and stays in range", () => {
    const draws = (seed: number, stream: string): number[] => {
      const rng = new StrategyRng(seed, stream);
      return Array.from({ length: 50 }, () => rng.between(3, 9));
    };
    expect(draws(1, "a")).toEqual(draws(1, "a"));
    expect(draws(1, "a")).not.toEqual(draws(2, "a"));
    expect(draws(1, "a")).not.toEqual(draws(1, "b"));
    for (const n of draws(7, "x")) expect(n >= 3 && n <= 9).toBe(true);
    expect(new Set(draws(7, "x")).size).toBeGreaterThan(1);
    expect(() => new StrategyRng(1.5, "a")).toThrow(RangeError);
  });
});

describe("headless strategies", () => {
  it.each(HEADLESS_STRATEGY_NAMES.flatMap((name) => [1, 2].map((seed) => [name, seed] as const)))("%s (seed %i) acts only through dispatch, and every accepted command is in the log", (name, seed) => {
    const { sent, wrap } = recorder();
    let game: KernelSimulation | null = null;
    const r = runBatchSeed(name, seed, {
      gateway: (sim) => {
        game = sim;
        return wrap(sim);
      },
    });
    const accepted = sent.filter((s) => s.result.status !== "rejected");
    expect(accepted.length).toBeGreaterThan(0);
    // Every command the run applied came through the strategy's gateway, and nothing else touched state.
    expect(game!.state.commandLog.map((e) => e.command)).toEqual(accepted.map((s) => s.command));
    expect(r.invariantViolationCount).toBe(0);
    expect(r.replayDiverged).toBe(false);
    expect(r.replayStateHash).toBe(r.stateHash);
    // Only the Quality Specialist presses a locked button, and only LOCKED comes back.
    const rejected = Object.keys(r.rejections);
    expect(rejected).toEqual(name === "quality-specialist" ? ["LOCKED"] : []);
  });

  it("the Quality Specialist is refused the QC station with LOCKED before the unlock, then buys it after earning it", () => {
    const { sent, wrap } = recorder();
    const r = runBatchSeed("quality-specialist", 1, { gateway: wrap });
    const qc = sent.filter((s) => s.command.type === "PURCHASE_EQUIPMENT" && s.command.equipmentId === (QC_STATION as EquipmentId));
    const first = qc[0]!;
    expect(first.result).toMatchObject({ status: "rejected", reason: { code: "LOCKED", unlockId: qcUnlock } });
    const bought = qc.find((s) => s.result.status !== "rejected");
    expect(bought).toBeDefined();
    // Bought legitimately: after the tier that grants the unlock, never before.
    const grantingTier = GAME_DATA.progression.tiers.findIndex((t) => t.unlocks.includes(qcUnlock!));
    const reached = r.tierReached[tierId(grantingTier)];
    expect(reached).not.toBeNull();
    expect(bought!.tick).toBeGreaterThanOrEqual(reached!.tick);
    expect(first.tick).toBeLessThan(reached!.tick);
    // Every refusal came before the unlock.
    for (const s of qc.filter((x) => x.result.status === "rejected")) expect(s.tick).toBeLessThan(reached!.tick);
  });

  it("strategies make different choices on the same seed, and seeds spread a strategy's choices", () => {
    const runs = HEADLESS_STRATEGY_NAMES.map((name) => runBatchSeed(name, 3));
    expect(new Set(runs.map((r) => r.stateHash)).size).toBe(HEADLESS_STRATEGY_NAMES.length);
    const seeds = [1, 2, 3, 4, 5, 6].map((seed) => runBatchSeed("contract-operator", seed));
    expect(new Set(seeds.map((r) => JSON.stringify(r.variant))).size).toBeGreaterThan(1);
    expect(new Set(seeds.map((r) => r.stateHash)).size).toBe(seeds.length);
  });

  it("the Market Opportunist routes around closed roads; the Contract Operator waits for them", () => {
    // Close the default roads to the Crossroads and Kessler's for the first three days.
    const closures: ScenarioDefinition["scheduledEvents"] = [STATE_HIGHWAY, COUNTY_ROAD].map((routeId) => ({
      kind: "ROUTE_CLOSURE" as const,
      tick: tick(1),
      routeId: routeId as RouteId,
      reason: "RIVAL" as const,
      durationTicks: 3 * TICKS_PER_DAY,
    }));
    const scenario: ScenarioDefinition = { ...FIRST_SHIPMENT_SCENARIO, scheduledEvents: closures };
    const routesUsed = (name: (typeof HEADLESS_STRATEGY_NAMES)[number]): (RouteId | null)[] => {
      const { sent, wrap } = recorder();
      runBatchSeed(name, 1, { scenario, gateway: wrap, days: 3 });
      return sent.flatMap((s) => (s.command.type === "DISPATCH_DELIVERY" && s.result.status !== "rejected" ? [s.command.routeId] : []));
    };
    expect(routesUsed("market-opportunist").some((id) => id !== null)).toBe(true);
    expect(routesUsed("contract-operator").every((id) => id === null)).toBe(true);
  });

  it("the Volume Producer makes only basic moonshine and takes only basic contracts", () => {
    const { sent, wrap } = recorder();
    runBatchSeed("volume-producer", 1, { gateway: wrap, days: 15 });
    for (const s of sent) {
      if (s.command.type === "START_PRODUCTION") expect(s.command.recipeId).toBe(BASIC_MOONSHINE_RECIPE);
      if (s.command.type === "PURCHASE_EQUIPMENT") expect(s.command.equipmentId).not.toBe(QC_STATION);
    }
    expect(sent.some((s) => s.command.type === "ACCEPT_CONTRACT")).toBe(true);
  });
});

describe("batch run", () => {
  it("is deterministic and records the metrics", () => {
    const a = runBatchSeed("contract-operator", 2);
    expect(runBatchSeed("contract-operator", 2)).toEqual(a);
    expect(a.outcome).toBe("WON");
    expect(a.outcomeTick).toBe(a.endTick);
    expect(a.victory!.tick).toBe(a.outcomeTick);
    expect(a.victory!.realMinutes).toBe(a.victory!.tick / TICKS_PER_REAL_MINUTE);
    expect(a.finalNetWorth).toBeGreaterThanOrEqual(GAME_DATA.progression.victory.netWorth);
    expect(a.finalReputation).toBeGreaterThanOrEqual(GAME_DATA.progression.victory.reputation);
    expect(a.contractsCompleted).toBeGreaterThanOrEqual(GAME_DATA.progression.victory.completedContracts);
    expect(a.tierReached[tierId(0)]).toEqual({ tick: 0, realMinutes: 0 });
    expect(a.firstProfitableSale).not.toBeNull();
    expect(a.firstUpgrade).not.toBeNull();
    expect(a.cashTrough.cash).toBeLessThanOrEqual(a.finalCash);
    expect(a.unitsSold).toBeLessThanOrEqual(a.casesProduced);
    expect(a.grossProfit).toBeLessThanOrEqual(a.revenue);
    expect(Object.keys(a.losses)).toEqual(["seizures", "failedProduction", "penalties", "belowCostSales", "transport"]);
    expect(a.losses.transport).toBeGreaterThan(0);
  });

  it("stops at the day cap when nothing ends the game first", () => {
    const r = runBatchSeed("volume-producer", 1, { days: 2 });
    expect(r.outcome).toBe("DAY_CAP");
    expect(r.outcomeTick).toBeNull();
    expect(r.endTick).toBe(2 * TICKS_PER_DAY);
    expect(() => runBatchSeed("volume-producer", 1, { days: 0 })).toThrow(RangeError);
  });

  it("replays a run's command log to the same state hash", () => {
    let game: KernelSimulation | null = null;
    const r = runBatchSeed("market-opportunist", 4, {
      gateway: (sim) => {
        game = sim;
        return sim;
      },
    });
    expect(game!.state.commandLog.length).toBeGreaterThan(0);
    expect(replayStateHash(game!, { scenario: { ...FIRST_SHIPMENT_SCENARIO, seed: 4 }, data: GAME_DATA })).toBe(r.stateHash);
  });
});

describe("batch CLI", () => {
  function memoryIo(): BatchIo & { files: Map<string, string>; errors: string[] } {
    const files = new Map<string, string>();
    const errors: string[] = [];
    let t = 0;
    return { files, errors, write: (path, text) => files.set(path, text), out: () => {}, err: (line) => errors.push(line), now: () => (t += 1_000) };
  }

  it("parses its flags", () => {
    expect(parseBatchArgs(["--seeds", "5"])).toMatchObject({ seeds: 5, days: 30, strategy: null, out: DEFAULT_BATCH_OUT });
    expect(parseBatchArgs(["--", "--seeds=2", "--strategy", "market-opportunist", "--days", "3", "--out", "x.json", "--jobs", "1"])).toEqual({
      seeds: 2,
      days: 3,
      strategy: "market-opportunist",
      out: "x.json",
      jobs: 1,
    });
    expect(() => parseBatchArgs([])).toThrow(BatchArgsError);
    expect(() => parseBatchArgs(["--seeds", "0"])).toThrow(BatchArgsError);
    expect(() => parseBatchArgs(["--seeds", "1", "--strategy", "greedy-spot"])).toThrow(BatchArgsError);
    expect(() => parseBatchArgs(["--seeds", "1", "--out"])).toThrow(BatchArgsError);
    expect(() => parseBatchArgs(["--seeds", "1", "--speed", "4"])).toThrow(BatchArgsError);
  });

  it("writes a byte-identical file for the same arguments, on one thread or several", async () => {
    const args = { seeds: 2, days: 4, strategy: null };
    const one = formatBatchFile(runBatch(args));
    expect(formatBatchFile(runBatch(args))).toBe(one);
    expect(formatBatchFile(await runBatchParallel(args, 3))).toBe(one);
    const io = memoryIo();
    expect(await batchMain(["--seeds", "2", "--days", "4", "--out", "a.json", "--jobs", "2"], io)).toBe(0);
    expect([...io.files.values()]).toEqual([one]);
    const parsed = JSON.parse(one) as { runs: BatchRunResult[]; summary: { strategy: string }[]; setback: { runs: BatchRunResult[]; summary: { strategy: string }[] } };
    const tasks = batchTasks(args);
    expect(tasks.map((t) => t.scenario)).toEqual([...Array<string>(8).fill("first-shipment"), ...Array<string>(8).fill("setback")]);
    const of = (scenario: string) => tasks.filter((t) => t.scenario === scenario).map((t) => [t.strategy, t.seed]);
    expect(parsed.runs.map((r) => [r.strategy, r.seed])).toEqual(of("first-shipment"));
    expect(parsed.setback.runs.map((r) => [r.strategy, r.seed])).toEqual(of("setback"));
    expect(parsed.summary.map((s) => s.strategy)).toEqual([...HEADLESS_STRATEGY_NAMES]);
    expect(parsed.setback.summary.map((s) => s.strategy)).toEqual([...HEADLESS_STRATEGY_NAMES]);
  });

  it("runs one strategy when asked", () => {
    const file = runBatch({ seeds: 2, days: 2, strategy: "quality-specialist" });
    expect(file.strategies).toEqual(["quality-specialist"]);
    expect(file.runs.map((r) => r.strategy)).toEqual(["quality-specialist", "quality-specialist"]);
  });

  it("exits non-zero when a run breaks an invariant", async () => {
    const io = memoryIo();
    const code = await batchMain(["--seeds", "1", "--days", "1", "--strategy", "contract-operator", "--out", "v.json"], io, {
      checks: { invariants: () => [{ code: "NEGATIVE_CASH", cash: -1 } as never] },
    });
    expect(code).toBe(1);
    const file = JSON.parse(io.files.values().next().value!) as { runs: BatchRunResult[]; summary: { runsWithInvariantViolations: number }[] };
    expect(file.runs[0]!.invariantViolationCount).toBeGreaterThan(0);
    expect(file.runs[0]!.invariantViolations[0]!.code).toBe("NEGATIVE_CASH");
    expect(file.summary[0]!.runsWithInvariantViolations).toBe(1);
    // The setback scenario's run is checked too.
    expect(io.errors.join("\n")).toContain("2 run(s) broke an invariant");
  });

  it("exits non-zero when a replay diverges", async () => {
    const io = memoryIo();
    const code = await batchMain(["--seeds", "1", "--days", "1", "--strategy", "volume-producer", "--out", "r.json"], io, {
      checks: { replay: () => "not-the-hash" },
    });
    expect(code).toBe(1);
    const file = JSON.parse(io.files.values().next().value!) as { runs: BatchRunResult[] };
    expect(file.runs[0]!.replayDiverged).toBe(true);
    expect(io.errors.join("\n")).toContain("2 replay(s) diverged");
  });

  it("exits 0 for a clean batch and 2 for bad arguments", async () => {
    expect(await batchMain(["--seeds", "1", "--days", "1", "--out", "ok.json", "--jobs", "1"], memoryIo())).toBe(0);
    expect(await batchMain(["--seeds"], memoryIo())).toBe(2);
  });
});

// Crafted events for RunObserver: only the fields it reads are meaningful.
const sale = (t: number, revenue: number, costOfGoodsSold: number): GameEvent =>
  ({
    type: "SALE_COMPLETED",
    tick: t,
    cargo: [{ productId: "moonshine", quality: "basic", quantity: 2 }],
    unitPrice: revenue / 2,
    revenue,
    costOfGoodsSold,
  }) as unknown as GameEvent;
const seizure = (t: number, bookValue: number): GameEvent => ({ type: "CARGO_LOST", tick: t, cargo: [], bookValue }) as unknown as GameEvent;

describe("run observer (#127)", () => {
  it("classifies a sale below cost apart from break-even and profitable", () => {
    const o = new RunObserver({}, 100_000 as Money);
    o.observe([sale(10, 900, 1_000), sale(20, 1_000, 1_000), sale(30, 1_100, 1_000), sale(40, 500, 1_000)]);
    const s = o.salesByProduct()["moonshine/basic"]!;
    expect(s).toMatchObject({ completed: 4, belowCost: 2, breakEven: 1, units: 8, revenue: 3_500, costOfGoodsSold: 4_000 });
    // Only the two below-cost sales count as a loss: 100 + 500.
    expect(o.belowCostSales).toBe(600);
    // Neither a below-cost nor a break-even sale is the first profitable one.
    expect(o.firstProfitableSale?.tick).toBe(30);
  });

  it("ignores a small loss and judges a moderate one, from net worth at the last stop", () => {
    const threshold = (100_000 * TARGETS.moderateSetbackMinPercent) / 100;
    expect(isModerateLoss(threshold - 1, 100_000)).toBe(false);
    expect(isModerateLoss(threshold, 100_000)).toBe(true);
    // Once net worth is at or below zero, any loss is moderate.
    expect(isModerateLoss(1, 0)).toBe(true);

    const o = new RunObserver({}, 100_000 as Money);
    o.observe([seizure(10, threshold - 1)]);
    o.atStop(10, 100_000 as Money);
    expect([o.setbackCount, o.moderateSetbackCount]).toEqual([1, 0]);
    expect(o.setback()).toBeNull();
    o.atStop(20, 200_000 as Money);
    // Net worth at the last stop is now 200 000, so the same share needs twice the loss.
    o.observe([seizure(30, threshold)]);
    expect(o.setback()).toBeNull();
    o.observe([seizure(40, 2 * threshold)]);
    expect([o.setbackCount, o.moderateSetbackCount]).toEqual([3, 1]);
    expect(o.setback()).toEqual({ kind: "SEIZURE", tick: 40, loss: 2 * threshold, netWorthBefore: 200_000, recoveredAt: null });
    // Recovery: the first stop where net worth is back to its pre-setback level.
    o.atStop(50, 199_999 as Money);
    expect(o.setback()!.recoveredAt).toBeNull();
    o.atStop(60, 200_000 as Money);
    o.atStop(70, 150_000 as Money);
    expect(o.setback()!.recoveredAt).toBe(60);
    // A later moderate loss doesn't replace the first.
    o.observe([seizure(80, 100_000)]);
    expect(o.setback()!.tick).toBe(40);
    expect(o.moderateSetbackCount).toBe(2);
  });

  it("runBatchSeed computes recoveredAt as the first stop back at the pre-setback net worth", () => {
    // Market Opportunist seed 4 loses one small cargo to a seizure on the risky route (as of game-data at #127).
    const stops: { tick: number; netWorth: number }[] = [];
    const record = (s: GameSnapshot): void => void stops.push({ tick: s.clock.tick, netWorth: s.finance.netWorth });
    // At the default threshold the seizure is too small to judge.
    const plain = runBatchSeed("market-opportunist", 4);
    expect(plain.setbackCount).toBeGreaterThan(0);
    expect(plain.moderateSetbackCount).toBe(0);
    expect(plain.setback).toBeNull();
    // With the threshold at 0 every loss is judged; check the recorded values against the stops.
    const r = runBatchSeed("market-opportunist", 4, { setbackMinPercent: 0, onStop: record });
    const sb = r.setback!;
    expect(sb).not.toBeNull();
    const i = stops.findIndex((s) => s.tick >= sb.tick);
    expect(i).toBeGreaterThan(0);
    expect(sb.netWorthBefore).toBe(stops[i - 1]!.netWorth);
    const back = stops.slice(i).find((s) => s.netWorth >= sb.netWorthBefore);
    expect(sb.recoveredAt).toBe(back ? back.tick : null);
    expect(sb.recoveredAt).not.toBeNull();
    expect(sb.recoveredAt!).toBeGreaterThanOrEqual(sb.tick);
  });
});

const lossBooked = (t: number, amount: number, netWorthBefore: number, assessed = amount): GameEvent =>
  ({ type: "LOSS_BOOKED", tick: t, reason: "RIVAL", assessed, amount, netWorthBefore, transactionId: "transaction:1" }) as unknown as GameEvent;

describe("scheduled setbacks (#129)", () => {
  it("the observer takes a shakedown's net worth before it from the event, not the last stop", () => {
    const o = new RunObserver({}, 100_000 as Money);
    o.atStop(10, 100_000 as Money);
    // Net worth rose to 200 000 between stops; at the last stop's 100 000 a 20 000 loss would be 20%, but it's 10% of the event's.
    o.observe([lossBooked(20, 20_000, 200_000)]);
    expect([o.setbackCount, o.moderateSetbackCount]).toEqual([1, 0]);
    expect(o.setback()).toBeNull();
    // The shakedown is recorded whatever its size.
    expect(o.shakedown()).toEqual({ kind: "SHAKEDOWN", tick: 20, loss: 20_000, netWorthBefore: 200_000, recoveredAt: null });
    o.atStop(30, 199_999 as Money);
    o.atStop(40, 200_000 as Money);
    expect(o.shakedown()!.recoveredAt).toBe(40);
    // A moderate one is also the run's setback; a second shakedown doesn't replace the first.
    const m = new RunObserver({}, 100_000 as Money);
    m.observe([lossBooked(20, 40_000, 200_000), lossBooked(50, 1, 10)]);
    expect(m.setback()).toEqual({ kind: "SHAKEDOWN", tick: 20, loss: 40_000, netWorthBefore: 200_000, recoveredAt: null });
    expect(m.shakedown()!.tick).toBe(20);
    expect(m.setbackCount).toBe(2);
  });

  it("a shakedown that took nothing is recorded but isn't a loss event, even at net worth ≤ 0 (#156 review, N1)", () => {
    const o = new RunObserver({}, -5_000 as Money);
    o.observe([lossBooked(20, 0, -5_000, 0)]);
    expect([o.setbackCount, o.moderateSetbackCount]).toEqual([0, 0]);
    expect(o.setback()).toBeNull();
    expect(o.shakedown()).toEqual({ kind: "SHAKEDOWN", tick: 20, loss: 0, netWorthBefore: -5_000, recoveredAt: null });
    // Capped at no cash on a positive net worth: the same.
    const c = new RunObserver({}, 100_000 as Money);
    c.observe([lossBooked(20, 0, 100_000, 16_000)]);
    expect([c.setbackCount, c.moderateSetbackCount]).toEqual([0, 0]);
    expect(c.shakedown()!.loss).toBe(0);
  });

  it("the setback scenario is the First Shipment plus one moderate SHAKEDOWN on a fixed day", () => {
    expect(SETBACK_SCENARIO.scheduledEvents).toEqual([...FIRST_SHIPMENT_SCENARIO.scheduledEvents, SETBACK_SHAKEDOWN]);
    expect(SETBACK_SHAKEDOWN.kind).toBe("SHAKEDOWN");
    expect(SETBACK_SHAKEDOWN.netWorthSharePpm).toBeGreaterThanOrEqual(150_000);
    expect(SETBACK_SHAKEDOWN.netWorthSharePpm * 100).toBeGreaterThan(TARGETS.moderateSetbackMinPercent * 1_000_000);
    // Early enough that its recovery window closes by the win cutoff.
    expect(SETBACK_SHAKEDOWN.tick + TARGETS.setbackRecoveryWindowTicks).toBeLessThanOrEqual(TARGETS.winCutoffTicks);
    expect(FIRST_SHIPMENT_SCENARIO.scheduledEvents.some((e) => e.kind === "SHAKEDOWN")).toBe(false);
  });

  it("every strategy meets the shakedown, books min(cash, share of net worth) on its tick, and stops there", () => {
    const days = Math.ceil((SETBACK_SHAKEDOWN.tick + TARGETS.setbackRecoveryWindowTicks) / TICKS_PER_DAY);
    for (const strategy of HEADLESS_STRATEGY_NAMES) {
      const stops: { tick: number; cash: number; netWorth: number }[] = [];
      const r = runBatchTask(
        { scenario: "setback", strategy, seed: 1 },
        { days, onStop: (s) => void stops.push({ tick: s.clock.tick, cash: s.finance.cash, netWorth: s.finance.netWorth }) },
      );
      expect(r.invariantViolationCount).toBe(0);
      expect(r.replayDiverged).toBe(false);
      const sd = r.shakedown!;
      expect(sd).not.toBeNull();
      expect(sd.kind).toBe("SHAKEDOWN");
      expect(sd.tick).toBe(SETBACK_SHAKEDOWN.tick);
      const assessed = Math.round((sd.netWorthBefore * SETBACK_SHAKEDOWN.netWorthSharePpm) / 1_000_000);
      // The stop before it; nothing else happens on the shakedown tick in seed 1 before it, so cash there is what was capped against.
      const before = stops.filter((s) => s.tick < sd.tick).at(-1)!;
      expect(sd.loss).toBe(Math.min(assessed, before.cash));
      // The run stopped on the shakedown's tick, after it.
      const at = stops.find((s) => s.tick === sd.tick)!;
      expect(at.netWorth).toBe(sd.netWorthBefore - sd.loss);
      // The same seed on the First Shipment has no shakedown.
      expect(runBatchTask({ scenario: "first-shipment", strategy, seed: 1 }, { days: 1 }).shakedown).toBeNull();
    }
  });
});
