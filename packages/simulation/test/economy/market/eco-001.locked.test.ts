// @locked
// ECO-001 acceptance tests for T02d (issue #8): the daily market. Covers the
// bounded spot price formula, market-data validation, the midnight cycle in GDD
// §7 order with its fixed RNG order, prices fixed within a day, the explainable
// report, the seeded shortage, buyer terms and want matching, releaseDeal, the
// liquidity cap against repeat arbitrage, and spot sales through the coordinator.
// Rules come from GDD §7 and ADR 0016.
//
// Written ahead of the implementation by a separate test-writer agent
// (factory.md §2, §7.3). Do not edit (CLAUDE.md rule 9).
//
// Imports are limited to `src/economy/market/index.ts`, the public package entry
// `src/index.ts` (the `Simulation`: `newGame`, `createSimulation`,
// `simulationOptions`, plus `createRegistry`, `createCoordinator` and
// `nextIntBetween` to drive `registerMarket` and recompute RNG draws), and
// `@eov/contracts` and `@eov/game-data`.
//
// Expected numbers come from game-data and the ADR 0016 formulas, so placeholder
// tuning can change without breaking these tests. The one exception is the GDD
// worked example ($20 → $27.50), which uses its own fixture numbers. The GDD
// clamp bounds (0.80–1.25 for M_D and M_S, 0.90–1.10 for M_E) appear here as
// literals because they're the rule under test. Simulation code reads them from
// `MARKET_PRICE_BOUNDS`.
//
// API these tests assume. (issue) marks names the issue fixes. The rest are the
// test-writer's choice.
//
// src/economy/market/index.ts:
//   Existing (S0), kept: `registerMarket` (issue), `commitDeal(state, deal, deliveryId, line)`,
//     `type Deal` ({ buyerId, unitPrice, quantity, amount }, plus whatever field
//     records the matched want. These tests don't read that field.)
//   Changed: `quoteDeal(state, data, buyerId, agreedUnitPrice, line): Deal | RejectionReason` (issue)
//   New:
//     `priceInputs(market, definition): readonly [Ratio, Ratio, Ratio]` (the issue
//       names it `priceInputs` and leaves the name open; this file fixes it).
//       `market` is a `MarketState` (it reads demand, supply, eventRatio).
//       `definition` is a `MarketDefinition` (it reads baselineDemand, baselineSupply).
//       It returns the clamped [M_D, M_S, M_E] in ppm, ready for `applyRatios`.
//     `validateMarketData(data: GameData): void` (issue). Throws `MarketDataError` on invalid data.
//     `MarketDataError` (the "typed error", a subclass of Error).
//     `releaseDeal(state, data, buyerId, deliveryId): GameState` (issue)
//
// @eov/game-data (issue, decisions 1–3):
//   `MARKET_PRICE_BOUNDS` exported (shape is the implementer's choice; only its existence is checked).
//   `MarketDefinition.demandDriftPpm: number`
//   `BuyerDefinition.minimumReputation: number`
//   `SupplierStockDefinition.shortage` (optional or nullable), holding
//     { earliestStartDay, latestStartDay, durationDays, supplyRatio, priceRatio,
//       marketEffects: readonly { productId, quality, eventRatio }[] }
//   Shipped data: exactly one configured shortage, Kessler's has a basic and a
//   standard moonshine want, and Lakeview's minimumReputation is above the
//   scenario's starting reputation.
//
// Expected to fail until T02d lands. `priceInputs`, `validateMarketData`,
// `MarketDataError`, `releaseDeal`, `MARKET_PRICE_BOUNDS` and the new definition
// fields don't exist yet, `quoteDeal` doesn't take `data`, and there's no
// midnight cycle.

import {
  applyRatios,
  asId,
  cents,
  clampRatio,
  idempotencyKey,
  multiplyMoney,
  qualityRank,
  ratio,
  ratioOf,
  RATIO_ONE,
  tick,
  TICKS_PER_DAY,
  type BuyerId,
  type BuyerState,
  type CargoLine,
  type CommandResult,
  type GameCommand,
  type GameEvent,
  type GameState,
  type LedgerAccount,
  type LedgerTransaction,
  type MarketState,
  type MaterialId,
  type Money,
  type ProductId,
  type QualityTier,
  type Ratio,
  type RngState,
  type SupplierId,
} from "@eov/contracts";
import {
  BASIC_MOONSHINE_RECIPE,
  CROSSROADS_ROADHOUSE,
  DISTILLERY_MAIN,
  FIRST_SHIPMENT_SCENARIO,
  GAME_DATA,
  KESSLERS_BACK_ROOM,
  LAKEVIEW_HOTEL,
  MARKET_PRICE_BOUNDS,
  MODEL_TT_TRUCK,
  MOONSHINE,
  type BuyerDefinition,
  type BuyerWantDefinition,
  type GameData,
  type MarketDefinition,
  type SupplierStockDefinition,
} from "@eov/game-data";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  commitDeal,
  MarketDataError,
  priceInputs,
  quoteDeal,
  registerMarket,
  releaseDeal,
  validateMarketData,
  type Deal,
} from "../../../src/economy/market/index.ts";
import {
  createCoordinator,
  createRegistry,
  createSimulation,
  newGame,
  nextIntBetween,
  simulationOptions,
  type KernelSimulation,
} from "../../../src/index.ts";

// ---------------------------------------------------------------------------
// Constants and lookups
// ---------------------------------------------------------------------------

const DAY = TICKS_PER_DAY;
const PPM = 1_000_000;

// GDD §7 clamp bounds, in ppm.
const M_DS_MIN = 800_000;
const M_DS_MAX = 1_250_000;
const M_E_MIN = 900_000;
const M_E_MAX = 1_100_000;
const PRODUCT_MIN = 576_000; // 0.80 × 0.80 × 0.90
const PRODUCT_MAX = 1_718_750; // 1.25 × 1.25 × 1.10

type Shortage = NonNullable<SupplierStockDefinition["shortage"]>;
type MarketEffect = Shortage["marketEffects"][number];

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const recipe = GAME_DATA.recipes.find((r) => r.id === BASIC_MOONSHINE_RECIPE)!;
const truck = GAME_DATA.vehicles.find((v) => v.id === MODEL_TT_TRUCK)!;

function buyerDef(id: BuyerId, data: GameData = GAME_DATA): BuyerDefinition {
  const def = data.buyers.find((b) => b.id === id);
  if (!def) throw new Error(`No buyer definition ${id}`);
  return def;
}

function wantDef(id: BuyerId, quality: QualityTier): BuyerWantDefinition {
  const want = buyerDef(id).wants.find((w) => w.productId === MOONSHINE && w.minimumQuality === quality);
  if (!want) throw new Error(`${id} has no ${quality} moonshine want`);
  return want;
}

function marketDef(productId: ProductId, quality: QualityTier, data: GameData = GAME_DATA): MarketDefinition {
  const def = data.markets.find((m) => m.productId === productId && m.quality === quality);
  if (!def) throw new Error(`No market definition ${productId} ${quality}`);
  return def;
}

function basePrice(productId: ProductId, quality: QualityTier): Money {
  const product = GAME_DATA.products.find((p) => p.id === productId);
  if (!product) throw new Error(`No product ${productId}`);
  return product.basePrice[quality];
}

/** Markets in ADR 0016 market order: product ID, then quality rank. */
function marketOrder(data: GameData = GAME_DATA): readonly MarketDefinition[] {
  return [...data.markets].sort((a, b) => byString(a.productId, b.productId) || qualityRank(a.quality) - qualityRank(b.quality));
}

/** Configured shortages in ADR 0016 roll order: supplier ID, then material ID. */
function shortageLines(data: GameData = GAME_DATA) {
  return [...data.suppliers]
    .sort((a, b) => byString(a.id, b.id))
    .flatMap((s) =>
      [...s.stock]
        .sort((a, b) => byString(a.materialId, b.materialId))
        .flatMap((st) => (st.shortage ? [{ supplierId: s.id, materialId: st.materialId, stock: st, shortage: st.shortage }] : [])),
    );
}

/** The one shortage the shipped data configures (decision 3). Looked up lazily so a missing one fails only the tests that use it. */
function shippedShortage() {
  const lines = shortageLines();
  if (lines.length !== 1) throw new Error(`Expected exactly one configured shortage in GAME_DATA, found ${lines.length}`);
  return lines[0]!;
}

/** floor(n × r / 10⁶) in exact integer arithmetic. */
function floorPpm(n: number, r: number): number {
  return Number((BigInt(n) * BigInt(r)) / BigInt(PPM));
}

/** k = floor(D₀ × demandDriftPpm / 10⁶) (ADR 0016). */
function driftBound(def: MarketDefinition): number {
  return floorPpm(def.baselineDemand, def.demandDriftPpm);
}

// ---------------------------------------------------------------------------
// State lookups
// ---------------------------------------------------------------------------

function marketOf(state: GameState, productId: ProductId, quality: QualityTier): MarketState {
  const m = state.markets.find((x) => x.productId === productId && x.quality === quality);
  if (!m) throw new Error(`No market ${productId} ${quality}`);
  return m;
}

function buyerOf(state: GameState, id: BuyerId): BuyerState {
  const b = state.buyers.find((x) => x.id === id);
  if (!b) throw new Error(`No buyer ${id}`);
  return b;
}

function wantOf(state: GameState, id: BuyerId, quality: QualityTier): BuyerState["wants"][number] {
  const w = buyerOf(state, id).wants.find((x) => x.productId === MOONSHINE && x.minimumQuality === quality);
  if (!w) throw new Error(`${id} has no ${quality} moonshine want in state`);
  return w;
}

function stockOf(state: GameState, supplierId: SupplierId, materialId: MaterialId) {
  const line = state.suppliers.find((s) => s.id === supplierId)?.stock.find((st) => st.materialId === materialId);
  if (!line) throw new Error(`No stock line ${supplierId}/${materialId}`);
  return line;
}

function casesInStock(state: GameState, quality: QualityTier = "basic"): number {
  return state.productPools.find((p) => p.facilityId === DISTILLERY_MAIN && p.productId === MOONSHINE && p.quality === quality)?.quantity ?? 0;
}

function sideTotal(transactions: readonly LedgerTransaction[], account: LedgerAccount, side: "DEBIT" | "CREDIT"): number {
  let total = 0;
  for (const t of transactions) for (const e of t.entries) if (e.account === account && e.side === side) total += e.amount;
  return total;
}

function transactionsKeyed(state: GameState, key: string): readonly LedgerTransaction[] {
  return state.ledger.transactions.filter((t) => t.idempotencyKey === key);
}

/** The spot price the formula gives for a market as it stands in state. */
function formulaSpot(m: MarketState): Money {
  return applyRatios(basePrice(m.productId, m.quality), priceInputs(m, marketDef(m.productId, m.quality)));
}

// ---------------------------------------------------------------------------
// Driving the simulation
// ---------------------------------------------------------------------------

function gameWithSeed(seed: number): KernelSimulation {
  return newGame({ scenario: { ...FIRST_SHIPMENT_SCENARIO, seed } });
}

/** A simulation over an edited state, with every registered system. */
function simulationOf(state: GameState): KernelSimulation {
  return createSimulation(state, simulationOptions());
}

function advanceTo(sim: KernelSimulation, target: number): void {
  if (target < sim.state.tick) throw new Error(`Can't go back from ${sim.state.tick} to ${target}`);
  sim.advance(target - sim.state.tick);
}

function advanceUntil(sim: KernelSimulation, done: (s: GameState) => boolean, maxTicks: number): void {
  for (let i = 0; i < maxTicks && !done(sim.state); i++) sim.advance(1);
  if (!done(sim.state)) throw new Error(`Condition not reached within ${maxTicks} ticks`);
}

function expectApplied(result: CommandResult): void {
  if (result.status !== "applied") throw new Error(`Expected applied, got ${JSON.stringify(result)}`);
}

/** Rejected with `code`, with no state change and no events. Returns the reason. */
function expectRejected(sim: KernelSimulation, command: GameCommand, code: string) {
  sim.takeEvents();
  const before = sim.stateHash();
  const result = sim.dispatch({ command });
  if (result.status !== "rejected") throw new Error(`Expected rejected ${code}, got ${JSON.stringify(result)}`);
  expect(result.reason.code).toBe(code);
  expect(sim.stateHash()).toBe(before);
  expect(sim.takeEvents()).toEqual([]);
  return result.reason;
}

function supplierSelling(materialId: MaterialId): SupplierId {
  const supplier = [...GAME_DATA.suppliers]
    .sort((a, b) => byString(a.id, b.id))
    .find((s) => FIRST_SHIPMENT_SCENARIO.supplierIds.includes(s.id) && s.stock.some((st) => st.materialId === materialId));
  if (!supplier) throw new Error(`No scenario supplier sells ${materialId}`);
  return supplier.id;
}

function purchase(materialId: MaterialId, quantity: number): GameCommand {
  return { type: "PURCHASE_MATERIALS", supplierId: supplierSelling(materialId), materialId, quantity, facilityId: DISTILLERY_MAIN };
}

/** Buys the inputs for `cases` basic cases, produces them, and waits until they're in stock. */
function stockCases(sim: KernelSimulation, cases: number): void {
  const before = casesInStock(sim.state);
  for (const input of recipe.inputsPerCase) expectApplied(sim.dispatch({ command: purchase(input.materialId, input.quantity * cases) }));
  expectApplied(sim.dispatch({ command: { type: "START_PRODUCTION", facilityId: DISTILLERY_MAIN, recipeId: BASIC_MOONSHINE_RECIPE, quantity: cases } }));
  const job = sim.state.productionJobs.find((j) => j.facilityId === DISTILLERY_MAIN);
  if (!job) throw new Error("Production didn't start");
  advanceTo(sim, job.completesAt);
  expect(casesInStock(sim.state)).toBe(before + cases);
}

function sell(buyerId: BuyerId, quantity: number, agreedUnitPrice: Money, quality: QualityTier = "basic"): GameCommand {
  return {
    type: "DISPATCH_DELIVERY",
    vehicleId: MODEL_TT_TRUCK,
    cargo: [{ productId: MOONSHINE, quality, quantity }],
    purpose: { kind: "SALE", buyerId, agreedUnitPrice },
    routeId: null,
  };
}

function lastDeliveryId(state: GameState) {
  const d = state.deliveries.at(-1);
  if (!d) throw new Error("No delivery");
  return d.id;
}

function truckHome(state: GameState): boolean {
  return state.vehicles.find((v) => v.id === MODEL_TT_TRUCK)?.trip === null;
}

function eventsOfType<T extends GameEvent["type"]>(events: readonly GameEvent[], type: T): Extract<GameEvent, { type: T }>[] {
  return events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === type);
}

function line(quality: QualityTier, quantity: number): CargoLine {
  return { productId: MOONSHINE, quality, quantity };
}

function isDeal(x: Deal | { readonly code: string }): x is Deal {
  return !("code" in x);
}

function mustDeal(x: ReturnType<typeof quoteDeal>): Deal {
  if (!isDeal(x)) throw new Error(`Expected a deal, got ${JSON.stringify(x)}`);
  return x;
}

function withBuyer(state: GameState, id: BuyerId, patch: (b: BuyerState) => BuyerState): GameState {
  return { ...state, buyers: state.buyers.map((b) => (b.id === id ? patch(b) : b)) };
}

function withReputation(state: GameState, reputation: number): GameState {
  return { ...state, family: { ...state.family, reputation } };
}

/** min(demandRemaining, floor(budgetRemaining / unitPrice)) (GDD §7 buyer liquidity). */
function liquidity(buyer: BuyerState, want: BuyerState["wants"][number]): number {
  return Math.min(want.demandRemaining, Math.floor(buyer.budgetRemaining / want.unitPrice));
}

// ---------------------------------------------------------------------------
// Fixture GameData for validation
// ---------------------------------------------------------------------------

function patchMarket(index: number, patch: Partial<MarketDefinition>): GameData {
  return { ...GAME_DATA, markets: GAME_DATA.markets.map((m, i) => (i === index ? { ...m, ...patch } : m)) };
}

function patchBuyer(id: BuyerId, patch: Partial<BuyerDefinition>): GameData {
  return { ...GAME_DATA, buyers: GAME_DATA.buyers.map((b) => (b.id === id ? { ...b, ...patch } : b)) };
}

function patchWant(id: BuyerId, index: number, patch: Partial<BuyerWantDefinition>): GameData {
  const def = buyerDef(id);
  return patchBuyer(id, { wants: def.wants.map((w, i) => (i === index ? { ...w, ...patch } : w)) });
}

function patchStock(supplierId: SupplierId, materialId: MaterialId, patch: Partial<SupplierStockDefinition>): GameData {
  return {
    ...GAME_DATA,
    suppliers: GAME_DATA.suppliers.map((s) =>
      s.id === supplierId ? { ...s, stock: s.stock.map((st) => (st.materialId === materialId ? { ...st, ...patch } : st)) } : s,
    ),
  };
}

function patchShortage(patch: Partial<Shortage>): GameData {
  return patchStock(shippedShortage().supplierId, shippedShortage().materialId, { shortage: { ...shippedShortage().shortage, ...patch } });
}

function patchEffect(patch: Partial<MarketEffect>): GameData {
  const [first, ...rest] = shippedShortage().shortage.marketEffects;
  if (!first) throw new Error("The shipped shortage has no market effects");
  return patchShortage({ marketEffects: [{ ...first, ...patch }, ...rest] });
}

/** Another stock line (not the shipped shortage's) given a copy of the shipped shortage. */
function twoShortagesOnOneMarket(): GameData {
  const other = GAME_DATA.suppliers
    .flatMap((s) => s.stock.map((st) => ({ supplierId: s.id, materialId: st.materialId, st })))
    .find((x) => !x.st.shortage);
  if (!other) throw new Error("No stock line without a shortage to copy one onto");
  return {
    ...GAME_DATA,
    suppliers: GAME_DATA.suppliers.map((s) =>
      s.id === other.supplierId
        ? { ...s, stock: s.stock.map((st) => (st.materialId === other.materialId ? { ...st, shortage: shippedShortage().shortage } : st)) }
        : s,
    ),
  };
}

/** `fn` throws a MarketDataError (and MarketDataError is a real class, so a missing export can't pass). */
function expectMarketDataError(fn: () => unknown, label?: string): void {
  expect(typeof MarketDataError, "MarketDataError must be an exported class").toBe("function");
  let caught: unknown = null;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught, label).toBeInstanceOf(MarketDataError);
  expect(caught, label).toBeInstanceOf(Error);
}

const premiumMarketExists = GAME_DATA.markets.some((m) => m.productId === MOONSHINE && m.quality === "premium");

// ===========================================================================
// Spot price (GDD §7, ADR 0016)
// ===========================================================================

describe("ECO-001 spot price", () => {
  const opening: MarketState = newGame().state.markets[0]!;
  const def: MarketDefinition = GAME_DATA.markets[0]!;
  const fixture = (demand: number, supply: number, eventRatio: Ratio, baselineDemand: number, baselineSupply: number) => ({
    market: { ...opening, demand, supply, eventRatio },
    def: { ...def, baselineDemand, baselineSupply },
  });

  it("exports the clamp bounds from game-data", () => {
    expect(MARKET_PRICE_BOUNDS).toBeDefined();
  });

  it("passes the GDD worked example exactly: $20, demand +10%, supply −20%, no event → $27.50", () => {
    // D₀ 40, D 44 (1.10×); S₀ 60, S 48 (0.8×, so M_S = 60/48 = 1.25).
    const { market, def: d } = fixture(44, 48, RATIO_ONE, 40, 60);
    const inputs = priceInputs(market, d);
    expect([...inputs]).toEqual([1_100_000, 1_250_000, 1_000_000]);
    expect(applyRatios(cents(2_000), inputs)).toBe(cents(2_750));
  });

  it("clamps each multiplier to its GDD bounds", () => {
    const at = (demand: number, supply: number, eventRatio: number) => {
      const { market, def: d } = fixture(demand, supply, ratio(eventRatio), 40, 60);
      return [...priceInputs(market, d)];
    };
    expect(at(80, 60, PPM)).toEqual([M_DS_MAX, PPM, PPM]); // D = 2 × D₀
    expect(at(0, 60, PPM)).toEqual([M_DS_MIN, PPM, PPM]); // D = 0
    expect(at(40, 0, PPM)).toEqual([PPM, M_DS_MAX, PPM]); // S = 0 → S₀ / max(S, 1)
    expect(at(40, 600, PPM)).toEqual([PPM, M_DS_MIN, PPM]); // S = 10 × S₀
    expect(at(40, 60, 1_500_000)).toEqual([PPM, PPM, M_E_MAX]);
    expect(at(40, 60, 500_000)).toEqual([PPM, PPM, M_E_MIN]);
  });

  it("property: the multipliers follow the formula, their product stays in [0.576, 1.71875], and the price is rounded once", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 1, max: 100_000 }),
        fc.integer({ min: 1, max: 100_000 }),
        fc.integer({ min: 1, max: 5_000_000 }),
        fc.integer({ min: 1, max: 10_000_000 }),
        (D, S, D0, S0, eventRatio, base) => {
          const { market, def: d } = fixture(D, S, ratio(eventRatio), D0, S0);
          const inputs = priceInputs(market, d);
          expect(inputs).toHaveLength(3);
          const [mD, mS, mE] = inputs;
          expect(mD).toBe(clampRatio(ratioOf(D, D0), ratio(M_DS_MIN), ratio(M_DS_MAX)));
          expect(mS).toBe(clampRatio(ratioOf(S0, Math.max(S, 1)), ratio(M_DS_MIN), ratio(M_DS_MAX)));
          expect(mE).toBe(clampRatio(ratio(eventRatio), ratio(M_E_MIN), ratio(M_E_MAX)));
          // Product in ppm³ against the bounds scaled to ppm³.
          const product = BigInt(mD!) * BigInt(mS!) * BigInt(mE!);
          const scale = BigInt(PPM) * BigInt(PPM);
          expect(product >= BigInt(PRODUCT_MIN) * scale).toBe(true);
          expect(product <= BigInt(PRODUCT_MAX) * scale).toBe(true);
          // One rounding: the price equals applyRatios over the reported multipliers,
          // and lies within the bounds applied to the base price.
          const price = applyRatios(cents(base), inputs);
          expect(price).toBe(applyRatios(cents(base), [mD!, mS!, mE!]));
          expect(price).toBeGreaterThanOrEqual(applyRatios(cents(base), [ratio(PRODUCT_MIN)]));
          expect(price).toBeLessThanOrEqual(applyRatios(cents(base), [ratio(PRODUCT_MAX)]));
        },
      ),
      { numRuns: 500 },
    );
  });
});

// ===========================================================================
// Validation
// ===========================================================================

describe("ECO-001 market data validation", () => {
  const roadhouseWant0 = buyerDef(CROSSROADS_ROADHOUSE).wants[0]!;
  const kesslers = buyerDef(KESSLERS_BACK_ROOM);

  const invalid: readonly (readonly [string, () => GameData])[] = [
    ["D₀ = 0", () => patchMarket(0, { baselineDemand: 0 })],
    ["D₀ < 0", () => patchMarket(0, { baselineDemand: -5 })],
    ["S₀ = 0", () => patchMarket(0, { baselineSupply: 0 })],
    ["S₀ < 0", () => patchMarket(0, { baselineSupply: -5 })],
    ["non-integer D₀", () => patchMarket(0, { baselineDemand: 40.5 })],
    ["non-integer S₀", () => patchMarket(0, { baselineSupply: 60.5 })],
    ["a buyer want with no (product, quality) market", () => patchWant(CROSSROADS_ROADHOUSE, 0, { minimumQuality: "premium" })],
    ["two wants of one buyer with the same (product, minimum quality)", () => patchBuyer(KESSLERS_BACK_ROOM, { wants: [...kesslers.wants, kesslers.wants[0]!] })],
    ["minimumReputation < 0", () => patchBuyer(CROSSROADS_ROADHOUSE, { minimumReputation: -1 })],
    ["minimumReputation > 100", () => patchBuyer(CROSSROADS_ROADHOUSE, { minimumReputation: 101 })],
    ["daily demand 0", () => patchWant(CROSSROADS_ROADHOUSE, 0, { dailyDemand: 0 })],
    ["daily demand < 0", () => patchWant(CROSSROADS_ROADHOUSE, 0, { dailyDemand: -1 })],
    ["price ratio 0", () => patchWant(CROSSROADS_ROADHOUSE, 0, { priceRatio: ratio(0) })],
    ["price ratio < 0", () => patchWant(CROSSROADS_ROADHOUSE, 0, { priceRatio: ratio(-1) })],
    ["demandDriftPpm < 0", () => patchMarket(0, { demandDriftPpm: -1 })],
    ["demandDriftPpm = 1 000 000", () => patchMarket(0, { demandDriftPpm: PPM })],
    ["two configured shortages affecting the same market", twoShortagesOnOneMarket],
    ["a negative daily budget", () => patchBuyer(CROSSROADS_ROADHOUSE, { dailyBudget: cents(-1) })],
    ["shortage earliestStartDay < 2", () => patchShortage({ earliestStartDay: 1, latestStartDay: Math.max(1, shippedShortage().shortage.latestStartDay) })],
    ["shortage earliestStartDay > latestStartDay", () => patchShortage({ earliestStartDay: 5, latestStartDay: 4 })],
    ["shortage durationDays 0", () => patchShortage({ durationDays: 0 })],
    ["shortage supplyRatio 0", () => patchShortage({ supplyRatio: ratio(0) })],
    ["shortage supplyRatio > 1", () => patchShortage({ supplyRatio: ratio(PPM + 1) })],
    ["shortage priceRatio < 1", () => patchShortage({ priceRatio: ratio(PPM - 1) })],
    ["shortage eventRatio < 0.90", () => patchEffect({ eventRatio: ratio(M_E_MIN - 1) })],
    ["shortage eventRatio > 1.10", () => patchEffect({ eventRatio: ratio(M_E_MAX + 1) })],
    ["shortage effect on a market that doesn't exist", () => patchEffect({ quality: "premium" })],
  ];

  it("the fixtures that rely on there being no premium moonshine market are valid probes", () => {
    expect(premiumMarketExists).toBe(false);
    expect(roadhouseWant0.minimumQuality).not.toBe("premium");
  });

  it("accepts the shipped GAME_DATA", () => {
    expect(() => validateMarketData(GAME_DATA)).not.toThrow();
  });

  it.each(invalid)("rejects %s with MarketDataError", (_name, build) => {
    const data = build();
    expectMarketDataError(() => validateMarketData(data));
  });

  it("accepts the boundary values of each rule", () => {
    const boundaries: readonly GameData[] = [
      patchBuyer(CROSSROADS_ROADHOUSE, { minimumReputation: 0 }),
      patchBuyer(CROSSROADS_ROADHOUSE, { minimumReputation: 100 }),
      patchBuyer(CROSSROADS_ROADHOUSE, { dailyBudget: cents(0) }),
      patchMarket(0, { demandDriftPpm: 0 }),
      patchMarket(0, { demandDriftPpm: PPM - 1 }),
      patchShortage({ earliestStartDay: 2, latestStartDay: 2 }),
      patchShortage({ durationDays: 1 }),
      patchShortage({ supplyRatio: ratio(PPM) }),
      patchShortage({ priceRatio: ratio(PPM) }),
      patchEffect({ eventRatio: ratio(M_E_MIN) }),
      patchEffect({ eventRatio: ratio(M_E_MAX) }),
    ];
    for (const data of boundaries) expect(() => validateMarketData(data)).not.toThrow();
  });

  it("runs inside registerMarket", () => {
    expect(() => registerMarket(createRegistry(), GAME_DATA, createCoordinator())).not.toThrow();
    for (const [name, build] of invalid) {
      const data = build();
      expectMarketDataError(() => registerMarket(createRegistry(), data, createCoordinator()), name);
    }
  });
});

// ===========================================================================
// Midnight cycle
// ===========================================================================

describe("ECO-001 midnight cycle", () => {
  it("runs replenish, refresh, events, prices, report in one entry-free DAILY_SETTLEMENT transaction", () => {
    const sim = newGame();
    const roadhouse = CROSSROADS_ROADHOUSE;
    const sold = 3;

    // Day 0: buy and produce (lowers supplier stock), then dispatch late so the
    // deal is still outstanding at midnight (lowers the roadhouse's demand and budget).
    stockCases(sim, sold);
    const route = GAME_DATA.routes.find((r) => r.toLocationId === buyerDef(roadhouse).locationId)!;
    const dispatchTick = DAY - Math.floor(route.durationTicks / 2);
    expect(sim.state.tick).toBeLessThan(dispatchTick);
    advanceTo(sim, dispatchTick - 1);
    expectApplied(sim.dispatch({ command: sell(roadhouse, sold, wantOf(sim.state, roadhouse, "basic").unitPrice) }));
    advanceTo(sim, DAY - 1);

    const before = sim.state;
    expect(before.suppliers.some((s) => s.stock.some((st) => st.available < GAME_DATA.suppliers.find((d) => d.id === s.id)!.stock.find((x) => x.materialId === st.materialId)!.dailyStock))).toBe(true);
    expect(buyerOf(before, roadhouse).commitments).toHaveLength(1);
    sim.takeEvents();

    advanceTo(sim, DAY);
    const after = sim.state;
    const events = sim.takeEvents();

    // Step 1: replenish suppliers to their daily level, no carry-over, normal price.
    for (const s of after.suppliers) {
      const def = GAME_DATA.suppliers.find((d) => d.id === s.id)!;
      for (const st of s.stock) {
        const stDef = def.stock.find((x) => x.materialId === st.materialId)!;
        expect(st).toEqual({ materialId: st.materialId, available: stDef.dailyStock, unitPrice: stDef.unitPrice, shortage: null });
      }
    }

    // Step 2: buyers refreshed to their daily values; outstanding commitments untouched.
    for (const b of after.buyers) {
      const def = buyerDef(b.id);
      expect(b.budgetRemaining).toBe(def.dailyBudget);
      expect(b.wants.map((w) => [w.productId, w.minimumQuality, w.demandRemaining])).toEqual(
        def.wants.map((w) => [w.productId, w.minimumQuality, w.dailyDemand]),
      );
      expect(b.commitments).toEqual(buyerOf(before, b.id).commitments);
    }

    // Steps 3–4: shortage rolls first (supplier, then material order), then one
    // drift draw per market in market order, all from the market stream.
    let rng: RngState = before.rng.market;
    const startDays = shortageLines().map((s) => {
      const draw = nextIntBetween(rng, s.shortage.earliestStartDay, s.shortage.latestStartDay);
      rng = draw.rng;
      return { ...s, startDay: draw.value };
    });
    const drifts = marketOrder().map((def) => {
      const k = driftBound(def);
      const draw = nextIntBetween(rng, -k, k);
      rng = draw.rng;
      return { def, drift: draw.value };
    });
    expect(after.rng.market).toEqual(rng);

    for (const s of startDays) {
      const scheduled = after.scheduledEvents.filter(
        (e) => e.kind === "SHORTAGE_START" && e.supplierId === s.supplierId && e.materialId === s.materialId,
      );
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0]).toMatchObject({
        tick: s.startDay * DAY,
        supplyRatio: s.shortage.supplyRatio,
        durationTicks: s.shortage.durationDays * DAY,
      });
    }

    // Sold volume per market: dailyDemand − demandRemaining over the wants priced from it.
    const soldVolume = (productId: ProductId, quality: QualityTier) =>
      before.buyers.reduce(
        (n, b) =>
          n +
          buyerDef(b.id)
            .wants.filter((w) => w.productId === productId && w.minimumQuality === quality)
            .reduce((m, w) => m + w.dailyDemand - wantOf(before, b.id, w.minimumQuality).demandRemaining, 0),
        0,
      );
    expect(soldVolume(MOONSHINE, "basic")).toBe(sold);

    for (const { def, drift } of drifts) {
      const m = marketOf(after, def.productId, def.quality);
      expect(m.demand).toBe(def.baselineDemand + drift);
      expect(m.supply).toBe(def.baselineSupply + soldVolume(def.productId, def.quality));
      expect(m.eventRatio).toBe(RATIO_ONE);
      expect(m.previousSpotPrice).toBe(marketOf(before, def.productId, def.quality).spotPrice);
      expect(m.spotPrice).toBe(formulaSpot(m));
    }

    // Buyer quotes: applyRatios(spot of (product, minimum quality), [priceRatio]).
    for (const b of after.buyers) {
      for (const w of buyerDef(b.id).wants) {
        expect(wantOf(after, b.id, w.minimumQuality).unitPrice).toBe(applyRatios(marketOf(after, w.productId, w.minimumQuality).spotPrice, [w.priceRatio]));
      }
    }

    // One transaction, no entries, keyed by the day that is starting.
    const txs = transactionsKeyed(after, idempotencyKey("DAILY_SETTLEMENT", "MARKET", 1));
    expect(txs).toHaveLength(1);
    const tx = txs[0]!;
    expect(tx.kind).toBe("DAILY_SETTLEMENT");
    expect(tx.tick).toBe(DAY);
    expect(tx.entries).toEqual([]);

    // Step 5: the report, emitted by that transaction.
    const reports = eventsOfType(events, "MARKET_UPDATED");
    expect(reports).toHaveLength(1);
    expect(reports[0]!.dayIndex).toBe(1);
    expect(tx.eventIds).toContain(reports[0]!.id);
  });

  it("rolls shortages only at the midnight that starts day 1; later midnights draw only drift, in market order", () => {
    const sim = newGame();
    advanceTo(sim, DAY);
    const scheduledAfterDay1 = sim.state.scheduledEvents.filter((e) => e.kind === "SHORTAGE_START");
    for (let day = 2; day <= 3; day++) {
      advanceTo(sim, day * DAY - 1);
      const before = sim.state;
      advanceTo(sim, day * DAY);
      let rng: RngState = before.rng.market;
      for (const def of marketOrder()) {
        const k = driftBound(def);
        const draw = nextIntBetween(rng, -k, k);
        rng = draw.rng;
        expect(marketOf(sim.state, def.productId, def.quality).demand).toBe(def.baselineDemand + draw.value);
      }
      expect(sim.state.rng.market).toEqual(rng);
      expect(transactionsKeyed(sim.state, idempotencyKey("DAILY_SETTLEMENT", "MARKET", day))).toHaveLength(1);
      // No new shortage was scheduled.
      const starts = sim.state.scheduledEvents.filter((e) => e.kind === "SHORTAGE_START");
      for (const e of starts) expect(scheduledAfterDay1).toContainEqual(e);
    }
  });

  it("is deterministic: the same seed gives the same prices over 15 days, a different seed different demand", () => {
    const run = (seed: number) => {
      const sim = gameWithSeed(seed);
      const days: { prices: Money[]; demand: number[] }[] = [];
      for (let day = 1; day <= 15; day++) {
        advanceTo(sim, day * DAY);
        days.push({ prices: sim.state.markets.map((m) => m.spotPrice), demand: sim.state.markets.map((m) => m.demand) });
      }
      return days;
    };
    expect(GAME_DATA.markets.some((m) => driftBound(m) > 0)).toBe(true);
    const seed = FIRST_SHIPMENT_SCENARIO.seed;
    const a = run(seed);
    expect(run(seed)).toEqual(a);
    expect(run(seed + 1).map((d) => d.demand)).not.toEqual(a.map((d) => d.demand));
  });

  it("keeps every price in bounds and explainable every day of a 30-day run", { timeout: 120_000 }, () => {
    const sim = newGame();
    const day0 = sim.snapshot().market;
    expect(day0.products.length).toBe(GAME_DATA.markets.length);
    for (const p of day0.products) expect(p.previousSpotPrice).toBeNull();

    for (let day = 1; day <= 30; day++) {
      advanceTo(sim, day * DAY);
      for (const m of sim.state.markets) {
        const [mD, mS, mE] = priceInputs(m, marketDef(m.productId, m.quality));
        expect(mD).toBeGreaterThanOrEqual(M_DS_MIN);
        expect(mD).toBeLessThanOrEqual(M_DS_MAX);
        expect(mS).toBeGreaterThanOrEqual(M_DS_MIN);
        expect(mS).toBeLessThanOrEqual(M_DS_MAX);
        expect(mE).toBeGreaterThanOrEqual(M_E_MIN);
        expect(mE).toBeLessThanOrEqual(M_E_MAX);
        expect(m.spotPrice).toBe(formulaSpot(m));
      }
      const report = sim.snapshot().market;
      expect(report.dayIndex).toBe(day);
      for (const p of report.products) {
        const m = marketOf(sim.state, p.productId, p.quality);
        expect(p.basePrice).toBe(basePrice(p.productId, p.quality));
        expect(p.spotPrice).toBe(m.spotPrice);
        expect([p.demandRatioPpm, p.supplyRatioPpm, p.eventRatioPpm]).toEqual([...priceInputs(m, marketDef(p.productId, p.quality))]);
        expect(applyRatios(p.basePrice, [ratio(p.demandRatioPpm), ratio(p.supplyRatioPpm), ratio(p.eventRatioPpm)])).toBe(p.spotPrice);
        expect(p.previousSpotPrice).not.toBeNull();
      }
    }
  });
});

// ===========================================================================
// Prices fixed within a day
// ===========================================================================

describe("ECO-001 prices are fixed within a day", () => {
  const quotes = (state: GameState) => ({
    markets: state.markets,
    buyerPrices: state.buyers.map((b) => b.wants.map((w) => w.unitPrice)),
    supplierPrices: state.suppliers.map((s) => s.stock.map((st) => st.unitPrice)),
  });

  it("changes spot prices, buyer quotes and supplier prices only at midnight; stock and demand drop immediately", () => {
    const sim = newGame();
    advanceTo(sim, DAY);
    const fixed = quotes(sim.state);
    const check = () => expect(quotes(sim.state)).toEqual(fixed);

    // A purchase lowers the supplier's stock at once, at an unchanged price.
    const input = recipe.inputsPerCase[0]!;
    const supplierId = supplierSelling(input.materialId);
    const availableBefore = stockOf(sim.state, supplierId, input.materialId).available;
    expectApplied(sim.dispatch({ command: purchase(input.materialId, input.quantity) }));
    expect(stockOf(sim.state, supplierId, input.materialId).available).toBe(availableBefore - input.quantity);
    check();

    // A dispatched sale lowers the buyer's demand and budget at once, at an unchanged quote.
    stockCases(sim, 1);
    check();
    const buyer = buyerOf(sim.state, CROSSROADS_ROADHOUSE);
    const want = wantOf(sim.state, CROSSROADS_ROADHOUSE, "basic");
    expectApplied(sim.dispatch({ command: sell(CROSSROADS_ROADHOUSE, 1, want.unitPrice) }));
    expect(buyerOf(sim.state, CROSSROADS_ROADHOUSE).budgetRemaining).toBe(buyer.budgetRemaining - want.unitPrice);
    expect(wantOf(sim.state, CROSSROADS_ROADHOUSE, "basic").demandRemaining).toBe(want.demandRemaining - 1);
    check();

    // Nothing moves for the rest of the day.
    while (sim.state.tick < 2 * DAY - 1) {
      sim.advance(Math.min(60, 2 * DAY - 1 - sim.state.tick));
      check();
    }

    advanceTo(sim, 2 * DAY);
    for (const m of sim.state.markets) {
      expect(m.previousSpotPrice).toBe(fixed.markets.find((x) => x.productId === m.productId && x.quality === m.quality)!.spotPrice);
    }
  });

  it("rejects a command queued with yesterday's quote for after midnight with QUOTE_CHANGED when the quote moved", () => {
    let movedSeen = 0;
    for (let seed = 1; seed <= 30 && movedSeen < 2; seed++) {
      const sim = gameWithSeed(seed);
      stockCases(sim, 1);
      const yesterday = wantOf(sim.state, CROSSROADS_ROADHOUSE, "basic").unitPrice;
      const queued = sim.dispatch({ command: sell(CROSSROADS_ROADHOUSE, 1, yesterday), scheduledTick: tick(DAY + 1) });
      expect(queued.status).toBe("queued");
      advanceTo(sim, DAY);
      const today = wantOf(sim.state, CROSSROADS_ROADHOUSE, "basic").unitPrice;
      sim.takeEvents();
      advanceTo(sim, DAY + 1);
      const events = sim.takeEvents();
      const rejected = eventsOfType(events, "COMMAND_REJECTED");
      if (today !== yesterday) {
        movedSeen++;
        expect(rejected).toHaveLength(1);
        expect(rejected[0]!.reason).toEqual({ code: "QUOTE_CHANGED", buyerId: CROSSROADS_ROADHOUSE, agreed: yesterday, current: today });
        expect(sim.state.deliveries).toEqual([]);
      } else {
        expect(rejected).toEqual([]);
        expect(eventsOfType(events, "DELIVERY_DISPATCHED")).toHaveLength(1);
      }
    }
    expect(movedSeen).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Shortage
// ===========================================================================

describe("ECO-001 shortage", () => {
  const scheduledStartDay = (sim: KernelSimulation): number => {
    const { supplierId, materialId } = shippedShortage();
    advanceTo(sim, DAY);
    const starts = sim.state.scheduledEvents.filter((e) => e.kind === "SHORTAGE_START" && e.supplierId === supplierId && e.materialId === materialId);
    expect(starts).toHaveLength(1);
    const t = starts[0]!.tick;
    expect(t % DAY).toBe(0);
    return t / DAY;
  };

  it("ships one shortage that cuts stock, raises the price, and raises the affected markets' eventRatio", () => {
    const { shortage } = shippedShortage();
    expect(shortage.supplyRatio).toBeLessThan(PPM);
    expect(shortage.priceRatio).toBeGreaterThan(PPM);
    expect(shortage.marketEffects.length).toBeGreaterThan(0);
    for (const e of shortage.marketEffects) expect(e.eventRatio).toBeGreaterThan(PPM);
    expect(shortage.latestStartDay).toBeGreaterThan(shortage.earliestStartDay);
  });

  it("starts in its window, bites while it lasts, and ends after its duration with every effect gone", { timeout: 60_000 }, () => {
    const { supplierId, materialId, stock: stockDef, shortage } = shippedShortage();
    const sim = newGame();
    const startDay = scheduledStartDay(sim);
    expect(startDay).toBeGreaterThanOrEqual(shortage.earliestStartDay);
    expect(startDay).toBeLessThanOrEqual(shortage.latestStartDay);
    const startTick = startDay * DAY;
    const endsAt = startTick + shortage.durationDays * DAY;
    const shortPrice = applyRatios(stockDef.unitPrice, [shortage.priceRatio]);
    const shortStock = floorPpm(stockDef.dailyStock, shortage.supplyRatio);
    const affected = (m: MarketState) => shortage.marketEffects.find((e) => e.productId === m.productId && e.quality === m.quality);

    for (let day = 1; day <= startDay + shortage.durationDays + 1; day++) {
      sim.takeEvents();
      advanceTo(sim, day * DAY);
      const events = sim.takeEvents();
      const t = day * DAY;
      const active = t >= startTick && t < endsAt;
      const line = stockOf(sim.state, supplierId, materialId);

      if (active) {
        expect(line.shortage).toEqual({ supplyRatio: shortage.supplyRatio, endsAt });
        expect(line.available).toBe(shortStock);
        expect(line.unitPrice).toBe(shortPrice);
      } else {
        expect(line.shortage).toBeNull();
        expect(line.available).toBe(stockDef.dailyStock);
        expect(line.unitPrice).toBe(stockDef.unitPrice);
      }
      for (const m of sim.state.markets) {
        const effect = affected(m);
        expect(m.eventRatio).toBe(active && effect ? effect.eventRatio : RATIO_ONE);
        expect(m.spotPrice).toBe(formulaSpot(m));
      }
      const snapLine = sim.snapshot().market.suppliers.find((s) => s.id === supplierId)!.materials.find((x) => x.materialId === materialId)!;
      expect(snapLine.shortage).toBe(active);

      if (t === startTick) {
        const started = eventsOfType(events, "SHORTAGE_STARTED");
        expect(started).toHaveLength(1);
        expect(started[0]).toMatchObject({ supplierId, materialId, supplyRatioPpm: shortage.supplyRatio, endsAt });
        const txs = transactionsKeyed(sim.state, idempotencyKey("DAILY_SETTLEMENT", "SHORTAGE_START", supplierId, materialId, startTick));
        expect(txs).toHaveLength(1);
        expect(txs[0]!.kind).toBe("DAILY_SETTLEMENT");
        expect(txs[0]!.entries).toEqual([]);
        expect(txs[0]!.eventIds).toContain(started[0]!.id);
        const ends = sim.state.scheduledEvents.filter((e) => e.kind === "SHORTAGE_END" && e.supplierId === supplierId && e.materialId === materialId);
        expect(ends.map((e) => e.tick)).toEqual([endsAt]);

        // Buying during the shortage pays the shortage price, and only the cut stock is there.
        sim.takeEvents();
        expectApplied(sim.dispatch({ command: purchase(materialId, 1) }));
        const bought = eventsOfType(sim.takeEvents(), "MATERIALS_PURCHASED");
        expect(bought).toHaveLength(1);
        expect(bought[0]).toMatchObject({ supplierId, materialId, quantity: 1, unitPrice: shortPrice, total: shortPrice });
        expectRejected(sim, purchase(materialId, shortStock), "SUPPLIER_STOCK_LOW");
      }
      if (t === endsAt) {
        const ended = eventsOfType(events, "SHORTAGE_ENDED");
        expect(ended).toHaveLength(1);
        expect(ended[0]).toMatchObject({ supplierId, materialId });
        const txs = transactionsKeyed(sim.state, idempotencyKey("DAILY_SETTLEMENT", "SHORTAGE_END", supplierId, materialId, endsAt));
        expect(txs).toHaveLength(1);
        expect(txs[0]!.entries).toEqual([]);
        expect(txs[0]!.eventIds).toContain(ended[0]!.id);
      }
    }
  });

  it("varies its start day across seeds and repeats it exactly for one seed", () => {
    const { shortage } = shippedShortage();
    const days = new Set<number>();
    for (let seed = 1; seed <= 20; seed++) {
      const day = scheduledStartDay(gameWithSeed(seed));
      expect(day).toBeGreaterThanOrEqual(shortage.earliestStartDay);
      expect(day).toBeLessThanOrEqual(shortage.latestStartDay);
      expect(scheduledStartDay(gameWithSeed(seed))).toBe(day);
      days.add(day);
    }
    expect(days.size).toBeGreaterThan(1);
  });
});

// ===========================================================================
// Buyers and spot deals (ADR 0005, ADR 0016)
// ===========================================================================

describe("ECO-001 buyer terms: quoteDeal", () => {
  const opening = newGame().state;
  const lakeview = buyerDef(LAKEVIEW_HOTEL);
  const required = lakeview.minimumReputation;

  it("checks unknown buyer, reputation, want, quote, then liquidity, in that order", () => {
    expect(required).toBeGreaterThan(0);
    const unknown = asId("Buyer", "nobody-at-all");
    expect(quoteDeal(opening, GAME_DATA, unknown, cents(1), line("standard", 1))).toEqual({ code: "UNKNOWN_ENTITY", kind: "Buyer", id: unknown });

    const low = withReputation(opening, required - 1);
    const standard = wantOf(low, LAKEVIEW_HOTEL, "standard");
    // Reputation is checked before the want and the quote.
    expect(quoteDeal(low, GAME_DATA, LAKEVIEW_HOTEL, cents(standard.unitPrice + 1), line("basic", 1000))).toEqual({
      code: "REPUTATION_TOO_LOW",
      required,
      current: required - 1,
    });
    expect(quoteDeal(low, GAME_DATA, LAKEVIEW_HOTEL, standard.unitPrice, line("standard", 1))).toMatchObject({ code: "REPUTATION_TOO_LOW" });

    const ok = withReputation(opening, required);
    // Want before quote: Lakeview takes no basic moonshine.
    expect(lakeview.wants.some((w) => w.minimumQuality === "basic")).toBe(false);
    expect(quoteDeal(ok, GAME_DATA, LAKEVIEW_HOTEL, cents(standard.unitPrice + 1), line("basic", 1000))).toEqual({
      code: "PRODUCT_NOT_WANTED",
      buyerId: LAKEVIEW_HOTEL,
      productId: MOONSHINE,
      quality: "basic",
    });
    // Quote before liquidity.
    expect(quoteDeal(ok, GAME_DATA, LAKEVIEW_HOTEL, cents(standard.unitPrice + 1), line("standard", 1000))).toEqual({
      code: "QUOTE_CHANGED",
      buyerId: LAKEVIEW_HOTEL,
      agreed: standard.unitPrice + 1,
      current: standard.unitPrice,
    });
    // Liquidity: no partial sales.
    const acceptable = liquidity(buyerOf(ok, LAKEVIEW_HOTEL), standard);
    expect(quoteDeal(ok, GAME_DATA, LAKEVIEW_HOTEL, standard.unitPrice, line("standard", acceptable + 1))).toEqual({
      code: "BUYER_WILL_TAKE_LESS",
      buyerId: LAKEVIEW_HOTEL,
      requested: acceptable + 1,
      acceptable,
    });
    expect(quoteDeal(ok, GAME_DATA, LAKEVIEW_HOTEL, standard.unitPrice, line("standard", acceptable))).toMatchObject({
      buyerId: LAKEVIEW_HOTEL,
      unitPrice: standard.unitPrice,
      quantity: acceptable,
      amount: multiplyMoney(standard.unitPrice, acceptable),
    });
  });

  it("caps a deal by demand remaining or by budget, whichever binds", () => {
    const want = wantOf(opening, CROSSROADS_ROADHOUSE, "basic");
    const demandBinds = withBuyer(opening, CROSSROADS_ROADHOUSE, (b) => ({ ...b, budgetRemaining: multiplyMoney(want.unitPrice, want.demandRemaining + 5) }));
    expect(quoteDeal(demandBinds, GAME_DATA, CROSSROADS_ROADHOUSE, want.unitPrice, line("basic", want.demandRemaining + 1))).toMatchObject({
      code: "BUYER_WILL_TAKE_LESS",
      acceptable: want.demandRemaining,
    });
    const budgetCases = Math.max(0, want.demandRemaining - 3);
    const budgetBinds = withBuyer(opening, CROSSROADS_ROADHOUSE, (b) => ({ ...b, budgetRemaining: cents(multiplyMoney(want.unitPrice, budgetCases) + want.unitPrice - 1) }));
    expect(quoteDeal(budgetBinds, GAME_DATA, CROSSROADS_ROADHOUSE, want.unitPrice, line("basic", budgetCases + 1))).toMatchObject({
      code: "BUYER_WILL_TAKE_LESS",
      acceptable: budgetCases,
    });
    expect(isDeal(quoteDeal(budgetBinds, GAME_DATA, CROSSROADS_ROADHOUSE, want.unitPrice, line("basic", budgetCases)))).toBe(budgetCases > 0);
  });
});

describe("ECO-001 want matching (follow-up from #47)", () => {
  const kesslers = () => {
    const opening = newGame().state;
    return { opening, basic: wantOf(opening, KESSLERS_BACK_ROOM, "basic"), standard: wantOf(opening, KESSLERS_BACK_ROOM, "standard") };
  };

  it("quotes the most specific want: standard for a standard or premium case, basic for a basic case", () => {
    const { opening, basic, standard } = kesslers();
    expect(basic.unitPrice).not.toBe(standard.unitPrice);
    expect(mustDeal(quoteDeal(opening, GAME_DATA, KESSLERS_BACK_ROOM, standard.unitPrice, line("standard", 1))).unitPrice).toBe(standard.unitPrice);
    expect(mustDeal(quoteDeal(opening, GAME_DATA, KESSLERS_BACK_ROOM, standard.unitPrice, line("premium", 1))).unitPrice).toBe(standard.unitPrice);
    expect(mustDeal(quoteDeal(opening, GAME_DATA, KESSLERS_BACK_ROOM, basic.unitPrice, line("basic", 1))).unitPrice).toBe(basic.unitPrice);
    expect(quoteDeal(opening, GAME_DATA, KESSLERS_BACK_ROOM, basic.unitPrice, line("standard", 1))).toEqual({
      code: "QUOTE_CHANGED",
      buyerId: KESSLERS_BACK_ROOM,
      agreed: basic.unitPrice,
      current: standard.unitPrice,
    });
    expect(quoteDeal(opening, GAME_DATA, KESSLERS_BACK_ROOM, standard.unitPrice, line("basic", 1))).toEqual({
      code: "QUOTE_CHANGED",
      buyerId: KESSLERS_BACK_ROOM,
      agreed: standard.unitPrice,
      current: basic.unitPrice,
    });
  });

  it("checks liquidity against the matched want's demand", () => {
    const { opening, basic, standard } = kesslers();
    // Exhaust the basic want's demand only: a standard case is still taken.
    const basicDone = withBuyer(opening, KESSLERS_BACK_ROOM, (b) => ({
      ...b,
      wants: b.wants.map((w) => (w.minimumQuality === "basic" ? { ...w, demandRemaining: 0 } : w)),
    }));
    expect(isDeal(quoteDeal(basicDone, GAME_DATA, KESSLERS_BACK_ROOM, standard.unitPrice, line("standard", 1)))).toBe(true);
    expect(quoteDeal(basicDone, GAME_DATA, KESSLERS_BACK_ROOM, basic.unitPrice, line("basic", 1))).toMatchObject({ code: "BUYER_WILL_TAKE_LESS", acceptable: 0 });
  });

  it("commitDeal reduces the matched want's demand and the shared budget", () => {
    const { opening, basic, standard } = kesslers();
    const deliveryId = asId("Delivery", "delivery-901");
    const stdLine = line("standard", 2);
    const stdDeal = mustDeal(quoteDeal(opening, GAME_DATA, KESSLERS_BACK_ROOM, standard.unitPrice, stdLine));
    const afterStd = commitDeal(opening, stdDeal, deliveryId, stdLine);
    expect(wantOf(afterStd, KESSLERS_BACK_ROOM, "standard").demandRemaining).toBe(standard.demandRemaining - 2);
    expect(wantOf(afterStd, KESSLERS_BACK_ROOM, "basic").demandRemaining).toBe(basic.demandRemaining);
    expect(buyerOf(afterStd, KESSLERS_BACK_ROOM).budgetRemaining).toBe(buyerOf(opening, KESSLERS_BACK_ROOM).budgetRemaining - stdDeal.amount);
    expect(buyerOf(afterStd, KESSLERS_BACK_ROOM).commitments).toEqual([{ deliveryId, productId: MOONSHINE, quantity: 2, amount: stdDeal.amount }]);

    const basicId = asId("Delivery", "delivery-902");
    const basicLine = line("basic", 3);
    const basicDeal = mustDeal(quoteDeal(afterStd, GAME_DATA, KESSLERS_BACK_ROOM, basic.unitPrice, basicLine));
    const afterBoth = commitDeal(afterStd, basicDeal, basicId, basicLine);
    expect(wantOf(afterBoth, KESSLERS_BACK_ROOM, "standard").demandRemaining).toBe(standard.demandRemaining - 2);
    expect(wantOf(afterBoth, KESSLERS_BACK_ROOM, "basic").demandRemaining).toBe(basic.demandRemaining - 3);
    expect(buyerOf(afterBoth, KESSLERS_BACK_ROOM).budgetRemaining).toBe(buyerOf(opening, KESSLERS_BACK_ROOM).budgetRemaining - stdDeal.amount - basicDeal.amount);

    // The snapshot's maxAcceptableQuantity is right for each want.
    const state = withBuyer(afterBoth, KESSLERS_BACK_ROOM, (b) => ({ ...b, commitments: [] }));
    const snap = simulationOf(state).snapshot();
    const kessler = snap.market.buyers.find((b) => b.id === KESSLERS_BACK_ROOM)!;
    const buyer = buyerOf(state, KESSLERS_BACK_ROOM);
    for (const quality of ["basic", "standard"] as const) {
      const want = wantOf(state, KESSLERS_BACK_ROOM, quality);
      const reported = kessler.wants.find((w) => w.productId === MOONSHINE && w.minimumQuality === quality)!;
      expect(reported.unitPrice).toBe(want.unitPrice);
      expect(reported.demandRemaining).toBe(want.demandRemaining);
      expect(reported.maxAcceptableQuantity).toBe(liquidity(buyer, want));
    }
  });
});

describe("ECO-001 buyer snapshot", () => {
  it("reports minimumReputation and willDeal from game-data, and 0 acceptable for a buyer that won't deal", () => {
    const base = newGame().state;
    const required = buyerDef(LAKEVIEW_HOTEL).minimumReputation;
    for (const reputation of [required - 1, required]) {
      const state = withReputation(base, reputation);
      const report = simulationOf(state).snapshot().market;
      for (const b of report.buyers) {
        const def = buyerDef(b.id);
        expect(b.minimumReputation).toBe(def.minimumReputation);
        expect(b.willDeal).toBe(reputation >= def.minimumReputation);
        const buyer = buyerOf(state, b.id);
        for (const w of b.wants) {
          const want = wantOf(state, b.id, w.minimumQuality);
          expect(w.maxAcceptableQuantity).toBe(b.willDeal ? liquidity(buyer, want) : 0);
        }
      }
      const lakeview = report.buyers.find((b) => b.id === LAKEVIEW_HOTEL)!;
      expect(lakeview.willDeal).toBe(reputation >= required);
      if (!lakeview.willDeal) for (const w of lakeview.wants) expect(w.maxAcceptableQuantity).toBe(0);
    }
  });
});

describe("ECO-001 releaseDeal", () => {
  it("restores the matching want's demand and the budget the same day, leaving other wants alone", () => {
    const sim = newGame();
    stockCases(sim, 3);
    const before = sim.state;
    const basic = wantOf(before, KESSLERS_BACK_ROOM, "basic");
    expectApplied(sim.dispatch({ command: sell(KESSLERS_BACK_ROOM, 3, basic.unitPrice) }));
    const during = sim.state;
    const deliveryId = lastDeliveryId(during);
    const commitment = buyerOf(during, KESSLERS_BACK_ROOM).commitments.find((c) => c.deliveryId === deliveryId)!;
    expect(commitment).toMatchObject({ productId: MOONSHINE, quantity: 3 });
    const duringJson = JSON.stringify(during.buyers);

    const released = releaseDeal(during, GAME_DATA, KESSLERS_BACK_ROOM, deliveryId);
    expect(JSON.stringify(during.buyers)).toBe(duringJson); // pure
    const b = buyerOf(released, KESSLERS_BACK_ROOM);
    expect(b.commitments.some((c) => c.deliveryId === deliveryId)).toBe(false);
    expect(wantOf(released, KESSLERS_BACK_ROOM, "basic").demandRemaining).toBe(basic.demandRemaining);
    expect(wantOf(released, KESSLERS_BACK_ROOM, "standard").demandRemaining).toBe(wantOf(during, KESSLERS_BACK_ROOM, "standard").demandRemaining);
    expect(b.budgetRemaining).toBe(Math.min(buyerDef(KESSLERS_BACK_ROOM).dailyBudget, buyerOf(during, KESSLERS_BACK_ROOM).budgetRemaining + commitment.amount));
    expect(b.budgetRemaining).toBe(buyerOf(before, KESSLERS_BACK_ROOM).budgetRemaining);
    // Other buyers untouched.
    expect(released.buyers.filter((x) => x.id !== KESSLERS_BACK_ROOM)).toEqual(during.buyers.filter((x) => x.id !== KESSLERS_BACK_ROOM));
  });

  it("caps the restore at the buyer's daily values after a midnight refresh", () => {
    const roadhouse = CROSSROADS_ROADHOUSE;
    const def = buyerDef(roadhouse);
    const daily = wantDef(roadhouse, "basic").dailyDemand;
    const shipped = 3;

    const sim = newGame();
    stockCases(sim, shipped);
    const route = GAME_DATA.routes.find((r) => r.toLocationId === def.locationId)!;
    advanceTo(sim, DAY - Math.floor(route.durationTicks / 2) - 1);
    expectApplied(sim.dispatch({ command: sell(roadhouse, shipped, wantOf(sim.state, roadhouse, "basic").unitPrice) }));
    const deliveryId = lastDeliveryId(sim.state);
    const amount = buyerOf(sim.state, roadhouse).commitments.find((c) => c.deliveryId === deliveryId)!.amount;
    advanceTo(sim, DAY + 1);
    const day1 = sim.state;
    expect(day1.deliveries.find((d) => d.id === deliveryId)!.status).toBe("OUTBOUND");
    expect(wantOf(day1, roadhouse, "basic").demandRemaining).toBe(daily);
    expect(buyerOf(day1, roadhouse).budgetRemaining).toBe(def.dailyBudget);

    // A day-1 deal of `soldToday` cases, then the day-0 deal falls through.
    for (const soldToday of [1, 5]) {
      const price = wantOf(day1, roadhouse, "basic").unitPrice;
      const todayLine = line("basic", soldToday);
      const deal = mustDeal(quoteDeal(day1, GAME_DATA, roadhouse, price, todayLine));
      const withToday = commitDeal(day1, deal, asId("Delivery", "delivery-950"), todayLine);
      const released = releaseDeal(withToday, GAME_DATA, roadhouse, deliveryId);
      const b = buyerOf(released, roadhouse);
      expect(b.commitments.map((c) => c.deliveryId)).toEqual(["delivery-950"]);
      expect(wantOf(released, roadhouse, "basic").demandRemaining).toBe(Math.min(daily, daily - soldToday + shipped));
      expect(b.budgetRemaining).toBe(Math.min(def.dailyBudget, def.dailyBudget - deal.amount + amount));
      if (soldToday < shipped) {
        // The cap binds: without it the buyer would exceed one day's limits.
        expect(wantOf(released, roadhouse, "basic").demandRemaining).toBe(daily);
        expect(b.budgetRemaining).toBeLessThanOrEqual(def.dailyBudget);
      }
    }
  });
});

// ===========================================================================
// No unlimited repeat arbitrage (real Simulation)
// ===========================================================================

describe("ECO-001 no unlimited repeat arbitrage", () => {
  it("caps a buyer's cases per day at min(dailyDemand, floor(dailyBudget / price)) and rejects dispatches past it", { timeout: 60_000 }, () => {
    const roadhouse = CROSSROADS_ROADHOUSE;
    const def = buyerDef(roadhouse);
    const daily = wantDef(roadhouse, "basic").dailyDemand;
    const sim = newGame();

    // Enough stock for more than any day's cap, ready by the start of day 2.
    const maxCap = daily;
    expect(truck.capacityCases).toBeGreaterThanOrEqual(maxCap + 1);
    stockCases(sim, maxCap + 1);
    expect(sim.state.tick).toBeLessThan(2 * DAY);
    advanceTo(sim, 2 * DAY);

    const price = wantOf(sim.state, roadhouse, "basic").unitPrice;
    expect(buyerOf(sim.state, roadhouse).budgetRemaining).toBe(def.dailyBudget);
    expect(wantOf(sim.state, roadhouse, "basic").demandRemaining).toBe(daily);
    const cap = Math.min(daily, Math.floor(def.dailyBudget / price));
    expect(cap).toBeGreaterThan(0);

    expect(expectRejected(sim, sell(roadhouse, cap + 1, price), "BUYER_WILL_TAKE_LESS")).toEqual({
      code: "BUYER_WILL_TAKE_LESS",
      buyerId: roadhouse,
      requested: cap + 1,
      acceptable: cap,
    });

    const stockBefore = casesInStock(sim.state);
    expectApplied(sim.dispatch({ command: sell(roadhouse, cap, price) }));
    expect(casesInStock(sim.state)).toBe(stockBefore - cap);
    expect(buyerOf(sim.state, roadhouse).budgetRemaining).toBe(def.dailyBudget - cap * price);
    expect(buyerOf(sim.state, roadhouse).budgetRemaining).toBeGreaterThanOrEqual(0);

    // The truck comes back the same day; the buyer takes nothing more today.
    advanceUntil(sim, truckHome, 3 * DAY - sim.state.tick - 1);
    expect(sim.state.tick).toBeLessThan(3 * DAY);
    expect(casesInStock(sim.state)).toBe(stockBefore - cap);
    expect(expectRejected(sim, sell(roadhouse, 1, price), "BUYER_WILL_TAKE_LESS")).toMatchObject({ requested: 1, acceptable: 0 });
    expect(buyerOf(sim.state, roadhouse).budgetRemaining).toBeGreaterThanOrEqual(0);

    // Tomorrow, the market remembers today's sales: M_S drops below 1.0, never below 0.80.
    advanceTo(sim, 3 * DAY);
    const basicDef = marketDef(MOONSHINE, "basic");
    const m = marketOf(sim.state, MOONSHINE, "basic");
    expect(m.supply).toBe(basicDef.baselineSupply + cap);
    const [, mS] = priceInputs(m, basicDef);
    expect(mS).toBe(clampRatio(ratioOf(basicDef.baselineSupply, basicDef.baselineSupply + cap), ratio(M_DS_MIN), ratio(M_DS_MAX)));
    expect(mS).toBeLessThan(PPM);
    expect(mS).toBeGreaterThanOrEqual(M_DS_MIN);
  });

  it("selling every buyer's full demand every day keeps lowering the next day's M_S, never below 0.80", { timeout: 60_000 }, () => {
    let sim = newGame();
    for (let day = 1; day <= 5; day++) {
      advanceTo(sim, day * DAY - 1);
      // The day's buyers took everything they wanted.
      const soldOut: GameState = {
        ...sim.state,
        buyers: sim.state.buyers.map((b) => ({ ...b, wants: b.wants.map((w) => ({ ...w, demandRemaining: 0 })) })),
      };
      sim = simulationOf(soldOut);
      advanceTo(sim, day * DAY);
      for (const def of GAME_DATA.markets) {
        const sold = soldOut.buyers.reduce(
          (n, b) => n + buyerDef(b.id).wants.filter((w) => w.productId === def.productId && w.minimumQuality === def.quality).reduce((k, w) => k + w.dailyDemand, 0),
          0,
        );
        const m = marketOf(sim.state, def.productId, def.quality);
        expect(m.supply).toBe(def.baselineSupply + sold);
        const [, mS] = priceInputs(m, def);
        expect(mS).toBe(clampRatio(ratioOf(def.baselineSupply, def.baselineSupply + sold), ratio(M_DS_MIN), ratio(M_DS_MAX)));
        expect(mS).toBeGreaterThanOrEqual(M_DS_MIN);
        if (sold > 0) expect(mS).toBeLessThan(PPM);
        expect(m.spotPrice).toBe(formulaSpot(m));
      }
    }
  });
});

// ===========================================================================
// Spot sales through the coordinator (ADR 0005, ADR 0010)
// ===========================================================================

describe("ECO-001 spot sale end to end", () => {
  it("purchase → produce → dispatch → arrive: market side staged in DISPATCH and SALE, money recognized once", () => {
    const sim = newGame();
    const roadhouse = CROSSROADS_ROADHOUSE;

    // Purchase posts Dr RAW_MATERIALS / Cr CASH at the supplier's price.
    const input = recipe.inputsPerCase[0]!;
    const supplierId = supplierSelling(input.materialId);
    const unit = stockOf(sim.state, supplierId, input.materialId).unitPrice;
    const txCount = sim.state.ledger.transactions.length;
    expectApplied(sim.dispatch({ command: purchase(input.materialId, 4) }));
    const purchaseTxs = sim.state.ledger.transactions.slice(txCount);
    expect(purchaseTxs).toHaveLength(1);
    expect(purchaseTxs[0]!.kind).toBe("MATERIAL_PURCHASE");
    const cost = multiplyMoney(unit, 4);
    expect([...purchaseTxs[0]!.entries].sort((a, b) => byString(a.side + a.account, b.side + b.account))).toEqual([
      { account: "CASH", side: "CREDIT", amount: cost },
      { account: "RAW_MATERIALS", side: "DEBIT", amount: cost },
    ]);

    const cases = 2;
    stockCases(sim, cases);
    const quote = wantOf(sim.state, roadhouse, "basic").unitPrice;
    const buyerBefore = buyerOf(sim.state, roadhouse);
    const wantBefore = wantOf(sim.state, roadhouse, "basic");

    // A rejected dispatch changes nothing.
    expectRejected(sim, sell(roadhouse, cases, cents(quote + 1)), "QUOTE_CHANGED");

    const beforeDispatch = sim.state;
    const cashBefore = sideTotal(beforeDispatch.ledger.transactions, "CASH", "DEBIT") - sideTotal(beforeDispatch.ledger.transactions, "CASH", "CREDIT");
    expectApplied(sim.dispatch({ command: sell(roadhouse, cases, quote) }));
    const dispatchTxs = sim.state.ledger.transactions.slice(beforeDispatch.ledger.transactions.length);
    expect(dispatchTxs.map((t) => t.kind)).toEqual(["DISPATCH"]);
    const deliveryId = lastDeliveryId(sim.state);
    const amount = multiplyMoney(quote, cases);
    // quoteDeal + commitDeal inside DISPATCH: the deal is committed with the delivery.
    expect(buyerOf(sim.state, roadhouse).commitments).toEqual([{ deliveryId, productId: MOONSHINE, quantity: cases, amount }]);
    expect(buyerOf(sim.state, roadhouse).budgetRemaining).toBe(buyerBefore.budgetRemaining - amount);
    expect(wantOf(sim.state, roadhouse, "basic").demandRemaining).toBe(wantBefore.demandRemaining - cases);
    expect(casesInStock(sim.state)).toBe(casesInStock(beforeDispatch) - cases);
    const cargoCost = sideTotal(dispatchTxs, "GOODS_IN_TRANSIT", "DEBIT");

    advanceUntil(sim, (s) => s.deliveries.find((d) => d.id === deliveryId)?.status === "DELIVERED", DAY);
    expect(sim.state.tick).toBeLessThan(DAY);
    const afterArrival = sim.state;
    const saleTxs = afterArrival.ledger.transactions.filter((t) => t.kind === "SALE");
    expect(saleTxs).toHaveLength(1);
    expect(saleTxs[0]!.idempotencyKey).toBe(idempotencyKey("SALE", deliveryId));
    // settleDeal inside SALE: the commitment is gone, demand and budget stay spent.
    expect(buyerOf(afterArrival, roadhouse).commitments).toEqual([]);
    expect(buyerOf(afterArrival, roadhouse).budgetRemaining).toBe(buyerBefore.budgetRemaining - amount);
    expect(wantOf(afterArrival, roadhouse, "basic").demandRemaining).toBe(wantBefore.demandRemaining - cases);

    // Revenue and COGS recognized once, at the agreed price; cash in once.
    const all = afterArrival.ledger.transactions;
    expect(sideTotal(all, "SALES_REVENUE", "CREDIT")).toBe(amount);
    expect(sideTotal(all, "SALES_REVENUE", "DEBIT")).toBe(0);
    expect(sideTotal(all, "COST_OF_GOODS_SOLD", "DEBIT")).toBe(cargoCost);
    expect(sideTotal(saleTxs, "CASH", "DEBIT")).toBe(amount);
    const cashAfter = sideTotal(all, "CASH", "DEBIT") - sideTotal(all, "CASH", "CREDIT");
    expect(cashAfter - cashBefore).toBe(amount);
    expect(casesInStock(afterArrival)).toBe(casesInStock(beforeDispatch) - cases);
  });
});
