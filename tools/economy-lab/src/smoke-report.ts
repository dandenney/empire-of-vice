// The smoke report (T07a, issue #12): distributions over seeds, the GDD §13
// targets, and flags on the placeholder market tuning (ADR 0016, #69 follow-up).
// T05g (issue #106) adds tiers, victory, and insolvency, and marks the upgrade
// metrics not applicable to a strategy that never takes contracts.
//
// T07c (issue #120) moves the GDD §13 targets into `targets.ts`, shared with the
// balance report, and applies the #85 review fixes: break-even sales are counted
// apart from below-cost ones, over completed sales (not dispatches), and day 0
// (the opening day, before the first sale lands) is left out of the margin
// averages. The standard-moonshine market is reported beside the basic one.
//
// Missed targets and flags are reported, never failed: the CLI exits non-zero
// only when a seed crashes or breaks an invariant.

import { formatMoney, TICKS_PER_DAY, type Money } from "@eov/contracts";
import { GAME_DATA, MARKET_PRICE_BOUNDS, STANDARD_MOONSHINE_RECIPE, type GameData } from "@eov/game-data";
import { STRATEGY } from "./greedy-spot.ts";
import { NET_WORTH_DAY, type InstallmentTally, type Milestone, type SeedReport } from "./smoke-run.ts";
import { TARGETS, TICKS_PER_REAL_MINUTE, victoryOf } from "./targets.ts";

/** What the upgrade cells say for a strategy that never takes contracts. */
export const NOT_APPLICABLE = "n/a (takes no contracts, so never reaches tier 2)";

export interface Distribution {
  /** Seeds with a value (a milestone that was reached). */
  readonly n: number;
  readonly median: number;
  readonly min: number;
  readonly max: number;
}

export interface SeedFailure {
  readonly seed: number;
  readonly error: string;
  readonly message: string;
}

export interface SmokeSummary {
  readonly seeds: number;
  readonly days: number;
  readonly strategy: string;
  /** False when the strategy never takes contracts: the upgrade metrics are not applicable. */
  readonly takesContracts: boolean;
  readonly failures: readonly SeedFailure[];
  readonly qualityUpgrade: Distribution | null;
  /** Ticks each tier was reached, by tier ID in ladder order, over the seeds that reached it. */
  readonly tierReached: Readonly<Record<string, Distribution | null>>;
  /** Ticks of `VICTORY_ACHIEVED`, over the seeds that won. */
  readonly victory: Distribution | null;
  /** Ticks of `GAME_LOST`, over the seeds that lost. */
  readonly lost: Distribution | null;
  readonly finalReputation: Distribution | null;
  readonly contractsCompleted: Distribution | null;
  /** Installment outcomes summed over seeds. */
  readonly installments: InstallmentTally;
  readonly firstProfitableSale: Distribution | null;
  readonly firstNetProfit: Distribution | null;
  readonly firstUpgrade: Distribution | null;
  readonly upgradeEarned: Distribution | null;
  readonly cashTrough: Distribution | null;
  readonly unitsSold: Distribution | null;
  readonly grossProfitPerDay: Distribution | null;
  readonly netProfitPerDay: Distribution | null;
  readonly netWorthAtDay5: Distribution | null;
  readonly finalNetWorth: Distribution | null;
  /** Index d: net worth at the start of day d, over seeds. */
  readonly netWorthCurve: readonly (Distribution | null)[];
}

/** Median (lower-middle average, floored to stay an integer), min, and max. Null for no values. */
export function distribution(values: readonly number[]): Distribution | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 === 1 ? sorted[mid]! : Math.floor((sorted[mid - 1]! + sorted[mid]!) / 2);
  return { n: sorted.length, median, min: sorted[0]!, max: sorted.at(-1)! };
}

const ticksOf = (reports: readonly SeedReport[], pick: (r: SeedReport) => Milestone | null): Distribution | null =>
  distribution(reports.flatMap((r) => (pick(r) ? [pick(r)!.tick] : [])));

/** A seed's average over its days after day 0: the opening day has wages but no sale yet (#85 review). */
const perDay = (r: SeedReport, pick: (d: SeedReport["daily"][number]) => number): number => {
  const later = r.daily.filter((d) => d.day > 0);
  return later.length === 0 ? 0 : Math.floor(later.reduce((n, d) => n + pick(d), 0) / later.length);
};

export function summarize(
  reports: readonly SeedReport[],
  failures: readonly SeedFailure[],
  days: number,
  strategy: string = STRATEGY.name,
  data: GameData = GAME_DATA,
): SmokeSummary {
  const curve: (Distribution | null)[] = [];
  for (let d = 0; d <= days; d++) curve.push(distribution(reports.flatMap((r) => (r.netWorthByDay[d] === undefined ? [] : [r.netWorthByDay[d]!]))));
  const tierReached: Record<string, Distribution | null> = {};
  for (const t of data.progression.tiers) tierReached[t.id] = ticksOf(reports, (r) => r.tierReached[t.id] ?? null);
  const installments = { FULFILLED: 0, PARTIAL: 0, MISSED: 0 };
  for (const r of reports) for (const k of Object.keys(installments) as (keyof InstallmentTally)[]) installments[k] += r.installments[k];
  return {
    seeds: reports.length + failures.length,
    days,
    strategy,
    takesContracts: reports[0]?.takesContracts ?? strategy !== STRATEGY.name,
    failures,
    qualityUpgrade: ticksOf(reports, (r) => r.qualityUpgrade),
    tierReached,
    victory: ticksOf(reports, (r) => r.victory),
    lost: ticksOf(reports, (r) => r.lost),
    finalReputation: distribution(reports.map((r) => r.finalReputation)),
    contractsCompleted: distribution(reports.map((r) => r.contractsCompleted)),
    installments,
    firstProfitableSale: ticksOf(reports, (r) => r.firstProfitableSale),
    firstNetProfit: ticksOf(reports, (r) => r.firstNetProfit),
    firstUpgrade: ticksOf(reports, (r) => r.firstUpgrade),
    upgradeEarned: ticksOf(reports, (r) => r.upgradeEarned),
    cashTrough: distribution(reports.map((r) => r.cashTrough.cash)),
    unitsSold: distribution(reports.map((r) => r.unitsSold)),
    grossProfitPerDay: distribution(reports.map((r) => perDay(r, (d) => d.grossProfit))),
    netProfitPerDay: distribution(reports.map((r) => perDay(r, (d) => d.netProfit))),
    netWorthAtDay5: distribution(reports.flatMap((r) => (r.netWorthAtDay5 === null ? [] : [r.netWorthAtDay5]))),
    finalNetWorth: distribution(reports.map((r) => r.finalNetWorth)),
    netWorthCurve: curve,
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const minutes = (ticks: number): string => (ticks / TICKS_PER_REAL_MINUTE).toFixed(1);
const at = (ticks: number): string => `${ticks} (${minutes(ticks)} min)`;
/** The game day (0-based) a tick falls in. */
const dayOf = (ticks: number): number => Math.floor(ticks / TICKS_PER_DAY);
const money = (cents: number): string => formatMoney(cents as Money);
const ppm = (value: number): string => (value / 1_000_000).toFixed(3);

function row(cells: readonly string[]): string {
  return `| ${cells.join(" | ")} |`;
}

function distRow(label: string, d: Distribution | null, total: number, show: (v: number) => string): string {
  if (!d) return row([label, "not reached", "", "", `0/${total}`]);
  return row([label, show(d.median), show(d.min), show(d.max), `${d.n}/${total}`]);
}

function milestoneCell(m: Milestone | null): string {
  return m ? `${m.tick} (${minutes(m.tick)})` : "not reached";
}

/** Unit cost of a recipe at normal supplier prices (the cheapest supplier): ingredients plus conversion. */
export function unitCost(recipe: GameData["recipes"][number], data: GameData = GAME_DATA): Money {
  let cost = recipe.laborPerCase + recipe.overheadPerCase;
  for (const input of recipe.inputsPerCase) {
    const prices = data.suppliers.flatMap((s) => s.stock).filter((l) => l.materialId === input.materialId).map((l) => l.unitPrice);
    cost += input.quantity * Math.min(...prices);
  }
  return cost as Money;
}

function sum(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

/** Pass/miss lines against GDD §13, then flags on the placeholder market tuning. */
export function findings(summary: SmokeSummary, reports: readonly SeedReport[], data: GameData = GAME_DATA): string[] {
  const out: string[] = [];
  const total = reports.length;
  if (total === 0) return ["No seed finished, so there is nothing to compare."];
  const recipe = data.recipes.find((r) => r.id === STRATEGY.recipeId)!;
  const product = `${recipe.productId}/${recipe.quality}`;
  const marketDef = data.markets.find((m) => m.productId === recipe.productId && m.quality === recipe.quality);

  // GDD §13 targets.
  const fp = summary.firstProfitableSale;
  out.push(
    !fp
      ? `MISS first profitable sale: never reached (target < ${at(TARGETS.firstProfitMaxTicks)}).`
      : `${fp.max < TARGETS.firstProfitMaxTicks && fp.n === total ? "OK" : "MISS"} first profitable sale: median ${at(fp.median)}, ` +
          `max ${at(fp.max)}, ${fp.n}/${total} seeds (target < ${at(TARGETS.firstProfitMaxTicks)}).`,
  );
  const inWindow = (d: Distribution | null): boolean =>
    d !== null && d.median >= TARGETS.firstUpgradeMinTicks && d.median <= TARGETS.firstUpgradeMaxTicks;
  const window = `${TARGETS.firstUpgradeMinTicks}–${TARGETS.firstUpgradeMaxTicks} ticks (10–15 min)`;
  if (!summary.takesContracts) {
    out.push(
      `N/A first upgrade and upgrade earned: ${summary.strategy} takes no contracts, so it never earns the reputation tier 2 needs ` +
        `(ADR 0020 decision 3 gates the condenser there). The contract-taking variant carries the upgrade timing.`,
    );
  } else {
    const fu = summary.firstUpgrade;
    out.push(
      `${inWindow(fu) ? "OK" : "MISS"} first meaningful upgrade (condenser bought at tier 2; cash ≥ price + reserve): ` +
        (fu ? `median ${at(fu.median)}, ${fu.n}/${total} seeds` : "never") +
        ` (target ${window}).`,
    );
    const ue = summary.upgradeEarned;
    out.push(
      `${inWindow(ue) ? "OK" : "MISS"} upgrade earned (profit to date ≥ its price): ` +
        (ue ? `median ${at(ue.median)}, ${ue.n}/${total} seeds` : `not reached in ${summary.days} days by any seed`) +
        ` (target ${window}).`,
    );
  }
  const victory = victoryOf(data);
  const fnw = summary.finalNetWorth!;
  const opening = reports[0]!.netWorthByDay[0]!;
  out.push(
    `${fnw.median >= victory.netWorth ? "OK" : "MISS"} net worth after ${summary.days} days: median ${money(fnw.median)} ` +
      `(opening ${money(opening)}, GDD §4 victory ${money(victory.netWorth)}). ` +
      `Day ${NET_WORTH_DAY} median ${money(summary.netWorthAtDay5?.median ?? 0)} (ADR 0018 decision 9 input).`,
  );

  // Victory, tiers, and insolvency (ADR 0020 decisions 4, 7, 10, 15).
  const v = summary.victory;
  const victoryInWindow = v !== null && v.median >= TARGETS.victoryMinTicks && v.median <= TARGETS.victoryMaxTicks;
  out.push(
    `${victoryInWindow ? "OK" : "MISS"} victory (${money(victory.netWorth)} net worth, reputation ${victory.reputation}, ${victory.completedContracts} completed contract): ` +
      (v
        ? `${v.n}/${total} seeds won within ${summary.days} days; victory day median ${dayOf(v.median)} (${at(v.median)}), ` +
          `earliest day ${dayOf(v.min)}, latest day ${dayOf(v.max)} (GDD §13 target: median ${TARGETS.victoryMinTicks}–${TARGETS.victoryMaxTicks} ticks, 20–30 min).`
        : `no seed won within ${summary.days} days.`) +
      (summary.takesContracts ? "" : ` ${summary.strategy} takes no contracts, so it can't complete one or reach reputation ${victory.reputation}.`),
  );
  const tiers = data.progression.tiers
    .map((t) => {
      const d = summary.tierReached[t.id];
      return d ? `${t.id} ${d.n}/${total} (median day ${dayOf(d.median)}, ${minutes(d.median)} min)` : `${t.id} 0/${total}`;
    })
    .join("; ");
  out.push(`INFO tiers reached: ${tiers}.`);
  const lost = summary.lost;
  const ins = summary.installments;
  out.push(
    `${lost ? "FLAG" : "OK"} insolvency (GAME_LOST): ${lost ? `${lost.n}/${total} seeds, first on day ${dayOf(lost.min)}` : `0/${total} seeds`}. ` +
      `Installments ${ins.FULFILLED} fulfilled, ${ins.PARTIAL} partial, ${ins.MISSED} missed; ` +
      `final reputation median ${summary.finalReputation?.median ?? 0}.`,
  );

  // Unit economics: the frame for every market flag below.
  const cost = unitCost(recipe, data);
  const days = reports.flatMap((r) => r.market);
  const spot = distribution(days.map((d) => d.spotPrice))!;
  out.push(
    `INFO ${product}: unit cost ${money(cost)} at normal prices (ingredients + conversion); spot over all seed-days ` +
      `median ${money(spot.median)}, min ${money(spot.min)}, max ${money(spot.max)}. ` +
      `Gross profit per day median ${money(summary.grossProfitPerDay!.median)}; net (after wages and overhead) ${money(summary.netProfitPerDay!.median)}.`,
  );
  // Completed sales, not dispatches: a dispatch can still fall through (#85 review).
  const completed = sum(reports.map((r) => r.salesCompleted));
  const belowCost = sum(reports.map((r) => r.belowCostSales));
  const breakEven = sum(reports.map((r) => r.breakEvenSales));
  out.push(
    `${belowCost > 0 ? "FLAG" : "OK"} ${belowCost} of ${completed} completed sales were below cost of goods sold; ` +
      `${breakEven} sold exactly at cost (break-even).`,
  );
  const sales = sum(reports.map((r) => r.saleCaps.BUDGET + r.saleCaps.DEMAND + r.saleCaps.STOCK + r.saleCaps.TRUCK));

  // The standard-moonshine market beside the basic one (#118 review). This strategy
  // may not make standard, but its quote moves every day and sets the margin a
  // player compares basic against.
  const standardRecipe = data.recipes.find((r) => r.id === STANDARD_MOONSHINE_RECIPE);
  const standardDays = reports.flatMap((r) => r.standardMarket);
  const standardSpot = distribution(standardDays.map((d) => d.spotPrice));
  if (standardRecipe && standardSpot) {
    const standardCost = unitCost(standardRecipe, data);
    const swing = standardSpot.max - standardSpot.min;
    const margin = standardSpot.median - standardCost;
    out.push(
      `INFO ${standardRecipe.productId}/${standardRecipe.quality}: unit cost ${money(standardCost)} at normal prices; spot over all seed-days ` +
        `median ${money(standardSpot.median)}, min ${money(standardSpot.min)}, max ${money(standardSpot.max)}; ` +
        `median margin per case ${money(margin)} against basic's ${money(spot.median - cost)}; swing ${money(swing)}.`,
    );
  }

  // D₀/S₀ (ADR 0016: S = S₀ + yesterday's sales, so M_S ≤ 1 and only falls).
  const later = days.filter((d) => d.day > 0);
  const ms = distribution(later.map((d) => d.supplyRatioPpm));
  const sold = distribution(reports.flatMap((r) => r.daily.filter((d) => d.day > 0).map((d) => d.unitsSold)));
  if (marketDef && ms && sold) {
    const floor = later.filter((d) => d.supplyRatioPpm <= MARKET_PRICE_BOUNDS.supply.min).length;
    out.push(
      `${ms.median < 900_000 ? "FLAG" : "OK"} D₀/S₀ (${marketDef.baselineDemand}/${marketDef.baselineSupply}): selling a median ${sold.median} cases a day ` +
        `puts M_S at median ${ppm(ms.median)} (min ${ppm(ms.min)}); ${floor}/${later.length} seed-days at the ${ppm(MARKET_PRICE_BOUNDS.supply.min)} floor. ` +
        `The one bot's own volume moves the market price by ${((1_000_000 - ms.median) / 10_000).toFixed(0)}%.`,
    );
  }

  // demandDriftPpm.
  const md = distribution(days.map((d) => d.demandRatioPpm));
  if (marketDef && md) {
    const swing = spot.max - spot.min;
    const margin = spot.median - cost;
    out.push(
      `${swing > margin ? "FLAG" : "OK"} demandDriftPpm (${marketDef.demandDriftPpm}): M_D ranged ${ppm(md.min)}–${ppm(md.max)}; ` +
        `the spot swing (${money(swing)}) is ${swing > margin ? "larger" : "smaller"} than the median margin per case (${money(margin)}).`,
    );
  }

  // Price bounds.
  const me = distribution(days.map((d) => d.eventRatioPpm))!;
  const b = MARKET_PRICE_BOUNDS;
  const clamped = days.filter(
    (d) =>
      d.demandRatioPpm <= b.demand.min ||
      d.demandRatioPpm >= b.demand.max ||
      d.supplyRatioPpm <= b.supply.min ||
      d.eventRatioPpm <= b.event.min ||
      d.eventRatioPpm >= b.event.max,
  ).length;
  out.push(
    `INFO price bounds: ${clamped}/${days.length} seed-days had a multiplier at a bound (M_E at ${ppm(me.max)} is the shortage). ` +
      `M_S never exceeds 1.000 (ADR 0016), so the reachable top is ${ppm((b.demand.max * b.event.max) / 1_000_000)} × base.`,
  );

  // Shortage window.
  const starts = reports.map((r) => r.shortageStartDay);
  const started = starts.flatMap((s) => (s === null ? [] : [s]));
  const supplierCapped = sum(reports.map((r) => r.productionCaps.SUPPLIER));
  const shortageDays = days.filter((d) => d.shortage);
  const normalDays = days.filter((d) => !d.shortage && d.day > 0);
  const avgSpot = (list: typeof days): number => (list.length === 0 ? 0 : Math.floor(sum(list.map((d) => d.spotPrice)) / list.length));
  const maxInput = distribution(shortageDays.map((d) => d.maxInputPrice));
  const startDist = distribution(started);
  out.push(
    `${supplierCapped === 0 ? "FLAG" : "OK"} shortage window: started in ${started.length}/${total} runs, ` +
      (startDist ? `on day ${startDist.min}–${startDist.max} (median ${startDist.median})` : "never") +
      `. Supplier stock capped a run ${supplierCapped} times` +
      (supplierCapped === 0 ? " (the cut stock still covers this bot's daily run, so only prices move)" : "") +
      `. Spot averaged ${money(avgSpot(shortageDays))} during it vs ${money(avgSpot(normalDays))} otherwise; ` +
      `input price peaked at ${money(maxInput?.max ?? 0)}.`,
  );

  // Buyer budgets.
  const budget = sum(reports.map((r) => r.saleCaps.BUDGET));
  const demand = sum(reports.map((r) => r.saleCaps.DEMAND));
  const noBuyer = sum(reports.map((r) => r.saleCaps.NO_BUYER));
  const byBuyer = new Map<string, number>();
  for (const r of reports) for (const [id, n] of Object.entries(r.unitsByBuyer)) byBuyer.set(id, (byBuyer.get(id) ?? 0) + n);
  const split = [...byBuyer].sort(([a], [c]) => (a < c ? -1 : 1)).map(([id, n]) => `${id} ${n}`).join(", ");
  out.push(
    `${budget === 0 && noBuyer === 0 ? "FLAG" : "OK"} buyer budgets: a buyer's budget capped ${budget} of ${sales} sales and demand capped ${demand}; ` +
      `${noBuyer} decision points had stock but no buyer. Units by buyer: ${split}.` +
      (budget === 0 ? " Budgets never bind for this strategy's volume, so demand and price do all the limiting." : ""),
  );

  const rejected = new Map<string, number>();
  for (const r of reports) for (const [code, n] of Object.entries(r.rejections)) rejected.set(code, (rejected.get(code) ?? 0) + n!);
  if (rejected.size > 0) out.push(`INFO rejected commands: ${[...rejected].map(([c, n]) => `${c} ×${n}`).join(", ")}.`);
  return out;
}

export function formatSmokeReport(summary: SmokeSummary, reports: readonly SeedReport[], data: GameData = GAME_DATA): string {
  const total = reports.length;
  const lines: string[] = [
    `## Economy smoke: ${summary.strategy}, ${summary.seeds} seeds × ${summary.days} game days (placeholder game-data ${data.version})`,
    "",
    `Times are ticks (real minutes at 1×, ${TICKS_PER_REAL_MINUTE} ticks per minute).`,
    "",
  ];
  if (summary.failures.length > 0) {
    lines.push(`**${summary.failures.length} seed(s) failed:**`, "");
    for (const f of summary.failures) lines.push(`- seed ${f.seed}: ${f.error}: ${f.message}`);
    lines.push("");
  }

  lines.push("### Distribution", "", row(["Metric", "Median", "Min", "Max", "Seeds"]), row(["---", "---:", "---:", "---:", "---:"]));
  const upgradeRow = (label: string, d: Distribution | null): string =>
    summary.takesContracts ? distRow(label, d, total, at) : row([label, NOT_APPLICABLE, "", "", ""]);
  lines.push(
    distRow("First profitable sale", summary.firstProfitableSale, total, at),
    distRow("First profit to date (after wages)", summary.firstNetProfit, total, at),
    upgradeRow("First affordable upgrade (bought)", summary.firstUpgrade),
    upgradeRow("Upgrade earned (profit ≥ price)", summary.upgradeEarned),
    upgradeRow("QC station bought (tier 3)", summary.qualityUpgrade),
  );
  for (const t of data.progression.tiers) lines.push(distRow(`Tier reached: ${t.id}`, summary.tierReached[t.id] ?? null, total, at));
  lines.push(
    distRow("Victory", summary.victory, total, at),
    distRow("Insolvent (GAME_LOST)", summary.lost, total, at),
    distRow("Final reputation", summary.finalReputation, total, String),
    distRow("Contracts completed", summary.contractsCompleted, total, String),
    distRow("Cash trough", summary.cashTrough, total, money),
    distRow("Units sold", summary.unitsSold, total, String),
    distRow("Gross margin per day", summary.grossProfitPerDay, total, money),
    distRow("Net profit per day", summary.netProfitPerDay, total, money),
    distRow(`Net worth at day ${NET_WORTH_DAY}`, summary.netWorthAtDay5, total, money),
    distRow(`Net worth at day ${summary.days}`, summary.finalNetWorth, total, money),
    "",
  );

  lines.push("### Net worth by game day (start of day)", "", row(["Day", "Tick", "Median", "Min", "Max"]), row(["---:", "---:", "---:", "---:", "---:"]));
  summary.netWorthCurve.forEach((d, day) => {
    if (d) lines.push(row([String(day), String(day * TICKS_PER_DAY), money(d.median), money(d.min), money(d.max)]));
  });
  lines.push("");

  lines.push(
    "### Margin by game day (medians over seeds)",
    "",
    row(["Day", "Units sold", "Revenue", "Gross margin", "Net profit"]),
    row(["---:", "---:", "---:", "---:", "---:"]),
  );
  for (let day = 0; day < summary.days; day++) {
    const of = (pick: (d: SeedReport["daily"][number]) => number): string => {
      const d = distribution(reports.flatMap((r) => r.daily.filter((x) => x.day === day).map(pick)));
      return d ? String(d.median) : "";
    };
    const cash = (pick: (d: SeedReport["daily"][number]) => number): string => {
      const v = of(pick);
      return v === "" ? "" : money(Number(v));
    };
    lines.push(row([String(day), of((d) => d.unitsSold), cash((d) => d.revenue), cash((d) => d.grossProfit), cash((d) => d.netProfit)]));
  }
  lines.push("");

  lines.push("### Findings (GDD §13 targets and placeholder market tuning)", "");
  for (const f of findings(summary, reports, data)) lines.push(`- ${f}`);
  lines.push("");

  lines.push(
    "### Per seed",
    "",
    row([
      "Seed",
      "First profit",
      "Upgrade bought",
      "Upgrade earned",
      "QC bought",
      "Top tier",
      "Victory",
      "Lost",
      "Rep",
      "Cash trough",
      "Units",
      "Gross/day",
      "Net/day",
      `NW day ${NET_WORTH_DAY}`,
      `NW day ${summary.days}`,
      "Shortage day",
    ]),
    row(["---:", "---:", "---:", "---:", "---:", "---", "---:", "---:", "---:", "---:", "---:", "---:", "---:", "---:", "---:", "---:"]),
  );
  const upgradeCell = (r: SeedReport, m: Milestone | null): string => (r.takesContracts ? milestoneCell(m) : "n/a");
  for (const r of reports) {
    const top = [...data.progression.tiers].reverse().find((t) => r.tierReached[t.id]);
    lines.push(
      row([
        String(r.seed),
        milestoneCell(r.firstProfitableSale),
        upgradeCell(r, r.firstUpgrade),
        upgradeCell(r, r.upgradeEarned),
        upgradeCell(r, r.qualityUpgrade),
        top ? `${top.id} @${r.tierReached[top.id]!.tick}` : "none",
        r.victory ? `day ${dayOf(r.victory.tick)} @${r.victory.tick}` : "no",
        r.lost ? `day ${dayOf(r.lost.tick)}` : "no",
        String(r.finalReputation),
        `${money(r.cashTrough.cash)} @${r.cashTrough.tick}`,
        String(r.unitsSold),
        money(perDay(r, (d) => d.grossProfit)),
        money(perDay(r, (d) => d.netProfit)),
        r.netWorthAtDay5 === null ? "n/a" : money(r.netWorthAtDay5),
        money(r.finalNetWorth),
        r.shortageStartDay === null ? "none" : String(r.shortageStartDay),
      ]),
    );
  }
  return lines.join("\n");
}
