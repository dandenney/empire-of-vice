// One headless run for the seeded batch (T07b, issue #119): a GDD §13 strategy
// plays The First Shipment on one seed until victory, loss, or a day cap.
//
// Like the smoke run, it's event-driven: it stops wherever the strategy could
// react (a run completes, the truck arrives or gets home, midnight, an
// installment deadline, a route reopening), lets the strategy act, and checks the
// ledger invariants. Net worth only rises through sales (truck arrivals) and
// reputation only at installment settlements (deadlines), so victory always lands
// on a stop; insolvency is checked at midnight, also a stop.
//
// T07c (issue #120) adds what the balance report needs: completed sales by
// product (break-even apart from below cost), the basic and standard spot quotes
// and net worth at each day's start, the run's first setback and whether net
// worth recovered from it, and whether victory landed on an installment
// settlement.
//
// At the end the run's command log is replayed on a fresh game (ADR 0004's replay
// procedure) and the state hash compared.

import {
  TICKS_PER_DAY,
  type ExpenseCategory,
  type GameEvent,
  type GameSnapshot,
  type InvariantViolation,
  type LedgerTransaction,
  type Money,
  type RejectionCode,
  type GameState,
} from "@eov/contracts";
import {
  BASIC_MOONSHINE_RECIPE,
  FIRST_SHIPMENT_SCENARIO,
  GAME_DATA,
  STANDARD_MOONSHINE_RECIPE,
  type GameData,
  type ScenarioDefinition,
} from "@eov/game-data";
import { checkInvariants, newGame, type KernelSimulation } from "@eov/simulation";
import type { Gateway } from "./greedy-spot.ts";
import type { HeadlessStrategyName, Variant } from "./headless-strategy.ts";
import { milestone, type Milestone } from "./smoke-run.ts";
import { createHeadlessStrategy } from "./strategies.ts";

/** Default day cap (issue #119): 30 game days. */
export const DEFAULT_BATCH_DAYS = 30;

/** Violations kept per run; the count covers the rest. */
export const MAX_RECORDED_VIOLATIONS = 20;

export type RunOutcome = "WON" | "LOST" | "DAY_CAP";

export interface RecordedViolation {
  readonly tick: number;
  readonly code: string;
}

/** Economic losses by source over the run, in cents. */
export interface LossesBySource {
  /** Cargo seized on a risky route (CARGO_LOST book value). */
  readonly seizures: Money;
  /** Inputs written off by failed production runs. */
  readonly failedProduction: Money;
  /** Contract penalties for missing cases. */
  readonly penalties: Money;
  /** Σ (cost of goods sold − revenue) over sales below cost. */
  readonly belowCostSales: Money;
  /** Transport charges (the TRANSPORT expense). */
  readonly transport: Money;
}

/** Completed sales of one product and quality (SALE_COMPLETED events, spot and contract). */
export interface ProductSales {
  readonly completed: number;
  /** Revenue below cost of goods sold. */
  readonly belowCost: number;
  /** Revenue exactly equal to cost of goods sold. */
  readonly breakEven: number;
  readonly units: number;
  readonly revenue: Money;
  readonly costOfGoodsSold: Money;
}

/** What can set a run back: an event that books a loss. */
export type SetbackKind = "SEIZURE" | "FAILED_RUN" | "PENALTY";

/**
 * The run's first setback: the first event that booked a loss (cargo seized,
 * a production run's inputs written off, or an installment penalty).
 */
export interface Setback {
  readonly kind: SetbackKind;
  readonly tick: number;
  /** The loss the event booked, in cents. */
  readonly loss: Money;
  /** Net worth at the last stop before the event. */
  readonly netWorthBefore: Money;
  /** The first stop at which net worth was back to at least `netWorthBefore`, or null. */
  readonly recoveredAt: number | null;
}

export interface BatchRunResult {
  readonly strategy: HeadlessStrategyName;
  readonly seed: number;
  readonly variant: Variant;
  readonly outcome: RunOutcome;
  /** The tick of victory or loss, or null at the day cap. */
  readonly outcomeTick: number | null;
  readonly endTick: number;
  readonly firstProfitableSale: Milestone | null;
  /** First time profit to date (after wages and overhead) went above zero. */
  readonly firstNetProfit: Milestone | null;
  /** First equipment bought. */
  readonly firstUpgrade: Milestone | null;
  /** When each tier was reached, by tier ID in ladder order. The starting tier is reached at tick 0. */
  readonly tierReached: Readonly<Record<string, Milestone | null>>;
  readonly victory: Milestone | null;
  /** Whether an installment settled on the victory tick (reputation only moves at settlement). */
  readonly victoryOnSettlement: boolean;
  /**
   * The first stop at which each victory condition held (game-data's
   * `progression.victory`): net worth, reputation, and completed contracts.
   * The last of the three to clear is what set the victory time.
   */
  readonly victoryGates: { readonly netWorth: number | null; readonly reputation: number | null; readonly completedContracts: number | null };
  readonly lost: Milestone | null;
  readonly cashTrough: { readonly cash: Money; readonly tick: number };
  readonly finalNetWorth: Money;
  readonly finalCash: Money;
  readonly finalReputation: number;
  readonly revenue: Money;
  readonly grossProfit: Money;
  readonly netProfit: Money;
  readonly losses: LossesBySource;
  readonly unitsSold: number;
  /** Completed sales by "productId/quality", keys sorted. */
  readonly sales: Readonly<Record<string, ProductSales>>;
  /** Index d: net worth at the start of day d, while the run lasted. */
  readonly netWorthByDay: readonly Money[];
  /** Spot price at the start of each day the run lasted, by "productId/quality", for basic and standard moonshine. */
  readonly spotByDay: Readonly<Record<string, readonly Money[]>>;
  readonly setback: Setback | null;
  /** Loss events over the whole run (seizures, failed runs, penalties). */
  readonly setbackCount: number;
  /** Route closures and supplier shortages that started during the run. */
  readonly disruptions: { readonly routeClosures: number; readonly shortages: number };
  readonly casesProduced: number;
  readonly contractsAccepted: number;
  readonly contractsCompleted: number;
  readonly installments: { readonly FULFILLED: number; readonly PARTIAL: number; readonly MISSED: number };
  /** Rejections at dispatch plus at apply time, by code. */
  readonly rejections: Partial<Record<RejectionCode, number>>;
  readonly invariantViolationCount: number;
  /** The first MAX_RECORDED_VIOLATIONS violations. */
  readonly invariantViolations: readonly RecordedViolation[];
  readonly stateHash: string;
  readonly replayStateHash: string;
  readonly replayDiverged: boolean;
}

/** Overrides for tests: the checks the runner applies, so a test can force each failure path. */
export interface BatchChecks {
  readonly invariants?: (state: GameState, last: LedgerTransaction) => readonly (InvariantViolation | { readonly code: string })[];
  readonly replay?: (original: KernelSimulation, setup: { readonly scenario: ScenarioDefinition; readonly data: GameData }) => string;
}

export interface BatchRunOptions {
  readonly days?: number;
  readonly scenario?: ScenarioDefinition;
  readonly data?: GameData;
  readonly checks?: BatchChecks;
  /** Wraps the command gateway the strategy sees, e.g. to record its commands in a test. */
  readonly gateway?: (sim: KernelSimulation) => Gateway;
}

/**
 * Replays a run's command log on a fresh game (ADR 0004 replay procedure, issue #66):
 * the envelopes due at or before the end tick, then advance to it, then the rest.
 */
export function replayStateHash(original: KernelSimulation, setup: { readonly scenario: ScenarioDefinition; readonly data: GameData }): string {
  const end = original.state.tick;
  const replayed = newGame(setup);
  const log = [...original.state.commandLog, ...original.state.queuedCommands];
  for (const e of log) if (e.scheduledTick <= end) replayed.replay(e);
  replayed.advance(end - replayed.state.tick);
  for (const e of log) if (e.scheduledTick > end) replayed.replay(e);
  return replayed.stateHash();
}

/** The next tick worth stopping at: a run completing, a truck arriving, midnight, or one the strategy asks for. */
function nextStop(s: GameSnapshot, end: number, wake: readonly number[]): number {
  const now = s.clock.tick;
  let next = Math.min(end, (Math.floor(now / TICKS_PER_DAY) + 1) * TICKS_PER_DAY);
  for (const job of s.productionJobs) if (job.completesAt > now) next = Math.min(next, job.completesAt);
  for (const v of s.vehicles) if (v.trip && v.trip.arrivesAt > now) next = Math.min(next, v.trip.arrivesAt);
  for (const t of wake) if (t > now) next = Math.min(next, t);
  return next;
}

/**
 * The simulation as a strategy sees it, with the snapshot memoized per state.
 * The kernel replaces its state object on every change, so the same object means
 * the same snapshot; this only saves re-projecting between commands.
 */
export function cachingGateway(sim: KernelSimulation): Gateway {
  let state: GameState | null = null;
  let snapshot: GameSnapshot | null = null;
  return {
    dispatch: (request) => sim.dispatch(request),
    snapshot: () => {
      if (snapshot === null || state !== sim.state) {
        state = sim.state;
        snapshot = sim.snapshot();
      }
      return snapshot;
    },
  };
}

const expense = (s: GameSnapshot, category: ExpenseCategory): Money =>
  s.finance.toDate.profit.expenses.find((e) => e.category === category)?.amount ?? (0 as Money);

export function runBatchSeed(strategy: HeadlessStrategyName, seed: number, options: BatchRunOptions = {}): BatchRunResult {
  const days = options.days ?? DEFAULT_BATCH_DAYS;
  if (!Number.isSafeInteger(days) || days < 1) throw new RangeError(`days must be a positive integer, got ${days}`);
  const data = options.data ?? GAME_DATA;
  const scenario: ScenarioDefinition = { ...(options.scenario ?? FIRST_SHIPMENT_SCENARIO), seed };
  const sim = newGame({ scenario, data });
  const gateway = options.gateway ? options.gateway(sim) : cachingGateway(sim);
  const invariants = options.checks?.invariants ?? checkInvariants;
  const replay = options.checks?.replay ?? replayStateHash;
  const end = days * TICKS_PER_DAY;

  const first = sim.snapshot();
  const bot = createHeadlessStrategy(strategy, first, seed, data);

  let firstProfitableSale: Milestone | null = null;
  let firstNetProfit: Milestone | null = null;
  let firstUpgrade: Milestone | null = null;
  let victory: Milestone | null = null;
  let lost: Milestone | null = null;
  const tierReached: Record<string, Milestone | null> = {};
  for (const t of data.progression.tiers) tierReached[t.id] = t.id === first.progression.currentTierId ? milestone(0) : null;
  let trough = { cash: first.finance.cash, tick: 0 };
  let unitsSold = 0;
  const sales = new Map<string, { completed: number; belowCost: number; breakEven: number; units: number; revenue: number; costOfGoodsSold: number }>();
  const netWorthByDay: Money[] = [];
  const watched = [BASIC_MOONSHINE_RECIPE, STANDARD_MOONSHINE_RECIPE]
    .map((id) => data.recipes.find((r) => r.id === id))
    .flatMap((r) => (r ? [`${r.productId}/${r.quality}`] : []));
  const spotByDay: Record<string, Money[]> = {};
  for (const key of watched) spotByDay[key] = [];
  // Assigned in closures, so the cast keeps TS from narrowing it to null here.
  let setback = null as { kind: SetbackKind; tick: number; loss: number; netWorthBefore: Money; recoveredAt: number | null } | null;
  let setbackCount = 0;
  let lastNetWorth = first.finance.netWorth;
  let victoryOnSettlement = false;
  const goal = data.progression.victory;
  const gates: { netWorth: number | null; reputation: number | null; completedContracts: number | null } = { netWorth: null, reputation: null, completedContracts: null };
  const settledAt = new Set<number>();
  let routeClosures = 0;
  let shortages = 0;
  let casesProduced = 0;
  let contractsAccepted = 0;
  let contractsCompleted = 0;
  const installments = { FULFILLED: 0, PARTIAL: 0, MISSED: 0 };
  let seizures = 0;
  let failedProduction = 0;
  let penalties = 0;
  let belowCostSales = 0;
  const applyRejections: Partial<Record<RejectionCode, number>> = {};
  const violations: RecordedViolation[] = [];
  let violationCount = 0;

  const lose = (kind: SetbackKind, tick: number, loss: number): void => {
    setbackCount++;
    setback ??= { kind, tick, loss, netWorthBefore: lastNetWorth, recoveredAt: null };
  };

  const observe = (events: readonly GameEvent[]): void => {
    for (const e of events) {
      switch (e.type) {
        case "SALE_COMPLETED": {
          const units = e.cargo.reduce((n, line) => n + line.quantity, 0);
          unitsSold += units;
          const line = e.cargo[0];
          const key = line ? `${line.productId}/${line.quality}` : "none";
          const tally = sales.get(key) ?? { completed: 0, belowCost: 0, breakEven: 0, units: 0, revenue: 0, costOfGoodsSold: 0 };
          tally.completed++;
          tally.units += units;
          tally.revenue += e.revenue;
          tally.costOfGoodsSold += e.costOfGoodsSold;
          if (e.revenue > e.costOfGoodsSold) firstProfitableSale ??= milestone(e.tick);
          else if (e.revenue < e.costOfGoodsSold) {
            tally.belowCost++;
            belowCostSales += e.costOfGoodsSold - e.revenue;
          } else tally.breakEven++;
          sales.set(key, tally);
          break;
        }
        case "SHORTAGE_STARTED":
          shortages++;
          break;
        case "ROUTE_CLOSED":
          routeClosures++;
          break;
        case "PRODUCTION_COMPLETED":
          casesProduced += e.quantity;
          break;
        case "PRODUCTION_FAILED":
          failedProduction += e.writtenOff;
          lose("FAILED_RUN", e.tick, e.writtenOff);
          break;
        case "CARGO_LOST":
          seizures += e.bookValue;
          lose("SEIZURE", e.tick, e.bookValue);
          break;
        case "INSTALLMENT_SETTLED":
          installments[e.outcome]++;
          penalties += e.penalty;
          settledAt.add(e.tick);
          if (e.penalty > 0) lose("PENALTY", e.tick, e.penalty);
          break;
        case "EQUIPMENT_PURCHASED":
          firstUpgrade ??= milestone(e.tick);
          break;
        case "CONTRACT_ACCEPTED":
          contractsAccepted++;
          break;
        case "CONTRACT_COMPLETED":
          contractsCompleted++;
          break;
        case "TIER_REACHED":
          tierReached[e.tierId] ??= milestone(e.tick);
          break;
        case "VICTORY_ACHIEVED":
          if (victory === null) victoryOnSettlement = settledAt.has(e.tick);
          victory ??= milestone(e.tick);
          break;
        case "GAME_LOST":
          lost ??= milestone(e.tick);
          break;
        case "COMMAND_REJECTED":
          applyRejections[e.reason.code] = (applyRejections[e.reason.code] ?? 0) + 1;
          break;
        default:
          break;
      }
    }
  };

  /** Takes the new events, tracks the cash trough and the day-start lines, and checks the invariants. */
  const stop = (): GameSnapshot => {
    observe(sim.takeEvents());
    const s = sim.snapshot();
    const now = s.clock.tick;
    if (s.finance.cash < trough.cash) trough = { cash: s.finance.cash, tick: now };
    if (s.finance.toDate.profit.netProfit > 0) firstNetProfit ??= milestone(now);
    if (setback !== null && setback.recoveredAt === null && s.finance.netWorth >= setback.netWorthBefore) setback.recoveredAt = now;
    lastNetWorth = s.finance.netWorth;
    if (s.finance.netWorth >= goal.netWorth) gates.netWorth ??= now;
    if (s.family.reputation >= goal.reputation) gates.reputation ??= now;
    if (contractsCompleted >= goal.completedContracts) gates.completedContracts ??= now;
    // Every midnight is a stop, so each day's start is recorded once.
    if (now % TICKS_PER_DAY === 0 && netWorthByDay.length === now / TICKS_PER_DAY) {
      netWorthByDay.push(s.finance.netWorth);
      for (const key of watched) {
        const quote = s.market.products.find((p) => `${p.productId}/${p.quality}` === key);
        spotByDay[key]!.push(quote?.spotPrice ?? (0 as Money));
      }
    }
    const state = sim.state;
    const last = state.ledger.transactions.at(-1);
    const found: { readonly code: string }[] = last ? [...invariants(state, last)] : [];
    const b = s.finance.balanceSheet;
    if (b.totalAssets !== b.totalLiabilities + b.equity) found.push({ code: "SNAPSHOT_BALANCE_SHEET_MISMATCH" });
    for (const v of found) {
      violationCount++;
      if (violations.length < MAX_RECORDED_VIOLATIONS) violations.push({ tick: state.tick, code: v.code });
    }
    return s;
  };

  let s = stop();
  for (;;) {
    if (s.outcome.status !== "PLAYING" || s.clock.tick >= end) break;
    bot.act(gateway);
    s = stop();
    sim.advance(nextStop(s, end, bot.wakeTicks(s)) - s.clock.tick);
    s = stop();
  }

  const stateHash = sim.stateHash();
  const replayHash = replay(sim, { scenario, data });
  const rejections: Partial<Record<RejectionCode, number>> = { ...bot.log.rejections };
  for (const [code, n] of Object.entries(applyRejections) as [RejectionCode, number][]) rejections[code] = (rejections[code] ?? 0) + n;
  const profit = s.finance.toDate.profit;

  return {
    strategy,
    seed,
    variant: bot.variant,
    outcome: s.outcome.status === "WON" ? "WON" : s.outcome.status === "LOST" ? "LOST" : "DAY_CAP",
    outcomeTick: s.outcome.status === "PLAYING" ? null : s.outcome.tick,
    endTick: s.clock.tick,
    firstProfitableSale,
    firstNetProfit,
    firstUpgrade,
    tierReached,
    victory,
    victoryOnSettlement,
    victoryGates: gates,
    lost,
    cashTrough: trough,
    finalNetWorth: s.finance.netWorth,
    finalCash: s.finance.cash,
    finalReputation: s.family.reputation,
    revenue: profit.revenue,
    grossProfit: profit.grossProfit,
    netProfit: profit.netProfit,
    losses: {
      seizures: seizures as Money,
      failedProduction: failedProduction as Money,
      penalties: penalties as Money,
      belowCostSales: belowCostSales as Money,
      transport: expense(s, "TRANSPORT"),
    },
    unitsSold,
    sales: Object.fromEntries(
      [...sales.keys()].sort().map((key) => {
        const t = sales.get(key)!;
        return [key, { ...t, revenue: t.revenue as Money, costOfGoodsSold: t.costOfGoodsSold as Money }];
      }),
    ),
    netWorthByDay,
    spotByDay,
    setback: setback === null ? null : { ...setback, loss: setback.loss as Money },
    setbackCount,
    disruptions: { routeClosures, shortages },
    casesProduced,
    contractsAccepted,
    contractsCompleted,
    installments,
    rejections,
    invariantViolationCount: violationCount,
    invariantViolations: violations,
    stateHash,
    replayStateHash: replayHash,
    replayDiverged: replayHash !== stateHash,
  };
}
