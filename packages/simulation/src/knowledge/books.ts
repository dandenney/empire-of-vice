// The books and cash postings (ADR 0021 decisions 6 and 7): whether each ledger
// transaction is known, decided per transaction, never per TransactionKind.
//
// 1. Known at once: posted at game creation, by the founder's own command, or
//    as a charge fixed by agreements (`TRANSACTION_PRODUCERS` triggers other
//    than WORLD); or concerning what the founder observes when it posts
//    (`concernOf` is in the live view; at a closed place only the filtered view
//    counts, ADR 0023 decision 6); or posted on the delivery the founder rides
//    (#222: a seizure on their own run is seen on the spot).
// 2. Otherwise, with a CASH entry: a cash posting. Known, and a channel for its
//    cause (`CASH_POSTING_REVEALS`).
// 3. Otherwise, with entries: pending (`PENDING_BOOKS_CONCERNS`).
// 4. No entries: never in the player's books. An old entry-less
//    `RESERVATION:job-n` key (no registered producer) is one of these: a no-op.

import {
  CASH_POSTING_REVEALS,
  PENDING_BOOKS_CONCERNS,
  TRANSACTION_PRODUCERS,
  transactionProducerOf,
  type BooksConcern,
  type ContractId,
  type FacilityId,
  type GameEvent,
  type GameState,
  type KnowledgeSubject,
  type LedgerTransaction,
  type LocationId,
  type PartyKind,
  type TransactionProducer,
} from "@eov/contracts";
import type { GameData } from "@eov/game-data";
import { facilityLocation, sameSubject } from "./view.ts";

export class KnowledgeError extends Error {
  override readonly name = "KnowledgeError";
}

export type BookClass =
  | { readonly kind: "NO_ENTRIES" }
  | { readonly kind: "KNOWN" }
  | { readonly kind: "CASH_POSTING"; readonly producer: TransactionProducer }
  | { readonly kind: "PENDING"; readonly concerns: BooksConcern };

/** The idempotency key's first ID part: the delivery, contract or job it's about. */
function keyId(transaction: LedgerTransaction): string {
  const id = transaction.idempotencyKey.split(":")[1];
  if (!id) throw new KnowledgeError(`${transaction.id}: no ID in idempotency key ${transaction.idempotencyKey}`);
  return id;
}

function deliveryOf(state: GameState, transaction: LedgerTransaction) {
  const id = keyId(transaction);
  const delivery = state.deliveries.find((d) => d.id === id);
  if (!delivery) throw new KnowledgeError(`${transaction.id}: unknown delivery ${id}`);
  return delivery;
}

/** The facility a production settlement concerns, from its own event (the job has left state by then). */
function jobFacility(transaction: LedgerTransaction, events: ReadonlyMap<string, GameEvent>): FacilityId {
  for (const eventId of transaction.eventIds) {
    const event = events.get(eventId);
    if (event && (event.type === "PRODUCTION_COMPLETED" || event.type === "PRODUCTION_FAILED")) return event.facilityId;
  }
  throw new KnowledgeError(`${transaction.id}: a production settlement without its event`);
}

/**
 * What a WORLD transaction concerns (decision 7's table, extended to the
 * cash-only producers for rule 1's presence test): a subject, the news at a
 * place, or null for the producers with no place (midnight paydowns, a
 * shakedown).
 */
export function concernOf(
  state: GameState,
  data: GameData,
  transaction: LedgerTransaction,
  producer: TransactionProducer,
  events: ReadonlyMap<string, GameEvent>,
): BooksConcern | null {
  switch (producer) {
    case "PRODUCTION":
    case "PRODUCTION_WRITE_OFF":
      return { kind: "FACILITY_STOCK", facilityId: jobFacility(transaction, events) };
    case "INSTALLMENT_SETTLEMENT":
      return { kind: "CONTRACT_PROGRESS", contractId: keyId(transaction) as ContractId };
    case "VEHICLE_RETURN":
    case "SALE":
      return { kind: "VEHICLE_WHEREABOUTS", vehicleId: deliveryOf(state, transaction).vehicleId };
    case "CARGO_LOSS":
      return { kind: "NEWS", locationId: facilityLocation(data, deliveryOf(state, transaction).fromFacilityId) };
    case "TRANSFER": {
      const purpose = deliveryOf(state, transaction).purpose;
      if (purpose.kind !== "TRANSFER") throw new KnowledgeError(`${transaction.id}: a TRANSFER posting for a ${purpose.kind} delivery`);
      return { kind: "FACILITY_STOCK", facilityId: purpose.destinationFacilityId };
    }
    default:
      return null;
  }
}

/** Whether a transaction moved through CASH (decision 6 rule 2). */
export function hasCash(transaction: LedgerTransaction): boolean {
  return transaction.entries.some((e) => e.account === "CASH");
}

/** The producers whose idempotency key names the delivery they're about (`<KIND>:<deliveryId>`). */
const DELIVERY_PRODUCERS: ReadonlySet<TransactionProducer> = new Set<TransactionProducer>(["SALE", "VEHICLE_RETURN", "CARGO_LOSS", "TRANSFER"]);

/** What the founder observes at the end of a unit: the live view's subjects, the place, and the delivery they ride. */
export interface Observed {
  readonly subjects: readonly KnowledgeSubject[];
  readonly locationId: LocationId | null;
  /** The delivery the founder is aboard (ON_DELIVERY), whose road events they see on the spot (#222); null otherwise. */
  readonly aboard: string | null;
}

/** Decision 6's rules 1–4 for one transaction, at the end of the unit that posted it. */
export function classify(
  state: GameState,
  data: GameData,
  transaction: LedgerTransaction,
  observed: Observed,
  events: ReadonlyMap<string, GameEvent>,
): BookClass {
  if (transaction.entries.length === 0) return { kind: "NO_ENTRIES" };
  const producer = transactionProducerOf(transaction.idempotencyKey);
  if (producer === null) throw new KnowledgeError(`${transaction.id}: no registered producer for ${transaction.idempotencyKey}`);
  if (TRANSACTION_PRODUCERS[producer].trigger !== "WORLD") return { kind: "KNOWN" };
  // A posting on the delivery the founder rides (a seizure on the road) is seen
  // where it happens (#222, amending decision 7): rule 1's presence test.
  if (observed.aboard !== null && DELIVERY_PRODUCERS.has(producer) && keyId(transaction) === observed.aboard) return { kind: "KNOWN" };
  const concern = concernOf(state, data, transaction, producer, events);
  if (concern !== null) {
    const seen =
      concern.kind === "NEWS"
        ? concern.locationId === observed.locationId
        : observed.subjects.some((s) => sameSubject(s, concern));
    if (seen) return { kind: "KNOWN" };
  }
  if (hasCash(transaction)) {
    if (!Object.hasOwn(CASH_POSTING_REVEALS, producer)) {
      throw new KnowledgeError(`${transaction.id}: producer ${producer} posted cash away from the founder without a CASH_POSTING_REVEALS row`);
    }
    return { kind: "CASH_POSTING", producer };
  }
  if (!Object.hasOwn(PENDING_BOOKS_CONCERNS, producer) || concern === null) {
    throw new KnowledgeError(`${transaction.id}: producer ${producer} posted entries away from the founder without a PENDING_BOOKS_CONCERNS row`);
  }
  return { kind: "PENDING", concerns: concern };
}

/**
 * What a cash posting reveals (decision 6's table, `CASH_POSTING_REVEALS`): the
 * subjects of its cause that apply, limited to what KNOWLEDGE_VISIBILITY's
 * CASH_POSTING row allows for the party it concerns, and where its pending news
 * is delivered.
 */
export function cashPostingCause(
  state: GameState,
  data: GameData,
  transaction: LedgerTransaction,
  producer: keyof typeof CASH_POSTING_REVEALS,
  events: ReadonlyMap<string, GameEvent>,
): { readonly party: PartyKind | null; readonly subjects: readonly KnowledgeSubject[]; readonly newsAt: LocationId | null } {
  switch (producer) {
    case "INSTALLMENT_SETTLEMENT":
      return { party: "BUYER", subjects: [{ kind: "CONTRACT_PROGRESS", contractId: keyId(transaction) as ContractId }], newsAt: null };
    case "VEHICLE_RETURN": {
      const delivery = deliveryOf(state, transaction);
      return {
        party: "FACILITY",
        subjects: [{ kind: "VEHICLE_WHEREABOUTS", vehicleId: delivery.vehicleId }],
        newsAt: facilityLocation(data, delivery.fromFacilityId),
      };
    }
    case "SALE": {
      const delivery = deliveryOf(state, transaction);
      const subjects: KnowledgeSubject[] = [];
      if (delivery.purpose.kind === "CONTRACT_INSTALLMENT") subjects.push({ kind: "CONTRACT_PROGRESS", contractId: delivery.purpose.contractId });
      subjects.push({ kind: "VEHICLE_WHEREABOUTS", vehicleId: delivery.vehicleId });
      return { party: "BUYER", subjects, newsAt: null };
    }
    case "PRODUCTION":
    case "PRODUCTION_WRITE_OFF": {
      const facilityId = jobFacility(transaction, events);
      return {
        party: "FACILITY",
        subjects: [
          { kind: "FACILITY_STOCK", facilityId },
          { kind: "FACILITY_OPERATIONS", facilityId },
        ],
        newsAt: null,
      };
    }
    case "DAILY_SETTLEMENT:PENALTIES":
    case "DAILY_SETTLEMENT:PAYROLL":
    case "LOSS:SHAKEDOWN":
      return { party: null, subjects: [], newsAt: null };
  }
}
