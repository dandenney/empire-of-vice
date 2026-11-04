// S0 stub: extended by T02b (ADR 0010, FIN-001 atomic economic operations).
//
// Implements `TransactionCoordinator` from contracts. A draft stages changes on a
// private copy of the state; nothing reaches the caller until `commit` returns
// the new state, so a rejected or abandoned draft changes nothing.
//
// - IDs: the transaction ID comes from `allocateId` at `begin` (the counter only
//   moves in the draft's state, so it's consumed only on commit). Events are
//   minted and journaled with the kernel's `emitEvent` as they're staged, so a
//   committed transaction's events reach the journal exactly the way the kernel's
//   `eventsEmittedBetween` expects.
// - Idempotency: the ledger log is the record of applied operations. A key that's
//   already in it makes `begin` return `duplicate`.
// - Invariants: checked on the staged state at commit. A violation throws
//   InvariantViolationError: it's a bug, not a gameplay outcome.

import {
  InvariantViolationError,
  type CommitResult,
  type DuplicateTransaction,
  type EventId,
  type GameEventInput,
  type GameState,
  type InvariantViolation,
  type LedgerEntry,
  type LedgerTransaction,
  type RejectionReason,
  type StateChange,
  type TransactionCoordinator,
  type TransactionDraft,
  type TransactionId,
  type TransactionRequest,
} from "@eov/contracts";
import { emitEvent } from "../../events/journal.ts";
import { allocateId, formatId } from "../../kernel/ids.ts";
import { checkInvariants } from "./invariants.ts";

export class CoordinatorError extends Error {
  override readonly name = "CoordinatorError";
}

class Draft implements TransactionDraft {
  readonly transactionId: TransactionId;
  readonly request: TransactionRequest;
  #status: "staging" | "rejected" = "staging";
  #reason: RejectionReason | null = null;
  #state: GameState;
  readonly #entries: LedgerEntry[] = [];
  readonly #eventIds: EventId[] = [];
  #committed = false;

  constructor(base: GameState, request: TransactionRequest) {
    const minted = allocateId(base, "Transaction");
    this.transactionId = minted.id;
    this.request = request;
    this.#state = minted.state;
  }

  get status(): "staging" | "rejected" {
    return this.#status;
  }

  get state(): GameState {
    return this.#state;
  }

  #staging(): boolean {
    if (this.#committed) throw new CoordinatorError(`Transaction ${this.transactionId} was already committed`);
    return this.#status === "staging";
  }

  update(change: StateChange): void {
    if (this.#staging()) this.#state = change(this.#state);
  }

  post(entries: readonly LedgerEntry[]): void {
    if (this.#staging()) this.#entries.push(...entries);
  }

  emit(event: GameEventInput): EventId {
    // After a rejection, report the ID the event would have had, but mint nothing.
    if (!this.#staging()) return formatId("Event", this.#state.counters.nextId.Event);
    const emitted = emitEvent(this.#state, event, { tick: this.request.tick, causedBy: this.request.causedBy });
    this.#state = emitted.state;
    this.#eventIds.push(emitted.eventId);
    return emitted.eventId;
  }

  reject(reason: RejectionReason): void {
    if (!this.#staging()) return;
    this.#status = "rejected";
    this.#reason = reason;
  }

  #withTransaction(): { readonly state: GameState; readonly transaction: LedgerTransaction } {
    const transaction: LedgerTransaction = {
      id: this.transactionId,
      tick: this.request.tick,
      kind: this.request.kind,
      idempotencyKey: this.request.idempotencyKey,
      entries: [...this.#entries],
      eventIds: [...this.#eventIds],
    };
    const state: GameState = {
      ...this.#state,
      ledger: { ...this.#state.ledger, transactions: [...this.#state.ledger.transactions, transaction] },
    };
    return { state, transaction };
  }

  validate(): readonly InvariantViolation[] {
    const { state, transaction } = this.#withTransaction();
    return checkInvariants(state, transaction);
  }

  commit(): CommitResult {
    if (this.#committed) throw new CoordinatorError(`Transaction ${this.transactionId} can be committed once`);
    this.#committed = true;
    if (this.#status === "rejected") return { status: "rejected", reason: this.#reason! };
    const { state, transaction } = this.#withTransaction();
    const violations = checkInvariants(state, transaction);
    if (violations.length > 0) throw new InvariantViolationError(this.transactionId, violations);
    return { status: "committed", state, transactionId: this.transactionId, eventIds: transaction.eventIds };
  }
}

export function createCoordinator(): TransactionCoordinator {
  return {
    begin(state: GameState, request: TransactionRequest): TransactionDraft | DuplicateTransaction {
      const existing = state.ledger.transactions.find((t) => t.idempotencyKey === request.idempotencyKey);
      if (existing) return { status: "duplicate", transactionId: existing.id };
      return new Draft(state, request);
    },
  };
}
