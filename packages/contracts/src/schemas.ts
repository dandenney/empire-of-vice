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
import type { DeliveryPurpose, GameCommand } from "./commands.ts";
import { GAME_COMMAND_TYPES } from "./commands.ts";
import type { EventMeta } from "./events.ts";
import { QUALITY_TIERS } from "./goods.ts";
import { DYNAMIC_ID_KINDS, isValidId, type Id, type IdKind } from "./ids.ts";
import { LEDGER_ACCOUNTS, type LedgerAccount, type TransactionKind } from "./ledger.ts";
import { isMoney, type Money, type Ratio } from "./money.ts";
import { RNG_STREAMS } from "./state.ts";
import { SAVE_FORMAT, SAVE_SCHEMA_VERSION } from "./save.ts";
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

// ---------------------------------------------------------------------------
// Commands (ADR 0004)
// ---------------------------------------------------------------------------

export const deliveryPurposeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("SALE"), buyerId: idSchema("Buyer"), agreedUnitPrice: moneySchema }),
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
  }),
  z.strictObject({ type: z.literal("ACCEPT_CONTRACT"), contractOfferId: idSchema("ContractOffer") }),
  z.strictObject({
    type: z.literal("PURCHASE_EQUIPMENT"),
    facilityId: idSchema("Facility"),
    equipmentId: idSchema("Equipment"),
  }),
  z.strictObject({ type: z.literal("SET_WORKFORCE"), facilityId: idSchema("Facility"), workerCount: count }),
  z.strictObject({ type: z.literal("RELEASE_RESERVATION"), reservationId: idSchema("Reservation") }),
  z.strictObject({ type: z.literal("REPEAT_OPERATION"), sourceCommandId: idSchema("Command") }),
]) satisfies z.ZodType<GameCommand>;

/** What the worker gateway validates before calling `Simulation.dispatch`. */
export const commandRequestSchema = z.strictObject({
  command: gameCommandSchema,
  scheduledTick: tickSchema.optional(),
});

export const commandEnvelopeSchema = z.strictObject({
  id: idSchema("Command"),
  scheduledTick: tickSchema,
  sequence: nonNegativeInt,
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
  "ProductionJob", "Delivery", "ContractOffer", "Contract", "Reservation",
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
  z.strictObject({ code: z.literal("NOT_REPEATABLE"), sourceCommandId: idSchema("Command") }),
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
  ev("PRODUCTION_FAILED", {
    jobId: idSchema("ProductionJob"),
    facilityId: idSchema("Facility"),
    reason: z.literal("DISRUPTION"),
    writtenOff: moneySchema,
    transactionId: idSchema("Transaction"),
  }),
  ev("EQUIPMENT_PURCHASED", {
    facilityId: idSchema("Facility"),
    equipmentId: idSchema("Equipment"),
    price: moneySchema,
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
  ev("DELIVERY_DELAYED", {
    deliveryId: idSchema("Delivery"),
    routeId: idSchema("Route"),
    previousArrivesAt: tickSchema,
    arrivesAt: tickSchema,
  }),
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
  ev("DEAL_FELL_THROUGH", {
    deliveryId: idSchema("Delivery"),
    buyerId: idSchema("Buyer"),
    reason: z.enum(["TOO_LATE", "CARGO_LOST"]),
  }),
  ev("CARGO_LOST", {
    deliveryId: idSchema("Delivery"),
    vehicleId: idSchema("Vehicle"),
    cargo,
    bookValue: moneySchema,
    transactionId: idSchema("Transaction"),
  }),
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
    reason: z.enum(["PLAYER", "CONTRACT_ENDED", "PRODUCTION_FAILED", "DELIVERY_FAILED"]),
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
]);

// ---------------------------------------------------------------------------
// Ledger (FIN-001)
// ---------------------------------------------------------------------------

const ledgerAccountSchema = z.enum(Object.keys(LEDGER_ACCOUNTS) as [LedgerAccount, ...LedgerAccount[]]);

const transactionKindSchema = z.enum([
  "OPENING_BALANCE", "MATERIAL_PURCHASE", "PRODUCTION", "PRODUCTION_WRITE_OFF", "EQUIPMENT_PURCHASE",
  "DISPATCH", "SALE", "TRANSFER", "CARGO_LOSS", "DAILY_SETTLEMENT", "INSTALLMENT_SETTLEMENT",
  "RESERVATION", "ASSET_SALE",
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
    }),
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
          deliveryId: idSchema("Delivery"),
          productId: idSchema("Product"),
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
    ]),
  ),
  eventJournal: z.array(gameEventSchema),
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
// Helpers
// ---------------------------------------------------------------------------

/** Readable one-line issues for SaveLoadError.INVALID and gateway rejections. */
export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`);
}

