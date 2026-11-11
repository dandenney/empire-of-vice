// The GDD §13 balance report (T07c, issue #120):
//
//   pnpm --filter @eov/economy-lab report [--in dist/batch-results.json] [--out dist/balance-report.md]
//
// Reads a results file written by `batch` (T07b) and writes a Markdown report:
// every GDD §13 target flagged MET, MISSED or INSUFFICIENT EVIDENCE with its measured value, then the
// distributions behind them (time to victory, win rates, bankruptcy and
// soft-lock rates, cash troughs, profitability, sources of loss, milestone and
// tier times), the basic and standard market lines, setbacks and recovery, why
// victory times cluster, the Volume Producer choice, and a tuning proposal for
// target not MET. Narrative and proposals are generated from the results (T07e,
// issue #127): no strategy, tick or dollar figure is written in by hand. A run
// counts as a win only by TARGETS.winCutoffTicks. Proposals only: nothing here
// changes game-data. T07f (issue #129) judges setback recovery on the lab's
// setback scenario, where every strategy meets one scheduled SHAKEDOWN.
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
import { isModerateLoss, type BatchRunResult, type SetbackKind } from "./batch-run.ts";
import { BATCH_FORMAT_VERSION, DEFAULT_BATCH_OUT, type BatchFile } from "./batch.ts";
import type { HeadlessStrategyName } from "./headless-strategy.ts";
import { unitCost } from "./smoke-report.ts";
import { countsAsWin, isLateWin, TARGETS, TICKS_PER_REAL_MINUTE, victoryOf } from "./targets.ts";

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
const minutesGoal = (lo: number, hi: number): string => `${minutes(lo)}–${minutes(hi)} min (${lo}–${hi} ticks)`;
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

/** INSUFFICIENT EVIDENCE: too few judged runs to say either way (setback recovery only). */
export type Verdict = "MET" | "MISSED" | "INSUFFICIENT EVIDENCE";

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
  /** Wins by TARGETS.winCutoffTicks. */
  readonly won: number;
  /** Victories after the cutoff: not wins. */
  readonly wonLate: number;
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
    const won = runs.filter(countsAsWin).length;
    return {
      strategy,
      runs,
      won,
      wonLate: runs.filter(isLateWin).length,
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

/** Whether the run's recorded setback is moderate: a loss of at least TARGETS.moderateSetbackMinPercent of net worth when booked. */
export const hasModerateSetback = (r: BatchRunResult): boolean => r.setback !== null && isModerateLoss(r.setback.loss, r.setback.netWorthBefore);

/** Whether a moderate setback recovered within the window: net worth back to its pre-setback level, and the run not lost. */
const recovered = (r: BatchRunResult): boolean =>
  hasModerateSetback(r) && r.setback!.recoveredAt !== null && r.setback!.recoveredAt - r.setback!.tick <= TARGETS.setbackRecoveryWindowTicks && r.outcome !== "LOST";

/** Judged runs: a moderate setback whose window closed. One whose window ran past the end of the run without a recovery can't be judged either way. */
export const judgeable = (r: BatchRunResult): boolean =>
  hasModerateSetback(r) && (recovered(r) || r.outcome === "LOST" || r.endTick - r.setback!.tick >= TARGETS.setbackRecoveryWindowTicks);

export interface SetbackJudgement {
  readonly judged: number;
  readonly recovered: number;
  readonly verdict: Verdict;
}

/**
 * Setback recovery, per strategy and pooled. A strategy (or the pool) with fewer
 * than TARGETS.setbackMinJudgedRuns judged runs is INSUFFICIENT EVIDENCE. The
 * target is MISSED if the pool or any strategy with enough evidence recovers less
 * than TARGETS.setbackRecoveryMinPercent of the time; MET only when every
 * strategy has enough evidence and recovers often enough; otherwise INSUFFICIENT
 * EVIDENCE.
 */
export function setbackVerdict(
  file: Pick<BatchFile, "runs" | "strategies">,
): SetbackJudgement & { readonly per: readonly (SetbackJudgement & { readonly strategy: HeadlessStrategyName })[] } {
  const judge = (runs: readonly BatchRunResult[]): SetbackJudgement => {
    const j = runs.filter(judgeable);
    const ok = j.filter(recovered).length;
    const verdict: Verdict =
      j.length < TARGETS.setbackMinJudgedRuns ? "INSUFFICIENT EVIDENCE" : percent(ok, j.length) >= TARGETS.setbackRecoveryMinPercent ? "MET" : "MISSED";
    return { judged: j.length, recovered: ok, verdict };
  };
  const pooled = judge(file.runs);
  const per = file.strategies.map((strategy) => ({ strategy, ...judge(file.runs.filter((r) => r.strategy === strategy)) }));
  const verdict: Verdict =
    pooled.verdict === "MISSED" || per.some((p) => p.verdict === "MISSED")
      ? "MISSED"
      : pooled.verdict === "MET" && per.length > 0 && per.every((p) => p.verdict === "MET")
        ? "MET"
        : "INSUFFICIENT EVIDENCE";
  return { ...pooled, verdict, per };
}

/** The setback scenario's runs with each run's setback set to its scheduled SHAKEDOWN, so the setback measures judge it. */
export const shakedownRuns = (file: BatchFile): readonly BatchRunResult[] => file.setback.runs.map((r) => ({ ...r, setback: r.shakedown }));

/**
 * Setback recovery on the setback scenario (issue #129): `setbackVerdict` over
 * each run's scheduled SHAKEDOWN. This is the GDD §13 target's verdict. A run
 * that ended before the shakedown, or whose shakedown was capped at cash below
 * the moderate share, isn't judged.
 */
export function scheduledSetbackVerdict(file: BatchFile): ReturnType<typeof setbackVerdict> {
  return setbackVerdict({ runs: shakedownRuns(file), strategies: file.strategies });
}

/**
 * The setback scenario's win rate by the cutoff, per strategy and pooled: an INFO
 * line under the targets table, not a gated target (issue #159).
 */
export function setbackWinRateInfo(file: BatchFile): string {
  const runs = file.setback.runs;
  const rate = (mine: readonly BatchRunResult[]): string => pct(percent(mine.filter(countsAsWin).length, mine.length));
  return (
    `INFO (not a gated target): on the setback scenario, wins by ${at(TARGETS.winCutoffTicks)}: ` +
    `${file.strategies.map((s) => `${s} ${rate(runs.filter((r) => r.strategy === s))}`).join(", ")}; pooled ${rate(runs)} of ${runs.length} runs.`
  );
}

type UpgradeSide = "in" | "early" | "late" | "never";

/** Where a first-upgrade median falls against the 10–15 min window. */
const upgradeSide = (p: Percentiles | null): UpgradeSide =>
  p === null ? "never" : p.p50 < TARGETS.firstUpgradeMinTicks ? "early" : p.p50 > TARGETS.firstUpgradeMaxTicks ? "late" : "in";

function firstUpgradeByStrategy(per: readonly StrategyStats[]): { readonly strategy: HeadlessStrategyName; readonly p: Percentiles | null; readonly side: UpgradeSide }[] {
  return per.map((s) => {
    const p = percentiles(ticksOf(s.runs, (r) => r.firstUpgrade));
    return { strategy: s.strategy, p, side: upgradeSide(p) };
  });
}

export function evaluateTargets(file: BatchFile): TargetResult[] {
  const all = file.runs;
  const per = stats(file);
  const out: TargetResult[] = [];

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
  const fuPer = firstUpgradeByStrategy(per);
  out.push({
    id: "first-upgrade",
    target: "First meaningful upgrade (first equipment bought)",
    goal: `median ${minutesGoal(TARGETS.firstUpgradeMinTicks, TARGETS.firstUpgradeMaxTicks)}, pooled and for every strategy`,
    measured:
      (fu ? `pooled p50 ${at(fu.p50)} (p10 ${minutes(fu.p10)}, p90 ${minutes(fu.p90)} min); ${fu.n}/${all.length} runs` : "pooled: never") +
      `; by strategy p50: ${fuPer.map((x) => `${x.strategy} ${x.p ? `${minutes(x.p.p50)} min` : "never"}${x.side === "in" ? "" : ` (${x.side})`}`).join(", ")}`,
    verdict: upgradeSide(fu) === "in" && fuPer.length > 0 && fuPer.every((x) => x.side === "in") ? "MET" : "MISSED",
  });

  const v = percentiles(ticksOf(all, (r) => r.victory));
  out.push({
    id: "victory-time",
    target: "M001 victory",
    goal: `median over runs that reached victory (late wins included) ${minutesGoal(TARGETS.victoryMinTicks, TARGETS.victoryMaxTicks)}`,
    measured: v ? `p50 ${at(v.p50)} (p10 ${minutes(v.p10)}, p90 ${minutes(v.p90)} min); ${v.n}/${all.length} runs reached victory` : "no run reached victory",
    verdict: v !== null && v.p50 >= TARGETS.victoryMinTicks && v.p50 <= TARGETS.victoryMaxTicks ? "MET" : "MISSED",
  });

  const inBand = (s: StrategyStats): boolean => s.winRate >= TARGETS.competentSuccessMinPercent && s.winRate <= TARGETS.competentSuccessMaxPercent;
  out.push({
    id: "competent-success",
    target: "Competent strategy success",
    goal: `every strategy wins ${TARGETS.competentSuccessMinPercent}–${TARGETS.competentSuccessMaxPercent}% of its runs, a win counting only by ${at(TARGETS.winCutoffTicks)}`,
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

  const sv = scheduledSetbackVerdict(file);
  out.push({
    id: "setback-recovery",
    target: "Recovery from one moderate setback",
    goal:
      `on the setback scenario, ≥ ${TARGETS.setbackRecoveryMinPercent}% of runs whose scheduled shakedown was moderate (a loss ≥ ${TARGETS.moderateSetbackMinPercent}% of net worth) recover within ` +
      `${minutes(TARGETS.setbackRecoveryWindowTicks)} min, pooled and for every strategy, each over at least ${TARGETS.setbackMinJudgedRuns} judged runs (see "Setbacks and recovery")`,
    measured:
      (sv.judged === 0 ? "pooled: no judged moderate setback" : `pooled ${sv.recovered}/${sv.judged} recovered (${pct(percent(sv.recovered, sv.judged))})`) +
      `; by strategy: ${sv.per.map((p) => `${p.strategy} ${p.recovered}/${p.judged}${p.verdict === "INSUFFICIENT EVIDENCE" ? " (too few)" : p.verdict === "MISSED" ? " (below)" : ""}`).join(", ")}`,
    verdict: sv.verdict,
  });

  // Integrity counts both scenarios' runs.
  const checked = [...all, ...file.setback.runs];
  const violations = sum(checked.map((r) => r.invariantViolationCount));
  const violatingRuns = checked.filter((r) => r.invariantViolationCount > 0).length;
  out.push({
    id: "reconciliation",
    target: "Financial reconciliation failures",
    goal: "zero",
    measured: `${violations} invariant violation(s) in ${violatingRuns}/${checked.length} runs (both scenarios)`,
    verdict: violations <= TARGETS.reconciliationFailuresMax ? "MET" : "MISSED",
  });

  const diverged = checked.filter((r) => r.replayDiverged).length;
  out.push({
    id: "replay",
    target: "Deterministic replay divergence",
    goal: "zero",
    measured: `${diverged}/${checked.length} runs diverged on replay (both scenarios)`,
    verdict: diverged <= TARGETS.replayDivergencesMax ? "MET" : "MISSED",
  });
  return out;
}

/** Whether the file records an integrity failure: an invariant violation or a replay divergence. */
export function integrityFailed(file: BatchFile): boolean {
  return [...file.runs, ...file.setback.runs].some((r) => r.invariantViolationCount > 0 || r.replayDiverged);
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

/** The kinds a First Shipment run can book; SHAKEDOWN only comes from the setback scenario. */
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
  const unproven = targets.filter((t) => t.verdict === "INSUFFICIENT EVIDENCE");
  lines.push(
    "## GDD §13 targets",
    "",
    `${targets.length - missed.length - unproven.length} MET, ${missed.length} MISSED, ${unproven.length} INSUFFICIENT EVIDENCE.`,
    "",
    row(["Target", "Goal", "Measured", "Verdict"]),
    align(4, 0),
  );
  for (const t of targets) lines.push(row([t.target, t.goal, t.measured, `**${t.verdict}**`]));
  lines.push("", setbackWinRateInfo(file), "");
  const gate = targets.find((t) => t.id === "competent-success")!;
  const viable = per.filter((s) => s.won > 0).map((s) => s.strategy);
  lines.push(
    `M001 release gate "multiple viable strategies can reach victory": ${viable.length} of ${per.length} strategies won at least one run (${viable.join(", ") || "none"}). ` +
      (gate.verdict === "MET" ? "Every strategy is inside the competent-success band." : "The competent-success band is missed, so the gate's balance half is not yet shown."),
    "",
  );

  // Outcomes.
  lines.push(
    "## Outcomes by strategy",
    "",
    `**Win rule.** A run counts as a win only if victory comes by tick ${TARGETS.winCutoffTicks} (${minutes(TARGETS.winCutoffTicks)} min, game day ${TARGETS.winCutoffTicks / TICKS_PER_DAY}), ` +
      `the end of the M001 session. The batch runs to its ${file.days}-day cap, but a later victory is a *late win*: not a win in any win or success rate here.`,
    "",
    row(["Strategy", "Runs", "Won", "Won late", "Win rate", "Bankrupt (LOST)", "Day cap", "Soft-locked", "Net worth at end p50"]),
    align(1, 8),
  );
  for (const s of per) {
    const nw = percentiles(s.runs.map((r) => r.finalNetWorth));
    lines.push(
      row([
        s.strategy,
        String(s.runs.length),
        String(s.won),
        String(s.wonLate),
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
    `Bankrupt: the game declared insolvency (GAME_LOST). Day cap: neither won nor lost in ${file.days} days (late wins are counted apart). ` +
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
  const lossKinds: [string, (r: BatchRunResult) => number][] = [
    ["seizures", (r) => r.losses.seizures],
    ["failed runs", (r) => r.losses.failedProduction],
    ["penalties", (r) => r.losses.penalties],
  ];
  const whoLost = lossKinds.map(([label, pick]) => {
    const who = per.filter((s) => s.runs.some((r) => pick(r) > 0)).map((s) => s.strategy);
    return `${label}: ${who.length === 0 ? "none" : `${who.join(", ")} (${who.length} of ${per.length})`}`;
  });
  lines.push("", `Strategies that booked each risk-driven loss at least once. ${whoLost.join("; ")}.`, "");

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
  const sv = setbackVerdict(file);
  const sd = file.setback.shakedown;
  const scheduled = shakedownRuns(file);
  const ssv = scheduledSetbackVerdict(file);
  lines.push(
    "## Setbacks and recovery",
    "",
    "**Definition.** A *loss event* is cargo seized on a risky route (CARGO_LOST), a production run's inputs written off (PRODUCTION_FAILED), " +
      "an installment penalty (INSTALLMENT_SETTLED with a penalty), or a scheduled shakedown (LOSS_BOOKED). A *moderate setback* is a loss event of at least " +
      `${TARGETS.moderateSetbackMinPercent}% of net worth at the moment it's booked; smaller losses are counted but never judged. ` +
      "The run *recovers* if its net worth is back to at least its level just before the setback within " +
      `${at(TARGETS.setbackRecoveryWindowTicks)} (${TARGETS.setbackRecoveryWindowTicks / TICKS_PER_DAY} game days), and it doesn't go bankrupt. ` +
      "A run whose window outlasts the run without a recovery isn't judged. " +
      `"Usually possible" is read as at least ${TARGETS.setbackRecoveryMinPercent}% of judged runs recovering, pooled and for each strategy; ` +
      `fewer than ${TARGETS.setbackMinJudgedRuns} judged runs is INSUFFICIENT EVIDENCE.`,
    "",
    "### Scheduled setback scenario",
    "",
    `The target is judged here. Every strategy plays the same seeds again on a lab variant of the First Shipment that schedules one ${sd.reason} \`SHAKEDOWN\` ` +
      `at ${at(sd.tick)}, game day ${(sd.tick / TICKS_PER_DAY).toFixed(1)}: a loss of ${pct(sd.netWorthSharePpm / 10_000)} of net worth on that tick, capped at cash. ` +
      "Net worth before it is the event's own (LOSS_BOOKED), not the last stop's. A run that ended before the shakedown isn't judged, " +
      `and neither is one whose loss was capped at cash below ${TARGETS.moderateSetbackMinPercent}% of net worth.`,
    "",
    row(["Strategy", "Runs", "Ended before it", "Booked", "Capped at cash below moderate", "Judged", "Recovered", "Verdict", "Loss p50", "Loss share p50", "Recovery time p50", "Win rate: First Shipment → setback"]),
    align(1, 11),
  );
  for (const s of per) {
    const mine = scheduled.filter((r) => r.strategy === s.strategy);
    const booked = mine.filter((r) => r.setback !== null);
    const hit = booked.filter(hasModerateSetback);
    const j = hit.filter(judgeable);
    const rec = j.filter(recovered);
    const loss = percentiles(booked.map((r) => r.setback!.loss));
    const share = percentiles(booked.filter((r) => r.setback!.netWorthBefore > 0).map((r) => Math.round((r.setback!.loss * 100) / r.setback!.netWorthBefore)));
    const time = percentiles(rec.map((r) => r.setback!.recoveredAt! - r.setback!.tick));
    lines.push(
      row([
        s.strategy,
        String(mine.length),
        String(mine.length - booked.length),
        String(booked.length),
        String(booked.length - hit.length),
        String(j.length),
        `${rec.length} (${pct(percent(rec.length, j.length))})`,
        ssv.per.find((x) => x.strategy === s.strategy)?.verdict ?? "",
        loss ? money(loss.p50) : "",
        share ? `${share.p50}%` : "",
        time ? at(time.p50) : "",
        `${pct(s.winRate)} → ${pct(percent(mine.filter(countsAsWin).length, mine.length))}`,
      ]),
    );
  }
  lines.push(
    "",
    ssv.judged === 0
      ? "No scheduled shakedown was judgeable."
      : `Pooled, ${ssv.recovered} of ${ssv.judged} judged runs recovered (${pct(percent(ssv.recovered, ssv.judged))}): **${ssv.verdict}**.`,
    "",
    "### Incidental setbacks (the First Shipment)",
    "",
    "The losses strategies happen to book on the First Shipment as it ships, for comparison; the target isn't judged on them, since only some strategies book a moderate one.",
    "",
    row(["Strategy", "Runs with any loss", "Runs with a moderate setback", ...SETBACK_KINDS, "Judged", "Recovered", "Verdict", "Loss p50", "Loss share p50", "Recovery time p50", "Won (by the cutoff) after a setback"]),
    align(1, 12),
  );
  for (const s of per) {
    const anyLoss = s.runs.filter((r) => r.setbackCount > 0).length;
    const hit = s.runs.filter(hasModerateSetback);
    const j = hit.filter(judgeable);
    const rec = j.filter(recovered);
    const loss = percentiles(hit.map((r) => r.setback!.loss));
    const share = percentiles(hit.filter((r) => r.setback!.netWorthBefore > 0).map((r) => Math.round((r.setback!.loss * 100) / r.setback!.netWorthBefore)));
    const time = percentiles(rec.map((r) => r.setback!.recoveredAt! - r.setback!.tick));
    lines.push(
      row([
        s.strategy,
        String(anyLoss),
        String(hit.length),
        ...SETBACK_KINDS.map((k) => String(hit.filter((r) => r.setback!.kind === k).length)),
        String(j.length),
        `${rec.length} (${pct(percent(rec.length, j.length))})`,
        sv.per.find((x) => x.strategy === s.strategy)?.verdict ?? "",
        loss ? money(loss.p50) : "",
        share ? `${share.p50}%` : "",
        time ? at(time.p50) : "",
        `${hit.filter(countsAsWin).length}/${hit.length}`,
      ]),
    );
  }
  const closures = sum(file.runs.map((r) => r.disruptions.routeClosures));
  const shortages = sum(file.runs.map((r) => r.disruptions.shortages));
  const disrupted = file.runs.filter((r) => r.disruptions.routeClosures + r.disruptions.shortages > 0);
  const smallOnly = file.runs.filter((r) => r.setbackCount > 0 && !hasModerateSetback(r)).length;
  const covered = sv.per.filter((p) => p.verdict !== "INSUFFICIENT EVIDENCE").map((p) => p.strategy);
  lines.push(
    "",
    `Scheduled disruptions, which book no loss by themselves: ${closures} route closure(s) and ${shortages} supplier shortage(s) over ${total} runs; ` +
      `${disrupted.length} runs met at least one, and ${disrupted.filter(countsAsWin).length} of those won by the cutoff.`,
    "",
    `${judged.length} of ${total} runs (${pct(percent(judged.length, total))}) had a judgeable moderate setback; ` +
      `${smallOnly} more booked only losses under ${TARGETS.moderateSetbackMinPercent}% of net worth, which aren't judged. ` +
      `${covered.length} of ${per.length} strategies have enough judged runs (${covered.join(", ") || "none"}).`,
    "",
  );

  // Victory clustering.
  const settlementShare = per
    .map((s) => {
      const wins = s.runs.filter((r) => r.victory !== null);
      return { strategy: s.strategy, wins: wins.length, onSettlement: wins.filter((r) => r.victoryOnSettlement).length };
    })
    .filter((x) => x.wins > 0);
  const cite = (xs: typeof settlementShare, pick: (x: (typeof settlementShare)[number]) => number): string =>
    xs.map((x) => `${x.strategy} (${pct(percent(pick(x), x.wins))} of ${x.wins} victories)`).join(", ");
  const bySettlement = settlementShare.filter((x) => x.onSettlement * 2 > x.wins);
  const bySale = settlementShare.filter((x) => x.onSettlement * 2 <= x.wins);
  const observed: string[] = [];
  if (bySettlement.length > 0) observed.push(`on an installment settlement for ${cite(bySettlement, (x) => x.onSettlement)}`);
  if (bySale.length > 0) observed.push(`on a sale (a truck arrival lifting net worth over the threshold) for ${cite(bySale, (x) => x.wins - x.onSettlement)}`);
  const allWins = file.runs.filter((r) => r.victory !== null);
  const tickCounts = new Map<number, number>();
  for (const r of allWins) tickCounts.set(r.victory!.tick, (tickCounts.get(r.victory!.tick) ?? 0) + 1);
  let topTick: [number, number] | null = null;
  for (const [t, n] of [...tickCounts].sort((a, b) => a[0] - b[0])) if (topTick === null || n > topTick[1]) topTick = [t, n];
  const topRuns = topTick === null ? [] : allWins.filter((r) => r.victory!.tick === topTick![0]);
  const topStrategies = [...new Set(topRuns.map((r) => r.strategy))];
  const topOnSettlement = topRuns.filter((r) => r.victoryOnSettlement).length;
  lines.push(
    "## Why victory times cluster",
    "",
    "Victory needs all three conditions at once, and each one can only change at a few kinds of tick:",
    "",
    "- **Reputation and the completed contract** move only when an installment settles, at its deadline. Deadlines are fixed ticks set by when the offer was accepted, " +
      "and offers arrive on the contract system's schedule, so a run whose last condition is reputation or the contract wins exactly on a settlement tick.",
    "- **Net worth** moves when a sale completes, which is when the truck arrives. Runs and trips have fixed durations, so the delivery that crosses the threshold " +
      "lands on the same tick in every seed whose market lets the strategy load the same cargo at the same time.",
    "",
    allWins.length === 0
      ? "No run reached victory, so there is no victory tick to explain."
      : `In these results most victories (late ones included) land ${observed.join("; and ")}. ` +
          `The most common victory tick is ${at(topTick![0])}: ${topTick![1]} victories (${topStrategies.join(", ")}), ` +
          `${topOnSettlement === topRuns.length ? "every one on a settlement tick" : topOnSettlement === 0 ? "none on a settlement tick" : `${topOnSettlement} on a settlement tick`}.`,
    "",
    "Either way the victory time is a step function of a few scheduled ticks, not a continuous quantity: the distribution has spikes rather than a spread, " +
      "and the medians below move in jumps when tuning changes which settlement or which delivery is the decisive one. Read the p10–p90 range with that in mind.",
    "",
    row(["Strategy", "Victories (late included)", "On a settlement tick", "Distinct victory ticks", "Most common tick", "Last to clear: net worth / reputation / contract"]),
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
  if (vp) lines.push(...volumeProducer(vp, per, markets, goal, file.days));

  // Proposals.
  const open = [...missed, ...unproven];
  lines.push("## Tuning proposals", "", "Proposals only. This report changes no game-data; the tuning task that follows it decides.", "");
  if (open.length === 0) lines.push("Every target is MET; nothing to propose.");
  for (const t of open) lines.push(`- **${t.target}** (${t.verdict}; ${t.measured}): ${proposal(t.id, per, markets, file)}`);
  lines.push("", "Beyond the targets:", "");
  const spread = per.filter((s) => s.runs.length > 1 && new Set(s.runs.map((r) => r.firstUpgrade?.tick ?? -1)).size === 1).map((s) => s.strategy);
  if (spread.length > 0) {
    lines.push(
      `- **Seed spread.** ${spread.join(", ")} bought their first upgrade on the same tick in every seed, so something deterministic (tier gates, fixed durations), not the market, sets their early pacing. ` +
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
  if (lines.at(-1) === "") lines.push("Nothing else stands out.");
  lines.push("");
  return lines.join("\n");
}

/** The product ("productId/quality") a strategy's runs earned the most revenue from, with its share of their revenue in percent. */
function mainProduct(s: StrategyStats): { readonly key: string; readonly share: number } | null {
  const revenue = new Map<string, number>();
  for (const r of s.runs) for (const [key, t] of Object.entries(r.sales)) revenue.set(key, (revenue.get(key) ?? 0) + t.revenue);
  let best: [string, number] | null = null;
  for (const [key, v] of [...revenue].sort((a, b) => (a[0] < b[0] ? -1 : 1))) if (best === null || v > best[1]) best = [key, v];
  if (best === null || best[1] === 0) return null;
  return { key: best[0], share: percent(best[1], sum([...revenue.values()])) };
}

const mainProductText = (s: StrategyStats): string => {
  const m = mainProduct(s);
  return m === null ? "no sales" : `${pct(m.share)} of revenue from ${m.key}`;
};

const inBand = (s: StrategyStats): boolean => s.winRate >= TARGETS.competentSuccessMinPercent && s.winRate <= TARGETS.competentSuccessMaxPercent;
const band = `${TARGETS.competentSuccessMinPercent}–${TARGETS.competentSuccessMaxPercent}%`;

function volumeProducer(vp: StrategyStats, per: readonly StrategyStats[], markets: readonly MarketLine[], goal: GameData["progression"]["victory"], days: number): string[] {
  const nw = percentiles(vp.runs.map((r) => r.finalNetWorth));
  const units = percentiles(vp.runs.map((r) => r.unitsSold));
  const opening = vp.runs[0]?.netWorthByDay[0] ?? 0;
  const out = ["## The Volume Producer", ""];
  if (!nw || !units) return [...out, "No Volume Producer runs.", ""];
  const gateRuns = (g: Gate): number => vp.runs.filter((r) => r.victoryGates[g] !== null).length;
  const gateLabel: Record<Gate, string> = { netWorth: "net worth", reputation: "reputation", completedContracts: "the completed contract" };
  const weakest = [...GATES].sort((a, b) => gateRuns(a) - gateRuns(b))[0]!;
  const main = mainProduct(vp);
  const line = main ? markets.find((m) => m.key === main.key) : undefined;
  const others = markets.filter((m) => m !== line);
  out.push(
    `${vp.strategy} won ${vp.won}/${vp.runs.length} runs (${pct(vp.winRate)}; the competent band is ${band}). It takes ${mainProductText(vp)}, ` +
      `and its median run ends at ${money(nw.p50)} net worth (opening ${money(opening)}, victory ${money(goal.netWorth)}) after selling ${units.p50} cases in ${days} days. ` +
      `It reaches net worth ${money(goal.netWorth)} in ${gateRuns("netWorth")}/${vp.runs.length} runs, reputation ${goal.reputation} in ${gateRuns("reputation")}/${vp.runs.length}, ` +
      `and ${goal.completedContracts} completed contract(s) in ${gateRuns("completedContracts")}/${vp.runs.length}` +
      (gateRuns(weakest) < vp.runs.length ? `; ${gateLabel[weakest]} is the condition it misses most.` : "."),
  );
  if (line) {
    out.push(
      "",
      `Its main line, ${line.key}, realized ${money(line.grossPerCase)} gross a case (${money(line.basePrice - line.cost)} margin at base)` +
        (others.length > 0 ? `, against ${others.map((m) => `${m.key}'s ${money(m.grossPerCase)} (${money(m.basePrice - m.cost)} at base)`).join(", ")}.` : "."),
    );
  }
  if (inBand(vp)) return [...out, "", "It is inside the competent band, so there is no archetype decision to make.", ""];

  const short = goal.netWorth - nw.p50;
  const above = per.filter((s) => s !== vp && s.winRate > TARGETS.competentSuccessMaxPercent && main !== null && s.runs.some((r) => (r.sales[main.key]?.units ?? 0) > 0));
  out.push("", `It is ${vp.winRate < TARGETS.competentSuccessMinPercent ? "below" : "above"} the competent band. Two ways to settle it:`, "");
  if (short > 0 && weakest === "netWorth") {
    // Rough: the extra margin per case that would have closed the median shortfall over the median run's sales.
    const extra = units.p50 === 0 ? 0 : Math.ceil(short / units.p50);
    out.push(
      `1. **Keep its product mix and tune that product's margin.** Closing the median shortfall (${money(short)}) by the day cap over its median ${units.p50} cases needs about ` +
        `${money(extra)} more margin a case (a linear estimate, not a simulation); reaching victory inside ${minutes(TARGETS.victoryMaxTicks)} min needs more, since fewer cases have sold by then. ` +
        "Levers in game-data: the product's base price, its inputs or labor per case, or capacity." +
        (above.length > 0 ? ` A wider margin also lifts the other strategies that sell it, and ${above.map((s) => `${s.strategy} (${pct(s.winRate)})`).join(", ")} already win above the band.` : ""),
    );
  } else {
    out.push(`1. **Keep its product mix and tune what it lacks.** Its weakest victory condition is ${gateLabel[weakest]}; move the game-data lever behind that condition.`);
  }
  out.push(
    "2. **Redefine the archetype as volume of whatever is unlocked.** The strategy keeps its capacity-first upgrade order but switches its output to the best unlocked product. " +
      "This is a lab change only (no game-data), but it narrows the difference between it and the strategies that already sell that product.",
    "",
    "Either choice is a design call; the report doesn't make it.",
    "",
  );
  return out;
}

function proposal(id: TargetId, per: readonly StrategyStats[], markets: readonly MarketLine[], file: BatchFile): string {
  const above = per.filter((s) => s.winRate > TARGETS.competentSuccessMaxPercent);
  const below = per.filter((s) => s.winRate < TARGETS.competentSuccessMinPercent);
  const name = (xs: readonly StrategyStats[]): string => xs.map((s) => `${s.strategy} (${pct(s.winRate)}; ${mainProductText(s)})`).join(", ");
  switch (id) {
    case "first-profitable-sale":
      return "shorten the first run or the first trip: the first recipe's ticks per case, the opening run size the cash allows, or the nearest buyer's route duration.";
    case "first-upgrade": {
      const by = firstUpgradeByStrategy(per);
      const side = (x: UpgradeSide): string => by.filter((b) => b.side === x).map((b) => `${b.strategy}${b.p ? ` (p50 ${minutes(b.p.p50)} min)` : ""}`).join(", ");
      const parts: string[] = [];
      if (side("late")) parts.push(`late: ${side("late")}`);
      if (side("early")) parts.push(`early: ${side("early")}`);
      if (side("never")) parts.push(`never upgraded: ${side("never")}`);
      return (
        `${parts.join("; ") || "the pooled median is outside the window"}. ` +
        "Compare each strategy's first-upgrade time with its tier times under Milestones: when they coincide, the upgrade waits on a tier unlock, so move the tier's reputation threshold " +
        "or the reputation an early installment pays; when the upgrade comes well after its unlock, cash holds it back, so move the equipment's price. " +
        `Late strategies need the lever pulled toward earlier, early ones toward later, until every median sits in ${minutesGoal(TARGETS.firstUpgradeMinTicks, TARGETS.firstUpgradeMaxTicks)}.`
      );
    }
    case "victory-time": {
      const wins = file.runs.filter((r) => r.victory !== null);
      const v = percentiles(wins.map((r) => r.victory!.tick));
      if (v === null) return "no run won, so there is no victory time to move; see the competent-success proposal.";
      const direction = v.p50 < TARGETS.victoryMinTicks ? "early" : "late";
      const last = (g: Gate): number => wins.filter((r) => lastGate(r) === g).length;
      const decisive = [...GATES].sort((a, b) => last(b) - last(a))[0]!;
      const settled = wins.filter((r) => r.victoryOnSettlement).length;
      const lever: Record<Gate, string> = {
        netWorth: "the victory net-worth threshold, or the margins and trip durations that set how fast net worth grows",
        reputation: "the reputation per installment, the first contract's offer time, or installment spacing",
        completedContracts: "the first contract's offer time, its installment count, or installment spacing",
      };
      return (
        `the median victory is ${direction} (p50 ${minutes(v.p50)} min). ${pct(percent(settled, wins.length))} of victories land on an installment settlement and the rest on a sale ` +
        `(see "Why victory times cluster"); the last condition to clear is net worth in ${last("netWorth")}, reputation in ${last("reputation")}, and the contract in ${last("completedContracts")} of ${wins.length} victories. ` +
        `So the lever is the one behind ${decisive === "netWorth" ? "net worth" : decisive === "reputation" ? "reputation" : "the completed contract"}: ${lever[decisive]}.`
      );
    }
    case "competent-success": {
      const parts: string[] = [];
      if (above.length > 0) {
        parts.push(
          `above ${TARGETS.competentSuccessMaxPercent}%: ${name(above)}. Tighten the product they lean on (its base price, or the price of the equipment that unlocks it), ` +
            "or add pressure that can actually cost a run (contract penalties that bite, a disruption that books a loss)",
        );
      }
      if (below.length > 0) {
        parts.push(
          `below ${TARGETS.competentSuccessMinPercent}%: ${name(below)}. Widen the margin of the product they lean on, or change what the strategy makes` +
            (below.some((s) => s.strategy === "volume-producer") ? ' (see "The Volume Producer" for the two options)' : ""),
        );
      }
      return `${parts.join("; ") || "every strategy is in the band"}.`;
    }
    case "dominant-advantage": {
      const sorted = [...per].sort((a, b) => b.winRate - a.winRate);
      const best = sorted[0];
      const worst = sorted.at(-1);
      if (!best || !worst || best === worst) return "fewer than two strategies ran, so there is no gap to measure; run them all.";
      const bm = mainProduct(best)?.key;
      const wm = mainProduct(worst)?.key;
      const sameProduct = bm !== undefined && bm === wm;
      return (
        `the gap runs from ${name([best])} to ${name([worst])}. ` +
        (sameProduct
          ? "Both lean on the same product, so the gap is in how they play it (upgrade order, contracts, routes) rather than in a product's margin: look at what the leader does that the other doesn't, before touching prices."
          : `They lean on different products, so narrow the margin gap between ${bm ?? "the leader's product"} and ${wm ?? "the trailer's"} from both ends, or change what the trailing strategy makes.`)
      );
    }
    case "setback-recovery": {
      const sv = scheduledSetbackVerdict(file);
      const thin = sv.per.filter((p) => p.verdict === "INSUFFICIENT EVIDENCE");
      const low = sv.per.filter((p) => p.verdict === "MISSED");
      const parts: string[] = [];
      if (thin.length > 0) {
        parts.push(
          `too few judged scheduled shakedowns for ${thin.map((p) => `${p.strategy} (${p.judged})`).join(", ")}, against the ${TARGETS.setbackMinJudgedRuns} needed. ` +
            "That is a measurement gap, not a tuning one: run more seeds, or, if the shakedown was capped at cash below the moderate share or came after the game ended " +
            "(see \"Scheduled setback scenario\"), move it to an earlier day in the lab's setback scenario",
        );
      }
      if (low.length > 0 || (sv.verdict === "MISSED" && low.length === 0)) {
        const who = low.length > 0 ? low.map((p) => `${p.strategy} (${p.recovered}/${p.judged})`).join(", ") : `the pool (${sv.recovered}/${sv.judged})`;
        parts.push(
          `recovery from the scheduled shakedown below ${TARGETS.setbackRecoveryMinPercent}% for ${who}. Make a moderate loss less final: ` +
            "more room to earn it back (margins, cash buffers) within the window, or smaller incidental losses (seizure shares, penalties) stacked on it",
        );
      }
      return `${parts.join("; ")}.`;
    }
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
