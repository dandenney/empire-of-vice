# 0010: The transaction coordinator

Status: proposed (T00b, issue #2)

## Context

Architecture §5: every state change that spans systems goes through one coordinator. Its interface is defined in T00b and implemented in T02b, so inventory (T02a), market (T02d), contracts (T02e), and logistics (T03) can be built in parallel against it. FIN-001 requires atomic economic operations ("if any validation fails, no state change commits") and transaction IDs that prevent duplicate processing. The issue asks for stage, validate, and commit, all-or-nothing, with transaction IDs for idempotency.

## Decision

### Shape (`coordinator.ts`)

```ts
const tx = coordinator.begin(state, { kind, idempotencyKey, tick, causedBy });
if (tx.status === "duplicate") return;    // already applied
tx.update(change);                        // pure (state) => state, staged
tx.post(entries);                         // ledger entries, staged
tx.emit(event);                           // events, staged
tx.reject(reason);                        // or abandon with a typed reason
const result = tx.commit();               // new state, or the rejection
```

- **The coordinator is a function over state, not a holder of state.** `begin` takes the current `GameState` and `commit` returns a new one. The kernel (T01) owns the state reference, and tests drive the coordinator with plain fixtures.
- **Staging is generic:** `update` takes any pure `StateChange`. Systems keep their own logic (weighted-average costing stays in T02a, quotes in T02d) as pure functions, and the coordinator doesn't need a method per system. Its contract stays small and stable while systems are built in parallel.
- **The coordinator owns:** the transaction and event IDs, stamping events with tick and cause, balancing the ledger, idempotency, invariant checks, and atomicity.
- **Reads inside a transaction see staged changes** (`tx.state`), so a multi-step operation can decide later steps from earlier ones.

### Business rules vs invariants

- **Business rules** ("can the player afford it?", "will the buyer take this many?") belong to the calling system. It calls `tx.reject(reason)` with a typed `RejectionReason`, and the player gets an explanation.
- **Invariants** are checked by the coordinator on every commit:
  - the transaction balances, with no single-entry transactions and no negative entry amounts
  - cash never goes negative
  - no negative quantities, budgets, or demand
  - an empty pool has no leftover cost
  - nothing is reserved beyond what a pool holds
  - **each inventory account's ledger balance equals the inventory it represents** (raw materials, finished goods, goods in transit)
  - assets = liabilities + equity
  - reputation stays in 0–100
- **A violated invariant is a bug, not a gameplay outcome**, so `commit` throws `InvariantViolationError` and leaves the original state untouched. Property tests (T02b) drive random operation sequences and assert it never throws. That's FIN-001's "randomized transaction sequences preserve all invariants."

The ledger-vs-inventory check is the important one. Inventory pools and ledger accounts are separate records of the same value, and checking them against each other on every commit catches costing bugs the moment they happen.

### Idempotency

- Every request carries an **idempotency key built from the operation's domain identity**: `SALE:delivery-3`, `INSTALLMENT_SETTLEMENT:contract-2:1`, `DAILY_SETTLEMENT:4`. `idempotencyKey()` builds and validates them.
- **The ledger log doubles as the record of applied operations.** Every commit appends a `LedgerTransaction` with its key, so `begin` with a key that's already in the log returns `duplicate`, and the caller does nothing. Operations that move no money (reserving inventory, a fully fulfilled installment) still append a transaction, with no entries, so they're covered by the same rule.
- The **transaction ID** is assigned at `begin`, so staged events can reference it (`SaleCompletedEvent.transactionId`). The ID counter only advances if the draft commits, because the counter lives in the draft state.
- Because every coordinated operation now produces a transaction, the event fields that allowed `null` for "no transaction" (`INSTALLMENT_SETTLED`, `PRODUCTION_FAILED`) are now required. `LedgerTransaction` carries `eventIds` (plural), since one operation can emit several events. The separate `CONTRACT_PENALTY` kind is gone, because penalties are part of `INSTALLMENT_SETTLEMENT`.

### The engine API (`engine.ts`)

`Simulation` is the public surface for the worker gateway, the lab, and tests:

| Method | Purpose |
|---|---|
| `dispatch(request)` | Apply or queue a command (ADR 0004) |
| `advance(ticks)` | Process that many ticks |
| `snapshot()` | The read-only projection for the UI |
| `serialize()` | A save (ADR 0008) |
| `stateHash()` | Replay and save checks |
| `takeEvents()` | Events since the last call, for publishing and full lab histories |
| `state` | Read-only, for tests and the lab |

Defining it here means T01 and S0b don't each invent one.

## Consequences

- T02b implements the coordinator and its invariant checks, with property tests. Until then, S0a uses a thin stub with the same interface.
- Systems never write the ledger or emit events directly. A reviewer can check this by looking for state changes outside `tx.update`.
- A system that needs a new invariant or transaction kind requests a contract change.

#### Amendment, 2026-11-04 (issue #36, from #32 and #33): a truck's return is a coordinated operation

A vehicle getting home moves no money, and S0a cleared the trip and emitted `VEHICLE_RETURNED` outside the coordinator because no transaction kind fit. That broke the single path above. `VEHICLE_RETURN` is now a `TransactionKind`, and it's another example of an operation that moves no money but still commits through the coordinator:

- The logistics system commits a `VEHICLE_RETURN` transaction with **no ledger entries**, keyed `VEHICLE_RETURN:<deliveryId>`, so a return applies once. The trip is cleared with `tx.update`, and `VEHICLE_RETURNED` is staged with `tx.emit`.
- No system emits events outside the coordinator any more. Only the coordinator, and the kernel for its own command events, write to the event journal.
- The kind is specific rather than a general "state change" kind, so the finance panel's transaction list can say what happened.

In the same change (#33), `RESERVATION_RELEASED.reason` gained `CONSUMED`. A completing production job emits one `RESERVATION_RELEASED { reason: "CONSUMED" }` per reservation it uses up, in its `PRODUCTION` transaction, before `PRODUCTION_COMPLETED`. Removing reservations in state and reporting them as events now always happen together.
