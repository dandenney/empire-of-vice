# 0013: reservation release rules

Status: accepted (decided by the orchestrator while refreshing T02a, issue #5; implemented in T02a)

## Context

GDD §14.8 leaves open what happens to reserved goods when the thing holding them doesn't go to plan: a production job fails, a contract delivery fails, or the player changes their mind. The contracts already constrain the answer:

- `ReservationState` names a `facilityId`, and the coordinator's `OVER_RESERVED` invariant checks reservations against facility pools.
- `ReservationHolder` is either a `CONTRACT` or a `PRODUCTION_JOB`.
- `RESERVATION_RELEASED.reason` is one of `PLAYER`, `CONTRACT_ENDED`, `PRODUCTION_FAILED`, `DELIVERY_FAILED`, `CONSUMED` (ADR 0010, 2026-11-04 amendment).
- `ProductionFailedEvent.writtenOff` and the `PRODUCTION_WRITE_OFF` transaction kind exist for failed production.
- `RELEASE_RESERVATION` is the player's command, and `RESERVATION_NOT_ACTIVE` its rejection.

## Decision

1. **Reservations only cover goods in a facility pool.** Once goods are loaded on a truck they're no longer reserved. "Reserved" always means "sitting in a pool, spoken for".
2. **Player release** (`RELEASE_RESERVATION`): only `CONTRACT`-held reservations. The goods stay in the pool and are available at once. A missing reservation, or one held by a `PRODUCTION_JOB`, is rejected with `RESERVATION_NOT_ACTIVE`: a job's inputs are committed to the still, and M001 has no job cancellation. The handler judges the reservation alone; it doesn't require the contract to exist. Releasing has no immediate contract effect; the installment may later settle as partial or missed (T02e). The release is a `RESERVATION` transaction with no ledger entries, keyed `idempotencyKey("RESERVATION", reservationId, "RELEASE")`, emitting `RESERVATION_RELEASED { reason: "PLAYER" }`.
3. **Production completes:** each reservation's goods are removed at weighted-average cost and the reservation is reported with `CONSUMED`, in the job's `PRODUCTION` transaction.
4. **Production fails:** the inputs are lost, not returned. Each reservation's goods are removed at weighted-average cost, the reservation is reported with `PRODUCTION_FAILED`, and the total removed cost is the `writtenOff` amount booked to `LOSSES` in a `PRODUCTION_WRITE_OFF` transaction. Inventory provides the removal (`consumeReservations`, which returns the cost); T02c decides when jobs fail and books the transaction.
5. **Contract delivery dispatched:** cargo is drawn from that contract's reservations on the pool first (in ID order), then from unreserved stock, never from another holder's reservation (`takeForContract`). The player can over-deliver from free stock (partial fulfilment is allowed, GDD §7). A reservation drawn to 0 is removed and reported with `CONSUMED`; a partly drawn one keeps its ID with a smaller quantity.
6. **Delivery fails** (seized, or the deal falls through, ADR 0005): there's no reservation left to release (rule 1). Seized cargo is written off by its caller. Cargo that comes back to a facility goes into its pool **unreserved**; the contracts system may re-reserve it in the same transaction if the contract is still active (T02e's call).
7. **Contract ends** (its last installment settles): any remaining reservations are removed and reported with `CONTRACT_ENDED`, in that settlement transaction (`releaseContractReservations`, called by T02e).
8. **Every removal of a reservation from state is reported** by one `RESERVATION_RELEASED` in the same transaction (ADR 0010 amendment). The inventory helpers are pure and return the removed IDs; the caller emits the events through its draft.

Removal for a sale or a transfer (`takeProduct`, `takeMaterial`) takes unreserved stock only, so a contract's reservation can't be sold twice.

## Alternatives considered

- **Failed production returns its inputs** (no loss). Rejected: a failure with no cost isn't a risk, and FIN-001 wants losses recorded explicitly.
- **Failed production consumes a share proportional to the time run.** Rejected: a new rounding rule and a time dependency for little gameplay gain.
- **Returned contract cargo is re-reserved automatically**, or **the reservation stays attached to the delivery** until it completes. The first hides a contract decision inside inventory (is the contract still active?); the second needs a new `ReservationHolder` kind, a contract change.
- **The player may release any reservation.** Rejected: releasing a job's inputs is a job cancellation, which M001 doesn't have.

## Consequences

- `RESERVATION_RELEASED { reason: "DELIVERY_FAILED" }` is never emitted under the M001 rules. It's a candidate for removal in a later contract change; until then nothing emits it.
- `RESERVATION_NOT_ACTIVE` covers both "no such reservation" and "not yours to release" (job-held). A distinct code would need a contract change; the current one is close enough for M001's UI.
- T02c, T02e, and T03 call the inventory helpers and emit the events; they don't remove reservations by hand.

#### Amendment, 2026-11-05 (ADR 0017, issue #7): a failed job's write-off includes its conversion cost

This replaces rule 4's last clause, the write-off amount. The rest of rule 4 is unchanged: the inputs are consumed at weighted-average cost and reported with `PRODUCTION_FAILED`. A failed job is also charged its labor and overhead, as a completed one would be, and the whole amount is written off to `LOSSES`. `ProductionFailedEvent.writtenOff` is therefore materials plus conversion: the `LOSSES` debit of the `PRODUCTION_WRITE_OFF` transaction.
