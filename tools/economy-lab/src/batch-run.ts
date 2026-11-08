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
// settlement. T07e (issue #127) judges only moderate setbacks (a loss of at least
// `TARGETS.moderateSetbackMinPercent` of net worth) and moves the event
// classifiers into `RunObserver` so they can be tested on crafted events.
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
import { TARGETS } from "./targets.ts";

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
 * The run's first moderate setback (issue #127): the first event that booked a
 * loss (cargo seized, a production run's inputs written off, or an installment
 * penalty) of at least `TARGETS.moderateSetbackMinPercent` of net worth at the
 * moment it was booked. Smaller losses are counted (`setbackCount`) but never
 * judged.
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
  /** The first moderate setback, or null. */
  readonly setback: Setback | null;
  /** Loss events over the whole run (seizures, failed runs, penalties), of any size. */
  readonly setbackCount: number;
  /** The loss events among them that were moderate. */
  readonly moderateSetbackCount: number;
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
  /** Called with the snapshot at every stop, e.g. so a test can follow net worth. */
  readonly onStop?: (snapshot: GameSnapshot) => void;
  /** Overrides the moderate-setback threshold (percent of net worth), e.g. 0 so a test can judge any loss. */
  readonly setbackMinPercent?: number;
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

/** Whether a loss is moderate: at least `minPercent` of net worth when it was booked. Any loss is, once net worth is at or below zero. */
export function isModerateLoss(loss: number, netWorthBefore: number, minPercent: number = TARGETS.moderateSetbackMinPercent): boolean {
  return loss * 100 >= minPercent * netWorthBefore;
}

type MutableSales = { completed: number; belowCost: number; breakEven: number; units: number; revenue: number; costOfGoodsSold: number };

/**
 * What a batch run reads from the game's events, apart from the snapshot: sales
 * and their classification, losses and setbacks, milestones, and counts. Fed in
 * order: `observe` with each stop's events, then `atStop` with that stop's net
 * worth. Exported so its classifiers can be tested on crafted events.
 */
export class RunObserver {
  firstProfitableSale: Milestone | null = null;
  firstUpgrade: Milestone | null = null;
  victory: Milestone | null = null;
  victoryOnSettlement = false;
  lost: Milestone | null = null;
  unitsSold = 0;
  seizures = 0;
  failedProduction = 0;
  penalties = 0;
  belowCostSales = 0;
  setbackCount = 0;
  moderateSetbackCount = 0;
  routeClosures = 0;
  shortages = 0;
  casesProduced = 0;
  contractsAccepted = 0;
  contractsCompleted = 0;
  readonly installments = { FULFILLED: 0, PARTIAL: 0, MISSED: 0 };
  readonly applyRejections: Partial<Record<RejectionCode, number>> = {};
  private readonly sales = new Map<string, MutableSales>();
  private readonly settledAt = new Set<number>();
  private first: { kind: SetbackKind; tick: number; loss: number; netWorthBefore: Money; recoveredAt: number | null } | null = null;
  private lastNetWorth: Money;
  private readonly tierReached: Record<string, Milestone | null>;
  private readonly setbackMinPercent: number;

  /**
   * @param tierReached the run's tier milestones, filled in as tiers are reached
   * @param openingNetWorth net worth before the first stop
   * @param setbackMinPercent the moderate-setback threshold, in percent of net worth
   */
  constructor(tierReached: Record<string, Milestone | null>, openingNetWorth: Money, setbackMinPercent: number = TARGETS.moderateSetbackMinPercent) {
    this.tierReached = tierReached;
    this.lastNetWorth = openingNetWorth;
    this.setbackMinPercent = setbackMinPercent;
  }

  /** A loss booked at `tick`. Net worth before it is the last stop's. */
  private lose(kind: SetbackKind, tick: number, loss: number): void {
    this.setbackCount++;
    if (!isModerateLoss(loss, this.lastNetWorth, this.setbackMinPercent)) return;
    this.moderateSetbackCount++;
    this.first ??= { kind, tick, loss, netWorthBefore: this.lastNetWorth, recoveredAt: null };
  }

  observe(events: readonly GameEvent[]): void {
    for (const e of events) {
      switch (e.type) {
        case "SALE_COMPLETED": {
          const units = e.cargo.reduce((n, line) => n + line.quantity, 0);
          this.unitsSold += units;
          // A sale is attributed to its first cargo line's product and quality. That
          // holds while SALE_COMPLETED carries a single unitPrice: one price means one
          // product and quality per sale, so the first line speaks for every line. If
          // mixed cargo ever sells in one event (a price per line), split the tally by
          // line here, or revenue and cost would land on the wrong product.
          const line = e.cargo[0];
          const key = line ? `${line.productId}/${line.quality}` : "none";
          const tally = this.sales.get(key) ?? { completed: 0, belowCost: 0, breakEven: 0, units: 0, revenue: 0, costOfGoodsSold: 0 };
          tally.completed++;
          tally.units += units;
          tally.revenue += e.revenue;
          tally.costOfGoodsSold += e.costOfGoodsSold;
          if (e.revenue > e.costOfGoodsSold) this.firstProfitableSale ??= milestone(e.tick);
          else if (e.revenue < e.costOfGoodsSold) {
            tally.belowCost++;
            this.belowCostSales += e.costOfGoodsSold - e.revenue;
          } else tally.breakEven++;
          this.sales.set(key, tally);
          break;
        }
        case "SHORTAGE_STARTED":
          this.shortages++;
          break;
        case "ROUTE_CLOSED":
          this.routeClosures++;
          break;
        case "PRODUCTION_COMPLETED":
          this.casesProduced += e.quantity;
          break;
        case "PRODUCTION_FAILED":
          this.failedProduction += e.writtenOff;
          this.lose("FAILED_RUN", e.tick, e.writtenOff);
          break;
        case "CARGO_LOST":
          this.seizures += e.bookValue;
          this.lose("SEIZURE", e.tick, e.bookValue);
          break;
        case "INSTALLMENT_SETTLED":
          this.installments[e.outcome]++;
          this.penalties += e.penalty;
          this.settledAt.add(e.tick);
          if (e.penalty > 0) this.lose("PENALTY", e.tick, e.penalty);
          break;
        case "EQUIPMENT_PURCHASED":
          this.firstUpgrade ??= milestone(e.tick);
          break;
        case "CONTRACT_ACCEPTED":
          this.contractsAccepted++;
          break;
        case "CONTRACT_COMPLETED":
          this.contractsCompleted++;
          break;
        case "TIER_REACHED":
          this.tierReached[e.tierId] ??= milestone(e.tick);
          break;
        case "VICTORY_ACHIEVED":
          if (this.victory === null) this.victoryOnSettlement = this.settledAt.has(e.tick);
          this.victory ??= milestone(e.tick);
          break;
        case "GAME_LOST":
          this.lost ??= milestone(e.tick);
          break;
        case "COMMAND_REJECTED":
          this.applyRejections[e.reason.code] = (this.applyRejections[e.reason.code] ?? 0) + 1;
          break;
        default:
          break;
      }
    }
  }

  /** Net worth at a stop, after its events: marks the setback recovered once net worth is back to its pre-setback level. */
  atStop(tick: number, netWorth: Money): void {
    const first = this.first;
    if (first !== null && first.recoveredAt === null && netWorth >= first.netWorthBefore) first.recoveredAt = tick;
    this.lastNetWorth = netWorth;
  }

  setback(): Setback | null {
    return this.first === null ? null : { ...this.first, loss: this.first.loss as Money };
  }

  /** Completed sales by "productId/quality", keys sorted. */
  salesByProduct(): Record<string, ProductSales> {
    return Object.fromEntries(
      [...this.sales.keys()].sort().map((key) => {
        const t = this.sales.get(key)!;
        return [key, { ...t, revenue: t.revenue as Money, costOfGoodsSold: t.costOfGoodsSold as Money }];
      }),
    );
  }
}

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

  let firstNetProfit: Milestone | null = null;
  const tierReached: Record<string, Milestone | null> = {};
  for (const t of data.progression.tiers) tierReached[t.id] = t.id === first.progression.currentTierId ? milestone(0) : null;
  const tracker = new RunObserver(tierReached, first.finance.netWorth, options.setbackMinPercent ?? TARGETS.moderateSetbackMinPercent);
  let trough = { cash: first.finance.cash, tick: 0 };
  const netWorthByDay: Money[] = [];
  const watched = [BASIC_MOONSHINE_RECIPE, STANDARD_MOONSHINE_RECIPE]
    .map((id) => data.recipes.find((r) => r.id === id))
    .flatMap((r) => (r ? [`${r.productId}/${r.quality}`] : []));
  const spotByDay: Record<string, Money[]> = {};
  for (const key of watched) spotByDay[key] = [];
  const goal = data.progression.victory;
  const gates: { netWorth: number | null; reputation: number | null; completedContracts: number | null } = { netWorth: null, reputation: null, completedContracts: null };
  const violations: RecordedViolation[] = [];
  let violationCount = 0;

  /** Takes the new events, tracks the cash trough and the day-start lines, and checks the invariants. */
  const stop = (): GameSnapshot => {
    tracker.observe(sim.takeEvents());
    const s = sim.snapshot();
    const now = s.clock.tick;
    options.onStop?.(s);
    if (s.finance.cash < trough.cash) trough = { cash: s.finance.cash, tick: now };
    if (s.finance.toDate.profit.netProfit > 0) firstNetProfit ??= milestone(now);
    tracker.atStop(now, s.finance.netWorth);
    if (s.finance.netWorth >= goal.netWorth) gates.netWorth ??= now;
    if (s.family.reputation >= goal.reputation) gates.reputation ??= now;
    if (tracker.contractsCompleted >= goal.completedContracts) gates.completedContracts ??= now;
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
  for (const [code, n] of Object.entries(tracker.applyRejections) as [RejectionCode, number][]) rejections[code] = (rejections[code] ?? 0) + n;
  const profit = s.finance.toDate.profit;

  return {
    strategy,
    seed,
    variant: bot.variant,
    outcome: s.outcome.status === "WON" ? "WON" : s.outcome.status === "LOST" ? "LOST" : "DAY_CAP",
    outcomeTick: s.outcome.status === "PLAYING" ? null : s.outcome.tick,
    endTick: s.clock.tick,
    firstProfitableSale: tracker.firstProfitableSale,
    firstNetProfit,
    firstUpgrade: tracker.firstUpgrade,
    tierReached,
    victory: tracker.victory,
    victoryOnSettlement: tracker.victoryOnSettlement,
    victoryGates: gates,
    lost: tracker.lost,
    cashTrough: trough,
    finalNetWorth: s.finance.netWorth,
    finalCash: s.finance.cash,
    finalReputation: s.family.reputation,
    revenue: profit.revenue,
    grossProfit: profit.grossProfit,
    netProfit: profit.netProfit,
    losses: {
      seizures: tracker.seizures as Money,
      failedProduction: tracker.failedProduction as Money,
      penalties: tracker.penalties as Money,
      belowCostSales: tracker.belowCostSales as Money,
      transport: expense(s, "TRANSPORT"),
    },
    unitsSold: tracker.unitsSold,
    sales: tracker.salesByProduct(),
    netWorthByDay,
    spotByDay,
    setback: tracker.setback(),
    setbackCount: tracker.setbackCount,
    moderateSetbackCount: tracker.moderateSetbackCount,
    disruptions: { routeClosures: tracker.routeClosures, shortages: tracker.shortages },
    casesProduced: tracker.casesProduced,
    contractsAccepted: tracker.contractsAccepted,
    contractsCompleted: tracker.contractsCompleted,
    installments: tracker.installments,
    rejections,
    invariantViolationCount: violationCount,
    invariantViolations: violations,
    stateHash,
    replayStateHash: replayHash,
    replayDiverged: replayHash !== stateHash,
  };
}
