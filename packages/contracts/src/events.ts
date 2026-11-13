// Game events: what happened. See docs/decisions/0006-event-journal.md.
//
// Commands express intent, events record outcomes, state is the result
// (architecture §4). Events are not the source of truth: state is. They drive
// UI notifications and the finance panel's "why did money change" explanations,
// and they make tests and lab reports readable.
//
// Every event has a stable simulation-assigned ID, the tick it happened on, and
// the command that caused it (or null for things the world did on its own,
// like midnight settlement or a route closing). Any event that moved money
// carries the TransactionId of its balanced ledger transaction.

import type { DeliveryPurpose, GameCommandType, RejectionReason } from "./commands.ts";
import type { CargoLine, QualityTier } from "./goods.ts";
import type { CallInReason, CatchUp } from "./knowledge.ts";
import type {
  BuyerId,
  CharacterId,
  CommandId,
  ContractId,
  ContractOfferId,
  DealId,
  DeliveryId,
  EquipmentId,
  EventId,
  FacilityId,
  LocationId,
  MaterialId,
  ProductId,
  ProductionJobId,
  RecipeId,
  ReservationId,
  RouteId,
  SupplierId,
  TierId,
  TransactionId,
  UnlockId,
  VehicleId,
} from "./ids.ts";
import type { Money } from "./money.ts";
import type { ArrangementPrivilege, CallAnswerer, Transport } from "./state.ts";
import type { Tick } from "./time.ts";

/** Fields every event has. */
export interface EventMeta {
  readonly id: EventId;
  readonly tick: Tick;
  /** The command that caused this, or null for world-driven events. */
  readonly causedBy: CommandId | null;
}

type GameEventOf<T extends string, P extends object> = EventMeta & { readonly type: T } & P;

// ---------------------------------------------------------------------------
// Commands and the clock
// ---------------------------------------------------------------------------

/** A queued command failed validation when its tick arrived (ADR 0004). */
export type CommandRejectedEvent = GameEventOf<
  "COMMAND_REJECTED",
  { readonly commandId: CommandId; readonly commandType: GameCommandType; readonly reason: RejectionReason }
>;

/**
 * Midnight settlement of recurring costs (SIM-001 step 5). Costs the player couldn't
 * pay in cash become liabilities: cash never goes negative (FIN-001).
 */
export type DaySettledEvent = GameEventOf<
  "DAY_SETTLED",
  {
    /** The game day that just ended. */
    readonly dayIndex: number;
    readonly wagesDue: Money;
    readonly overheadDue: Money;
    readonly paidInCash: Money;
    readonly addedToLiabilities: Money;
    /** Earlier liabilities (unpaid wages, penalties) paid off tonight. */
    readonly liabilitiesPaid: Money;
    readonly transactionId: TransactionId;
  }
>;

// ---------------------------------------------------------------------------
// Materials and production (PROD-001)
// ---------------------------------------------------------------------------

export type MaterialsPurchasedEvent = GameEventOf<
  "MATERIALS_PURCHASED",
  {
    readonly supplierId: SupplierId;
    readonly materialId: MaterialId;
    readonly quantity: number;
    readonly unitPrice: Money;
    readonly total: Money;
    readonly facilityId: FacilityId;
    readonly transactionId: TransactionId;
  }
>;

export type ProductionStartedEvent = GameEventOf<
  "PRODUCTION_STARTED",
  {
    readonly jobId: ProductionJobId;
    readonly facilityId: FacilityId;
    readonly recipeId: RecipeId;
    readonly quantity: number;
    readonly completesAt: Tick;
  }
>;

/** Finished goods enter inventory at cost. No profit is recognized (FIN-001). */
export type ProductionCompletedEvent = GameEventOf<
  "PRODUCTION_COMPLETED",
  {
    readonly jobId: ProductionJobId;
    readonly facilityId: FacilityId;
    readonly productId: ProductId;
    readonly quality: QualityTier;
    readonly quantity: number;
    /** Materials + labor + overhead capitalized into inventory. */
    readonly costBasis: Money;
    readonly transactionId: TransactionId;
  }
>;

/** A job that couldn't finish. Its reservations are released per GDD §14.8 (rules decided in T02a). */
export type ProductionFailedEvent = GameEventOf<
  "PRODUCTION_FAILED",
  {
    readonly jobId: ProductionJobId;
    readonly facilityId: FacilityId;
    readonly reason: "DISRUPTION";
    /** Cost of consumed inputs written off, if any. */
    readonly writtenOff: Money;
    readonly transactionId: TransactionId;
  }
>;

export type EquipmentPurchasedEvent = GameEventOf<
  "EQUIPMENT_PURCHASED",
  {
    readonly facilityId: FacilityId;
    readonly equipmentId: EquipmentId;
    readonly price: Money;
    readonly transactionId: TransactionId;
  }
>;

/**
 * An owned equipment item sold for recovery (ADR 0020 decision 9). `proceeds` is the
 * resale value; `bookValue - proceeds` is booked to LOSSES.
 */
export type EquipmentSoldEvent = GameEventOf<
  "EQUIPMENT_SOLD",
  {
    readonly facilityId: FacilityId;
    readonly equipmentId: EquipmentId;
    readonly bookValue: Money;
    readonly proceeds: Money;
    readonly transactionId: TransactionId;
  }
>;

export type WorkforceChangedEvent = GameEventOf<
  "WORKFORCE_CHANGED",
  { readonly facilityId: FacilityId; readonly from: number; readonly to: number }
>;

// ---------------------------------------------------------------------------
// Deliveries and sales (ADR 0005)
// ---------------------------------------------------------------------------

/** A truck left. A SALE with a deal carries it out; one on spec is settled on arrival (ADR 0022 decision 6). */
export type DeliveryDispatchedEvent = GameEventOf<
  "DELIVERY_DISPATCHED",
  {
    readonly deliveryId: DeliveryId;
    readonly vehicleId: VehicleId;
    readonly routeId: RouteId;
    readonly cargo: readonly CargoLine[];
    readonly purpose: DeliveryPurpose;
    readonly arrivesAt: Tick;
  }
>;

export type DeliveryDelayedEvent = GameEventOf<
  "DELIVERY_DELAYED",
  {
    readonly deliveryId: DeliveryId;
    readonly routeId: RouteId;
    readonly previousArrivesAt: Tick;
    readonly arrivesAt: Tick;
  }
>;

/** Cash on delivery: revenue and cost of goods sold are recognized now (FIN-001). */
export type SaleCompletedEvent = GameEventOf<
  "SALE_COMPLETED",
  {
    readonly deliveryId: DeliveryId;
    readonly buyerId: BuyerId;
    readonly cargo: readonly CargoLine[];
    readonly unitPrice: Money;
    readonly revenue: Money;
    readonly costOfGoodsSold: Money;
    /** Set when this sale fulfilled (part of) a contract installment. */
    readonly contractId: ContractId | null;
    readonly transactionId: TransactionId;
  }
>;

export type TransferCompletedEvent = GameEventOf<
  "TRANSFER_COMPLETED",
  {
    readonly deliveryId: DeliveryId;
    readonly destinationFacilityId: FacilityId;
    readonly cargo: readonly CargoLine[];
    /** Book value moved. Consolidated net worth doesn't change (FIN-001). */
    readonly bookValue: Money;
  }
>;

/**
 * A sale didn't happen. A deal's committed demand and budget are released (ADR 0005).
 * ADR 0022 decision 6's reasons: a deal-backed run arrived late (TOO_LATE), its cargo
 * was seized (CARGO_LOST), or it was turned back by a closed road (ROUTE_CLOSED); an
 * on-spec buyer took nothing (NOT_WANTED); an installment reached a closed contract
 * (CONTRACT_CLOSED).
 */
export type DealFellThroughEvent = GameEventOf<
  "DEAL_FELL_THROUGH",
  {
    readonly deliveryId: DeliveryId;
    readonly buyerId: BuyerId;
    readonly reason: DealFellThroughReason;
  }
>;

export type DealFellThroughReason = "TOO_LATE" | "CARGO_LOST" | "NOT_WANTED" | "CONTRACT_CLOSED" | "ROUTE_CLOSED";

/** AGREE_DEAL applied: the buyer holds demand (and budget, if committed) for this deal (ADR 0022 decision 6). */
export type DealAgreedEvent = GameEventOf<
  "DEAL_AGREED",
  {
    readonly dealId: DealId;
    readonly buyerId: BuyerId;
    readonly productId: ProductId;
    readonly quality: QualityTier;
    readonly quantity: number;
    readonly unitPrice: Money;
    readonly expiresAt: Tick;
    readonly budgetCommitted: boolean;
  }
>;

/**
 * A HELD deal reached its `expiresAt` undispatched: its commitment is released
 * under the daily caps (ADR 0022 decision 6). A dispatched deal never expires.
 */
export type DealExpiredEvent = GameEventOf<"DEAL_EXPIRED", { readonly dealId: DealId; readonly buyerId: BuyerId }>;

/**
 * An on-spec sale (or a by-phone deal's budget-limited settlement) arrived: the
 * buyer took `accepted` of `offered` cases at `unitPrice` (ADR 0022 decision 6).
 */
export type SpecSaleSettledEvent = GameEventOf<
  "SPEC_SALE_SETTLED",
  {
    readonly deliveryId: DeliveryId;
    readonly buyerId: BuyerId;
    readonly offered: number;
    readonly accepted: number;
    readonly unitPrice: Money;
  }
>;

/**
 * A delivery found its route closed (ADR 0022 decision 6): on the road, or at
 * departure after loading. The truck turns back, or doesn't leave.
 */
export type RouteFoundClosedEvent = GameEventOf<"ROUTE_FOUND_CLOSED", { readonly deliveryId: DeliveryId; readonly routeId: RouteId }>;

/** Cargo seized or destroyed, written off explicitly (FIN-001). */
export type CargoLostEvent = GameEventOf<
  "CARGO_LOST",
  {
    readonly deliveryId: DeliveryId;
    readonly vehicleId: VehicleId;
    readonly cargo: readonly CargoLine[];
    readonly bookValue: Money;
    readonly transactionId: TransactionId;
  }
>;

export type VehicleReturnedEvent = GameEventOf<
  "VEHICLE_RETURNED",
  {
    readonly vehicleId: VehicleId;
    readonly deliveryId: DeliveryId;
    readonly locationId: LocationId;
    /** Cases still aboard (e.g. a transfer that couldn't unload), returned to inventory. */
    readonly returnedCargo: readonly CargoLine[];
  }
>;

// ---------------------------------------------------------------------------
// Market and disruptions (ECO-001, GDD §10)
// ---------------------------------------------------------------------------

/** The daily market report was published (ECO-001 daily cycle step 5). The report is in the snapshot. */
export type MarketUpdatedEvent = GameEventOf<"MARKET_UPDATED", { readonly dayIndex: number }>;

export type ShortageStartedEvent = GameEventOf<
  "SHORTAGE_STARTED",
  {
    readonly supplierId: SupplierId;
    readonly materialId: MaterialId;
    /** Fraction of normal supply still available, in parts per million. */
    readonly supplyRatioPpm: number;
    readonly endsAt: Tick;
  }
>;

export type ShortageEndedEvent = GameEventOf<
  "SHORTAGE_ENDED",
  { readonly supplierId: SupplierId; readonly materialId: MaterialId }
>;

export type RouteClosedEvent = GameEventOf<
  "ROUTE_CLOSED",
  {
    readonly routeId: RouteId;
    readonly reason: "RIVAL" | "POLICE";
    /** null if the reopening time isn't known yet. */
    readonly reopensAt: Tick | null;
  }
>;

export type RouteReopenedEvent = GameEventOf<"ROUTE_REOPENED", { readonly routeId: RouteId }>;

// ---------------------------------------------------------------------------
// Contracts and reservations (ECO-001)
// ---------------------------------------------------------------------------

export type ContractOfferedEvent = GameEventOf<
  "CONTRACT_OFFERED",
  { readonly contractOfferId: ContractOfferId; readonly buyerId: BuyerId; readonly expiresAt: Tick }
>;

export type ContractOfferExpiredEvent = GameEventOf<
  "CONTRACT_OFFER_EXPIRED",
  { readonly contractOfferId: ContractOfferId }
>;

export type ContractAcceptedEvent = GameEventOf<
  "CONTRACT_ACCEPTED",
  {
    readonly contractOfferId: ContractOfferId;
    readonly contractId: ContractId;
    readonly buyerId: BuyerId;
    readonly reservationIds: readonly ReservationId[];
  }
>;

export type InstallmentOutcome = "FULFILLED" | "PARTIAL" | "MISSED";

/**
 * One installment's deadline passed and it was settled, exactly once (GDD §7).
 * Deliveries arriving on the deadline tick count as on time (SIM-001).
 */
export type InstallmentSettledEvent = GameEventOf<
  "INSTALLMENT_SETTLED",
  {
    readonly contractId: ContractId;
    /** 0-based. */
    readonly installmentIndex: number;
    readonly required: number;
    readonly delivered: number;
    readonly outcome: InstallmentOutcome;
    /** 20% of the contracted value of missing cases. Unpaid penalties become a liability. */
    readonly penalty: Money;
    readonly transactionId: TransactionId;
  }
>;

/** All installments settled. Only this counts toward victory (GDD §7 clarification). */
export type ContractCompletedEvent = GameEventOf<
  "CONTRACT_COMPLETED",
  { readonly contractId: ContractId; readonly outcomes: readonly InstallmentOutcome[] }
>;

export type ReservationReleasedEvent = GameEventOf<
  "RESERVATION_RELEASED",
  {
    readonly reservationId: ReservationId;
    /** `CONSUMED`: the holder used the goods up (a production job completing). Emitted in the holder's transaction. */
    readonly reason: "PLAYER" | "CONTRACT_ENDED" | "PRODUCTION_FAILED" | "DELIVERY_FAILED" | "CONSUMED";
  }
>;

// ---------------------------------------------------------------------------
// Progression (PROG-001)
// ---------------------------------------------------------------------------

export type ReputationChangeReason =
  | "FIRST_QUALIFYING_DELIVERY"
  | "INSTALLMENT_FULFILLED"
  | "CONSECUTIVE_INSTALLMENT"
  | "INSTALLMENT_PARTIAL"
  | "INSTALLMENT_MISSED"
  | "PRODUCT_REJECTED"
  | "DEAL_FELL_THROUGH";

export type ReputationChangedEvent = GameEventOf<
  "REPUTATION_CHANGED",
  {
    readonly from: number;
    readonly to: number;
    readonly reason: ReputationChangeReason;
    /** The delivery or contract behind the change, for the explanation UI. */
    readonly deliveryId: DeliveryId | null;
    readonly contractId: ContractId | null;
  }
>;

export type TierReachedEvent = GameEventOf<"TIER_REACHED", { readonly tierId: TierId }>;

export type UnlockGrantedEvent = GameEventOf<"UNLOCK_GRANTED", { readonly unlockId: UnlockId }>;

export type VictoryAchievedEvent = GameEventOf<
  "VICTORY_ACHIEVED",
  { readonly netWorth: Money; readonly reputation: number; readonly completedContractId: ContractId }
>;

/**
 * Explicit failure, so there's never a silent soft-lock (GDD §9). The insolvency
 * conditions, recovery, and the minimum restart path are decided in ADR 0020
 * (decisions 9 and 10).
 */
export type GameLostEvent = GameEventOf<"GAME_LOST", { readonly reason: "INSOLVENT" }>;

// ---------------------------------------------------------------------------
// Scheduled setbacks (issue #129)
// ---------------------------------------------------------------------------

/**
 * A scheduled SHAKEDOWN booked its loss (Dr LOSSES / Cr CASH). `assessed` is the
 * event's share of net worth; `amount`, what was booked, is `assessed` capped at
 * cash, so the loss never makes cash negative. Zero when there was nothing to take.
 */
export type LossBookedEvent = GameEventOf<
  "LOSS_BOOKED",
  {
    readonly reason: "RIVAL" | "POLICE";
    readonly assessed: Money;
    readonly amount: Money;
    /** Net worth on the event's tick, just before the loss. */
    readonly netWorthBefore: Money;
    readonly transactionId: TransactionId;
  }
>;

// ---------------------------------------------------------------------------
// Knowledge (ADR 0021 decision 7)
// ---------------------------------------------------------------------------

/**
 * The founder arrived somewhere and caught up on what changed while they were
 * away. The same content is stored in `knowledge.lastCatchUp`.
 */
export type KnowledgeCaughtUpEvent = GameEventOf<"KNOWLEDGE_CAUGHT_UP", Omit<CatchUp, "tick">>;

// ---------------------------------------------------------------------------
// The founder (ADR 0023). None fires with `founderRules: false`.
// ---------------------------------------------------------------------------

/** The founder set out (TRAVEL, ADR 0023 decision 3). */
export type FounderDepartedEvent = GameEventOf<
  "FOUNDER_DEPARTED",
  { readonly from: LocationId; readonly to: LocationId; readonly transport: Transport }
>;

/** The founder reached the destination of a TRAVEL (ADR 0023 decision 3). */
export type FounderArrivedEvent = GameEventOf<"FOUNDER_ARRIVED", { readonly locationId: LocationId }>;

/**
 * A vehicle leg's route was closed when the leg should start, so the trip
 * stopped at the junction `locationId` (ADR 0023 decision 3).
 */
export type FounderHaltedEvent = GameEventOf<"FOUNDER_HALTED", { readonly routeId: RouteId; readonly locationId: LocationId }>;

/** The founder lay down to rest until `until` (REST, ADR 0023 decision 7). */
export type FounderRestedEvent = GameEventOf<"FOUNDER_RESTED", { readonly locationId: LocationId; readonly until: Tick }>;

/** The founder woke: at the rest's end, or `early` by WAKE (ADR 0023 decision 7). */
export type FounderWokeEvent = GameEventOf<"FOUNDER_WOKE", { readonly locationId: LocationId; readonly early: boolean }>;

// ---------------------------------------------------------------------------
// Telephones, rooms and arrangements (ADR 0024, ADR 0027). None fires with
// `founderRules: false`.
// ---------------------------------------------------------------------------

/**
 * The founder placed a call from `fromLocationId` to `locationId` (ADR 0024
 * decision 3). Applied either way: `answeredBy` is null when nobody answered,
 * and then the transaction has no entries (the coin comes back).
 */
export type CallPlacedEvent = GameEventOf<
  "CALL_PLACED",
  {
    readonly fromLocationId: LocationId;
    readonly locationId: LocationId;
    readonly answered: boolean;
    readonly answeredBy: CallAnswerer | null;
    readonly transactionId: TransactionId;
  }
>;

/** A party called the family and the founder answered at `phoneLocationId` (ADR 0024 decision 5). */
export type CallReceivedEvent = GameEventOf<
  "CALL_RECEIVED",
  { readonly callerLocationId: LocationId; readonly phoneLocationId: LocationId; readonly reason: CallInReason }
>;

/** A party called and a message was taken at `heldAtLocationId` (ADR 0024 decision 6). Hidden until delivered. */
export type MessageTakenEvent = GameEventOf<
  "MESSAGE_TAKEN",
  {
    readonly callerLocationId: LocationId;
    readonly heldAtLocationId: LocationId;
    /** null: the keeper of the place, not a character. */
    readonly takenBy: CharacterId | null;
    readonly reason: CallInReason;
  }
>;

/** The messages held at `locationId` reached the founder (ADR 0024 decision 6). */
export type MessagesDeliveredEvent = GameEventOf<
  "MESSAGES_DELIVERED",
  {
    readonly locationId: LocationId;
    readonly count: number;
    /** Messages dropped there past MESSAGE_LIMIT before this delivery. */
    readonly dropped: number;
    readonly via: "ARRIVAL" | "PRESENT" | "CALL";
  }
>;

/** A telephone line was installed at one of the family's facilities (ADR 0024 decision 2). */
export type PhoneInstalledEvent = GameEventOf<
  "PHONE_INSTALLED",
  { readonly facilityId: FacilityId; readonly price: Money; readonly transactionId: TransactionId }
>;

/** The founder rented a room for a stay until `until` (ADR 0027 decision 4). */
export type RoomRentedEvent = GameEventOf<
  "ROOM_RENTED",
  { readonly locationId: LocationId; readonly until: Tick; readonly price: Money; readonly transactionId: TransactionId }
>;

/** A dealing newly granted a privilege of the arrangement at `locationId` (ADR 0027 decision 3). */
export type ArrangementGrantedEvent = GameEventOf<
  "ARRANGEMENT_GRANTED",
  { readonly locationId: LocationId; readonly privilege: ArrangementPrivilege }
>;

// ---------------------------------------------------------------------------
// The union
// ---------------------------------------------------------------------------

export type GameEvent =
  | CommandRejectedEvent
  | DaySettledEvent
  | MaterialsPurchasedEvent
  | ProductionStartedEvent
  | ProductionCompletedEvent
  | ProductionFailedEvent
  | EquipmentPurchasedEvent
  | EquipmentSoldEvent
  | WorkforceChangedEvent
  | DeliveryDispatchedEvent
  | DeliveryDelayedEvent
  | SaleCompletedEvent
  | TransferCompletedEvent
  | DealFellThroughEvent
  | CargoLostEvent
  | VehicleReturnedEvent
  | MarketUpdatedEvent
  | ShortageStartedEvent
  | ShortageEndedEvent
  | RouteClosedEvent
  | RouteReopenedEvent
  | ContractOfferedEvent
  | ContractOfferExpiredEvent
  | ContractAcceptedEvent
  | InstallmentSettledEvent
  | ContractCompletedEvent
  | ReservationReleasedEvent
  | ReputationChangedEvent
  | TierReachedEvent
  | UnlockGrantedEvent
  | VictoryAchievedEvent
  | GameLostEvent
  | LossBookedEvent
  | KnowledgeCaughtUpEvent
  | FounderDepartedEvent
  | FounderArrivedEvent
  | FounderHaltedEvent
  | FounderRestedEvent
  | FounderWokeEvent
  | DealAgreedEvent
  | DealExpiredEvent
  | SpecSaleSettledEvent
  | RouteFoundClosedEvent
  | CallPlacedEvent
  | CallReceivedEvent
  | MessageTakenEvent
  | MessagesDeliveredEvent
  | PhoneInstalledEvent
  | RoomRentedEvent
  | ArrangementGrantedEvent;

export type GameEventType = GameEvent["type"];

/** Narrow by type: `EventOfType<"SALE_COMPLETED">`. */
export type EventOfType<T extends GameEventType> = Extract<GameEvent, { type: T }>;

/**
 * How the worker publishes each event (architecture §4: important events go out
 * immediately, the rest ride along with the next periodic snapshot).
 * - `notify`: publish immediately; the UI may show a notification.
 * - `log`: publish with the next snapshot; shown in history and explanations only.
 * A `Record` over every type, so adding an event without classifying it won't compile.
 */
export const EVENT_IMPORTANCE: Readonly<Record<GameEventType, "notify" | "log">> = {
  COMMAND_REJECTED: "notify",
  DAY_SETTLED: "log",
  MATERIALS_PURCHASED: "log",
  PRODUCTION_STARTED: "log",
  PRODUCTION_COMPLETED: "notify",
  PRODUCTION_FAILED: "notify",
  EQUIPMENT_PURCHASED: "log",
  EQUIPMENT_SOLD: "log",
  WORKFORCE_CHANGED: "log",
  DELIVERY_DISPATCHED: "log",
  DELIVERY_DELAYED: "notify",
  SALE_COMPLETED: "notify",
  TRANSFER_COMPLETED: "log",
  DEAL_FELL_THROUGH: "notify",
  CARGO_LOST: "notify",
  VEHICLE_RETURNED: "log",
  MARKET_UPDATED: "log",
  SHORTAGE_STARTED: "notify",
  SHORTAGE_ENDED: "notify",
  ROUTE_CLOSED: "notify",
  ROUTE_REOPENED: "notify",
  CONTRACT_OFFERED: "notify",
  CONTRACT_OFFER_EXPIRED: "log",
  CONTRACT_ACCEPTED: "log",
  INSTALLMENT_SETTLED: "notify",
  CONTRACT_COMPLETED: "notify",
  RESERVATION_RELEASED: "log",
  REPUTATION_CHANGED: "log",
  TIER_REACHED: "notify",
  UNLOCK_GRANTED: "notify",
  VICTORY_ACHIEVED: "notify",
  GAME_LOST: "notify",
  // No player-facing copy in M001 (issue #129: only the lab's setback scenario schedules one).
  LOSS_BOOKED: "log",
  // The player sees catch-ups through the player snapshot (`catchUp`, `activity`), never as a world-event toast.
  KNOWLEDGE_CAUGHT_UP: "log",
  // The founder's own comings and goings: the player sees them through the
  // player snapshot's `founder` section, not as world-event toasts.
  FOUNDER_DEPARTED: "log",
  FOUNDER_ARRIVED: "log",
  FOUNDER_HALTED: "log",
  FOUNDER_RESTED: "log",
  FOUNDER_WOKE: "log",
  // Deals and outcomes (ADR 0022 decisions 6 and 9). The founder learns them
  // through the player snapshot (activity, news, the deal list), not as
  // world-event toasts. DEAL_AGREED is the founder's own command.
  DEAL_AGREED: "log",
  DEAL_EXPIRED: "log",
  SPEC_SALE_SETTLED: "log",
  ROUTE_FOUND_CLOSED: "log",
  // Telephones, rooms and arrangements (ADR 0024, ADR 0027). The founder learns
  // them through the player snapshot (activity items, `founder`, `places`), never
  // as world-event toasts; MESSAGE_TAKEN is hidden until the message is delivered.
  CALL_PLACED: "log",
  CALL_RECEIVED: "log",
  MESSAGE_TAKEN: "log",
  MESSAGES_DELIVERED: "log",
  PHONE_INSTALLED: "log",
  ROOM_RENTED: "log",
  ARRANGEMENT_GRANTED: "log",
};

export const GAME_EVENT_TYPES = Object.keys(EVENT_IMPORTANCE) as readonly GameEventType[];

/**
 * Which place an event concerns, for pending news (ADR 0021 decision 7). While
 * the founder isn't at that place, a tagged event becomes a `NewsItem` in its
 * pending news; arriving there (or a channel covering it) delivers it.
 * - `FACILITY`: the event's `facilityId`;
 * - `DELIVERY_ORIGIN`: an event on a road concerns the origin facility of its
 *   delivery, where the crew would bring the story home;
 * - null: not news. A diff of the live view covers it, or a channel reports it.
 * A `Record` over every type, so adding an event without tagging it won't compile.
 */
export const EVENT_CONCERNS_PLACE = {
  COMMAND_REJECTED: null,
  DAY_SETTLED: null,
  MATERIALS_PURCHASED: null,
  PRODUCTION_STARTED: null,
  PRODUCTION_COMPLETED: null,
  PRODUCTION_FAILED: "FACILITY",
  EQUIPMENT_PURCHASED: null,
  EQUIPMENT_SOLD: null,
  WORKFORCE_CHANGED: null,
  DELIVERY_DISPATCHED: null,
  DELIVERY_DELAYED: "DELIVERY_ORIGIN",
  SALE_COMPLETED: null,
  TRANSFER_COMPLETED: null,
  DEAL_FELL_THROUGH: "DELIVERY_ORIGIN",
  CARGO_LOST: "DELIVERY_ORIGIN",
  VEHICLE_RETURNED: null,
  MARKET_UPDATED: null,
  SHORTAGE_STARTED: null,
  SHORTAGE_ENDED: null,
  ROUTE_CLOSED: null,
  ROUTE_REOPENED: null,
  CONTRACT_OFFERED: null,
  CONTRACT_OFFER_EXPIRED: null,
  CONTRACT_ACCEPTED: null,
  INSTALLMENT_SETTLED: null,
  CONTRACT_COMPLETED: null,
  RESERVATION_RELEASED: null,
  REPUTATION_CHANGED: null,
  TIER_REACHED: null,
  UNLOCK_GRANTED: null,
  VICTORY_ACHIEVED: null,
  GAME_LOST: null,
  LOSS_BOOKED: null,
  KNOWLEDGE_CAUGHT_UP: null,
  FOUNDER_DEPARTED: null,
  FOUNDER_ARRIVED: null,
  FOUNDER_HALTED: null,
  FOUNDER_RESTED: null,
  FOUNDER_WOKE: null,
  // An agreement's state: always known (ADR 0022 decision 9).
  DEAL_AGREED: null,
  DEAL_EXPIRED: null,
  // Revealed by the SALE cash posting, or the VEHICLE_RETURN posting for a 0 take (ADR 0022 decision 9).
  SPEC_SALE_SETTLED: null,
  // News at the delivery's origin facility; learned directly if aboard (ADR 0022 decision 9).
  ROUTE_FOUND_CLOSED: "DELIVERY_ORIGIN",
  // The founder's own commands, and channels with their own delivery: a call in
  // the founder answers is learned at once, a message when it's delivered
  // (ADR 0024 decision 6), never as news.
  CALL_PLACED: null,
  CALL_RECEIVED: null,
  MESSAGE_TAKEN: null,
  MESSAGES_DELIVERED: null,
  PHONE_INSTALLED: null,
  ROOM_RENTED: null,
  ARRANGEMENT_GRANTED: null,
} as const satisfies Readonly<Record<GameEventType, "FACILITY" | "DELIVERY_ORIGIN" | null>>;

/** Event types that become news at the place they concern. */
export type PlaceTaggedEventType = {
  [T in GameEventType]: (typeof EVENT_CONCERNS_PLACE)[T] extends null ? never : T;
}[GameEventType];

/** Events kept in the journal for history and explanations (ADR 0006). Not a gameplay value. */
export const EVENT_JOURNAL_CAPACITY = 1_000;
