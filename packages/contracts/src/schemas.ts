// Zod schemas for everything that crosses a trust boundary: commands from the UI
// (architecture §4: "commands are validated at the gateway") and saves loaded from
// storage (ADR 0009). See docs/decisions/0011-validation-schemas.md.
//
// The TypeScript types in the other files are the contract. These schemas mirror
// them, and test/schemas.test.ts proves at compile time that each schema's inferred
// type equals its contract type, so the two can't drift apart.
//
// Schemas check shape and simple ranges (integers, non-negative quantities, ID
// format, balanced ledger transactions). Cross-entity invariants are the
// coordinator's job (ADR 0010).

import { z } from "zod";
import type { CommandIssuer, DeliveryPurpose, GameCommand } from "./commands.ts";
import { GAME_COMMAND_TYPES } from "./commands.ts";
import type { EventMeta } from "./events.ts";
import { QUALITY_TIERS } from "./goods.ts";
import { DYNAMIC_ID_KINDS, isValidId, type Id, type IdKind } from "./ids.ts";
import {
  knowledgeSubjectKey,
  SUBJECT_KINDS,
  TRANSACTION_PRODUCERS,
  type KnowledgeSubject,
  type KnowledgeValue,
  type TransactionProducer,
} from "./knowledge.ts";
import { LEDGER_ACCOUNTS, type LedgerAccount, type TransactionKind } from "./ledger.ts";
import { isMoney, type Money, type Ratio } from "./money.ts";
import { ACTIVITY_KINDS, RNG_STREAMS, type DriverRef, type FounderState, type RouteLeg, type Transport } from "./state.ts";
import { SAVE_FORMAT, SAVE_SCHEMA_VERSION } from "./save.ts";
import type { CashFlowCategory } from "./snapshot.ts";
import type { Tick } from "./time.ts";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const moneySchema = z.custom<Money>(isMoney, { message: "Expected a safe integer number of cents" });
export const ratioSchema = z.custom<Ratio>((v) => typeof v === "number" && Number.isSafeInteger(v), {
  message: "Expected an integer ratio in parts per million",
});
export const tickSchema = z.custom<Tick>((v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0, {
  message: "Expected a non-negative integer tick",
});

export function idSchema<K extends IdKind>(kind: K) {
  return z.custom<Id<K>>(isValidId, { message: `Expected a ${kind} ID` });
}

/** A count of something that exists: 0 or more. */
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** A quantity in a command: at least 1. */
const positiveQuantity = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const nonNegativeInt = count;
const qualitySchema = z.enum(QUALITY_TIERS);

const cargoLineSchema = z.strictObject({
  productId: idSchema("Product"),
  quality: qualitySchema,
  quantity: positiveQuantity,
});

const contractTermsShape = {
  buyerId: idSchema("Buyer"),
  productId: idSchema("Product"),
  minimumQuality: qualitySchema,
  quantityPerInstallment: positiveQuantity,
  unitPrice: moneySchema,
  installmentCount: positiveQuantity,
  intervalTicks: positiveQuantity,
  penaltyRatePpm: nonNegativeInt,
};

const reputationSchema = z.number().int().min(0).max(100);

// ---------------------------------------------------------------------------
// The founder (ADR 0023 decision 1)
// ---------------------------------------------------------------------------

export const transportSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("FOOT") }),
  z.strictObject({ kind: z.literal("VEHICLE"), vehicleId: idSchema("Vehicle") }),
]) satisfies z.ZodType<Transport>;

export const routeLegSchema = z.strictObject({ routeId: idSchema("Route"), reversed: z.boolean() }) satisfies z.ZodType<RouteLeg>;

export const activityKindSchema = z.enum(ACTIVITY_KINDS);

export const founderStateSchema = z.strictObject({
  whereabouts: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("PRESENT"),
      locationId: idSchema("Location"),
      busy: z.strictObject({ activity: activityKindSchema, until: tickSchema }).nullable(),
    }),
    z.strictObject({
      kind: z.literal("TRAVELLING"),
      transport: transportSchema,
      path: z.array(routeLegSchema).min(1),
      legIndex: nonNegativeInt,
      legDepartedAt: tickSchema,
      legArrivesAt: tickSchema,
      destinationLocationId: idSchema("Location"),
    }),
    z.strictObject({
      kind: z.literal("ON_DELIVERY"),
      deliveryId: idSchema("Delivery"),
      vehicleId: idSchema("Vehicle"),
      atStop: z.strictObject({ locationId: idSchema("Location"), tick: tickSchema }).nullable(),
    }),
    z.strictObject({
      kind: z.literal("RESTING"),
      locationId: idSchema("Location"),
      startedAt: tickSchema,
      until: tickSchema,
    }),
  ]),
  awakeSince: tickSchema,
}) satisfies z.ZodType<FounderState>;

/** `DriverRef` (ADR 0023 decision 5). `DISPATCH_DELIVERY.driver` and `DeliveryState.driver` use it from O1a. */
export const driverRefSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("FOUNDER") }),
  z.strictObject({ kind: z.literal("EMPLOYEE"), characterId: idSchema("Character") }),
]) satisfies z.ZodType<DriverRef>;

// ---------------------------------------------------------------------------
// Commands (ADR 0004)
// ---------------------------------------------------------------------------

export const deliveryPurposeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("SALE"), buyerId: idSchema("Buyer"), dealId: idSchema("Deal").nullable() }),
  z.strictObject({ kind: z.literal("CONTRACT_INSTALLMENT"), contractId: idSchema("Contract") }),
  z.strictObject({ kind: z.literal("TRANSFER"), destinationFacilityId: idSchema("Facility") }),
]) satisfies z.ZodType<DeliveryPurpose>;

export const gameCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("PURCHASE_MATERIALS"),
    supplierId: idSchema("Supplier"),
    materialId: idSchema("Material"),
    quantity: positiveQuantity,
    facilityId: idSchema("Facility"),
  }),
  z.strictObject({
    type: z.literal("START_PRODUCTION"),
    facilityId: idSchema("Facility"),
    recipeId: idSchema("Recipe"),
    quantity: positiveQuantity,
  }),
  z.strictObject({
    type: z.literal("DISPATCH_DELIVERY"),
    vehicleId: idSchema("Vehicle"),
    cargo: z.array(cargoLineSchema).min(1),
    purpose: deliveryPurposeSchema,
    routeId: idSchema("Route").nullable(),
    driver: driverRefSchema.nullable(),
  }),
  z.strictObject({ type: z.literal("ACCEPT_CONTRACT"), contractOfferId: idSchema("ContractOffer") }),
  z.strictObject({
    type: z.literal("PURCHASE_EQUIPMENT"),
    facilityId: idSchema("Facility"),
    equipmentId: idSchema("Equipment"),
  }),
  z.strictObject({ type: z.literal("SET_WORKFORCE"), facilityId: idSchema("Facility"), workerCount: count }),
  z.strictObject({ type: z.literal("RELEASE_RESERVATION"), facilityId: idSchema("Facility"), reservationId: idSchema("Reservation") }),
  z.strictObject({ type: z.literal("REPEAT_OPERATION"), sourceCommandId: idSchema("Command") }),
  z.strictObject({
    type: z.literal("SELL_EQUIPMENT"),
    facilityId: idSchema("Facility"),
    equipmentId: idSchema("Equipment"),
  }),
  z.strictObject({
    type: z.literal("TRAVEL"),
    destinationLocationId: idSchema("Location"),
    transport: transportSchema,
    via: z.array(routeLegSchema).min(1).nullable(),
  }),
  z.strictObject({ type: z.literal("REST"), untilTick: tickSchema }),
  z.strictObject({ type: z.literal("WAKE") }),
  z.strictObject({
    type: z.literal("AGREE_DEAL"),
    buyerId: idSchema("Buyer"),
    productId: idSchema("Product"),
    quality: qualitySchema,
    quantity: positiveQuantity,
    agreedUnitPrice: moneySchema,
  }),
]) satisfies z.ZodType<GameCommand>;

/** What the worker gateway validates before calling `Simulation.dispatch`. */
export const commandRequestSchema = z.strictObject({
  command: gameCommandSchema,
  scheduledTick: tickSchema.optional(),
});

/** `CommandIssuer` (ADR 0022 decision 5): FOUNDER only until ADR 0025's task. */
export const commandIssuerSchema = z.strictObject({ kind: z.literal("FOUNDER") }) satisfies z.ZodType<CommandIssuer>;

export const commandEnvelopeSchema = z.strictObject({
  id: idSchema("Command"),
  scheduledTick: tickSchema,
  sequence: nonNegativeInt,
  issuer: commandIssuerSchema,
  command: gameCommandSchema,
});

// Every command type has a schema branch (checked at compile time in the tests too).
void (GAME_COMMAND_TYPES satisfies readonly z.infer<typeof gameCommandSchema>["type"][]);

// ---------------------------------------------------------------------------
// Rejection reasons
// ---------------------------------------------------------------------------

const idKindSchema = z.enum([
  "Location", "Facility", "Supplier", "Buyer", "Vehicle", "Route", "Material", "Product", "Recipe",
  "Equipment", "Character", "Family", "Unlock", "Tier", "Scenario", "Command", "Event", "Transaction",
  "ProductionJob", "Delivery", "ContractOffer", "Contract", "Reservation", "Deal",
] as const satisfies readonly IdKind[]);

export const rejectionReasonSchema = z.discriminatedUnion("code", [
  z.strictObject({ code: z.literal("INVALID_QUANTITY"), field: z.string(), value: z.number() }),
  z.strictObject({ code: z.literal("SCHEDULED_IN_PAST"), scheduledTick: tickSchema, currentTick: tickSchema }),
  z.strictObject({ code: z.literal("UNKNOWN_ENTITY"), kind: idKindSchema, id: z.custom<Id<IdKind>>(isValidId, { message: "Expected an ID" }) }),
  z.strictObject({ code: z.literal("LOCKED"), unlockId: idSchema("Unlock") }),
  z.strictObject({ code: z.literal("REPUTATION_TOO_LOW"), required: z.number(), current: z.number() }),
  z.strictObject({ code: z.literal("INSUFFICIENT_FUNDS"), required: moneySchema, available: moneySchema }),
  z.strictObject({ code: z.literal("SUPPLIER_STOCK_LOW"), materialId: idSchema("Material"), requested: count, available: count }),
  z.strictObject({ code: z.literal("MATERIAL_NOT_SOLD"), supplierId: idSchema("Supplier"), materialId: idSchema("Material") }),
  z.strictObject({ code: z.literal("INSUFFICIENT_MATERIALS"), materialId: idSchema("Material"), required: count, available: count }),
  z.strictObject({ code: z.literal("RECIPE_NOT_SUPPORTED"), facilityId: idSchema("Facility"), recipeId: idSchema("Recipe") }),
  z.strictObject({ code: z.literal("PRODUCTION_CAPACITY_EXCEEDED"), facilityId: idSchema("Facility"), requested: count, available: count }),
  z.strictObject({ code: z.literal("STORAGE_CAPACITY_EXCEEDED"), facilityId: idSchema("Facility"), requested: count, available: count }),
  z.strictObject({ code: z.literal("WORKFORCE_LIMIT_EXCEEDED"), facilityId: idSchema("Facility"), requested: count, maximum: count }),
  z.strictObject({ code: z.literal("NO_EQUIPMENT_SLOT"), facilityId: idSchema("Facility"), equipmentId: idSchema("Equipment") }),
  z.strictObject({ code: z.literal("EQUIPMENT_ALREADY_OWNED"), facilityId: idSchema("Facility"), equipmentId: idSchema("Equipment") }),
  z.strictObject({ code: z.literal("EQUIPMENT_NOT_OWNED"), facilityId: idSchema("Facility"), equipmentId: idSchema("Equipment") }),
  z.strictObject({
    code: z.literal("INSUFFICIENT_STOCK"),
    productId: idSchema("Product"),
    quality: qualitySchema,
    requested: count,
    available: count,
  }),
  z.strictObject({ code: z.literal("RESERVATION_NOT_ACTIVE"), reservationId: idSchema("Reservation") }),
  z.strictObject({ code: z.literal("VEHICLE_UNAVAILABLE"), vehicleId: idSchema("Vehicle") }),
  z.strictObject({ code: z.literal("VEHICLE_CAPACITY_EXCEEDED"), vehicleId: idSchema("Vehicle"), requested: count, capacity: count }),
  z.strictObject({ code: z.literal("NO_ROUTE"), vehicleId: idSchema("Vehicle") }),
  z.strictObject({ code: z.literal("ROUTE_CLOSED"), routeId: idSchema("Route"), reopensAt: tickSchema.nullable() }),
  z.strictObject({ code: z.literal("QUOTE_CHANGED"), buyerId: idSchema("Buyer"), agreed: moneySchema, current: moneySchema }),
  z.strictObject({ code: z.literal("BUYER_WILL_TAKE_LESS"), buyerId: idSchema("Buyer"), requested: count, acceptable: count }),
  z.strictObject({
    code: z.literal("PRODUCT_NOT_WANTED"),
    buyerId: idSchema("Buyer"),
    productId: idSchema("Product"),
    quality: qualitySchema,
  }),
  z.strictObject({ code: z.literal("OFFER_UNAVAILABLE"), contractOfferId: idSchema("ContractOffer") }),
  z.strictObject({ code: z.literal("CONTRACT_NOT_ACTIVE"), contractId: idSchema("Contract") }),
  z.strictObject({ code: z.literal("CARGO_DOES_NOT_MATCH_CONTRACT"), contractId: idSchema("Contract") }),
  z.strictObject({ code: z.literal("DEAL_UNAVAILABLE"), dealId: idSchema("Deal") }),
  z.strictObject({ code: z.literal("CARGO_DOES_NOT_MATCH_DEAL"), dealId: idSchema("Deal") }),
  z.strictObject({ code: z.literal("NOT_REPEATABLE"), sourceCommandId: idSchema("Command") }),
  z.strictObject({
    code: z.literal("NOT_PRESENT"),
    requiredLocationId: idSchema("Location"),
    issuerLocationId: idSchema("Location").nullable(),
  }),
  z.strictObject({ code: z.literal("FOUNDER_BUSY"), until: tickSchema }),
  z.strictObject({ code: z.literal("PLACE_CLOSED"), locationId: idSchema("Location"), opensAt: tickSchema }),
  z.strictObject({ code: z.literal("VEHICLE_NOT_AT"), vehicleId: idSchema("Vehicle"), locationId: idSchema("Location") }),
  z.strictObject({ code: z.literal("NO_DRIVER"), vehicleId: idSchema("Vehicle") }),
  z.strictObject({ code: z.literal("NO_WAY_TO_REACH"), characterId: idSchema("Character") }),
  z.strictObject({ code: z.literal("FOUNDER_AWAY"), whereabouts: z.enum(["TRAVELLING", "ON_DELIVERY", "RESTING"]) }),
  z.strictObject({ code: z.literal("ALREADY_THERE") }),
  z.strictObject({ code: z.literal("INVALID_PATH") }),
  z.strictObject({ code: z.literal("NO_PATH"), destinationLocationId: idSchema("Location") }),
  z.strictObject({ code: z.literal("INVALID_REST_LENGTH"), min: tickSchema, max: tickSchema }),
  z.strictObject({ code: z.literal("NOT_RESTING") }),
]);

// ---------------------------------------------------------------------------
// Events (ADR 0006)
// ---------------------------------------------------------------------------

const eventMeta = {
  id: idSchema("Event"),
  tick: tickSchema,
  causedBy: idSchema("Command").nullable(),
} satisfies Record<keyof EventMeta, z.ZodType>;

const ev = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.strictObject({ ...eventMeta, type: z.literal(type), ...shape });

const cargo = z.array(cargoLineSchema);
const outcomeSchema = z.enum(["FULFILLED", "PARTIAL", "MISSED"]);
const closureReason = z.enum(["RIVAL", "POLICE"]);

// The payloads of the event types that become news (EVENT_CONCERNS_PLACE), shared
// by the event schema and the news schema.
const productionFailedShape = {
  jobId: idSchema("ProductionJob"),
  facilityId: idSchema("Facility"),
  reason: z.literal("DISRUPTION"),
  writtenOff: moneySchema,
  transactionId: idSchema("Transaction"),
};
const deliveryDelayedShape = {
  deliveryId: idSchema("Delivery"),
  routeId: idSchema("Route"),
  previousArrivesAt: tickSchema,
  arrivesAt: tickSchema,
};
const dealFellThroughShape = {
  deliveryId: idSchema("Delivery"),
  buyerId: idSchema("Buyer"),
  reason: z.enum(["TOO_LATE", "CARGO_LOST", "NOT_WANTED", "CONTRACT_CLOSED", "ROUTE_CLOSED"]),
};
const routeFoundClosedShape = {
  deliveryId: idSchema("Delivery"),
  routeId: idSchema("Route"),
};
const cargoLostShape = {
  deliveryId: idSchema("Delivery"),
  vehicleId: idSchema("Vehicle"),
  cargo,
  bookValue: moneySchema,
  transactionId: idSchema("Transaction"),
};

// ---------------------------------------------------------------------------
// Knowledge (ADR 0021 decisions 4–7)
// ---------------------------------------------------------------------------

const vehicleTripSchema = z.strictObject({
  deliveryId: idSchema("Delivery"),
  routeId: idSchema("Route"),
  leg: z.enum(["OUTBOUND", "RETURN"]),
  departedAt: tickSchema,
  arrivesAt: tickSchema,
  cargo,
  purpose: deliveryPurposeSchema,
  delayed: z.boolean(),
});

const routeStatusSchema = z.union([
  z.strictObject({ open: z.literal(true) }),
  z.strictObject({ open: z.literal(false), reopensAt: tickSchema.nullable(), reason: closureReason }),
]);

const buyerWantShape = {
  productId: idSchema("Product"),
  productName: z.string(),
  minimumQuality: qualitySchema,
  unitPrice: moneySchema,
  demandRemaining: count,
};

const contractOfferShape = {
  ...contractTermsShape,
  buyerName: z.string(),
  productName: z.string(),
  id: idSchema("ContractOffer"),
  firstDeadline: tickSchema,
  expiresAt: tickSchema,
};

const installmentShape = {
  index: nonNegativeInt,
  deadline: tickSchema,
  required: count,
  delivered: count,
  outcome: outcomeSchema.nullable(),
  penalty: moneySchema.nullable(),
};

const contractStatusSchema = z.enum(["ACTIVE", "COMPLETED"]);

const facilityStockValueSchema = z.strictObject({
  kind: z.literal("FACILITY_STOCK"),
  facilityId: idSchema("Facility"),
  products: z.array(
    z.strictObject({
      productId: idSchema("Product"),
      productName: z.string(),
      quality: qualitySchema,
      quantity: count,
      reservedQuantity: count,
      totalCost: moneySchema,
      averageUnitCost: moneySchema,
    }),
  ),
  materials: z.array(
    z.strictObject({
      materialId: idSchema("Material"),
      materialName: z.string(),
      quantity: count,
      reservedQuantity: count,
      totalCost: moneySchema,
    }),
  ),
  storageUsed: count,
});

const facilityOperationsValueSchema = z.strictObject({
  kind: z.literal("FACILITY_OPERATIONS"),
  facilityId: idSchema("Facility"),
  jobs: z.array(
    z.strictObject({
      id: idSchema("ProductionJob"),
      facilityId: idSchema("Facility"),
      recipeId: idSchema("Recipe"),
      productId: idSchema("Product"),
      quality: qualitySchema,
      quantity: positiveQuantity,
      startedAt: tickSchema,
      completesAt: tickSchema,
    }),
  ),
  workersPresent: count,
});

const supplierOfferValueSchema = z.strictObject({
  kind: z.literal("SUPPLIER_OFFER"),
  supplierId: idSchema("Supplier"),
  materials: z.array(
    z.strictObject({
      materialId: idSchema("Material"),
      materialName: z.string(),
      unitPrice: moneySchema,
      available: count,
      shortage: z.boolean(),
    }),
  ),
});

const buyerWantsValueSchema = z.strictObject({
  kind: z.literal("BUYER_WANTS"),
  buyerId: idSchema("Buyer"),
  willDeal: z.boolean(),
  wants: z.array(z.strictObject(buyerWantShape)),
});

const buyerBudgetValueSchema = z.strictObject({
  kind: z.literal("BUYER_BUDGET"),
  buyerId: idSchema("Buyer"),
  budgetRemaining: moneySchema,
});

const contractOffersValueSchema = z.strictObject({
  kind: z.literal("CONTRACT_OFFERS"),
  buyerId: idSchema("Buyer"),
  offers: z.array(z.strictObject(contractOfferShape)),
});

const contractProgressValueSchema = z.strictObject({
  kind: z.literal("CONTRACT_PROGRESS"),
  contractId: idSchema("Contract"),
  status: contractStatusSchema,
  installments: z.array(z.strictObject(installmentShape)),
});

const marketPricesValueSchema = z.strictObject({
  kind: z.literal("MARKET_PRICES"),
  products: z.array(
    z.strictObject({
      productId: idSchema("Product"),
      productName: z.string(),
      quality: qualitySchema,
      basePrice: moneySchema,
      spotPrice: moneySchema,
      demandRatioPpm: nonNegativeInt,
      supplyRatioPpm: nonNegativeInt,
      eventRatioPpm: nonNegativeInt,
      previousSpotPrice: moneySchema.nullable(),
    }),
  ),
});

const routeConditionValueSchema = z.strictObject({
  kind: z.literal("ROUTE_CONDITION"),
  routeId: idSchema("Route"),
  status: routeStatusSchema,
});

const vehicleWhereaboutsValueSchema = z.strictObject({
  kind: z.literal("VEHICLE_WHEREABOUTS"),
  vehicleId: idSchema("Vehicle"),
  parkedAt: idSchema("Location").nullable(),
  trip: vehicleTripSchema.nullable(),
});

const standingValueSchema = z.strictObject({
  kind: z.literal("STANDING"),
  reputation: reputationSchema,
  tierId: idSchema("Tier"),
  unlocked: z.array(idSchema("Unlock")),
});

export const knowledgeSubjectSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("FACILITY_STOCK"), facilityId: idSchema("Facility") }),
  z.strictObject({ kind: z.literal("FACILITY_OPERATIONS"), facilityId: idSchema("Facility") }),
  z.strictObject({ kind: z.literal("SUPPLIER_OFFER"), supplierId: idSchema("Supplier") }),
  z.strictObject({ kind: z.literal("BUYER_WANTS"), buyerId: idSchema("Buyer") }),
  z.strictObject({ kind: z.literal("BUYER_BUDGET"), buyerId: idSchema("Buyer") }),
  z.strictObject({ kind: z.literal("CONTRACT_OFFERS"), buyerId: idSchema("Buyer") }),
  z.strictObject({ kind: z.literal("CONTRACT_PROGRESS"), contractId: idSchema("Contract") }),
  z.strictObject({ kind: z.literal("MARKET_PRICES") }),
  z.strictObject({ kind: z.literal("ROUTE_CONDITION"), routeId: idSchema("Route") }),
  z.strictObject({ kind: z.literal("VEHICLE_WHEREABOUTS"), vehicleId: idSchema("Vehicle") }),
  z.strictObject({ kind: z.literal("STANDING") }),
]) satisfies z.ZodType<KnowledgeSubject>;

// Every subject kind has a subject branch.
void (SUBJECT_KINDS satisfies readonly z.infer<typeof knowledgeSubjectSchema>["kind"][]);

export const knowledgeValueSchema = z.discriminatedUnion("kind", [
  facilityStockValueSchema,
  facilityOperationsValueSchema,
  supplierOfferValueSchema,
  buyerWantsValueSchema,
  buyerBudgetValueSchema,
  contractOffersValueSchema,
  contractProgressValueSchema,
  marketPricesValueSchema,
  routeConditionValueSchema,
  vehicleWhereaboutsValueSchema,
  standingValueSchema,
]);

export const knowledgeSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("IN_PERSON"), locationId: idSchema("Location") }),
  z.strictObject({ kind: z.literal("CASH_POSTING"), transactionId: idSchema("Transaction") }),
  z.strictObject({ kind: z.literal("PHONE"), partyLocationId: idSchema("Location") }),
  z.strictObject({
    kind: z.literal("MESSAGE"),
    takenAtLocationId: idSchema("Location"),
    takenBy: idSchema("Character").nullable(),
  }),
  z.strictObject({ kind: z.literal("REPORT"), characterId: idSchema("Character") }),
]);

/** A value belongs to a subject when it has the subject's kind and key. */
function valueMatches(subject: KnowledgeSubject, value: KnowledgeValue | null): boolean {
  return value === null || (value.kind === subject.kind && knowledgeSubjectKey(value) === knowledgeSubjectKey(subject));
}

export const knowledgeRecordSchema = z
  .strictObject({
    subject: knowledgeSubjectSchema,
    value: knowledgeValueSchema,
    learnedAt: tickSchema,
    source: knowledgeSourceSchema,
  })
  .refine((r) => valueMatches(r.subject, r.value), "A record's value must have its subject's kind and key");

const newsEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("PRODUCTION_FAILED"), ...productionFailedShape }),
  z.strictObject({ type: z.literal("DELIVERY_DELAYED"), ...deliveryDelayedShape }),
  z.strictObject({ type: z.literal("DEAL_FELL_THROUGH"), ...dealFellThroughShape }),
  z.strictObject({ type: z.literal("CARGO_LOST"), ...cargoLostShape }),
  z.strictObject({ type: z.literal("ROUTE_FOUND_CLOSED"), ...routeFoundClosedShape }),
]);

export const newsItemSchema = z.strictObject({ tick: tickSchema, event: newsEventSchema });

export const catchUpLineSchema = z
  .strictObject({
    subject: knowledgeSubjectSchema,
    before: knowledgeValueSchema.nullable(),
    after: knowledgeValueSchema,
  })
  .refine((l) => valueMatches(l.subject, l.before) && valueMatches(l.subject, l.after), "A catch-up line's values must have its subject's kind and key");

const catchUpShape = {
  locationId: idSchema("Location"),
  sinceTick: tickSchema.nullable(),
  lines: z.array(catchUpLineSchema),
  news: z.array(newsItemSchema),
  droppedNews: count,
};

export const catchUpSchema = z.strictObject({ ...catchUpShape, tick: tickSchema });

const transactionProducerSchema = z.enum(
  Object.keys(TRANSACTION_PRODUCERS) as [TransactionProducer, ...TransactionProducer[]],
);

export const activityItemSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("COMMAND"),
    tick: tickSchema,
    command: gameCommandSchema,
    status: z.enum(["APPLIED", "QUEUED", "REJECTED"]),
    reason: rejectionReasonSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal("CATCH_UP"),
    tick: tickSchema,
    locationId: idSchema("Location"),
    sinceTick: tickSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal("CASH_POSTING"),
    tick: tickSchema,
    producer: transactionProducerSchema,
    cashChange: moneySchema,
    revealed: z.array(knowledgeSubjectSchema),
    news: z.array(newsItemSchema),
  }),
]);

export const knowledgeStateSchema = z.strictObject({
  records: z.array(knowledgeRecordSchema),
  pendingNews: z.array(
    z.strictObject({ locationId: idSchema("Location"), items: z.array(newsItemSchema), dropped: count }),
  ),
  pendingBooks: z.array(
    z.strictObject({
      transactionId: idSchema("Transaction"),
      concerns: z.union([
        knowledgeSubjectSchema,
        z.strictObject({ kind: z.literal("NEWS"), locationId: idSchema("Location") }),
      ]),
    }),
  ),
  activity: z.array(activityItemSchema),
  lastCatchUp: catchUpSchema.nullable(),
});

export const gameEventSchema = z.discriminatedUnion("type", [
  ev("COMMAND_REJECTED", {
    commandId: idSchema("Command"),
    commandType: z.enum(GAME_COMMAND_TYPES),
    reason: rejectionReasonSchema,
  }),
  ev("DAY_SETTLED", {
    dayIndex: nonNegativeInt,
    wagesDue: moneySchema,
    overheadDue: moneySchema,
    paidInCash: moneySchema,
    addedToLiabilities: moneySchema,
    liabilitiesPaid: moneySchema,
    transactionId: idSchema("Transaction"),
  }),
  ev("MATERIALS_PURCHASED", {
    supplierId: idSchema("Supplier"),
    materialId: idSchema("Material"),
    quantity: positiveQuantity,
    unitPrice: moneySchema,
    total: moneySchema,
    facilityId: idSchema("Facility"),
    transactionId: idSchema("Transaction"),
  }),
  ev("PRODUCTION_STARTED", {
    jobId: idSchema("ProductionJob"),
    facilityId: idSchema("Facility"),
    recipeId: idSchema("Recipe"),
    quantity: positiveQuantity,
    completesAt: tickSchema,
  }),
  ev("PRODUCTION_COMPLETED", {
    jobId: idSchema("ProductionJob"),
    facilityId: idSchema("Facility"),
    productId: idSchema("Product"),
    quality: qualitySchema,
    quantity: positiveQuantity,
    costBasis: moneySchema,
    transactionId: idSchema("Transaction"),
  }),
  ev("PRODUCTION_FAILED", productionFailedShape),
  ev("EQUIPMENT_PURCHASED", {
    facilityId: idSchema("Facility"),
    equipmentId: idSchema("Equipment"),
    price: moneySchema,
    transactionId: idSchema("Transaction"),
  }),
  ev("EQUIPMENT_SOLD", {
    facilityId: idSchema("Facility"),
    equipmentId: idSchema("Equipment"),
    bookValue: moneySchema,
    proceeds: moneySchema,
    transactionId: idSchema("Transaction"),
  }),
  ev("WORKFORCE_CHANGED", { facilityId: idSchema("Facility"), from: count, to: count }),
  ev("DELIVERY_DISPATCHED", {
    deliveryId: idSchema("Delivery"),
    vehicleId: idSchema("Vehicle"),
    routeId: idSchema("Route"),
    cargo,
    purpose: deliveryPurposeSchema,
    arrivesAt: tickSchema,
  }),
  ev("DELIVERY_DELAYED", deliveryDelayedShape),
  ev("SALE_COMPLETED", {
    deliveryId: idSchema("Delivery"),
    buyerId: idSchema("Buyer"),
    cargo,
    unitPrice: moneySchema,
    revenue: moneySchema,
    costOfGoodsSold: moneySchema,
    contractId: idSchema("Contract").nullable(),
    transactionId: idSchema("Transaction"),
  }),
  ev("TRANSFER_COMPLETED", {
    deliveryId: idSchema("Delivery"),
    destinationFacilityId: idSchema("Facility"),
    cargo,
    bookValue: moneySchema,
  }),
  ev("DEAL_FELL_THROUGH", dealFellThroughShape),
  ev("CARGO_LOST", cargoLostShape),
  ev("VEHICLE_RETURNED", {
    vehicleId: idSchema("Vehicle"),
    deliveryId: idSchema("Delivery"),
    locationId: idSchema("Location"),
    returnedCargo: cargo,
  }),
  ev("MARKET_UPDATED", { dayIndex: nonNegativeInt }),
  ev("SHORTAGE_STARTED", {
    supplierId: idSchema("Supplier"),
    materialId: idSchema("Material"),
    supplyRatioPpm: nonNegativeInt,
    endsAt: tickSchema,
  }),
  ev("SHORTAGE_ENDED", { supplierId: idSchema("Supplier"), materialId: idSchema("Material") }),
  ev("ROUTE_CLOSED", { routeId: idSchema("Route"), reason: closureReason, reopensAt: tickSchema.nullable() }),
  ev("ROUTE_REOPENED", { routeId: idSchema("Route") }),
  ev("CONTRACT_OFFERED", {
    contractOfferId: idSchema("ContractOffer"),
    buyerId: idSchema("Buyer"),
    expiresAt: tickSchema,
  }),
  ev("CONTRACT_OFFER_EXPIRED", { contractOfferId: idSchema("ContractOffer") }),
  ev("CONTRACT_ACCEPTED", {
    contractOfferId: idSchema("ContractOffer"),
    contractId: idSchema("Contract"),
    buyerId: idSchema("Buyer"),
    reservationIds: z.array(idSchema("Reservation")),
  }),
  ev("INSTALLMENT_SETTLED", {
    contractId: idSchema("Contract"),
    installmentIndex: nonNegativeInt,
    required: count,
    delivered: count,
    outcome: outcomeSchema,
    penalty: moneySchema,
    transactionId: idSchema("Transaction"),
  }),
  ev("CONTRACT_COMPLETED", { contractId: idSchema("Contract"), outcomes: z.array(outcomeSchema) }),
  ev("RESERVATION_RELEASED", {
    reservationId: idSchema("Reservation"),
    reason: z.enum(["PLAYER", "CONTRACT_ENDED", "PRODUCTION_FAILED", "DELIVERY_FAILED", "CONSUMED"]),
  }),
  ev("REPUTATION_CHANGED", {
    from: z.number().int().min(0).max(100),
    to: z.number().int().min(0).max(100),
    reason: z.enum([
      "FIRST_QUALIFYING_DELIVERY",
      "INSTALLMENT_FULFILLED",
      "CONSECUTIVE_INSTALLMENT",
      "INSTALLMENT_PARTIAL",
      "INSTALLMENT_MISSED",
      "PRODUCT_REJECTED",
      "DEAL_FELL_THROUGH",
    ]),
    deliveryId: idSchema("Delivery").nullable(),
    contractId: idSchema("Contract").nullable(),
  }),
  ev("TIER_REACHED", { tierId: idSchema("Tier") }),
  ev("UNLOCK_GRANTED", { unlockId: idSchema("Unlock") }),
  ev("VICTORY_ACHIEVED", {
    netWorth: moneySchema,
    reputation: z.number().int().min(0).max(100),
    completedContractId: idSchema("Contract"),
  }),
  ev("GAME_LOST", { reason: z.literal("INSOLVENT") }),
  ev("LOSS_BOOKED", {
    reason: closureReason,
    assessed: moneySchema,
    amount: moneySchema,
    netWorthBefore: moneySchema,
    transactionId: idSchema("Transaction"),
  }),
  ev("KNOWLEDGE_CAUGHT_UP", catchUpShape),
  ev("FOUNDER_DEPARTED", { from: idSchema("Location"), to: idSchema("Location"), transport: transportSchema }),
  ev("FOUNDER_ARRIVED", { locationId: idSchema("Location") }),
  ev("FOUNDER_HALTED", { routeId: idSchema("Route"), locationId: idSchema("Location") }),
  ev("FOUNDER_RESTED", { locationId: idSchema("Location"), until: tickSchema }),
  ev("FOUNDER_WOKE", { locationId: idSchema("Location"), early: z.boolean() }),
  ev("DEAL_AGREED", {
    dealId: idSchema("Deal"),
    buyerId: idSchema("Buyer"),
    productId: idSchema("Product"),
    quality: qualitySchema,
    quantity: positiveQuantity,
    unitPrice: moneySchema,
    expiresAt: tickSchema,
    budgetCommitted: z.boolean(),
  }),
  ev("DEAL_EXPIRED", { dealId: idSchema("Deal"), buyerId: idSchema("Buyer") }),
  ev("SPEC_SALE_SETTLED", {
    deliveryId: idSchema("Delivery"),
    buyerId: idSchema("Buyer"),
    offered: positiveQuantity,
    accepted: count,
    unitPrice: moneySchema,
  }),
  ev("ROUTE_FOUND_CLOSED", routeFoundClosedShape),
]);

// ---------------------------------------------------------------------------
// Ledger (FIN-001)
// ---------------------------------------------------------------------------

const ledgerAccountSchema = z.enum(Object.keys(LEDGER_ACCOUNTS) as [LedgerAccount, ...LedgerAccount[]]);

const transactionKindSchema = z.enum([
  "OPENING_BALANCE", "MATERIAL_PURCHASE", "PRODUCTION", "PRODUCTION_WRITE_OFF", "EQUIPMENT_PURCHASE",
  "DISPATCH", "SALE", "TRANSFER", "CARGO_LOSS", "DAILY_SETTLEMENT", "INSTALLMENT_SETTLEMENT",
  "RESERVATION", "ASSET_SALE", "VEHICLE_RETURN", "LOSS", "PROGRESSION",
] as const satisfies readonly TransactionKind[]);

const ledgerEntrySchema = z.strictObject({
  account: ledgerAccountSchema,
  side: z.enum(["DEBIT", "CREDIT"]),
  amount: moneySchema.refine((v) => v > 0, "Entry amounts are positive; the side carries direction"),
});

export const ledgerTransactionSchema = z
  .strictObject({
    id: idSchema("Transaction"),
    tick: tickSchema,
    kind: transactionKindSchema,
    idempotencyKey: z.string().min(1),
    entries: z.array(ledgerEntrySchema),
    eventIds: z.array(idSchema("Event")),
  })
  .refine((t) => t.entries.length !== 1, "A transaction has no entries or at least two")
  .refine((t) => {
    let balance = 0;
    for (const e of t.entries) balance += e.side === "DEBIT" ? e.amount : -e.amount;
    return balance === 0;
  }, "Debits must equal credits");

// ---------------------------------------------------------------------------
// Game state and saves (ADR 0008, 0009)
// ---------------------------------------------------------------------------

const rngStateSchema = z.strictObject({
  algorithm: z.literal("xoshiro128**"),
  words: z.tuple([count, count, count, count]),
});

const outcomeStateSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("PLAYING") }),
  z.strictObject({ status: z.literal("WON"), tick: tickSchema }),
  z.strictObject({ status: z.literal("LOST"), tick: tickSchema, reason: z.literal("INSOLVENT") }),
]);

const scheduledBase = { tick: tickSchema, sequence: nonNegativeInt };

export const gameStateSchema = z.strictObject({
  scenarioId: idSchema("Scenario"),
  seed: z.number().int(),
  tick: tickSchema,
  outcome: outcomeStateSchema,
  counters: z.strictObject({
    nextCommandSequence: nonNegativeInt,
    nextScheduleSequence: nonNegativeInt,
    nextId: z.record(z.enum(DYNAMIC_ID_KINDS), nonNegativeInt),
  }),
  rng: z.record(z.enum(RNG_STREAMS), rngStateSchema),
  family: z.strictObject({
    id: idSchema("Family"),
    reputation: z.number().int().min(0).max(100),
    tierId: idSchema("Tier"),
    unlocked: z.array(idSchema("Unlock")),
    firstQualifyingDeliveryMade: z.boolean(),
    consecutiveFulfilledInstallments: nonNegativeInt,
  }),
  facilities: z.array(
    z.strictObject({
      id: idSchema("Facility"),
      equipment: z.array(z.strictObject({ equipmentId: idSchema("Equipment"), bookValue: moneySchema })),
      workerCount: count,
    }),
  ),
  productPools: z.array(
    z.strictObject({
      facilityId: idSchema("Facility"),
      productId: idSchema("Product"),
      quality: qualitySchema,
      quantity: count,
      totalCost: moneySchema,
    }),
  ),
  materialPools: z.array(
    z.strictObject({
      facilityId: idSchema("Facility"),
      materialId: idSchema("Material"),
      quantity: count,
      totalCost: moneySchema,
    }),
  ),
  reservations: z.array(
    z.strictObject({
      id: idSchema("Reservation"),
      facilityId: idSchema("Facility"),
      goods: z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("PRODUCT"), productId: idSchema("Product"), quality: qualitySchema }),
        z.strictObject({ kind: z.literal("MATERIAL"), materialId: idSchema("Material") }),
      ]),
      quantity: positiveQuantity,
      holder: z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("CONTRACT"), contractId: idSchema("Contract") }),
        z.strictObject({ kind: z.literal("PRODUCTION_JOB"), jobId: idSchema("ProductionJob") }),
      ]),
    }),
  ),
  productionJobs: z.array(
    z.strictObject({
      id: idSchema("ProductionJob"),
      facilityId: idSchema("Facility"),
      recipeId: idSchema("Recipe"),
      quantity: positiveQuantity,
      startedAt: tickSchema,
      completesAt: tickSchema,
      reservationIds: z.array(idSchema("Reservation")),
    }),
  ),
  vehicles: z.array(
    z.strictObject({
      id: idSchema("Vehicle"),
      parkedAt: idSchema("Location").nullable(),
      tripCount: count,
      trip: z
        .strictObject({
          deliveryId: idSchema("Delivery"),
          routeId: idSchema("Route"),
          leg: z.enum(["OUTBOUND", "RETURN"]),
          departedAt: tickSchema,
          arrivesAt: tickSchema,
          delayed: z.boolean(),
        })
        .nullable(),
    }),
  ),
  deliveries: z.array(
    z.strictObject({
      id: idSchema("Delivery"),
      vehicleId: idSchema("Vehicle"),
      fromFacilityId: idSchema("Facility"),
      routeId: idSchema("Route"),
      cargo: z.array(
        z.strictObject({
          productId: idSchema("Product"),
          quality: qualitySchema,
          quantity: positiveQuantity,
          cost: moneySchema,
        }),
      ),
      purpose: deliveryPurposeSchema,
      status: z.enum(["OUTBOUND", "DELIVERED", "FAILED"]),
      dealDeadline: tickSchema.nullable(),
      driver: driverRefSchema.nullable(),
    }),
  ),
  heldDeals: z.array(
    z
      .strictObject({
        id: idSchema("Deal"),
        buyerId: idSchema("Buyer"),
        productId: idSchema("Product"),
        quality: qualitySchema,
        quantity: positiveQuantity,
        unitPrice: moneySchema,
        agreedAt: tickSchema,
        expiresAt: tickSchema,
        budgetCommitted: z.boolean(),
        status: z.enum(["HELD", "DISPATCHED", "SETTLED", "EXPIRED", "FELL_THROUGH"]),
        deliveryId: idSchema("Delivery").nullable(),
      })
      // Terminal deals leave the list (ADR 0022 decision 6); a dispatched one names its delivery.
      .refine((d) => d.status === "HELD" || d.status === "DISPATCHED", "heldDeals holds only HELD and DISPATCHED deals")
      .refine((d) => (d.status === "DISPATCHED") === (d.deliveryId !== null), "A deal names a delivery exactly when it's DISPATCHED"),
  ),
  markets: z.array(
    z.strictObject({
      productId: idSchema("Product"),
      quality: qualitySchema,
      demand: count,
      supply: count,
      eventRatio: ratioSchema,
      spotPrice: moneySchema,
      previousSpotPrice: moneySchema.nullable(),
    }),
  ),
  suppliers: z.array(
    z.strictObject({
      id: idSchema("Supplier"),
      stock: z.array(
        z.strictObject({
          materialId: idSchema("Material"),
          available: count,
          unitPrice: moneySchema,
          shortage: z.strictObject({ supplyRatio: ratioSchema, endsAt: tickSchema }).nullable(),
        }),
      ),
    }),
  ),
  buyers: z.array(
    z.strictObject({
      id: idSchema("Buyer"),
      budgetRemaining: moneySchema,
      wants: z.array(
        z.strictObject({
          productId: idSchema("Product"),
          minimumQuality: qualitySchema,
          unitPrice: moneySchema,
          demandRemaining: count,
        }),
      ),
      commitments: z.array(
        z.strictObject({
          dealId: idSchema("Deal"),
          productId: idSchema("Product"),
          quality: qualitySchema,
          quantity: positiveQuantity,
          amount: moneySchema,
        }),
      ),
    }),
  ),
  routes: z.array(
    z.strictObject({
      id: idSchema("Route"),
      closure: z.strictObject({ reason: closureReason, reopensAt: tickSchema.nullable() }).nullable(),
    }),
  ),
  contractOffers: z.array(
    z.strictObject({
      ...contractTermsShape,
      id: idSchema("ContractOffer"),
      firstDeadline: tickSchema,
      expiresAt: tickSchema,
    }),
  ),
  contracts: z.array(
    z.strictObject({
      ...contractTermsShape,
      id: idSchema("Contract"),
      offerId: idSchema("ContractOffer"),
      status: z.enum(["ACTIVE", "COMPLETED"]),
      installments: z.array(
        z.strictObject({
          deadline: tickSchema,
          required: count,
          delivered: count,
          outcome: outcomeSchema.nullable(),
          penalty: moneySchema.nullable(),
        }),
      ),
      reservationIds: z.array(idSchema("Reservation")),
    }),
  ),
  ledger: z.strictObject({ transactions: z.array(ledgerTransactionSchema) }),
  queuedCommands: z.array(commandEnvelopeSchema),
  commandLog: z.array(commandEnvelopeSchema),
  scheduledEvents: z.array(
    z.discriminatedUnion("kind", [
      z.strictObject({
        ...scheduledBase,
        kind: z.literal("ROUTE_CLOSURE"),
        routeId: idSchema("Route"),
        reason: closureReason,
        durationTicks: positiveQuantity.nullable(),
      }),
      z.strictObject({ ...scheduledBase, kind: z.literal("ROUTE_REOPENING"), routeId: idSchema("Route") }),
      z.strictObject({
        ...scheduledBase,
        kind: z.literal("SHORTAGE_START"),
        supplierId: idSchema("Supplier"),
        materialId: idSchema("Material"),
        supplyRatio: ratioSchema,
        durationTicks: positiveQuantity,
      }),
      z.strictObject({
        ...scheduledBase,
        kind: z.literal("SHORTAGE_END"),
        supplierId: idSchema("Supplier"),
        materialId: idSchema("Material"),
      }),
      z.strictObject({ ...scheduledBase, kind: z.literal("CONTRACT_OFFER"), buyerId: idSchema("Buyer") }),
      z.strictObject({
        ...scheduledBase,
        kind: z.literal("SHAKEDOWN"),
        reason: closureReason,
        netWorthSharePpm: z.number().int().min(1).max(1_000_000),
      }),
    ]),
  ),
  eventJournal: z.array(gameEventSchema),
  knowledge: knowledgeStateSchema,
  founder: founderStateSchema,
});

export const saveGameSchema = z.strictObject({
  format: z.literal(SAVE_FORMAT),
  schemaVersion: z.literal(SAVE_SCHEMA_VERSION),
  scenarioId: idSchema("Scenario"),
  gameDataVersion: z.string().min(1),
  state: gameStateSchema,
});

export const saveFileSchema = z.strictObject({
  save: saveGameSchema,
  meta: z.strictObject({
    slot: z.string().min(1),
    label: z.string(),
    savedAt: z.iso.datetime(),
    appVersion: z.string().min(1),
  }),
  stateHash: z.string().min(1),
});

/** The first thing persistence reads, before migrating: just enough to pick a migration path. */
export const saveHeaderSchema = z.looseObject({
  format: z.literal(SAVE_FORMAT),
  schemaVersion: z.number().int().min(1),
});

// ---------------------------------------------------------------------------
// What the worker sends the game UI (ADR 0021 decisions 2 and 8)
// ---------------------------------------------------------------------------

export const playerCommandResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("applied"), commandId: idSchema("Command"), tick: tickSchema }),
  z.strictObject({ status: z.literal("queued"), commandId: idSchema("Command"), scheduledTick: tickSchema }),
  z.strictObject({ status: z.literal("rejected"), commandId: idSchema("Command"), reason: rejectionReasonSchema }),
]);

function known<S extends z.ZodType>(value: S) {
  return z.strictObject({ value, learnedAt: tickSchema, source: knowledgeSourceSchema }).nullable();
}

const worldPointSchema = z.strictObject({
  x: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  y: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
});

const placeGeographyShape = { id: idSchema("Location"), name: z.string(), position: worldPointSchema };

const playerFacilitySchema = z.strictObject({
  id: idSchema("Facility"),
  name: z.string(),
  kind: z.enum(["DISTILLERY", "WAREHOUSE"]),
  equipment: z.array(
    z.strictObject({ id: idSchema("Equipment"), name: z.string(), bookValue: moneySchema, resaleValue: moneySchema }),
  ),
  equipmentSlots: z.strictObject({ used: count, total: count }),
  equipmentOptions: z.array(
    z.strictObject({
      equipmentId: idSchema("Equipment"),
      name: z.string(),
      description: z.string(),
      price: moneySchema,
      blockedBy: rejectionReasonSchema.nullable(),
    }),
  ),
  workforce: z.strictObject({ workers: count, maximum: count, dailyWagePerWorker: moneySchema }),
  productionCapacityPerDay: count,
  recipes: z.array(
    z.strictObject({
      recipeId: idSchema("Recipe"),
      name: z.string(),
      productId: idSchema("Product"),
      quality: qualitySchema,
      inputsPerCase: z.array(z.strictObject({ materialId: idSchema("Material"), quantity: positiveQuantity })),
      ticksPerCase: positiveQuantity,
      maxStartableQuantity: count,
      blockedBy: rejectionReasonSchema.nullable(),
    }),
  ),
  storageCapacity: count,
  stock: known(facilityStockValueSchema),
  operations: known(facilityOperationsValueSchema),
});

const playerPlaceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...placeGeographyShape, kind: z.literal("FACILITY"), facility: playerFacilitySchema }),
  z.strictObject({
    ...placeGeographyShape,
    kind: z.literal("SUPPLIER"),
    supplier: z.strictObject({ id: idSchema("Supplier"), name: z.string(), offer: known(supplierOfferValueSchema) }),
  }),
  z.strictObject({
    ...placeGeographyShape,
    kind: z.literal("BUYER"),
    buyer: z.strictObject({
      id: idSchema("Buyer"),
      name: z.string(),
      minimumReputation: reputationSchema,
      wants: known(
        buyerWantsValueSchema.extend({
          wants: z.array(z.strictObject({ ...buyerWantShape, maxAcceptableQuantity: count })),
        }),
      ),
      budget: known(buyerBudgetValueSchema),
      offers: known(
        contractOffersValueSchema.extend({
          offers: z.array(z.strictObject({ ...contractOfferShape, blockedBy: rejectionReasonSchema.nullable() })),
        }),
      ),
    }),
  }),
]);

const playerRouteSchema = z.strictObject({
  id: idSchema("Route"),
  name: z.string(),
  fromLocationId: idSchema("Location"),
  toLocationId: idSchema("Location"),
  waypoints: z.array(worldPointSchema),
  durationTicks: positiveQuantity,
  transportCost: moneySchema,
  riskPpm: nonNegativeInt,
  condition: known(routeConditionValueSchema),
});

const playerVehicleSchema = z.strictObject({
  id: idSchema("Vehicle"),
  name: z.string(),
  capacity: count,
  homeLocationId: idSchema("Location"),
  whereabouts: known(vehicleWhereaboutsValueSchema),
});

const playerContractSchema = z.strictObject({
  ...contractTermsShape,
  buyerName: z.string(),
  productName: z.string(),
  id: idSchema("Contract"),
  progress: known(
    contractProgressValueSchema.extend({
      installments: z.array(z.strictObject({ ...installmentShape, inTransit: count })),
    }),
  ),
});

const cashFlowCategorySchema = z.enum([
  "SALES", "ASSET_SALES", "MATERIALS", "EQUIPMENT", "WAGES", "OVERHEAD", "TRANSPORT", "PENALTIES", "LOSSES",
] as const satisfies readonly CashFlowCategory[]);

const progressSchema = <S extends z.ZodType>(value: S) => z.strictObject({ current: value, target: value });

export const playerSnapshotSchema = z.strictObject({
  clock: z.strictObject({
    tick: tickSchema,
    dayIndex: nonNegativeInt,
    date: z.strictObject({
      year: z.number().int(),
      month: z.number().int().min(1).max(12),
      day: z.number().int().min(1).max(31),
      hour: z.number().int().min(0).max(23),
      minute: z.number().int().min(0).max(59),
    }),
  }),
  outcome: outcomeStateSchema,
  founder: z.strictObject({
    ...founderStateSchema.shape,
    tired: z.boolean(),
    currentLeg: z
      .strictObject({
        routeId: idSchema("Route"),
        waypoints: z.array(worldPointSchema),
        progressPpm: z.number().int().min(0).max(1_000_000),
      })
      .nullable(),
  }),
  here: idSchema("Location").nullable(),
  places: z.array(playerPlaceSchema),
  routes: z.array(playerRouteSchema),
  vehicles: z.array(playerVehicleSchema),
  market: known(marketPricesValueSchema),
  standing: known(standingValueSchema),
  contracts: z.array(playerContractSchema),
  deals: z.array(
    z.strictObject({
      id: idSchema("Deal"),
      buyerId: idSchema("Buyer"),
      productId: idSchema("Product"),
      quality: qualitySchema,
      quantity: positiveQuantity,
      unitPrice: moneySchema,
      agreedAt: tickSchema,
      expiresAt: tickSchema,
      budgetCommitted: z.boolean(),
      status: z.enum(["HELD", "DISPATCHED"]),
      deliveryId: idSchema("Delivery").nullable(),
    }),
  ),
  finance: z.strictObject({
    cash: moneySchema,
    books: z.array(
      z.strictObject({
        tick: tickSchema,
        kind: transactionKindSchema,
        cashFlowCategory: cashFlowCategorySchema.nullable(),
        entries: z.array(ledgerEntrySchema),
      }),
    ),
    knownNetWorth: z.strictObject({ amount: moneySchema, asOf: tickSchema.nullable() }),
    victory: z.strictObject({
      netWorth: progressSchema(moneySchema),
      reputation: progressSchema(z.number()),
      completedContracts: progressSchema(count),
    }),
  }),
  activity: z.array(activityItemSchema),
  catchUp: catchUpSchema.nullable(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Readable one-line issues for SaveLoadError.INVALID and gateway rejections. */
export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`);
}

