// The read-only projection the UI renders. See docs/decisions/0007-game-snapshot.md.
//
// The worker publishes a GameSnapshot periodically and the UI renders it. The UI
// never holds its own copy of game state (architecture §4). Snapshots are plain
// JSON-safe data (structured-clone friendly) and self-contained: entities carry
// display names, so panels don't need to join against game-data.
//
// Lists are arrays sorted by ID, so output is deterministic and diffs cleanly.
// Values the UI could derive but would get subtly wrong (net worth, quotes,
// eligibility) are computed by the simulation and included.

import type { DeliveryPurpose, RejectionReason } from "./commands.ts";
import type { GameEvent, InstallmentOutcome } from "./events.ts";
import type { WorldPoint } from "./geometry.ts";
import type { CargoLine, MaterialLine, QualityTier } from "./goods.ts";
import type {
  BuyerId,
  ContractId,
  ContractOfferId,
  DeliveryId,
  EquipmentId,
  FacilityId,
  FamilyId,
  CharacterId,
  LocationId,
  MaterialId,
  ProductId,
  ProductionJobId,
  RecipeId,
  ReservationId,
  RouteId,
  SupplierId,
  TierId,
  UnlockId,
  VehicleId,
} from "./ids.ts";
import type { LedgerTransaction } from "./ledger.ts";
import type { Money } from "./money.ts";
import type { ContractTermsData } from "./state.ts";
import type { Tick } from "./time.ts";

export interface GameSnapshot {
  readonly clock: ClockSnapshot;
  readonly outcome: GameOutcome;
  readonly family: FamilySnapshot;
  readonly finance: FinanceSnapshot;
  readonly progression: ProgressionSnapshot;
  // Map
  readonly locations: readonly LocationSnapshot[];
  readonly routes: readonly RouteSnapshot[];
  // Operations
  readonly facilities: readonly FacilitySnapshot[];
  readonly productionJobs: readonly ProductionJobSnapshot[];
  readonly vehicles: readonly VehicleSnapshot[];
  // Market and contracts
  readonly market: MarketReport;
  readonly contracts: ContractsSnapshot;
  /** The most recent SNAPSHOT_RECENT_EVENTS events, oldest first. */
  readonly recentEvents: readonly GameEvent[];
}

/** Events included per snapshot. The full journal stays in state (ADR 0006). */
export const SNAPSHOT_RECENT_EVENTS = 100;

// ---------------------------------------------------------------------------
// Clock and outcome
// ---------------------------------------------------------------------------

export interface GameDate {
  readonly year: number;
  /** 1–12. */
  readonly month: number;
  /** 1–31. */
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

export interface ClockSnapshot {
  readonly tick: Tick;
  readonly dayIndex: number;
  readonly date: GameDate;
}

export type GameOutcome =
  | { readonly status: "PLAYING" }
  | { readonly status: "WON"; readonly tick: Tick }
  | { readonly status: "LOST"; readonly tick: Tick; readonly reason: "INSOLVENT" };

// ---------------------------------------------------------------------------
// Family and people (GDD §10)
// ---------------------------------------------------------------------------

export interface FamilySnapshot {
  readonly id: FamilyId;
  readonly name: string;
  /** 0–100 (PROG-001). */
  readonly reputation: number;
  readonly leaders: readonly CharacterSnapshot[];
}

export interface CharacterSnapshot {
  readonly id: CharacterId;
  readonly name: string;
  readonly role: "FOUNDER" | "FOREMAN";
  readonly skill: number;
  readonly loyalty: number;
  readonly dailyWage: Money;
}

// ---------------------------------------------------------------------------
// Finance (FIN-001). Profit, cash flow, and net worth are separate metrics.
// ---------------------------------------------------------------------------

export interface FinanceSnapshot {
  readonly cash: Money;
  /** Total assets − total liabilities. May be negative (FIN-001). */
  readonly netWorth: Money;
  readonly balanceSheet: BalanceSheet;
  /** Since midnight. */
  readonly today: PeriodReport;
  /** The last complete game day, or null on day 0. */
  readonly previousDay: PeriodReport | null;
  /** Since the scenario started. */
  readonly toDate: PeriodReport;
  /** Most recent ledger transactions, oldest first, for "why did money change" explanations. */
  readonly recentTransactions: readonly LedgerTransaction[];
}

export interface BalanceSheet {
  readonly assets: {
    readonly cash: Money;
    readonly rawMaterials: Money;
    readonly finishedGoods: Money;
    readonly goodsInTransit: Money;
    readonly receivables: Money;
    readonly equipment: Money;
    readonly vehicles: Money;
    readonly facilities: Money;
  };
  readonly liabilities: {
    readonly wagesPayable: Money;
    readonly penaltiesPayable: Money;
  };
  readonly totalAssets: Money;
  readonly totalLiabilities: Money;
  /** Equals netWorth. Assets = liabilities + equity is a tested invariant. */
  readonly equity: Money;
}

/** Profit and cash flow over one period. They differ: buying a still uses cash but isn't an expense. */
export interface PeriodReport {
  readonly fromTick: Tick;
  readonly toTick: Tick;
  readonly profit: IncomeStatement;
  readonly cashFlow: CashFlowStatement;
}

export type ExpenseCategory = "WAGES" | "OVERHEAD" | "TRANSPORT" | "PENALTIES" | "LOSSES";

export interface IncomeStatement {
  readonly revenue: Money;
  readonly costOfGoodsSold: Money;
  readonly grossProfit: Money;
  /** Every category, in a fixed order, zero if nothing happened. */
  readonly expenses: readonly { readonly category: ExpenseCategory; readonly amount: Money }[];
  readonly gains: Money;
  readonly netProfit: Money;
}

export type CashFlowCategory =
  | "SALES"
  | "ASSET_SALES"
  | "MATERIALS"
  | "EQUIPMENT"
  | "WAGES"
  | "OVERHEAD"
  | "TRANSPORT"
  | "PENALTIES";

export interface CashFlowStatement {
  readonly openingCash: Money;
  /** Positive amounts in, negative out. Every category, fixed order. */
  readonly lines: readonly { readonly category: CashFlowCategory; readonly amount: Money }[];
  readonly netChange: Money;
  readonly closingCash: Money;
}

// ---------------------------------------------------------------------------
// Progression (PROG-001)
// ---------------------------------------------------------------------------

export interface ProgressionSnapshot {
  readonly currentTierId: TierId;
  /** All tiers in ascending order. */
  readonly tiers: readonly TierSnapshot[];
  readonly unlocked: readonly UnlockId[];
  readonly victory: VictoryProgress;
}

export interface TierSnapshot {
  readonly id: TierId;
  readonly name: string;
  readonly netWorthRequired: Money | null;
  readonly reputationRequired: number | null;
  readonly unlocks: readonly UnlockId[];
  readonly reached: boolean;
}

export interface VictoryProgress {
  readonly netWorth: { readonly current: Money; readonly target: Money };
  readonly reputation: { readonly current: number; readonly target: number };
  /** Contracts with every installment settled (GDD §7 clarification). */
  readonly completedContracts: { readonly current: number; readonly target: number };
}

// ---------------------------------------------------------------------------
// Map (GDD §10)
// ---------------------------------------------------------------------------

export type LocationOccupant =
  | { readonly kind: "FACILITY"; readonly facilityId: FacilityId }
  | { readonly kind: "SUPPLIER"; readonly supplierId: SupplierId }
  | { readonly kind: "BUYER"; readonly buyerId: BuyerId };

export interface LocationSnapshot {
  readonly id: LocationId;
  readonly name: string;
  readonly position: WorldPoint;
  readonly occupant: LocationOccupant;
}

export interface RouteSnapshot {
  readonly id: RouteId;
  readonly name: string;
  readonly fromLocationId: LocationId;
  readonly toLocationId: LocationId;
  /** Path from `from` to `to`, inclusive of both ends. Trucks are drawn along it. */
  readonly waypoints: readonly WorldPoint[];
  readonly durationTicks: number;
  readonly transportCost: Money;
  readonly status: { readonly open: true } | { readonly open: false; readonly reopensAt: Tick | null; readonly reason: "RIVAL" | "POLICE" };
  /** Shown to the player so route choice is informed. Parts per million chance of trouble per trip. */
  readonly riskPpm: number;
}

// ---------------------------------------------------------------------------
// Facilities, inventory, production (PROD-001, FIN-001)
// ---------------------------------------------------------------------------

export interface FacilitySnapshot {
  readonly id: FacilityId;
  readonly name: string;
  readonly locationId: LocationId;
  readonly kind: "DISTILLERY" | "WAREHOUSE";
  readonly equipment: readonly { readonly id: EquipmentId; readonly name: string; readonly bookValue: Money }[];
  readonly equipmentSlots: { readonly used: number; readonly total: number };
  /** What could be bought here, with the reason it can't (if it can't) precomputed. */
  readonly equipmentOptions: readonly EquipmentOption[];
  readonly workforce: { readonly workers: number; readonly maximum: number; readonly dailyWagePerWorker: Money };
  readonly storage: { readonly used: number; readonly capacity: number };
  /** Cases per game day at current equipment and workforce. */
  readonly productionCapacityPerDay: number;
  readonly recipes: readonly RecipeOption[];
  readonly products: readonly InventoryPoolSnapshot[];
  readonly materials: readonly MaterialStockSnapshot[];
}

export interface EquipmentOption {
  readonly equipmentId: EquipmentId;
  readonly name: string;
  readonly description: string;
  readonly price: Money;
  /** null if it can be bought right now. */
  readonly blockedBy: RejectionReason | null;
}

export interface RecipeOption {
  readonly recipeId: RecipeId;
  readonly name: string;
  readonly productId: ProductId;
  readonly quality: QualityTier;
  /** Inputs per output case. */
  readonly inputsPerCase: readonly MaterialLine[];
  /** The recipe's base ticks per case at 1× throughput; a job of N cases takes N × this. */
  readonly ticksPerCase: number;
  /** Largest quantity startable now (materials, capacity, storage, cash). 0 if blocked. */
  readonly maxStartableQuantity: number;
  readonly blockedBy: RejectionReason | null;
}

/** One weighted-average cost pool (FIN-001): product + quality at a facility. */
export interface InventoryPoolSnapshot {
  readonly productId: ProductId;
  readonly productName: string;
  readonly quality: QualityTier;
  readonly quantity: number;
  /** Reserved for contracts or in-progress operations; can't be sold or shipped elsewhere. */
  readonly reservedQuantity: number;
  readonly totalCost: Money;
  /** totalCost / quantity, rounded for display. The pool stores total cost, not this. */
  readonly averageUnitCost: Money;
}

export interface MaterialStockSnapshot {
  readonly materialId: MaterialId;
  readonly materialName: string;
  readonly quantity: number;
  /** Reserved by running production jobs. */
  readonly reservedQuantity: number;
  readonly totalCost: Money;
}

export interface ProductionJobSnapshot {
  readonly id: ProductionJobId;
  readonly facilityId: FacilityId;
  readonly recipeId: RecipeId;
  readonly productId: ProductId;
  readonly quality: QualityTier;
  readonly quantity: number;
  readonly startedAt: Tick;
  readonly completesAt: Tick;
}

// ---------------------------------------------------------------------------
// Vehicles and deliveries
// ---------------------------------------------------------------------------

export interface VehicleSnapshot {
  readonly id: VehicleId;
  readonly name: string;
  /** Cases. */
  readonly capacity: number;
  /** Where it's parked when idle, or the location it will return to. */
  readonly homeLocationId: LocationId;
  readonly trip: VehicleTrip | null;
}

/**
 * A vehicle on the road. The map positions it at
 * (now − departedAt) / (arrivesAt − departedAt) along the route (ADR 0003).
 * On the return leg, it travels the same route backwards.
 */
export interface VehicleTrip {
  readonly deliveryId: DeliveryId;
  readonly routeId: RouteId;
  readonly leg: "OUTBOUND" | "RETURN";
  readonly departedAt: Tick;
  readonly arrivesAt: Tick;
  readonly cargo: readonly CargoLine[];
  readonly purpose: DeliveryPurpose;
  readonly delayed: boolean;
}

// ---------------------------------------------------------------------------
// Market (ECO-001). Stable between midnights.
// ---------------------------------------------------------------------------

export interface MarketReport {
  readonly dayIndex: number;
  readonly products: readonly ProductPriceSnapshot[];
  readonly suppliers: readonly SupplierSnapshot[];
  readonly buyers: readonly BuyerSnapshot[];
}

/** One (product, quality) market, with the formula's inputs so the price is explainable. */
export interface ProductPriceSnapshot {
  readonly productId: ProductId;
  readonly productName: string;
  readonly quality: QualityTier;
  readonly basePrice: Money;
  readonly spotPrice: Money;
  /** Clamped multipliers M_D, M_S, M_E in parts per million. */
  readonly demandRatioPpm: number;
  readonly supplyRatioPpm: number;
  readonly eventRatioPpm: number;
  /** Today's quote vs yesterday's, or null on day 0. */
  readonly previousSpotPrice: Money | null;
}

export interface SupplierSnapshot {
  readonly id: SupplierId;
  readonly name: string;
  readonly locationId: LocationId;
  readonly materials: readonly {
    readonly materialId: MaterialId;
    readonly materialName: string;
    readonly unitPrice: Money;
    readonly available: number;
    readonly shortage: boolean;
  }[];
}

export interface BuyerSnapshot {
  readonly id: BuyerId;
  readonly name: string;
  readonly locationId: LocationId;
  readonly minimumReputation: number;
  /** False if reputation is too low to deal at all. */
  readonly willDeal: boolean;
  readonly budgetRemaining: Money;
  readonly wants: readonly BuyerWant[];
}

/** What this buyer will take today, at what price (ADR 0005: the deal price if you dispatch now). */
export interface BuyerWant {
  readonly productId: ProductId;
  readonly productName: string;
  readonly minimumQuality: QualityTier;
  readonly unitPrice: Money;
  readonly demandRemaining: number;
  /** min(demandRemaining, floor(budgetRemaining / unitPrice)) (ECO-001 buyer liquidity). */
  readonly maxAcceptableQuantity: number;
}

// ---------------------------------------------------------------------------
// Contracts (ECO-001)
// ---------------------------------------------------------------------------

export interface ContractsSnapshot {
  readonly offers: readonly ContractOfferSnapshot[];
  readonly active: readonly ContractSnapshot[];
  /** Contracts with every installment settled, most recent first. Missed installments still count as settled. */
  readonly closed: readonly ContractSnapshot[];
}

/** Stored terms (ContractTermsData) plus display names. */
export interface ContractTerms extends ContractTermsData {
  readonly buyerName: string;
  readonly productName: string;
}

export interface ContractOfferSnapshot extends ContractTerms {
  readonly id: ContractOfferId;
  readonly firstDeadline: Tick;
  readonly expiresAt: Tick;
  readonly blockedBy: RejectionReason | null;
}

export interface ContractSnapshot extends ContractTerms {
  readonly id: ContractId;
  readonly status: "ACTIVE" | "COMPLETED";
  readonly installments: readonly InstallmentSnapshot[];
  readonly reservationIds: readonly ReservationId[];
  /** Cases currently held for this contract. */
  readonly reservedQuantity: number;
}

export interface InstallmentSnapshot {
  readonly index: number;
  readonly deadline: Tick;
  readonly required: number;
  /** Delivered so far (counts on-time deliveries up to and including the deadline tick). */
  readonly delivered: number;
  /** In transit toward this installment right now. */
  readonly inTransit: number;
  /** null until the deadline passes and it settles. */
  readonly outcome: InstallmentOutcome | null;
  readonly penalty: Money | null;
}
