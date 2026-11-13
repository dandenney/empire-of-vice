// The player snapshot builder (ADR 0021 decision 8): GameState → PlayerSnapshot.
//
// Built only from three inputs, never from the rest of the world:
// - `knowledge` (records, activity, the last catch-up, pending books);
// - the always-known state (decision 3): the clock, the outcome, the founder,
//   the purse, agreements the founder made (facilities' equipment and
//   workforce, owned vehicles, contracts' terms, deals, the founder's own
//   commands and their transactions), and geography;
// - the live view of where the founder observes (decision 5), read from the
//   world now, with `learnedAt` = now and an IN_PERSON source.
//
// Every affordance is recomputed from known values: `blockedBy`,
// `maxStartableQuantity`, `maxAcceptableQuantity`, `inTransit`. So is anything
// that reads a known value (the books, known net worth, victory progress, the
// deal list). A pure function of state: building it changes nothing.
//
// With founder rules off the whole world is the live view (ADR 0022 decision 2's
// lab mode), and nothing is pending.

import {
  compareIds,
  knowledgeSubjectKey,

  type BuyerId,
  type ContractOfferSnapshot,
  type DealId,
  type DeliveryState,
  type EquipmentOption,
  type GameState,
  type InstallmentSnapshot,
  type Known,
  type KnowledgeSubject,
  type KnowledgeSubjectOf,
  type KnowledgeValueOf,
  type LedgerTransaction,
  type Money,
  type PlayerBookRow,
  type PlayerBuyer,
  type PlayerContract,
  type PlayerDeal,
  type PlayerFacility,
  type PlayerFinance,
  type PlayerFounder,
  type PlayerPlace,
  type PlayerRoute,
  type PlayerSnapshot,
  type PlayerVehicle,
  type RecipeOption,
  type RejectionReason,
  type SubjectKind,
  type Tick,
  type UnlockId,
} from "@eov/contracts";
import { DEAL_HOLD_TICKS, type GameData, type RecipeDefinition } from "@eov/game-data";
import { creditCases, type Installment } from "../contracts/rules.ts";
import { cashBalance, ledgerBalances } from "../economy/ledger/ledger.ts";
import { busyRejection } from "../founder/activities.ts";
import { routeOf } from "../founder/paths.ts";
import { isTired } from "../founder/time.ts";
import { liveView, observation, occupantAt, type LiveEntry } from "../knowledge/view.ts";
import type { ProjectionContext } from "../kernel/registry.ts";
import {
  conversionCost,
  facilityMaxSafeQuantity,
  facilitySpec,
  productionCapacityPerDay,
  resaleValue,
  storageCapacity,
  supportsRecipe,
  throughput,
} from "../production/index.ts";
import { balanceSheetOf, cashFlowCategoryOf } from "./finance.ts";
import { routeGeography } from "./snapshot.ts";

export interface PlayerProjectionDeps {
  readonly data: GameData;
  /** Founder rules on: the knowledge model applies. Off: the whole world is the live view. */
  readonly founderRules: boolean;
}

const byId = <T extends { readonly id: string }>(a: T, b: T): number => compareIds(a.id, b.id);

function named<T extends { readonly id: string; readonly name: string }>(list: readonly T[], id: string, what: string): T {
  const found = list.find((x) => x.id === id);
  if (!found) throw new RangeError(`Player snapshot: unknown ${what} ${id}`);
  return found;
}

const keyOf = (subject: KnowledgeSubject): string => `${subject.kind}|${knowledgeSubjectKey(subject)}`;

/** What the founder knows right now: the live view over the records. */
class KnownView {
  readonly #live = new Map<string, LiveEntry>();
  readonly #state: GameState;

  constructor(state: GameState, live: readonly LiveEntry[]) {
    this.#state = state;
    for (const entry of live) this.#live.set(keyOf(entry.subject), entry);
  }

  isLive(subject: KnowledgeSubject): boolean {
    return this.#live.has(keyOf(subject));
  }

  get<K extends SubjectKind>(subject: KnowledgeSubjectOf<K>): Known<KnowledgeValueOf<K>> {
    const live = this.#live.get(keyOf(subject));
    if (live) return { value: live.value as KnowledgeValueOf<K>, learnedAt: this.#state.tick, source: live.source };
    const record = this.#state.knowledge.records.find((r) => keyOf(r.subject) === keyOf(subject));
    return record ? { value: record.value as KnowledgeValueOf<K>, learnedAt: record.learnedAt, source: record.source } : null;
  }
}

// ---------------------------------------------------------------------------
// The founder (ADR 0023 decision 1): always known
// ---------------------------------------------------------------------------

const PPM = 1_000_000;

function projectFounder(state: GameState, data: GameData): PlayerFounder {
  const w = state.founder.whereabouts;
  let currentLeg: PlayerFounder["currentLeg"] = null;
  if (w.kind === "TRAVELLING") {
    const leg = w.path[w.legIndex]!;
    const waypoints = routeOf(data, leg.routeId).waypoints.map((p) => ({ ...p }));
    const span = w.legArrivesAt - w.legDepartedAt;
    const done = Math.min(Math.max(state.tick - w.legDepartedAt, 0), span);
    currentLeg = {
      routeId: leg.routeId,
      waypoints: leg.reversed ? waypoints.reverse() : waypoints,
      progressPpm: span > 0 ? Math.floor((done * PPM) / span) : PPM,
    };
  }
  return { ...state.founder, tired: isTired(state.founder, state.tick), currentLeg };
}

// ---------------------------------------------------------------------------
// Facilities: affordances from known stock and operations, the purse and agreements
// ---------------------------------------------------------------------------

interface Gates {
  /** FOUNDER_BUSY for a timed command applied next tick, with founder rules on (ADR 0023 decision 4). */
  readonly busy: RejectionReason | null;
  /** Known unlocks, or null if STANDING was never known. */
  readonly unlocked: readonly UnlockId[] | null;
  readonly reputation: number | null;
  readonly cash: Money;
  readonly next: Tick;
}

function knownRecipe(
  state: GameState,
  data: GameData,
  facility: GameState["facilities"][number],
  recipe: RecipeDefinition,
  stock: KnowledgeValueOf<"FACILITY_STOCK"> | null,
  operations: KnowledgeValueOf<"FACILITY_OPERATIONS"> | null,
  gates: Gates,
): RecipeOption {
  const committed = (stock?.storageUsed ?? 0) + (operations?.jobs ?? []).reduce((n, j) => n + j.quantity, 0);
  const room = Math.max(0, storageCapacity(state, data, facility.id) - committed);
  const available = (materialId: string): number => {
    const line = stock?.materials.find((m) => m.materialId === materialId);
    return line ? Math.max(0, line.quantity - line.reservedQuantity) : 0;
  };
  const perCase = conversionCost(recipe, 1);
  let blockedBy: RejectionReason | null = gates.busy;
  if (blockedBy === null && !supportsRecipe(facility, recipe)) blockedBy = { code: "RECIPE_NOT_SUPPORTED", facilityId: facility.id, recipeId: recipe.id };
  if (blockedBy === null && (throughput(state, data, facility.id) === 0 || (operations?.jobs.length ?? 0) > 0)) {
    blockedBy = { code: "PRODUCTION_CAPACITY_EXCEEDED", facilityId: facility.id, requested: 1, available: 0 };
  }
  if (blockedBy === null && room < 1) blockedBy = { code: "STORAGE_CAPACITY_EXCEEDED", facilityId: facility.id, requested: 1, available: room };
  for (const input of recipe.inputsPerCase) {
    if (blockedBy === null && available(input.materialId) < input.quantity) {
      blockedBy = { code: "INSUFFICIENT_MATERIALS", materialId: input.materialId, required: input.quantity, available: available(input.materialId) };
    }
  }
  if (blockedBy === null && gates.cash < perCase) blockedBy = { code: "INSUFFICIENT_FUNDS", required: perCase, available: gates.cash };
  let maxStartableQuantity = 0;
  if (blockedBy === null) {
    let max = Math.min(room, facilityMaxSafeQuantity(state, data, facility.id, recipe, gates.next));
    for (const input of recipe.inputsPerCase) if (input.quantity > 0) max = Math.min(max, Math.floor(available(input.materialId) / input.quantity));
    if (perCase > 0) max = Math.min(max, Math.floor(gates.cash / perCase));
    maxStartableQuantity = Math.max(1, max);
  }
  return {
    recipeId: recipe.id,
    name: recipe.name,
    productId: recipe.productId,
    quality: recipe.quality,
    inputsPerCase: recipe.inputsPerCase.map((i) => ({ materialId: i.materialId, quantity: i.quantity })),
    ticksPerCase: recipe.ticksPerCase,
    maxStartableQuantity,
    blockedBy,
  };
}

function knownEquipmentOptions(data: GameData, facility: GameState["facilities"][number], gates: Gates): readonly EquipmentOption[] {
  const slots = facilitySpec(data, facility.id).equipmentSlots;
  return [...data.equipment]
    .filter((e) => !facility.equipment.some((o) => o.equipmentId === e.id))
    .sort(byId)
    .map((e) => {
      let blockedBy: RejectionReason | null = gates.busy;
      if (blockedBy === null && e.requiredUnlockId !== null && gates.unlocked !== null && !gates.unlocked.includes(e.requiredUnlockId)) {
        blockedBy = { code: "LOCKED", unlockId: e.requiredUnlockId };
      }
      if (blockedBy === null && facility.equipment.length >= slots) blockedBy = { code: "NO_EQUIPMENT_SLOT", facilityId: facility.id, equipmentId: e.id };
      if (blockedBy === null && gates.cash < e.price) blockedBy = { code: "INSUFFICIENT_FUNDS", required: e.price, available: gates.cash };
      return { equipmentId: e.id, name: e.name, description: e.description, price: e.price, blockedBy };
    });
}

function projectFacility(state: GameState, data: GameData, facility: GameState["facilities"][number], known: KnownView, gates: Gates): PlayerFacility {
  const def = named(data.facilities, facility.id, "facility");
  const stock = known.get<"FACILITY_STOCK">({ kind: "FACILITY_STOCK", facilityId: facility.id });
  const operations = known.get<"FACILITY_OPERATIONS">({ kind: "FACILITY_OPERATIONS", facilityId: facility.id });
  const spec = facilitySpec(data, facility.id);
  return {
    id: facility.id,
    name: def.name,
    kind: def.kind,
    equipment: facility.equipment.map((e) => ({
      id: e.equipmentId,
      name: named(data.equipment, e.equipmentId, "equipment").name,
      bookValue: e.bookValue,
      resaleValue: resaleValue(e.bookValue, data),
    })),
    equipmentSlots: { used: facility.equipment.length, total: spec.equipmentSlots },
    equipmentOptions: knownEquipmentOptions(data, facility, gates),
    workforce: { workers: facility.workerCount, maximum: spec.maximumWorkers, dailyWagePerWorker: data.workforce.workerDailyWage },
    productionCapacityPerDay: productionCapacityPerDay(state, data, facility.id),
    recipes: [...data.recipes].sort(byId).map((r) => knownRecipe(state, data, facility, r, stock?.value ?? null, operations?.value ?? null, gates)),
    storageCapacity: storageCapacity(state, data, facility.id),
    stock,
    operations,
  };
}

// ---------------------------------------------------------------------------
// Buyers: quotes and offers recomputed from known values
// ---------------------------------------------------------------------------

function projectBuyer(data: GameData, buyerId: BuyerId, known: KnownView, gates: Gates): PlayerBuyer {
  const def = named(data.buyers, buyerId, "buyer");
  const wantsKnown = known.get<"BUYER_WANTS">({ kind: "BUYER_WANTS", buyerId });
  const budget = known.get<"BUYER_BUDGET">({ kind: "BUYER_BUDGET", buyerId });
  const offersKnown = known.get<"CONTRACT_OFFERS">({ kind: "CONTRACT_OFFERS", buyerId });
  // ECO-001 liquidity from known values: without a known budget, the demand remaining (decision 8).
  const acceptable = (unitPrice: Money, demandRemaining: number): number => {
    if (budget === null) return demandRemaining;
    const affordable = unitPrice > 0 ? Math.floor(budget.value.budgetRemaining / unitPrice) : demandRemaining;
    return Math.max(0, Math.min(demandRemaining, affordable));
  };
  const wants: PlayerBuyer["wants"] =
    wantsKnown === null
      ? null
      : {
          ...wantsKnown,
          value: {
            ...wantsKnown.value,
            wants: wantsKnown.value.wants.map((w) => ({
              ...w,
              maxAcceptableQuantity: wantsKnown.value.willDeal ? acceptable(w.unitPrice, w.demandRemaining) : 0,
            })),
          },
        };
  const offerBlockedBy = (offer: Omit<ContractOfferSnapshot, "blockedBy">): RejectionReason | null => {
    if (gates.next >= offer.expiresAt) return { code: "OFFER_UNAVAILABLE", contractOfferId: offer.id };
    const unlockId = data.contracts.terms.requiredUnlockId;
    if (unlockId !== null && gates.unlocked !== null && !gates.unlocked.includes(unlockId)) return { code: "LOCKED", unlockId };
    if (gates.reputation !== null && gates.reputation < def.minimumReputation) {
      return { code: "REPUTATION_TOO_LOW", required: def.minimumReputation, current: gates.reputation };
    }
    return null;
  };
  const offers =
    offersKnown === null
      ? null
      : { ...offersKnown, value: { ...offersKnown.value, offers: offersKnown.value.offers.map((o) => ({ ...o, blockedBy: offerBlockedBy(o) })) } };
  return { id: buyerId, name: def.name, minimumReputation: def.minimumReputation, wants, budget, offers };
}

function projectPlaces(state: GameState, data: GameData, known: KnownView, gates: Gates): readonly PlayerPlace[] {
  const out: PlayerPlace[] = [];
  for (const location of [...data.locations].sort(byId)) {
    const occupant = occupantAt(state, data, location.id);
    if (occupant === null) continue;
    const geography = { id: location.id, name: location.name, position: { ...location.position } };
    if (occupant.kind === "FACILITY") {
      const facility = state.facilities.find((f) => f.id === occupant.facilityId)!;
      out.push({ ...geography, kind: "FACILITY", facility: projectFacility(state, data, facility, known, gates) });
    } else if (occupant.kind === "SUPPLIER") {
      const def = named(data.suppliers, occupant.supplierId, "supplier");
      out.push({
        ...geography,
        kind: "SUPPLIER",
        supplier: { id: def.id, name: def.name, offer: known.get<"SUPPLIER_OFFER">({ kind: "SUPPLIER_OFFER", supplierId: def.id }) },
      });
    } else {
      out.push({ ...geography, kind: "BUYER", buyer: projectBuyer(data, occupant.buyerId as BuyerId, known, gates) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Contracts and deals
// ---------------------------------------------------------------------------

/** Known outbound trips toward a contract, as the founder knows them (decision 8: `inTransit`). */
function knownTripsToward(state: GameState, known: KnownView, contractId: string) {
  const trips: { readonly id: string; readonly arrivesAt: number; readonly cases: number }[] = [];
  for (const vehicle of state.vehicles) {
    const trip = known.get<"VEHICLE_WHEREABOUTS">({ kind: "VEHICLE_WHEREABOUTS", vehicleId: vehicle.id })?.value.trip ?? null;
    if (trip === null || trip.leg !== "OUTBOUND" || trip.purpose.kind !== "CONTRACT_INSTALLMENT" || trip.purpose.contractId !== contractId) continue;
    trips.push({ id: trip.deliveryId, arrivesAt: trip.arrivesAt, cases: trip.cargo.reduce((n, l) => n + l.quantity, 0) });
  }
  return trips.sort((a, b) => a.arrivesAt - b.arrivesAt || compareIds(a.id, b.id));
}

function projectContracts(state: GameState, data: GameData, known: KnownView): readonly PlayerContract[] {
  return [...state.contracts].sort(byId).map((c) => {
    const progressKnown = known.get<"CONTRACT_PROGRESS">({ kind: "CONTRACT_PROGRESS", contractId: c.id });
    let progress: PlayerContract["progress"] = null;
    if (progressKnown !== null) {
      const known_ = progressKnown.value;
      const inTransit = known_.installments.map(() => 0);
      if (known_.status === "ACTIVE") {
        let projected: readonly Installment[] = known_.installments.map((i) => ({
          deadline: i.deadline,
          required: i.required,
          delivered: i.delivered,
          outcome: i.outcome,
          penalty: i.penalty,
        }));
        for (const trip of knownTripsToward(state, known, c.id)) {
          const credit = creditCases(projected, trip.cases, trip.arrivesAt);
          projected = projected.map((i, k) => ({ ...i, delivered: i.delivered + credit[k]! }));
          credit.forEach((n, k) => (inTransit[k]! += n));
        }
      }
      const installments: InstallmentSnapshot[] = known_.installments.map((i, k) => ({ ...i, inTransit: inTransit[k]! }));
      progress = { ...progressKnown, value: { ...known_, installments } };
    }
    return {
      id: c.id,
      buyerId: c.buyerId,
      productId: c.productId,
      minimumQuality: c.minimumQuality,
      quantityPerInstallment: c.quantityPerInstallment,
      unitPrice: c.unitPrice,
      installmentCount: c.installmentCount,
      intervalTicks: c.intervalTicks,
      penaltyRatePpm: c.penaltyRatePpm,
      buyerName: named(data.buyers, c.buyerId, "buyer").name,
      productName: named(data.products, c.productId, "product").name,
      progress,
    };
  });
}

/**
 * The terms of a deal that has left `heldDeals`, from what the founder did: the
 * deal's own DEAL_AGREED transaction (decision 6 rule 1: the founder's command)
 * gives its ID and the tick it was agreed, and the founder's AGREE_DEAL at that
 * tick (in the command log) gives the terms. In person, a deal commits budget
 * (ADR 0022 decision 6; by phone is ADR 0024's).
 */
function agreedTerms(state: GameState, dealId: DealId, delivery: DeliveryState): Omit<PlayerDeal, "status" | "deliveryId"> | null {
  if (delivery.purpose.kind !== "SALE") return null;
  const buyerId = delivery.purpose.buyerId;
  const agreed = state.ledger.transactions.find((t) => t.idempotencyKey === `DAILY_SETTLEMENT:DEAL_AGREED:${dealId}`);
  if (!agreed) return null;
  for (const envelope of state.commandLog) {
    const command = envelope.command;
    if (envelope.scheduledTick !== agreed.tick || command.type !== "AGREE_DEAL" || command.buyerId !== buyerId) continue;
    return {
      id: dealId,
      buyerId,
      productId: command.productId,
      quality: command.quality,
      quantity: command.quantity,
      unitPrice: command.agreedUnitPrice,
      agreedAt: agreed.tick,
      expiresAt: (agreed.tick + DEAL_HOLD_TICKS) as Tick,
      budgetCommitted: true,
    };
  }
  return null;
}

/**
 * The founder's deals as known (`PlayerDeal`). A deal still in `heldDeals` is an
 * agreement (HELD, or DISPATCHED until it ends), so it's listed as it stands. A
 * deal that has ended in the world stays DISPATCHED until the founder learns how
 * its delivery went: until known VEHICLE_WHEREABOUTS no longer shows that
 * delivery's truck outbound (riding to the stop, a SALE or VEHICLE_RETURN cash
 * posting, or the truck home). Never reads the world's verdict.
 */
function projectDeals(state: GameState, known: KnownView): readonly PlayerDeal[] {
  const deals = new Map<string, PlayerDeal>();
  for (const d of state.heldDeals) {
    if (d.status !== "HELD" && d.status !== "DISPATCHED") continue;
    deals.set(d.id, {
      id: d.id,
      buyerId: d.buyerId,
      productId: d.productId,
      quality: d.quality,
      quantity: d.quantity,
      unitPrice: d.unitPrice,
      agreedAt: d.agreedAt,
      expiresAt: d.expiresAt,
      budgetCommitted: d.budgetCommitted,
      status: d.status,
      deliveryId: d.deliveryId,
    });
  }
  for (const delivery of state.deliveries) {
    if (delivery.purpose.kind !== "SALE" || delivery.purpose.dealId === null || deals.has(delivery.purpose.dealId)) continue;
    const trip = known.get<"VEHICLE_WHEREABOUTS">({ kind: "VEHICLE_WHEREABOUTS", vehicleId: delivery.vehicleId })?.value.trip ?? null;
    if (trip === null || trip.deliveryId !== delivery.id || trip.leg !== "OUTBOUND") continue;
    const terms = agreedTerms(state, delivery.purpose.dealId, delivery);
    if (terms) deals.set(terms.id, { ...terms, status: "DISPATCHED", deliveryId: delivery.id });
  }
  return [...deals.values()].sort(byId);
}

// ---------------------------------------------------------------------------
// Finance (decision 7): the purse and the books as known
// ---------------------------------------------------------------------------

function projectFinance(state: GameState, data: GameData, known: KnownView, observedAt: string | null, standing: Known<KnowledgeValueOf<"STANDING">>, contracts: readonly PlayerContract[]): PlayerFinance {
  // A pending book whose subject is in the live view counts as known now (decision 7).
  const pending = new Set<string>(
    state.knowledge.pendingBooks
      .filter((b) => (b.concerns.kind === "NEWS" ? b.concerns.locationId !== observedAt : !known.isLive(b.concerns)))
      .map((b) => b.transactionId),
  );
  const knownTransactions: LedgerTransaction[] = state.ledger.transactions.filter((t) => t.entries.length > 0 && !pending.has(t.id));
  const books: PlayerBookRow[] = knownTransactions.map((t) => ({
    tick: t.tick,
    kind: t.kind,
    cashFlowCategory: t.entries.some((e) => e.account === "CASH") ? cashFlowCategoryOf(t) : null,
    entries: t.entries.map((e) => ({ ...e })),
  }));
  // Every asset and liability in the known books, PRODUCTION_IN_PROGRESS included (prepaid conversion cost).
  const amount = balanceSheetOf(ledgerBalances(knownTransactions)).equity;
  // Inventory at cost rests on what's known of the stock and of the trucks' loads.
  let asOf: Tick | null = null;
  const consider = (k: { readonly learnedAt: Tick } | null): void => {
    if (k !== null && (asOf === null || k.learnedAt < asOf)) asOf = k.learnedAt;
  };
  for (const f of state.facilities) consider(known.get<"FACILITY_STOCK">({ kind: "FACILITY_STOCK", facilityId: f.id }));
  for (const v of state.vehicles) consider(known.get<"VEHICLE_WHEREABOUTS">({ kind: "VEHICLE_WHEREABOUTS", vehicleId: v.id }));
  const { victory } = data.progression;
  return {
    cash: cashBalance(state),
    books,
    knownNetWorth: { amount, asOf },
    victory: {
      netWorth: { current: amount, target: victory.netWorth },
      // Never known: 0 until STANDING is first learned (it is on the first waking).
      reputation: { current: standing?.value.reputation ?? 0, target: victory.reputation },
      completedContracts: { current: contracts.filter((c) => c.progress?.value.status === "COMPLETED").length, target: victory.completedContracts },
    },
  };
}

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

export function projectPlayerSnapshot(state: GameState, ctx: ProjectionContext, deps: PlayerProjectionDeps): PlayerSnapshot {
  const { data } = deps;
  const t = state.tick;
  const known = new KnownView(state, liveView(state, data, t, !deps.founderRules));
  const observedAt = deps.founderRules ? observation(state, t).locationId : null;
  const standing = known.get<"STANDING">({ kind: "STANDING" });
  const next = (t + 1) as Tick;
  const gates: Gates = {
    busy: deps.founderRules ? busyRejection(state, next) : null,
    unlocked: standing?.value.unlocked ?? null,
    reputation: standing?.value.reputation ?? null,
    cash: cashBalance(state),
    next,
  };
  const routes: PlayerRoute[] = [...state.routes]
    .sort(byId)
    .map((r) => ({ ...routeGeography(data, r.id), condition: known.get<"ROUTE_CONDITION">({ kind: "ROUTE_CONDITION", routeId: r.id }) }));
  const vehicles: PlayerVehicle[] = [...state.vehicles].sort(byId).map((v) => {
    const def = named(data.vehicles, v.id, "vehicle");
    return {
      id: v.id,
      name: def.name,
      capacity: def.capacityCases,
      homeLocationId: named(data.facilities, def.homeFacilityId, "facility").locationId,
      whereabouts: known.get<"VEHICLE_WHEREABOUTS">({ kind: "VEHICLE_WHEREABOUTS", vehicleId: v.id }),
    };
  });
  const contracts = projectContracts(state, data, known);
  const w = state.founder.whereabouts;
  return {
    clock: ctx.clock,
    outcome: state.outcome,
    founder: projectFounder(state, data),
    here: w.kind === "PRESENT" ? w.locationId : null,
    places: projectPlaces(state, data, known, gates),
    routes,
    vehicles,
    market: known.get<"MARKET_PRICES">({ kind: "MARKET_PRICES" }),
    standing,
    contracts,
    deals: projectDeals(state, known),
    finance: projectFinance(state, data, known, observedAt, standing, contracts),
    activity: state.knowledge.activity,
    catchUp: state.knowledge.lastCatchUp,
  };
}

