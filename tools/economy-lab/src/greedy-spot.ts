// The greedy spot-sale strategy (T07a, issue #12): one headless player that runs
// buy → produce → sell as fast as cash, stock, and buyers allow.
//
// It reads the same read-only snapshot the UI renders and acts only through
// `dispatch`, the player's command gateway. It never edits state. Every gameplay
// number it uses (prices, costs, wages, crews) comes from the snapshot or from
// game-data; the only numbers here are the strategy's own choices (STRATEGY).
//
// Each decision point, in order:
// 1. Upgrade. If the improved condenser is buyable and cash covers its price plus
//    a working-capital reserve, buy it and hire up to the facility's new crew.
// 2. Produce. If the distillery is idle, buy the missing ingredients for one
//    day's run (capped by storage, supplier stock, and cash), then start it.
// 3. Sell. If the truck is home with cases in stock, send as many as the
//    best-paying buyer will take today (highest quote first) at the current quote.

import type {
  BuyerId,
  CommandResult,
  EquipmentId,
  FacilityId,
  FacilitySnapshot,
  GameCommand,
  GameSnapshot,
  MaterialId,
  Money,
  RecipeId,
  RejectionCode,
  SupplierId,
  VehicleId,
} from "@eov/contracts";
import { BASIC_MOONSHINE_RECIPE, GAME_DATA, IMPROVED_CONDENSER, type GameData, type RecipeDefinition } from "@eov/game-data";

/** The strategy's own knobs. Not gameplay numbers: they describe how this bot plays. */
export const STRATEGY = {
  name: "greedy-spot",
  recipeId: BASIC_MOONSHINE_RECIPE as RecipeId,
  /** The one upgrade the bot buys: the only equipment that raises basic throughput. */
  upgradeId: IMPROVED_CONDENSER as EquipmentId,
  /** Cash kept back when buying the upgrade: this many days of runs plus period costs. */
  upgradeReserveDays: 1,
} as const;

/** What capped a sale's quantity. */
export type SaleCap = "BUDGET" | "DEMAND" | "STOCK" | "TRUCK";

/** Decision points with the truck home and cases in stock but no buyer taking any today. */
export type NoSale = "NO_BUYER";

/** Facts the runner records about the bot's own decisions. */
export interface StrategyLog {
  /** When the bot bought its first upgrade (the improved condenser). */
  upgradeBoughtAt: number | null;
  /** When the bot bought the QC station. Only the contract-taking variant buys it. */
  qualityUpgradeBoughtAt: number | null;
  /** Contract offers accepted. */
  contractsAccepted: number;
  readonly saleCaps: Record<SaleCap | NoSale, number>;
  /** Production starts held back below one day's run, by cause. */
  readonly productionCaps: Record<"CASH" | "STORAGE" | "SUPPLIER", number>;
  /** Dispatch-time rejections, by code. The bot shouldn't hit any. */
  readonly rejections: Partial<Record<RejectionCode, number>>;
}

export function newStrategyLog(): StrategyLog {
  return {
    upgradeBoughtAt: null,
    qualityUpgradeBoughtAt: null,
    contractsAccepted: 0,
    saleCaps: { BUDGET: 0, DEMAND: 0, STOCK: 0, TRUCK: 0, NO_BUYER: 0 },
    productionCaps: { CASH: 0, STORAGE: 0, SUPPLIER: 0 },
    rejections: {},
  };
}

/** The command gateway: `Simulation.dispatch` and `snapshot`, nothing else. */
export interface Gateway {
  dispatch(request: { readonly command: GameCommand }): CommandResult;
  snapshot(): GameSnapshot;
}

/** A headless player the smoke runner can drive. */
export interface Strategy {
  readonly name: string;
  /**
   * Whether it takes contracts. One that doesn't can't earn the reputation tier 2
   * needs (ADR 0020 decision 5), so the upgrade metrics don't apply to it.
   */
  readonly takesContracts: boolean;
  readonly log: StrategyLog;
  /** One decision point. Dispatches zero or more commands. */
  act(sim: Gateway): void;
  /** Extra ticks worth stopping at, beyond job completions, truck arrivals, and midnight. */
  wakeTicks(s: GameSnapshot): readonly number[];
}

export function recipeOf(data: GameData, id: RecipeId): RecipeDefinition {
  const recipe = data.recipes.find((r) => r.id === id);
  if (!recipe) throw new Error(`Strategy recipe ${id} is not in game-data`);
  return recipe;
}

/** Tonight's wages and overhead at the facility's current headcount. */
export function periodCosts(s: GameSnapshot, facility: FacilitySnapshot, data: GameData): Money {
  const leaders = s.family.leaders.reduce((sum, l) => sum + l.dailyWage, 0);
  const workers = facility.workforce.workers * facility.workforce.dailyWagePerWorker;
  const overhead = data.facilityProduction.find((f) => f.facilityId === facility.id)?.dailyOverhead ?? 0;
  return (leaders + workers + overhead) as Money;
}

export interface SupplyLine {
  readonly supplierId: SupplierId;
  readonly materialId: MaterialId;
  readonly unitPrice: Money;
  readonly available: number;
}

/** The cheapest supplier line for each material, from today's market report. */
export function supplyLines(s: GameSnapshot): Map<MaterialId, SupplyLine> {
  const lines = new Map<MaterialId, SupplyLine>();
  for (const supplier of s.market.suppliers) {
    for (const m of supplier.materials) {
      const current = lines.get(m.materialId);
      if (!current || m.unitPrice < current.unitPrice) {
        lines.set(m.materialId, { supplierId: supplier.id, materialId: m.materialId, unitPrice: m.unitPrice, available: m.available });
      }
    }
  }
  return lines;
}

export interface RunPlan {
  readonly quantity: number;
  readonly purchases: readonly { readonly line: SupplyLine; readonly quantity: number }[];
  /** Cash the run needs now (ingredients) and at completion (conversion cost). */
  readonly cashCost: Money;
}

/** The ingredients to buy and the cash needed for a run of `quantity` cases. Null if a supplier can't cover it. */
export function planRun(s: GameSnapshot, facility: FacilitySnapshot, recipe: RecipeDefinition, quantity: number): RunPlan | null {
  const lines = supplyLines(s);
  const purchases: { line: SupplyLine; quantity: number }[] = [];
  let cost = quantity * (recipe.laborPerCase + recipe.overheadPerCase);
  for (const input of recipe.inputsPerCase) {
    const stock = facility.materials.find((m) => m.materialId === input.materialId);
    const free = stock ? stock.quantity - stock.reservedQuantity : 0;
    const missing = Math.max(0, input.quantity * quantity - free);
    if (missing === 0) continue;
    const line = lines.get(input.materialId);
    if (!line || line.available < missing) return null;
    purchases.push({ line, quantity: missing });
    cost += missing * line.unitPrice;
  }
  return { quantity, purchases, cashCost: cost as Money };
}

export class GreedySpotStrategy implements Strategy {
  readonly name = STRATEGY.name;
  readonly takesContracts = false;
  readonly log: StrategyLog = newStrategyLog();
  readonly #data: GameData;
  readonly #recipe: RecipeDefinition;
  readonly #facilityId: FacilityId;
  readonly #vehicleId: VehicleId;

  constructor(first: GameSnapshot, data: GameData = GAME_DATA) {
    this.#data = data;
    this.#recipe = recipeOf(data, STRATEGY.recipeId);
    const facility = first.facilities.find((f) => f.recipes.some((r) => r.recipeId === STRATEGY.recipeId) && f.kind === "DISTILLERY");
    const vehicle = first.vehicles[0];
    if (!facility || !vehicle) throw new Error("Scenario has no distillery or no vehicle for the strategy");
    this.#facilityId = facility.id;
    this.#vehicleId = vehicle.id;
  }

  /** One decision point. Dispatches zero or more commands. */
  act(sim: Gateway): void {
    this.#upgrade(sim);
    this.#produce(sim);
    this.#sell(sim);
  }

  wakeTicks(): readonly number[] {
    return [];
  }

  #facility(s: GameSnapshot): FacilitySnapshot {
    const facility = s.facilities.find((f) => f.id === this.#facilityId);
    if (!facility) throw new Error(`Facility ${this.#facilityId} disappeared from the snapshot`);
    return facility;
  }

  /** Dispatches one command. Returns the tick it applied at, or null if it was rejected. */
  #send(sim: Gateway, command: GameCommand): number | null {
    const result = sim.dispatch({ command });
    if (result.status === "rejected") {
      const code = result.reason.code;
      this.log.rejections[code] = (this.log.rejections[code] ?? 0) + 1;
      return null;
    }
    return result.status === "applied" ? result.tick : result.scheduledTick;
  }

  #upgrade(sim: Gateway): void {
    if (this.log.upgradeBoughtAt !== null) return;
    const s = sim.snapshot();
    const facility = this.#facility(s);
    const option = facility.equipmentOptions.find((e) => e.equipmentId === STRATEGY.upgradeId);
    if (!option || option.blockedBy !== null) return;
    const dayRun = planRun(s, facility, this.#recipe, Math.max(1, facility.productionCapacityPerDay));
    const reserve = STRATEGY.upgradeReserveDays * ((dayRun?.cashCost ?? 0) + periodCosts(s, facility, this.#data));
    if (s.finance.cash < option.price + reserve) return;
    const bought = this.#send(sim, { type: "PURCHASE_EQUIPMENT", facilityId: facility.id, equipmentId: option.equipmentId });
    if (bought === null) return;
    this.log.upgradeBoughtAt = bought;

    // Staff the new crew: Σ crew of what the facility now owns, within its maximum.
    const owned = new Set([...facility.equipment.map((e) => e.id), option.equipmentId]);
    const crew = this.#data.equipment.filter((e) => owned.has(e.id)).reduce((n, e) => n + e.crew, 0);
    const target = Math.min(crew, facility.workforce.maximum);
    if (target > facility.workforce.workers) {
      this.#send(sim, { type: "SET_WORKFORCE", facilityId: facility.id, workerCount: target });
    }
  }

  #produce(sim: Gateway): void {
    const s = sim.snapshot();
    if (s.productionJobs.some((j) => j.facilityId === this.#facilityId)) return;
    const facility = this.#facility(s);
    const dayRun = facility.productionCapacityPerDay;
    const room = facility.storage.capacity - facility.storage.used;
    let quantity = Math.min(dayRun, room);
    if (quantity <= 0) {
      if (dayRun > 0) this.log.productionCaps.STORAGE++;
      return;
    }
    if (quantity < dayRun) this.log.productionCaps.STORAGE++;

    // Largest run the suppliers and cash cover, keeping tonight's wages and overhead.
    const budget = s.finance.cash - periodCosts(s, facility, this.#data);
    let plan: RunPlan | null = null;
    let capped: "CASH" | "SUPPLIER" | null = null;
    for (; quantity > 0; quantity--) {
      const candidate = planRun(s, facility, this.#recipe, quantity);
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
    this.#send(sim, { type: "START_PRODUCTION", facilityId: facility.id, recipeId: this.#recipe.id, quantity: plan.quantity });
  }

  #sell(sim: Gateway): void {
    const s = sim.snapshot();
    const vehicle = s.vehicles.find((v) => v.id === this.#vehicleId);
    if (!vehicle || vehicle.trip !== null) return;
    const facility = this.#facility(s);
    const { productId, quality } = this.#recipe;
    const pool = facility.products.find((p) => p.productId === productId && p.quality === quality);
    const stock = pool ? pool.quantity - pool.reservedQuantity : 0;
    if (stock <= 0) return;

    // Highest quote first; ties by buyer ID so the choice is deterministic.
    const offers: { buyerId: BuyerId; unitPrice: Money; acceptable: number; demand: number }[] = [];
    for (const buyer of s.market.buyers) {
      if (!buyer.willDeal) continue;
      // Skip a buyer whose default route (the first listed, what routeId null resolves to) is closed.
      const route = this.#data.routes.find((r) => r.fromLocationId === facility.locationId && r.toLocationId === buyer.locationId);
      if (route && s.routes.find((r) => r.id === route.id)?.status.open === false) continue;
      const want = buyer.wants.find((w) => w.productId === productId && w.minimumQuality === quality);
      if (!want || want.maxAcceptableQuantity <= 0) continue;
      offers.push({ buyerId: buyer.id, unitPrice: want.unitPrice, acceptable: want.maxAcceptableQuantity, demand: want.demandRemaining });
    }
    offers.sort((a, b) => b.unitPrice - a.unitPrice || (a.buyerId < b.buyerId ? -1 : a.buyerId > b.buyerId ? 1 : 0));
    const best = offers[0];
    if (!best) {
      this.log.saleCaps.NO_BUYER++;
      return;
    }

    const quantity = Math.min(stock, vehicle.capacity, best.acceptable);
    // The binding limit. Stock and the truck first: a buyer limit only counts when it bit.
    const cap: SaleCap =
      quantity === stock ? "STOCK" : quantity === vehicle.capacity ? "TRUCK" : best.acceptable < best.demand ? "BUDGET" : "DEMAND";
    const sent = this.#send(sim, {
      type: "DISPATCH_DELIVERY",
      vehicleId: vehicle.id,
      cargo: [{ productId, quality, quantity }],
      purpose: { kind: "SALE", buyerId: best.buyerId, agreedUnitPrice: best.unitPrice },
      routeId: null,
    });
    if (sent !== null) this.log.saleCaps[cap]++;
  }
}
