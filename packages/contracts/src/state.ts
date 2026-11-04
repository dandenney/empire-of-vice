// Authoritative game state: what the simulation owns, saves, and hashes.
// See docs/decisions/0008-game-state-and-saves.md.
//
// State holds only DYNAMIC facts. Static definitions (names, recipes, base prices,
// route geometry, equipment stats) come from game-data and the scenario file, and
// are looked up by ID. Derived values (net worth, balance-sheet totals, report
// figures) are computed from state, never stored, so they can't drift.
//
// Like the snapshot, state is plain JSON-safe data with no optional fields, and
// lists are arrays sorted by ID (or by (tick, sequence) for queues). That makes
// canonical serialization, and therefore state hashing, straightforward.

import type { CommandEnvelope, DeliveryPurpose } from "./commands.ts";
import type { GameEvent, InstallmentOutcome } from "./events.ts";
import type { QualityTier } from "./goods.ts";
import type {
  BuyerId,
  ContractId,
  ContractOfferId,
  DeliveryId,
  DynamicIdKind,
  EquipmentId,
  FacilityId,
  FamilyId,
  MaterialId,
  ProductId,
  ProductionJobId,
  RecipeId,
  ReservationId,
  RouteId,
  ScenarioId,
  SupplierId,
  TierId,
  UnlockId,
  VehicleId,
} from "./ids.ts";
import type { LedgerTransaction } from "./ledger.ts";
import type { Money, Ratio } from "./money.ts";
import type { GameOutcome } from "./snapshot.ts";
import type { Tick } from "./time.ts";

export interface GameState {
  readonly scenarioId: ScenarioId;
  readonly seed: number;
  /** Ticks completed (ADR 0003). */
  readonly tick: Tick;
  readonly outcome: GameOutcome;
  readonly counters: StateCounters;
  readonly rng: Readonly<Record<RngStream, RngState>>;

  readonly family: FamilyState;
  readonly facilities: readonly FacilityState[];
  readonly productPools: readonly ProductPoolState[];
  readonly materialPools: readonly MaterialPoolState[];
  readonly reservations: readonly ReservationState[];
  readonly productionJobs: readonly ProductionJobState[];
  readonly vehicles: readonly VehicleState[];
  readonly deliveries: readonly DeliveryState[];
  readonly markets: readonly MarketState[];
  readonly suppliers: readonly SupplierState[];
  readonly buyers: readonly BuyerState[];
  readonly routes: readonly RouteState[];
  readonly contractOffers: readonly ContractOfferState[];
  readonly contracts: readonly ContractState[];
  readonly ledger: LedgerState;

  /** Commands waiting for a future tick, in (scheduledTick, sequence) order (ADR 0004). */
  readonly queuedCommands: readonly CommandEnvelope[];
  /** Every applied command, in order. Used for replay and debugging, not for loading. */
  readonly commandLog: readonly CommandEnvelope[];
  /** World happenings with no owning entity, in (tick, sequence) order. */
  readonly scheduledEvents: readonly ScheduledWorldEvent[];
  /** The last EVENT_JOURNAL_CAPACITY events, oldest first (ADR 0006). */
  readonly eventJournal: readonly GameEvent[];
}

// ---------------------------------------------------------------------------
// Determinism plumbing
// ---------------------------------------------------------------------------

export interface StateCounters {
  /** Next command sequence number (ADR 0004). */
  readonly nextCommandSequence: number;
  /** Next sequence for scheduled world events, so same-tick events keep a stable order. */
  readonly nextScheduleSequence: number;
  /** Next numeric suffix for each dynamically assigned ID kind (ADR 0003). */
  readonly nextId: Readonly<Record<DynamicIdKind, number>>;
}

/**
 * Independent random streams per system. A change in how often one system draws
 * random numbers doesn't shift the outcomes of another, so balance comparisons
 * between lab runs stay meaningful.
 */
export const RNG_STREAMS = ["market", "contracts", "routes", "production"] as const;
export type RngStream = (typeof RNG_STREAMS)[number];

/** xoshiro128**: four 32-bit unsigned words. Integer-only (Math.imul, shifts), so identical in every engine. */
export interface RngState {
  readonly algorithm: "xoshiro128**";
  readonly words: readonly [number, number, number, number];
}

// ---------------------------------------------------------------------------
// Family and progression (PROG-001)
// ---------------------------------------------------------------------------

export interface FamilyState {
  readonly id: FamilyId;
  /** 0–100. */
  readonly reputation: number;
  readonly tierId: TierId;
  /** Earned unlocks are never revoked (PROG-001). */
  readonly unlocked: readonly UnlockId[];
  /** For the one-time "first qualifying delivery" reputation bonus. */
  readonly firstQualifyingDeliveryMade: boolean;
  /** For the consecutive-installment bonus. */
  readonly consecutiveFulfilledInstallments: number;
}

// ---------------------------------------------------------------------------
// Facilities and inventory (PROD-001, FIN-001)
// ---------------------------------------------------------------------------

export interface FacilityState {
  readonly id: FacilityId;
  readonly equipment: readonly { readonly equipmentId: EquipmentId; readonly bookValue: Money }[];
  readonly workerCount: number;
}

/**
 * A weighted-average cost pool. Stores TOTAL cost, never a rounded unit cost (FIN-001).
 * Quantity includes reserved cases; reservations say how many are spoken for.
 */
export interface ProductPoolState {
  readonly facilityId: FacilityId;
  readonly productId: ProductId;
  readonly quality: QualityTier;
  readonly quantity: number;
  readonly totalCost: Money;
}

export interface MaterialPoolState {
  readonly facilityId: FacilityId;
  readonly materialId: MaterialId;
  readonly quantity: number;
  readonly totalCost: Money;
}

export type ReservedGoods =
  | { readonly kind: "PRODUCT"; readonly productId: ProductId; readonly quality: QualityTier }
  | { readonly kind: "MATERIAL"; readonly materialId: MaterialId };

export type ReservationHolder =
  | { readonly kind: "CONTRACT"; readonly contractId: ContractId }
  | { readonly kind: "PRODUCTION_JOB"; readonly jobId: ProductionJobId };

/** Active reservations only. Released or consumed ones are removed (and reported as events). */
export interface ReservationState {
  readonly id: ReservationId;
  readonly facilityId: FacilityId;
  readonly goods: ReservedGoods;
  readonly quantity: number;
  readonly holder: ReservationHolder;
}

export interface ProductionJobState {
  readonly id: ProductionJobId;
  readonly facilityId: FacilityId;
  readonly recipeId: RecipeId;
  readonly quantity: number;
  readonly startedAt: Tick;
  readonly completesAt: Tick;
  /** The material reservations this job will consume on completion. */
  readonly reservationIds: readonly ReservationId[];
}

// ---------------------------------------------------------------------------
// Vehicles and deliveries (ADR 0005)
// ---------------------------------------------------------------------------

export interface VehicleState {
  readonly id: VehicleId;
  readonly trip: {
    readonly deliveryId: DeliveryId;
    readonly routeId: RouteId;
    readonly leg: "OUTBOUND" | "RETURN";
    readonly departedAt: Tick;
    readonly arrivesAt: Tick;
    readonly delayed: boolean;
  } | null;
}

/** Cargo on a truck keeps its cost basis, so a sale can recognize COGS and a loss can be written off. */
export interface CargoLineState {
  readonly productId: ProductId;
  readonly quality: QualityTier;
  readonly quantity: number;
  readonly cost: Money;
}

export interface DeliveryState {
  readonly id: DeliveryId;
  readonly vehicleId: VehicleId;
  readonly fromFacilityId: FacilityId;
  readonly routeId: RouteId;
  readonly cargo: readonly CargoLineState[];
  readonly purpose: DeliveryPurpose;
  readonly status: "OUTBOUND" | "DELIVERED" | "FAILED";
  /** For SALE: the latest arrival tick before the deal falls through (rules in T02d/T03). */
  readonly dealDeadline: Tick | null;
}

// ---------------------------------------------------------------------------
// Market, suppliers, buyers, routes (ECO-001). Quotes are fixed at midnight.
// ---------------------------------------------------------------------------

/** One (product, quality) market. Base price and baselines D₀, S₀ come from game-data. */
export interface MarketState {
  readonly productId: ProductId;
  readonly quality: QualityTier;
  readonly demand: number;
  readonly supply: number;
  readonly eventRatio: Ratio;
  readonly spotPrice: Money;
  readonly previousSpotPrice: Money | null;
}

export interface SupplierState {
  readonly id: SupplierId;
  readonly stock: readonly {
    readonly materialId: MaterialId;
    readonly available: number;
    readonly unitPrice: Money;
    readonly shortage: { readonly supplyRatio: Ratio; readonly endsAt: Tick } | null;
  }[];
}

export interface BuyerState {
  readonly id: BuyerId;
  readonly budgetRemaining: Money;
  readonly wants: readonly {
    readonly productId: ProductId;
    readonly minimumQuality: QualityTier;
    readonly unitPrice: Money;
    readonly demandRemaining: number;
  }[];
  /** Deals struck but not yet delivered (ADR 0005). Released if a deal falls through. */
  readonly commitments: readonly {
    readonly deliveryId: DeliveryId;
    readonly productId: ProductId;
    readonly quantity: number;
    readonly amount: Money;
  }[];
}

export interface RouteState {
  readonly id: RouteId;
  readonly closure: { readonly reason: "RIVAL" | "POLICE"; readonly reopensAt: Tick | null } | null;
}

// ---------------------------------------------------------------------------
// Contracts (ECO-001)
// ---------------------------------------------------------------------------

/** Contract terms as stored. The snapshot adds display names. */
export interface ContractTermsData {
  readonly buyerId: BuyerId;
  readonly productId: ProductId;
  readonly minimumQuality: QualityTier;
  readonly quantityPerInstallment: number;
  readonly unitPrice: Money;
  readonly installmentCount: number;
  readonly intervalTicks: number;
  readonly penaltyRatePpm: number;
}

export interface ContractOfferState extends ContractTermsData {
  readonly id: ContractOfferId;
  readonly firstDeadline: Tick;
  readonly expiresAt: Tick;
}

export interface ContractState extends ContractTermsData {
  readonly id: ContractId;
  readonly offerId: ContractOfferId;
  readonly status: "ACTIVE" | "COMPLETED";
  readonly installments: readonly {
    readonly deadline: Tick;
    readonly required: number;
    readonly delivered: number;
    readonly outcome: InstallmentOutcome | null;
    readonly penalty: Money | null;
  }[];
  readonly reservationIds: readonly ReservationId[];
}

// ---------------------------------------------------------------------------
// Ledger (FIN-001)
// ---------------------------------------------------------------------------

/**
 * The full transaction log. Balances and every report (balance sheet, profit,
 * cash flow by period) are derived from it, so save/load preserves the ledger
 * exactly (FIN-001 acceptance). An M001 campaign produces a few thousand
 * transactions at most; compaction can come later if campaigns get longer.
 */
export interface LedgerState {
  readonly transactions: readonly LedgerTransaction[];
}

// ---------------------------------------------------------------------------
// Scheduled world events
// ---------------------------------------------------------------------------

/**
 * Things the world will do at a set tick that no entity owns. Timers that belong
 * to an entity stay on it (a job's `completesAt`, a trip's `arrivesAt`, an
 * installment's `deadline`), so there's one source of truth for each.
 */
export type ScheduledWorldEvent = { readonly tick: Tick; readonly sequence: number } & (
  | { readonly kind: "ROUTE_CLOSURE"; readonly routeId: RouteId; readonly reason: "RIVAL" | "POLICE"; readonly durationTicks: number | null }
  | { readonly kind: "ROUTE_REOPENING"; readonly routeId: RouteId }
  | { readonly kind: "SHORTAGE_START"; readonly supplierId: SupplierId; readonly materialId: MaterialId; readonly supplyRatio: Ratio; readonly durationTicks: number }
  | { readonly kind: "SHORTAGE_END"; readonly supplierId: SupplierId; readonly materialId: MaterialId }
  | { readonly kind: "CONTRACT_OFFER"; readonly buyerId: BuyerId }
);
