// The player snapshot: what the worker publishes to the game UI under the
// knowledge model. See docs/decisions/0021-knowledge-model.md (decisions 2, 3, 8).
//
// Built only from `GameState.knowledge`, the always-known state (the clock, the
// outcome, the founder, the purse, agreements the founder made, geography), and
// the live view of the founder's current place. Never from the rest of the world.
// The world snapshot (`GameSnapshot`, ADR 0007) stays for the lab, tests and a
// dev-only debug view.
//
// Follows ADR 0007's rules: plain data, no optional fields, lists sorted with
// `compareIds`, self-contained. Every affordance (`blockedBy`,
// `maxStartableQuantity`, `maxAcceptableQuantity`, quotes, `inTransit`) is
// recomputed from known values, never read from the world. Raw
// simulation-created IDs are command handles only; the UI never shows them.
//
// The founder section (ADR 0023) is added by its own contract task (P1).

import type { WorldPoint } from "./geometry.ts";
import type { BuyerId, ContractId, LocationId, SupplierId } from "./ids.ts";
import type { ActivityItem, CatchUp, Known, KnowledgeValueOf } from "./knowledge.ts";
import type { LedgerEntry, TransactionKind } from "./ledger.ts";
import type { Money } from "./money.ts";
import type {
  BuyerWant,
  CashFlowCategory,
  ClockSnapshot,
  ContractOfferSnapshot,
  ContractTerms,
  FacilitySnapshot,
  GameOutcome,
  InstallmentSnapshot,
  RouteSnapshot,
  VehicleSnapshot,
  VictoryProgress,
} from "./snapshot.ts";
import type { Tick } from "./time.ts";

export interface PlayerSnapshot {
  /** Always known (decision 3). */
  readonly clock: ClockSnapshot;
  /** Always known; evaluated on the world, the one accepted exception to the non-leak property (decision 9). */
  readonly outcome: GameOutcome;
  /** The place the founder is at, or null while travelling. Its values in `places` are the live view (decision 5). */
  readonly here: LocationId | null;
  /** Every location, sorted by ID. */
  readonly places: readonly PlayerPlace[];
  /** Every route, sorted by ID. */
  readonly routes: readonly PlayerRoute[];
  /** Owned vehicles, sorted by ID. */
  readonly vehicles: readonly PlayerVehicle[];
  readonly market: Known<KnowledgeValueOf<"MARKET_PRICES">>;
  readonly standing: Known<KnowledgeValueOf<"STANDING">>;
  /** Contracts the founder agreed, sorted by ID. Offers come through `places`. */
  readonly contracts: readonly PlayerContract[];
  readonly finance: PlayerFinance;
  /** `knowledge.activity`: what the founder saw or was told, newest last. Replaces `recentEvents`. */
  readonly activity: readonly ActivityItem[];
  /** `knowledge.lastCatchUp`. */
  readonly catchUp: CatchUp | null;
}

// ---------------------------------------------------------------------------
// Places: geography (always known) plus a Known value per subject
// ---------------------------------------------------------------------------

interface PlaceGeography {
  readonly id: LocationId;
  readonly name: string;
  readonly position: WorldPoint;
}

export type PlayerPlace = FacilityPlace | SupplierPlace | BuyerPlace;

export interface FacilityPlace extends PlaceGeography {
  readonly kind: "FACILITY";
  readonly facility: PlayerFacility;
}

/**
 * An owned facility. Equipment, workforce and capacity are agreements the
 * founder made (always known). `equipmentOptions` and `recipes` carry
 * affordances recomputed from known stock and the purse.
 */
export interface PlayerFacility
  extends Pick<
    FacilitySnapshot,
    "id" | "name" | "kind" | "equipment" | "equipmentSlots" | "equipmentOptions" | "workforce" | "productionCapacityPerDay" | "recipes"
  > {
  readonly storageCapacity: number;
  readonly stock: Known<KnowledgeValueOf<"FACILITY_STOCK">>;
  readonly operations: Known<KnowledgeValueOf<"FACILITY_OPERATIONS">>;
}

export interface SupplierPlace extends PlaceGeography {
  readonly kind: "SUPPLIER";
  readonly supplier: PlayerSupplier;
}

export interface PlayerSupplier {
  readonly id: SupplierId;
  readonly name: string;
  readonly offer: Known<KnowledgeValueOf<"SUPPLIER_OFFER">>;
}

export interface BuyerPlace extends PlaceGeography {
  readonly kind: "BUYER";
  readonly buyer: PlayerBuyer;
}

export interface PlayerBuyer {
  readonly id: BuyerId;
  readonly name: string;
  /** Static game-data. Whether the buyer will deal is in the known `wants`. */
  readonly minimumReputation: number;
  /** Known wants, with `maxAcceptableQuantity` recomputed (`demandRemaining` if the budget isn't known). */
  readonly wants: Known<Omit<KnowledgeValueOf<"BUYER_WANTS">, "wants"> & { readonly wants: readonly BuyerWant[] }>;
  readonly budget: Known<KnowledgeValueOf<"BUYER_BUDGET">>;
  /** Known offers, with `blockedBy` recomputed. */
  readonly offers: Known<Omit<KnowledgeValueOf<"CONTRACT_OFFERS">, "offers"> & { readonly offers: readonly ContractOfferSnapshot[] }>;
}

// ---------------------------------------------------------------------------
// Routes, vehicles, contracts
// ---------------------------------------------------------------------------

/** Geometry, cost and risk are always known (decision 3); the condition isn't. */
export interface PlayerRoute extends Omit<RouteSnapshot, "status"> {
  readonly condition: Known<KnowledgeValueOf<"ROUTE_CONDITION">>;
}

/** An owned vehicle (always known); where it is isn't. */
export interface PlayerVehicle extends Omit<VehicleSnapshot, "trip"> {
  readonly whereabouts: Known<KnowledgeValueOf<"VEHICLE_WHEREABOUTS">>;
}

/** Agreed terms (always known), plus known progress with each installment's `inTransit` recomputed. */
export interface PlayerContract extends ContractTerms {
  readonly id: ContractId;
  readonly progress: Known<
    Omit<KnowledgeValueOf<"CONTRACT_PROGRESS">, "installments"> & { readonly installments: readonly InstallmentSnapshot[] }
  >;
}

// ---------------------------------------------------------------------------
// Finance: the purse (always known) and the books as known (decision 7)
// ---------------------------------------------------------------------------

/**
 * One known ledger transaction. No `idempotencyKey` or `eventIds`, which carry
 * simulation IDs.
 */
export interface PlayerBookRow {
  readonly tick: Tick;
  readonly kind: TransactionKind;
  /** The cash-flow line it falls under, or null if it has no CASH entry. */
  readonly cashFlowCategory: CashFlowCategory | null;
  readonly entries: readonly LedgerEntry[];
}

export interface PlayerFinance {
  readonly cash: Money;
  /** Every ledger transaction with entries except those still in `pendingBooks`, oldest first. */
  readonly books: readonly PlayerBookRow[];
  /** Cash + known inventory at cost + owned assets − known liabilities. Labelled as known. */
  readonly knownNetWorth: {
    readonly amount: Money;
    /** The oldest `learnedAt` the figure relies on, or null if it relies on no record. */
    readonly asOf: Tick | null;
  };
  /** Victory progress from known values. The outcome itself is evaluated on the world. */
  readonly victory: VictoryProgress;
}
