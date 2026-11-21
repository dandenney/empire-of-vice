// Player commands, how they're scheduled, and their results.
// See docs/decisions/0004-command-identity-and-timing.md, 0005-delivery-deals-and-payment.md
// and 0022-orders-authority-outcomes.md.
//
// A command is the player's intent. The simulation applies it atomically or
// rejects it with a typed reason. It never partially mutates state
// (architecture §4). Future manager AI goes through the same commands (GDD §9).

import type { CargoLine, QualityTier } from "./goods.ts";
import type {
  BuyerId,
  CharacterId,
  CommandId,
  ContractId,
  ContractOfferId,
  DealId,
  EquipmentId,
  EventId,
  FacilityId,
  Id,
  IdKind,
  LocationId,
  MaterialId,
  ProductId,
  RecipeId,
  ReservationId,
  RouteId,
  StandingOrderId,
  SupplierId,
  UnlockId,
  VehicleId,
} from "./ids.ts";
import type { Money } from "./money.ts";
import type { DriverRef, EmployeeRole, RouteLeg, StandingOrderTerms, Transport } from "./state.ts";
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
 * Why a truck is being sent. The buyer pays cash on delivery (ADR 0005). A sale
 * either carries out a held deal (`dealId`: quantity and price were fixed by
 * AGREE_DEAL), or goes on spec (`dealId: null`): the buyer takes what they want
 * at that day's quote when the truck arrives (ADR 0022 decision 6).
 */
export type DeliveryPurpose =
  | {
      readonly kind: "SALE";
      readonly buyerId: BuyerId;
      /** The held deal this dispatch carries out, or null for a sale on spec. */
      readonly dealId: DealId | null;
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
  /**
   * Lets the player route around a disruption. null: the default route.
   * Explicit null, not optional, because commands are stored in state (ADR 0008).
   */
  readonly routeId: RouteId | null;
  /**
   * Who drives (ADR 0023 decision 5). A new dispatch names one; null only in
   * commands migrated from a pre-M002 save (ADR 0023 decision 10). With
   * `founderRules: false`, a FOUNDER driver doesn't put the founder aboard.
   */
  readonly driver: DriverRef | null;
}

/**
 * Agrees a deal with a buyer ahead of the run (ADR 0022 decision 6): the buyer
 * commits demand (and, in person, budget) at `agreedUnitPrice` for this quantity
 * and quality, held until `DEAL_HOLD_TICKS` (game-data) after agreeing. A
 * DISPATCH_DELIVERY naming the deal carries it out. Checked as ADR 0005's sale
 * was: UNKNOWN_ENTITY, REPUTATION_TOO_LOW, PRODUCT_NOT_WANTED, QUOTE_CHANGED and
 * BUYER_WILL_TAKE_LESS.
 */
export interface AgreeDealCommand {
  readonly type: "AGREE_DEAL";
  readonly buyerId: BuyerId;
  readonly productId: ProductId;
  /** The cargo quality the deal is for, matched to the buyer's most specific want (ADR 0016). */
  readonly quality: QualityTier;
  readonly quantity: number;
  /** The per-case price the player saw. A different quote when it applies is QUOTE_CHANGED, never a silent re-price. */
  readonly agreedUnitPrice: Money;
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
 * Recovery by selling assets (GDD §9, §14.9; ADR 0020 decision 9). Sells one owned
 * equipment item at its resale value. The truck and the building can't be sold.
 * Not repeatable.
 */
export interface SellEquipmentCommand {
  readonly type: "SELL_EQUIPMENT";
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

/**
 * GDD §7: the player may release reserved inventory, accepting the risk of missing
 * an installment. Names the facility it acts at (ADR 0022 decision 3): the
 * reservation must be active there, otherwise RESERVATION_NOT_ACTIVE.
 */
export interface ReleaseReservationCommand {
  readonly type: "RELEASE_RESERVATION";
  readonly facilityId: FacilityId;
  readonly reservationId: ReservationId;
}

/**
 * GDD §9 earned automation, level 2: re-issue a previously applied operation.
 * The source command is copied and fully re-validated against current state.
 * A deal is single-use, so a repeated SALE never reuses its source's deal. With
 * `founderRules: false` it agrees a new deal at the buyer's current quote, in the
 * dispatch's own transaction, so it can't lock in a stale price (issue #192).
 */
export interface RepeatOperationCommand {
  readonly type: "REPEAT_OPERATION";
  readonly sourceCommandId: CommandId;
}

/**
 * The founder sets out for another place (ADR 0023 decision 3), on foot or
 * driving a truck parked where they are. With `founderRules: false` it's
 * accepted and changes nothing (decision 9).
 */
export interface TravelCommand {
  readonly type: "TRAVEL";
  readonly destinationLocationId: LocationId;
  readonly transport: Transport;
  /**
   * A simple path from the founder's place to the destination. null: the
   * shortest by total duration, avoiding routes known to be closed when driving.
   */
  readonly via: readonly RouteLeg[] | null;
}

/**
 * The founder rests where they are until `untilTick` (ADR 0023 decision 7),
 * which must be within [apply tick + MIN_REST_TICKS, apply tick + MAX_REST_TICKS].
 * With `founderRules: false` it's accepted and changes nothing (decision 9).
 */
export interface RestCommand {
  readonly type: "REST";
  readonly untilTick: Tick;
}

/** Ends a rest early (ADR 0023 decision 7). Instant. A no-op with `founderRules: false`. */
export interface WakeCommand {
  readonly type: "WAKE";
}

/**
 * The founder calls a place from the phone where they stand (ADR 0024 decision 3,
 * ADR 0027 decision 5). Phones are places, so the target is a location, not a
 * party. Applied whether or not anyone answers. A no-op with `founderRules: false`.
 */
export interface PlaceCallCommand {
  readonly type: "PLACE_CALL";
  /** The place being called. */
  readonly locationId: LocationId;
}

/**
 * The family has a telephone line put in at one of its facilities (ADR 0024
 * decision 2). A timed activity, present at the facility. A no-op with
 * `founderRules: false`.
 */
export interface InstallPhoneCommand {
  readonly type: "INSTALL_PHONE";
  readonly facilityId: FacilityId;
}

/**
 * The founder rents a room where they stand, paying for a stay to the next
 * checkout (ADR 0027 decision 4). A timed activity at the desk. A no-op with
 * `founderRules: false`.
 */
export interface RentRoomCommand {
  readonly type: "RENT_ROOM";
  readonly locationId: LocationId;
}

/**
 * The founder hires a candidate on the slate where they stand (ADR 0025 decision 4,
 * ADR 0028 decisions 4 and 5). A timed activity (HIRE), in person at an open
 * hiring place for the role. A no-op with `founderRules: false` (decision 13).
 */
export interface HireEmployeeCommand {
  readonly type: "HIRE_EMPLOYEE";
  readonly characterId: CharacterId;
  readonly role: EmployeeRole;
  readonly stationId: FacilityId;
  /** The asking wage the founder accepted. Guards against a slate changing under a stale UI (CANDIDATE_TERMS_CHANGED). */
  readonly dailyWage: Money;
  /**
   * The first standing order, given in the hiring conversation (ADR 0028
   * decision 5), or null to brief them later.
   */
  readonly standingOrder: StandingOrderTerms | null;
}

/**
 * Gives, changes or cancels an employee's standing order (ADR 0025 decision 5).
 * Reaches them in person at their station (timed: BRIEF_EMPLOYEE) or on a call
 * they answered. A no-op with `founderRules: false`.
 */
export interface SetStandingOrderCommand {
  readonly type: "SET_STANDING_ORDER";
  readonly characterId: CharacterId;
  /** null cancels: the employee stays on the books and idles. */
  readonly terms: StandingOrderTerms | null;
}

/**
 * Lets an employee go (ADR 0025 decision 4). Reaches them as SET_STANDING_ORDER
 * does. A no-op with `founderRules: false`.
 */
export interface DismissEmployeeCommand {
  readonly type: "DISMISS_EMPLOYEE";
  readonly characterId: CharacterId;
}

/**
 * Fill free barrels with mash (ADR 0029 decision 4). In person at the facility;
 * MASH long. A founder-rules production command.
 */
export interface SetMashCommand {
  readonly type: "SET_MASH";
  readonly facilityId: FacilityId;
  readonly recipeId: RecipeId;
  /** How many free barrels to fill, each with one barrel of the recipe's mash. */
  readonly barrels: number;
}

/**
 * Distill every ready wash of the recipe at the facility in one run (ADR 0029
 * decision 4). The operator is tied to the still for the run.
 */
export interface StartDistillationCommand {
  readonly type: "START_DISTILLATION";
  readonly facilityId: FacilityId;
  readonly recipeId: RecipeId;
}

export type GameCommand =
  | PurchaseMaterialsCommand
  | StartProductionCommand
  | DispatchDeliveryCommand
  | AcceptContractCommand
  | PurchaseEquipmentCommand
  | SetWorkforceCommand
  | ReleaseReservationCommand
  | RepeatOperationCommand
  | SellEquipmentCommand
  | TravelCommand
  | RestCommand
  | WakeCommand
  | AgreeDealCommand
  | PlaceCallCommand
  | InstallPhoneCommand
  | RentRoomCommand
  | HireEmployeeCommand
  | SetStandingOrderCommand
  | DismissEmployeeCommand
  | SetMashCommand
  | StartDistillationCommand;

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
  "SELL_EQUIPMENT",
  "TRAVEL",
  "REST",
  "WAKE",
  "AGREE_DEAL",
  "PLACE_CALL",
  "INSTALL_PHONE",
  "RENT_ROOM",
  "HIRE_EMPLOYEE",
  "SET_STANDING_ORDER",
  "DISMISS_EMPLOYEE",
  "SET_MASH",
  "START_DISTILLATION",
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

/** The founder: the issuer of every player command, and so of every envelope. */
export type FounderIssuer = { readonly kind: "FOUNDER" };

/**
 * Who issued a command (ADR 0022 decision 5, amended by ADR 0025 decision 6).
 * Player commands are always the FOUNDER's. An EMPLOYEE command is issued under
 * a standing order by the `employees` phase; it has no envelope, so this type
 * rides on the simulation's command context and on `EMPLOYEE_ACTED`, never on
 * `CommandEnvelope`.
 */
export type CommandIssuer =
  | FounderIssuer
  | { readonly kind: "EMPLOYEE"; readonly characterId: CharacterId; readonly standingOrderId: StandingOrderId };

/**
 * A command as journaled and saved. The simulation assigns `id` and `sequence`
 * at dispatch, so both are deterministic. Commands apply in (scheduledTick, sequence) order.
 */
export interface CommandEnvelope {
  readonly id: CommandId;
  readonly scheduledTick: Tick;
  readonly sequence: number;
  /**
   * Always the founder (ADR 0025 decision 6): employee commands have no
   * envelope, are never logged or queued, and replay re-derives them from state.
   */
  readonly issuer: FounderIssuer;
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

/**
 * What the worker returns to the game UI for a command (ADR 0021 decision 2): the
 * status, the command ID and, if rejected, the reason. No `eventIds`: event IDs
 * come from one global counter, so their numbers depend on activity the founder
 * hasn't observed (decision 9).
 */
export type PlayerCommandResult =
  | { readonly status: "applied"; readonly commandId: CommandId; readonly tick: Tick }
  | { readonly status: "queued"; readonly commandId: CommandId; readonly scheduledTick: Tick }
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
  /** SELL_EQUIPMENT for an item the facility doesn't have (ADR 0020 decision 9). */
  | { readonly code: "EQUIPMENT_NOT_OWNED"; readonly facilityId: FacilityId; readonly equipmentId: EquipmentId }
  // Inventory
  | { readonly code: "INSUFFICIENT_STOCK"; readonly productId: ProductId; readonly quality: QualityTier; readonly requested: number; readonly available: number }
  | { readonly code: "RESERVATION_NOT_ACTIVE"; readonly reservationId: ReservationId }
  // Vehicles and routes
  | { readonly code: "VEHICLE_UNAVAILABLE"; readonly vehicleId: VehicleId }
  | { readonly code: "VEHICLE_CAPACITY_EXCEEDED"; readonly vehicleId: VehicleId; readonly requested: number; readonly capacity: number }
  | { readonly code: "NO_ROUTE"; readonly vehicleId: VehicleId }
  | { readonly code: "ROUTE_CLOSED"; readonly routeId: RouteId; readonly reopensAt: Tick | null }
  // Buyers and deals (ADR 0005; checked by AGREE_DEAL since ADR 0022 decision 6)
  | { readonly code: "QUOTE_CHANGED"; readonly buyerId: BuyerId; readonly agreed: Money; readonly current: Money }
  | { readonly code: "BUYER_WILL_TAKE_LESS"; readonly buyerId: BuyerId; readonly requested: number; readonly acceptable: number }
  | { readonly code: "PRODUCT_NOT_WANTED"; readonly buyerId: BuyerId; readonly productId: ProductId; readonly quality: QualityTier }
  /** A sale names a deal the founder doesn't hold: never agreed, already dispatched, or ended (ADR 0022 decision 6). */
  | { readonly code: "DEAL_UNAVAILABLE"; readonly dealId: DealId }
  /** A sale's buyer or cargo (product, quality, quantity) isn't what its deal was agreed for (ADR 0022 decision 6). */
  | { readonly code: "CARGO_DOES_NOT_MATCH_DEAL"; readonly dealId: DealId }
  // Contracts
  | { readonly code: "OFFER_UNAVAILABLE"; readonly contractOfferId: ContractOfferId }
  | { readonly code: "CONTRACT_NOT_ACTIVE"; readonly contractId: ContractId }
  | { readonly code: "CARGO_DOES_NOT_MATCH_CONTRACT"; readonly contractId: ContractId }
  // Repeat orders
  | { readonly code: "NOT_REPEATABLE"; readonly sourceCommandId: CommandId }
  // Presence, shared by ADR 0022 and ADR 0023. Each depends only on always-known
  // state (the founder's whereabouts, place hours, the founder's own place), so
  // showing it leaks nothing (ADR 0021 decision 9).
  /** Not at the place the command needs. Travelling, riding or resting count as not present (ADR 0022 decision 3). */
  | { readonly code: "NOT_PRESENT"; readonly requiredLocationId: LocationId; readonly issuerLocationId: LocationId | null }
  /** A timed activity is still running: busy through `until`, inclusive (ADR 0023 decision 2a). */
  | { readonly code: "FOUNDER_BUSY"; readonly until: Tick }
  /**
   * An activity with a party must start during their hours. `opensAt`: the next
   * tick the place opens, from known hours. For PLACE_CALL it comes from the
   * phone's own hours, and for RENT_ROOM from the desk's (ADR 0027 decision 16),
   * never from the place's PLACE_HOURS.
   */
  | { readonly code: "PLACE_CLOSED"; readonly locationId: LocationId; readonly opensAt: Tick }
  /**
   * The truck isn't parked at the place the founder acts from. `locationId` is
   * that place, never the truck's, so the reason reveals no VEHICLE_WHEREABOUTS
   * (ADR 0022 decision 3). VEHICLE_UNAVAILABLE stays for `founderRules: false`.
   */
  | { readonly code: "VEHICLE_NOT_AT"; readonly vehicleId: VehicleId; readonly locationId: LocationId }
  /** The named driver can't drive, or a new dispatch names none while founder rules are on (ADR 0022 decision 3). */
  | { readonly code: "NO_DRIVER"; readonly vehicleId: VehicleId }
  /**
   * An order someone else must carry out can't reach them: the founder isn't with
   * them and no call connects (ADR 0022 decision 4). From always-known facts only.
   */
  | { readonly code: "NO_WAY_TO_REACH"; readonly characterId: CharacterId }
  // The founder's own commands: TRAVEL, REST, WAKE (ADR 0023 decision 3a).
  /** TRAVEL, REST, PLACE_CALL or RENT_ROOM while the founder is travelling, riding a delivery, or resting. */
  | { readonly code: "FOUNDER_AWAY"; readonly whereabouts: "TRAVELLING" | "ON_DELIVERY" | "RESTING" }
  /** TRAVEL to, or PLACE_CALL of, the place the founder is already at. */
  | { readonly code: "ALREADY_THERE" }
  /** TRAVEL `via` isn't a simple path from the founder's place to the destination. */
  | { readonly code: "INVALID_PATH" }
  /** TRAVEL by vehicle: no path avoids the routes the founder knows to be closed. */
  | { readonly code: "NO_PATH"; readonly destinationLocationId: LocationId }
  /** REST `untilTick` outside the valid range. `min` and `max` are absolute ticks: the earliest and latest valid `untilTick` for the apply tick. */
  | { readonly code: "INVALID_REST_LENGTH"; readonly min: Tick; readonly max: Tick }
  /** WAKE while the founder isn't resting. */
  | { readonly code: "NOT_RESTING" }
  // Telephones and rooms (ADR 0024 decision 14, ADR 0027 decision 16). Every
  // payload is phone geography, the founder's place, room and arrangements, or
  // the founder's own facility: always known.
  /** PLACE_CALL: there's no phone at all where the founder stands (no family line, no PHONES entry). `locationId` is the founder's place. */
  | { readonly code: "NO_PHONE_HERE"; readonly locationId: LocationId }
  /** PLACE_CALL: the place called has no phone (no PHONES entry, no family line). */
  | { readonly code: "NO_PHONE_THERE"; readonly locationId: LocationId }
  /** INSTALL_PHONE at a facility that already has a line. */
  | { readonly code: "PHONE_ALREADY_INSTALLED"; readonly facilityId: FacilityId }
  /**
   * PLACE_CALL from a phone the founder may not use now, whatever the hours
   * (ADR 0027 decision 5): a PRIVATE line, a GUEST phone with no room held there,
   * or an ARRANGEMENT phone whose arrangement doesn't grant PHONE_USE.
   */
  | { readonly code: "PHONE_USE_NOT_GRANTED"; readonly locationId: LocationId; readonly rule: "PRIVATE" | "GUEST" | "ARRANGEMENT" }
  /** RENT_ROOM where there are no rooms to rent (no ROOMS entry, ADR 0027 decision 4). */
  | { readonly code: "NO_ROOMS_HERE"; readonly locationId: LocationId }
  // Employees (ADR 0025 decision 15). Every payload is the candidate's ID and the
  // slate's wage (shown in person), the founder's own facilities, the role, or
  // the standing order: always known or in the founder's view.
  /** HIRE_EMPLOYEE for someone not on the role's current slate here, including someone already employed. */
  | { readonly code: "CANDIDATE_UNAVAILABLE"; readonly characterId: CharacterId }
  /** HIRE_EMPLOYEE at a wage other than the candidate's current asking wage (`current`). */
  | { readonly code: "CANDIDATE_TERMS_CHANGED"; readonly characterId: CharacterId; readonly agreed: Money; readonly current: Money }
  /** The station can't host the role: a Distiller at a facility without recipe equipment. */
  | { readonly code: "STATION_UNSUITABLE"; readonly facilityId: FacilityId; readonly role: EmployeeRole }
  /** The station already has someone in that role. */
  | { readonly code: "POSITION_FILLED"; readonly facilityId: FacilityId; readonly role: EmployeeRole }
  /**
   * An employee's command outside their standing order's authority (ADR 0022
   * gate 4, ADR 0025 decision 5). Only ever an employee command's result,
   * reported in a report line, never a founder command's immediate result.
   */
  | { readonly code: "OUTSIDE_AUTHORITY"; readonly characterId: CharacterId; readonly standingOrderId: StandingOrderId; readonly limit: AuthorityLimit }
  // Two-stage production (ADR 0029 decision 14).
  /** START_PRODUCTION under founder rules: production there is SET_MASH then START_DISTILLATION (ADR 0029). */
  | { readonly code: "TWO_STAGE_RECIPE"; readonly facilityId: FacilityId; readonly recipeId: RecipeId }
  /** No wash of the recipe is ready there. readyAt: the soonest a fermenting one is ready, or null if none is fermenting. */
  | { readonly code: "NO_READY_WASH"; readonly facilityId: FacilityId; readonly recipeId: RecipeId; readonly readyAt: Tick | null };

/** Which part of a standing order an employee's command went beyond (ADR 0025 decision 5). */
export type AuthorityLimit = "COMMAND" | "STATION" | "RECIPE" | "BATCH_SIZE" | "SPENDING_CAP";

export type RejectionCode = RejectionReason["code"];
