// The transaction coordinator interface. See docs/decisions/0010-transaction-coordinator.md.
// Defined here (T00b), implemented in T02b, used by every system that changes
// more than its own state: inventory, production, market, logistics, contracts.
//
// A transaction is staged against a draft of the state, validated, then committed
// all-or-nothing (architecture §5, FIN-001 "atomic economic operations"):
//
//   const tx = coordinator.begin(state, { kind: "SALE", idempotencyKey, tick, causedBy });
//   if (tx.status === "duplicate") return;          // already applied: idempotent no-op
//   if (buyerCantPay) tx.reject({ code: "INSUFFICIENT_FUNDS", ... });
//   tx.update(removeFromPool(...));                 // pure state changes, staged
//   tx.post([{ account: "CASH", side: "DEBIT", amount }, ...]);
//   tx.emit({ type: "SALE_COMPLETED", ... });
//   const result = tx.commit();                     // new state, or rejected; never half-applied
//
// Business rules (can the player afford it?) are the calling system's job; it calls
// `reject` with a typed reason. Invariants (balanced ledger, no negative stock, ledger
// matches inventory) are the coordinator's job, checked on every commit. An invariant
// violation is a bug, not a gameplay outcome, so commit throws InvariantViolationError
// and the original state is untouched.

import type { RejectionReason } from "./commands.ts";
import type { EventMeta, GameEvent } from "./events.ts";
import type { CommandId, EventId, TransactionId } from "./ids.ts";
import type { LedgerAccount, LedgerEntry, TransactionKind } from "./ledger.ts";
import type { Money } from "./money.ts";
import type { GameState } from "./state.ts";
import type { Tick } from "./time.ts";

export interface TransactionCoordinator {
  /**
   * Starts staging a transaction against `state`. Returns `duplicate` if a transaction
   * with the same idempotency key was already committed: the caller treats that as
   * success and does nothing (GDD §7, FIN-001: nothing settles twice).
   */
  begin(state: GameState, request: TransactionRequest): TransactionDraft | DuplicateTransaction;
}

export interface TransactionRequest {
  readonly kind: TransactionKind;
  /** Build with `idempotencyKey()`. One key per real-world operation. */
  readonly idempotencyKey: string;
  /** The tick the operation happens on. Stamped on the transaction and its events. */
  readonly tick: Tick;
  readonly causedBy: CommandId | null;
}

export interface DuplicateTransaction {
  readonly status: "duplicate";
  /** The transaction that already applied this operation. */
  readonly transactionId: TransactionId;
}

/** A pure function from state to new state. Must not mutate its input or read anything else. */
export type StateChange = (state: GameState) => GameState;

/** An event as a system emits it. The coordinator fills in `id`, `tick`, and `causedBy`. */
export type GameEventInput = GameEvent extends infer E ? (E extends GameEvent ? Omit<E, keyof EventMeta> : never) : never;

export interface TransactionDraft {
  readonly status: "staging" | "rejected";
  /** Assigned at begin, so staged events can reference it. Only consumed if committed. */
  readonly transactionId: TransactionId;
  readonly request: TransactionRequest;
  /** The state with everything staged so far applied. Read it to make later decisions in the same transaction. */
  readonly state: GameState;

  /** Stages a change to any part of state. */
  update(change: StateChange): void;
  /** Stages ledger entries. They must balance by commit time, across all `post` calls. */
  post(entries: readonly LedgerEntry[]): void;
  /** Stages an event and returns the ID it will have if the transaction commits. */
  emit(event: GameEventInput): EventId;
  /** Abandons the transaction with a typed reason. Later staging calls are ignored, and commit returns it. */
  reject(reason: RejectionReason): void;
  /** Checks invariants against the staged state without committing. For tests and debugging. */
  validate(): readonly InvariantViolation[];
  /**
   * Applies everything or nothing. Returns the new state, or the rejection.
   * Throws InvariantViolationError if staged changes break an invariant.
   * A draft can be committed once.
   */
  commit(): CommitResult;
}

export type CommitResult =
  | {
      readonly status: "committed";
      readonly state: GameState;
      readonly transactionId: TransactionId;
      readonly eventIds: readonly EventId[];
    }
  | { readonly status: "rejected"; readonly reason: RejectionReason };

// ---------------------------------------------------------------------------
// Invariants (checked on every commit)
// ---------------------------------------------------------------------------

export type InvariantViolation =
  /** Debits ≠ credits for the transaction. */
  | { readonly code: "LEDGER_UNBALANCED"; readonly debits: Money; readonly credits: Money }
  | { readonly code: "LEDGER_SINGLE_ENTRY" }
  | { readonly code: "NEGATIVE_ENTRY_AMOUNT"; readonly account: LedgerAccount }
  /** Cash never goes negative (FIN-001). */
  | { readonly code: "NEGATIVE_CASH"; readonly cash: Money }
  /** A pool, supplier stock, buyer budget, or demand below zero. */
  | { readonly code: "NEGATIVE_QUANTITY"; readonly where: string; readonly value: number }
  | { readonly code: "NEGATIVE_AMOUNT"; readonly where: string; readonly value: Money }
  /** An empty pool with leftover cost, or cost without quantity (FIN-001). */
  | { readonly code: "COST_WITHOUT_QUANTITY"; readonly where: string; readonly cost: Money }
  /** More reserved than the pool holds. */
  | { readonly code: "OVER_RESERVED"; readonly where: string; readonly reserved: number; readonly available: number }
  /**
   * An inventory account's ledger balance doesn't equal the inventory it represents:
   * RAW_MATERIALS = material pools, FINISHED_GOODS = product pools,
   * GOODS_IN_TRANSIT = cost of cargo on outbound deliveries.
   */
  | { readonly code: "LEDGER_INVENTORY_MISMATCH"; readonly account: LedgerAccount; readonly ledger: Money; readonly inventory: Money }
  /** Assets ≠ liabilities + equity (including current-period profit). */
  | { readonly code: "BALANCE_SHEET_MISMATCH"; readonly assets: Money; readonly liabilitiesAndEquity: Money }
  | { readonly code: "REPUTATION_OUT_OF_RANGE"; readonly reputation: number };

export class InvariantViolationError extends Error {
  override readonly name = "InvariantViolationError";
  readonly violations: readonly InvariantViolation[];

  constructor(transactionId: TransactionId, violations: readonly InvariantViolation[]) {
    super(`Transaction ${transactionId} violates invariants: ${violations.map((v) => v.code).join(", ")}`);
    this.violations = violations;
  }
}

// ---------------------------------------------------------------------------
// Idempotency keys
// ---------------------------------------------------------------------------

/**
 * Builds the idempotency key for one real-world operation from its domain identity:
 * `idempotencyKey("SALE", deliveryId)` → "SALE:delivery-3",
 * `idempotencyKey("INSTALLMENT_SETTLEMENT", contractId, 1)` → "INSTALLMENT_SETTLEMENT:contract-2:1",
 * `idempotencyKey("DAILY_SETTLEMENT", dayIndex)` → "DAILY_SETTLEMENT:4".
 * Never include anything that differs between a first attempt and a retry (like a transaction ID).
 */
export function idempotencyKey(kind: TransactionKind, ...parts: readonly (string | number)[]): string {
  if (parts.length === 0) throw new TypeError(`idempotencyKey(${kind}) needs at least one identifying part`);
  for (const part of parts) {
    if (typeof part === "number" ? !Number.isSafeInteger(part) : part.length === 0 || part.includes(":")) {
      throw new TypeError(`Invalid idempotency key part for ${kind}: ${JSON.stringify(part)}`);
    }
  }
  return [kind, ...parts].join(":");
}
