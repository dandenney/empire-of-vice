// The snapshot projection (ADR 0007): GameState + game-data → GameSnapshot.
//
// A pure function of its arguments. It never changes state, so taking a
// snapshot never changes the state hash. Output follows ADR 0007's rules:
// plain data, explicit nulls, display names from game-data, lists sorted by ID
// (fixed-data IDs as text; simulation-created records keep state order, which
// is creation order, until #34 settles ID ordering), and `blockedBy` taken from
// the rejection a real dispatch would return (a dispatch on a throwaway kernel
// over the current state, discarded afterwards), so the UI never re-implements
// a rule.

import {
  addMoney,
  qualityRank,
  SNAPSHOT_RECENT_EVENTS,
  ZERO_MONEY,
  divideMoney,
  type BuyerSnapshot,
  type EquipmentOption,
  type ClockSnapshot,
  type FacilitySnapshot,
  type FacilityState,
  type GameSnapshot,
  type GameState,
  type InventoryPoolSnapshot,
  type LocationSnapshot,
  type MaterialStockSnapshot,
  type ProductPriceSnapshot,
  type SupplierSnapshot,
  type VehicleTrip,
  type MarketReport,
  type Money,
  type ProductionJobSnapshot,
  type WashSnapshot,
  type ProgressionSnapshot,
  type PurchaseEquipmentCommand,
  type RecipeOption,
  type RejectionReason,
  type RouteSnapshot,
  type StartProductionCommand,
  type VehicleSnapshot,
} from "@eov/contracts";
import type { GameData, RecipeDefinition } from "@eov/game-data";
import { projectContracts } from "../contracts/projection.ts";
import { cashBalance } from "../economy/ledger/ledger.ts";
import { priceInputs, quoteDeal } from "../economy/market/market.ts";
import { availableMaterial } from "../inventory/pools.ts";
import type { ProjectionContext, SystemRegistry } from "../kernel/registry.ts";
import { createSimulation } from "../kernel/simulation.ts";
import {
  facilityMaxSafeQuantity,
  facilitySpec,
  productionCapacityPerDay,
  resaleValue,
  storageAvailable,
  storageCapacity,
} from "../production/index.ts";
import { projectFinance } from "./finance.ts";

export interface ProjectionDeps {
  readonly data: GameData;
  /** Used to dry-run command handlers for `blockedBy` and `maxStartableQuantity`. */
  readonly registry: SystemRegistry;
}

const byId = <T extends { readonly id: string }>(a: T, b: T): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function named<T extends { readonly id: string; readonly name: string }>(list: readonly T[], id: string, what: string): T {
  const found = list.find((x) => x.id === id);
  if (!found) throw new RangeError(`Snapshot: unknown ${what} ${id}`);
  return found;
}

// ---------------------------------------------------------------------------
// Dry runs: the reason a command would be rejected right now
// ---------------------------------------------------------------------------

/**
 * Dispatches a command on a throwaway kernel over `state` and returns the
 * rejection reason, or null if it would apply. It goes through the kernel's
 * own dispatch path, so commands queued for the next tick apply first, exactly
 * as they would for a real dispatch. The throwaway kernel is discarded and
 * `state` is never changed.
 */
function dryRunRejection(
  state: GameState,
  command: StartProductionCommand | PurchaseEquipmentCommand,
  deps: ProjectionDeps,
  startDate: ProjectionContext["startDate"],
): RejectionReason | null {
  const probe = createSimulation(state, { registry: deps.registry, startDate, gameDataVersion: deps.data.version });
  const result = probe.dispatch({ command });
  return result.status === "rejected" ? result.reason : null;
}

/**
 * The largest quantity START_PRODUCTION accepts without its arithmetic leaving
 * the safe-integer range (input totals, conversion cost, completion tick), for
 * a start on the next tick: the handler's own crew-aware bound
 * (`facilityMaxSafeQuantity`, ADR 0017 decision 1). A search bound; at least 1.
 */
function quantityCeiling(state: GameState, facility: FacilityState, recipe: RecipeDefinition, data: GameData): number {
  return Math.max(1, facilityMaxSafeQuantity(state, data, facility.id, recipe, state.tick + 1));
}

/**
 * What the current state's stock, storage, and cash allow, as a first guess for
 * the search. Commands queued for the next tick can change them, so the search
 * checks the guess against the handler rather than trusting it.
 */
function quantityGuess(state: GameState, facility: FacilityState, recipe: RecipeDefinition, data: GameData, ceiling: number): number {
  let guess = Math.min(ceiling, storageAvailable(state, data, facility.id));
  for (const input of recipe.inputsPerCase) {
    if (input.quantity > 0) guess = Math.min(guess, Math.floor(availableMaterial(state, facility.id, input.materialId) / input.quantity));
  }
  const perCase = addMoney(recipe.laborPerCase, recipe.overheadPerCase);
  if (perCase > 0) guess = Math.min(guess, Math.floor(cashBalance(state) / perCase));
  return Math.max(1, guess);
}

function recipeOption(state: GameState, facility: FacilityState, recipe: RecipeDefinition, deps: ProjectionDeps, ctx: ProjectionContext): RecipeOption {
  const command = (quantity: number): StartProductionCommand => ({ type: "START_PRODUCTION", facilityId: facility.id, recipeId: recipe.id, quantity });
  const accepts = (quantity: number): boolean => dryRunRejection(state, command(quantity), deps, ctx.startDate) === null;
  const blockedBy = dryRunRejection(state, command(1), deps, ctx.startDate);
  let maxStartableQuantity = 0;
  if (blockedBy === null) {
    // Validity is monotone in quantity (more cases need more storage, materials and cash),
    // so binary-search the largest accepted quantity in [1, ceiling]. The bounds
    // are finite even for a recipe with no inputs or no cost. Checking the guess
    // and the one above it first settles the usual case in two dispatches.
    let low = 1;
    let high = quantityCeiling(state, facility, recipe, deps.data);
    const guess = Math.min(high, quantityGuess(state, facility, recipe, deps.data, high));
    if (guess > low) {
      if (accepts(guess)) low = guess;
      else high = guess - 1;
    }
    if (low === guess && low < high) {
      if (accepts(low + 1)) low += 1;
      else high = low;
    }
    while (low < high) {
      const mid = low + Math.ceil((high - low) / 2);
      if (accepts(mid)) low = mid;
      else high = mid - 1;
    }
    maxStartableQuantity = low;
  }
  return {
    recipeId: recipe.id,
    name: recipe.name,
    productId: recipe.productId,
    quality: recipe.quality,
    inputsPerCase: recipe.inputsPerCase.map((i) => ({ materialId: i.materialId, quantity: i.quantity })),
    // The recipe's base time at 1×; the scaled duration is jobDuration's (round-3 notes on #7).
    ticksPerCase: recipe.ticksPerCase,
    maxStartableQuantity,
    blockedBy,
    // ADR 0029 decision 8: computed under founder rules by TS2 (#244); null until then.
    twoStage: null,
  };
}

/** Every equipment item the facility doesn't own, by ID, each with a dry-run PURCHASE_EQUIPMENT's verdict. */
function equipmentOptions(state: GameState, facility: FacilityState, deps: ProjectionDeps, ctx: ProjectionContext): readonly EquipmentOption[] {
  return deps.data.equipment
    .filter((e) => !facility.equipment.some((o) => o.equipmentId === e.id))
    .sort(byId)
    .map((e) => ({
      equipmentId: e.id,
      name: e.name,
      description: e.description,
      price: e.price,
      blockedBy: dryRunRejection(state, { type: "PURCHASE_EQUIPMENT", facilityId: facility.id, equipmentId: e.id }, deps, ctx.startDate),
    }));
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/**
 * The tier ladder in game-data order (ascending, ADR 0020 decision 4). A tier is
 * reached if it's the family's tier or below it: tiers are never revoked.
 */
function projectProgression(state: GameState, data: GameData, netWorth: Money): ProgressionSnapshot {
  const { tiers, victory } = data.progression;
  const current = tiers.findIndex((t) => t.id === state.family.tierId);
  if (current < 0) throw new RangeError(`Snapshot: unknown tier ${state.family.tierId}`);
  return {
    currentTierId: state.family.tierId,
    tiers: tiers.map((t, i) => ({
      id: t.id,
      name: t.name,
      netWorthRequired: t.netWorthRequired,
      reputationRequired: t.reputationRequired,
      unlocks: [...t.unlocks],
      reached: i <= current,
    })),
    unlocked: [...state.family.unlocked],
    victory: {
      netWorth: { current: netWorth, target: victory.netWorth },
      reputation: { current: state.family.reputation, target: victory.reputation },
      completedContracts: {
        current: state.contracts.filter((c) => c.status === "COMPLETED").length,
        target: victory.completedContracts,
      },
    },
  };
}

function projectLocations(state: GameState, data: GameData): readonly LocationSnapshot[] {
  const out: LocationSnapshot[] = [];
  for (const location of data.locations) {
    const facility = state.facilities.find((f) => data.facilities.find((d) => d.id === f.id)?.locationId === location.id);
    const supplier = state.suppliers.find((s) => data.suppliers.find((d) => d.id === s.id)?.locationId === location.id);
    const buyer = state.buyers.find((b) => data.buyers.find((d) => d.id === b.id)?.locationId === location.id);
    const occupant: LocationSnapshot["occupant"] | null = facility
      ? { kind: "FACILITY", facilityId: facility.id }
      : supplier
        ? { kind: "SUPPLIER", supplierId: supplier.id }
        : buyer
          ? { kind: "BUYER", buyerId: buyer.id }
          : null;
    // A place with nothing of this scenario's on it isn't shown.
    if (occupant) out.push({ id: location.id, name: location.name, position: { ...location.position }, occupant });
  }
  return out.sort(byId);
}

/** A route's condition in the world (ADR 0007's `RouteSnapshot.status`). */
export function routeStatus(state: GameState, routeId: string): RouteSnapshot["status"] {
  const closure = state.routes.find((r) => r.id === routeId)?.closure ?? null;
  return closure ? { open: false, reopensAt: closure.reopensAt, reason: closure.reason } : { open: true };
}

/** A route's geometry, cost and risk: static game-data (always known, ADR 0021 decision 3). */
export function routeGeography(data: GameData, routeId: string): Omit<RouteSnapshot, "status"> {
  const def = named(data.routes, routeId, "route");
  return {
    id: def.id,
    name: def.name,
    fromLocationId: def.fromLocationId,
    toLocationId: def.toLocationId,
    waypoints: def.waypoints.map((p) => ({ ...p })),
    durationTicks: def.durationTicks,
    transportCost: def.transportCost,
    riskPpm: def.riskPpm,
  };
}

function projectRoutes(state: GameState, data: GameData): readonly RouteSnapshot[] {
  return state.routes
    .map((r): RouteSnapshot => {
      const geography = routeGeography(data, r.id);
      return {
        id: geography.id,
        name: geography.name,
        fromLocationId: geography.fromLocationId,
        toLocationId: geography.toLocationId,
        waypoints: geography.waypoints,
        durationTicks: geography.durationTicks,
        transportCost: geography.transportCost,
        status: routeStatus(state, r.id),
        riskPpm: geography.riskPpm,
      };
    })
    .sort(byId);
}

/** A facility's product and material pools, with reservations and cost (ADR 0007), in state order. */
export function facilityStock(
  state: GameState,
  data: GameData,
  facilityId: string,
): { readonly products: readonly InventoryPoolSnapshot[]; readonly materials: readonly MaterialStockSnapshot[] } {
  const reservedHere = (match: (goods: GameState["reservations"][number]["goods"]) => boolean): number =>
    state.reservations.filter((r) => r.facilityId === facilityId && match(r.goods)).reduce((n, r) => n + r.quantity, 0);
  const products = state.productPools
    .filter((p) => p.facilityId === facilityId)
    .map((p) => ({
      productId: p.productId,
      productName: named(data.products, p.productId, "product").name,
      quality: p.quality,
      quantity: p.quantity,
      reservedQuantity: reservedHere((g) => g.kind === "PRODUCT" && g.productId === p.productId && g.quality === p.quality),
      totalCost: p.totalCost,
      averageUnitCost: p.quantity > 0 ? divideMoney(p.totalCost, p.quantity) : ZERO_MONEY,
    }));
  const materials = state.materialPools
    .filter((m) => m.facilityId === facilityId)
    .map((m) => ({
      materialId: m.materialId,
      materialName: named(data.materials, m.materialId, "material").name,
      quantity: m.quantity,
      reservedQuantity: reservedHere((g) => g.kind === "MATERIAL" && g.materialId === m.materialId),
      totalCost: m.totalCost,
    }));
  return { products, materials };
}

function projectFacility(state: GameState, facility: FacilityState, deps: ProjectionDeps, ctx: ProjectionContext): FacilitySnapshot {
  const { data } = deps;
  const def = named(data.facilities, facility.id, "facility");
  const { products, materials } = facilityStock(state, data, facility.id);
  const owned = facility.equipment.map((e) => named(data.equipment, e.equipmentId, "equipment"));
  return {
    id: facility.id,
    name: def.name,
    locationId: def.locationId,
    // From game-data, not inferred from current equipment: a distillery that sold its still is still a distillery (T05i, #148).
    kind: def.kind,
    equipment: facility.equipment.map((e, i) => ({
      id: e.equipmentId,
      name: owned[i]!.name,
      bookValue: e.bookValue,
      resaleValue: resaleValue(e.bookValue, data),
    })),
    equipmentSlots: { used: facility.equipment.length, total: facilitySpec(data, facility.id).equipmentSlots },
    equipmentOptions: equipmentOptions(state, facility, deps, ctx),
    workforce: { workers: facility.workerCount, maximum: facilitySpec(data, facility.id).maximumWorkers, dailyWagePerWorker: data.workforce.workerDailyWage },
    storage: { used: products.reduce((n, p) => n + p.quantity, 0), capacity: storageCapacity(state, data, facility.id) },
    barrels: facilitySpec(data, facility.id).barrels,
    productionCapacityPerDay: productionCapacityPerDay(state, data, facility.id),
    recipes: [...data.recipes].sort(byId).map((r) => recipeOption(state, facility, r, deps, ctx)),
    products,
    materials,
    phoneLine: facility.phoneLine === null ? null : { bookValue: facility.phoneLine.bookValue },
  };
}

/** Production jobs in state order (ADR 0007). */
export function projectJobs(state: GameState, data: GameData): readonly ProductionJobSnapshot[] {
  return state.productionJobs.map((j) => {
    const recipe = named(data.recipes, j.recipeId, "recipe");
    return {
      id: j.id,
      facilityId: j.facilityId,
      recipeId: j.recipeId,
      productId: recipe.productId,
      quality: recipe.quality,
      quantity: j.quantity,
      startedAt: j.startedAt,
      completesAt: j.completesAt,
    };
  });
}

/** Every full barrel (ADR 0029 decision 8), in state order: sorted by (facilityId, barrel). */
export function projectWashes(state: GameState, data: GameData): readonly WashSnapshot[] {
  return state.washes.map((w) => {
    const recipe = named(data.recipes, w.recipeId, "recipe");
    return {
      facilityId: w.facilityId,
      barrel: w.barrel,
      recipeId: w.recipeId,
      productId: recipe.productId,
      quality: recipe.quality,
      quantity: w.quantity,
      mashedAt: w.mashedAt,
      readyAt: w.readyAt,
    };
  });
}

/** A vehicle's trip with its delivery's cargo and purpose (ADR 0007), or null when it has none. */
export function vehicleTrip(state: GameState, v: GameState["vehicles"][number]): VehicleTrip | null {
  if (!v.trip) return null;
  const trip = v.trip;
  const delivery = state.deliveries.find((d) => d.id === trip.deliveryId);
  if (!delivery) throw new RangeError(`Snapshot: vehicle ${v.id} is on unknown delivery ${trip.deliveryId}`);
  return {
    deliveryId: trip.deliveryId,
    routeId: trip.routeId,
    leg: trip.leg,
    departedAt: trip.departedAt,
    arrivesAt: trip.arrivesAt,
    cargo: delivery.cargo.map((l) => ({ productId: l.productId, quality: l.quality, quantity: l.quantity })),
    purpose: delivery.purpose,
    delayed: trip.delayed,
  };
}

function projectVehicles(state: GameState, data: GameData): readonly VehicleSnapshot[] {
  return state.vehicles
    .map((v): VehicleSnapshot => {
      const def = named(data.vehicles, v.id, "vehicle");
      const home = named(data.facilities, def.homeFacilityId, "facility");
      return { id: v.id, name: def.name, capacity: def.capacityCases, homeLocationId: home.locationId, trip: vehicleTrip(state, v) };
    })
    .sort(byId);
}

/** Every (product, quality) market with its price inputs (ADR 0007), sorted by product then quality. */
export function marketProducts(state: GameState, data: GameData): readonly ProductPriceSnapshot[] {
  return state.markets
    .map((m) => {
      const product = named(data.products, m.productId, "product");
      const def = data.markets.find((d) => d.productId === m.productId && d.quality === m.quality);
      if (!def) throw new RangeError(`Snapshot: no market definition for ${m.productId} ${m.quality}`);
      // The clamped multipliers the spot price was built from (ADR 0016), so
      // applyRatios(basePrice, [demand, supply, event]) === spotPrice.
      const [demandRatioPpm, supplyRatioPpm, eventRatioPpm] = priceInputs(m, def);
      return {
        productId: m.productId,
        productName: product.name,
        quality: m.quality,
        basePrice: product.basePrice[m.quality],
        spotPrice: m.spotPrice,
        demandRatioPpm,
        supplyRatioPpm,
        eventRatioPpm,
        previousSpotPrice: m.previousSpotPrice,
      };
    })
    .sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : qualityRank(a.quality) - qualityRank(b.quality)));
}

/** A supplier's materials: price, availability, shortage (ADR 0007). */
export function supplierMaterials(state: GameState, data: GameData, supplierId: string): SupplierSnapshot["materials"] {
  const supplier = state.suppliers.find((s) => s.id === supplierId);
  if (!supplier) throw new RangeError(`Snapshot: unknown supplier ${supplierId}`);
  return supplier.stock.map((st) => ({
    materialId: st.materialId,
    materialName: named(data.materials, st.materialId, "material").name,
    unitPrice: st.unitPrice,
    available: st.available,
    shortage: st.shortage !== null,
  }));
}

function projectMarket(state: GameState, data: GameData, clock: ClockSnapshot): MarketReport {
  const products = marketProducts(state, data);
  const suppliers = state.suppliers
    .map((s) => {
      const def = named(data.suppliers, s.id, "supplier");
      return { id: s.id, name: def.name, locationId: def.locationId, materials: supplierMaterials(state, data, s.id) };
    })
    .sort(byId);
  const buyers = state.buyers
    .map((b): BuyerSnapshot => {
      const def = named(data.buyers, b.id, "buyer");
      const minimumReputation = def.minimumReputation;
      return {
        id: b.id,
        name: def.name,
        locationId: def.locationId,
        minimumReputation,
        willDeal: state.family.reputation >= minimumReputation,
        budgetRemaining: b.budgetRemaining,
        wants: b.wants.map((w) => {
          // The liquidity cap comes from the same rule a dispatch is checked with
          // (quoteDeal), asked about one case more than the want's demand remaining.
          // A line at the want's minimum quality matches that want (ADR 0016). Its
          // acceptable quantity is never above the demand remaining, so the probe
          // is BUYER_WILL_TAKE_LESS and carries the cap. Any other answer (such as
          // REPUTATION_TOO_LOW for a buyer that won't deal) means no deal: 0.
          const probe = quoteDeal(state, data, b.id, w.unitPrice, { productId: w.productId, quality: w.minimumQuality, quantity: w.demandRemaining + 1 });
          const maxAcceptableQuantity = "code" in probe && probe.code === "BUYER_WILL_TAKE_LESS" ? probe.acceptable : 0;
          return {
            productId: w.productId,
            productName: named(data.products, w.productId, "product").name,
            minimumQuality: w.minimumQuality,
            unitPrice: w.unitPrice,
            demandRemaining: w.demandRemaining,
            maxAcceptableQuantity,
          };
        }),
      };
    })
    .sort(byId);
  return { dayIndex: clock.dayIndex, products, suppliers, buyers };
}

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

export function projectSnapshot(state: GameState, ctx: ProjectionContext, deps: ProjectionDeps): GameSnapshot {
  const { data } = deps;
  const finance = projectFinance(state);
  return {
    clock: ctx.clock,
    outcome: state.outcome,
    family: {
      id: state.family.id,
      name: named(data.families, state.family.id, "family").name,
      reputation: state.family.reputation,
      // The family's leaders are game-data's characters (ADR 0017 decision 10).
      leaders: [...data.characters]
        .sort(byId)
        .map((c) => ({ id: c.id, name: c.name, role: c.role, skill: c.skill, loyalty: c.loyalty, dailyWage: c.dailyWage })),
    },
    finance,
    progression: projectProgression(state, data, finance.netWorth),
    locations: projectLocations(state, data),
    routes: projectRoutes(state, data),
    facilities: [...state.facilities].sort(byId).map((f) => projectFacility(state, f, deps, ctx)),
    productionJobs: projectJobs(state, data),
    washes: projectWashes(state, data),
    vehicles: projectVehicles(state, data),
    // The whole employee state, named, for the lab and the debug view (ADR 0025 decision 16).
    employees: state.employees.map((e) => ({ ...e, name: named(data.personnel.candidatePool, e.characterId, "candidate").name })),
    market: projectMarket(state, data, ctx.clock),
    contracts: projectContracts(state, data),
    recentEvents: state.eventJournal.slice(-SNAPSHOT_RECENT_EVENTS),
  };
}

