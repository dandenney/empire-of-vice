// The live view (ADR 0021 decision 5; ADR 0023 decisions 2 and 6): what the
// founder sees by being somewhere, read from the world at that moment.
//
// - Where the founder observes: PRESENT at a place, or a delivery stop on its
//   tick (ADR 0023 decision 2). Not while travelling, riding between stops, or
//   resting.
// - At that place: the facility, supplier or buyer there (every subject kind
//   KNOWLEDGE_VISIBILITY.IN_PERSON allows for its party kind), vehicles parked
//   there, ROUTE_CONDITION for the place's LIVE_VIEW_ROUTES, CONTRACT_PROGRESS
//   and CONTRACT_OFFERS for the buyer there, MARKET_PRICES at a buyer or
//   supplier, and STANDING.
// - At a closed place (ADR 0023 decision 6) only what's visible from the road:
//   the routes and parked vehicles. Not the party's subjects, MARKET_PRICES or
//   STANDING.
// - At a delivery stop the delivery's own subjects are seen too, whatever the
//   hours: the truck's VEHICLE_WHEREABOUTS, and CONTRACT_PROGRESS for an
//   installment (ADR 0023 decision 6, "Deliveries arrive any hour").
// - A route's condition is live while the founder travels it: the leg under way
//   (TRAVELLING), or the delivery's route (ON_DELIVERY).
//
// With founder rules off (M001, the lab) the whole world is the live view
// (ADR 0022 decision 2's lab mode), so the player snapshot equals the world's.
//
// Values are observed data only (decision 4): projections of world state, never
// affordances.

import {
  compareKnowledgeSubjects,
  knowledgeSubjectKey,
  type DeliveryState,
  type GameState,
  type KnowledgeSource,
  type KnowledgeSubject,
  type KnowledgeValue,
  type LocationId,
  type LocationOccupant,
  type PartyKind,
  type RouteId,
  type Tick,
} from "@eov/contracts";
import { KNOWLEDGE_VISIBILITY, LIVE_VIEW_ROUTES, type GameData } from "@eov/game-data";
import { isOpenAt } from "../founder/time.ts";
import { storageUsed } from "../inventory/pools.ts";
import { facilityStock, marketProducts, projectJobs, projectWashes, routeStatus, supplierMaterials, vehicleTrip } from "../projection/snapshot.ts";

/** A subject with its current world value, as the live view shows it. */
export interface LiveEntry {
  readonly subject: KnowledgeSubject;
  readonly value: KnowledgeValue;
  readonly source: KnowledgeSource;
}

/** Where, and how much, the founder observes at one tick. */
export interface Observation {
  /** Present at, or a delivery stop on its tick; null otherwise. */
  readonly locationId: LocationId | null;
  /** The delivery whose stop the founder observes, if any. */
  readonly stop: DeliveryState | null;
  /** Routes whose condition is live, besides the place's own. */
  readonly travelledRouteIds: readonly RouteId[];
}

const IN_PERSON = KNOWLEDGE_VISIBILITY.IN_PERSON;

/** What occupies a location in this game: an owned facility, a supplier, a buyer, or nothing. */
export type Occupant = LocationOccupant | null;

export function occupantAt(state: GameState, data: GameData, locationId: LocationId): Occupant {
  const facility = state.facilities.find((f) => data.facilities.find((d) => d.id === f.id)?.locationId === locationId);
  if (facility) return { kind: "FACILITY", facilityId: facility.id };
  const supplier = state.suppliers.find((s) => data.suppliers.find((d) => d.id === s.id)?.locationId === locationId);
  if (supplier) return { kind: "SUPPLIER", supplierId: supplier.id };
  const buyer = state.buyers.find((b) => data.buyers.find((d) => d.id === b.id)?.locationId === locationId);
  if (buyer) return { kind: "BUYER", buyerId: buyer.id };
  return null;
}

export function facilityLocation(data: GameData, facilityId: string): LocationId {
  const def = data.facilities.find((f) => f.id === facilityId);
  if (!def) throw new RangeError(`Knowledge: unknown facility ${facilityId}`);
  return def.locationId;
}

export function buyerLocation(data: GameData, buyerId: string): LocationId {
  const def = data.buyers.find((b) => b.id === buyerId);
  if (!def) throw new RangeError(`Knowledge: unknown buyer ${buyerId}`);
  return def.locationId;
}

/** Where the founder observes at `t`, from the always-known founder state. */
export function observation(state: GameState, t: Tick): Observation {
  const w = state.founder.whereabouts;
  switch (w.kind) {
    case "PRESENT":
      return { locationId: w.locationId, stop: null, travelledRouteIds: [] };
    case "TRAVELLING": {
      const leg = w.path[w.legIndex];
      return { locationId: null, stop: null, travelledRouteIds: leg ? [leg.routeId] : [] };
    }
    case "ON_DELIVERY": {
      const delivery = state.deliveries.find((d) => d.id === w.deliveryId) ?? null;
      const routes = delivery ? [delivery.routeId] : [];
      if (w.atStop !== null && w.atStop.tick === t) return { locationId: w.atStop.locationId, stop: delivery, travelledRouteIds: routes };
      return { locationId: null, stop: null, travelledRouteIds: routes };
    }
    case "RESTING":
      return { locationId: null, stop: null, travelledRouteIds: [] };
  }
}

/** Without repeats, in record order (decision 4). The lists are short: one place's subjects. */
function sortSubjects(subjects: readonly KnowledgeSubject[]): readonly KnowledgeSubject[] {
  const keys = new Set<string>();
  const out: KnowledgeSubject[] = [];
  for (const s of subjects) {
    const key = subjectKey(s);
    if (keys.has(key)) continue;
    keys.add(key);
    out.push(s);
  }
  return out.length > 1 ? out.sort(compareKnowledgeSubjects) : out;
}

/** The subjects that belong to a place (ADR 0021 decision 5), as its party kind allows, with the closed-hours filter. */
function placeSubjects(state: GameState, data: GameData, locationId: LocationId, t: Tick): readonly KnowledgeSubject[] {
  const occupant = occupantAt(state, data, locationId);
  const partyKind: PartyKind = occupant?.kind ?? "FACILITY";
  const allowed = new Set(IN_PERSON[partyKind]);
  // Your own facilities never close; a closed party shows only what the road shows (ADR 0023 decision 6).
  const open = occupant === null || occupant.kind === "FACILITY" || isOpenAt(locationId, t);
  const out: KnowledgeSubject[] = [];
  if (occupant?.kind === "FACILITY") {
    out.push({ kind: "FACILITY_STOCK", facilityId: occupant.facilityId }, { kind: "FACILITY_OPERATIONS", facilityId: occupant.facilityId });
  } else if (occupant?.kind === "SUPPLIER" && open) {
    out.push({ kind: "SUPPLIER_OFFER", supplierId: occupant.supplierId }, { kind: "MARKET_PRICES" });
  } else if (occupant?.kind === "BUYER" && open) {
    const buyerId = occupant.buyerId;
    out.push({ kind: "BUYER_WANTS", buyerId }, { kind: "BUYER_BUDGET", buyerId }, { kind: "CONTRACT_OFFERS", buyerId }, { kind: "MARKET_PRICES" });
    for (const c of state.contracts) if (c.buyerId === buyerId) out.push({ kind: "CONTRACT_PROGRESS", contractId: c.id });
  }
  if (open) out.push({ kind: "STANDING" });
  for (const v of state.vehicles) if (v.parkedAt === locationId) out.push({ kind: "VEHICLE_WHEREABOUTS", vehicleId: v.id });
  for (const routeId of LIVE_VIEW_ROUTES.find((e) => e.locationId === locationId)?.routeIds ?? []) {
    if (state.routes.some((r) => r.id === routeId)) out.push({ kind: "ROUTE_CONDITION", routeId });
  }
  return out.filter((s) => allowed.has(s.kind));
}

// The tick-end persist works these out every tick the founder is somewhere, so
// they're memoised on the immutable state slices they read. A cache hit returns
// the same result the computation would; it changes nothing but speed.

interface SubjectsMemo {
  readonly deps: readonly unknown[];
  readonly subjects: readonly KnowledgeSubject[];
}
const subjectsMemo = new WeakMap<object, SubjectsMemo>();

/** The live view's subjects for an observation at `t`. */
export function liveSubjects(state: GameState, data: GameData, obs: Observation, t: Tick): readonly KnowledgeSubject[] {
  const deps = [
    data,
    obs.locationId,
    obs.locationId !== null && isOpenAt(obs.locationId, t),
    obs.stop,
    state.vehicles,
    state.contracts,
    state.routes,
    state.facilities,
    state.suppliers,
    state.buyers,
  ];
  const memo = subjectsMemo.get(state.founder);
  if (memo && memo.deps.every((d, i) => d === deps[i])) return memo.subjects;
  const subjects = computeLiveSubjects(state, data, obs, t);
  subjectsMemo.set(state.founder, { deps, subjects });
  return subjects;
}

function computeLiveSubjects(state: GameState, data: GameData, obs: Observation, t: Tick): readonly KnowledgeSubject[] {
  const out: KnowledgeSubject[] = [];
  if (obs.locationId !== null) out.push(...placeSubjects(state, data, obs.locationId, t));
  if (obs.stop !== null) {
    // The hand-over: the delivery's own subjects, whatever the hours.
    out.push({ kind: "VEHICLE_WHEREABOUTS", vehicleId: obs.stop.vehicleId });
    if (obs.stop.purpose.kind === "CONTRACT_INSTALLMENT") out.push({ kind: "CONTRACT_PROGRESS", contractId: obs.stop.purpose.contractId });
  }
  for (const routeId of obs.travelledRouteIds) if (state.routes.some((r) => r.id === routeId)) out.push({ kind: "ROUTE_CONDITION", routeId });
  return sortSubjects(out);
}

/** Every subject the world has, for the lab mode (founder rules off). */
export function allSubjects(state: GameState): readonly KnowledgeSubject[] {
  const out: KnowledgeSubject[] = [];
  for (const f of state.facilities) out.push({ kind: "FACILITY_STOCK", facilityId: f.id }, { kind: "FACILITY_OPERATIONS", facilityId: f.id });
  for (const s of state.suppliers) out.push({ kind: "SUPPLIER_OFFER", supplierId: s.id });
  for (const b of state.buyers) {
    out.push({ kind: "BUYER_WANTS", buyerId: b.id }, { kind: "BUYER_BUDGET", buyerId: b.id }, { kind: "CONTRACT_OFFERS", buyerId: b.id });
  }
  for (const c of state.contracts) out.push({ kind: "CONTRACT_PROGRESS", contractId: c.id });
  out.push({ kind: "MARKET_PRICES" }, { kind: "STANDING" });
  for (const r of state.routes) out.push({ kind: "ROUTE_CONDITION", routeId: r.id });
  for (const v of state.vehicles) out.push({ kind: "VEHICLE_WHEREABOUTS", vehicleId: v.id });
  return sortSubjects(out);
}

/** The location a subject belongs to, for the lab mode's IN_PERSON source. Null for the place-less kinds. */
function subjectLocation(state: GameState, data: GameData, subject: KnowledgeSubject): LocationId | null {
  switch (subject.kind) {
    case "FACILITY_STOCK":
    case "FACILITY_OPERATIONS":
      return facilityLocation(data, subject.facilityId);
    case "SUPPLIER_OFFER":
      return data.suppliers.find((s) => s.id === subject.supplierId)?.locationId ?? null;
    case "BUYER_WANTS":
    case "BUYER_BUDGET":
    case "CONTRACT_OFFERS":
      return buyerLocation(data, subject.buyerId);
    case "CONTRACT_PROGRESS": {
      const contract = state.contracts.find((c) => c.id === subject.contractId);
      return contract ? buyerLocation(data, contract.buyerId) : null;
    }
    case "ROUTE_CONDITION":
      return data.routes.find((r) => r.id === subject.routeId)?.fromLocationId ?? null;
    case "VEHICLE_WHEREABOUTS":
      return state.vehicles.find((v) => v.id === subject.vehicleId)?.parkedAt ?? null;
    case "EMPLOYEE_PERFORMANCE": {
      // A facility-party subject of the employee's station (ADR 0025 decision 8).
      const employee = state.employees.find((e) => e.characterId === subject.characterId);
      return employee ? facilityLocation(data, employee.stationId) : null;
    }
    case "MARKET_PRICES":
    case "STANDING":
      return null;
  }
}

// ---------------------------------------------------------------------------
// World values (decision 4: observed data only)
// ---------------------------------------------------------------------------

/** A subject's value in the world now: what any channel copies when it delivers that subject. */
export function worldValue(state: GameState, data: GameData, subject: KnowledgeSubject): KnowledgeValue {
  const deps = valueDeps(state, data, subject);
  const key = subjectKey(subject);
  let byKey = valueMemo.get(deps[0]!);
  const memo = byKey?.get(key);
  if (memo && memo.deps.every((d, i) => d === deps[i])) return memo.value;
  const value = computeWorldValue(state, data, subject);
  if (!byKey) {
    byKey = new Map();
    valueMemo.set(deps[0]!, byKey);
  }
  byKey.set(key, { deps, value });
  return value;
}

const valueMemo = new WeakMap<object, Map<string, { readonly deps: readonly object[]; readonly value: KnowledgeValue }>>();

/** The state slices (and game-data) a subject's value is projected from, first the one memoised on. */
function valueDeps(state: GameState, data: GameData, subject: KnowledgeSubject): readonly object[] {
  switch (subject.kind) {
    case "FACILITY_STOCK":
      return [state.productPools, state.materialPools, state.reservations, data];
    case "FACILITY_OPERATIONS":
      return [state.productionJobs, state.washes, state.facilities, data];
    case "SUPPLIER_OFFER":
      return [state.suppliers, data];
    case "BUYER_WANTS":
      return [state.buyers, state.family, data];
    case "BUYER_BUDGET":
      return [state.buyers, data];
    case "CONTRACT_OFFERS":
      return [state.contractOffers, data];
    case "CONTRACT_PROGRESS":
      return [state.contracts, data];
    case "MARKET_PRICES":
      return [state.markets, data];
    case "ROUTE_CONDITION":
      return [state.routes, data];
    case "VEHICLE_WHEREABOUTS":
      return [state.vehicles, state.deliveries, data];
    case "STANDING":
      return [state.family, data];
    case "EMPLOYEE_PERFORMANCE":
      return [state.employees, data];
  }
}

function computeWorldValue(state: GameState, data: GameData, subject: KnowledgeSubject): KnowledgeValue {
  switch (subject.kind) {
    case "FACILITY_STOCK": {
      const { products, materials } = facilityStock(state, data, subject.facilityId);
      return { kind: "FACILITY_STOCK", facilityId: subject.facilityId, products, materials, storageUsed: storageUsed(state, subject.facilityId) };
    }
    case "FACILITY_OPERATIONS": {
      const facility = state.facilities.find((f) => f.id === subject.facilityId);
      return {
        kind: "FACILITY_OPERATIONS",
        facilityId: subject.facilityId,
        jobs: projectJobs(state, data).filter((j) => j.facilityId === subject.facilityId),
        workersPresent: facility?.workerCount ?? 0,
        // ADR 0029 decision 8: the full barrels there. Always [] until TS2 (#244) sets mashes.
        washes: projectWashes(state, data).filter((w) => w.facilityId === subject.facilityId),
      };
    }
    case "SUPPLIER_OFFER":
      return { kind: "SUPPLIER_OFFER", supplierId: subject.supplierId, materials: supplierMaterials(state, data, subject.supplierId) };
    case "BUYER_WANTS": {
      const buyer = state.buyers.find((b) => b.id === subject.buyerId);
      const def = data.buyers.find((b) => b.id === subject.buyerId);
      if (!buyer || !def) throw new RangeError(`Knowledge: unknown buyer ${subject.buyerId}`);
      return {
        kind: "BUYER_WANTS",
        buyerId: subject.buyerId,
        willDeal: state.family.reputation >= def.minimumReputation,
        wants: buyer.wants.map((w) => ({
          productId: w.productId,
          productName: data.products.find((p) => p.id === w.productId)?.name ?? w.productId,
          minimumQuality: w.minimumQuality,
          unitPrice: w.unitPrice,
          demandRemaining: w.demandRemaining,
        })),
      };
    }
    case "BUYER_BUDGET": {
      const buyer = state.buyers.find((b) => b.id === subject.buyerId);
      if (!buyer) throw new RangeError(`Knowledge: unknown buyer ${subject.buyerId}`);
      return { kind: "BUYER_BUDGET", buyerId: subject.buyerId, budgetRemaining: buyer.budgetRemaining };
    }
    case "CONTRACT_OFFERS":
      return {
        kind: "CONTRACT_OFFERS",
        buyerId: subject.buyerId,
        offers: state.contractOffers
          .filter((o) => o.buyerId === subject.buyerId)
          .map((o) => ({
            ...o,
            buyerName: data.buyers.find((b) => b.id === o.buyerId)?.name ?? o.buyerId,
            productName: data.products.find((p) => p.id === o.productId)?.name ?? o.productId,
          })),
      };
    case "CONTRACT_PROGRESS": {
      const contract = state.contracts.find((c) => c.id === subject.contractId);
      if (!contract) throw new RangeError(`Knowledge: unknown contract ${subject.contractId}`);
      return {
        kind: "CONTRACT_PROGRESS",
        contractId: subject.contractId,
        status: contract.status,
        installments: contract.installments.map((i, index) => ({
          index,
          deadline: i.deadline,
          required: i.required,
          delivered: i.delivered,
          outcome: i.outcome,
          penalty: i.penalty,
        })),
      };
    }
    case "MARKET_PRICES":
      return { kind: "MARKET_PRICES", products: marketProducts(state, data) };
    case "ROUTE_CONDITION":
      return { kind: "ROUTE_CONDITION", routeId: subject.routeId, status: routeStatus(state, subject.routeId) };
    case "VEHICLE_WHEREABOUTS": {
      const vehicle = state.vehicles.find((v) => v.id === subject.vehicleId);
      if (!vehicle) throw new RangeError(`Knowledge: unknown vehicle ${subject.vehicleId}`);
      return { kind: "VEHICLE_WHEREABOUTS", vehicleId: vehicle.id, parkedAt: vehicle.parkedAt, trip: vehicleTrip(state, vehicle) };
    }
    case "STANDING":
      return { kind: "STANDING", reputation: state.family.reputation, tierId: state.family.tierId, unlocked: [...state.family.unlocked] };
    case "EMPLOYEE_PERFORMANCE": {
      // ADR 0025 decision 8: the true competence once batchesRun reaches the reveal count.
      const employee = state.employees.find((e) => e.characterId === subject.characterId);
      if (!employee) throw new RangeError(`Knowledge: unknown employee ${subject.characterId}`);
      const { batchesRun } = employee.work;
      const revealed = batchesRun >= data.personnel.competenceRevealBatches;
      return { kind: "EMPLOYEE_PERFORMANCE", characterId: employee.characterId, batchesRun, competence: revealed ? employee.competence : null };
    }
  }
}

/**
 * The live view at `t`: each subject with its world value and an IN_PERSON
 * source at the place observed (or, for a route travelled between places, the
 * route's start). With `omniscient` (founder rules off) every subject, each
 * sourced at its own place.
 */
export function liveView(state: GameState, data: GameData, t: Tick, omniscient: boolean): readonly LiveEntry[] {
  if (omniscient) {
    const here = state.founder.whereabouts.kind === "PRESENT" ? state.founder.whereabouts.locationId : null;
    return allSubjects(state).map((subject) => {
      const at = subjectLocation(state, data, subject) ?? here ?? data.locations[0]!.id;
      return { subject, value: worldValue(state, data, subject), source: { kind: "IN_PERSON", locationId: at } };
    });
  }
  const obs = observation(state, t);
  return liveEntries(state, data, obs, liveSubjects(state, data, obs, t));
}

/** The live view's entries for subjects already worked out (`liveSubjects`). */
export function liveEntries(state: GameState, data: GameData, obs: Observation, subjects: readonly KnowledgeSubject[]): readonly LiveEntry[] {
  return subjects.map((subject) => {
    let at = obs.locationId;
    if (at === null && subject.kind === "ROUTE_CONDITION") at = data.routes.find((r) => r.id === subject.routeId)!.fromLocationId;
    return { subject, value: worldValue(state, data, subject), source: { kind: "IN_PERSON", locationId: at! } };
  });
}

/** A subject's identity as one string: its kind and key. */
export function subjectKey(subject: KnowledgeSubject): string {
  let key = keyMemo.get(subject);
  if (key === undefined) {
    key = `${subject.kind}|${knowledgeSubjectKey(subject)}`;
    keyMemo.set(subject, key);
  }
  return key;
}

const keyMemo = new WeakMap<KnowledgeSubject, string>();

export function sameSubject(a: KnowledgeSubject, b: KnowledgeSubject): boolean {
  return a.kind === b.kind && knowledgeSubjectKey(a) === knowledgeSubjectKey(b);
}
