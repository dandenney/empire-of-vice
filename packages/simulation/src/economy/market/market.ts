// ECO-001 daily market (T02d, issue #8; GDD §7; ADR 0016).
//
// - Opening market, supplier, and buyer state from game-data.
// - The bounded spot price formula (`priceInputs`), and market-data validation.
// - The midnight cycle, one entry-free DAILY_SETTLEMENT transaction in GDD §7
//   order: replenish suppliers, refresh buyers, seeded events, prices, report.
// - Seeded ingredient shortages (SHORTAGE_START / SHORTAGE_END world events).
// - PURCHASE_MATERIALS at the supplier's current price.
// - The market side of deals (ADR 0005, ADR 0022 decision 6): AGREE_DEAL quotes
//   and commits a held deal, keyed by the deal (`deal-<n>`); a HELD deal that
//   reaches `expiresAt` expires (DEAL_EXPIRED) in the deadlines phase. Logistics
//   dispatches, settles and releases them inside its DISPATCH and SALE
//   transactions. Founder rules off only: in person, budget committed; the
//   on-spec path is SK1c-2's (#226) and by-phone deals ADR 0024's.
// - PURCHASE_MATERIALS and AGREE_DEAL are judged by their order validators
//   against the issuer's view (ADR 0022 decisions 1–3, `view/`).

import {
  addMoney,
  addTicks,
  applyRatios,
  compareById,
  clampRatio,
  dayIndex,
  idempotencyKey,
  multiplyMoney,
  qualityRank,
  RATIO_ONE,
  RATIO_SCALE,
  ratioOf,
  subtractMoney,
  tick,
  TICKS_PER_DAY,
  type BuyerId,
  type BuyerState,
  type CargoLine,
  type DealId,
  type DeliveryId,
  type EventOfType,
  type GameState,
  type HeldDealState,
  type MarketState,
  type Money,
  type ProductId,
  type QualityTier,
  type Ratio,
  type RejectionReason,
  type SupplierState,
  type Tick,
  type TransactionCoordinator,
} from "@eov/contracts";
import {
  DEAL_HOLD_TICKS,
  MARKET_PRICE_BOUNDS,
  type BuyerDefinition,
  type GameData,
  type MarketDefinition,
  type ScenarioDefinition,
  type ShortageDefinition,
  type SupplierStockDefinition,
} from "@eov/game-data";
import { scheduleWorldEvent } from "../../events/world-events.ts";
import { allocateId, formatId } from "../../kernel/ids.ts";
import type { CommandOfType, SystemRegistry, TickContext } from "../../kernel/registry.ts";
import { addMaterial } from "../../inventory/pools.ts";
import { nextIntBetween } from "../../rng/xoshiro128.ts";
import { materialPurchaseEntries } from "../ledger/postings.ts";
import { M001_RULES, type GameRules } from "../../kernel/rules.ts";
import { judgeOrder, type OrderValidator } from "../../view/order.ts";
import { presenceRejection } from "../../view/presence.ts";
import { cashOf, type WorldSlice } from "../../view/world.ts";

// ---------------------------------------------------------------------------
// Lookups and ordering
// ---------------------------------------------------------------------------

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** ADR 0016 market order: product ID, then quality rank. */
function compareMarkets(a: { readonly productId: ProductId; readonly quality: QualityTier }, b: typeof a): number {
  return byString(a.productId, b.productId) || qualityRank(a.quality) - qualityRank(b.quality);
}

function marketDefinition(data: GameData, productId: ProductId, quality: QualityTier): MarketDefinition {
  const def = data.markets.find((m) => m.productId === productId && m.quality === quality);
  if (!def) throw new RangeError(`No market definition for ${productId} ${quality}`);
  return def;
}

function basePriceOf(data: GameData, productId: ProductId, quality: QualityTier): Money {
  const product = data.products.find((p) => p.id === productId);
  if (!product) throw new RangeError(`Market for unknown product ${productId}`);
  return product.basePrice[quality];
}

function buyerDefinition(data: GameData, id: BuyerId): BuyerDefinition | undefined {
  return data.buyers.find((b) => b.id === id);
}

function stockDefinition(data: GameData, supplierId: string, materialId: string): SupplierStockDefinition | undefined {
  return data.suppliers.find((s) => s.id === supplierId)?.stock.find((st) => st.materialId === materialId);
}

/** floor(n × ppm / 10⁶) in exact integer arithmetic, for non-negative n and ppm. */
function floorPpm(n: number, ppm: number): number {
  return Number((BigInt(n) * BigInt(ppm)) / BigInt(RATIO_SCALE));
}

/**
 * The buyer's most specific want for a line (ADR 0016): the want for the line's
 * product with the highest minimum quality at or below the line's quality.
 */
function matchWant<W extends { readonly productId: ProductId; readonly minimumQuality: QualityTier }>(
  wants: readonly W[],
  productId: ProductId,
  quality: QualityTier,
): W | undefined {
  let best: W | undefined;
  for (const w of wants) {
    if (w.productId !== productId || qualityRank(w.minimumQuality) > qualityRank(quality)) continue;
    if (!best || qualityRank(w.minimumQuality) > qualityRank(best.minimumQuality)) best = w;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Spot price (GDD §7, ADR 0016)
// ---------------------------------------------------------------------------

/**
 * The clamped spot price multipliers [M_D, M_S, M_E] in ppm, ready for
 * `applyRatios(P_base, …)`: M_D = clamp(D / D₀), M_S = clamp(S₀ / max(S, 1)),
 * M_E = clamp(eventRatio), with the GDD §7 bounds from game-data.
 */
export function priceInputs(
  market: Pick<MarketState, "demand" | "supply" | "eventRatio">,
  definition: Pick<MarketDefinition, "baselineDemand" | "baselineSupply">,
): readonly [Ratio, Ratio, Ratio] {
  const { demand, supply, event } = MARKET_PRICE_BOUNDS;
  return [
    clampRatio(ratioOf(market.demand, definition.baselineDemand), demand.min, demand.max),
    clampRatio(ratioOf(definition.baselineSupply, Math.max(market.supply, 1)), supply.min, supply.max),
    clampRatio(market.eventRatio, event.min, event.max),
  ];
}

/** The spot price for a market as it stands: one rounding, half up to the cent. */
function spotPriceOf(data: GameData, market: Pick<MarketState, "productId" | "quality" | "demand" | "supply" | "eventRatio">): Money {
  const def = marketDefinition(data, market.productId, market.quality);
  return applyRatios(basePriceOf(data, market.productId, market.quality), priceInputs(market, def));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Invalid market, buyer, or supplier data. Thrown when the market system registers. */
export class MarketDataError extends Error {
  override readonly name = "MarketDataError";
}

function isPositiveInteger(n: number): boolean {
  return Number.isSafeInteger(n) && n > 0;
}

/**
 * Checks the market, buyer, and supplier definitions against GDD §7 and ADR 0016.
 * Throws MarketDataError on the first problem found.
 */
export function validateMarketData(data: GameData): void {
  const fail = (message: string): never => {
    throw new MarketDataError(message);
  };
  const hasMarket = (productId: ProductId, quality: QualityTier) => data.markets.some((m) => m.productId === productId && m.quality === quality);

  const seenMarkets = new Set<string>();
  for (const m of data.markets) {
    const key = `${m.productId}/${m.quality}`;
    if (seenMarkets.has(key)) fail(`Market ${key} is defined twice`);
    seenMarkets.add(key);
    if (!data.products.some((p) => p.id === m.productId)) fail(`Market ${key} has no product definition`);
    if (!isPositiveInteger(m.baselineDemand)) fail(`Market ${key}: D₀ must be a positive integer, got ${m.baselineDemand}`);
    if (!isPositiveInteger(m.baselineSupply)) fail(`Market ${key}: S₀ must be a positive integer, got ${m.baselineSupply}`);
    if (!Number.isSafeInteger(m.demandDriftPpm) || m.demandDriftPpm < 0 || m.demandDriftPpm >= RATIO_SCALE) {
      fail(`Market ${key}: demandDriftPpm must be an integer in [0, ${RATIO_SCALE}), got ${m.demandDriftPpm}`);
    }
  }

  for (const b of data.buyers) {
    if (!Number.isSafeInteger(b.minimumReputation) || b.minimumReputation < 0 || b.minimumReputation > 100) {
      fail(`Buyer ${b.id}: minimumReputation must be an integer in [0, 100], got ${b.minimumReputation}`);
    }
    if (!Number.isSafeInteger(b.dailyBudget) || b.dailyBudget < 0) fail(`Buyer ${b.id}: dailyBudget must not be negative, got ${b.dailyBudget}`);
    const seenWants = new Set<string>();
    for (const w of b.wants) {
      const key = `${w.productId}/${w.minimumQuality}`;
      if (seenWants.has(key)) fail(`Buyer ${b.id} has two wants for ${key}`);
      seenWants.add(key);
      if (!hasMarket(w.productId, w.minimumQuality)) fail(`Buyer ${b.id} wants ${key}, which has no market`);
      if (!isPositiveInteger(w.dailyDemand)) fail(`Buyer ${b.id} want ${key}: dailyDemand must be a positive integer, got ${w.dailyDemand}`);
      if (!Number.isSafeInteger(w.priceRatio) || w.priceRatio <= 0) fail(`Buyer ${b.id} want ${key}: priceRatio must be positive, got ${w.priceRatio}`);
    }
  }

  const { event } = MARKET_PRICE_BOUNDS;
  const shortageOnMarket = new Map<string, string>();
  for (const s of data.suppliers) {
    for (const st of s.stock) {
      const line = `${s.id}/${st.materialId}`;
      const sh = st.shortage;
      if (!sh) continue;
      if (!Number.isSafeInteger(sh.earliestStartDay) || sh.earliestStartDay < 2) fail(`Shortage ${line}: earliestStartDay must be an integer ≥ 2`);
      if (!Number.isSafeInteger(sh.latestStartDay) || sh.latestStartDay < sh.earliestStartDay) fail(`Shortage ${line}: latestStartDay must be ≥ earliestStartDay`);
      if (!isPositiveInteger(sh.durationDays)) fail(`Shortage ${line}: durationDays must be a positive integer`);
      if (!Number.isSafeInteger(sh.supplyRatio) || sh.supplyRatio <= 0 || sh.supplyRatio > RATIO_ONE) fail(`Shortage ${line}: supplyRatio must be in (0, 1]`);
      if (!Number.isSafeInteger(sh.priceRatio) || sh.priceRatio < RATIO_ONE) fail(`Shortage ${line}: priceRatio must be ≥ 1`);
      for (const e of sh.marketEffects) {
        const key = `${e.productId}/${e.quality}`;
        if (!hasMarket(e.productId, e.quality)) fail(`Shortage ${line} affects ${key}, which has no market`);
        if (!Number.isSafeInteger(e.eventRatio) || e.eventRatio < event.min || e.eventRatio > event.max) {
          fail(`Shortage ${line}: eventRatio for ${key} must be in [${event.min}, ${event.max}] ppm`);
        }
        const other = shortageOnMarket.get(key);
        if (other !== undefined) fail(`Shortages ${other} and ${line} both affect market ${key}`);
        shortageOnMarket.set(key, line);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Opening state
// ---------------------------------------------------------------------------

/** The market's opening quote: base price, with demand and supply at baseline (all multipliers 1.0×). */
export function initialMarkets(data: GameData): readonly MarketState[] {
  return data.markets.map((m) => ({
    productId: m.productId,
    quality: m.quality,
    demand: m.baselineDemand,
    supply: m.baselineSupply,
    eventRatio: RATIO_ONE,
    spotPrice: basePriceOf(data, m.productId, m.quality),
    previousSpotPrice: null,
  }));
}

export function initialSuppliers(data: GameData, scenario: ScenarioDefinition): readonly SupplierState[] {
  return [...scenario.supplierIds].sort().map((id) => {
    const def = data.suppliers.find((s) => s.id === id);
    if (!def) throw new RangeError(`Scenario references unknown supplier ${id}`);
    return {
      id,
      stock: def.stock.map((st) => ({ materialId: st.materialId, available: st.dailyStock, unitPrice: st.unitPrice, shortage: null })),
    };
  });
}

/** Buyers' opening quotes: the market spot price times the buyer's price ratio. */
export function initialBuyers(data: GameData, scenario: ScenarioDefinition, markets: readonly MarketState[]): readonly BuyerState[] {
  return [...scenario.buyerIds].sort().map((id) => {
    const def = data.buyers.find((b) => b.id === id);
    if (!def) throw new RangeError(`Scenario references unknown buyer ${id}`);
    return {
      id,
      budgetRemaining: def.dailyBudget,
      wants: def.wants.map((w) => {
        const market = markets.find((m) => m.productId === w.productId && m.quality === w.minimumQuality);
        if (!market) throw new RangeError(`Buyer ${id} wants ${w.productId} with no ${w.minimumQuality} market`);
        return {
          productId: w.productId,
          minimumQuality: w.minimumQuality,
          unitPrice: applyRatios(market.spotPrice, [w.priceRatio]),
          demandRemaining: w.dailyDemand,
        };
      }),
      commitments: [],
    };
  });
}

// ---------------------------------------------------------------------------
// Deals (ADR 0005, ADR 0016; held deals since ADR 0022 decision 6)
// ---------------------------------------------------------------------------

export interface Deal {
  readonly buyerId: BuyerId;
  /** The `minimumQuality` of the want the line matched, so `commitDeal` reduces that same want. */
  readonly wantQuality: QualityTier;
  readonly unitPrice: Money;
  readonly quantity: number;
  readonly amount: Money;
}

/**
 * Checks a deal for one cargo line against the buyer's terms and current quote,
 * in order: unknown buyer, reputation, want, quote, then liquidity (GDD §7:
 * min(demand remaining, budget / price)). No partial sales: anything the buyer
 * won't fully take is rejected. AGREE_DEAL's checks (ADR 0022 decision 6), as
 * ADR 0005's dispatch was.
 */
export function quoteDeal(state: WorldSlice, data: GameData, buyerId: BuyerId, agreedUnitPrice: Money, line: CargoLine): Deal | RejectionReason {
  const buyer = state.buyers.find((b) => b.id === buyerId);
  const def = buyerDefinition(data, buyerId);
  if (!buyer || !def) return { code: "UNKNOWN_ENTITY", kind: "Buyer", id: buyerId };
  if (state.family.reputation < def.minimumReputation) {
    return { code: "REPUTATION_TOO_LOW", required: def.minimumReputation, current: state.family.reputation };
  }
  const want = matchWant(buyer.wants, line.productId, line.quality);
  if (!want) return { code: "PRODUCT_NOT_WANTED", buyerId, productId: line.productId, quality: line.quality };
  if (want.unitPrice !== agreedUnitPrice) {
    return { code: "QUOTE_CHANGED", buyerId, agreed: agreedUnitPrice, current: want.unitPrice };
  }
  const affordable = want.unitPrice > 0 ? Math.floor(buyer.budgetRemaining / want.unitPrice) : want.demandRemaining;
  const acceptable = Math.max(0, Math.min(want.demandRemaining, affordable));
  if (line.quantity > acceptable) return { code: "BUYER_WILL_TAKE_LESS", buyerId, requested: line.quantity, acceptable };
  return {
    buyerId,
    wantQuality: want.minimumQuality,
    unitPrice: want.unitPrice,
    quantity: line.quantity,
    amount: multiplyMoney(want.unitPrice, line.quantity),
  };
}

/**
 * The buyer's current quote for a line (the want `quoteDeal` would match), or
 * null when the buyer is unknown or wants nothing the line meets. With founder
 * rules off, a repeated sale re-agrees at this price (issue #192).
 */
export function currentQuote(state: WorldSlice, buyerId: BuyerId, line: Pick<CargoLine, "productId" | "quality">): Money | null {
  const buyer = state.buyers.find((b) => b.id === buyerId);
  return (buyer && matchWant(buyer.wants, line.productId, line.quality)?.unitPrice) ?? null;
}

/** Commits the buyer's demand (on the matched want) and budget to a deal, keyed by the deal (ADR 0022 decision 6). */
export function commitDeal(state: GameState, deal: Deal, dealId: DealId, line: CargoLine): GameState {
  return {
    ...state,
    buyers: state.buyers.map((b) => {
      if (b.id !== deal.buyerId) return b;
      return {
        ...b,
        budgetRemaining: subtractMoney(b.budgetRemaining, deal.amount),
        wants: b.wants.map((w) =>
          w.productId === line.productId && w.minimumQuality === deal.wantQuality ? { ...w, demandRemaining: w.demandRemaining - deal.quantity } : w,
        ),
        commitments: [
          ...b.commitments,
          { dealId, productId: line.productId, quality: deal.wantQuality, quantity: deal.quantity, amount: deal.amount },
        ],
      };
    }),
  };
}

/** The commitment a deal holds, if any. */
export function findCommitment(state: GameState, buyerId: BuyerId, dealId: DealId): BuyerState["commitments"][number] | undefined {
  return state.buyers.find((b) => b.id === buyerId)?.commitments.find((c) => c.dealId === dealId);
}

/** Removes a fulfilled commitment. Its demand and budget stay spent. */
export function settleDeal(state: GameState, buyerId: BuyerId, dealId: DealId): GameState {
  return {
    ...state,
    buyers: state.buyers.map((b) => (b.id === buyerId ? { ...b, commitments: b.commitments.filter((c) => c.dealId !== dealId) } : b)),
  };
}

/**
 * Releases a deal that expired or fell through (ADR 0016, ADR 0022 decision 6):
 * removes the commitment and gives back its demand, to the want it matched (the
 * commitment's `quality`), and its stored amount, to the budget. Each is capped at
 * the buyer's daily value, so a release after a midnight refresh can't push the
 * buyer past one day's limits. A commitment whose want no longer exists (a save
 * migrated without a match) gives back budget only. With no such commitment, the
 * state is returned unchanged.
 */
export function releaseDeal(state: GameState, data: GameData, buyerId: BuyerId, dealId: DealId): GameState {
  const buyer = state.buyers.find((b) => b.id === buyerId);
  const commitment = buyer?.commitments.find((c) => c.dealId === dealId);
  if (!buyer || !commitment) return state;
  const def = buyerDefinition(data, buyerId);
  if (!def) throw new RangeError(`releaseDeal: no definition for buyer ${buyerId}`);
  const matches = (w: { readonly productId: ProductId; readonly minimumQuality: QualityTier }) =>
    w.productId === commitment.productId && w.minimumQuality === commitment.quality;
  const wantDef = def.wants.find(matches);
  const budget = addMoney(buyer.budgetRemaining, commitment.amount);
  const released: BuyerState = {
    ...buyer,
    budgetRemaining: budget < def.dailyBudget ? budget : def.dailyBudget,
    wants: buyer.wants.map((w) =>
      matches(w) && wantDef ? { ...w, demandRemaining: Math.min(wantDef.dailyDemand, w.demandRemaining + commitment.quantity) } : w,
    ),
    commitments: buyer.commitments.filter((c) => c.dealId !== dealId),
  };
  return { ...state, buyers: state.buyers.map((b) => (b.id === buyerId ? released : b)) };
}

// ---------------------------------------------------------------------------
// Held deals (ADR 0022 decision 6)
// ---------------------------------------------------------------------------

/** A HELD deal, for a dispatch to carry out; undefined if the founder holds no such deal. */
export function heldDeal(state: Pick<WorldSlice, "heldDeals">, dealId: DealId): HeldDealState | undefined {
  return state.heldDeals.find((d) => d.id === dealId && d.status === "HELD");
}

/** The deal a delivery is carrying out (DISPATCHED), if any. */
export function dispatchedDealOf(state: GameState, deliveryId: DeliveryId): HeldDealState | undefined {
  return state.heldDeals.find((d) => d.deliveryId === deliveryId && d.status === "DISPATCHED");
}

function withDeal(state: GameState, dealId: DealId, change: (d: HeldDealState) => HeldDealState): GameState {
  return { ...state, heldDeals: state.heldDeals.map((d) => (d.id === dealId ? change(d) : d)) };
}

/** A dispatch takes the deal: DISPATCHED with that delivery. A dispatched deal never expires by time. */
export function dispatchDeal(state: GameState, dealId: DealId, deliveryId: DeliveryId): GameState {
  return withDeal(state, dealId, (d) => ({ ...d, status: "DISPATCHED", deliveryId }));
}

/** The deal reached a terminal state (SETTLED, EXPIRED, FELL_THROUGH): it leaves `heldDeals`, and its event reports it. */
export function endDeal(state: GameState, dealId: DealId): GameState {
  return { ...state, heldDeals: state.heldDeals.filter((d) => d.id !== dealId) };
}

/** What AGREE_DEAL fixes: the buyer and the cargo line at a price. */
export interface DealTerms {
  readonly buyerId: BuyerId;
  readonly line: CargoLine;
  readonly agreedUnitPrice: Money;
}

/** A staged agreement: the state with the deal held and committed, and the DEAL_AGREED payload. */
export interface Agreement {
  readonly state: GameState;
  readonly deal: HeldDealState;
  readonly event: Omit<EventOfType<"DEAL_AGREED">, "id" | "tick" | "causedBy">;
}

/**
 * Agrees a deal in person (ADR 0022 decision 6), as ADR 0005's sale was checked:
 * `quoteDeal`'s reasons, then the deal is minted (`deal-<n>`), HELD until
 * `tick + DEAL_HOLD_TICKS`, and the buyer's demand and budget are committed to it.
 * Pure; the caller stages the result in its transaction and emits the event. A
 * by-phone agreement (demand only, ADR 0024) is a later task.
 */
export function agreeDeal(state: GameState, data: GameData, terms: DealTerms, at: Tick): Agreement | RejectionReason {
  const { buyerId, line, agreedUnitPrice } = terms;
  const quoted = quoteDeal(state, data, buyerId, agreedUnitPrice, line);
  if ("code" in quoted) return quoted;
  const minted = allocateId(state, "Deal");
  const deal: HeldDealState = {
    id: minted.id,
    buyerId,
    productId: line.productId,
    quality: line.quality,
    quantity: line.quantity,
    unitPrice: quoted.unitPrice,
    agreedAt: at,
    expiresAt: addTicks(at, DEAL_HOLD_TICKS),
    budgetCommitted: true,
    status: "HELD",
    deliveryId: null,
  };
  const committed = commitDeal(minted.state, quoted, deal.id, line);
  return {
    state: { ...committed, heldDeals: [...committed.heldDeals, deal].sort(compareById) },
    deal,
    event: {
      type: "DEAL_AGREED",
      dealId: deal.id,
      buyerId,
      productId: deal.productId,
      quality: deal.quality,
      quantity: deal.quantity,
      unitPrice: deal.unitPrice,
      expiresAt: deal.expiresAt,
      budgetCommitted: deal.budgetCommitted,
    },
  };
}

/**
 * HELD deals whose `expiresAt` has come (ADR 0022 decision 6): each releases its
 * commitment under the daily caps, leaves `heldDeals` and emits DEAL_EXPIRED, in
 * one entry-free DAILY_SETTLEMENT transaction keyed by the deal. In deal ID order.
 * DISPATCHED deals are never touched: only their delivery resolves them.
 */
function expireDeals(state: GameState, data: GameData, coordinator: TransactionCoordinator, ctx: TickContext): GameState {
  let s = state;
  for (const deal of state.heldDeals) {
    if (deal.status !== "HELD" || deal.expiresAt > ctx.tick) continue;
    const tx = coordinator.begin(s, {
      kind: "DAILY_SETTLEMENT",
      idempotencyKey: idempotencyKey("DAILY_SETTLEMENT", "DEAL_EXPIRED", deal.id),
      tick: ctx.tick,
      causedBy: null,
    });
    if (tx.status === "duplicate") continue;
    tx.update((x) => endDeal(releaseDeal(x, data, deal.buyerId, deal.id), deal.id));
    tx.emit({ type: "DEAL_EXPIRED", dealId: deal.id, buyerId: deal.buyerId });
    const result = tx.commit();
    if (result.status !== "committed") throw new Error(`DEAL_EXPIRED for ${deal.id} rejected: ${JSON.stringify(result.reason)}`);
    s = result.state;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Midnight cycle (GDD §7 order, ADR 0016)
// ---------------------------------------------------------------------------

type MarketKey = string;
const keyOf = (productId: ProductId, quality: QualityTier): MarketKey => `${productId}/${quality}`;

/** Step 1: each stock line back to its daily level, cut and repriced during a shortage. */
function replenishSuppliers(state: GameState, data: GameData): GameState {
  return {
    ...state,
    suppliers: state.suppliers.map((s) => ({
      ...s,
      stock: s.stock.map((st) => {
        const def = stockDefinition(data, s.id, st.materialId);
        if (!def) throw new RangeError(`No stock definition for ${s.id}/${st.materialId}`);
        if (st.shortage === null) return { ...st, available: def.dailyStock, unitPrice: def.unitPrice };
        const priceRatio = def.shortage?.priceRatio ?? RATIO_ONE;
        return { ...st, available: floorPpm(def.dailyStock, st.shortage.supplyRatio), unitPrice: applyRatios(def.unitPrice, [priceRatio]) };
      }),
    })),
  };
}

/** Step 2a: the cases buyers took from each market today (sum of dailyDemand − demandRemaining). */
function soldVolumes(state: GameState, data: GameData): ReadonlyMap<MarketKey, number> {
  const sold = new Map<MarketKey, number>();
  for (const b of state.buyers) {
    const def = buyerDefinition(data, b.id);
    if (!def) throw new RangeError(`No definition for buyer ${b.id}`);
    for (const w of b.wants) {
      const wantDef = def.wants.find((d) => d.productId === w.productId && d.minimumQuality === w.minimumQuality);
      if (!wantDef) throw new RangeError(`No definition for buyer ${b.id}'s ${w.productId} ${w.minimumQuality} want`);
      const key = keyOf(w.productId, w.minimumQuality);
      sold.set(key, (sold.get(key) ?? 0) + wantDef.dailyDemand - w.demandRemaining);
    }
  }
  return sold;
}

/** Step 2b: budgets and demand back to their daily values. Outstanding commitments stay. */
function refreshBuyers(state: GameState, data: GameData): GameState {
  return {
    ...state,
    buyers: state.buyers.map((b) => {
      const def = buyerDefinition(data, b.id)!;
      return {
        ...b,
        budgetRemaining: def.dailyBudget,
        wants: b.wants.map((w) => ({
          ...w,
          demandRemaining: def.wants.find((d) => d.productId === w.productId && d.minimumQuality === w.minimumQuality)!.dailyDemand,
        })),
      };
    }),
  };
}

/** Configured shortages in ADR 0016 roll order: supplier ID, then material ID. */
function configuredShortages(data: GameData) {
  return [...data.suppliers]
    .sort((a, b) => byString(a.id, b.id))
    .flatMap((s) =>
      [...s.stock]
        .sort((a, b) => byString(a.materialId, b.materialId))
        .flatMap((st) => (st.shortage ? [{ supplierId: s.id, materialId: st.materialId, shortage: st.shortage }] : [])),
    );
}

/** Step 3a (the midnight that starts day 1 only): roll and schedule each configured shortage. */
function scheduleShortages(state: GameState, data: GameData): GameState {
  let s = state;
  for (const { supplierId, materialId, shortage } of configuredShortages(data)) {
    const draw = nextIntBetween(s.rng.market, shortage.earliestStartDay, shortage.latestStartDay);
    s = { ...s, rng: { ...s.rng, market: draw.rng } };
    s = scheduleWorldEvent(s, {
      kind: "SHORTAGE_START",
      tick: tick(draw.value * TICKS_PER_DAY),
      supplierId,
      materialId,
      supplyRatio: shortage.supplyRatio,
      durationTicks: shortage.durationDays * TICKS_PER_DAY,
    });
  }
  return s;
}

/** Step 3b: each market's M_E input from the one active shortage affecting it, or 1.0×. */
function eventRatios(state: GameState, data: GameData): ReadonlyMap<MarketKey, Ratio> {
  const ratios = new Map<MarketKey, Ratio>();
  for (const s of state.suppliers) {
    for (const st of s.stock) {
      if (st.shortage === null) continue;
      const def: ShortageDefinition | null | undefined = stockDefinition(data, s.id, st.materialId)?.shortage;
      for (const e of def?.marketEffects ?? []) ratios.set(keyOf(e.productId, e.quality), e.eventRatio);
    }
  }
  return ratios;
}

/** Step 4: drift draws in market order, then new demand, supply, spot prices, and buyer quotes. */
function updatePrices(state: GameState, data: GameData, sold: ReadonlyMap<MarketKey, number>, events: ReadonlyMap<MarketKey, Ratio>): GameState {
  let rng = state.rng.market;
  const demand = new Map<MarketKey, number>();
  for (const def of [...data.markets].sort(compareMarkets)) {
    const k = floorPpm(def.baselineDemand, def.demandDriftPpm);
    const draw = nextIntBetween(rng, -k, k);
    rng = draw.rng;
    demand.set(keyOf(def.productId, def.quality), def.baselineDemand + draw.value);
  }
  const markets = state.markets.map((m): MarketState => {
    const def = marketDefinition(data, m.productId, m.quality);
    const key = keyOf(m.productId, m.quality);
    const next = {
      productId: m.productId,
      quality: m.quality,
      demand: demand.get(key)!,
      supply: def.baselineSupply + (sold.get(key) ?? 0),
      eventRatio: events.get(key) ?? RATIO_ONE,
    };
    return { ...next, spotPrice: spotPriceOf(data, next), previousSpotPrice: m.spotPrice };
  });
  const buyers = state.buyers.map((b) => {
    const def = buyerDefinition(data, b.id)!;
    return {
      ...b,
      wants: b.wants.map((w) => {
        const wantDef = def.wants.find((d) => d.productId === w.productId && d.minimumQuality === w.minimumQuality)!;
        const market = markets.find((m) => m.productId === w.productId && m.quality === w.minimumQuality);
        if (!market) throw new RangeError(`Buyer ${b.id} wants ${w.productId} with no ${w.minimumQuality} market`);
        return { ...w, unitPrice: applyRatios(market.spotPrice, [wantDef.priceRatio]) };
      }),
    };
  });
  return { ...state, rng: { ...state.rng, market: rng }, markets, buyers };
}

function runMidnight(state: GameState, ctx: TickContext, data: GameData, coordinator: TransactionCoordinator): GameState {
  // The day that is starting (ADR 0016).
  const day = dayIndex(ctx.tick);
  const tx = coordinator.begin(state, {
    kind: "DAILY_SETTLEMENT",
    idempotencyKey: idempotencyKey("DAILY_SETTLEMENT", "MARKET", day),
    tick: ctx.tick,
    causedBy: null,
  });
  if (tx.status === "duplicate") return state;

  tx.update((s) => replenishSuppliers(s, data));
  const sold = soldVolumes(tx.state, data);
  tx.update((s) => refreshBuyers(s, data));
  if (day === 1) tx.update((s) => scheduleShortages(s, data));
  const events = eventRatios(tx.state, data);
  tx.update((s) => updatePrices(s, data, sold, events));
  tx.emit({ type: "MARKET_UPDATED", dayIndex: day });

  const result = tx.commit();
  if (result.status !== "committed") throw new Error(`Market midnight cycle rejected: ${JSON.stringify(result.reason)}`);
  return result.state;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

function withStockLine(
  state: GameState,
  supplierId: string,
  materialId: string,
  change: (line: SupplierState["stock"][number]) => SupplierState["stock"][number],
): GameState {
  return {
    ...state,
    suppliers: state.suppliers.map((s) =>
      s.id === supplierId ? { ...s, stock: s.stock.map((st) => (st.materialId === materialId ? change(st) : st)) } : s,
    ),
  };
}

export function registerMarket(registry: SystemRegistry, data: GameData, coordinator: TransactionCoordinator, rules: GameRules = M001_RULES): void {
  validateMarketData(data);

  registry.onPhase("midnight", "market-daily-cycle", (state, ctx) => runMidnight(state, ctx, data, coordinator));
  registry.onPhase("deadlines", "held-deal-expiry", (state, ctx) => expireDeals(state, data, coordinator, ctx));

  // AGREE_DEAL (ADR 0022 decision 6): one entry-free DAILY_SETTLEMENT transaction
  // keyed by the new deal, carrying DEAL_AGREED. Judged by its order validator first.
  const validateAgree = agreeDealValidator(data);
  registry.onCommand("AGREE_DEAL", {
    validate: (_state, command) => quantityRejection(command.quantity),
    apply: (state, command, ctx) => {
      const rejection = judgeOrder(validateAgree, state, data, rules, command, ctx.tick);
      if (rejection) return { status: "rejected", reason: rejection };
      const dealId = formatId("Deal", state.counters.nextId.Deal);
      const tx = coordinator.begin(state, {
        kind: "DAILY_SETTLEMENT",
        idempotencyKey: idempotencyKey("DAILY_SETTLEMENT", "DEAL_AGREED", dealId),
        tick: ctx.tick,
        causedBy: ctx.envelope.id,
      });
      if (tx.status === "duplicate") return { status: "applied", state };
      const { buyerId, productId, quality, quantity, agreedUnitPrice } = command;
      // The buyer is in the live view, so the world agrees with the view here.
      const agreed = agreeDeal(tx.state, data, { buyerId, line: { productId, quality, quantity }, agreedUnitPrice }, ctx.tick);
      if ("code" in agreed) {
        tx.reject(agreed);
      } else {
        tx.update(() => agreed.state);
        tx.emit(agreed.event);
      }
      const result = tx.commit();
      return result.status === "committed" ? { status: "applied", state: result.state } : { status: "rejected", reason: result.reason };
    },
  });

  registry.onWorldEvent("SHORTAGE_START", (state, event, ctx) => {
    const { supplierId, materialId } = event;
    const tx = coordinator.begin(state, {
      kind: "DAILY_SETTLEMENT",
      idempotencyKey: idempotencyKey("DAILY_SETTLEMENT", "SHORTAGE_START", supplierId, materialId, ctx.tick),
      tick: ctx.tick,
      causedBy: null,
    });
    if (tx.status === "duplicate") return state;
    const endsAt = tick(ctx.tick + event.durationTicks);
    tx.update((s) => withStockLine(s, supplierId, materialId, (st) => ({ ...st, shortage: { supplyRatio: event.supplyRatio, endsAt } })));
    tx.update((s) => scheduleWorldEvent(s, { kind: "SHORTAGE_END", tick: endsAt, supplierId, materialId }));
    tx.emit({ type: "SHORTAGE_STARTED", supplierId, materialId, supplyRatioPpm: event.supplyRatio, endsAt });
    const result = tx.commit();
    if (result.status !== "committed") throw new Error(`SHORTAGE_START rejected: ${JSON.stringify(result.reason)}`);
    return result.state;
  });

  registry.onWorldEvent("SHORTAGE_END", (state, event, ctx) => {
    const { supplierId, materialId } = event;
    const tx = coordinator.begin(state, {
      kind: "DAILY_SETTLEMENT",
      idempotencyKey: idempotencyKey("DAILY_SETTLEMENT", "SHORTAGE_END", supplierId, materialId, ctx.tick),
      tick: ctx.tick,
      causedBy: null,
    });
    if (tx.status === "duplicate") return state;
    tx.update((s) => withStockLine(s, supplierId, materialId, (st) => ({ ...st, shortage: null })));
    tx.emit({ type: "SHORTAGE_ENDED", supplierId, materialId });
    const result = tx.commit();
    if (result.status !== "committed") throw new Error(`SHORTAGE_END rejected: ${JSON.stringify(result.reason)}`);
    return result.state;
  });

  const validatePurchase = purchaseMaterialsValidator(data);
  registry.onCommand("PURCHASE_MATERIALS", {
    validate: (_state, command) => quantityRejection(command.quantity),
    apply: (state, command, ctx) => {
      const rejection = judgeOrder(validatePurchase, state, data, rules, command, ctx.tick);
      if (rejection) return { status: "rejected", reason: rejection };
      const tx = coordinator.begin(state, {
        kind: "MATERIAL_PURCHASE",
        idempotencyKey: idempotencyKey("MATERIAL_PURCHASE", ctx.envelope.id),
        tick: ctx.tick,
        causedBy: ctx.envelope.id,
      });
      if (tx.status === "duplicate") return { status: "applied", state };

      // The supplier is in the live view: the validator read these same values.
      const { quantity, supplierId, materialId, facilityId } = command;
      const stock = tx.state.suppliers.find((s) => s.id === supplierId)?.stock.find((s) => s.materialId === materialId);
      if (!stock) throw new RangeError(`PURCHASE_MATERIALS: ${supplierId} doesn't sell ${materialId}, after validation`);
      const cost = multiplyMoney(stock.unitPrice, quantity);
      tx.update((s) => withStockLine(s, supplierId, materialId, (st) => ({ ...st, available: st.available - quantity })));
      tx.update((s) => addMaterial(s, facilityId, materialId, quantity, cost));
      tx.post(materialPurchaseEntries(cost));
      tx.emit({
        type: "MATERIALS_PURCHASED",
        supplierId,
        materialId,
        quantity,
        unitPrice: stock.unitPrice,
        total: cost,
        facilityId,
        transactionId: tx.transactionId,
      });

      const result = tx.commit();
      return result.status === "committed" ? { status: "applied", state: result.state } : { status: "rejected", reason: result.reason };
    },
  });
}

// ---------------------------------------------------------------------------
// Orders (ADR 0022 decisions 1–3): the market's validators, read from the view
// ---------------------------------------------------------------------------

function quantityRejection(quantity: number): RejectionReason | null {
  return Number.isSafeInteger(quantity) && quantity > 0 ? null : { code: "INVALID_QUANTITY", field: "quantity", value: quantity };
}

/**
 * PURCHASE_MATERIALS against the world as seen (M001's order): quantity,
 * facility, supplier, material sold, the supplier's stock, then cash.
 */
function purchaseRejection(world: WorldSlice, command: CommandOfType<"PURCHASE_MATERIALS">): RejectionReason | null {
  const { quantity, supplierId, materialId, facilityId } = command;
  const invalid = quantityRejection(quantity);
  if (invalid) return invalid;
  if (!world.facilities.some((f) => f.id === facilityId)) return { code: "UNKNOWN_ENTITY", kind: "Facility", id: facilityId };
  const supplier = world.suppliers.find((s) => s.id === supplierId);
  if (!supplier) return { code: "UNKNOWN_ENTITY", kind: "Supplier", id: supplierId };
  const stock = supplier.stock.find((s) => s.materialId === materialId);
  if (!stock) return { code: "MATERIAL_NOT_SOLD", supplierId, materialId };
  if (stock.available < quantity) return { code: "SUPPLIER_STOCK_LOW", materialId, requested: quantity, available: stock.available };
  const total = multiplyMoney(stock.unitPrice, quantity);
  const cash = cashOf(world);
  return cash < total ? { code: "INSUFFICIENT_FUNDS", required: total, available: cash } : null;
}

/**
 * PURCHASE_MATERIALS (ADR 0022 decision 3): gate 1 is the quantity, the facility
 * (owned) and the supplier (geography); the founder must be at the supplier,
 * free, while it's open; then the supplier's live stock and the purse. The goods
 * go to the named facility, which isn't checked (M001 doesn't check material
 * storage).
 */
export function purchaseMaterialsValidator(data: GameData): OrderValidator<"PURCHASE_MATERIALS"> {
  return (view, command) => {
    if (view.founderRules) {
      const { quantity, supplierId, facilityId } = command;
      const invalid = quantityRejection(quantity);
      if (invalid) return invalid;
      if (!view.world.facilities.some((f) => f.id === facilityId)) return { code: "UNKNOWN_ENTITY", kind: "Facility", id: facilityId };
      const def = data.suppliers.find((s) => s.id === supplierId);
      if (!def || !view.world.suppliers.some((s) => s.id === supplierId)) return { code: "UNKNOWN_ENTITY", kind: "Supplier", id: supplierId };
      const absent = presenceRejection(view, { locationId: def.locationId, activity: "BUY_MATERIALS", party: true });
      if (absent) return absent;
    }
    return purchaseRejection(view.world, command);
  };
}

/**
 * AGREE_DEAL in person (ADR 0022 decisions 3 and 6): gate 1 is the quantity and
 * the buyer (geography); the founder must be at the buyer, free, while it's
 * open; then `quoteDeal`'s checks against the live view: reputation, the want,
 * the quote, and liquidity (demand and budget).
 */
export function agreeDealValidator(data: GameData): OrderValidator<"AGREE_DEAL"> {
  return (view, command) => {
    const { buyerId, productId, quality, quantity, agreedUnitPrice } = command;
    const invalid = quantityRejection(quantity);
    if (invalid) return invalid;
    if (view.founderRules) {
      const def = buyerDefinition(data, buyerId);
      if (!def || !view.world.buyers.some((b) => b.id === buyerId)) return { code: "UNKNOWN_ENTITY", kind: "Buyer", id: buyerId };
      const absent = presenceRejection(view, { locationId: def.locationId, activity: "AGREE_DEAL", party: true });
      if (absent) return absent;
    }
    const quoted = quoteDeal(view.world, data, buyerId, agreedUnitPrice, { productId, quality, quantity });
    return "code" in quoted ? quoted : null;
  };
}

