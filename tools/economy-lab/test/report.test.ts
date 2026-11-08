import { TICKS_PER_DAY } from "@eov/contracts";
import { GAME_DATA, STANDARD_MOONSHINE_RECIPE } from "@eov/game-data";
import { beforeAll, describe, expect, it } from "vitest";
import type { BatchRunResult } from "../src/batch-run.ts";
import { formatBatchFile, runBatch, summarizeStrategy, type BatchFile } from "../src/batch.ts";
import {
  evaluateTargets,
  formatBalanceReport,
  hasModerateSetback,
  setbackVerdict,
  integrityFailed,
  parseBatchFile,
  parseReportArgs,
  percentiles,
  reportMain,
  ReportArgsError,
  DEFAULT_REPORT_OUT,
  type ReportIo,
  type TargetId,
} from "../src/report.ts";
import { findings, summarize } from "../src/smoke-report.ts";
import { runSmokeSeed } from "../src/smoke-run.ts";
import { countsAsWin, isLateWin, TARGETS, TICKS_PER_REAL_MINUTE, victoryOf } from "../src/targets.ts";

const ALL_TARGETS: readonly TargetId[] = [
  "first-profitable-sale",
  "first-upgrade",
  "victory-time",
  "competent-success",
  "dominant-advantage",
  "setback-recovery",
  "reconciliation",
  "replay",
];

/** A real batch long enough for the contract strategies to win: 2 seeds × 4 strategies × 16 days. */
let file: BatchFile;
let text: string;
beforeAll(() => {
  file = runBatch({ seeds: 2, days: 16, strategy: null });
  text = formatBatchFile(file);
});

const withRuns = (f: BatchFile, map: (r: BatchRunResult, i: number) => BatchRunResult): BatchFile => ({ ...f, runs: f.runs.map(map) });
const verdict = (f: BatchFile, id: TargetId): string => evaluateTargets(f).find((t) => t.id === id)!.verdict;

function memoryIo(files: Record<string, string>): ReportIo & { written: Map<string, string>; errors: string[]; lines: string[] } {
  const written = new Map<string, string>();
  const errors: string[] = [];
  const lines: string[] = [];
  return {
    written,
    errors,
    lines,
    read: (path) => {
      const name = Object.keys(files).find((k) => path.endsWith(k));
      if (name === undefined) throw new Error(`ENOENT: ${path}`);
      return files[name]!;
    },
    write: (path, t) => written.set(path, t),
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
  };
}

describe("shared targets", () => {
  it("hold the GDD §13 numbers in ticks, and read victory from game-data", () => {
    expect(TICKS_PER_REAL_MINUTE).toBe(720);
    expect(TARGETS.firstProfitMaxTicks).toBe(5 * TICKS_PER_REAL_MINUTE);
    expect([TARGETS.firstUpgradeMinTicks, TARGETS.firstUpgradeMaxTicks]).toEqual([10 * TICKS_PER_REAL_MINUTE, 15 * TICKS_PER_REAL_MINUTE]);
    expect([TARGETS.victoryMinTicks, TARGETS.victoryMaxTicks]).toEqual([20 * TICKS_PER_REAL_MINUTE, 30 * TICKS_PER_REAL_MINUTE]);
    expect([TARGETS.competentSuccessMinPercent, TARGETS.competentSuccessMaxPercent, TARGETS.dominantAdvantageMaxPoints]).toEqual([60, 85, 20]);
    expect(victoryOf()).toBe(GAME_DATA.progression.victory);
  });
});

describe("percentiles", () => {
  it("uses nearest rank", () => {
    expect(percentiles([])).toBeNull();
    expect(percentiles([7])).toEqual({ n: 1, min: 7, p10: 7, p50: 7, p90: 7, max: 7 });
    const ten = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    expect(percentiles(ten)).toEqual({ n: 10, min: 1, p10: 1, p50: 5, p90: 9, max: 10 });
    expect(percentiles([...Array(100).keys()].map((i) => i + 1))).toMatchObject({ p10: 10, p50: 50, p90: 90 });
  });
});

describe("batch run fields the report reads", () => {
  it("records day-start lines, sales, and victory gates consistently", () => {
    for (const r of file.runs) {
      const days = Math.floor(r.endTick / TICKS_PER_DAY) + 1;
      expect(r.netWorthByDay).toHaveLength(days);
      for (const spots of Object.values(r.spotByDay)) expect(spots).toHaveLength(days);
      expect(Object.keys(r.spotByDay)).toHaveLength(2);
      const sales = Object.values(r.sales);
      expect(sales.reduce((n, s) => n + s.units, 0)).toBe(r.unitsSold);
      for (const s of sales) expect(s.belowCost + s.breakEven).toBeLessThanOrEqual(s.completed);
      if (r.victory) {
        for (const t of Object.values(r.victoryGates)) expect(t).not.toBeNull();
        expect(Math.max(...Object.values(r.victoryGates).map((t) => t!))).toBe(r.victory.tick);
      }
      if (r.setback) expect(r.setbackCount).toBeGreaterThan(0);
    }
    expect(file.runs.some((r) => r.victory !== null)).toBe(true);
  });
});

describe("balance report", () => {
  it("is byte-identical for the same results file", () => {
    const a = formatBalanceReport(parseBatchFile(text));
    const b = formatBalanceReport(parseBatchFile(text));
    expect(b).toBe(a);
    expect(formatBalanceReport(file)).toBe(a);
    const one = memoryIo({ "results.json": text });
    const two = memoryIo({ "results.json": text });
    expect(reportMain(["--in", "results.json", "--out", "r.md"], one)).toBe(0);
    expect(reportMain(["--in=results.json", "--out=r.md"], two)).toBe(0);
    expect([...one.written.values()]).toEqual([`${a}\n`]);
    expect([...two.written.values()]).toEqual([...one.written.values()]);
  });

  it("flags every GDD §13 target MET, MISSED or INSUFFICIENT EVIDENCE, with a proposal for each one not MET", () => {
    const targets = evaluateTargets(file);
    expect(targets.map((t) => t.id)).toEqual(ALL_TARGETS);
    const report = formatBalanceReport(file);
    for (const t of targets) {
      expect(["MET", "MISSED", "INSUFFICIENT EVIDENCE"]).toContain(t.verdict);
      expect(report).toContain(`| ${t.target} | ${t.goal} | ${t.measured} | **${t.verdict}** |`);
    }
    const proposals = report.slice(report.indexOf("## Tuning proposals"));
    for (const t of targets.filter((x) => x.verdict !== "MET")) expect(proposals).toContain(`- **${t.target}** (${t.verdict};`);
    for (const section of [
      "## Outcomes by strategy",
      "## Time to victory",
      "## Milestones",
      "## Cash troughs",
      "## Profitability",
      "## Sources of economic loss",
      "## Market lines (basic and standard moonshine)",
      "## Setbacks and recovery",
      "## Why victory times cluster",
      "## The Volume Producer",
    ]) {
      expect(report).toContain(section);
    }
    const standard = GAME_DATA.recipes.find((r) => r.id === STANDARD_MOONSHINE_RECIPE)!;
    expect(report).toContain(`| ${standard.productId}/${standard.quality} |`);
  });

  it("judges win rates against the competent band and the dominant-strategy gap", () => {
    const win = (r: BatchRunResult): BatchRunResult => ({ ...r, outcome: "WON", victory: { tick: TARGETS.winCutoffTicks, realMinutes: TARGETS.winCutoffTicks / TICKS_PER_REAL_MINUTE } });
    const noWin = (r: BatchRunResult): BatchRunResult => ({ ...r, outcome: "DAY_CAP", victory: null });
    // Make each strategy win exactly one of its two runs: 50% everywhere, below the band, gap 0.
    let seen = new Map<string, number>();
    const half = withRuns(file, (r) => {
      const n = seen.get(r.strategy) ?? 0;
      seen.set(r.strategy, n + 1);
      return n === 0 ? win(r) : noWin(r);
    });
    expect(verdict(half, "competent-success")).toBe("MISSED");
    expect(verdict(half, "dominant-advantage")).toBe("MET");
    // All win: above the band, and still no gap.
    const all = withRuns(file, win);
    expect(verdict(all, "competent-success")).toBe("MISSED");
    expect(verdict(all, "dominant-advantage")).toBe("MET");
    // One strategy loses everything: a 100-point gap.
    seen = new Map();
    const lopsided = withRuns(file, (r) => (r.strategy === "volume-producer" ? noWin(r) : win(r)));
    expect(verdict(lopsided, "dominant-advantage")).toBe("MISSED");
    expect(evaluateTargets(lopsided).find((t) => t.id === "dominant-advantage")!.measured).toContain("100.00 points");
  });

  it("counts a victory as a win only by the cutoff (game day 15), in every win rate", () => {
    expect(TARGETS.winCutoffTicks).toBe(TARGETS.victoryMaxTicks);
    expect(TARGETS.winCutoffTicks).toBe(15 * TICKS_PER_DAY);
    const wonAt = (tick: number) => (r: BatchRunResult): BatchRunResult => ({ ...r, outcome: "WON", victory: { tick, realMinutes: tick / TICKS_PER_REAL_MINUTE } });
    expect(countsAsWin(wonAt(TARGETS.winCutoffTicks)(file.runs[0]!))).toBe(true);
    expect(countsAsWin(wonAt(TARGETS.winCutoffTicks + 1)(file.runs[0]!))).toBe(false);
    expect(isLateWin(wonAt(TARGETS.winCutoffTicks + 1)(file.runs[0]!))).toBe(true);
    expect(countsAsWin({ outcome: "DAY_CAP", victory: null })).toBe(false);
    // Every run wins, one tick late: no strategy has a win, in the report or the batch summary.
    const late = withRuns(file, wonAt(TARGETS.winCutoffTicks + 1));
    const competent = evaluateTargets(late).find((t) => t.id === "competent-success")!;
    for (const s of file.strategies) expect(competent.measured).toContain(`${s} 0.00% (below)`);
    const summary = summarizeStrategy(file.strategies[0]!, late.runs);
    expect([summary.won, summary.wonLate, summary.winRatePercent]).toEqual([0, summary.runs, 0]);
    const report = formatBalanceReport(late);
    expect(report).toContain(`A run counts as a win only if victory comes by tick ${TARGETS.winCutoffTicks}`);
    // On the cutoff tick itself they all count.
    const onTime = withRuns(file, wonAt(TARGETS.winCutoffTicks));
    expect(summarizeStrategy(file.strategies[0]!, onTime.runs).winRatePercent).toBe(100);
  });

  it("judges time targets on the run medians", () => {
    const at = (tick: number) => ({ tick, realMinutes: tick / TICKS_PER_REAL_MINUTE });
    const timed = (fps: number, upgrade: number, victory: number): BatchFile =>
      withRuns(file, (r) => ({ ...r, firstProfitableSale: at(fps), firstUpgrade: at(upgrade), victory: at(victory) }));
    const good = timed(TARGETS.firstProfitMaxTicks, TARGETS.firstUpgradeMinTicks, TARGETS.victoryMaxTicks);
    expect([verdict(good, "first-profitable-sale"), verdict(good, "first-upgrade"), verdict(good, "victory-time")]).toEqual(["MET", "MET", "MET"]);
    const bad = timed(TARGETS.firstProfitMaxTicks + 1, TARGETS.firstUpgradeMaxTicks + 1, TARGETS.victoryMinTicks - 1);
    expect([verdict(bad, "first-profitable-sale"), verdict(bad, "first-upgrade"), verdict(bad, "victory-time")]).toEqual(["MISSED", "MISSED", "MISSED"]);
    // A run that never made a profitable sale misses the target, however fast the others were.
    expect(verdict(withRuns(good, (r, i) => (i === 0 ? { ...r, firstProfitableSale: null } : r)), "first-profitable-sale")).toBe("MISSED");
  });

  it("measures setback recovery: net worth back within the window, over enough judged runs", () => {
    // A moderate loss: 20% of net worth.
    const setback = (recoveredAfter: number | null, loss = 60_000) => (r: BatchRunResult): BatchRunResult => ({
      ...r,
      outcome: "WON",
      endTick: 20_000,
      setback: { kind: "SEIZURE", tick: 1_000, loss: loss as never, netWorthBefore: 300_000 as never, recoveredAt: recoveredAfter === null ? null : 1_000 + recoveredAfter },
    });
    // Exactly TARGETS.setbackMinJudgedRuns runs for every strategy.
    const many: BatchFile = {
      ...file,
      runs: Array.from({ length: TARGETS.setbackMinJudgedRuns * file.strategies.length }, (_, i) => ({ ...file.runs[i % file.runs.length]!, seed: i + 1 })),
    };
    for (const s of file.strategies) expect(many.runs.filter((r) => r.strategy === s)).toHaveLength(TARGETS.setbackMinJudgedRuns);
    expect(verdict(withRuns(many, setback(TARGETS.setbackRecoveryWindowTicks)), "setback-recovery")).toBe("MET");
    expect(verdict(withRuns(many, setback(TARGETS.setbackRecoveryWindowTicks + 1)), "setback-recovery")).toBe("MISSED");
    expect(verdict(withRuns(many, setback(null)), "setback-recovery")).toBe("MISSED");
    // A recovery inside the window doesn't count if the run went bankrupt.
    expect(verdict(withRuns(many, (r) => ({ ...setback(100)(r), outcome: "LOST" })), "setback-recovery")).toBe("MISSED");
    // A window that outlasts the run without a recovery isn't judged.
    expect(setbackVerdict(withRuns(many, (r) => ({ ...setback(null)(r), endTick: 1_000 + TARGETS.setbackRecoveryWindowTicks - 1 }))).judged).toBe(0);
  });

  it("judges only moderate setbacks: a loss under the threshold is ignored, one at it is judged", () => {
    const at = (loss: number) => (r: BatchRunResult): BatchRunResult => ({
      ...r,
      endTick: 20_000,
      setback: { kind: "PENALTY", tick: 1_000, loss: loss as never, netWorthBefore: 100_000 as never, recoveredAt: 1_100 },
    });
    const threshold = (100_000 * TARGETS.moderateSetbackMinPercent) / 100;
    expect(hasModerateSetback(at(threshold - 1)(file.runs[0]!))).toBe(false);
    expect(hasModerateSetback(at(threshold)(file.runs[0]!))).toBe(true);
    expect(setbackVerdict(withRuns(file, at(threshold - 1))).judged).toBe(0);
    expect(setbackVerdict(withRuns(file, at(threshold))).judged).toBe(file.runs.length);
  });

  it("says INSUFFICIENT EVIDENCE below the judged-run floor, pooled or for any one strategy", () => {
    const moderate = (r: BatchRunResult): BatchRunResult => ({
      ...r,
      outcome: "WON",
      endTick: 20_000,
      setback: { kind: "SEIZURE", tick: 1_000, loss: 60_000 as never, netWorthBefore: 300_000 as never, recoveredAt: 1_100 },
    });
    // Every judged run recovers, but there are too few of them.
    expect(file.runs.length).toBeLessThan(TARGETS.setbackMinJudgedRuns);
    const few = setbackVerdict(withRuns(file, moderate));
    expect(few.recovered).toBe(few.judged);
    expect(few.verdict).toBe("INSUFFICIENT EVIDENCE");
    // Enough pooled, but one strategy one run short.
    const n = TARGETS.setbackMinJudgedRuns * file.strategies.length;
    const many: BatchFile = { ...file, runs: Array.from({ length: n }, (_, i) => ({ ...file.runs[i % file.runs.length]!, seed: i + 1 })) };
    const short = file.strategies[0]!;
    let dropped = false;
    const oneShort = withRuns(many, (r) => {
      if (!dropped && r.strategy === short) {
        dropped = true;
        return { ...r, setback: null };
      }
      return moderate(r);
    });
    const sv = setbackVerdict(oneShort);
    expect(sv.per.find((p) => p.strategy === short)!.verdict).toBe("INSUFFICIENT EVIDENCE");
    expect(sv.per.filter((p) => p.strategy !== short).every((p) => p.verdict === "MET")).toBe(true);
    expect(sv.verdict).toBe("INSUFFICIENT EVIDENCE");
    // No setback anywhere: nothing to judge.
    expect(verdict(withRuns(many, (r) => ({ ...r, setback: null })), "setback-recovery")).toBe("INSUFFICIENT EVIDENCE");
    // The report says so, and proposes the scheduled scenario rather than tuning.
    const report = formatBalanceReport(oneShort);
    const t = evaluateTargets(oneShort).find((x) => x.id === "setback-recovery")!;
    expect(report).toContain(`| ${t.target} | ${t.goal} | ${t.measured} | **INSUFFICIENT EVIDENCE** |`);
    expect(report.slice(report.indexOf("## Tuning proposals"))).toContain(`- **${t.target}** (INSUFFICIENT EVIDENCE;`);
  });

  it("judges the first upgrade per strategy as well as pooled", () => {
    const at = (tick: number) => ({ tick, realMinutes: tick / TICKS_PER_REAL_MINUTE });
    const inWindow = withRuns(file, (r) => ({ ...r, firstUpgrade: at(TARGETS.firstUpgradeMinTicks) }));
    expect(verdict(inWindow, "first-upgrade")).toBe("MET");
    // One strategy late: the pooled median is still in the window, but the target is MISSED.
    const late = file.strategies[0]!;
    const oneLate = withRuns(inWindow, (r) => (r.strategy === late ? { ...r, firstUpgrade: at(TARGETS.firstUpgradeMaxTicks + 1) } : r));
    const t = evaluateTargets(oneLate).find((x) => x.id === "first-upgrade")!;
    expect(t.verdict).toBe("MISSED");
    expect(t.measured).toContain(`${late} ${(((TARGETS.firstUpgradeMaxTicks + 1) / TICKS_PER_REAL_MINUTE)).toFixed(1)} min (late)`);
  });

  it("fails on an invariant violation or a replay divergence, never on a missed balance target", () => {
    expect(integrityFailed(file)).toBe(false);
    const broken = withRuns(file, (r, i) => (i === 0 ? { ...r, invariantViolationCount: 1 } : r));
    const diverged = withRuns(file, (r, i) => (i === 0 ? { ...r, replayDiverged: true } : r));
    expect(verdict(broken, "reconciliation")).toBe("MISSED");
    expect(verdict(diverged, "replay")).toBe("MISSED");
    for (const bad of [broken, diverged]) {
      const io = memoryIo({ "bad.json": formatBatchFile(bad) });
      expect(reportMain(["--in", "bad.json", "--out", "bad.md"], io)).toBe(1);
      expect(io.written.size).toBe(1);
    }
    // The real file misses balance targets but exits 0.
    expect(evaluateTargets(file).some((t) => t.verdict === "MISSED")).toBe(true);
    expect(reportMain(["--in", "ok.json"], memoryIo({ "ok.json": text }))).toBe(0);
  });

  it("parses its flags and refuses bad input", () => {
    expect(parseReportArgs([])).toEqual({ in: "dist/batch-results.json", out: DEFAULT_REPORT_OUT });
    expect(parseReportArgs(["--", "--in", "a.json", "--out", "b.md"])).toEqual({ in: "a.json", out: "b.md" });
    expect(() => parseReportArgs(["--in"])).toThrow(ReportArgsError);
    expect(() => parseReportArgs(["--seeds", "4"])).toThrow(ReportArgsError);
    expect(() => parseBatchFile(JSON.stringify({ ...file, format: 1 }))).toThrow(ReportArgsError);
    expect(reportMain(["--in", "missing.json"], memoryIo({}))).toBe(2);
    expect(reportMain(["--in", "old.json"], memoryIo({ "old.json": JSON.stringify({ ...file, format: 1 }) }))).toBe(2);
    expect(reportMain(["--bogus"], memoryIo({}))).toBe(2);
  });
});

describe("smoke report fixes (#85, #118 reviews)", () => {
  it("counts completed sales, with break-even apart from below cost", () => {
    const r = runSmokeSeed(3);
    expect(r.salesCompleted).toBeGreaterThan(0);
    expect(r.belowCostSales + r.breakEvenSales).toBeLessThanOrEqual(r.salesCompleted);
    expect(r.standardMarket).toHaveLength(r.market.length);
    const tweaked = { ...r, salesCompleted: 40, belowCostSales: 2, breakEvenSales: 3 };
    const lines = findings(summarize([tweaked], [], r.days), [tweaked]);
    expect(lines).toContain("FLAG 2 of 40 completed sales were below cost of goods sold; 3 sold exactly at cost (break-even).");
    expect(lines.some((l) => l.startsWith("INFO moonshine/standard:"))).toBe(true);
  });

  it("leaves day 0 out of the margin averages", () => {
    const r = runSmokeSeed(3);
    const day0 = { ...r, daily: r.daily.map((d) => (d.day === 0 ? { ...d, grossProfit: -1_000_000 as never, netProfit: -1_000_000 as never } : d)) };
    expect(summarize([day0], [], r.days).grossProfitPerDay).toEqual(summarize([r], [], r.days).grossProfitPerDay);
    expect(summarize([day0], [], r.days).netProfitPerDay).toEqual(summarize([r], [], r.days).netProfitPerDay);
  });
});
