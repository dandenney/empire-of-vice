// The shared loop of the four GDD §13 headless strategies (T07b, issue #119).
//
// Like T07a's greedy spot bot and T05g's contract taker, a headless strategy
// reads only the snapshot (plus static game-data definitions) and acts only
// through `dispatch` with ordinary commands. It never edits state, and it follows
// the same command and unlock rules as the player (GDD §13).
//
// Each decision point, in order (subclasses change the steps, not the order):
// 1. Accept the contract offers the strategy wants.
// 2. Upgrade, in the strategy's order, once cash covers the price plus a
//    working-capital reserve; then hire up to the facility's new crew.
// 3. Produce. If the distillery is idle, buy the missing inputs and start a run.
// 4. Deliver, if the truck is home: a contract installment that's due soon, or
//    else a spot sale of stock no contract needs.
//
// Choices a player could reasonably make either way (how much cash to hold back,
// how long a run is, which of several near-equal buyers to visit) come from a
// seeded PRNG derived from the run seed (`StrategyRng`), so seeds spread even
// where the simulation's own randomness doesn't.

import {
  qualityRank,
  QUALITY_TIERS,
  TICKS_PER_DAY,
  type BuyerId,
  type ContractOfferSnapshot,
  type ContractSnapshot,
  type EquipmentId,
  type FacilityId,
  type FacilitySnapshot,
  type GameCommand,
  type GameSnapshot,
  type LocationId,
  type Money,
  type ProductId,
  type QualityTier,
  type RecipeId,
  type RouteId,
  type RouteSnapshot,
  type TierId,
  type VehicleId,
} from "@eov/contracts";
import { BASIC_MOONSHINE_RECIPE, GAME_DATA, STANDARD_MOONSHINE_RECIPE, type GameData, type RecipeDefinition } from "@eov/game-data";
import { outstanding } from "./contract-taker.ts";
import { newStrategyLog, periodCosts, planRun, recipeOf, type Gateway, type RunPlan, type Strategy, type StrategyLog } from "./greedy-spot.ts";
import { StrategyRng } from "./prng.ts";

/** The four GDD §13 strategies, in the GDD's order. */
export const HEADLESS_STRATEGY_NAMES = ["volume-producer", "quality-specialist", "contract-operator", "market-opportunist"] as const;
export type HeadlessStrategyName = (typeof HEADLESS_STRATEGY_NAMES)[number];

/** Per-run choices drawn once from the strategy's PRNG. Not gameplay numbers. */
export interface Variant {
  /** Cash kept back when buying equipment: this many half-days of runs plus period costs. */
  readonly reserveHalfDays: number;
  /** A run is at most a day's capacity divided by this. */
  readonly runsPerDay: number;
  /** A spot offer whose revenue rate is within this share (ppm) of the best may be picked instead. */
  readonly spotTolerancePpm: number;
}

// A note on non-integer values (#122 review): `SpotOffer.rate`, the spot-tolerance
// floor in `spot()`, and `reserve()` may be fractional. They are decision values used
// only in comparisons, never stored or sent as money (every command carries integer
// cents from the snapshot), and IEEE arithmetic is deterministic, so runs replay
// exactly.

/** The range each variant field is drawn from, inclusive. */
export interface VariantRanges {
  readonly reserveHalfDays: readonly [number, number];
  readonly runsPerDay: readonly [number, number];
  readonly spotTolerancePpm: readonly [number, number];
}

const PPM = 1_000_000;

/** Stock is held back for installments due within this many ticks; later ones don't block spot sales yet. */
export const HOLD_TICKS = 2 * TICKS_PER_DAY;
/** Once the next unfilled deadline is this close: ship a partial load, and fill with a better quality than asked. */
export const URGENT_TICKS = TICKS_PER_DAY / 2;

/** The deadline of the first installment that still needs cases. */
export function nextDeadline(c: ContractSnapshot): number {
  return c.installments.find((i) => i.outcome === null && i.required - i.delivered - i.inTransit > 0)?.deadline ?? Number.MAX_SAFE_INTEGER;
}

export const qualitiesFrom = (minimum: QualityTier): readonly QualityTier[] => QUALITY_TIERS.filter((q) => qualityRank(q) >= qualityRank(minimum));

/**
 * The want a buyer prices a case at: the one with the highest minimum quality the case meets.
 * This is ADR 0016's documented rule ("a cargo line matches the buyer's most specific
 * want: the highest `minimumQuality` at or below the line's quality"); the snapshot's
 * `BuyerWant` doesn't say it, so the strategy applies it itself.
 */
export function pricingWant<W extends { readonly productId: ProductId; readonly minimumQuality: QualityTier }>(
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

/** A route to take: `routeId` null means the default (ADR 0019 decision 1). */
export interface RouteChoice {
  readonly routeId: RouteId | null;
  readonly route: RouteSnapshot;
}

/** One spot sale the truck could make now. */
export interface SpotOffer {
  readonly buyerId: BuyerId;
  readonly productId: ProductId;
  readonly quality: QualityTier;
  readonly unitPrice: Money;
  readonly quantity: number;
  readonly route: RouteChoice;
  /** Net revenue per tick of the round trip: one truck carries one buyer's one want per trip. */
  readonly rate: number;
  /** The pool's average unit cost, so a strategy can refuse to sell below cost. */
  readonly averageUnitCost: Money;
}

export abstract class HeadlessStrategy implements Strategy {
  abstract readonly name: HeadlessStrategyName;
  readonly takesContracts = true;
  readonly log: StrategyLog = newStrategyLog();
  readonly variant: Variant;
  protected readonly data: GameData;
  protected readonly rng: StrategyRng;
  protected readonly basic: RecipeDefinition;
  protected readonly standard: RecipeDefinition;
  protected readonly facilityId: FacilityId;
  protected readonly vehicleId: VehicleId;
  /** Equipment last refused as LOCKED, and the tier the family was at then. Retried only after a promotion. */
  readonly #lockedAt = new Map<EquipmentId, TierId>();

  protected constructor(first: GameSnapshot, seed: number, stream: HeadlessStrategyName, ranges: VariantRanges, data: GameData = GAME_DATA) {
    this.data = data;
    this.rng = new StrategyRng(seed, stream);
    this.variant = {
      reserveHalfDays: this.rng.between(...ranges.reserveHalfDays),
      runsPerDay: this.rng.between(...ranges.runsPerDay),
      spotTolerancePpm: this.rng.between(...ranges.spotTolerancePpm),
    };
    this.basic = recipeOf(data, BASIC_MOONSHINE_RECIPE as RecipeId);
    this.standard = recipeOf(data, STANDARD_MOONSHINE_RECIPE as RecipeId);
    const facility = first.facilities.find((f) => f.kind === "DISTILLERY" && f.recipes.some((r) => r.recipeId === this.basic.id));
    const vehicle = first.vehicles[0];
    if (!facility || !vehicle) throw new Error("Scenario has no distillery or no vehicle for the strategy");
    this.facilityId = facility.id;
    this.vehicleId = vehicle.id;
  }

  act(sim: Gateway): void {
    this.accept(sim);
    this.upgrade(sim);
    this.produce(sim);
    this.deliver(sim);
  }

  /** Installment deadlines (settlement moves reputation, tiers, and victory) and route reopenings. */
  wakeTicks(s: GameSnapshot): readonly number[] {
    const ticks: number[] = [];
    for (const c of s.contracts.active) for (const i of c.installments) if (i.outcome === null) ticks.push(i.deadline);
    for (const r of s.routes) if (!r.status.open && r.status.reopensAt !== null) ticks.push(r.status.reopensAt);
    return ticks;
  }

  // -------------------------------------------------------------------------
  // Hooks
  // -------------------------------------------------------------------------

  /** Equipment to buy, in order. The ladder stops at the first item not yet affordable. */
  protected abstract upgradeIds(s: GameSnapshot, facility: FacilitySnapshot): readonly EquipmentId[];

  /** Whether to accept an offer that isn't blocked. */
  protected abstract wantsOffer(offer: ContractOfferSnapshot, s: GameSnapshot): boolean;

  /**
   * Whether to try buying an item the snapshot says is LOCKED. A player can press
   * the button anyway; the simulation refuses it with LOCKED. Off by default.
   */
  protected probesLockedEquipment(): boolean {
    return false;
  }

  /** The recipe for the next run. Default: standard once owned, unless a basic contract needs cases soon. */
  protected recipeFor(s: GameSnapshot, facility: FacilitySnapshot): RecipeDefinition {
    if (!this.owns(facility, this.standard)) return this.basic;
    return this.basicNeedSoon(s, facility) > 0 ? this.basic : this.standard;
  }

  /** The largest run to start now, before cash and supplier limits. */
  protected runSize(facility: FacilitySnapshot): number {
    return Math.ceil(facility.productionCapacityPerDay / this.variant.runsPerDay);
  }

  /** Called before production, if defined: a chance to buy inputs ahead. */
  protected stockUp?(sim: Gateway): void;

  /** The route to a buyer's location, or null to skip the buyer for now. Default: the default route, if open. */
  protected routeTo(s: GameSnapshot, from: LocationId, to: LocationId): RouteChoice | null {
    const route = this.defaultRoute(s, from, to);
    return route && route.status.open ? { routeId: null, route } : null;
  }

  /** Whether to make a spot sale, if defined. Without it, any offer with a positive rate goes. */
  protected acceptsSpot?(offer: SpotOffer, s: GameSnapshot, facility: FacilitySnapshot): boolean;

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  protected facility(s: GameSnapshot): FacilitySnapshot {
    const facility = s.facilities.find((f) => f.id === this.facilityId);
    if (!facility) throw new Error(`Facility ${this.facilityId} disappeared from the snapshot`);
    return facility;
  }

  /** Dispatches one command. Returns the tick it applied at, or null if it was rejected (counted in the log). */
  protected send(sim: Gateway, command: GameCommand): number | null {
    const result = sim.dispatch({ command });
    if (result.status === "rejected") {
      const code = result.reason.code;
      this.log.rejections[code] = (this.log.rejections[code] ?? 0) + 1;
      return null;
    }
    return result.status === "applied" ? result.tick : result.scheduledTick;
  }

  protected owns(facility: FacilitySnapshot, recipe: RecipeDefinition): boolean {
    return recipe.requiredEquipmentIds.every((id) => facility.equipment.some((e) => e.id === id));
  }

  /** The default route (the first listed in game-data) between two locations, as the snapshot shows it now. */
  protected defaultRoute(s: GameSnapshot, from: LocationId, to: LocationId): RouteSnapshot | null {
    const def = this.data.routes.find((r) => r.fromLocationId === from && r.toLocationId === to);
    return def ? (s.routes.find((r) => r.id === def.id) ?? null) : null;
  }

  /** Basic cases that basic contracts need within the hold window, beyond the basic stock on hand. */
  protected basicNeedSoon(s: GameSnapshot, facility: FacilitySnapshot): number {
    const soon = s.clock.tick + HOLD_TICKS;
    const need = s.contracts.active
      .filter((c) => c.productId === this.basic.productId && c.minimumQuality === this.basic.quality)
      .reduce((n, c) => n + outstanding(c, soon), 0);
    const stock = facility.products.find((p) => p.productId === this.basic.productId && p.quality === this.basic.quality)?.quantity ?? 0;
    return Math.max(0, need - stock);
  }

  /** Cash kept back for working capital: reserveHalfDays half-days of a full-capacity run plus tonight's costs. */
  protected reserve(s: GameSnapshot, facility: FacilitySnapshot): number {
    const recipe = this.recipeFor(s, facility);
    const dayRun = planRun(s, facility, recipe, Math.max(1, facility.productionCapacityPerDay));
    return (this.variant.reserveHalfDays * ((dayRun?.cashCost ?? 0) + periodCosts(s, facility, this.data))) / 2;
  }

  // -------------------------------------------------------------------------
  // Steps
  // -------------------------------------------------------------------------

  protected accept(sim: Gateway): void {
    for (const offer of sim.snapshot().contracts.offers) {
      if (offer.blockedBy !== null || !this.wantsOffer(offer, sim.snapshot())) continue;
      if (this.send(sim, { type: "ACCEPT_CONTRACT", contractOfferId: offer.id }) !== null) this.log.contractsAccepted++;
    }
  }

  protected upgrade(sim: Gateway): void {
    for (const id of this.upgradeIds(sim.snapshot(), this.facility(sim.snapshot()))) {
      const s = sim.snapshot();
      const facility = this.facility(s);
      if (facility.equipment.some((e) => e.id === id)) continue;
      const option = facility.equipmentOptions.find((e) => e.equipmentId === id);
      if (!option) return;
      if (option.blockedBy !== null) {
        const locked = option.blockedBy.code === "LOCKED";
        if (!locked || !this.probesLockedEquipment() || this.#lockedAt.get(id) === s.progression.currentTierId) return;
      }
      if (s.finance.cash < option.price + this.reserve(s, facility)) return;
      const result = sim.dispatch({ command: { type: "PURCHASE_EQUIPMENT", facilityId: facility.id, equipmentId: id } });
      if (result.status === "rejected") {
        this.log.rejections[result.reason.code] = (this.log.rejections[result.reason.code] ?? 0) + 1;
        if (result.reason.code === "LOCKED") this.#lockedAt.set(id, s.progression.currentTierId);
        return;
      }
      const bought = result.status === "applied" ? result.tick : result.scheduledTick;
      if (this.isQualityEquipment(id)) this.log.qualityUpgradeBoughtAt ??= bought;
      else this.log.upgradeBoughtAt ??= bought;

      // Staff the new crew: Σ crew of what the facility now owns, within its maximum.
      const owned = new Set([...facility.equipment.map((e) => e.id), id]);
      const crew = this.data.equipment.filter((e) => owned.has(e.id)).reduce((n, e) => n + e.crew, 0);
      const target = Math.min(crew, facility.workforce.maximum);
      if (target > facility.workforce.workers) this.send(sim, { type: "SET_WORKFORCE", facilityId: facility.id, workerCount: target });
    }
  }

  /** Equipment a standard-quality recipe needs. */
  protected isQualityEquipment(id: EquipmentId): boolean {
    return this.standard.requiredEquipmentIds.includes(id) && !this.basic.requiredEquipmentIds.includes(id);
  }

  protected produce(sim: Gateway): void {
    this.stockUp?.(sim);
    const s = sim.snapshot();
    if (s.productionJobs.some((j) => j.facilityId === this.facilityId)) return;
    const facility = this.facility(s);
    const recipe = this.recipeFor(s, facility);
    const run = this.runSize(facility);
    const room = facility.storage.capacity - facility.storage.used;
    let quantity = Math.min(run, room);
    if (quantity <= 0) {
      if (run > 0) this.log.productionCaps.STORAGE++;
      return;
    }
    if (quantity < run) this.log.productionCaps.STORAGE++;

    // Largest run the suppliers and cash cover, keeping tonight's wages and overhead.
    const budget = s.finance.cash - periodCosts(s, facility, this.data);
    let plan: RunPlan | null = null;
    let capped: "CASH" | "SUPPLIER" | null = null;
    for (; quantity > 0; quantity--) {
      const candidate = planRun(s, facility, recipe, quantity);
      if (!candidate) {
        capped ??= "SUPPLIER";
        continue;
      }
      if (candidate.cashCost > budget) {
        capped ??= "CASH";
        continue;
      }
      plan = candidate;
      break;
    }
    if (capped) this.log.productionCaps[capped]++;
    if (!plan) return;
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
    this.send(sim, { type: "START_PRODUCTION", facilityId: facility.id, recipeId: recipe.id, quantity: plan.quantity });
  }

  protected deliver(sim: Gateway): void {
    const s = sim.snapshot();
    const vehicle = s.vehicles.find((v) => v.id === this.vehicleId);
    if (!vehicle || vehicle.trip !== null) return;
    if (this.installment(sim, s, vehicle.capacity)) return;
    this.spot(sim, s, vehicle.capacity);
  }

  /** Ships one installment load if there is one worth sending. Returns whether the truck left. */
  protected installment(sim: Gateway, s: GameSnapshot, capacity: number): boolean {
    const facility = this.facility(s);
    const now = s.clock.tick;
    const contracts = [...s.contracts.active].sort((a, b) => nextDeadline(a) - nextDeadline(b));
    for (const c of contracts) {
      // Ship once installments are due soon; a load may run ahead to later ones (they're credited in order).
      const soon = outstanding(c, now + HOLD_TICKS);
      if (soon <= 0) continue;
      const buyer = s.market.buyers.find((b) => b.id === c.buyerId);
      const route = buyer ? this.routeTo(s, facility.locationId, buyer.locationId) : null;
      if (!route) continue;
      const urgent = nextDeadline(c) - now <= URGENT_TICKS;
      for (const quality of urgent ? qualitiesFrom(c.minimumQuality) : [c.minimumQuality]) {
        const pool = facility.products.find((p) => p.productId === c.productId && p.quality === quality);
        if (!pool) continue;
        const own = Math.min(pool.reservedQuantity, c.reservedQuantity);
        const available = pool.quantity - pool.reservedQuantity + own;
        const quantity = Math.min(outstanding(c), available, capacity);
        if (quantity <= 0) continue;
        if (quantity < Math.min(soon, capacity) && !urgent) break;
        const dispatch = (n: number): GameCommand => ({
          type: "DISPATCH_DELIVERY",
          vehicleId: this.vehicleId,
          cargo: [{ productId: c.productId, quality, quantity: n }],
          purpose: { kind: "CONTRACT_INSTALLMENT", contractId: c.id },
          routeId: route.routeId,
        });
        const result = sim.dispatch({ command: dispatch(quantity) });
        if (result.status !== "rejected") return true;
        // Another contract's reservation at this quality: retry with what this one may draw.
        if (result.reason.code === "INSUFFICIENT_STOCK" && result.reason.available > 0 && this.send(sim, dispatch(result.reason.available)) !== null) return true;
        if (result.reason.code !== "INSUFFICIENT_STOCK") this.log.rejections[result.reason.code] = (this.log.rejections[result.reason.code] ?? 0) + 1;
      }
    }
    return false;
  }

  /**
   * Unreserved stock by quality, less what installments due soon still need beyond
   * their reservations: held at the contract's own quality, or at any acceptable
   * quality once its deadline is urgent.
   */
  protected free(s: GameSnapshot, facility: FacilitySnapshot): Map<string, number> {
    const now = s.clock.tick;
    const free = new Map<string, number>();
    for (const p of facility.products) free.set(`${p.productId}/${p.quality}`, p.quantity - p.reservedQuantity);
    for (const c of s.contracts.active) {
      let held = Math.max(0, outstanding(c, now + HOLD_TICKS) - c.reservedQuantity);
      const urgent = nextDeadline(c) - now <= URGENT_TICKS;
      for (const quality of urgent ? qualitiesFrom(c.minimumQuality) : [c.minimumQuality]) {
        const key = `${c.productId}/${quality}`;
        const take = Math.min(held, free.get(key) ?? 0);
        if (take > 0) free.set(key, free.get(key)! - take);
        held -= take;
      }
    }
    return free;
  }

  /** Every spot sale the truck could make now, from stock no contract needs. */
  protected spotOffers(s: GameSnapshot, facility: FacilitySnapshot, capacity: number): SpotOffer[] {
    const free = this.free(s, facility);
    const offers: SpotOffer[] = [];
    if (![...free.values()].some((n) => n > 0)) return offers;
    for (const buyer of s.market.buyers) {
      if (!buyer.willDeal) continue;
      const route = this.routeTo(s, facility.locationId, buyer.locationId);
      if (!route) continue;
      for (const want of buyer.wants) {
        if (want.maxAcceptableQuantity <= 0) continue;
        // The lowest quality in stock that this want prices. A buyer prices a case at its
        // want with the highest minimum quality the case meets, so a better case may
        // belong to another of its wants, at that want's quote.
        const quality = qualitiesFrom(want.minimumQuality).find(
          (q) => (free.get(`${want.productId}/${q}`) ?? 0) > 0 && pricingWant(buyer.wants, want.productId, q) === want,
        );
        if (!quality) continue;
        const quantity = Math.min(free.get(`${want.productId}/${quality}`)!, capacity, want.maxAcceptableQuantity);
        const pool = facility.products.find((p) => p.productId === want.productId && p.quality === quality);
        offers.push({
          buyerId: buyer.id,
          productId: want.productId,
          quality,
          unitPrice: want.unitPrice,
          quantity,
          route,
          rate: (quantity * want.unitPrice - route.route.transportCost) / (2 * route.route.durationTicks),
          averageUnitCost: pool?.averageUnitCost ?? (0 as Money),
        });
      }
    }
    return offers;
  }

  /**
   * Sends the truck on the best spot sale. Offers within the variant's tolerance
   * of the best rate are near enough equal that a player could pick any of them,
   * so one is drawn from the strategy's PRNG.
   */
  protected spot(sim: Gateway, s: GameSnapshot, capacity: number): void {
    const facility = this.facility(s);
    const offers = this.spotOffers(s, facility, capacity).filter((o) => o.rate > 0 && (this.acceptsSpot?.(o, s, facility) ?? true));
    if (offers.length === 0) {
      this.log.saleCaps.NO_BUYER++;
      return;
    }
    offers.sort((a, b) => b.rate - a.rate || (a.buyerId < b.buyerId ? -1 : a.buyerId > b.buyerId ? 1 : 0) || qualityRank(a.quality) - qualityRank(b.quality));
    const floor = offers[0]!.rate * (1 - this.variant.spotTolerancePpm / PPM);
    const best = this.rng.pick(offers.filter((o) => o.rate >= floor));
    const sent = this.send(sim, {
      type: "DISPATCH_DELIVERY",
      vehicleId: this.vehicleId,
      cargo: [{ productId: best.productId, quality: best.quality, quantity: best.quantity }],
      purpose: { kind: "SALE", buyerId: best.buyerId, agreedUnitPrice: best.unitPrice },
      routeId: best.route.routeId,
    });
    if (sent !== null) this.log.saleCaps[best.quantity === capacity ? "TRUCK" : "STOCK"]++;
  }
}
