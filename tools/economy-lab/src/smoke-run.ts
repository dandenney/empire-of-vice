// One seeded smoke run (T07a, issue #12): a strategy (the greedy spot seller by
// default, or T05g's contract-taking variant) plays The First Shipment for a
// number of game days, and the run records the pacing metrics GDD §13 asks
// about, plus tiers, victory, and insolvency (T05g, issue #106).
//
// The run is event-driven. It stops wherever something the bot can react to
// happens (a run completes, the truck arrives or gets home, midnight) and lets
// the bot act there. Between stops nothing changes that the bot could use, so
// the result is the same as checking every tick, only faster. Cash only moves at
// those stops or when the bot acts, so sampling there gives the exact trough.

import {
  TICKS_PER_DAY,
  type GameEvent,
  type GameSnapshot,
  type InvariantViolation,
  type Money,
  type RejectionCode,
} from "@eov/contracts";
import { FIRST_SHIPMENT_SCENARIO, GAME_DATA, STANDARD_MOONSHINE_RECIPE, type GameData, type ScenarioDefinition } from "@eov/game-data";
import { checkInvariants, newGame, type KernelSimulation } from "@eov/simulation";
import { ContractTakerStrategy, CONTRACT_STRATEGY } from "./contract-taker.ts";
import { GreedySpotStrategy, STRATEGY, type Strategy, type StrategyLog } from "./greedy-spot.ts";
import { TICKS_PER_REAL_MINUTE } from "./targets.ts";

export { TICKS_PER_REAL_MINUTE } from "./targets.ts";

/** Default run length (issue #12 refresh): 10 game days, 14 400 ticks. */
export const DEFAULT_DAYS = 10;

/** The day whose opening net worth feeds ADR 0018's contract timing (decision 9). */
export const NET_WORTH_DAY = 5;

/** The strategies the smoke runner can play. */
export const STRATEGY_NAMES = [STRATEGY.name, CONTRACT_STRATEGY.name] as const;
export type StrategyName = (typeof STRATEGY_NAMES)[number];

export function createStrategy(name: StrategyName, first: GameSnapshot, data: GameData): Strategy {
  return name === CONTRACT_STRATEGY.name ? new ContractTakerStrategy(first, data) : new GreedySpotStrategy(first, data);
}

export interface SmokeOptions {
  readonly days?: number;
  readonly scenario?: ScenarioDefinition;
  readonly data?: GameData;
  /** Default: the greedy spot seller. */
  readonly strategy?: StrategyName;
}

/** Installment outcomes over a run. */
export interface InstallmentTally {
  readonly FULFILLED: number;
  readonly PARTIAL: number;
  readonly MISSED: number;
}

/** A tick, and the same moment in real minutes at 1×. */
export interface Milestone {
  readonly tick: number;
  readonly realMinutes: number;
}

/** One finished game day. */
export interface DayRecord {
  /** The day index that just ended (0 = the first day). */
  readonly day: number;
  /** At the midnight that ends the day, after settlement. */
  readonly netWorth: Money;
  readonly cash: Money;
  readonly revenue: Money;
  readonly grossProfit: Money;
  readonly netProfit: Money;
  readonly unitsSold: number;
}

/** The strategy's product market on one day, as quoted at that day's start. */
export interface MarketDay {
  readonly day: number;
  readonly spotPrice: Money;
  readonly demandRatioPpm: number;
  readonly supplyRatioPpm: number;
  readonly eventRatioPpm: number;
  /** The most any input material cost per unit that day. */
  readonly maxInputPrice: Money;
  readonly shortage: boolean;
}

export interface SeedReport {
  readonly seed: number;
  readonly days: number;
  readonly strategy: string;
  /** False for a strategy that never takes contracts: tier 2 and the upgrades are out of its reach. */
  readonly takesContracts: boolean;
  /** First sale whose revenue beat its cost of goods sold. */
  readonly firstProfitableSale: Milestone | null;
  /** First time profit to date (after wages and overhead) went above zero. */
  readonly firstNetProfit: Milestone | null;
  /** When the bot bought its upgrade: cash covered the price plus its working-capital reserve. */
  readonly firstUpgrade: Milestone | null;
  /** First time profit to date covered the upgrade's price: the upgrade paid for out of earnings. */
  readonly upgradeEarned: Milestone | null;
  readonly upgradePrice: Money;
  /** When the bot bought the QC station (tier 3). */
  readonly qualityUpgrade: Milestone | null;
  /** When each tier was reached, by tier ID in ladder order. The starting tier is reached at tick 0. */
  readonly tierReached: Readonly<Record<string, Milestone | null>>;
  readonly victory: Milestone | null;
  /** `GAME_LOST` (insolvency). */
  readonly lost: Milestone | null;
  readonly finalReputation: number;
  readonly contractsAccepted: number;
  readonly contractsCompleted: number;
  readonly installments: InstallmentTally;
  /** Index d: net worth at the start of day d (tick d × 1 440). Index 0 is the opening. */
  readonly netWorthByDay: readonly Money[];
  readonly netWorthAtDay5: Money | null;
  readonly cashTrough: { readonly cash: Money; readonly tick: number };
  readonly unitsSold: number;
  readonly casesProduced: number;
  /** Completed sales (SALE_COMPLETED), not dispatches: the denominator for the two counts below. */
  readonly salesCompleted: number;
  /** Completed sales whose revenue was below their cost of goods sold. */
  readonly belowCostSales: number;
  /** Completed sales whose revenue exactly equalled their cost of goods sold. */
  readonly breakEvenSales: number;
  readonly daily: readonly DayRecord[];
  /** The strategy's product (basic moonshine) market, one entry per day. */
  readonly market: readonly MarketDay[];
  /** The standard-moonshine market on the same days, beside the basic one (#118 review). */
  readonly standardMarket: readonly MarketDay[];
  /** Day index the seeded shortage started, or null if it didn't start in the run. */
  readonly shortageStartDay: number | null;
  readonly unitsByBuyer: Readonly<Record<string, number>>;
  readonly saleCaps: StrategyLog["saleCaps"];
  readonly productionCaps: StrategyLog["productionCaps"];
  /** Rejections at dispatch plus at apply time, by code. */
  readonly rejections: Partial<Record<RejectionCode, number>>;
  readonly finalNetWorth: Money;
  readonly finalCash: Money;
  readonly stateHash: string;
}

/** End-of-day reconciliation found a broken invariant. The coordinator should have thrown first. */
export class SmokeInvariantError extends Error {
  override readonly name = "SmokeInvariantError";
  readonly violations: readonly (InvariantViolation | { readonly code: string })[];
  constructor(seed: number, tick: number, violations: readonly (InvariantViolation | { readonly code: string })[]) {
    super(`Seed ${seed}, tick ${tick}: ${violations.map((v) => v.code).join(", ")}`);
    this.violations = violations;
  }
}

export function milestone(tick: number): Milestone {
  return { tick, realMinutes: tick / TICKS_PER_REAL_MINUTE };
}

/** The next tick worth stopping at: a run completing, a truck arriving, midnight, or one the strategy asks for. */
function nextStop(s: GameSnapshot, end: number, bot: Strategy): number {
  const now = s.clock.tick;
  let next = Math.min(end, (Math.floor(now / TICKS_PER_DAY) + 1) * TICKS_PER_DAY);
  for (const job of s.productionJobs) if (job.completesAt > now) next = Math.min(next, job.completesAt);
  for (const v of s.vehicles) if (v.trip && v.trip.arrivesAt > now) next = Math.min(next, v.trip.arrivesAt);
  for (const t of bot.wakeTicks(s)) if (t > now) next = Math.min(next, t);
  return next;
}

function reconcile(sim: KernelSimulation, seed: number): void {
  const state = sim.state;
  const last = state.ledger.transactions.at(-1);
  const violations: (InvariantViolation | { readonly code: string })[] = last ? [...checkInvariants(state, last)] : [];
  const b = sim.snapshot().finance.balanceSheet;
  if (b.totalAssets !== b.totalLiabilities + b.equity) violations.push({ code: "SNAPSHOT_BALANCE_SHEET_MISMATCH" });
  if (violations.length > 0) throw new SmokeInvariantError(seed, state.tick, violations);
}

export function runSmokeSeed(seed: number, options: SmokeOptions = {}): SeedReport {
  const days = options.days ?? DEFAULT_DAYS;
  if (!Number.isSafeInteger(days) || days < 1) throw new RangeError(`days must be a positive integer, got ${days}`);
  const data = options.data ?? GAME_DATA;
  const scenario: ScenarioDefinition = { ...(options.scenario ?? FIRST_SHIPMENT_SCENARIO), seed };
  const sim = newGame({ scenario, data });
  const end = days * TICKS_PER_DAY;

  const first = sim.snapshot();
  const bot = createStrategy(options.strategy ?? STRATEGY.name, first, data);
  const recipe = data.recipes.find((r) => r.id === STRATEGY.recipeId)!;
  const standardRecipe = data.recipes.find((r) => r.id === STANDARD_MOONSHINE_RECIPE);
  const upgradePrice = data.equipment.find((e) => e.id === STRATEGY.upgradeId)?.price ?? (0 as Money);

  let firstProfitableSale: Milestone | null = null;
  let firstNetProfit: Milestone | null = null;
  let upgradeEarned: Milestone | null = null;
  let shortageStartDay: number | null = null;
  let trough = { cash: first.finance.cash, tick: 0 };
  let unitsSold = 0;
  let unitsToday = 0;
  let casesProduced = 0;
  let salesCompleted = 0;
  let belowCostSales = 0;
  let breakEvenSales = 0;
  const unitsByBuyer: Record<string, number> = {};
  const applyRejections: Partial<Record<RejectionCode, number>> = {};
  const netWorthByDay: Money[] = [first.finance.netWorth];
  const daily: DayRecord[] = [];
  const market: MarketDay[] = [];
  const standardMarket: MarketDay[] = [];
  const tierReached: Record<string, Milestone | null> = {};
  for (const t of data.progression.tiers) tierReached[t.id] = t.id === first.progression.currentTierId ? milestone(0) : null;
  let victory: Milestone | null = null;
  let lost: Milestone | null = null;
  let contractsCompleted = 0;
  const installments = { FULFILLED: 0, PARTIAL: 0, MISSED: 0 };

  const recordQuote = (s: GameSnapshot, of: GameData["recipes"][number], into: MarketDay[]): void => {
    const quote = s.market.products.find((p) => p.productId === of.productId && p.quality === of.quality);
    if (!quote) return;
    const inputs = new Set(of.inputsPerCase.map((i) => i.materialId));
    const lines = s.market.suppliers.flatMap((sup) => sup.materials).filter((m) => inputs.has(m.materialId));
    into.push({
      day: s.clock.dayIndex,
      spotPrice: quote.spotPrice,
      demandRatioPpm: quote.demandRatioPpm,
      supplyRatioPpm: quote.supplyRatioPpm,
      eventRatioPpm: quote.eventRatioPpm,
      maxInputPrice: lines.reduce((m, l) => Math.max(m, l.unitPrice), 0) as Money,
      shortage: lines.some((l) => l.shortage),
    });
  };
  const recordMarket = (s: GameSnapshot): void => {
    recordQuote(s, recipe, market);
    if (standardRecipe) recordQuote(s, standardRecipe, standardMarket);
  };

  const observe = (events: readonly GameEvent[]): void => {
    for (const e of events) {
      switch (e.type) {
        case "SALE_COMPLETED": {
          const quantity = e.cargo.reduce((n, line) => n + line.quantity, 0);
          unitsSold += quantity;
          unitsToday += quantity;
          unitsByBuyer[e.buyerId] = (unitsByBuyer[e.buyerId] ?? 0) + quantity;
          salesCompleted++;
          if (e.revenue > e.costOfGoodsSold) firstProfitableSale ??= milestone(e.tick);
          else if (e.revenue < e.costOfGoodsSold) belowCostSales++;
          else breakEvenSales++;
          break;
        }
        case "PRODUCTION_COMPLETED":
          casesProduced += e.quantity;
          break;
        case "SHORTAGE_STARTED":
          shortageStartDay ??= Math.floor(e.tick / TICKS_PER_DAY);
          break;
        case "TIER_REACHED":
          tierReached[e.tierId] ??= milestone(e.tick);
          break;
        case "VICTORY_ACHIEVED":
          victory ??= milestone(e.tick);
          break;
        case "GAME_LOST":
          lost ??= milestone(e.tick);
          break;
        case "INSTALLMENT_SETTLED":
          installments[e.outcome]++;
          break;
        case "CONTRACT_COMPLETED":
          contractsCompleted++;
          break;
        case "COMMAND_REJECTED":
          applyRejections[e.reason.code] = (applyRejections[e.reason.code] ?? 0) + 1;
          break;
        default:
          break;
      }
    }
  };

  const sample = (): GameSnapshot => {
    observe(sim.takeEvents());
    const s = sim.snapshot();
    if (s.finance.cash < trough.cash) trough = { cash: s.finance.cash, tick: s.clock.tick };
    const profit = s.finance.toDate.profit.netProfit;
    if (profit > 0) firstNetProfit ??= milestone(s.clock.tick);
    if (upgradePrice > 0 && profit >= upgradePrice) upgradeEarned ??= milestone(s.clock.tick);
    return s;
  };

  recordMarket(first);
  for (;;) {
    bot.act(sim);
    const s = sample();
    if (s.clock.tick >= end) break;
    sim.advance(nextStop(s, end, bot) - s.clock.tick);
    const after = sample();
    const t = after.clock.tick;
    if (t % TICKS_PER_DAY === 0) {
      reconcile(sim, seed);
      const day = after.finance.previousDay!;
      daily.push({
        day: t / TICKS_PER_DAY - 1,
        netWorth: after.finance.netWorth,
        cash: after.finance.cash,
        revenue: day.profit.revenue,
        grossProfit: day.profit.grossProfit,
        netProfit: day.profit.netProfit,
        unitsSold: unitsToday,
      });
      unitsToday = 0;
      netWorthByDay.push(after.finance.netWorth);
      if (t < end) recordMarket(after);
    }
  }

  const last = sim.snapshot();
  const rejections: Partial<Record<RejectionCode, number>> = { ...bot.log.rejections };
  for (const [code, n] of Object.entries(applyRejections) as [RejectionCode, number][]) rejections[code] = (rejections[code] ?? 0) + n;

  return {
    seed,
    days,
    strategy: bot.name,
    takesContracts: bot.takesContracts,
    firstProfitableSale,
    firstNetProfit,
    firstUpgrade: bot.log.upgradeBoughtAt === null ? null : milestone(bot.log.upgradeBoughtAt),
    upgradeEarned,
    upgradePrice,
    qualityUpgrade: bot.log.qualityUpgradeBoughtAt === null ? null : milestone(bot.log.qualityUpgradeBoughtAt),
    tierReached,
    victory,
    lost,
    finalReputation: last.family.reputation,
    contractsAccepted: bot.log.contractsAccepted,
    contractsCompleted,
    installments,
    netWorthByDay,
    netWorthAtDay5: netWorthByDay[NET_WORTH_DAY] ?? null,
    cashTrough: trough,
    unitsSold,
    casesProduced,
    salesCompleted,
    belowCostSales,
    breakEvenSales,
    daily,
    market,
    standardMarket,
    shortageStartDay,
    unitsByBuyer,
    saleCaps: { ...bot.log.saleCaps },
    productionCaps: { ...bot.log.productionCaps },
    rejections,
    finalNetWorth: last.finance.netWorth,
    finalCash: last.finance.cash,
    stateHash: sim.stateHash(),
  };
}
