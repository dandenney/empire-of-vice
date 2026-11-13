// Player knowledge: what the founder knows, when they learned it, and how.
// See docs/decisions/0021-knowledge-model.md (decisions 4–7 and 11).
//
// Knowledge is authoritative simulation state (`GameState.knowledge`): hashed,
// saved and replayed like the rest of state. The player snapshot builder is the
// only reader (ADR 0021 decision 1). Values are observed data only: they never
// carry an affordance the simulation computed for the UI (`blockedBy`,
// `maxStartableQuantity`, `maxAcceptableQuantity`, `inTransit`). Those are
// recomputed from known values when the player snapshot is built (decision 8).
//
// Like state, everything here is plain JSON-safe data with no optional fields.

import type { GameCommand, RejectionReason } from "./commands.ts";
import type { EventMeta, EventOfType, PlaceTaggedEventType } from "./events.ts";
import { compareIds } from "./ids.ts";
import type {
  BuyerId,
  CharacterId,
  ContractId,
  FacilityId,
  LocationId,
  RouteId,
  SupplierId,
  TierId,
  TransactionId,
  UnlockId,
  VehicleId,
} from "./ids.ts";
import type { Money } from "./money.ts";
import type {
  BuyerWant,
  ContractOfferSnapshot,
  ContractSnapshot,
  InstallmentSnapshot,
  InventoryPoolSnapshot,
  LocationOccupant,
  MaterialStockSnapshot,
  ProductionJobSnapshot,
  ProductPriceSnapshot,
  RouteSnapshot,
  SupplierSnapshot,
  VehicleTrip,
} from "./snapshot.ts";
import type { ArrangementPrivilege, CallAnswerer } from "./state.ts";
import type { Tick } from "./time.ts";

// ---------------------------------------------------------------------------
// Parties and subjects (decision 4)
// ---------------------------------------------------------------------------

/** What occupies a place (ADR 0007). The visibility table is keyed by it (decision 6). */
export type PartyKind = LocationOccupant["kind"];
export const PARTY_KINDS = ["FACILITY", "SUPPLIER", "BUYER"] as const satisfies readonly PartyKind[];

/**
 * Every subject kind, in the order records are sorted (decision 4: by subject
 * kind, then by key with `compareIds`). The order is part of the state hash.
 */
export const SUBJECT_KINDS = [
  "FACILITY_STOCK",
  "FACILITY_OPERATIONS",
  "SUPPLIER_OFFER",
  "BUYER_WANTS",
  "BUYER_BUDGET",
  "CONTRACT_OFFERS",
  "CONTRACT_PROGRESS",
  "MARKET_PRICES",
  "ROUTE_CONDITION",
  "VEHICLE_WHEREABOUTS",
  "STANDING",
] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

/**
 * A fact group the founder can know (decision 4). A visit refreshes a whole group
 * at once, so the values within one always agree with each other. The kind plus
 * its key field (if any) identifies one record.
 */
export type KnowledgeSubject =
  | { readonly kind: "FACILITY_STOCK"; readonly facilityId: FacilityId }
  | { readonly kind: "FACILITY_OPERATIONS"; readonly facilityId: FacilityId }
  | { readonly kind: "SUPPLIER_OFFER"; readonly supplierId: SupplierId }
  | { readonly kind: "BUYER_WANTS"; readonly buyerId: BuyerId }
  | { readonly kind: "BUYER_BUDGET"; readonly buyerId: BuyerId }
  | { readonly kind: "CONTRACT_OFFERS"; readonly buyerId: BuyerId }
  | { readonly kind: "CONTRACT_PROGRESS"; readonly contractId: ContractId }
  | { readonly kind: "MARKET_PRICES" }
  | { readonly kind: "ROUTE_CONDITION"; readonly routeId: RouteId }
  | { readonly kind: "VEHICLE_WHEREABOUTS"; readonly vehicleId: VehicleId }
  | { readonly kind: "STANDING" };

/**
 * The latest known value of a subject, discriminated by the same kind and
 * carrying the same key. Values reuse ADR 0007 snapshot types, with their
 * affordances omitted, so there are no parallel types.
 */
export type KnowledgeValue =
  | {
      readonly kind: "FACILITY_STOCK";
      readonly facilityId: FacilityId;
      /** Quantities, reservations and cost. */
      readonly products: readonly InventoryPoolSnapshot[];
      readonly materials: readonly MaterialStockSnapshot[];
      readonly storageUsed: number;
    }
  | {
      readonly kind: "FACILITY_OPERATIONS";
      readonly facilityId: FacilityId;
      readonly jobs: readonly ProductionJobSnapshot[];
      readonly workersPresent: number;
    }
  | {
      readonly kind: "SUPPLIER_OFFER";
      readonly supplierId: SupplierId;
      /** Price, available, shortage. */
      readonly materials: SupplierSnapshot["materials"];
    }
  | {
      readonly kind: "BUYER_WANTS";
      readonly buyerId: BuyerId;
      /** The buyer's minimum reputation against the world's (decision 4: revealed together with STANDING). */
      readonly willDeal: boolean;
      readonly wants: readonly Omit<BuyerWant, "maxAcceptableQuantity">[];
    }
  | { readonly kind: "BUYER_BUDGET"; readonly buyerId: BuyerId; readonly budgetRemaining: Money }
  | {
      readonly kind: "CONTRACT_OFFERS";
      readonly buyerId: BuyerId;
      readonly offers: readonly Omit<ContractOfferSnapshot, "blockedBy">[];
    }
  | {
      readonly kind: "CONTRACT_PROGRESS";
      readonly contractId: ContractId;
      readonly status: ContractSnapshot["status"];
      readonly installments: readonly Omit<InstallmentSnapshot, "inTransit">[];
    }
  | { readonly kind: "MARKET_PRICES"; readonly products: readonly ProductPriceSnapshot[] }
  | { readonly kind: "ROUTE_CONDITION"; readonly routeId: RouteId; readonly status: RouteSnapshot["status"] }
  | {
      readonly kind: "VEHICLE_WHEREABOUTS";
      readonly vehicleId: VehicleId;
      readonly parkedAt: LocationId | null;
      readonly trip: VehicleTrip | null;
    }
  | { readonly kind: "STANDING"; readonly reputation: number; readonly tierId: TierId; readonly unlocked: readonly UnlockId[] };

/** One subject kind's value: `KnowledgeValueOf<"BUYER_BUDGET">`. */
export type KnowledgeValueOf<K extends SubjectKind> = Extract<KnowledgeValue, { readonly kind: K }>;
/** One subject kind's subject: `KnowledgeSubjectOf<"BUYER_BUDGET">`. */
export type KnowledgeSubjectOf<K extends SubjectKind> = Extract<KnowledgeSubject, { readonly kind: K }>;

// ---------------------------------------------------------------------------
// Sources and records (decision 4)
// ---------------------------------------------------------------------------

/** How a record was learned. Trust attaches here later (unreliable reports). */
export type KnowledgeSource =
  | { readonly kind: "IN_PERSON"; readonly locationId: LocationId }
  /** A cash posting, which is a channel for its cause (decision 6). */
  | { readonly kind: "CASH_POSTING"; readonly transactionId: TransactionId }
  /** ADR 0024. */
  | { readonly kind: "PHONE"; readonly partyLocationId: LocationId }
  /** ADR 0024. */
  | { readonly kind: "MESSAGE"; readonly takenAtLocationId: LocationId; readonly takenBy: CharacterId | null }
  /** ADR 0025. */
  | { readonly kind: "REPORT"; readonly characterId: CharacterId };

export type SourceKind = KnowledgeSource["kind"];
export const SOURCE_KINDS = ["IN_PERSON", "CASH_POSTING", "PHONE", "MESSAGE", "REPORT"] as const satisfies readonly SourceKind[];

/**
 * One record per subject, holding the latest known value; the newest wins
 * (decision 4). `subject.kind === value.kind`, and the value carries the
 * subject's key. "Never known" is the absence of a record.
 */
export interface KnowledgeRecord {
  readonly subject: KnowledgeSubject;
  readonly value: KnowledgeValue;
  readonly learnedAt: Tick;
  readonly source: KnowledgeSource;
}

/** A known value as the player snapshot shows it, or null if never known (decision 8). */
export type Known<T> = { readonly value: T; readonly learnedAt: Tick; readonly source: KnowledgeSource } | null;

/** The key a subject sorts by after its kind: its ID field, or "" for the kinds with no key. */
export function knowledgeSubjectKey(subject: KnowledgeSubject): string {
  switch (subject.kind) {
    case "FACILITY_STOCK":
    case "FACILITY_OPERATIONS":
      return subject.facilityId;
    case "SUPPLIER_OFFER":
      return subject.supplierId;
    case "BUYER_WANTS":
    case "BUYER_BUDGET":
    case "CONTRACT_OFFERS":
      return subject.buyerId;
    case "CONTRACT_PROGRESS":
      return subject.contractId;
    case "ROUTE_CONDITION":
      return subject.routeId;
    case "VEHICLE_WHEREABOUTS":
      return subject.vehicleId;
    case "MARKET_PRICES":
    case "STANDING":
      return "";
  }
}

/** The record order (decision 4): subject kind in `SUBJECT_KINDS` order, then key with `compareIds`. */
export function compareKnowledgeSubjects(a: KnowledgeSubject, b: KnowledgeSubject): number {
  return SUBJECT_KINDS.indexOf(a.kind) - SUBJECT_KINDS.indexOf(b.kind) || compareIds(knowledgeSubjectKey(a), knowledgeSubjectKey(b));
}

// ---------------------------------------------------------------------------
// News, catch-up and activity (decisions 7 and 8)
// ---------------------------------------------------------------------------

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * A world event that happened at a place (or on a road, filed at the delivery's
 * origin facility) while the founder wasn't there. The event's payload, without
 * its event ID and cause: the tag in `EVENT_CONCERNS_PLACE` (events.ts) says
 * which event types become news.
 */
export interface NewsItem {
  readonly tick: Tick;
  readonly event: DistributiveOmit<EventOfType<PlaceTaggedEventType>, keyof EventMeta>;
}

/** News waiting at one place, at most PENDING_NEWS_LIMIT items (game-data); older ones are dropped and counted. */
export interface PendingNews {
  readonly locationId: LocationId;
  /** Oldest first. */
  readonly items: readonly NewsItem[];
  readonly dropped: number;
}

/** What an unknown book transaction concerns: a subject, or the news at a place (decision 7). */
export type BooksConcern = KnowledgeSubject | { readonly kind: "NEWS"; readonly locationId: LocationId };

/** A ledger transaction with entries that the founder doesn't know about yet (decision 6 rule 3). */
export interface PendingBook {
  readonly transactionId: TransactionId;
  readonly concerns: BooksConcern;
}

/**
 * One structured catch-up line (decision 7): a subject in the live view whose
 * value differs from what was known. `before` is the stored value, or null if
 * the subject was never known. Lines are data; the words are UI copy.
 * `subject.kind === before.kind === after.kind`.
 */
export interface CatchUpLine {
  readonly subject: KnowledgeSubject;
  readonly before: KnowledgeValue | null;
  readonly after: KnowledgeValue;
}

/** What the founder learned arriving at a place (decision 7). Also the KNOWLEDGE_CAUGHT_UP payload. */
export interface CatchUp {
  readonly locationId: LocationId;
  /** The arrival tick. */
  readonly tick: Tick;
  /** The oldest `learnedAt` among the place's known subjects before arrival, or null if none was known. */
  readonly sinceTick: Tick | null;
  readonly lines: readonly CatchUpLine[];
  /** The place's pending news, delivered on arrival, oldest first. */
  readonly news: readonly NewsItem[];
  /** News items that were dropped from the place's pending news before arrival. */
  readonly droppedNews: number;
}

// ---------------------------------------------------------------------------
// Calls in and held messages (ADR 0024 decisions 5 and 6)
// ---------------------------------------------------------------------------

/**
 * Why a party calls the family (ADR 0024 decision 5). A domain type, because held
 * messages carry it; game-data's `CallInRule` imports it (ADR 0012). ADR 0025
 * adds `"EMPLOYEE_REPORT"`.
 */
export type CallInReason = "NEW_CONTRACT_OFFER" | "INSTALLMENT_DUE";

/** A message taken for the family and held where it was taken, until delivered (ADR 0024 decision 6). */
export interface HeldMessage {
  readonly takenAt: Tick;
  readonly callerLocationId: LocationId;
  /** null: the keeper of the place that took it (not a character). */
  readonly takenBy: CharacterId | null;
  readonly reason: CallInReason;
  /**
   * Copies, at `takenAt`, of the caller's subjects that
   * KNOWLEDGE_VISIBILITY.MESSAGE[partyKind] grants, sorted like knowledge records.
   */
  readonly values: readonly { readonly subject: KnowledgeSubject; readonly value: KnowledgeValue }[];
}

/** Messages waiting at one place, oldest first, at most MESSAGE_LIMIT (game-data). Like PendingNews. */
export interface PendingMessages {
  readonly locationId: LocationId;
  readonly items: readonly HeldMessage[];
  readonly dropped: number;
}

/** A delivered message as the player sees it: what it said, not the values (those go into records). */
export interface DeliveredMessage {
  readonly takenAt: Tick;
  readonly heldAtLocationId: LocationId;
  readonly callerLocationId: LocationId;
  readonly takenBy: CharacterId | null;
  readonly reason: CallInReason;
  readonly subjects: readonly KnowledgeSubject[];
}

/**
 * What the founder saw or was told (decision 8). Written only by the founder's
 * own commands and by channels, never filtered from the world event journal.
 * ADR 0024 and ADR 0027 add the phone and message items; ADR 0025 adds reports.
 */
export type ActivityItem =
  | {
      readonly kind: "COMMAND";
      readonly tick: Tick;
      /** The command's inputs only (ADR 0022 decision 1). */
      readonly command: GameCommand;
      readonly status: "APPLIED" | "QUEUED" | "REJECTED";
      /** Set when rejected. */
      readonly reason: RejectionReason | null;
    }
  | {
      /** An arrival summary; its content is `knowledge.lastCatchUp` (or the KNOWLEDGE_CAUGHT_UP event). */
      readonly kind: "CATCH_UP";
      readonly tick: Tick;
      readonly locationId: LocationId;
      readonly sinceTick: Tick | null;
    }
  | {
      /** A cash posting made while the founder was elsewhere, and what it revealed (decision 6). */
      readonly kind: "CASH_POSTING";
      readonly tick: Tick;
      readonly producer: TransactionProducer;
      /** Net change to cash: positive in, negative out. */
      readonly cashChange: Money;
      readonly revealed: readonly KnowledgeSubject[];
      readonly news: readonly NewsItem[];
    }
  | {
      /** The founder placed a call (ADR 0024 decision 3); `answeredBy` is null when nobody answered. */
      readonly kind: "CALL_PLACED";
      readonly tick: Tick;
      readonly locationId: LocationId;
      readonly answered: boolean;
      readonly answeredBy: CallAnswerer["kind"] | null;
    }
  | {
      /** The founder answered a call in (ADR 0024 decision 5). */
      readonly kind: "CALL_RECEIVED";
      readonly tick: Tick;
      readonly callerLocationId: LocationId;
      readonly phoneLocationId: LocationId;
      readonly reason: CallInReason;
    }
  | {
      /** One held message reached the founder (ADR 0024 decision 6). `tick` is when they learned it. */
      readonly kind: "MESSAGE_DELIVERED";
      readonly tick: Tick;
      readonly message: DeliveredMessage;
    }
  | {
      /** Messages dropped at a place past MESSAGE_LIMIT, reported with a delivery there. */
      readonly kind: "MESSAGES_DROPPED";
      readonly tick: Tick;
      readonly locationId: LocationId;
      readonly count: number;
    }
  | {
      /** A line was installed at one of the family's facilities (ADR 0024 decision 2). */
      readonly kind: "PHONE_INSTALLED";
      readonly tick: Tick;
      readonly facilityId: FacilityId;
    }
  | {
      /** A dealing newly met one of a contact's milestones (ADR 0027 decision 3). */
      readonly kind: "ARRANGEMENT_GRANTED";
      readonly tick: Tick;
      readonly locationId: LocationId;
      readonly privilege: ArrangementPrivilege;
    };

/**
 * How much each kind of activity item matters (ADR 0023 decision 9): while the
 * founder rests, the worker's scheduler fast-forwards, and drops back to the
 * player's speed as soon as a `notify` item lands in `knowledge.activity`.
 * Keyed by activity item kind, never by world event (ADR 0021 decision 2), so
 * the speed change leaks nothing. A `Record`, so a new kind won't compile
 * without a row. PLACEHOLDER rows for PT1 (#175):
 * - COMMAND: one of the founder's own orders applied or failed (a queued one
 *   resolving overnight): their decision's fate is worth waking the screen for;
 * - CATCH_UP: an arrival summary, which only comes from arriving or waking, and
 *   waking already ends the fast-forward;
 * - CASH_POSTING: money moved while the founder was elsewhere;
 * - CALL_RECEIVED, MESSAGE_DELIVERED: someone reached the family by phone
 *   (ADR 0024 decision 15); the other phone and arrangement items are `log`
 *   (ADR 0024's "info", ADR 0027 decision 17).
 */
export const ACTIVITY_IMPORTANCE: Readonly<Record<ActivityItem["kind"], "notify" | "log">> = {
  COMMAND: "notify",
  CATCH_UP: "log",
  CASH_POSTING: "notify",
  CALL_PLACED: "log",
  CALL_RECEIVED: "notify",
  MESSAGE_DELIVERED: "notify",
  MESSAGES_DROPPED: "log",
  PHONE_INSTALLED: "log",
  ARRANGEMENT_GRANTED: "log",
};

// ---------------------------------------------------------------------------
// Knowledge state (decision 7)
// ---------------------------------------------------------------------------

/** `GameState.knowledge`. Empty in a new game and in a migrated M001 save (decision 10). */
export interface KnowledgeState {
  /** Sorted with `compareKnowledgeSubjects`. */
  readonly records: readonly KnowledgeRecord[];
  /** One entry per place with news waiting, sorted by `locationId` with `compareIds`. */
  readonly pendingNews: readonly PendingNews[];
  /** Sorted by `transactionId` with `compareIds`. */
  readonly pendingBooks: readonly PendingBook[];
  /** What the founder saw or was told, newest last, capped at ACTIVITY_LIMIT (game-data). */
  readonly activity: readonly ActivityItem[];
  /** The latest arrival summary; cleared when the founder departs. */
  readonly lastCatchUp: CatchUp | null;
  /**
   * Messages held for the family (ADR 0024 decision 6): one entry per place with
   * messages waiting, sorted by `locationId` with `compareIds`. Hidden until
   * delivered; the player snapshot never shows whether any are waiting.
   */
  readonly pendingMessages: readonly PendingMessages[];
}

export const EMPTY_KNOWLEDGE: KnowledgeState = {
  records: [],
  pendingNews: [],
  pendingBooks: [],
  activity: [],
  lastCatchUp: null,
  pendingMessages: [],
};

// ---------------------------------------------------------------------------
// Transaction producers and how each becomes known (decisions 6 and 7)
// ---------------------------------------------------------------------------

/**
 * What can cause a producer's transactions, for decision 6 rule 1:
 * - `GAME_CREATION`, `FOUNDER_COMMAND`: known at once;
 * - `AGREED_CHARGE`: a charge whose amount depends only on agreements the founder
 *   made (midnight wages and overhead), known at once with or without a cash leg.
 *   Also an agreement's own change by time alone (a held deal expiring, ADR 0022
 *   decision 9);
 * - `WORLD`: can post without a founder command, so rules 2 and 3 apply.
 *
 * "Posted at the founder's place while they're present" is decided per
 * transaction at run time, so it isn't a static trigger.
 */
export type ProducerTrigger = "GAME_CREATION" | "FOUNDER_COMMAND" | "AGREED_CHARGE" | "WORLD";

/**
 * The kinds of transaction a producer can post: with a CASH entry (rule 2), with
 * entries but no CASH entry (rule 3), or with no entries at all (rule 4).
 */
export type BookLeg = "CASH" | "NON_CASH" | "NO_ENTRIES";

export interface TransactionProducerDefinition {
  readonly trigger: ProducerTrigger;
  readonly legs: readonly BookLeg[];
}

/**
 * Every transaction producer, identified by its idempotency-key family: the
 * transaction kind plus the constant tags of its key, without IDs and numbers
 * (`"DISPATCH:delivery-3:CLEAR"` is `DISPATCH:CLEAR`). A new producer must be
 * added here, and, if it can post without a founder command, to the tables
 * below. The producer coverage test (packages/contracts/test) enforces both,
 * against the simulation's own `idempotencyKey(...)` call sites.
 *
 * M001 producers plus ADR 0022's deals (O1a). Later tasks add theirs (ADR 0022's
 * other outcomes, ADR 0025's employees). ADR 0024's three TELEPHONE families and
 * ADR 0027's `LODGING:ROOM` land with their call sites in C1 (#179): the
 * transaction kinds exist from PH1, but nothing posts them yet.
 */
export const TRANSACTION_PRODUCERS = {
  // Game creation and founder commands (rule 1).
  OPENING_BALANCE: { trigger: "GAME_CREATION", legs: ["CASH", "NON_CASH", "NO_ENTRIES"] },
  MATERIAL_PURCHASE: { trigger: "FOUNDER_COMMAND", legs: ["CASH"] },
  EQUIPMENT_PURCHASE: { trigger: "FOUNDER_COMMAND", legs: ["CASH"] },
  ASSET_SALE: { trigger: "FOUNDER_COMMAND", legs: ["CASH", "NON_CASH"] },
  DISPATCH: { trigger: "FOUNDER_COMMAND", legs: ["NON_CASH", "NO_ENTRIES"] },
  /**
   * START_PRODUCTION (ADR 0022 decision 7): reserves the inputs and prepays the
   * conversion cost (no entries when that cost is 0). Replaces M001's entry-less
   * `RESERVATION:<jobId>`, which old ledgers still hold but nothing posts any more.
   */
  PRODUCTION_START: { trigger: "FOUNDER_COMMAND", legs: ["CASH", "NO_ENTRIES"] },
  "RESERVATION:ACCEPT": { trigger: "FOUNDER_COMMAND", legs: ["NO_ENTRIES"] },
  "RESERVATION:RELEASE": { trigger: "FOUNDER_COMMAND", legs: ["NO_ENTRIES"] },
  "DAILY_SETTLEMENT:WORKFORCE": { trigger: "FOUNDER_COMMAND", legs: ["NO_ENTRIES"] },
  /** AGREE_DEAL (ADR 0022 decision 9: rule 1, the founder's own command). */
  "DAILY_SETTLEMENT:DEAL_AGREED": { trigger: "FOUNDER_COMMAND", legs: ["NO_ENTRIES"] },
  // Charges fixed by agreements (rule 1).
  "DAILY_SETTLEMENT:WAGES": { trigger: "AGREED_CHARGE", legs: ["CASH", "NON_CASH"] },
  "DAILY_SETTLEMENT:OVERHEAD": { trigger: "AGREED_CHARGE", legs: ["CASH", "NON_CASH"] },
  /** A HELD deal expiring: an agreement's state, always known (ADR 0022 decision 9). */
  "DAILY_SETTLEMENT:DEAL_EXPIRED": { trigger: "AGREED_CHARGE", legs: ["NO_ENTRIES"] },
  // The world, with money lines.
  "DAILY_SETTLEMENT:PAYROLL": { trigger: "WORLD", legs: ["CASH", "NO_ENTRIES"] },
  "DAILY_SETTLEMENT:PENALTIES": { trigger: "WORLD", legs: ["CASH"] },
  INSTALLMENT_SETTLEMENT: { trigger: "WORLD", legs: ["CASH", "NON_CASH", "NO_ENTRIES"] },
  PRODUCTION: { trigger: "WORLD", legs: ["CASH", "NON_CASH", "NO_ENTRIES"] },
  PRODUCTION_WRITE_OFF: { trigger: "WORLD", legs: ["CASH", "NON_CASH", "NO_ENTRIES"] },
  SALE: { trigger: "WORLD", legs: ["CASH"] },
  TRANSFER: { trigger: "WORLD", legs: ["NON_CASH", "NO_ENTRIES"] },
  VEHICLE_RETURN: { trigger: "WORLD", legs: ["CASH", "NON_CASH", "NO_ENTRIES"] },
  CARGO_LOSS: { trigger: "WORLD", legs: ["NON_CASH", "NO_ENTRIES"] },
  "LOSS:SHAKEDOWN": { trigger: "WORLD", legs: ["CASH", "NO_ENTRIES"] },
  // The world, with no entries (rule 4: never in the player's books).
  "DAILY_SETTLEMENT:MARKET": { trigger: "WORLD", legs: ["NO_ENTRIES"] },
  "DAILY_SETTLEMENT:SHORTAGE_START": { trigger: "WORLD", legs: ["NO_ENTRIES"] },
  "DAILY_SETTLEMENT:SHORTAGE_END": { trigger: "WORLD", legs: ["NO_ENTRIES"] },
  "DAILY_SETTLEMENT:CONTRACT_OFFER": { trigger: "WORLD", legs: ["NO_ENTRIES"] },
  "DAILY_SETTLEMENT:CONTRACT_OFFER_EXPIRED": { trigger: "WORLD", legs: ["NO_ENTRIES"] },
  "DAILY_SETTLEMENT:ROUTE_CLOSURE": { trigger: "WORLD", legs: ["NO_ENTRIES"] },
  "DAILY_SETTLEMENT:ROUTE_REOPENING": { trigger: "WORLD", legs: ["NO_ENTRIES"] },
  "DISPATCH:CLEAR": { trigger: "WORLD", legs: ["NO_ENTRIES"] },
  "DISPATCH:DELAY": { trigger: "WORLD", legs: ["NO_ENTRIES"] },
  "DISPATCH:FELL_THROUGH": { trigger: "WORLD", legs: ["NO_ENTRIES"] },
  /** A sale on spec the buyer took nothing of (ADR 0022 decision 6): no entries, so never in the books. */
  "DISPATCH:SPEC_SETTLED": { trigger: "WORLD", legs: ["NO_ENTRIES"] },
  "PROGRESSION:TIER": { trigger: "WORLD", legs: ["NO_ENTRIES"] },
  "PROGRESSION:VICTORY": { trigger: "WORLD", legs: ["NO_ENTRIES"] },
  "PROGRESSION:FIRST_DELIVERY": { trigger: "WORLD", legs: ["NO_ENTRIES"] },
  "PROGRESSION:INSTALLMENT": { trigger: "WORLD", legs: ["NO_ENTRIES"] },
  "PROGRESSION:LOST": { trigger: "WORLD", legs: ["NO_ENTRIES"] },
} as const satisfies Readonly<Record<string, TransactionProducerDefinition>>;

export type TransactionProducer = keyof typeof TRANSACTION_PRODUCERS;

/**
 * What a cash posting made while the founder is elsewhere reveals about its
 * cause (decision 6, the table of cash postings).
 * - `subjects`: copied from the world when it posts, for the entities the posting
 *   concerns. A subject that applies only sometimes (CONTRACT_PROGRESS for a sale
 *   that served an installment) is revealed when it applies.
 * - `news`: `NONE`; `PENDING_AT_PLACE`, the pending news at the place the posting
 *   concerns (a failed deal at the truck's origin, decision 7); or `THE_POSTING`,
 *   the posting itself is reported as news (a shakedown).
 */
export interface CashPostingReveal {
  readonly subjects: readonly SubjectKind[];
  readonly news: "NONE" | "PENDING_AT_PLACE" | "THE_POSTING";
}

/** Decision 6's table, one row per producer that can post a CASH leg without a founder command. */
export const CASH_POSTING_REVEALS = {
  /** Installment penalty paid at the deadline (ADR 0018 decision 7). */
  INSTALLMENT_SETTLEMENT: { subjects: ["CONTRACT_PROGRESS"], news: "NONE" },
  /** Penalty paydown: the accrued penalty is already known from the installment's settlement. */
  "DAILY_SETTLEMENT:PENALTIES": { subjects: [], news: "NONE" },
  /** Payroll paydown: pays down agreed wages already known. */
  "DAILY_SETTLEMENT:PAYROLL": { subjects: [], news: "NONE" },
  /** Transport cost, and any cargo booked back into stock; not the rest of the home facility's stock. */
  VEHICLE_RETURN: { subjects: ["VEHICLE_WHEREABOUTS"], news: "PENDING_AT_PLACE" },
  /** Sale proceeds on arrival; the sale itself is an activity item. */
  SALE: { subjects: ["CONTRACT_PROGRESS", "VEHICLE_WHEREABOUTS"], news: "NONE" },
  /** A shakedown (T07f). */
  "LOSS:SHAKEDOWN": { subjects: [], news: "THE_POSTING" },
  /**
   * A job completing, conversion cost paid from cash at settlement (ADR 0017). Since
   * ADR 0022 decision 7 only a migrated job (`conversionPrepaid: null`) posts cash
   * here; a prepaid job's completion is non-cash and takes the books row instead.
   */
  PRODUCTION: { subjects: ["FACILITY_OPERATIONS", "FACILITY_STOCK"], news: "NONE" },
  /** A migrated job failing, conversion cost paid from cash (a prepaid failure takes the books row). */
  PRODUCTION_WRITE_OFF: { subjects: ["FACILITY_OPERATIONS", "FACILITY_STOCK"], news: "NONE" },
} as const satisfies Readonly<Partial<Record<TransactionProducer, CashPostingReveal>>>;

/**
 * Decision 7's table: what an unknown transaction with entries but no CASH entry
 * concerns, by producer. It leaves `pendingBooks` when that subject is next
 * learned, or that news is delivered.
 * - PRODUCTION, PRODUCTION_WRITE_OFF: FACILITY_STOCK of the job's facility (every
 *   prepaid job's settlement, ADR 0022 decision 7);
 * - INSTALLMENT_SETTLEMENT: CONTRACT_PROGRESS of that contract;
 * - VEHICLE_RETURN: VEHICLE_WHEREABOUTS of that truck;
 * - CARGO_LOSS: news at the delivery's origin facility;
 * - TRANSFER: FACILITY_STOCK of the destination facility, where the cases land.
 */
export const PENDING_BOOKS_CONCERNS = {
  PRODUCTION: "FACILITY_STOCK",
  PRODUCTION_WRITE_OFF: "FACILITY_STOCK",
  INSTALLMENT_SETTLEMENT: "CONTRACT_PROGRESS",
  VEHICLE_RETURN: "VEHICLE_WHEREABOUTS",
  CARGO_LOSS: "NEWS",
  TRANSFER: "FACILITY_STOCK",
} as const satisfies Readonly<Partial<Record<TransactionProducer, BooksConcern["kind"]>>>;

const KEY_TAG = /^[A-Z][A-Z0-9_]*$/;

/**
 * The producer of a transaction, from its idempotency key: the longest
 * registered family made of the key's leading constant tags. IDs are lowercase
 * and numbers are digits, so they're never tags. Null for an unknown family.
 */
export function transactionProducerOf(idempotencyKey: string): TransactionProducer | null {
  const tags = idempotencyKey.split(":").filter((part) => KEY_TAG.test(part));
  for (let n = tags.length; n > 0; n--) {
    const family = tags.slice(0, n).join(":");
    if (Object.hasOwn(TRANSACTION_PRODUCERS, family)) return family as TransactionProducer;
  }
  return null;
}
