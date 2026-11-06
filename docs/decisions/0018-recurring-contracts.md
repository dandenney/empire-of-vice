# 0018: Recurring contracts

Status: accepted (decided by the orchestrator while refreshing T02e, issue #9; implemented in T02e)

## Context

GDD §7 (ECO-001, "Contracts (M001)") fixes the terms: 3 installments, every 2 game days, 95% of spot when signed, a 20% penalty on missing cases, partial fulfillment allowed, no early cancellation. Funds and inventory are reserved on acceptance, an exact-deadline arrival is on time, settlement is idempotent, and unpaid penalties become a liability. A contract is `completed` only after all three installments settle. GDD §14.5 leaves the first deadline open, and the GDD doesn't say where offers come from, how a delivery is credited to an installment, or when penalties are paid.

Main already constrains the design:

- The contract types exist (`ContractOfferState`, `ContractState`, `ACCEPT_CONTRACT`, `INSTALLMENT_SETTLED`, `CONTRACT_COMPLETED`, the `CONTRACT_OFFER` world event, `INSTALLMENT_SETTLEMENT` and `RESERVATION` kinds), so this ADR needs **no contract change**.
- ADR 0005: a contract is a recurring order on the same path as a spot sale (dispatch, deliver, cash on delivery). Its cargo comes from its reservation.
- ADR 0013 rules 5–7: `takeForContract` draws a contract's reservations first, then unreserved stock; `releaseContractReservations` ends them with `CONTRACT_ENDED`.
- The kernel runs `vehicles`, then `resolution`, then `deadlines` on each tick (registry.ts), so an arrival on the deadline tick is credited before that installment settles.
- ADR 0017 decision 9: production's midnight hook pays wages and `WAGES_PAYABLE`; `PENALTIES_PAYABLE` paydown was left to T02e.
- Midnight hooks run in `SYSTEMS` registration order. Market runs first, so the day's spot prices are set before any later midnight hook reads them.

## Decision

1. **Data** (`packages/game-data/src/contracts.ts`, all PLACEHOLDER tuning for T07a):
   - Shared terms: `installmentCount` 3, `intervalTicks` 2 880 (2 days), `priceRatio` 950 000 ppm, `penaltyRatePpm` 200 000, `firstDeadlineOffsetTicks` 3 960 (see decision 9), and `requiredUnlockId: UnlockId | null`, which is `null` until T05 sets it (the same pattern as equipment's `requiredUnlockId`).
   - Contract buyers, keyed by `BuyerId`: Kessler's back room offers basic moonshine (minimum quality `basic`), 8 cases per installment. The Lakeview Hotel offers standard moonshine (minimum `standard`), 6 cases per installment. The roadhouse offers no contract.
2. **Offers.**
   - **Who gets one.** A contract buyer gets an offer when all of these hold: it has no open offer and no `ACTIVE` contract; `requiredUnlockId` is `null` or in `family.unlocked`; and `family.reputation ≥` the buyer's `minimumReputation`.
   - **When.** The contracts system's midnight hook checks every contract buyer, in ID order. The `CONTRACT_OFFER` world-event handler checks only the buyer it names, using the same rule; if the rule fails, it does nothing. Scheduling those world events is T05's job (scenario); the midnight hook alone keeps offers coming.
   - **Terms.** `unitPrice = applyRatios(spot, [priceRatio])`, where `spot` is the spot price of the `(productId, minimumQuality)` market at that tick. `firstDeadline = start of the offer's day + firstDeadlineOffsetTicks`. `expiresAt` = the next midnight.
   - **Transaction.** A `DAILY_SETTLEMENT` transaction with no entries, keyed `DAILY_SETTLEMENT:CONTRACT_OFFER:<buyerId>:<tick>`, emitting `CONTRACT_OFFERED`.
   - **Expiry.** At midnight, an offer whose `expiresAt ≤ tick` is removed in `DAILY_SETTLEMENT:CONTRACT_OFFER_EXPIRED:<offerId>`, emitting `CONTRACT_OFFER_EXPIRED`.
   - **Price at signing.** Spot prices change only at midnight, and an offer expires at the next one, so the offer's price is the 95%-of-spot price on the day it's signed (GDD §7).
3. **Accepting** (`ACCEPT_CONTRACT`). Checks, in order:
   1. `OFFER_UNAVAILABLE`: no such offer (unknown, expired, or already accepted).
   2. `LOCKED`: `requiredUnlockId` is set and no longer in `family.unlocked`.
   3. `REPUTATION_TOO_LOW`: reputation is below the buyer's minimum.

   On success, one `RESERVATION` transaction with no entries, keyed `RESERVATION:<contractId>:ACCEPT`:
   - removes the offer;
   - creates an `ACTIVE` contract with installment `k` (0-based) due at `firstDeadline + k × intervalTicks`, `required = quantityPerInstallment`, `delivered = 0`;
   - reserves inventory for the first installment (decision 4);
   - emits `CONTRACT_ACCEPTED`.

   **Funds.** GDD §7's "contract funds are reserved" means the buyer's money for the whole contract is committed by the contract itself. Contract deliveries never draw on the buyer's daily `budgetRemaining` or `demandRemaining`, and spot sales can't use it up. The player pays nothing to accept.
4. **Reserving inventory.**
   - **Target.** The current installment's `required − delivered`, minus the cases already reserved for this contract.
   - **Where from.** Unreserved finished stock of the contract's product with quality ≥ the minimum. Facilities are taken in ID order, then lowest quality first.
   - **Shortfalls are allowed.** Reserving less than the target, or nothing, is not a rejection. The player can produce later, and dispatch can also draw unreserved stock.
   - **When it runs.** At acceptance, and again in each non-final `INSTALLMENT_SETTLEMENT`, toward the next installment.
5. **Dispatching an installment** (`DISPATCH_DELIVERY`, purpose `CONTRACT_INSTALLMENT`). After the vehicle and cargo-shape checks logistics already runs, the checks are, in order:
   1. `CONTRACT_NOT_ACTIVE`: the contract is unknown or `COMPLETED`.
   2. `CARGO_DOES_NOT_MATCH_CONTRACT`: the product differs, or the quality is below the minimum.
   3. Route checks to the buyer's location, as for a sale (`NO_ROUTE`, `ROUTE_CLOSED`).
   4. `BUYER_WILL_TAKE_LESS { requested, acceptable }`, where `acceptable` = Σ over unsettled installments of `required − delivered`, minus contract cases already in transit.
   5. `INSUFFICIENT_STOCK`, when the contract's reservations at the home facility plus unreserved stock fall short.

   The cargo is taken with `takeForContract`, so a reservation drawn to 0 is reported `CONSUMED` in the `DISPATCH` transaction. No buyer commitment is made, and `dealDeadline` is `null`.
6. **Arrival.** Cash on delivery (ADR 0005), in a `SALE` transaction keyed `SALE:<deliveryId>`, with `saleEntries` at `unitPrice × cases`. It emits `SALE_COMPLETED { contractId }`.
   - **Crediting.** The cases are credited to unsettled installments whose `deadline ≥ tick`, in index order, filling each up to `required` before moving to the next.
   - **Extra cases.** Cases left over after every unsettled installment is full are still paid for, but credit nothing.
   - **After arrival.** The truck heads home, as after a spot sale.
7. **Settling an installment.**
   - **When.** In the `deadlines` phase, for each `ACTIVE` contract in ID order, each unsettled installment whose `deadline ≤ tick` settles, in index order.
   - **Transaction.** `INSTALLMENT_SETTLEMENT`, keyed `idempotencyKey("INSTALLMENT_SETTLEMENT", contractId, index)`.
   - **Outcome.** `FULFILLED` if `delivered ≥ required`, `PARTIAL` if `0 < delivered < required`, and `MISSED` if nothing was delivered.
   - **Penalty.** `applyRatios(multiplyMoney(unitPrice, missing), [penaltyRatePpm])`, where `missing = max(0, required − delivered)`. It is posted with `payOrAccrueEntries({ amount, expense: "PENALTY_EXPENSE", payable: "PENALTIES_PAYABLE", cashAvailable: cashBalance })`. A 0 penalty posts no entries, but the transaction still commits.
   - **Recorded.** `outcome` and `penalty` are stored on the installment, and `INSTALLMENT_SETTLED` is emitted.
   - **Non-final installment:** reservations are topped up toward the next one (decision 4).
   - **Final installment:** in the same transaction, the status becomes `COMPLETED`, `releaseContractReservations` emits `CONTRACT_ENDED` for what's left, and `CONTRACT_COMPLETED` is emitted.
   - **Exactly once.** An installment with an `outcome` is never settled again. The idempotency key backs this up, including after a save and load.
8. **Paying down penalties.**
   - **When.** The contracts midnight hook runs after production's (registration order), so wages and `WAGES_PAYABLE` are paid first.
   - **Transaction.** It pays `min(PENALTIES_PAYABLE balance, cashBalance)` with `payDownEntries(amount, "PENALTIES_PAYABLE")`, in `DAILY_SETTLEMENT:PENALTIES:<day>`. `<day>` is the day that just ended, as in ADR 0017.
   - **Skipped** when the amount is 0.
   - **No event.** `DAY_SETTLED.liabilitiesPaid` stays wages-only (ADR 0017).

   Each midnight, the hook first expires offers, then pays down penalties, then makes new offers.
9. **First-deadline timing (GDD §14.5).**
   - **Offset.** `firstDeadlineOffsetTicks` = 2 × 1 440 + 1 080. An offer made on day `d` has its installments due at 18:00 on days `d+2`, `d+4`, and `d+6`.
   - **Session fit.** A contract offered by day 5 completes by day 11, inside the 10–15 game-day session.
   - **Why 18:00.** It leaves the day for a round trip (the longest default route is 300 ticks each way) and keeps deadlines off the midnight tick.
   - **Validation.** T07a (#12) validates this; it's tuning.
10. **Reputation.** T02e only emits `INSTALLMENT_SETTLED` (with its outcome) and `CONTRACT_COMPLETED`. T05 applies +5 / −3 / −8 and the consecutive-installment bonus from those events.
11. **Returned contract cargo** (ADR 0013 rule 6).
    - Under ADR 0019, a contract delivery has no deal deadline, so it is never turned back. Seized cargo is written off by logistics, and the installment just settles short.
    - So the question of re-reserving returned cargo doesn't come up in M001.
    - If a later rule sends contract cargo home, it comes back unreserved, and the next top-up (decision 4) may reserve it again.
12. **Ownership of `logistics/logistics.ts` with T03.**
    - **Order.** T02e runs first.
    - **T02e owns:** the `CONTRACT_INSTALLMENT` branch of dispatch planning and staging; a contract arrival function; and the arrival dispatch on `delivery.purpose.kind`.
    - **T03 (#10) owns** the rest of the file. It runs after T02e merges and keeps those contract paths intact.

## Alternatives considered

- **Offers only from scheduled world events (T05).** Rejected: T02e couldn't be tested end to end, and a contract that falls through would leave no way to get another offer.
- **Price fixed at acceptance from the live spot.** This is the same thing here, because offers expire at midnight. Storing the price on the offer lets the panel show it.
- **Rejecting acceptance without enough stock to reserve.** Rejected: the contract would be unusable until the player stockpiles, and GDD §7 allows partial fulfillment.
- **Extra arrivals rejected at the gate.** Over-delivery is already capped at dispatch (decision 5). A late arrival after every installment has settled is still paid, which is simpler than sending the truck home with the cargo.
- **Paying penalties inside the production payroll transaction.** Rejected: production's settlement and `DAY_SETTLED` are T02c2's (ADR 0017), and keeping paydowns separate keeps the cash-flow categories clean (ADR 0015: `PENALTIES_PAYABLE` → `PENALTIES`).

## Consequences

- No contract change. T02e owns `src/contracts/**`, `game-data/src/contracts.ts`, and the listed sections of shared files.
- T04c (#50) renders offers, active contracts, and installments from `ContractsSnapshot`, which T02e's projection fills.
- T05 (#13) applies reputation, sets `requiredUnlockId`, and may schedule `CONTRACT_OFFER` world events.
- T07a (#12) validates the timing and quantities.
