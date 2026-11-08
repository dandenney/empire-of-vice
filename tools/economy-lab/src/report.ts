// The GDD §13 balance report (T07c, issue #120):
//
//   pnpm --filter @eov/economy-lab report [--in dist/batch-results.json] [--out dist/balance-report.md]
//
// Reads a results file written by `batch` (T07b) and writes a Markdown report:
// every GDD §13 target flagged MET or MISSED with its measured value, then the
// distributions behind them (time to victory, win rates, bankruptcy and
// soft-lock rates, cash troughs, profitability, sources of loss, milestone and
// tier times), the basic and standard market lines, setbacks and recovery, why
// victory times cluster, the Volume Producer choice, and a tuning proposal for
// every MISSED target. Proposals only: nothing here changes game-data.
//
// The report is a pure function of the results file and game-data: no clock, no
// environment, keys in a fixed order. The same file gives a byte-identical
// report. The exit code is 1 when the file records an invariant violation or a
// replay divergence (the nightly workflow fails on those), 2 for bad arguments or
// an unreadable file, and 0 otherwise. Missed balance targets never fail it.

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { formatMoney, TICKS_PER_DAY, type Money } from "@eov/contracts";
import { BASIC_MOONSHINE_RECIPE, GAME_DATA, STANDARD_MOONSHINE_RECIPE, type GameData, type RecipeDefinition } from "@eov/game-data";
import type { BatchRunResult, SetbackKind } from "./batch-run.ts";
import { BATCH_FORMAT_VERSION, DEFAULT_BATCH_OUT, type BatchFile } from "./batch.ts";
import type { HeadlessStrategyName } from "./headless-strategy.ts";
import { unitCost } from "./smoke-report.ts";
import { TARGETS, TICKS_PER_REAL_MINUTE, victoryOf } from "./targets.ts";

/** Where the report goes by default, relative to the working directory (`dist/` is git-ignored). */
export const DEFAULT_REPORT_OUT = "dist/balance-report.md";

/** A day-capped run is soft-locked when net worth hasn't grown over this many final game days. */
export const SOFT_LOCK_DAYS = 5;

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/** Nearest-rank percentiles over integer values. */
export interface Percentiles {
  readonly n: number;
  readonly min: number;
  readonly p10: number;
  readonly p50: number;
  readonly p90: number;
  readonly max: number;
}

/** The nearest-rank p-th percentile of sorted values: the smallest value with at least p% of values at or below it. */
function rank(sorted: readonly number[], p: number): number {
  const index = Math.max(0, Math.ceil((p * sorted.length) / 100) - 1);
  return sorted[index]!;
}

export function percentiles(values: readonly number[]): Percentiles | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, min: sorted[0]!, p10: rank(sorted, 10), p50: rank(sorted, 50), p90: rank(sorted, 90), max: sorted.at(-1)! };
}

const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);

/** A share in percent with two decimals, from integer counts. */
const percent = (part: number, whole: number): number => (whole === 0 ? 0 : Math.round((part * 10_000) / whole) / 100);

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const minutes = (ticks: number): string => (ticks / TICKS_PER_REAL_MINUTE).toFixed(1);
const at = (ticks: number): string => `${ticks} (${minutes(ticks)} min)`;
const money = (cents: number): string => formatMoney(cents as Money);
const pct = (value: number): string => `${value.toFixed(2)}%`;
const row = (cells: readonly string[]): string => `| ${cells.join(" | ")} |`;
const align = (left: number, right: number): string => row([...Array<string>(left).fill("---"), ...Array<string>(right).fill("---:")]);

function pRow(label: string, p: Percentiles | null, total: number, show: (v: number) => string): string {
  if (!p) return row([label, `0/${total}`, "", "", "", "", ""]);
  return row([label, `${p.n}/${total}`, show(p.p10), show(p.p50), show(p.p90), show(p.min), show(p.max)]);
}

const P_HEADER = (first: string): string[] => [row([first, "Runs", "p10", "p50", "p90", "Min", "Max"]), align(1, 6)];

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

export type Verdict = "MET" | "MISSED";

export interface TargetResult {
  readonly id: TargetId;
  readonly target: string;
  readonly goal: string;
  readonly measured: string;
  readonly verdict: Verdict;
}

export type TargetId =
  | "first-profitable-sale"
  | "first-upgrade"
  | "victory-time"
  | "competent-success"
  | "dominant-advantage"
  | "setback-recovery"
  | "reconciliation"
  | "replay";

/** Per-strategy figures the targets and sections share. */
interface StrategyStats {
  readonly strategy: HeadlessStrategyName;
  readonly runs: readonly BatchRunResult[];
  readonly won: number;
  readonly lost: number;
  readonly dayCap: number;
  readonly softLocked: number;
  readonly winRate: number;
}

const isSoftLocked = (r: BatchRunResult): boolean => {
  if (r.outcome !== "DAY_CAP") return false;
  const last = r.netWorthByDay.length - 1;
  return last >= SOFT_LOCK_DAYS && r.netWorthByDay[last]! <= r.netWorthByDay[last - SOFT_LOCK_DAYS]!;
};

function stats(file: BatchFile): StrategyStats[] {
  return file.strategies.map((strategy) => {
    const runs = file.runs.filter((r) => r.strategy === strategy);
    const won = runs.filter((r) => r.outcome === "WON").length;
    return {
      strategy,
      runs,
      won,
      lost: runs.filter((r) => r.outcome === "LOST").length,
      dayCap: runs.filter((r) => r.outcome === "DAY_CAP").length,
      softLocked: runs.filter(isSoftLocked).length,
      winRate: percent(won, runs.length),
    };
  });
}

const ticksOf = (runs: readonly BatchRunResult[], pick: (r: BatchRunResult) => { readonly tick: number } | null): number[] =>
  runs.flatMap((r) => {
    const m = pick(r);
    return m ? [m.tick] : [];
  });

/** Whether a setback recovered within the window: net worth back to its pre-setback level, and the run not lost. */
const recovered = (r: BatchRunResult): boolean =>
  r.setback !== null && r.setback.recoveredAt !== null && r.setback.recoveredAt - r.setback.tick <= TARGETS.setbackRecoveryWindowTicks && r.outcome !== "LOST";

/** A setback whose window ran past the end of the run without a recovery can't be judged either way. */
const judgeable = (r: BatchRunResult): boolean =>
  r.setback !== null && (recovered(r) || r.outcome === "LOST" || r.endTick - r.setback.tick >= TARGETS.setbackRecoveryWindowTicks);

export function evaluateTargets(file: BatchFile): TargetResult[] {
  const all = file.runs;
  const per = stats(file);
  const out: TargetResult[] = [];
  const minutesGoal = (lo: number, hi: number): string => `${minutes(lo)}–${minutes(hi)} min (${lo}–${hi} ticks)`;

  const fps = percentiles(ticksOf(all, (r) => r.firstProfitableSale));
  const fpsAll = fps !== null && fps.n === all.length;
  out.push({
    id: "first-profitable-sale",
    target: "First profitable sale",
    goal: `≤ ${minutes(TARGETS.firstProfitMaxTicks)} min (${TARGETS.firstProfitMaxTicks} ticks), p90 over every run, and every run makes one`,
    measured: fps ? `p50 ${at(fps.p50)}, p90 ${at(fps.p90)}; ${fps.n}/${all.length} runs` : "never",
    verdict: fpsAll && fps!.p90 <= TARGETS.firstProfitMaxTicks ? "MET" : "MISSED",
  });

  const fu = percentiles(ticksOf(all, (r) => r.firstUpgrade));
  out.push({
    id: "first-upgrade",
    target: "First meaningful upgrade (first equipment bought)",
    goal: `median ${minutesGoal(TARGETS.firstUpgradeMinTicks, TARGETS.firstUpgradeMaxTicks)}`,
    measured: fu ? `p50 ${at(fu.p50)} (p10 ${minutes(fu.p10)}, p90 ${minutes(fu.p90)} min); ${fu.n}/${all.length} runs` : "never",
    verdict: fu !== null && fu.p50 >= TARGETS.firstUpgradeMinTicks && fu.p50 <= TARGETS.firstUpgradeMaxTicks ? "MET" : "MISSED",
  });

  const v = percentiles(ticksOf(all, (r) => r.victory));
  out.push({
    id: "victory-time",
    target: "M001 victory",
    goal: `median over winning runs ${minutesGoal(TARGETS.victoryMinTicks, TARGETS.victoryMaxTicks)}`,
    measured: v ? `p50 ${at(v.p50)} (p10 ${minutes(v.p10)}, p90 ${minutes(v.p90)} min); ${v.n}/${all.length} runs won` : "no run won",
    verdict: v !== null && v.p50 >= TARGETS.victoryMinTicks && v.p50 <= TARGETS.victoryMaxTicks ? "MET" : "MISSED",
  });

  const inBand = (s: StrategyStats): boolean => s.winRate >= TARGETS.competentSuccessMinPercent && s.winRate <= TARGETS.competentSuccessMaxPercent;
  out.push({
    id: "competent-success",
    target: "Competent strategy success",
    goal: `every strategy wins ${TARGETS.competentSuccessMinPercent}–${TARGETS.competentSuccessMaxPercent}% of its runs`,
    measured: per.map((s) => `${s.strategy} ${pct(s.winRate)}${inBand(s) ? "" : s.winRate < TARGETS.competentSuccessMinPercent ? " (below)" : " (above)"}`).join("; "),
    verdict: per.length > 0 && per.every(inBand) ? "MET" : "MISSED",
  });

  const rates = per.map((s) => s.winRate);
  const best = per.reduce<StrategyStats | null>((b, s) => (b === null || s.winRate > b.winRate ? s : b), null);
  const worst = per.reduce<StrategyStats | null>((w, s) => (w === null || s.winRate < w.winRate ? s : w), null);
  const gap = rates.length === 0 ? 0 : Math.max(...rates) - Math.min(...rates);
  out.push({
    id: "dominant-advantage",
    target: "Dominant strategy advantage",
    goal: `best win rate less worst < ${TARGETS.dominantAdvantageMaxPoints} percentage points`,
    measured: best && worst ? `${gap.toFixed(2)} points (${best.strategy} ${pct(best.winRate)}, ${worst.strategy} ${pct(worst.winRate)})` : "no runs",
    verdict: per.length > 1 && gap < TARGETS.dominantAdvantageMaxPoints ? "MET" : "MISSED",
  });

  const judged = all.filter(judgeable);
  const ok = judged.filter(recovered).length;
  const rate = percent(ok, judged.length);
  const strategiesHit = new Set(judged.map((r) => r.strategy));
  out.push({
    id: "setback-recovery",
    target: "Recovery from one moderate setback",
    goal:
      `≥ ${TARGETS.setbackRecoveryMinPercent}% of runs with a setback recover within ${minutes(TARGETS.setbackRecoveryWindowTicks)} min, ` +
      `over at least ${TARGETS.setbackMinJudgedRuns} judged runs (see "Setbacks and recovery")`,
    measured:
      judged.length === 0
        ? "no run had a setback, so nothing to measure"
        : `${ok}/${judged.length} runs recovered (${pct(rate)}); setbacks came from ${[...strategiesHit].join(", ")}` +
          (strategiesHit.size < per.length ? ` only (${strategiesHit.size} of ${per.length} strategies)` : ""),
    verdict: judged.length >= TARGETS.setbackMinJudgedRuns && rate >= TARGETS.setbackRecoveryMinPercent ? "MET" : "MISSED",
  });

  const violations = sum(all.map((r) => r.invariantViolationCount));
  const violatingRuns = all.filter((r) => r.invariantViolationCount > 0).length;
  out.push({
    id: "reconciliation",
    target: "Financial reconciliation failures",
    goal: "zero",
    measured: `${violations} invariant violation(s) in ${violatingRuns}/${all.length} runs`,
    verdict: violations <= TARGETS.reconciliationFailuresMax ? "MET" : "MISSED",
  });

  const diverged = all.filter((r) => r.replayDiverged).length;
  out.push({
    id: "replay",
    target: "Deterministic replay divergence",
    goal: "zero",
    measured: `${diverged}/${all.length} runs diverged on replay`,
    verdict: diverged <= TARGETS.replayDivergencesMax ? "MET" : "MISSED",
  });
  return out;
}

/** Whether the file records an integrity failure: an invariant violation or a replay divergence. */
export function integrityFailed(file: BatchFile): boolean {
  return file.runs.some((r) => r.invariantViolationCount > 0 || r.replayDiverged);
}

// ---------------------------------------------------------------------------
// Market lines
// ---------------------------------------------------------------------------

interface MarketLine {
  readonly key: string;
  readonly recipe: RecipeDefinition;
  readonly cost: Money;
  readonly basePrice: Money;
  readonly spot: Percentiles | null;
  readonly completed: number;
  readonly belowCost: number;
  readonly breakEven: number;
  readonly units: number;
  readonly grossPerCase: number;
}

function marketLines(file: BatchFile, data: GameData): MarketLine[] {
  return [BASIC_MOONSHINE_RECIPE, STANDARD_MOONSHINE_RECIPE].flatMap((id) => {
    const recipe = data.recipes.find((r) => r.id === id);
    if (!recipe) return [];
    const key = `${recipe.productId}/${recipe.quality}`;
    const sales = file.runs.flatMap((r) => (r.sales[key] ? [r.sales[key]] : []));
    const units = sum(sales.map((s) => s.units));
    const gross = sum(sales.map((s) => s.revenue - s.costOfGoodsSold));
    return [
      {
        key,
        recipe,
        cost: unitCost(recipe, data),
        basePrice: data.products.find((p) => p.id === recipe.productId)?.basePrice[recipe.quality] ?? (0 as Money),
        spot: percentiles(file.runs.flatMap((r) => r.spotByDay[key] ?? [])),
        completed: sum(sales.map((s) => s.completed)),
        belowCost: sum(sales.map((s) => s.belowCost)),
        breakEven: sum(sales.map((s) => s.breakEven)),
        units,
        grossPerCase: units === 0 ? 0 : Math.round(gross / units),
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

const SETBACK_KINDS: readonly SetbackKind[] = ["SEIZURE", "FAILED_RUN", "PENALTY"];
const GATES = ["netWorth", "reputation", "completedContracts"] as const;
type Gate = (typeof GATES)[number];

/** The victory condition that cleared last in a winning run (ties: the later one in GATES order). */
function lastGate(r: BatchRunResult): Gate | null {
  let last: Gate | null = null;
  for (const g of GATES) {
    const t = r.victoryGates[g];
    if (t === null) return null;
    if (last === null || t >= r.victoryGates[last]!) last = g;
  }
  return last;
}

export function formatBalanceReport(file: BatchFile, data: GameData = GAME_DATA): string {
  const per = stats(file);
  const targets = evaluateTargets(file);
  const goal = victoryOf(data);
  const lines: string[] = [];
  const total = file.runs.length;

  lines.push(
    `# Balance report: ${file.strategies.length} strategies × seeds ${file.seeds.first}..${file.seeds.last}, day cap ${file.days}`,
    "",
    `Game-data ${file.gameDataVersion} (report read with ${data.version}); results format ${file.format}; ${total} runs.`,
    `Times are ticks, with real minutes at 1× (${TICKS_PER_REAL_MINUTE} ticks a minute; a game day is ${TICKS_PER_DAY} ticks, ${minutes(TICKS_PER_DAY)} min).`,
    `Victory (game-data \`progression.victory\`): net worth ${money(goal.netWorth)}, reputation ${goal.reputation}, ${goal.completedContracts} completed contract(s).`,
    "",
  );
  if (file.gameDataVersion !== data.version) {
    lines.push(`> The results came from game-data ${file.gameDataVersion} but this report read ${data.version}: unit costs and base prices may not match the runs.`, "");
  }

  // Targets.
  const missed = targets.filter((t) => t.verdict === "MISSED");
  lines.push(
    "## GDD §13 targets",
    "",
    `${targets.length - missed.length} MET, ${missed.length} MISSED.`,
    "",
    row(["Target", "Goal", "Measured", "Verdict"]),
    align(4, 0),
  );
  for (const t of targets) lines.push(row([t.target, t.goal, t.measured, `**${t.verdict}**`]));
  lines.push("");
  const gate = targets.find((t) => t.id === "competent-success")!;
  const viable = per.filter((s) => s.won > 0).map((s) => s.strategy);
  lines.push(
    `M001 release gate "multiple viable strategies can reach victory": ${viable.length} of ${per.length} strategies won at least one run (${viable.join(", ") || "none"}). ` +
      (gate.verdict === "MET" ? "Every strategy is inside the competent-success band." : "The competent-success band is missed, so the gate's balance half is not yet shown."),
    "",
  );

  // Outcomes.
  lines.push("## Outcomes by strategy", "", row(["Strategy", "Runs", "Won", "Win rate", "Bankrupt (LOST)", "Day cap", "Soft-locked", "Net worth at end p50"]), align(1, 7));
  for (const s of per) {
    const nw = percentiles(s.runs.map((r) => r.finalNetWorth));
    lines.push(
      row([
        s.strategy,
        String(s.runs.length),
        String(s.won),
        pct(s.winRate),
        `${s.lost} (${pct(percent(s.lost, s.runs.length))})`,
        `${s.dayCap} (${pct(percent(s.dayCap, s.runs.length))})`,
        `${s.softLocked} (${pct(percent(s.softLocked, s.runs.length))})`,
        nw ? money(nw.p50) : "",
      ]),
    );
  }
  lines.push(
    "",
    `Bankrupt: the game declared insolvency (GAME_LOST). Day cap: neither won nor lost in ${file.days} days. ` +
      `Soft-locked: a day-capped run whose net worth didn't grow over its last ${SOFT_LOCK_DAYS} game days (stuck, not just slow).`,
    "",
  );

  // Time to victory.
  lines.push("## Time to victory", "", ...P_HEADER("Strategy"));
  for (const s of per) lines.push(pRow(s.strategy, percentiles(ticksOf(s.runs, (r) => r.victory)), s.runs.length, at));
  lines.push(pRow("**all**", percentiles(ticksOf(file.runs, (r) => r.victory)), total, at), "");

  // Milestones.
  lines.push("## Milestones", "", "Ticks (real minutes at 1×), over the runs that reached each milestone.", "");
  const milestones: [string, (r: BatchRunResult) => { readonly tick: number } | null][] = [
    ["First profitable sale", (r) => r.firstProfitableSale],
    ["First profit to date (after wages)", (r) => r.firstNetProfit],
    ["First upgrade (equipment bought)", (r) => r.firstUpgrade],
    ...data.progression.tiers.slice(1).map((t): [string, (r: BatchRunResult) => { readonly tick: number } | null] => [`Tier: ${t.id}`, (r) => r.tierReached[t.id] ?? null]),
  ];
  for (const s of per) {
    lines.push(`### ${s.strategy}`, "", ...P_HEADER("Milestone"));
    for (const [label, pick] of milestones) lines.push(pRow(label, percentiles(ticksOf(s.runs, pick)), s.runs.length, at));
    lines.push("");
  }

  // Cash troughs and profitability.
  lines.push("## Cash troughs", "", "The lowest cash each run held at any stop.", "", ...P_HEADER("Strategy"));
  for (const s of per) lines.push(pRow(s.strategy, percentiles(s.runs.map((r) => r.cashTrough.cash)), s.runs.length, money));
  lines.push("");
  lines.push("## Profitability", "", "Totals to the end of each run (victory, loss, or the day cap), p50 over runs.", "");
  lines.push(row(["Strategy", "Revenue", "Gross profit", "Net profit", "Units sold", "Cases produced", "Contracts completed"]), align(1, 6));
  for (const s of per) {
    const p50 = (pick: (r: BatchRunResult) => number): number => percentiles(s.runs.map(pick))?.p50 ?? 0;
    lines.push(
      row([
        s.strategy,
        money(p50((r) => r.revenue)),
        money(p50((r) => r.grossProfit)),
        money(p50((r) => r.netProfit)),
        String(p50((r) => r.unitsSold)),
        String(p50((r) => r.casesProduced)),
        String(p50((r) => r.contractsCompleted)),
      ]),
    );
  }
  lines.push("", "Net profit per run:", "", ...P_HEADER("Strategy"));
  for (const s of per) lines.push(pRow(s.strategy, percentiles(s.runs.map((r) => r.netProfit)), s.runs.length, money));
  lines.push("");

  // Losses.
  lines.push(
    "## Sources of economic loss",
    "",
    "Summed over every run of the strategy; in brackets, the runs that had any.",
    "",
    row(["Strategy", "Seizures", "Failed runs", "Penalties", "Below-cost sales", "Transport", "Installments partial / missed"]),
    align(1, 6),
  );
  const lossCell = (runs: readonly BatchRunResult[], pick: (r: BatchRunResult) => number): string =>
    `${money(sum(runs.map(pick)))} (${runs.filter((r) => pick(r) > 0).length})`;
  for (const s of per) {
    lines.push(
      row([
        s.strategy,
        lossCell(s.runs, (r) => r.losses.seizures),
        lossCell(s.runs, (r) => r.losses.failedProduction),
        lossCell(s.runs, (r) => r.losses.penalties),
        lossCell(s.runs, (r) => r.losses.belowCostSales),
        lossCell(s.runs, (r) => r.losses.transport),
        `${sum(s.runs.map((r) => r.installments.PARTIAL))} / ${sum(s.runs.map((r) => r.installments.MISSED))}`,
      ]),
    );
  }
  const seizing = per.filter((s) => s.runs.some((r) => r.losses.seizures > 0 || r.losses.penalties > 0)).map((s) => s.strategy);
  lines.push(
    "",
    seizing.length === 0
      ? "No strategy lost cargo to a seizure or paid a penalty: transport and below-cost sales are the only losses."
      : `Risk-driven losses (seizures and penalties) appear only for ${seizing.join(", ")}. ` +
          "The Market Opportunist alone takes the risky alternative route when the default is closed, so it alone can lose cargo.",
    "",
  );

  // Market lines.
  const markets = marketLines(file, data);
  lines.push(
    "## Market lines (basic and standard moonshine)",
    "",
    "Unit cost: ingredients at the cheapest supplier's normal price, plus labor and overhead per case. Spot: the quote at the start of every run-day. " +
      "Gross per case: realized (revenue − cost of goods sold) / units, over all completed sales, spot and contract.",
    "",
    row(["Product", "Unit cost", "Base price", "Margin at base", "Spot p10", "Spot p50", "Spot p90", "Spot min–max", "Swing vs margin", "Gross per case"]),
    align(1, 9),
  );
  for (const m of markets) {
    const margin = m.basePrice - m.cost;
    const swing = m.spot ? m.spot.max - m.spot.min : 0;
    lines.push(
      row([
        m.key,
        money(m.cost),
        money(m.basePrice),
        money(margin),
        m.spot ? money(m.spot.p10) : "",
        m.spot ? money(m.spot.p50) : "",
        m.spot ? money(m.spot.p90) : "",
        m.spot ? `${money(m.spot.min)}–${money(m.spot.max)}` : "",
        `${money(swing)} ${swing > margin ? "(FLAG: larger)" : "(smaller)"}`,
        money(m.grossPerCase),
      ]),
    );
  }
  lines.push("", row(["Product", "Completed sales", "Below cost", "Break-even", "Units"]), align(1, 4));
  for (const m of markets) {
    lines.push(row([m.key, String(m.completed), `${m.belowCost} (${pct(percent(m.belowCost, m.completed))})`, String(m.breakEven), String(m.units)]));
  }
  lines.push(
    "",
    "Sales are counted when they complete (SALE_COMPLETED), not when the truck is dispatched. Break-even (revenue = cost) is counted apart from below cost (revenue < cost).",
    "",
  );

  // Setbacks.
  const judged = file.runs.filter(judgeable);
  lines.push(
    "## Setbacks and recovery",
    "",
    "**Definition.** A run's *moderate setback* is the first event that books a loss: cargo seized on a risky route (CARGO_LOST), a production run's inputs written off (PRODUCTION_FAILED), " +
      "or an installment penalty (INSTALLMENT_SETTLED with a penalty). The run *recovers* if its net worth is back to at least its level just before the setback within " +
      `${at(TARGETS.setbackRecoveryWindowTicks)} (${TARGETS.setbackRecoveryWindowTicks / TICKS_PER_DAY} game days), and it doesn't go bankrupt. ` +
      "A run whose window outlasts the run without a recovery isn't judged. " +
      `"Usually possible" is read as at least ${TARGETS.setbackRecoveryMinPercent}% of judged runs recovering.`,
    "",
    row(["Strategy", "Runs with a setback", ...SETBACK_KINDS, "Judged", "Recovered", "Loss p50", "Recovery time p50", "Won after a setback"]),
    align(1, 9),
  );
  for (const s of per) {
    const hit = s.runs.filter((r) => r.setback !== null);
    const j = hit.filter(judgeable);
    const rec = j.filter(recovered);
    const loss = percentiles(hit.map((r) => r.setback!.loss));
    const time = percentiles(rec.map((r) => r.setback!.recoveredAt! - r.setback!.tick));
    lines.push(
      row([
        s.strategy,
        String(hit.length),
        ...SETBACK_KINDS.map((k) => String(hit.filter((r) => r.setback!.kind === k).length)),
        String(j.length),
        `${rec.length} (${pct(percent(rec.length, j.length))})`,
        loss ? money(loss.p50) : "",
        time ? at(time.p50) : "",
        `${hit.filter((r) => r.outcome === "WON").length}/${hit.length}`,
      ]),
    );
  }
  const closures = sum(file.runs.map((r) => r.disruptions.routeClosures));
  const shortages = sum(file.runs.map((r) => r.disruptions.shortages));
  const disrupted = file.runs.filter((r) => r.disruptions.routeClosures + r.disruptions.shortages > 0);
  lines.push(
    "",
    `Scheduled disruptions, which book no loss by themselves: ${closures} route closure(s) and ${shortages} supplier shortage(s) over ${total} runs; ` +
      `${disrupted.length} runs met at least one, and ${disrupted.filter((r) => r.outcome === "WON").length} of those won.`,
    "",
    `Only ${judged.length} of ${total} runs (${pct(percent(judged.length, total))}) had a judgeable setback, so the measure rests on the strategies that take risks. ` +
      "A lab scenario with a scheduled loss (for example a seizure on a fixed day for every strategy) would measure recovery for every strategy; see the proposals.",
    "",
  );

  // Victory clustering.
  lines.push(
    "## Why victory times cluster",
    "",
    "Victory needs all three conditions at once, and each one can only change at a few kinds of tick:",
    "",
    "- **Reputation and the completed contract** move only when an installment settles, at its deadline. Deadlines are fixed ticks set by when the offer was accepted, " +
      "and offers arrive on the contract system's schedule, so a run whose last condition is reputation or the contract wins exactly on a settlement tick. " +
      "The Quality Specialist's 18360 is one: the settlement that lifts it to the top tier's reputation.",
    "- **Net worth** moves when a sale completes, which is when the truck arrives. Runs and trips have fixed durations, so the delivery that crosses the threshold " +
      "lands on the same tick in every seed whose market lets the strategy load the same cargo at the same time.",
    "",
    "Either way the victory time is a step function of a few scheduled ticks, not a continuous quantity: the distribution has spikes rather than a spread, " +
      "and the medians below move in jumps when tuning changes which settlement or which delivery is the decisive one. Read the p10–p90 range with that in mind.",
    "",
    row(["Strategy", "Wins", "On a settlement tick", "Distinct victory ticks", "Most common tick", "Last to clear: net worth / reputation / contract"]),
    align(1, 5),
  );
  for (const s of per) {
    const wins = s.runs.filter((r) => r.victory !== null);
    const counts = new Map<number, number>();
    for (const r of wins) counts.set(r.victory!.tick, (counts.get(r.victory!.tick) ?? 0) + 1);
    let mode: [number, number] | null = null;
    for (const [t, n] of [...counts].sort((a, b) => a[0] - b[0])) if (mode === null || n > mode[1]) mode = [t, n];
    const last = (g: Gate): number => wins.filter((r) => lastGate(r) === g).length;
    lines.push(
      row([
        s.strategy,
        String(wins.length),
        `${wins.filter((r) => r.victoryOnSettlement).length} (${pct(percent(wins.filter((r) => r.victoryOnSettlement).length, wins.length))})`,
        String(counts.size),
        mode ? `${at(mode[0])} × ${mode[1]}` : "",
        `${last("netWorth")} / ${last("reputation")} / ${last("completedContracts")}`,
      ]),
    );
  }
  lines.push("", "Victory conditions met by the end of the run (any outcome):", "", row(["Strategy", `Net worth ≥ ${money(goal.netWorth)}`, `Reputation ≥ ${goal.reputation}`, `Contracts ≥ ${goal.completedContracts}`]), align(1, 3));
  for (const s of per) {
    const met = (g: Gate): string => `${s.runs.filter((r) => r.victoryGates[g] !== null).length}/${s.runs.length}`;
    lines.push(row([s.strategy, met("netWorth"), met("reputation"), met("completedContracts")]));
  }
  lines.push("");

  // Volume Producer.
  const vp = per.find((s) => s.strategy === "volume-producer");
  const basic = markets.find((m) => m.recipe.id === BASIC_MOONSHINE_RECIPE);
  const standard = markets.find((m) => m.recipe.id === STANDARD_MOONSHINE_RECIPE);
  if (vp && basic && standard) {
    lines.push(...volumeProducer(vp, basic, standard, goal.netWorth, goal.reputation, file.days));
  }

  // Proposals.
  lines.push("## Tuning proposals", "", "Proposals only. This report changes no game-data; the tuning task that follows it decides.", "");
  if (missed.length === 0) lines.push("Every target is MET; nothing to propose.");
  for (const t of missed) lines.push(`- **${t.target}** (${t.measured}): ${proposal(t.id, per, markets, file)}`);
  lines.push("", "Beyond the targets:", "");
  const setbackStrategies = new Set(file.runs.filter(judgeable).map((r) => r.strategy));
  if (setbackStrategies.size < per.length) {
    lines.push(
      `- **Setback evidence.** Only ${setbackStrategies.size} of ${per.length} strategies ever booked a loss, so the recovery measure says little about the others. ` +
        "A lab scenario with a scheduled loss on a fixed day, run for every strategy, would measure recovery directly. " +
        "A loss can only come from the simulation (a seizure, a failed run, or a penalty), so this needs a scenario or game-data hook the tuning task would own.",
    );
  }
  const spread = per.filter((s) => s.runs.length > 1 && new Set(s.runs.map((r) => r.firstUpgrade?.tick ?? -1)).size === 1).map((s) => s.strategy);
  if (spread.length > 0) {
    lines.push(
      `- **Seed spread.** ${spread.join(", ")} bought their first upgrade on the same tick in every seed: the tier gates and fixed durations, not the market, set early pacing. ` +
        "More seeded variety early on (offer timing, opening prices) would make the distributions above say more.",
    );
  }
  const basicMarket = markets.find((m) => m.recipe.id === BASIC_MOONSHINE_RECIPE);
  if (basicMarket?.spot && basicMarket.spot.max - basicMarket.spot.min > basicMarket.basePrice - basicMarket.cost) {
    lines.push(
      `- **Basic's margin is below its price swing.** Spot ranges ${money(basicMarket.spot.min)}–${money(basicMarket.spot.max)} against a ${money(basicMarket.basePrice - basicMarket.cost)} margin at base, ` +
        `so ${pct(percent(basicMarket.belowCost, basicMarket.completed))} of basic sales completed below cost. Widening basic's margin (or narrowing its demand drift) fixes both.`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function volumeProducer(vp: StrategyStats, basic: MarketLine, standard: MarketLine, victoryNetWorth: Money, victoryReputation: number, days: number): string[] {
  const nw = percentiles(vp.runs.map((r) => r.finalNetWorth));
  const units = percentiles(vp.runs.map((r) => r.unitsSold));
  const opening = vp.runs[0]?.netWorthByDay[0] ?? 0;
  const out = ["## The Volume Producer", ""];
  if (!nw || !units) return [...out, "No Volume Producer runs.", ""];
  const short = victoryNetWorth - nw.p50;
  // Rough: the extra margin per case that would have closed the median shortfall over the median run's sales.
  const extra = units.p50 === 0 ? 0 : Math.ceil(short / units.p50);
  out.push(
    `The Volume Producer won ${vp.won}/${vp.runs.length} runs. It makes basic moonshine only, at full capacity, and its median run ends at ${money(nw.p50)} net worth ` +
      `(opening ${money(opening)}, victory ${money(victoryNetWorth)}) after selling ${units.p50} cases in ${days} days. ` +
      `Basic's realized gross is ${money(basic.grossPerCase)} a case against standard's ${money(standard.grossPerCase)}; ` +
      `at base prices the margins are ${money(basic.basePrice - basic.cost)} and ${money(standard.basePrice - standard.cost)}. ` +
      `It reaches reputation ${victoryReputation} in ${vp.runs.filter((r) => r.victoryGates.reputation !== null).length}/${vp.runs.length} runs and completes a contract in ` +
      `${vp.runs.filter((r) => r.victoryGates.completedContracts !== null).length}/${vp.runs.length}; net worth is what it lacks. ` +
      "Volume can't make up a margin gap that wide inside the session, so the archetype is not viable as written. Two ways to settle it:",
    "",
    `1. **Keep it basic-only and tune basic's margin.** Closing the median shortfall (${money(short)}) by the day cap over its median ${units.p50} cases needs about ` +
      `${money(extra)} more margin a case; reaching victory inside 30 minutes (day ${Math.floor(TARGETS.victoryMaxTicks / TICKS_PER_DAY)}) needs roughly twice that, ` +
      "since it sells about half its cases by then (a linear estimate, not a simulation). Levers in game-data: basic's base price, its inputs or labor per case, or capacity. " +
      "Raising basic's margin also lifts every other strategy's early game, so the 100% win rates would climb further unless standard's margin comes down.",
    `2. **Redefine the archetype as volume of whatever is unlocked.** The strategy keeps its capacity-first upgrade order but switches its output to standard once it owns the QC station. ` +
      "This is a lab change only (no game-data), but it brings the Volume Producer close to the Contract Operator, so the four strategies would differ less.",
    "",
    "Either choice is a design call; the report doesn't make it.",
    "",
  );
  return out;
}

function proposal(id: TargetId, per: readonly StrategyStats[], markets: readonly MarketLine[], file: BatchFile): string {
  const basic = markets.find((m) => m.recipe.id === BASIC_MOONSHINE_RECIPE);
  const standard = markets.find((m) => m.recipe.id === STANDARD_MOONSHINE_RECIPE);
  const above = per.filter((s) => s.winRate > TARGETS.competentSuccessMaxPercent).map((s) => s.strategy);
  const below = per.filter((s) => s.winRate < TARGETS.competentSuccessMinPercent).map((s) => s.strategy);
  switch (id) {
    case "first-profitable-sale":
      return "shorten the first run or the first trip: basic's ticks per case, the opening run size the cash allows, or the nearest buyer's route duration.";
    case "first-upgrade":
      return (
        "the first upgrade is the condenser, LOCKED until the second tier, so its time is the tier-2 reputation time. " +
        "Move it into 10–15 min by lowering the tier-2 reputation threshold, raising the reputation an early installment pays, or offering the first contract earlier; " +
        "or lower the condenser's price if cash, not the gate, is what holds it back."
      );
    case "victory-time":
      return "victory lands on installment settlements (see \"Why victory times cluster\"), so move the first contract's offer time or installment spacing, or the reputation per installment, rather than prices.";
    case "competent-success": {
      const parts: string[] = [];
      if (above.length > 0) {
        parts.push(
          `${above.join(", ")} win above ${TARGETS.competentSuccessMaxPercent}%: tighten standard moonshine` +
            (standard ? ` (gross ${money(standard.grossPerCase)} a case)` : "") +
            " through its base price or QC-station price, or add pressure that can actually cost a run (contract penalties that bite, a disruption that books a loss)",
        );
      }
      if (below.length > 0) parts.push(`${below.join(", ")} win below ${TARGETS.competentSuccessMinPercent}%: see "The Volume Producer" for the two options`);
      return `${parts.join("; ")}.`;
    }
    case "dominant-advantage":
      return (
        "the gap is the spread between the basic-only archetype and the standard-making ones. Narrow it from both ends: lift basic's margin" +
        (basic ? ` (${money(basic.grossPerCase)} a case)` : "") +
        " or redefine the Volume Producer, and tighten standard so the leaders fall into the 60–85% band."
      );
    case "setback-recovery":
      return (
        `${file.runs.filter(judgeable).length === 0 ? "no run had a setback to recover from, so the measure needs one" : "the measure rests on too few strategies"}: ` +
        "add a lab scenario with a scheduled loss on a fixed day (a seizure or a failed run), run every strategy through it, and judge recovery there."
      );
    case "reconciliation":
      return "not a tuning matter: an invariant broke. Reproduce the first violating run from its seed and fix the simulation before any tuning.";
    case "replay":
      return "not a tuning matter: replay diverged. Reproduce from the seed and find the non-deterministic input before any tuning.";
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface ReportArgs {
  readonly in: string;
  readonly out: string;
}

export class ReportArgsError extends Error {
  override readonly name = "ReportArgsError";
}

const USAGE = "usage: report [--in results.json] [--out report.md]";

export function parseReportArgs(argv: readonly string[]): ReportArgs {
  let input = DEFAULT_BATCH_OUT;
  let out = DEFAULT_REPORT_OUT;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const [flag, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    const value = (): string => {
      const v = inline ?? argv[++i];
      if (!v) throw new ReportArgsError(`${flag} needs a path. ${USAGE}`);
      return v;
    };
    switch (flag) {
      case "--":
        break;
      case "--in":
        input = value();
        break;
      case "--out":
        out = value();
        break;
      default:
        throw new ReportArgsError(`Unknown argument ${arg}. ${USAGE}`);
    }
  }
  return { in: input, out };
}

/** Parses a results file, checking its format version. */
export function parseBatchFile(text: string): BatchFile {
  const file = JSON.parse(text) as BatchFile;
  if (typeof file !== "object" || file === null || file.format !== BATCH_FORMAT_VERSION || !Array.isArray(file.runs)) {
    throw new ReportArgsError(`Not a batch results file of format ${BATCH_FORMAT_VERSION} (got format ${String((file as { format?: unknown } | null)?.format)}). Re-run batch.`);
  }
  return file;
}

export interface ReportIo {
  readonly read: (path: string) => string;
  readonly write: (path: string, text: string) => void;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

const NODE_IO: ReportIo = {
  read: (path) => readFileSync(path, "utf8"),
  write: (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  },
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

/** The CLI. Returns the exit code: 0, 1 if the results record an integrity failure, 2 for bad arguments or input. */
export function reportMain(argv: readonly string[], io: ReportIo = NODE_IO, data: GameData = GAME_DATA): number {
  let file: BatchFile;
  let args: ReportArgs;
  try {
    args = parseReportArgs(argv);
    file = parseBatchFile(io.read(resolve(args.in)));
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const text = formatBalanceReport(file, data);
  const path = resolve(args.out);
  io.write(path, `${text}\n`);
  for (const t of evaluateTargets(file)) io.out(`${t.verdict.padEnd(6)} ${t.target}: ${t.measured}`);
  io.out(`Wrote ${path}`);
  if (integrityFailed(file)) {
    io.err("The results record an invariant violation or a replay divergence.");
    return 1;
  }
  return 0;
}

if (import.meta.main) process.exitCode = reportMain(process.argv.slice(2));
