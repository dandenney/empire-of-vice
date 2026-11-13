# 0019: Route risk, disruption, and transport cost

Status: accepted (decided by the orchestrator while refreshing T03, issue #10; implemented in T03)

Amended by: ADR 0022 decision 8 (per-trip randomness). Since SK1c-2 (#226, PR #230), decision 3's two draws come from `tripRng(seed, vehicleId, tripCount)`, not `rng.routes`; the master `routes` stream is never drawn for a trip, so the staging described in decision 3 no longer applies to trips.

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
   - **Risky alternatives.** Each buyer gets a second, **risky** route at about ⅔ of the duration and cost, with `riskPpm` 150 000. The figures are ⅔ rounded half up to the tick and the cent, and they ship as **literal data values**, so tests read them from game-data rather than computing ⅔:

     | Buyer | Safe (default) | Risky |
     |---|---|---|
     | Crossroads | 120 ticks, $1.50 | 80 ticks, $1.00 |
     | Kessler's | 150 ticks, $2.00 | 100 ticks, $1.33 |
     | Lakeview | 300 ticks, $4.00 | 200 ticks, $2.67 |
   - **The choice.** The safe route is slower and dearer; the risky one is faster and cheaper but can fail. The player opts in through `routeId`.
   - **Names.** The three new risky routes need names and waypoints. Those are placeholders (story is the human's, factory.md §8), marked PLACEHOLDER, and the real names are a `needs-design` issue (linked from #10).
   - **Per-route tuning fields.** `RouteDefinition` in `game-data/src/routes.ts` (ADR 0012) gains three fields, so fixture `GameData` can force each outcome in tests without touching `game-data/src/index.ts`:
     - `delayTicks`: 240 on every route
     - `seizureSharePpm`: 333 334 on every route
     - `dealGraceTicks`: 120 on every route
     All three are PLACEHOLDER. On a route with `riskPpm` 0, `delayTicks` and `seizureSharePpm` are never read.
   - **Capacity** is per vehicle: the one truck carries 20 cases a trip. Routes have no capacity of their own in M001.
2. **Transport cost.** One charge per round trip, paid **when the truck gets home**, in its `VEHICLE_RETURN` transaction.
   - **Posting.** `payOrAccrueEntries({ amount: transportCost, expense: "TRANSPORT_EXPENSE", payable: "WAGES_PAYABLE", cashAvailable: cashBalance })`. The driver is paid on return. A shortfall accrues, and the nightly payroll pays it down (ADR 0017).
   - **No dispatch funds check.** Dispatch is never rejected for lack of cash. Nightly payroll (ADR 0017 decision 9) can leave cash at exactly 0, and M001 has no asset sales, so a funds check would leave a player with stock but no cash unable to sell: a soft lock (GDD §9). Charging at return already accrues any shortfall. This applies to `SALE` and `CONTRACT_INSTALLMENT` dispatches alike. The existing rejection order is unchanged.
   - **Cash flow (ADR 0015).** `VEHICLE_RETURN`'s kind default in `projection/finance.ts` becomes `TRANSPORT`, so a partly accrued charge still files under `TRANSPORT`. The accrued part is later paid down by payroll and shows up under `WAGES`, like any `WAGES_PAYABLE` paydown. That is accepted for M001: the driver is paid with the payroll.
   - **FIN-001 reference table.** The locked `fin-001.locked.test.ts` `KIND_DEFAULT` table has no `VEHICLE_RETURN` entry. Its property's step sequences dispatch with `routeId: null` to the Crossroads, so the charge is the Crossroads default's $1.50, and they never return a truck with between 1 and 149¢ in cash, so it doesn't throw in practice. If it ever does, that's a locked-test fix round under factory.md §7.3, not a T03 workaround.
   - **Doc comment.** The comment on `VEHICLE_RETURN` in `packages/contracts/src/ledger.ts` ("Moves no money") is updated to say it carries the trip's transport cost and any returned cargo. It's a doc-comment-only edit, which T03 owns.
3. **Disruption.** Only trips on a route with `riskPpm > 0` can be disrupted, and only once per trip.
   - **When.** At the tick the outbound leg is due, in the vehicles phase (vehicle ID order), for a trip with `delayed = false`. The draw runs before the arrival is resolved. A delayed trip doesn't draw again when it finally arrives.
   - **First draw.** `a = nextInt(rng.routes, 1 000 000)`. The trip is disrupted if `a < riskPpm`.
   - **Second draw.** Only if disrupted: `b = nextInt(rng.routes, 1 000 000)`. The cargo is **seized** if `b < seizureSharePpm` (333 334), otherwise the trip is **delayed**.
   - **No draws at 0.** A route with `riskPpm` 0 draws nothing, and commits no `DISPATCH:<id>:CLEAR` transaction. The arrival is resolved directly, as today.
   - **Data.** `seizureSharePpm` and `delayTicks` are per-route `RouteDefinition` fields (decision 1).
   - **Where the draw is committed.** The `rng.routes` advance is staged in the transaction that records the outcome, so it is committed exactly once:
     - **Delayed:** the `DISPATCH:<deliveryId>:DELAY` transaction.
     - **Seized:** the `CARGO_LOSS:<deliveryId>` transaction.
     - **Neither:** a no-entry, no-event `DISPATCH` transaction keyed `DISPATCH:<deliveryId>:CLEAR`, committed just before the arrival transaction on the same tick.
     T03 never stages the advance inside an arrival transaction. So the contract arrival function T02e owns (ADR 0018 decision 12) is called unchanged, and a sale arrival is handled the same way.
   - **Delayed.**
     - `arrivesAt += delayTicks` (240), and `delayed = true`.
     - It emits `DELIVERY_DELAYED`, in a no-entry `DISPATCH` transaction keyed `DISPATCH:<deliveryId>:DELAY`.
     - When the truck arrives, the normal arrival rules apply (decision 4).
   - **Seized.** One `CARGO_LOSS` transaction, keyed `CARGO_LOSS:<deliveryId>`:
     - `cargoLossEntries(cost)` posts the write-off.
     - It emits `CARGO_LOST` with the cargo, and the delivery is `FAILED`.
     - For a `SALE`, `releaseDeal` runs first (ADR 0016) and `DEAL_FELL_THROUGH { CARGO_LOST }` is emitted in the same transaction.
     - Then it sets `delivery.cargo = []`. The cargo is recorded in the `CARGO_LOST` event, not on the delivery.
     - The truck heads home empty on the return leg.
   - **Return leg.** Whenever a truck turns home without completing its delivery (a seizure here, or a deal that falls through in decision 4), the same outcome transaction sets the trip to `leg: "RETURN"`, `departedAt: tick`, `arrivesAt: tick + route.durationTicks`, `delayed: false`. That's the same as `arriveForSale` does after a sale.
   - **What comes home.** The return transaction brings home `delivery.cargo` when `delivery.status` is `FAILED`, and nothing otherwise. A seized delivery has empty cargo, a too-late one still has its cargo, and a delivered one brings nothing. So each case leaves in-transit exactly once.
4. **Deal deadline.**
   - **Setting it.** A `SALE` dispatch sets `dealDeadline = arrivesAt + route.dealGraceTicks` (120, PLACEHOLDER), using the arrival time set at dispatch.
   - **Too late.** If a sale arrives with `tick > dealDeadline`, the deal falls through. A no-entry `DISPATCH` transaction keyed `DISPATCH:<deliveryId>:FELL_THROUGH` runs `releaseDeal`, emits `DEAL_FELL_THROUGH { TOO_LATE }`, and sets the delivery to `FAILED`. The truck turns home with its cargo.
   - **Returned cargo.** At home, the cargo goes back into the home pool **unreserved** (ADR 0013 rule 6) at its cost, with `returnFromTransitEntries`. That happens in the same `VEHICLE_RETURN` transaction as the transport charge, and `VEHICLE_RETURNED.returnedCargo` lists it.
   - **Storage.** Returned cargo **always unloads**, even if that puts the facility over `storageCapacity`. A production start may have used the space while the truck was out. Capacity limits only starts (ADR 0017), and an over-full facility can't start new jobs until it sells down. This answers the returned-cargo storage question that ADR 0017's Consequences left to T03.
   - **Reputation.** A spot deal that falls through (seized or too late) changes no reputation in M001. No `REPUTATION_CHANGED` is emitted. The risk is already the wasted trip or the lost goods. The contracts' `DEAL_FELL_THROUGH` reputation reason stays unused until a later milestone decides otherwise. This settles the T03 half of ADR 0005's "reputation penalty for not showing up".
   - **Placeholder numbers.** With a 240-tick delay and 120 ticks of grace, a delayed sale always falls through. The risk is a wasted trip, not lost goods.
   - **Contract deliveries.** These have no deal deadline. A delayed one still delivers, though it may miss an installment deadline (ADR 0018 decision 6).
5. **Route closures.**
   - **Closing.** The `ROUTE_CLOSURE` handler sets the route's `closure { reason, reopensAt }`, with `reopensAt = tick + durationTicks`, or `null` when there's no duration. It emits `ROUTE_CLOSED` and schedules `ROUTE_REOPENING` when the closure has a duration.
   - **Reopening.** `ROUTE_REOPENING` clears the closure and emits `ROUTE_REOPENED` when `closure !== null && (closure.reopensAt === null || closure.reopensAt === tick)`. Otherwise it is a no-op with no transaction.
     - A closure with no known end (`reopensAt` null, per `RouteClosedEvent.reopensAt`) stays closed until the scenario schedules a `ROUTE_REOPENING` for it, which then always clears it. So no closure is permanent unless the scenario chooses that.
     - A stale reopening from an earlier closure can't end a later closure that has a duration.
   - **Overlapping closures.** A closure on a route that is already closed replaces the current closure. The stale reopening then fails the check above.
   - **Transactions.** Each is a no-entry `DAILY_SETTLEMENT` keyed `DAILY_SETTLEMENT:ROUTE_CLOSURE:<routeId>:<tick>` or `DAILY_SETTLEMENT:ROUTE_REOPENING:<routeId>:<tick>`, as for shortages (ADR 0016). A second closure of the same route on the same tick shares the key, so it's a duplicate and is ignored: the first one wins.
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
- **Reject dispatch when cash is below the transport cost.** That would protect cash, but payroll can leave cash at 0 and M001 has no asset sales, so a player with stock could be soft-locked (GDD §9). Accruing at return can't lock anyone out.
- **Delay only, with no seizure.** Then the GDD's "cargo loss" never happens, and the loss accounting goes untested.

## Consequences

- No contract type change; the one contracts edit is a doc comment.
- **Sprint Zero hash.** It moves for certain, from tick 0. `new-game.ts` builds `state.routes` from `data.routes`, so the three new routes change the starting state. The path also reaches the truck's return (`tools/economy-lab/src/sprint-zero.ts`, "Truck returns"), where `VEHICLE_RETURN` now carries entries. T03 updates the pins it owns and explains both causes, as T02d did.
- **Snapshot test.** `test/projection/snapshot.test.ts` pins the three-route list, so T03 owns that expectation. T02c2 (#63) edits other sections of the same file.
- **Unlocked tests that decision 2 changes.** Charging transport on `VEHICLE_RETURN` breaks these expectations, and T03 owns exactly them:
  - `test/projection/robustness.test.ts`, the `VEHICLE_RETURN` case that expects `cashFlowStatement` to throw when a return moves cash. `VEHICLE_RETURN` now has the `TRANSPORT` default, so the case is dropped or inverted.
  - `test/projection/snapshot.test.ts`, the test "reports a vehicle return as a transaction that moves no money". The return now pays the $1.50 charge on the Sprint Zero path.
  - `test/sprint-zero/path.test.ts`, the `entries: []` assertion on `VEHICLE_RETURN:delivery-1`, and its "no-entry" comment.
- T04b (map) and T04c (panels) can show each route's risk, cost, and duration from the existing route snapshot.
- T05 schedules closures. T07a/T07 tune the numbers.
