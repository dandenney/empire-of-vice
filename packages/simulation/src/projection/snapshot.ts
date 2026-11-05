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
//
// Sections whose system doesn't exist yet report what state and game-data hold
// and nothing more: contracts are empty lists (T02e), the progression ladder is
// the scenario's current tier only (T05), and leaders are empty (T02c2). Where
// the contract needs a value game-data doesn't define yet, see
// UNDEFINED_IN_GAME_DATA below.

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
  type LocationSnapshot,
  type MarketReport,
  type Money,
  type ProductionJobSnapshot,
  type ProgressionSnapshot,
  type PurchaseEquipmentCommand,
  type RecipeOption,
  type RejectionReason,
  type RouteSnapshot,
  type StartProductionCommand,
  type VehicleSnapshot,
} from "@eov/contracts";
import type { GameData, RecipeDefinition } from "@eov/game-data";
import { cashBalance } from "../economy/ledger/ledger.ts";
import { priceInputs, quoteDeal } from "../economy/market/market.ts";
import { availableMaterial } from "../inventory/pools.ts";
import type { ProjectionContext, SystemRegistry } from "../kernel/registry.ts";
import { createSimulation } from "../kernel/simulation.ts";
import { facilitySpec, maxSafeQuantity, productionCapacityPerDay, storageAvailable, storageCapacity, supportsRecipe } from "../production/index.ts";
import { projectFinance } from "./finance.ts";

/**
 * S0 stub: values the snapshot contract requires but game-data doesn't define
 * yet. Each is reported as 0 (a number) or the entity's ID (a name) rather than
 * a made-up figure, and each names the task that adds the definition. Listed in
 * the S0b PR as gaps.
 */
export const UNDEFINED_IN_GAME_DATA = {
  /** Family display name (T05, scenario). Reported as the family ID. */
  familyName: (id: string): string => id,
  /** Tier display name (T05, progression). Reported as the tier ID. */
  tierName: (id: string): string => id,
  /** Victory targets (T05). Reported as 0. */
  victoryNetWorth: ZERO_MONEY,
  victoryReputation: 0,
  victoryCompletedContracts: 0,
  /** Maximum workforce per facility (T02c). Reported as 0. */
  maximumWorkers: 0,
} as const;

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
 * a start on the next tick: the handler's own bound (`maxSafeQuantity`). A
 * search bound; at least 1.
 */
function quantityCeiling(state: GameState, recipe: RecipeDefinition): number {
  return Math.max(1, maxSafeQuantity(recipe, state.tick + 1));
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
    let high = quantityCeiling(state, recipe);
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

function projectProgression(state: GameState, netWorth: Money): ProgressionSnapshot {
  const missing = UNDEFINED_IN_GAME_DATA;
  return {
    currentTierId: state.family.tierId,
    // S0 stub (T05): no tier ladder in game-data yet, so only the current tier.
    tiers: [
      {
        id: state.family.tierId,
        name: missing.tierName(state.family.tierId),
        netWorthRequired: null,
        reputationRequired: null,
        unlocks: [...state.family.unlocked],
        reached: true,
      },
    ],
    unlocked: [...state.family.unlocked],
    victory: {
      netWorth: { current: netWorth, target: missing.victoryNetWorth },
      reputation: { current: state.family.reputation, target: missing.victoryReputation },
      completedContracts: {
        current: state.contracts.filter((c) => c.status === "COMPLETED").length,
        target: missing.victoryCompletedContracts,
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

function projectRoutes(state: GameState, data: GameData): readonly RouteSnapshot[] {
  return state.routes
    .map((r): RouteSnapshot => {
      const def = named(data.routes, r.id, "route");
      return {
        id: r.id,
        name: def.name,
        fromLocationId: def.fromLocationId,
        toLocationId: def.toLocationId,
        waypoints: def.waypoints.map((p) => ({ ...p })),
        durationTicks: def.durationTicks,
        transportCost: def.transportCost,
        status: r.closure ? { open: false, reopensAt: r.closure.reopensAt, reason: r.closure.reason } : { open: true },
        riskPpm: def.riskPpm,
      };
    })
    .sort(byId);
}

function projectFacility(state: GameState, facility: FacilityState, deps: ProjectionDeps, ctx: ProjectionContext): FacilitySnapshot {
  const { data } = deps;
  const def = named(data.facilities, facility.id, "facility");
  const missing = UNDEFINED_IN_GAME_DATA;
  const reservedHere = (match: (goods: GameState["reservations"][number]["goods"]) => boolean): number =>
    state.reservations.filter((r) => r.facilityId === facility.id && match(r.goods)).reduce((n, r) => n + r.quantity, 0);
  const products = state.productPools
    .filter((p) => p.facilityId === facility.id)
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
    .filter((m) => m.facilityId === facility.id)
    .map((m) => ({
      materialId: m.materialId,
      materialName: named(data.materials, m.materialId, "material").name,
      quantity: m.quantity,
      reservedQuantity: reservedHere((g) => g.kind === "MATERIAL" && g.materialId === m.materialId),
      totalCost: m.totalCost,
    }));
  const owned = facility.equipment.map((e) => named(data.equipment, e.equipmentId, "equipment"));
  // Game-data has no facility kind (T03), so a facility that can run a recipe is a distillery.
  const distills = data.recipes.some((r) => supportsRecipe(facility, r));
  return {
    id: facility.id,
    name: def.name,
    locationId: def.locationId,
    kind: distills ? "DISTILLERY" : "WAREHOUSE",
    equipment: facility.equipment.map((e, i) => ({ id: e.equipmentId, name: owned[i]!.name, bookValue: e.bookValue })),
    equipmentSlots: { used: facility.equipment.length, total: facilitySpec(data, facility.id).equipmentSlots },
    equipmentOptions: equipmentOptions(state, facility, deps, ctx),
    workforce: { workers: facility.workerCount, maximum: missing.maximumWorkers, dailyWagePerWorker: data.workforce.workerDailyWage },
    storage: { used: products.reduce((n, p) => n + p.quantity, 0), capacity: storageCapacity(state, data, facility.id) },
    productionCapacityPerDay: productionCapacityPerDay(state, data, facility.id),
    recipes: [...data.recipes].sort(byId).map((r) => recipeOption(state, facility, r, deps, ctx)),
    products,
    materials,
  };
}

function projectJobs(state: GameState, data: GameData): readonly ProductionJobSnapshot[] {
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

function projectVehicles(state: GameState, data: GameData): readonly VehicleSnapshot[] {
  return state.vehicles
    .map((v): VehicleSnapshot => {
      const def = named(data.vehicles, v.id, "vehicle");
      const home = named(data.facilities, def.homeFacilityId, "facility");
      let trip: VehicleSnapshot["trip"] = null;
      if (v.trip) {
        const delivery = state.deliveries.find((d) => d.id === v.trip!.deliveryId);
        if (!delivery) throw new RangeError(`Snapshot: vehicle ${v.id} is on unknown delivery ${v.trip.deliveryId}`);
        trip = {
          deliveryId: v.trip.deliveryId,
          routeId: v.trip.routeId,
          leg: v.trip.leg,
          departedAt: v.trip.departedAt,
          arrivesAt: v.trip.arrivesAt,
          cargo: delivery.cargo.map((l) => ({ productId: l.productId, quality: l.quality, quantity: l.quantity })),
          purpose: delivery.purpose,
          delayed: v.trip.delayed,
        };
      }
      return { id: v.id, name: def.name, capacity: def.capacityCases, homeLocationId: home.locationId, trip };
    })
    .sort(byId);
}

function projectMarket(state: GameState, data: GameData, clock: ClockSnapshot): MarketReport {
  const products = state.markets
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
  const suppliers = state.suppliers
    .map((s) => {
      const def = named(data.suppliers, s.id, "supplier");
      return {
        id: s.id,
        name: def.name,
        locationId: def.locationId,
        materials: s.stock.map((st) => ({
          materialId: st.materialId,
          materialName: named(data.materials, st.materialId, "material").name,
          unitPrice: st.unitPrice,
          available: st.available,
          shortage: st.shortage !== null,
        })),
      };
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
      name: UNDEFINED_IN_GAME_DATA.familyName(state.family.id),
      reputation: state.family.reputation,
      // S0 stub (T02c): game-data's characters have no skill or loyalty yet, and nothing assigns them to a family.
      leaders: [],
    },
    finance,
    progression: projectProgression(state, finance.netWorth),
    locations: projectLocations(state, data),
    routes: projectRoutes(state, data),
    facilities: [...state.facilities].sort(byId).map((f) => projectFacility(state, f, deps, ctx)),
    productionJobs: projectJobs(state, data),
    vehicles: projectVehicles(state, data),
    market: projectMarket(state, data, ctx.clock),
    // S0 stub (T02e): no contract system yet. State's offer and contract lists are always empty.
    contracts: { offers: [], active: [], closed: [] },
    recentEvents: state.eventJournal.slice(-SNAPSHOT_RECENT_EVENTS),
  };
}

