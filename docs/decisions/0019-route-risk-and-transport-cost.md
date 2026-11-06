# 0019: Route risk, disruption, and transport cost

Status: accepted (decided by the orchestrator while refreshing T03, issue #10; implemented in T03)

## Context

GDD §10 asks for one understandable strategic disruption in M001, such as a risky route, and GDD §4 action 8 has the player respond to it. T03's acceptance criteria ask for a seeded disruption (a delay or cargo loss) that gives the player a recoverable choice: the safer route costs more or takes longer. GDD §14.6 leaves route capacity, duration, transport cost, and disruption probability open. ADR 0005 says a deal falls through if the truck is too late or the cargo is seized.

Main constrains the design:

- `RouteDefinition` already has `durationTicks`, `transportCost`, and `riskPpm`. `VehicleState.trip.delayed` and `DeliveryState.dealDeadline` exist. So do the events (`DELIVERY_DELAYED`, `DEAL_FELL_THROUGH { TOO_LATE | CARGO_LOST }`, `CARGO_LOST`, `ROUTE_CLOSED`, `ROUTE_REOPENED`), the `routes` RNG stream, and `releaseDeal` (T02d) and `cargoLossEntries` / `returnFromTransitEntries` (T02b). **No contract type change is needed.**
- The ECO-001 locked test (`test/economy/market/eco-001.locked.test.ts`) dispatches a sale on the default route and asserts that cash moves by exactly the revenue between dispatch and arrival, and that the delivery completes the same day. So transport cost can't be charged at dispatch, and the default routes must not be disrupted.
- `DISPATCH_DELIVERY` with `routeId: null` takes the first route listed between two places (`resolveRoute`).
- ADR 0018 decision 12: T02e owns the contract paths in `logistics.ts` and runs first.

## Decision

1. **Routes and capacity (GDD §14.6)**, all PLACEHOLDER tuning for T07a.
   - **Default routes.** The first route listed to each buyer is the default, and it is **safe**: `riskPpm` 0. It keeps today's duration and cost: 120 ticks and $1.50 to the Crossroads, 150 and $2.00 to Kessler's, 300 and $4.00 to Lakeview.
   - **Risky alternatives.** Each buyer gets a second, **risky** route: ⅔ of the duration and cost (80 ticks and $1.00, 100 and $1.35, 200 and $2.65), with `riskPpm` 150 000.
   - **The choice.** The safe route is slower and dearer; the risky one is faster and cheaper but can fail. The player opts in through `routeId`.
   - **Names.** Route names and waypoints are placeholders (story is the human's, factory.md §8). Mark them PLACEHOLDER.
   - **Capacity** is per vehicle: the one truck carries 20 cases a trip. Routes have no capacity of their own in M001.
2. **Transport cost.** One charge per round trip, paid **when the truck gets home**, in its `VEHICLE_RETURN` transaction.
   - **Posting.** `payOrAccrueEntries({ amount: transportCost, expense: "TRANSPORT_EXPENSE", payable: "WAGES_PAYABLE", cashAvailable: cashBalance })`. The driver is paid on return. A shortfall accrues, and the nightly payroll pays it down (ADR 0017).
   - **Dispatch check.** Dispatch is rejected with `INSUFFICIENT_FUNDS { required: transportCost, available: cash }` when cash is below the cost. This check runs last, after every existing check, so the existing rejection order is unchanged.
   - **Cash flow (ADR 0015).** `VEHICLE_RETURN`'s kind default in `projection/finance.ts` becomes `TRANSPORT`, so a partly accrued charge still files under `TRANSPORT`.
   - **Doc comment.** The comment on `VEHICLE_RETURN` in `packages/contracts/src/ledger.ts` ("Moves no money") is updated to say it carries the trip's transport cost and any returned cargo. It's a doc-comment-only edit, which T03 owns.
3. **Disruption.** Only trips on a route with `riskPpm > 0` can be disrupted, and only once per trip.
   - **When.** At the tick the outbound leg is due, in the vehicles phase (vehicle ID order), for a trip with `delayed = false`.
   - **First draw.** `a = nextInt(rng.routes, 1 000 000)`. The trip is disrupted if `a < riskPpm`.
   - **Second draw.** Only if disrupted: `b = nextInt(rng.routes, 1 000 000)`. The cargo is **seized** if `b < seizureSharePpm` (333 334), otherwise the trip is **delayed**.
   - **No draws at 0.** A route with `riskPpm` 0 draws nothing.
   - **Data.** `seizureSharePpm` and `delayTicks` live in `game-data/src/routes.ts`.
   - **Delayed.**
     - `arrivesAt += delayTicks` (240), and `delayed = true`.
     - It emits `DELIVERY_DELAYED`, in a no-entry `DISPATCH` transaction keyed `DISPATCH:<deliveryId>:DELAY`.
     - When the truck arrives, the normal arrival rules apply (decision 4).
   - **Seized.** One `CARGO_LOSS` transaction, keyed `CARGO_LOSS:<deliveryId>`:
     - `cargoLossEntries(cost)` posts the write-off.
     - It emits `CARGO_LOST`, and the delivery is `FAILED`.
     - For a `SALE`, `releaseDeal` runs and `DEAL_FELL_THROUGH { CARGO_LOST }` is emitted in the same transaction.
     - The truck heads home empty on the return leg.
4. **Deal deadline.**
   - **Setting it.** A `SALE` dispatch sets `dealDeadline = arrivesAt + dealGraceTicks` (120, PLACEHOLDER).
   - **Too late.** If a sale arrives with `tick > dealDeadline`, the deal falls through. A no-entry `DISPATCH` transaction keyed `DISPATCH:<deliveryId>:FELL_THROUGH` runs `releaseDeal`, emits `DEAL_FELL_THROUGH { TOO_LATE }`, and sets the delivery to `FAILED`. The truck turns home with its cargo.
   - **Returned cargo.** At home, the cargo goes back into the home pool **unreserved** (ADR 0013 rule 6) at its cost, with `returnFromTransitEntries`. That happens in the same `VEHICLE_RETURN` transaction as the transport charge, and `VEHICLE_RETURNED.returnedCargo` lists it.
   - **Placeholder numbers.** With a 240-tick delay and 120 ticks of grace, a delayed sale always falls through. The risk is a wasted trip, not lost goods.
   - **Contract deliveries.** These have no deal deadline. A delayed one still delivers, though it may miss an installment deadline (ADR 0018 decision 6).
5. **Route closures.**
   - **Closing.** The `ROUTE_CLOSURE` handler sets the route's `closure { reason, reopensAt }`, with `reopensAt = tick + durationTicks`, or `null` when there's no duration. It emits `ROUTE_CLOSED` and schedules `ROUTE_REOPENING` when the closure has a duration.
   - **Reopening.** `ROUTE_REOPENING` clears the closure and emits `ROUTE_REOPENED`.
   - **Transactions.** Each is a no-entry `DAILY_SETTLEMENT` keyed `DAILY_SETTLEMENT:ROUTE_CLOSURE:<routeId>:<tick>` or `DAILY_SETTLEMENT:ROUTE_REOPENING:<routeId>:<tick>`, as for shortages (ADR 0016).
   - **Trips in flight** are unaffected. Dispatch onto a closed route is already rejected (`ROUTE_CLOSED`).
   - **Scheduling** closures is the scenario's job (T05, "1 simple disruption source").
6. **Cargo stays single-line in M001.** Spot deals and contracts are each for one product, so cargo with more than one line is still rejected with `INVALID_QUANTITY`. Mixed loads are post-M001.
7. **Transfers and the warehouse** are split out into their own task, T03b. That covers the warehouse facility, routes between owned facilities, `TRANSFER` dispatch and arrival, and the destination storage check. T03 keeps rejecting `TRANSFER` as today.
8. **Posting builders.** The dispatch, sale, loss, and return paths post through T02b's builders.
9. **No impairment transaction kind.** Seized cargo is written off under `CARGO_LOSS` (#6 decision 5). M001 needs nothing more.

## Alternatives considered

- **Charge transport at dispatch.** This is the natural moment, but the ECO-001 locked test pins the cash change from dispatch to arrival at exactly the revenue. Paying the driver on return is just as easy to explain, and it needs no locked-test fix round.
- **Make the default routes risky** (today's data gives them 3–8%). Then locked tests and the Sprint Zero path would depend on the seeded draws. Making the player opt into risk is also a clearer decision to offer (GDD §10, "understandable").
- **Draw the disruption at dispatch.** The outcome would have to be stored on the trip (only `delayed` exists), which is a contract change. Drawing at the arrival tick needs no new state, and it's deterministic.
- **Delay only, with no seizure.** Then the GDD's "cargo loss" never happens, and the loss accounting goes untested.

## Consequences

- No contract type change; the one contracts edit is a doc comment.
- **Sprint Zero hash.** If the Sprint Zero path runs to the truck's return, its hash moves, because `VEHICLE_RETURN` now carries entries. T03 updates the pins it owns and explains the move, as T02d did.
- T04b (map) and T04c (panels) can show each route's risk, cost, and duration from the existing route snapshot.
- T05 schedules closures. T07a/T07 tune the numbers.
