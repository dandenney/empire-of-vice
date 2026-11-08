import { TICKS_PER_DAY } from "@eov/contracts";
import { GAME_DATA, STANDARD_MOONSHINE_RECIPE } from "@eov/game-data";
import { beforeAll, describe, expect, it } from "vitest";
import type { BatchRunResult } from "../src/batch-run.ts";
import { formatBatchFile, runBatch, type BatchFile } from "../src/batch.ts";
import {
  evaluateTargets,
  formatBalanceReport,
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
import { TARGETS, TICKS_PER_REAL_MINUTE, victoryOf } from "../src/targets.ts";

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

  it("flags every GDD §13 target MET or MISSED, with a proposal for each MISSED one", () => {
    const targets = evaluateTargets(file);
    expect(targets.map((t) => t.id)).toEqual(ALL_TARGETS);
    const report = formatBalanceReport(file);
    for (const t of targets) {
      expect(["MET", "MISSED"]).toContain(t.verdict);
      expect(report).toContain(`| ${t.target} | ${t.goal} | ${t.measured} | **${t.verdict}** |`);
    }
    const proposals = report.slice(report.indexOf("## Tuning proposals"));
    for (const t of targets.filter((x) => x.verdict === "MISSED")) expect(proposals).toContain(`- **${t.target}**`);
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
    // Make each strategy win exactly one of its two runs: 50% everywhere, below the band, gap 0.
    let seen = new Map<string, number>();
    const half = withRuns(file, (r) => {
      const n = seen.get(r.strategy) ?? 0;
      seen.set(r.strategy, n + 1);
      return { ...r, outcome: n === 0 ? "WON" : "DAY_CAP" };
    });
    expect(verdict(half, "competent-success")).toBe("MISSED");
    expect(verdict(half, "dominant-advantage")).toBe("MET");
    // All win: above the band, and still no gap.
    const all = withRuns(file, (r) => ({ ...r, outcome: "WON" }));
    expect(verdict(all, "competent-success")).toBe("MISSED");
    expect(verdict(all, "dominant-advantage")).toBe("MET");
    // One strategy loses everything: a 100-point gap.
    seen = new Map();
    const lopsided = withRuns(file, (r) => ({ ...r, outcome: r.strategy === "volume-producer" ? "DAY_CAP" : "WON" }));
    expect(verdict(lopsided, "dominant-advantage")).toBe("MISSED");
    expect(evaluateTargets(lopsided).find((t) => t.id === "dominant-advantage")!.measured).toContain("100.00 points");
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
    const setback = (recoveredAfter: number | null) => (r: BatchRunResult): BatchRunResult => ({
      ...r,
      outcome: "WON",
      endTick: 20_000,
      setback: { kind: "SEIZURE", tick: 1_000, loss: 500 as never, netWorthBefore: 300_000 as never, recoveredAt: recoveredAfter === null ? null : 1_000 + recoveredAfter },
    });
    // Too few judged runs to call it MET, even when every one recovers.
    expect(file.runs.length).toBeLessThan(TARGETS.setbackMinJudgedRuns);
    expect(verdict(withRuns(file, setback(100)), "setback-recovery")).toBe("MISSED");
    const many: BatchFile = { ...file, runs: Array.from({ length: TARGETS.setbackMinJudgedRuns }, (_, i) => ({ ...file.runs[i % file.runs.length]!, seed: i + 1 })) };
    expect(verdict(withRuns(many, setback(TARGETS.setbackRecoveryWindowTicks)), "setback-recovery")).toBe("MET");
    expect(verdict(withRuns(many, setback(TARGETS.setbackRecoveryWindowTicks + 1)), "setback-recovery")).toBe("MISSED");
    expect(verdict(withRuns(many, setback(null)), "setback-recovery")).toBe("MISSED");
    // No setback anywhere: nothing to measure.
    expect(verdict(withRuns(many, (r) => ({ ...r, setback: null })), "setback-recovery")).toBe("MISSED");
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
