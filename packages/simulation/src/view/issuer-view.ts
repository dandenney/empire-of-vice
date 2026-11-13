// The issuer's view (ADR 0022 decision 2): everything an order's immediate
// check may read. Validators take an IssuerView, never GameState.
//
// `PlayerView` is the founder's: knowledge, the always-known state and the live
// view (ADR 0021 decisions 3–5, ADR 0023 decisions 2 and 6). Its `world` is the
// world masked to exactly that:
//
// - Always known: the clock, the founder, the purse and the books (`ledger`),
//   the founder's own commands (`commandLog`), their agreements (HELD deals, the
//   contracts they accepted, the facilities and vehicles they own), the routes
//   and places that exist, and the knowledge records.
// - The live view, at the place the founder is PRESENT (only PRESENT counts for
//   commands, ADR 0023 decision 2): the facility there (its equipment, crew,
//   stock, reservations and jobs), the vehicles parked there, the routes in its
//   LIVE_VIEW_ROUTES, and, while the party there is open at the apply tick, the
//   supplier or buyer there (with its contract offers and the progress of its
//   contracts) and STANDING. A closed party shows only what the road shows.
// - Everything else is what the records say: a contract's progress from its
//   CONTRACT_PROGRESS record, a route's condition from its ROUTE_CONDITION
//   record, STANDING from its record, a vehicle's trip from its
//   VEHICLE_WHEREABOUTS record, and the contract offers the founder has seen.
//   Without a record: the contract as accepted, the route open, no standing.
//   Places the founder isn't at hold nothing (no stock, no wants, no offers).
//
// With `founderRules: false` (the lab's M001 mode) the whole world is the live
// view, so `world` is the world itself: one validation path (decision 2).

import {
  type CommandIssuer,
  type ContractState,
  type FamilyState,
  type GameState,
  type LocationId,
  type RouteState,
  type Tick,
  type VehicleState,
} from "@eov/contracts";
import { LIVE_VIEW_ROUTES, type GameData } from "@eov/game-data";
import { isOpenAt } from "../founder/time.ts";
import type { GameRules } from "../kernel/rules.ts";
import { findRecord } from "../knowledge/records.ts";
import { occupantAt, worldValue } from "../knowledge/view.ts";
import type { KnownOffer, KnownTrip, ViewWorld } from "./world.ts";

/** What a validator may read (ADR 0022 decision 2). None of it is, or returns, a GameState. */
export interface IssuerView {
  readonly issuer: CommandIssuer;
  /** The tick the command applies at (`state.tick + 1` for an eager command). */
  readonly at: Tick;
  /** The scenario's founder rules (ADR 0023 decision 9): off, the view is the whole world and nothing is presence-gated. */
  readonly founderRules: boolean;
  /** Where the issuer is PRESENT, or null (travelling, riding or resting; ADR 0023 decision 2). */
  readonly here: LocationId | null;
  /** The world as the issuer sees it: knowledge, the always-known state and the live view, masked. */
  readonly world: ViewWorld;
}

/** The founder's view (ADR 0022 decision 2). */
export interface PlayerView extends IssuerView {
  readonly issuer: { readonly kind: "FOUNDER" };
}

const FOUNDER: { readonly kind: "FOUNDER" } = { kind: "FOUNDER" };

/**
 * Builds the founder's view of `state` for a command applied at `at`
 * (`state.tick + 1` for an eager command). Pure: reads only its arguments and
 * changes nothing.
 */
export function playerViewOf(state: GameState, data: GameData, rules: GameRules, at: Tick): PlayerView {
  const w = state.founder.whereabouts;
  const here = w.kind === "PRESENT" ? w.locationId : null;
  const world = rules.founderRules ? maskedWorld(state, data, here, at) : wholeWorld(state);
  return { issuer: FOUNDER, at, founderRules: rules.founderRules, here, world };
}

// ---------------------------------------------------------------------------
// Founder rules off: the whole world
// ---------------------------------------------------------------------------

const wholeMemo = new WeakMap<GameState, ViewWorld>();

function wholeWorld(state: GameState): ViewWorld {
  const memo = wholeMemo.get(state);
  if (memo) return memo;
  const trips: KnownTrip[] = [];
  for (const d of state.deliveries) {
    if (d.status !== "OUTBOUND") continue;
    trips.push({ deliveryId: d.id, purpose: d.purpose, cases: d.cargo.reduce((n, line) => n + line.quantity, 0) });
  }
  const world: ViewWorld = {
    ...slice(state),
    knownOffers: state.contractOffers.map((o) => ({ id: o.id, buyerId: o.buyerId })),
    trips,
  };
  wholeMemo.set(state, world);
  return world;
}

function slice(state: GameState): Omit<ViewWorld, "knownOffers" | "trips"> {
  return {
    tick: state.tick,
    founder: state.founder,
    family: state.family,
    facilities: state.facilities,
    productPools: state.productPools,
    materialPools: state.materialPools,
    reservations: state.reservations,
    productionJobs: state.productionJobs,
    vehicles: state.vehicles,
    heldDeals: state.heldDeals,
    buyers: state.buyers,
    suppliers: state.suppliers,
    contractOffers: state.contractOffers,
    contracts: state.contracts,
    routes: state.routes,
    ledger: state.ledger,
    commandLog: state.commandLog,
    knowledge: state.knowledge,
  };
}

// ---------------------------------------------------------------------------
// Founder rules on: the founder's view
// ---------------------------------------------------------------------------

function maskedWorld(state: GameState, data: GameData, here: LocationId | null, at: Tick): ViewWorld {
  const occupant = here === null ? null : occupantAt(state, data, here);
  // Your own facilities never close; a party is seen only while it's open (ADR 0023 decision 6).
  const open = here !== null && (occupant === null || occupant.kind === "FACILITY" || isOpenAt(here, at));
  const facilityHere = occupant?.kind === "FACILITY" ? occupant.facilityId : null;
  const supplierHere = open && occupant?.kind === "SUPPLIER" ? occupant.supplierId : null;
  const buyerHere = open && occupant?.kind === "BUYER" ? occupant.buyerId : null;
  const liveRoutes = new Set(here === null ? [] : (LIVE_VIEW_ROUTES.find((e) => e.locationId === here)?.routeIds ?? []));
  const knowledge = state.knowledge;

  const contractOffers = buyerHere === null ? [] : state.contractOffers.filter((o) => o.buyerId === buyerHere);
  const knownOffers: KnownOffer[] = contractOffers.map((o) => ({ id: o.id, buyerId: o.buyerId }));
  for (const record of knowledge.records) {
    if (record.value.kind !== "CONTRACT_OFFERS" || record.value.buyerId === buyerHere) continue;
    for (const o of record.value.offers) knownOffers.push({ id: o.id, buyerId: o.buyerId });
  }

  const vehicles = state.vehicles.map((v): VehicleState => (here !== null && v.parkedAt === here ? v : { id: v.id, parkedAt: null, tripCount: 0, trip: null }));
  const trips: KnownTrip[] = [];
  for (const v of state.vehicles) {
    const subject = { kind: "VEHICLE_WHEREABOUTS", vehicleId: v.id } as const;
    const value = here !== null && v.parkedAt === here ? worldValue(state, data, subject) : (findRecord(knowledge, subject)?.value ?? null);
    const trip = value?.kind === "VEHICLE_WHEREABOUTS" ? value.trip : null;
    if (trip === null || trip.leg !== "OUTBOUND") continue;
    trips.push({ deliveryId: trip.deliveryId, purpose: trip.purpose, cases: trip.cargo.reduce((n, line) => n + line.quantity, 0) });
  }

  return {
    tick: state.tick,
    founder: state.founder,
    family: knownFamily(state, open),
    facilities: state.facilities.map((f) => (f.id === facilityHere ? f : { id: f.id, equipment: [], workerCount: 0, phoneLine: f.phoneLine })),
    productPools: state.productPools.filter((p) => p.facilityId === facilityHere),
    materialPools: state.materialPools.filter((p) => p.facilityId === facilityHere),
    reservations: state.reservations.filter((r) => r.facilityId === facilityHere),
    productionJobs: state.productionJobs.filter((j) => j.facilityId === facilityHere),
    vehicles,
    // A HELD deal is an agreement, always known; what became of a dispatched one isn't (ADR 0022 decision 6).
    heldDeals: state.heldDeals.filter((d) => d.status === "HELD"),
    buyers: state.buyers.map((b) => (b.id === buyerHere ? b : { id: b.id, budgetRemaining: 0 as typeof b.budgetRemaining, wants: [], commitments: [] })),
    suppliers: state.suppliers.map((s) => (s.id === supplierHere ? s : { id: s.id, stock: [] })),
    contractOffers,
    contracts: state.contracts.map((c) => (c.buyerId === buyerHere ? c : knownContract(state, c))),
    routes: state.routes.map((r) => (liveRoutes.has(r.id) ? r : knownRoute(state, r))),
    ledger: state.ledger,
    commandLog: state.commandLog,
    knowledge,
    knownOffers,
    trips,
  };
}

/** STANDING: live where the founder is at an open place (or their own facility), else the record. */
function knownFamily(state: GameState, visible: boolean): FamilyState {
  if (visible) return state.family;
  const record = findRecord(state.knowledge, { kind: "STANDING" })?.value;
  const standing = record?.kind === "STANDING" ? record : null;
  return {
    id: state.family.id,
    reputation: standing?.reputation ?? 0,
    tierId: standing?.tierId ?? state.family.tierId,
    unlocked: standing?.unlocked ?? [],
    firstQualifyingDeliveryMade: false,
    consecutiveFulfilledInstallments: 0,
  };
}

/** A contract away from its buyer: its terms (an agreement) with the progress the founder knows (ADR 0022 decision 6). */
function knownContract(state: GameState, contract: ContractState): ContractState {
  const record = findRecord(state.knowledge, { kind: "CONTRACT_PROGRESS", contractId: contract.id })?.value;
  if (record?.kind === "CONTRACT_PROGRESS") {
    return {
      ...contract,
      status: record.status,
      installments: record.installments.map((i) => ({ deadline: i.deadline, required: i.required, delivered: i.delivered, outcome: i.outcome, penalty: i.penalty })),
      reservationIds: [],
    };
  }
  // Never seen since it was accepted: as accepted.
  return {
    ...contract,
    status: "ACTIVE",
    installments: contract.installments.map((i) => ({ deadline: i.deadline, required: i.required, delivered: 0, outcome: null, penalty: null })),
    reservationIds: [],
  };
}

/** A route outside the live view: its ROUTE_CONDITION record, or open if the founder knows nothing of it. */
function knownRoute(state: GameState, route: RouteState): RouteState {
  const record = findRecord(state.knowledge, { kind: "ROUTE_CONDITION", routeId: route.id })?.value;
  if (record?.kind !== "ROUTE_CONDITION" || record.status.open) return { id: route.id, closure: null };
  return { id: route.id, closure: { reason: record.status.reason, reopensAt: record.status.reopensAt } };
}
