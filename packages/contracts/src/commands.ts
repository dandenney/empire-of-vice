// Player commands, how they're scheduled, and their results.
// See docs/decisions/0004-command-identity-and-timing.md and 0005-delivery-deals-and-payment.md.
//
// A command is the player's intent. The simulation applies it atomically or
// rejects it with a typed reason. It never partially mutates state
// (architecture §4). Future manager AI goes through the same commands (GDD §9).

import type { CargoLine, QualityTier } from "./goods.ts";
import type {
  BuyerId,
  CommandId,
  ContractId,
  ContractOfferId,
  EquipmentId,
  EventId,
  FacilityId,
  Id,
  IdKind,
  MaterialId,
  ProductId,
  RecipeId,
  ReservationId,
  RouteId,
  SupplierId,
  UnlockId,
  VehicleId,
} from "./ids.ts";
import type { Money } from "./money.ts";
import type { Tick } from "./time.ts";

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** GDD §4 action 1. Materials go into raw inventory at the facility at today's supplier price. */
export interface PurchaseMaterialsCommand {
  readonly type: "PURCHASE_MATERIALS";
  readonly supplierId: SupplierId;
  readonly materialId: MaterialId;
  readonly quantity: number;
  readonly facilityId: FacilityId;
}

/**
 * GDD §4 action 2. The recipe fixes the inputs, output product, and quality tier.
 * Starting a job reserves its inputs and capacity (PROD-001).
 */
export interface StartProductionCommand {
  readonly type: "START_PRODUCTION";
  readonly facilityId: FacilityId;
  readonly recipeId: RecipeId;
  /** Output cases. */
  readonly quantity: number;
}

/**
 * Why a truck is being sent. A sale to a buyer is a deal struck at dispatch:
 * quantity and unit price are fixed now, and the buyer pays cash on delivery (ADR 0005).
 */
export type DeliveryPurpose =
  | {
      readonly kind: "SALE";
      readonly buyerId: BuyerId;
      /**
       * The per-case price the player agreed to, as shown in the UI. If it no longer
       * matches the buyer's quote when the command applies, the command is rejected
       * with QUOTE_CHANGED rather than silently selling at a different price.
       */
      readonly agreedUnitPrice: Money;
    }
  | { readonly kind: "CONTRACT_INSTALLMENT"; readonly contractId: ContractId }
  | { readonly kind: "TRANSFER"; readonly destinationFacilityId: FacilityId };

/**
 * GDD §4 actions 4 and 8. Cargo is loaded from inventory at the vehicle's current
 * location. The vehicle returns to where it started after delivering.
 */
export interface DispatchDeliveryCommand {
  readonly type: "DISPATCH_DELIVERY";
  readonly vehicleId: VehicleId;
  readonly cargo: readonly CargoLine[];
  readonly purpose: DeliveryPurpose;
  /** Optional, so the player can route around a disruption. Omitted: the default route. */
  readonly routeId?: RouteId;
}

/** GDD §4 action 7. Reserves contract inventory and funds as GDD §7 requires. */
export interface AcceptContractCommand {
  readonly type: "ACCEPT_CONTRACT";
  readonly contractOfferId: ContractOfferId;
}

/** GDD §4 action 6. Storage expansion is a kind of equipment. */
export interface PurchaseEquipmentCommand {
  readonly type: "PURCHASE_EQUIPMENT";
  readonly facilityId: FacilityId;
  readonly equipmentId: EquipmentId;
}

/**
 * GDD §4 action 6, and cutting costs during recovery (GDD §9). Sets the number of
 * generic workers at a facility, so one command covers both hiring and laying off.
 */
export interface SetWorkforceCommand {
  readonly type: "SET_WORKFORCE";
  readonly facilityId: FacilityId;
  readonly workerCount: number;
}

/** GDD §7: the player may release reserved inventory, accepting the risk of missing an installment. */
export interface ReleaseReservationCommand {
  readonly type: "RELEASE_RESERVATION";
  readonly reservationId: ReservationId;
}

/**
 * GDD §9 earned automation, level 2: re-issue a previously applied operation.
 * The source command is copied and fully re-validated against current state.
 * A repeated SALE uses the buyer's current quote, so it can't lock in a stale price.
 */
export interface RepeatOperationCommand {
  readonly type: "REPEAT_OPERATION";
  readonly sourceCommandId: CommandId;
}

export type GameCommand =
  | PurchaseMaterialsCommand
  | StartProductionCommand
  | DispatchDeliveryCommand
  | AcceptContractCommand
  | PurchaseEquipmentCommand
  | SetWorkforceCommand
  | ReleaseReservationCommand
  | RepeatOperationCommand;

export type GameCommandType = GameCommand["type"];

/** Commands REPEAT_OPERATION can repeat. */
export type RepeatableCommand = PurchaseMaterialsCommand | StartProductionCommand | DispatchDeliveryCommand;

export const GAME_COMMAND_TYPES = [
  "PURCHASE_MATERIALS",
  "START_PRODUCTION",
  "DISPATCH_DELIVERY",
  "ACCEPT_CONTRACT",
  "PURCHASE_EQUIPMENT",
  "SET_WORKFORCE",
  "RELEASE_RESERVATION",
  "REPEAT_OPERATION",
] as const satisfies readonly GameCommandType[];

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/** What a caller passes to `Simulation.dispatch`. */
export interface CommandRequest {
  readonly command: GameCommand;
  /**
   * When to apply it. Omitted: apply now, as the first thing of the next tick
   * (`state.tick + 1`). A later tick queues it; scripted lab strategies and
   * timed-command determinism tests use this (SIM-001). Earlier ticks are rejected.
   */
  readonly scheduledTick?: Tick;
}

/**
 * A command as journaled and saved. The simulation assigns `id` and `sequence`
 * at dispatch, so both are deterministic. Commands apply in (scheduledTick, sequence) order.
 */
export interface CommandEnvelope {
  readonly id: CommandId;
  readonly scheduledTick: Tick;
  readonly sequence: number;
  readonly command: GameCommand;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type CommandResult =
  /** Applied atomically. `eventIds` are the events it emitted, in order. */
  | { readonly status: "applied"; readonly commandId: CommandId; readonly tick: Tick; readonly eventIds: readonly EventId[] }
  /**
   * Queued for a future tick. It's validated again when it applies; if it fails then,
   * a COMMAND_REJECTED event carries the reason.
   */
  | { readonly status: "queued"; readonly commandId: CommandId; readonly scheduledTick: Tick }
  /** Rejected. Nothing changed. */
  | { readonly status: "rejected"; readonly commandId: CommandId; readonly reason: RejectionReason };

// ---------------------------------------------------------------------------
// Rejection reasons
// ---------------------------------------------------------------------------

/**
 * Why a command was rejected. Every reason carries the data a UI needs to explain
 * it ("Buyer will only take 6 cases"). Systems that need a new reason request a
 * contract change rather than overloading an existing one.
 */
export type RejectionReason =
  // Shape and scheduling
  | { readonly code: "INVALID_QUANTITY"; readonly field: string; readonly value: number }
  | { readonly code: "SCHEDULED_IN_PAST"; readonly scheduledTick: Tick; readonly currentTick: Tick }
  | { readonly code: "UNKNOWN_ENTITY"; readonly kind: IdKind; readonly id: Id<IdKind> }
  | { readonly code: "LOCKED"; readonly unlockId: UnlockId }
  | { readonly code: "REPUTATION_TOO_LOW"; readonly required: number; readonly current: number }
  // Money
  | { readonly code: "INSUFFICIENT_FUNDS"; readonly required: Money; readonly available: Money }
  // Suppliers and materials
  | { readonly code: "SUPPLIER_STOCK_LOW"; readonly materialId: MaterialId; readonly requested: number; readonly available: number }
  | { readonly code: "MATERIAL_NOT_SOLD"; readonly supplierId: SupplierId; readonly materialId: MaterialId }
  // Facilities and production
  | { readonly code: "INSUFFICIENT_MATERIALS"; readonly materialId: MaterialId; readonly required: number; readonly available: number }
  | { readonly code: "RECIPE_NOT_SUPPORTED"; readonly facilityId: FacilityId; readonly recipeId: RecipeId }
  | { readonly code: "PRODUCTION_CAPACITY_EXCEEDED"; readonly facilityId: FacilityId; readonly requested: number; readonly available: number }
  | { readonly code: "STORAGE_CAPACITY_EXCEEDED"; readonly facilityId: FacilityId; readonly requested: number; readonly available: number }
  | { readonly code: "WORKFORCE_LIMIT_EXCEEDED"; readonly facilityId: FacilityId; readonly requested: number; readonly maximum: number }
  | { readonly code: "NO_EQUIPMENT_SLOT"; readonly facilityId: FacilityId; readonly equipmentId: EquipmentId }
  | { readonly code: "EQUIPMENT_ALREADY_OWNED"; readonly facilityId: FacilityId; readonly equipmentId: EquipmentId }
  // Inventory
  | { readonly code: "INSUFFICIENT_STOCK"; readonly productId: ProductId; readonly quality: QualityTier; readonly requested: number; readonly available: number }
  | { readonly code: "RESERVATION_NOT_ACTIVE"; readonly reservationId: ReservationId }
  // Vehicles and routes
  | { readonly code: "VEHICLE_UNAVAILABLE"; readonly vehicleId: VehicleId }
  | { readonly code: "VEHICLE_CAPACITY_EXCEEDED"; readonly vehicleId: VehicleId; readonly requested: number; readonly capacity: number }
  | { readonly code: "NO_ROUTE"; readonly vehicleId: VehicleId }
  | { readonly code: "ROUTE_CLOSED"; readonly routeId: RouteId; readonly reopensAt: Tick | null }
  // Buyers and deals (ADR 0005)
  | { readonly code: "QUOTE_CHANGED"; readonly buyerId: BuyerId; readonly agreed: Money; readonly current: Money }
  | { readonly code: "BUYER_WILL_TAKE_LESS"; readonly buyerId: BuyerId; readonly requested: number; readonly acceptable: number }
  | { readonly code: "PRODUCT_NOT_WANTED"; readonly buyerId: BuyerId; readonly productId: ProductId; readonly quality: QualityTier }
  // Contracts
  | { readonly code: "OFFER_UNAVAILABLE"; readonly contractOfferId: ContractOfferId }
  | { readonly code: "CONTRACT_NOT_ACTIVE"; readonly contractId: ContractId }
  | { readonly code: "CARGO_DOES_NOT_MATCH_CONTRACT"; readonly contractId: ContractId }
  // Repeat orders
  | { readonly code: "NOT_REPEATABLE"; readonly sourceCommandId: CommandId };

export type RejectionCode = RejectionReason["code"];
