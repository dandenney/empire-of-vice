// The four GDD §13 headless strategies (T07b, issue #119). Each is the shared
// loop in `headless-strategy.ts` with its own priorities:
//
// - Volume Producer: basic moonshine only, at full-day runs. Buys the capacity
//   equipment (the condenser, then storage once storage would cap a run) and
//   takes only basic contracts, for the reputation the tiers need.
// - Quality Specialist: goes for the QC station first and standard moonshine.
//   It presses "buy" on the QC station before the unlock and is refused (LOCKED),
//   like a player would be; it earns the unlock through reputation and retries
//   only after a promotion. Takes basic contracts until it makes standard, then
//   standard contracts only.
// - Contract Operator: accepts every contract it can, fills installments first,
//   and spot-sells only the surplus (T05g's contract taker, with seeded variants).
// - Market Opportunist: reads the daily market report. It makes whichever recipe
//   pays the better margin at today's quotes, buys inputs ahead while no shortage
//   is on, holds stock when today's quote is below base or below cost (unless
//   storage is filling), routes around a closed road, and keeps to one contract
//   at a time so the truck stays free for the market.
//
// Strategy knobs here are choices about play, not gameplay numbers: every price,
// cost, and threshold comes from the snapshot or from game-data.

import type { ContractOfferSnapshot, EquipmentId, FacilitySnapshot, GameSnapshot, LocationId, ProductId, QualityTier } from "@eov/contracts";
import { GAME_DATA, IMPROVED_CONDENSER, QC_STATION, STORAGE_EXPANSION, type GameData, type RecipeDefinition } from "@eov/game-data";
import type { Gateway } from "./greedy-spot.ts";
import { periodCosts, planRun, supplyLines } from "./greedy-spot.ts";
import { HeadlessStrategy,type HeadlessStrategyName, type RouteChoice, type SpotOffer } from "./headless-strategy.ts";

const CONDENSER = IMPROVED_CONDENSER as EquipmentId;
const QC = QC_STATION as EquipmentId;
const STORAGE = STORAGE_EXPANSION as EquipmentId;

export class VolumeProducerStrategy extends HeadlessStrategy {
  readonly name = "volume-producer";

  constructor(first: GameSnapshot, seed: number, data: GameData = GAME_DATA) {
    super(first, seed, "volume-producer", { reserveHalfDays: [1, 3], runsPerDay: [1, 1], spotTolerancePpm: [0, 100_000] }, data);
  }

  protected upgradeIds(s: GameSnapshot, facility: FacilitySnapshot): readonly EquipmentId[] {
    // Storage only once it would cap a full run.
    const cramped = facility.storage.used + this.runSize(facility) > facility.storage.capacity;
    return cramped ? [CONDENSER, STORAGE] : [CONDENSER];
  }

  protected wantsOffer(offer: ContractOfferSnapshot): boolean {
    return offer.minimumQuality === this.basic.quality && offer.productId === this.basic.productId;
  }

  protected override recipeFor(): RecipeDefinition {
    return this.basic;
  }
}

export class QualitySpecialistStrategy extends HeadlessStrategy {
  readonly name = "quality-specialist";

  constructor(first: GameSnapshot, seed: number, data: GameData = GAME_DATA) {
    super(first, seed, "quality-specialist", { reserveHalfDays: [1, 2], runsPerDay: [1, 2], spotTolerancePpm: [0, 50_000] }, data);
  }

  protected upgradeIds(): readonly EquipmentId[] {
    return [QC, CONDENSER];
  }

  protected override probesLockedEquipment(): boolean {
    return true;
  }

  protected wantsOffer(offer: ContractOfferSnapshot, s: GameSnapshot): boolean {
    const target = this.owns(this.facility(s), this.standard) ? this.standard : this.basic;
    return offer.productId === target.productId && offer.minimumQuality === target.quality;
  }
}

export class ContractOperatorStrategy extends HeadlessStrategy {
  readonly name = "contract-operator";

  constructor(first: GameSnapshot, seed: number, data: GameData = GAME_DATA) {
    super(first, seed, "contract-operator", { reserveHalfDays: [2, 3], runsPerDay: [2, 2], spotTolerancePpm: [0, 30_000] }, data);
  }

  protected upgradeIds(): readonly EquipmentId[] {
    return [CONDENSER, QC];
  }

  protected wantsOffer(): boolean {
    return true;
  }
}

/** The opportunist keeps this many runs' worth of inputs on hand while no shortage is on. */
const OPPORTUNIST_BUFFER_RUNS = 2;
/** It holds stock back from a low or below-cost market only while storage is under this share full (ppm). */
const OPPORTUNIST_HOLD_BELOW_PPM = 500_000;

export class MarketOpportunistStrategy extends HeadlessStrategy {
  readonly name = "market-opportunist";

  constructor(first: GameSnapshot, seed: number, data: GameData = GAME_DATA) {
    super(first, seed, "market-opportunist", { reserveHalfDays: [1, 3], runsPerDay: [2, 3], spotTolerancePpm: [0, 150_000] }, data);
  }

  protected upgradeIds(): readonly EquipmentId[] {
    return [CONDENSER, QC];
  }

  /** One contract at a time, for a product it can make now. */
  protected wantsOffer(offer: ContractOfferSnapshot, s: GameSnapshot): boolean {
    if (s.contracts.active.length > 0) return false;
    const facility = this.facility(s);
    return [this.basic, this.standard].some((r) => this.owns(facility, r) && r.productId === offer.productId && r.quality === offer.minimumQuality);
  }

  /** The default route if it's open; otherwise the quickest open alternative, risk and all. */
  protected override routeTo(s: GameSnapshot, from: LocationId, to: LocationId): RouteChoice | null {
    const fallback = super.routeTo(s, from, to);
    if (fallback) return fallback;
    const open = s.routes
      .filter((r) => r.fromLocationId === from && r.toLocationId === to && r.status.open)
      .sort((a, b) => a.durationTicks - b.durationTicks || (a.id < b.id ? -1 : 1));
    return open[0] ? { routeId: open[0].id, route: open[0] } : null;
  }

  /** The best quote today for a product at a quality, from a buyer it can deal with. */
  #bestQuote(s: GameSnapshot, productId: ProductId, quality: QualityTier): number {
    let best = 0;
    for (const b of s.market.buyers) {
      if (!b.willDeal) continue;
      for (const w of b.wants) if (w.productId === productId && w.minimumQuality === quality && w.maxAcceptableQuantity > 0) best = Math.max(best, w.unitPrice);
    }
    return best;
  }

  /** Quote less today's unit cost (inputs at today's cheapest supplier price, plus labor and overhead). */
  #margin(s: GameSnapshot, recipe: RecipeDefinition): number {
    const lines = supplyLines(s);
    let cost = recipe.laborPerCase + recipe.overheadPerCase;
    for (const input of recipe.inputsPerCase) {
      const line = lines.get(input.materialId);
      if (!line) return Number.NEGATIVE_INFINITY;
      cost += input.quantity * line.unitPrice;
    }
    return this.#bestQuote(s, recipe.productId, recipe.quality) - cost;
  }

  protected override recipeFor(s: GameSnapshot, facility: FacilitySnapshot): RecipeDefinition {
    if (!this.owns(facility, this.standard)) return this.basic;
    if (this.basicNeedSoon(s, facility) > 0) return this.basic;
    const standardNeed = s.contracts.active.some((c) => c.productId === this.standard.productId && c.minimumQuality === this.standard.quality);
    if (standardNeed) return this.standard;
    return this.#margin(s, this.basic) > this.#margin(s, this.standard) ? this.basic : this.standard;
  }

  /** While no input is short, top inputs up to a buffer of runs, with cash to spare beyond the reserve. */
  protected override stockUp(sim: Gateway): void {
    const s = sim.snapshot();
    if (s.market.suppliers.some((sup) => sup.materials.some((m) => m.shortage))) return;
    const facility = this.facility(s);
    const recipe = this.recipeFor(s, facility);
    const running = s.productionJobs.some((j) => j.facilityId === this.facilityId);
    // An idle facility will draw one run now; the buffer is on top of it.
    const runs = OPPORTUNIST_BUFFER_RUNS + (running ? 0 : 1);
    const plan = planRun(s, facility, recipe, Math.max(1, this.runSize(facility) * runs));
    if (!plan || plan.purchases.length === 0) return;
    const inputCost = plan.purchases.reduce((n, p) => n + p.quantity * p.line.unitPrice, 0);
    if (s.finance.cash - inputCost < this.reserve(s, facility) + periodCosts(s, facility, this.data)) return;
    for (const p of plan.purchases) {
      const bought = this.send(sim, {
        type: "PURCHASE_MATERIALS",
        supplierId: p.line.supplierId,
        materialId: p.line.materialId,
        quantity: p.quantity,
        facilityId: facility.id,
      });
      if (bought === null) return;
    }
  }

  /** Hold stock while the market is low (below base) or the quote is below cost, unless storage is filling. */
  protected override acceptsSpot(offer: SpotOffer, s: GameSnapshot, facility: FacilitySnapshot): boolean {
    if (facility.storage.used * 1_000_000 >= facility.storage.capacity * OPPORTUNIST_HOLD_BELOW_PPM) return true;
    if (offer.unitPrice < offer.averageUnitCost) return false;
    const market = s.market.products.find((p) => p.productId === offer.productId && p.quality === offer.quality);
    return !market || market.spotPrice >= market.basePrice;
  }
}

export type HeadlessStrategyInstance = VolumeProducerStrategy | QualitySpecialistStrategy | ContractOperatorStrategy | MarketOpportunistStrategy;

/** A new strategy for one run. Its PRNG is derived from the run seed and its name. */
export function createHeadlessStrategy(name: HeadlessStrategyName, first: GameSnapshot, seed: number, data: GameData = GAME_DATA): HeadlessStrategyInstance {
  switch (name) {
    case "volume-producer":
      return new VolumeProducerStrategy(first, seed, data);
    case "quality-specialist":
      return new QualitySpecialistStrategy(first, seed, data);
    case "contract-operator":
      return new ContractOperatorStrategy(first, seed, data);
    case "market-opportunist":
      return new MarketOpportunistStrategy(first, seed, data);
  }
}
