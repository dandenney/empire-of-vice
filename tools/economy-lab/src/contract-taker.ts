// The contract-taking strategy (T05g, issue #106; ADR 0020 decision 15): the
// greedy spot seller, plus contracts and the upgrade ladder.
//
// The greedy spot bot never takes a contract, so it can't earn the reputation
// tier 2 needs and can't win. This variant is the M001 feasibility check: like
// the greedy bot it reads only the snapshot and acts only through `dispatch`.
// Every gameplay number it uses comes from the snapshot or from game-data; the
// only numbers here are the strategy's own choices (CONTRACT_STRATEGY).
//
// Each decision point, in order:
// 1. Accept every contract offer it can.
// 2. Upgrade, in order: the improved condenser (tier 2), then the QC station
//    (tier 3), each once cash covers its price plus a working-capital reserve.
//    After the condenser it hires up to the facility's new crew.
// 3. Produce. If the distillery is idle, start a run of up to half a day's
//    capacity. The recipe is standard moonshine once the QC station is owned,
//    unless a basic contract still needs cases the basic stock doesn't cover.
// 4. Deliver, if the truck is home: contract installments first (earliest
//    deadline first, lowest acceptable quality), then spot sales of the stock no
//    contract needs (best quote first).

import {
  qualityRank,
  QUALITY_TIERS,
  TICKS_PER_DAY,
  type BuyerId,
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
  type VehicleId,
} from "@eov/contracts";
import {
  BASIC_MOONSHINE_RECIPE,
  GAME_DATA,
  IMPROVED_CONDENSER,
  QC_STATION,
  STANDARD_MOONSHINE_RECIPE,
  type GameData,
  type RecipeDefinition,
} from "@eov/game-data";
import {
  newStrategyLog,
  periodCosts,
  planRun,
  recipeOf,
  type Gateway,
  type RunPlan,
  type SaleCap,
  type Strategy,
  type StrategyLog,
} from "./greedy-spot.ts";

/** The strategy's own knobs. Not gameplay numbers: they describe how this bot plays. */
export const CONTRACT_STRATEGY = {
  name: "contract-taker",
  basicRecipeId: BASIC_MOONSHINE_RECIPE as RecipeId,
  standardRecipeId: STANDARD_MOONSHINE_RECIPE as RecipeId,
  /** Bought in this order: capacity at tier 2, then quality at tier 3. */
  upgradeIds: [IMPROVED_CONDENSER, QC_STATION] as readonly EquipmentId[],
  /** Cash kept back when buying an upgrade: this many days of runs plus period costs. */
  upgradeReserveDays: 1,
  /** A run is at most a day's capacity divided by this, so the bot can switch recipes soon after an upgrade. */
  runsPerDay: 2,
  /** Stock is held back for installments due within this many ticks; later ones don't block spot sales yet. */
  holdTicks: 2 * TICKS_PER_DAY,
  /**
   * Once the next unfilled deadline is this close, in ticks: ship a partial load
   * anyway, and fill a contract with a better quality than it asks for.
   */
  urgentTicks: TICKS_PER_DAY / 2,
} as const;

/** Cases a contract still needs for installments due by `until`: required, less delivered and in transit. */
export function outstanding(c: ContractSnapshot, until: number = Number.MAX_SAFE_INTEGER): number {
  return c.installments
    .filter((i) => i.outcome === null && i.deadline <= until)
    .reduce((n, i) => n + Math.max(0, i.required - i.delivered - i.inTransit), 0);
}

/** The deadline of the first installment that still needs cases. */
function nextDeadline(c: ContractSnapshot): number {
  return c.installments.find((i) => i.outcome === null && i.required - i.delivered - i.inTransit > 0)?.deadline ?? Number.MAX_SAFE_INTEGER;
}

const qualitiesFrom = (minimum: QualityTier): readonly QualityTier[] => QUALITY_TIERS.filter((q) => qualityRank(q) >= qualityRank(minimum));

export class ContractTakerStrategy implements Strategy {
  readonly name = CONTRACT_STRATEGY.name;
  readonly takesContracts = true;
  readonly log: StrategyLog = newStrategyLog();
  readonly #data: GameData;
  readonly #basic: RecipeDefinition;
  readonly #standard: RecipeDefinition;
  readonly #facilityId: FacilityId;
  readonly #vehicleId: VehicleId;

  constructor(first: GameSnapshot, data: GameData = GAME_DATA) {
    this.#data = data;
    this.#basic = recipeOf(data, CONTRACT_STRATEGY.basicRecipeId);
    this.#standard = recipeOf(data, CONTRACT_STRATEGY.standardRecipeId);
    const facility = first.facilities.find((f) => f.recipes.some((r) => r.recipeId === this.#basic.id) && f.kind === "DISTILLERY");
    const vehicle = first.vehicles[0];
    if (!facility || !vehicle) throw new Error("Scenario has no distillery or no vehicle for the strategy");
    this.#facilityId = facility.id;
    this.#vehicleId = vehicle.id;
  }

  act(sim: Gateway): void {
    this.#accept(sim);
    this.#upgrade(sim);
    this.#produce(sim);
    this.#deliver(sim);
  }

  /** Installment deadlines (settlement can promote a tier) and route reopenings. */
  wakeTicks(s: GameSnapshot): readonly number[] {
    const ticks: number[] = [];
    for (const c of s.contracts.active) for (const i of c.installments) if (i.outcome === null) ticks.push(i.deadline);
    for (const r of s.routes) if (!r.status.open && r.status.reopensAt !== null) ticks.push(r.status.reopensAt);
    return ticks;
  }

  #facility(s: GameSnapshot): FacilitySnapshot {
    const facility = s.facilities.find((f) => f.id === this.#facilityId);
    if (!facility) throw new Error(`Facility ${this.#facilityId} disappeared from the snapshot`);
    return facility;
  }

  #send(sim: Gateway, command: GameCommand): number | null {
    const result = sim.dispatch({ command });
    if (result.status === "rejected") {
      const code = result.reason.code;
      this.log.rejections[code] = (this.log.rejections[code] ?? 0) + 1;
      return null;
    }
    return result.status === "applied" ? result.tick : result.scheduledTick;
  }

  #accept(sim: Gateway): void {
    for (const offer of sim.snapshot().contracts.offers) {
      if (offer.blockedBy !== null) continue;
      if (this.#send(sim, { type: "ACCEPT_CONTRACT", contractOfferId: offer.id }) !== null) this.log.contractsAccepted++;
    }
  }

  #owns(facility: FacilitySnapshot, recipe: RecipeDefinition): boolean {
    return recipe.requiredEquipmentIds.every((id) => facility.equipment.some((e) => e.id === id));
  }

  #upgrade(sim: Gateway): void {
    for (const id of CONTRACT_STRATEGY.upgradeIds) {
      const s = sim.snapshot();
      const facility = this.#facility(s);
      if (facility.equipment.some((e) => e.id === id)) continue;
      const option = facility.equipmentOptions.find((e) => e.equipmentId === id);
      if (!option || option.blockedBy !== null) return;
      const recipe = this.#recipeFor(s, facility);
      const dayRun = planRun(s, facility, recipe, Math.max(1, facility.productionCapacityPerDay));
      const reserve = CONTRACT_STRATEGY.upgradeReserveDays * ((dayRun?.cashCost ?? 0) + periodCosts(s, facility, this.#data));
      if (s.finance.cash < option.price + reserve) return;
      const bought = this.#send(sim, { type: "PURCHASE_EQUIPMENT", facilityId: facility.id, equipmentId: id });
      if (bought === null) return;
      if (id === QC_STATION) this.log.qualityUpgradeBoughtAt = bought;
      else this.log.upgradeBoughtAt ??= bought;

      const owned = new Set([...facility.equipment.map((e) => e.id), id]);
      const crew = this.#data.equipment.filter((e) => owned.has(e.id)).reduce((n, e) => n + e.crew, 0);
      const target = Math.min(crew, facility.workforce.maximum);
      if (target > facility.workforce.workers) this.#send(sim, { type: "SET_WORKFORCE", facilityId: facility.id, workerCount: target });
    }
  }

  /** Standard once the QC station is owned, unless a basic contract soon needs cases the basic stock doesn't cover. */
  #recipeFor(s: GameSnapshot, facility: FacilitySnapshot): RecipeDefinition {
    if (!this.#owns(facility, this.#standard)) return this.#basic;
    const soon = s.clock.tick + CONTRACT_STRATEGY.holdTicks;
    const basicNeed = s.contracts.active
      .filter((c) => c.productId === this.#basic.productId && c.minimumQuality === this.#basic.quality)
      .reduce((n, c) => n + outstanding(c, soon), 0);
    const basicStock = facility.products.find((p) => p.productId === this.#basic.productId && p.quality === this.#basic.quality)?.quantity ?? 0;
    return basicNeed > basicStock ? this.#basic : this.#standard;
  }

  #produce(sim: Gateway): void {
    const s = sim.snapshot();
    if (s.productionJobs.some((j) => j.facilityId === this.#facilityId)) return;
    const facility = this.#facility(s);
    const recipe = this.#recipeFor(s, facility);
    const run = Math.ceil(facility.productionCapacityPerDay / CONTRACT_STRATEGY.runsPerDay);
    const room = facility.storage.capacity - facility.storage.used;
    let quantity = Math.min(run, room);
    if (quantity <= 0) {
      if (run > 0) this.log.productionCaps.STORAGE++;
      return;
    }
    if (quantity < run) this.log.productionCaps.STORAGE++;

    const budget = s.finance.cash - periodCosts(s, facility, this.#data);
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
      const bought = this.#send(sim, {
        type: "PURCHASE_MATERIALS",
        supplierId: p.line.supplierId,
        materialId: p.line.materialId,
        quantity: p.quantity,
        facilityId: facility.id,
      });
      if (bought === null) return;
    }
    this.#send(sim, { type: "START_PRODUCTION", facilityId: facility.id, recipeId: recipe.id, quantity: plan.quantity });
  }

  /** Whether the default route (the first listed) from the facility to a location is open. */
  #routeOpen(s: GameSnapshot, from: LocationId, to: LocationId): boolean {
    const route = this.#data.routes.find((r) => r.fromLocationId === from && r.toLocationId === to);
    return !route || s.routes.find((r) => r.id === route.id)?.status.open !== false;
  }

  #deliver(sim: Gateway): void {
    const s = sim.snapshot();
    const vehicle = s.vehicles.find((v) => v.id === this.#vehicleId);
    if (!vehicle || vehicle.trip !== null) return;
    if (this.#installment(sim, s, vehicle.capacity)) return;
    this.#spot(sim, s, vehicle.capacity);
  }

  /** Ships one installment load if there is one worth sending. Returns whether the truck left. */
  #installment(sim: Gateway, s: GameSnapshot, capacity: number): boolean {
    const facility = this.#facility(s);
    const now = s.clock.tick;
    const contracts = [...s.contracts.active].sort((a, b) => nextDeadline(a) - nextDeadline(b));
    for (const c of contracts) {
      // Ship once installments are due soon; a load may run ahead to later ones (they're credited in order).
      const soon = outstanding(c, now + CONTRACT_STRATEGY.holdTicks);
      if (soon <= 0) continue;
      const buyer = s.market.buyers.find((b) => b.id === c.buyerId);
      if (!buyer || !this.#routeOpen(s, facility.locationId, buyer.locationId)) continue;
      const urgent = nextDeadline(c) - now <= CONTRACT_STRATEGY.urgentTicks;
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
          vehicleId: this.#vehicleId,
          cargo: [{ productId: c.productId, quality, quantity: n }],
          purpose: { kind: "CONTRACT_INSTALLMENT", contractId: c.id },
          routeId: null,
        });
        const result = sim.dispatch({ command: dispatch(quantity) });
        if (result.status !== "rejected") return true;
        // Another contract's reservation at this quality: retry with what this one may draw.
        if (result.reason.code === "INSUFFICIENT_STOCK" && result.reason.available > 0 && this.#send(sim, dispatch(result.reason.available)) !== null) return true;
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
  #free(s: GameSnapshot, facility: FacilitySnapshot): Map<string, number> {
    const now = s.clock.tick;
    const free = new Map<string, number>();
    for (const p of facility.products) free.set(`${p.productId}/${p.quality}`, p.quantity - p.reservedQuantity);
    for (const c of s.contracts.active) {
      let held = Math.max(0, outstanding(c, now + CONTRACT_STRATEGY.holdTicks) - c.reservedQuantity);
      const urgent = nextDeadline(c) - now <= CONTRACT_STRATEGY.urgentTicks;
      for (const quality of urgent ? qualitiesFrom(c.minimumQuality) : [c.minimumQuality]) {
        const key = `${c.productId}/${quality}`;
        const take = Math.min(held, free.get(key) ?? 0);
        if (take > 0) free.set(key, free.get(key)! - take);
        held -= take;
      }
    }
    return free;
  }

  #spot(sim: Gateway, s: GameSnapshot, capacity: number): void {
    const facility = this.#facility(s);
    const free = this.#free(s, facility);
    if (![...free.values()].some((n) => n > 0)) return;
    const offers: {
      buyerId: BuyerId;
      quality: QualityTier;
      productId: ProductId;
      unitPrice: Money;
      stock: number;
      acceptable: number;
      demand: number;
      quantity: number;
      /** Revenue per tick of the round trip: one truck carries one buyer's one want per trip. */
      rate: number;
    }[] = [];
    for (const buyer of s.market.buyers) {
      if (!buyer.willDeal || !this.#routeOpen(s, facility.locationId, buyer.locationId)) continue;
      const route = this.#data.routes.find((r) => r.fromLocationId === facility.locationId && r.toLocationId === buyer.locationId);
      if (!route) continue;
      for (const want of buyer.wants) {
        if (want.maxAcceptableQuantity <= 0) continue;
        // The lowest quality in stock that meets the want.
        const quality = qualitiesFrom(want.minimumQuality).find((q) => (free.get(`${want.productId}/${q}`) ?? 0) > 0);
        if (!quality) continue;
        const stock = free.get(`${want.productId}/${quality}`)!;
        const quantity = Math.min(stock, capacity, want.maxAcceptableQuantity);
        offers.push({
          buyerId: buyer.id,
          quality,
          productId: want.productId,
          unitPrice: want.unitPrice,
          stock,
          acceptable: want.maxAcceptableQuantity,
          demand: want.demandRemaining,
          quantity,
          rate: (quantity * want.unitPrice) / (2 * route.durationTicks),
        });
      }
    }
    offers.sort((a, b) => b.rate - a.rate || (a.buyerId < b.buyerId ? -1 : a.buyerId > b.buyerId ? 1 : 0));
    const best = offers[0];
    if (!best) {
      this.log.saleCaps.NO_BUYER++;
      return;
    }
    const quantity = best.quantity;
    const cap: SaleCap =
      quantity === best.stock ? "STOCK" : quantity === capacity ? "TRUCK" : best.acceptable < best.demand ? "BUDGET" : "DEMAND";
    const sent = this.#send(sim, {
      type: "DISPATCH_DELIVERY",
      vehicleId: this.#vehicleId,
      cargo: [{ productId: best.productId, quality: best.quality, quantity }],
      purpose: { kind: "SALE", buyerId: best.buyerId, agreedUnitPrice: best.unitPrice },
      routeId: null,
    });
    if (sent !== null) this.log.saleCaps[cap]++;
  }
}
