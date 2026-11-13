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
  CharacterId,
  ContractId,
  ContractOfferId,
  DealId,
  DeliveryId,
  DynamicIdKind,
  EquipmentId,
  FacilityId,
  FamilyId,
  LocationId,
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
import type { KnowledgeState } from "./knowledge.ts";
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
  /**
   * Deals the founder agreed that are still live: HELD or DISPATCHED, sorted
   * with `compareIds` (ADR 0022 decision 6). A deal leaves when it reaches a
   * terminal state, which its event reports.
   */
  readonly heldDeals: readonly HeldDealState[];
  readonly markets: readonly MarketState[];
  readonly suppliers: readonly SupplierState[];
  readonly buyers: readonly BuyerState[];
  readonly routes: readonly RouteState[];
  readonly contractOffers: readonly ContractOfferState[];
  readonly contracts: readonly ContractState[];
  readonly ledger: LedgerState;

  /** Commands waiting for a future tick, in (scheduledTick, sequence) order (ADR 0004). */
  readonly queuedCommands: readonly CommandEnvelope[];
  /**
   * Every command accepted at dispatch whose tick has been processed, as its
   * original envelope, in (scheduledTick, sequence) order (ADR 0004, amended by
   * T01b). That covers commands that applied immediately, queued commands that
   * applied when their tick arrived, and queued commands that were rejected then
   * (each also reported by a COMMAND_REJECTED event). The outcome isn't stored:
   * replaying the log from the same start state derives it again. Commands
   * rejected at dispatch never appear. Used for replay and debugging, not for loading.
   */
  readonly commandLog: readonly CommandEnvelope[];
  /** World happenings with no owning entity, in (tick, sequence) order. */
  readonly scheduledEvents: readonly ScheduledWorldEvent[];
  /** The last EVENT_JOURNAL_CAPACITY events, oldest first (ADR 0006). */
  readonly eventJournal: readonly GameEvent[];

  /**
   * What the founder knows (ADR 0021 decisions 4 and 7). Read only by the player
   * snapshot builder. Empty in a new game and in a migrated M001 save.
   */
  readonly knowledge: KnowledgeState;

  /**
   * Where the founder is and what they're doing (ADR 0023 decision 1). Always
   * known (ADR 0021 decision 3). With `founderRules: false` (the M001 scenario
   * and the lab) it never changes (ADR 0023 decision 9).
   */
  readonly founder: FounderState;
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
  /**
   * The conversion cost this job paid into PRODUCTION_IN_PROGRESS when it started
   * (ADR 0022 decision 7). Completion and failure credit exactly this amount and move
   * no cash. `null` marks a job migrated from a pre-M002 save, which prepaid nothing
   * and settles under the old rule (cash first, then WAGES_PAYABLE). Invariant: the
   * PRODUCTION_IN_PROGRESS balance equals the sum of this over running jobs.
   */
  readonly conversionPrepaid: Money | null;
}

// ---------------------------------------------------------------------------
// Vehicles and deliveries (ADR 0005)
// ---------------------------------------------------------------------------

export interface VehicleState {
  readonly id: VehicleId;
  /**
   * Where the truck stands (ADR 0023 decision 1): null from its departure until
   * its return (or, on TRAVEL, from setting out until arrival or a halt),
   * otherwise the location it's parked at. A truck being loaded already has its
   * `trip` but is still parked; the founder phase sets this to null when it
   * departs (ADR 0023 decision 2a).
   */
  readonly parkedAt: LocationId | null;
  /**
   * The vehicle's trip ordinal (ADR 0022 decision 8): dispatches so far,
   * incremented at each dispatch before anything is drawn for the trip. 0 in a
   * save migrated from before M002, so the first M002 trip is 1.
   */
  readonly tripCount: number;
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
  /**
   * For a SALE with a deal: the latest arrival tick before the deal falls through,
   * `min(deal.expiresAt, scheduled arrival + dealGraceTicks)` (ADR 0019 decision 4,
   * ADR 0022 decision 6). null for contract installments, transfers and sales on spec.
   */
  readonly dealDeadline: Tick | null;
  /** Who drives (ADR 0023 decision 5). null: a pre-M002 delivery, with no driver (decision 10). */
  readonly driver: DriverRef | null;
}

/**
 * A deal the founder agreed with a buyer (ADR 0022 decision 6). HELD until a
 * dispatch uses it (DISPATCHED) or `expiresAt` passes (DEAL_EXPIRED). Once
 * dispatched it's resolved only by its delivery: SETTLED on arrival in time,
 * FELL_THROUGH if late, seized (CARGO_LOST) or turned back. Terminal deals leave
 * `GameState.heldDeals`, so `status` there is only ever HELD or DISPATCHED.
 */
export interface HeldDealState {
  readonly id: DealId;
  readonly buyerId: BuyerId;
  readonly productId: ProductId;
  /** The cargo quality agreed; the buyer's commitment records the want it matched. */
  readonly quality: QualityTier;
  readonly quantity: number;
  readonly unitPrice: Money;
  readonly agreedAt: Tick;
  /** `agreedAt + DEAL_HOLD_TICKS`. A dispatched deal never expires by time. */
  readonly expiresAt: Tick;
  /** false for a by-phone deal, which commits demand only (ADR 0024). */
  readonly budgetCommitted: boolean;
  readonly status: HeldDealStatus;
  /** Set when a dispatch uses it. */
  readonly deliveryId: DeliveryId | null;
}

export type HeldDealStatus = "HELD" | "DISPATCHED" | "SETTLED" | "EXPIRED" | "FELL_THROUGH";

// ---------------------------------------------------------------------------
// The founder (ADR 0023 decisions 1, 3, 4, 5, 7)
// ---------------------------------------------------------------------------

/**
 * `GameState.founder`: dynamic state only (ADR 0008). The founder's identity is
 * the personnel entry with role FOUNDER in game-data, so no character ID here.
 */
export interface FounderState {
  readonly whereabouts: FounderWhereabouts;
  /**
   * The effective start of the founder's waking day: the tick a full rest ended,
   * moved forward by partial rests (ADR 0023 decision 7). Drives tiredness.
   */
  readonly awakeSince: Tick;
}

/**
 * Where the founder is (ADR 0023 decision 1). The founder is present at L
 * exactly when this is PRESENT at L, busy or not (decision 2).
 */
export type FounderWhereabouts =
  | {
      readonly kind: "PRESENT";
      readonly locationId: LocationId;
      /** A timed activity (decision 4), busy through `until`, inclusive (decision 2a). */
      readonly busy: { readonly activity: ActivityKind; readonly until: Tick } | null;
    }
  | {
      readonly kind: "TRAVELLING";
      readonly transport: Transport;
      /** A simple path (decision 3): consecutive legs connect and no location repeats. */
      readonly path: readonly RouteLeg[];
      /** Index into `path` of the leg under way. */
      readonly legIndex: number;
      readonly legDepartedAt: Tick;
      readonly legArrivesAt: Tick;
      readonly destinationLocationId: LocationId;
    }
  | {
      readonly kind: "ON_DELIVERY";
      readonly deliveryId: DeliveryId;
      readonly vehicleId: VehicleId;
      /** Set on the tick the outbound leg resolves at its destination (decision 2). */
      readonly atStop: { readonly locationId: LocationId; readonly tick: Tick } | null;
    }
  | {
      readonly kind: "RESTING";
      readonly locationId: LocationId;
      readonly startedAt: Tick;
      readonly until: Tick;
    };

export type FounderWhereaboutsKind = FounderWhereabouts["kind"];

/** How the founder travels (ADR 0023 decision 3). VEHICLE: a truck parked at the founder's place. */
export type Transport = { readonly kind: "FOOT" } | { readonly kind: "VEHICLE"; readonly vehicleId: VehicleId };

/** One leg of a founder's path: a route, driven or walked in either direction (ADR 0023 decision 3). */
export interface RouteLeg {
  readonly routeId: RouteId;
  /** True when the leg runs from the route's `toLocationId` to its `fromLocationId`. */
  readonly reversed: boolean;
}

/**
 * Timed activities (ADR 0023 decision 4). Each has a duration in game-data
 * (`ACTIVITY_DURATIONS`). Travel, riding a delivery and rest take their own
 * time and aren't activities.
 */
export const ACTIVITY_KINDS = [
  "BUY_MATERIALS",
  "START_BATCH",
  "LOAD_TRUCK",
  "AGREE_DEAL",
  "ACCEPT_CONTRACT",
  "BUY_EQUIPMENT",
  "SELL_EQUIPMENT",
  "SET_WORKFORCE",
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/**
 * Who drives a delivery (ADR 0023 decision 5); the same shape as ADR 0022's
 * issuer. `DISPATCH_DELIVERY.driver` and `DeliveryState.driver` use it.
 */
export type DriverRef = { readonly kind: "FOUNDER" } | { readonly kind: "EMPLOYEE"; readonly characterId: CharacterId };

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
  /**
   * Demand and budget committed to held deals (ADR 0022 decision 6), keyed by
   * deal. Removed when the deal settles; released (under the daily caps) if it
   * expires or falls through.
   */
  readonly commitments: readonly {
    readonly dealId: DealId;
    readonly productId: ProductId;
    /** The `minimumQuality` of the want the deal matched, whose demand it holds. */
    readonly quality: QualityTier;
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
  /**
   * A scheduled setback (issue #129): books a loss of `netWorthSharePpm` parts per
   * million of net worth at its tick, capped at cash, as one balanced transaction
   * (Dr LOSSES / Cr CASH). Emits LOSS_BOOKED. Used by the economy lab's setback
   * scenario; the First Shipment doesn't schedule one.
   */
  | { readonly kind: "SHAKEDOWN"; readonly reason: "RIVAL" | "POLICE"; readonly netWorthSharePpm: number }
);
