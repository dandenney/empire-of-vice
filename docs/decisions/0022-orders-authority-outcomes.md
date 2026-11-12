# 0022: Orders, authority and outcomes

Status: accepted (decided by the orchestrator for M002 task D2, issue #169; implemented by the contract task it names, SK1, and E1–E3)

Amends: ADR 0005 (deals struck at dispatch), ADR 0017 (when conversion cost is paid), ADR 0019 (route randomness), ADR 0020 decisions 10–11 (recovery selling, repeating a sale), ADR 0021 decision 6 (production's cash-posting row).

## Context

GDD §19 (ORD-001): under M001, a command is checked against the true world and accepted or rejected immediately with a reason. With local knowledge (ADR 0021) that leaks: "Buyer will only take 10" tells the founder something they had no way to know. ORD-001 splits a command into an **order**, checked against what the founder knows or can see, and an **outcome**, which happens in the world later and reaches the founder through a channel. It also names four gates that are modelled separately: **knowledge**, **authority**, **communication** and **presence**.

ADR 0021 (decision 9) requires the dynamic half of the non-leak property for `PlayerCommandResult`s. That is only possible if a command's immediate result depends on nothing the founder can't see. The #169 follow-ups (from the ADR 0021 reviews) add five more requirements:

1. Production's conversion cost is paid in cash when a job settles, so a finished batch is known from anywhere. That contradicts GDD §17, and this ADR must fix it.
2. Away-from-founder cash postings are a lever if playtests want more fog.
3. The shared `routes` RNG stream couples hidden trucks to the founder's trip.
4. Tier gating relies on ADR 0021 decision 4.
5. The dynamic non-leak property needs the order/outcome split.

ADR 0023 (D3) owns the founder's state (`GameState.founder`, with whereabouts `PRESENT` / `TRAVELLING` / `ON_DELIVERY` / `RESTING`), what "present" means, travel, how a command takes time (the founder is `busy` until the activity's duration has passed), place hours, the founder as the starting driver, and rest. It also names the rejection reasons for its own commands (`TRAVEL`, `REST`, `WAKE`). This ADR cites those, and names the reasons for every other command.

## Decision

### 1. Every command passes four gates, in a fixed order

For each command, the gates are checked in this order, and the first failure is the rejection:

1. **Shape, scheduling and identity:** `INVALID_QUANTITY`, `SCHEDULED_IN_PAST`, and resolving every ID the command names **through the issuer's view** (decision 2). At this gate, IDs resolve against the founder's agreements and **known records**. Checks that need the live view (an offer still on the table, a reservation still active) run in gate 5, after the hours gate. So a closed buyer gives `PLACE_CLOSED`, not `OFFER_UNAVAILABLE`.
2. **Presence:** does the issuer have to be physically at a place for this, and are they free to act there? (Decision 3. This gate also covers ADR 0023's busy and opening-hours rules.)
3. **Communication:** if the issuer isn't the one who carries it out, can the instruction reach whoever does? (Decision 4.)
4. **Authority:** may this issuer make this decision? (Decision 5.)
5. **Validity against what the issuer can see:** stock, prices, capacity, funds. (Decision 2.)

Each gate's rejection depends only on data in the issuer's view, so it's safe to show (decision 2).

### 2. Orders are validated against the issuer's view; outcomes happen in the world

**The rule.** The immediate result of a founder command (applied, queued, or rejected with a reason) is a function of the **player view only**. The player view is exactly the inputs ADR 0021 builds the player snapshot from: knowledge, the always-known state, and the live view. No immediate rejection may read a world value outside the live view.

**Identity goes through the view too.** Simulation-created IDs (offers, reservations, deals, contracts, commands) are resolved only through the view:

- the founder's own agreements and commands (issuer `FOUNDER`)
- the live view (or, during a call, what ADR 0021's visibility table grants that call)
- known records that list the ID

An ID the view doesn't hold gets the same rejection whatever the world holds. Each command's "not found" reason (`OFFER_UNAVAILABLE`, `RESERVATION_NOT_ACTIVE`, `DEAL_UNAVAILABLE`, `UNKNOWN_ENTITY`) is returned for "not in the view" and "gone from the world" alike, and the presence target is never derived from a world lookup.

**Calls are narrower than visits.** An order given on a phone call (ADR 0024) is validated only against the subjects `KNOWLEDGE_VISIBILITY` grants that source, never against the whole place. Example: a phone call doesn't reveal `BUYER_BUDGET`, so nothing in a by-phone `AGREE_DEAL` may read the budget (decision 6).

**Outcomes.** Anything a command sets in motion that depends on a world value outside the view is resolved later, in the world, as an **outcome**: its own atomic transaction (architecture rule 6 still holds for each), reported through channels (ADR 0021 decision 6). A command never fails halfway because the world differed from what was known. Either the order is rejected from the view, or it's applied and its later outcome reflects the world.

**Why most M001 checks survive.** Every command now needs presence at the place it acts on (decision 3). There the live view *is* the world (ADR 0021 decision 5), so M001's checks of that place are already checks against the view. What changes is the handful of checks that reach **another** place: a buyer at the far end of a sale, a contract's progress, a route outside the live view, a remote reservation.

**The apply step may write to places out of view**, such as a purchase into a facility's stock or contract reservations wherever stock is (ADR 0018). The requirement is narrower: no **rejection** may read them, and the **activity item** a command writes (ADR 0021 decision 8) contains only the command's inputs and values from the view. `ACCEPT_CONTRACT`'s activity says the contract was accepted, not how many cases were reserved.

**Implementation shape.** Validators take an **`IssuerView`** interface, never `GameState`. It has two implementations:

- **`PlayerView`**, for the founder: knowledge, the always-known state, and the live view.
- **`EmployeeView`**, for an employee: the world at the employee's place (decision 5).

With ADR 0023's founder-rules flag off (the lab's M001 mode), `PlayerView` is built with the whole world as its live view. That keeps a single validation path rather than adding a second one. A test-only `assertViewMatchesWorld` confirms that, for each applied command, every value a validator read from the view equals the world value.

**Queued commands** (a future `scheduledTick`) are validated again when they apply, against the issuer's view at that tick. A rejection then is reported by `COMMAND_REJECTED` into the founder's activity. The founder issued the command, so its fate is theirs to know, and the reason comes from the view.

### 3. Presence: what each command needs

"Present at P" for commands is ADR 0023's definition: whereabouts `PRESENT` at P (busy or not). Riding a delivery to a buyer is observation only. The founder sees the settlement as it happens (ADR 0023's `ON_DELIVERY.atBuyer`), but can't issue commands there until they're `PRESENT`. Every command below is presence-gated for the founder. An employee acting within authority is present where they're stationed (decision 5).

| Command | Founder must be present at | What moves out of the immediate result (decision 2) | Outcome |
|---|---|---|---|
| `PURCHASE_MATERIALS` | The supplier, open (ADR 0023 hours) | Nothing: the supplier is the live view, and M001 doesn't check material storage. The supplier delivers the goods into the named facility's raw stock, as in M001. The founder carries only the purse (ADR 0023). It's the founder's own transaction, so it's known. The facility's `FACILITY_STOCK` record updates on the next visit | Immediate |
| `START_PRODUCTION` | The facility | Nothing | Job completes or fails later (ADR 0017), plus decision 7's prepaid cost |
| `DISPATCH_DELIVERY` | The facility where the truck is parked, not busy, as its driver (`driver: DriverRef`, ADR 0023 decision 5). The dispatch origin is that facility. A hired Driver can drive instead (ADR 0025) | Buyer checks for on-spec sales; contract progress checks (judged on knowledge, decision 6); route condition outside the live view | Arrival (decision 6) |
| `ACCEPT_CONTRACT` | The buyer, open, or a call with them (ADR 0024). The offer must be in that view; otherwise `OFFER_UNAVAILABLE` | Nothing: acceptance reserves stock where it finds it but is never rejected for stock (ADR 0018 decision 4). By phone, `CONTRACT_OFFERS` and `STANDING` cover `OFFER_UNAVAILABLE`, `LOCKED` and `REPUTATION_TOO_LOW` | Remote reservations, unseen until visited |
| `PURCHASE_EQUIPMENT`, `SELL_EQUIPMENT` | The facility | Nothing. Tier gating reads the world, which agrees with known `STANDING` whenever the founder is present (ADR 0021 decision 4) | Immediate |
| `SET_WORKFORCE` | The facility | Nothing | Immediate |
| `RELEASE_RESERVATION` | The facility it names (the command gains `facilityId`). The reservation must be active **in that facility's live view**; otherwise `RESERVATION_NOT_ACTIVE`, whether or not it exists elsewhere | Nothing | Immediate |
| `REPEAT_OPERATION` | Whatever the repeated command needs. The source must be a command issued by the `FOUNDER`; otherwise `NOT_REPEATABLE` | As for that command | As for that command |
| `AGREE_DEAL` (new, decision 6) | The buyer, open, or a call with them (ADR 0024) | By phone: anything that needs the budget | A held deal |

The presence gate's rejections reveal nothing, because the founder's whereabouts, place hours and the founder's own place are always known (ADR 0021 decision 3, ADR 0023):

- **`NOT_PRESENT { requiredLocationId, issuerLocationId | null }`**: not at the place (travelling, riding or resting count as not present).
- **`FOUNDER_BUSY { until }`**: a timed activity is still running (ADR 0023 decision 4). Instant actions at the same place are still allowed.
- **`PLACE_CLOSED { locationId, opensAt }`**: an activity with a party (buying, negotiating, accepting) must start during their hours (ADR 0023). Working at your own facility isn't hours-gated.
- **`VEHICLE_NOT_AT { vehicleId, locationId }`**: the truck isn't parked in the live view of the place the founder is dispatching from. `locationId` is **that place**, never the truck's. The same reason covers a truck on a trip and one parked elsewhere, so it reveals no `VEHICLE_WHEREABOUTS`. M001's `VEHICLE_UNAVAILABLE` remains only in flag-off mode, where the whole world is the live view.
- **`NO_DRIVER { vehicleId }`**: the named driver can't drive (not the founder present there, and not a hired Driver stationed there), or a new dispatch has `driver: null` while founder rules are on. `null` is only for pre-M002 dispatches (ADR 0023).

Tiredness never causes a rejection (ADR 0023: it only stretches durations).

**A presence check moves a world check into the live view; it doesn't remove it.** `INSUFFICIENT_STOCK`, `STORAGE_CAPACITY_EXCEEDED`, `SUPPLIER_STOCK_LOW` and the rest keep their meaning, now always about a place the founder can see.

**Time costs.** `AGREE_DEAL` in person is a timed activity: ADR 0023's `ACTIVITY_DURATIONS` row `AGREE_DEAL` (game-data, PLACEHOLDER 30 game minutes). By phone, it takes the call's duration (ADR 0024).

### 4. Communication

An order that someone other than the issuer must carry out has to **reach** them:

- **In person:** the issuer is present where the person is.
- **By phone:** the issuer is at a phone, the person is at a phone, and the call connects (ADR 0024).
- **By standing order:** already given, so nothing has to travel again (decision 5).

If there's no way to reach them, the command is rejected with **`NO_WAY_TO_REACH { characterId }`**. That uses only always-known facts: where the founder is, which places have phones (geography, ADR 0024), and where the employee is stationed (an agreement). Whether a call is **answered** is an outcome, not a rejection (ADR 0024), because it depends on the other end.

Before phones exist (SK1, PT1), the founder is the only person who carries anything out, so this gate is always "present in person". It becomes real with C1 (#179) and E1–E3.

### 5. Authority

- **The founder** has all authority over the family's operations.
- **Employees** act only through **standing orders** (ADR 0025 defines their shapes). A standing order is an authority grant: the command types an employee may issue, where (their station), and limits (a weekly spending cap, a maximum quantity).
- **Command envelopes gain an issuer:** `issuer: { kind: "FOUNDER" } | { kind: "EMPLOYEE"; characterId: CharacterId; standingOrderId: StandingOrderId }`. Player commands are always `FOUNDER`. Employee commands come from the simulation's policy step (ADR 0025) and go through the same gateway and gates (GDD §9 and §19), with these differences:
  - presence is checked against the employee's station, not the founder's;
  - validation uses the `EmployeeView` (decision 2): the employee sees their own place. The results reach the founder only through reports (ADR 0021 `REPORT` source), so no player-visible result depends on them;
  - authority (gate 4) is checked against the standing order. A failure is **`OUTSIDE_AUTHORITY { characterId, standingOrderId, limit }`**, recorded in the employee's report, not shown immediately.
- **A standing order can never do what the founder couldn't have ordered.** Every employee command must also pass the founder's version of gates 1 and 5 for that place. This is a test: for each employee command applied, the same command issued by a founder present at that place would also apply.
- **Standing orders act without a call per action** (GDD §19). Communication gates only *new* instructions: giving, changing or cancelling a standing order needs presence or a call, like any other order to that person.
- **Spending.** Employees spend from the family purse, so their spending is a cash posting and known (ADR 0021 decision 3). What it was *for* is known only as far as the posting reveals its cause (ADR 0021 decision 6, plus the employee rows ADR 0025 adds).
- The contract task adds the `FOUNDER` issuer variant only. `EMPLOYEE` and `StandingOrderId` come with ADR 0025's task.

### 6. Sales and deliveries

ADR 0005 struck a sale's deal at dispatch: quantity and price fixed, buyer demand committed, cash on delivery. That checked a buyer who is usually somewhere else. M002 keeps ADR 0005's core (cash on delivery, the run is the risky part) and splits it by whether a deal was agreed beforehand.

**Held deals.** A new `AGREE_DEAL { buyerId, productId, quality, quantity, agreedUnitPrice }` creates one:

```ts
interface HeldDealState {
  readonly id: DealId;
  readonly buyerId: BuyerId;
  readonly productId: ProductId;
  readonly quality: QualityTier;           // the cargo quality agreed, matched to the buyer's want
  readonly quantity: number;
  readonly unitPrice: Money;
  readonly agreedAt: Tick;
  readonly expiresAt: Tick;                // agreedAt + DEAL_HOLD_TICKS
  readonly budgetCommitted: boolean;       // false for a by-phone deal (below)
  readonly status: "HELD" | "DISPATCHED" | "SETTLED" | "EXPIRED" | "FELL_THROUGH";
  readonly deliveryId: DeliveryId | null;  // set when a dispatch uses it
}
```

`GameState.heldDeals: readonly HeldDealState[]` is sorted with `compareIds`, and `counters.nextId` gains `Deal` (prefix `deal`). It holds only `HELD` and `DISPATCHED` deals. A deal is removed when it reaches a terminal state (`SETTLED`, `EXPIRED`, `FELL_THROUGH`), and that state is reported by its event, the way `ReservationState` keeps active reservations only.

**What's known about a deal.** A `HELD` deal is an agreement the founder made, so it's always known, and so is its expiry by time (`DEAL_EXPIRED`). **Once dispatched, a deal is resolved only by its delivery**, as in M001. What happens to it after dispatch (settled, fell through, or turned back) reaches the founder only through that delivery's channels: being aboard, the cash posting on arrival or return, or news (ADR 0021). A dispatched deal never expires by time.

- **In person:** validated against the live view with ADR 0005's checks (`QUOTE_CHANGED`, `BUYER_WILL_TAKE_LESS`, `PRODUCT_NOT_WANTED`, and `quoteDeal`'s `REPUTATION_TOO_LOW` and `UNKNOWN_ENTITY`). It commits demand **and budget**.
- **By phone (ADR 0024):** the call reveals `BUYER_WANTS` but not `BUYER_BUDGET` (ADR 0021). So it's capped by **demand only** (`BUYER_WILL_TAKE_LESS.acceptable = demandRemaining`), and commits demand only (`budgetCommitted: false`). The budget is settled on arrival: the buyer pays for what the budget allows at the deal price, and the rest of the deal's cargo comes home (as on spec, below).
- **Buyer commitments are re-keyed to the deal.** `BuyerState.commitments[]` moves from `deliveryId` to `dealId`, and stores the matched want quality, so `settleDeal` and `releaseDeal` no longer read delivery cargo. A held deal that crosses midnight keeps its commitment (outstanding commitments already survive `refreshBuyers`). **`DEAL_EXPIRED`** releases it under the existing daily caps. It's emitted at `expiresAt` **only for a deal still `HELD`** (decision 6, "What's known about a deal").

**Dispatching a sale.** `DeliveryPurpose` `SALE` becomes `{ kind: "SALE"; buyerId: BuyerId; dealId: DealId | null }`. `agreedUnitPrice` moves onto the deal.

- **With a deal:**
  - The deal must be `HELD`, or the result is `DEAL_UNAVAILABLE`. Its `buyerId` must match, and the cargo must match its product, quality and quantity; otherwise the result is `CARGO_DOES_NOT_MATCH_DEAL { dealId }`.
  - The deal becomes `DISPATCHED`, and the delivery's `dealDeadline` is set as in M001 (ADR 0019 decision 4), **capped at the deal's `expiresAt`**: `min(expiresAt, scheduled arrival + dealGraceTicks)`. So a delayed sale still falls through exactly as in M001 (the logistics locked tests' `TOO_LATE` case is unchanged), and with founder rules off the deal path reproduces M001's economics.
  - On time, it settles at the deal price as in M001 (`SALE_COMPLETED`) and becomes `SETTLED`.
  - Late, it falls through (`TOO_LATE`), the commitment is released, and the cargo comes home.
  - A by-phone deal settles budget-limited. The cases the budget doesn't cover come home on the `FAILED` path, their committed demand is released under the daily caps, and `SPEC_SALE_SETTLED` reports `offered` vs `accepted`.
  - **On-spec dispatches have no deal deadline** (`dealDeadline: null`): whenever the truck arrives, the buyer takes what they want.
- **On spec (`dealId: null`):** nothing is checked against the buyer at dispatch. On arrival, at any hour (ADR 0023), the buyer's take is computed from the world at that moment:
  - `accepted = 0` if the product, minimum quality or `minimumReputation` doesn't match the buyer's wants.
  - Otherwise, `accepted = min(cargo, demandRemaining, floor(budgetRemaining / quote))` at **that day's quote**: the ECO-001 liquidity formula, applied on arrival.
- **What arrival does, following the transfer precedent (`arriveForTransfer`):**
  - If `accepted > 0`: one `SALE` transaction for the accepted cases. COGS for that part is split with `allocateRemovalCost`. It emits `SALE_COMPLETED`, so progression's first qualifying delivery, victory, and the recovery policy work as before.
  - If a remainder is left: the delivery's `cargo` becomes the remainder, and its status is `FAILED`. So the existing `returnHome` path unloads it, and ADR 0020 decision 10's "no goods" test counts it as goods riding home, not gone.
  - If everything sold: status `DELIVERED`.
  - It always emits **`SPEC_SALE_SETTLED { deliveryId, buyerId, offered, accepted, unitPrice }`**. If `accepted = 0`, it also emits `DEAL_FELL_THROUGH { reason: "NOT_WANTED" }`, in a `DISPATCH` transaction keyed `DISPATCH:<deliveryId>:SPEC_SETTLED`, with no entries, the way `fallThrough` uses `DISPATCH:<id>:FELL_THROUGH`. **No reputation change** for a 0 take in M002 (`PRODUCT_REJECTED` stays unused; revisit after PT1).
- **Contract installments** check `CONTRACT_NOT_ACTIVE` and the installment cap (ADR 0018 decision 5, checks 1 and 4) against **known `CONTRACT_PROGRESS`**, plus the founder's own known in-transit cases (the same rule as ADR 0021 decision 8's `inTransit`). They never read the world's progress. On arrival:
  - extra cases above the requirement are paid as ADR 0018 decision 6 already pays them;
  - if the contract has completed in the meantime, the cargo comes home through the `FAILED` path, with `DEAL_FELL_THROUGH { reason: "CONTRACT_CLOSED" }`.
- **`TRANSFER` dispatches** are unchanged.
- **Route condition at dispatch.** `ROUTE_CLOSED` is rejected immediately only if the route is in the live view (ADR 0021 `LIVE_VIEW_ROUTES`; by default every route out of the founder's place), or is known closed. Then `reopensAt` comes from the record, not the world. Otherwise the truck sets out, and a closure is found as an outcome:
  - **`ROUTE_FOUND_CLOSED { deliveryId, routeId }`** turns the truck back on the return leg, and the trip reveals the route's condition. That matches ADR 0023's halting rule for the founder's own travel.
  - A road that closes **while the truck is being loaded** (between dispatch and ADR 0023's departure at `busy.until`) gives the same event at departure. The truck doesn't leave, and the founder stays `PRESENT`.
    - The cargo is unloaded back into the facility with `returnFromTransitEntries`, and cargo drawn from contract reservations comes back unreserved (ADR 0013 decision 6).
    - A deal-backed delivery's deal returns to `HELD` here. The founder is present and sees it, so nothing leaks.
    - This case **can** happen on a run the founder drives.
  - A **deal-backed** delivery turned back by a closure found on the road resolves like a fall-through. The deal ends `FELL_THROUGH` (reason `ROUTE_CLOSED`), its commitment is released, and the founder learns it through the delivery's channels (N1: a dispatched deal never quietly returns to `HELD`). An on-spec cargo just comes home.
  - With the default table, a closure **at dispatch time** can't go unseen on a run the founder drives. It can on a hired Driver's runs (ADR 0025), or if game-data narrows the table.
- **Which comes first in play.** Early on the founder drives every load, so on spec is the natural first path: drive to Kessler's, and he takes what he wants at today's price. A held deal (agreed at a stop, or later by phone) removes that risk. That's GDD §16's "the order of the day matters".

**Repeating a sale (amends ADR 0020 decision 11).** A repeated `SALE` dispatch always goes **on spec** (`dealId: null`), whatever its source. A deal is single-use, and on spec needs no quote, so repeating no longer reads a remote buyer's current price.

**Recovery selling (amends ADR 0020 decision 10).** With founder rules on, the recovery policy sells on spec. With them off (the lab's M001 mode), it issues `AGREE_DEAL` at the quote and then a deal dispatch. That's M001's economics, so the nightly numbers stay comparable.

### 7. Production's conversion cost is paid when the job starts

Today a job pays its conversion cost (`laborPerCase` + `overheadPerCase`, ADR 0017) from cash when it settles, so a finished or failed batch is a cash posting and known from anywhere (ADR 0021, Consequences). That contradicts GDD §17. Options:

- **(a) Pay at start (chosen).** `START_PRODUCTION` needs the founder present (decision 3), so the cash is paid where they can see it.
- (b) Accrue at settlement to a payable and pay it in person: it keeps settlement off cash too, but adds a per-facility payable and a payment chore with no decision in it (GDD §18: time and clicks are for meaningful activity).
- (c) Leave it and accept the leak: it contradicts the GDD.

**The postings:**

- **Start:** one transaction, `PRODUCTION_START:<jobId>` (new kind `PRODUCTION_START`), replacing today's entry-less `RESERVATION:<jobId>` transaction. It carries the input reservations, as that one did, plus Dr `PRODUCTION_IN_PROGRESS` / Cr `CASH` for the conversion cost. A recipe with zero conversion cost posts the reservations with no entries (the coordinator rejects 0-amount entries).
- **Completion:** Dr `FINISHED_GOODS`; Cr `RAW_MATERIALS` (the reserved inputs); Cr `PRODUCTION_IN_PROGRESS` (the prepaid amount).
- **Failure:** Dr `LOSSES`; Cr `RAW_MATERIALS`; Cr `PRODUCTION_IN_PROGRESS`. That's ADR 0017's write-off, with the cash leg replaced.
- **New asset account `PRODUCTION_IN_PROGRESS`.** Net worth doesn't change at start: it's a prepaid cost, not an expense. `BalanceSheet.assets` gains `productionInProgress`, and the player's known net worth (ADR 0021 decision 8) counts it **from the known books** (the start is known by rule 1; the completion is pending until learned). So starting a batch doesn't look like a drop, and known net worth stays consistent with stale `FACILITY_STOCK`.
- **Cash flow (ADR 0015).** `PRODUCTION_START`'s kind default is **`WAGES`**, consistent with ADR 0015's rule that production's capitalized conversion cost files under `WAGES`.
- **Each job stores what it prepaid:** `ProductionJobState.conversionPrepaid: Money | null`. Completion and failure credit exactly that amount, so a recipe-cost change mid-job leaves no residue. `null` means a job migrated from a pre-M002 save, which settles under the old pay-at-settlement rule. A new invariant: the `PRODUCTION_IN_PROGRESS` balance equals the sum of `conversionPrepaid` over running jobs.
- Completion and failure now move no cash (except for migrated `null` jobs). They become non-cash postings under ADR 0021 decision 7's production row, learned on the next visit. ADR 0021 decision 6's production cash-posting row applies only to migrated jobs.

**Funds and soft-locks.** `START_PRODUCTION` already rejects with `INSUFFICIENT_FUNDS` when cash is below the conversion cost (`production/jobs.ts`), and ADR 0020 decision 10 already counts conversion in its restart cost. So the check now guards a real payment. The restart analysis is unchanged, and no new soft-lock arises: prepaying only makes midnight wages accrue sooner.

**Throughput doesn't change,** and neither do job timing or failure odds (ADR 0023 decides `startedAt` under busy time).

### 8. Other ADR 0021 follow-ups

- **Away-from-founder cash postings stay cash postings in M002** (installment penalties, transport cost on return, the shakedown). Moving them to payables is a tuning lever for after PT1 (#175).
- **Per-trip route randomness.** A trip's route draws come from a stream seeded by an integer mix (no transcendental math) of **the game seed, the vehicle ID's stable hash, and a per-vehicle trip ordinal** (`VehicleState.tripCount`, incremented at each dispatch). Hidden activity can't change any of these for the founder's truck. The master `routes` stream is no longer drawn for trips. It stays for scheduled world events such as closures. This moves the Sprint Zero hash and is owned by SK1.
- **Tier gating** relies on ADR 0021 decision 4 (presence refreshes `STANDING`). Decision 3 makes equipment purchases presence-gated, so the argument holds.

### 9. Rejection reasons, and how outcomes reach the founder

**Rejection reasons:**
- **New:** `NOT_PRESENT`, `FOUNDER_BUSY`, `PLACE_CLOSED`, `VEHICLE_NOT_AT`, `NO_DRIVER` (decision 3); `NO_WAY_TO_REACH`, `OUTSIDE_AUTHORITY` (decisions 4–5); `CARGO_DOES_NOT_MATCH_DEAL`, `DEAL_UNAVAILABLE { dealId }` (decision 6). ADR 0023 (decision 3a) owns the reasons for `TRAVEL`, `REST` and `WAKE`. Codes both ADRs use (`NOT_PRESENT`, `FOUNDER_BUSY`, `PLACE_CLOSED`, `VEHICLE_NOT_AT`, `NO_DRIVER`) are added by whichever contract task lands first.
- **Moved to `AGREE_DEAL` only:** `QUOTE_CHANGED`, `BUYER_WILL_TAKE_LESS`, `PRODUCT_NOT_WANTED`, plus `REPUTATION_TOO_LOW` and `UNKNOWN_ENTITY` for the buyer. Installment dispatch keeps `BUYER_WILL_TAKE_LESS`, judged on knowledge (decision 6).
- **Now limited to the live view or known state:** `ROUTE_CLOSED`, `CONTRACT_NOT_ACTIVE`, `RESERVATION_NOT_ACTIVE`, `OFFER_UNAVAILABLE`.
- **Flag-off only:** `VEHICLE_UNAVAILABLE`.
- **Unchanged, now always about a place the founder can see:** every stock, capacity, funds and equipment reason.

A test enumerates every `RejectionCode` and, for each command that can produce it, confirms that the validator reads only from the `IssuerView`. The interface makes that a compile-time property too.

**Outcomes and ADR 0021's tables.** Each new producer or event, mapped to ADR 0021 decisions 6–7:

| New producer or event | How the founder learns it |
|---|---|
| `PRODUCTION_START` | Rule 1: the founder's own command |
| `AGREE_DEAL`, `DEAL_AGREED` | Rule 1 (own command); the deal is an agreement |
| `DEAL_EXPIRED` | An agreement's state, so always known; an activity item when it fires |
| On-spec arrival, `accepted > 0` (`SALE`) | Cash posting (decision 6 table row: "sale proceeds on arrival"), revealing `SPEC_SALE_SETTLED` as activity |
| On-spec arrival, `accepted = 0` | No entries at arrival (ADR 0021 rule 4). The cargo is revealed by the `VEHICLE_RETURN` posting (its cash row), or by the books row for `VEHICLE_RETURN` at cash 0 |
| Installment arrival at a closed contract | As above: the `VEHICLE_RETURN` posting |
| `ROUTE_FOUND_CLOSED` | No entries. News at the delivery's origin facility (ADR 0021 decision 7 place tag). The founder learns it directly if aboard |
| Production completion or failure (prepaid) | ADR 0021 decision 7's production row (non-cash), learned on the next visit |
| Production completion or failure (migrated, `conversionPrepaid: null`) | ADR 0021 decision 6's production cash-posting row |

The producer coverage test (ADR 0021 decision 11, K1 #188) includes these rows.

## Consequences

- **This changes M001 behaviour, and all ten `@locked` files under `packages/simulation/test` need re-locking** (factory.md §7.3, two-step). An agent re-locking under this ADR may touch only these files, and only for the listed reason:
  - `economy/fin-001.locked.test.ts`: `BalanceSheet.assets.productionInProgress`; production posting signatures (decision 7)
  - `inventory/fin-001.locked.test.ts`: `RELEASE_RESERVATION.facilityId` (decision 3)
  - `production/prod-001.locked.test.ts`: conversion cost at start; `PRODUCTION_START:<jobId>` replaces `RESERVATION:<jobId>` (decision 7)
  - `production/prod-001-labor.locked.test.ts`: `SALE` purpose shape (decision 6); conversion timing (decision 7)
  - `economy/market/eco-001.locked.test.ts`: deal at dispatch becomes `AGREE_DEAL`; commitments keyed by deal (decision 6)
  - `contracts/eco-001-contracts.locked.test.ts`: `SALE` purpose shape (decision 6)
  - `logistics/logistics.locked.test.ts`: per-trip randomness (decision 8); `SALE` purpose shape; deadline capped by `expiresAt`, with `TOO_LATE` behaviour unchanged (decision 6)
  - `commands/repeat.locked.test.ts`: a repeated sale goes on spec (decision 6)
  - `progression/prog-001-outcome.locked.test.ts`: recovery selling (decision 6)
  - `progression/prog-001-reputation.locked.test.ts`: `SALE` purpose shape (decision 6)

  The contract task and SK1 own the re-locks. M001's scenario stays playable through ADR 0021's migration and ADR 0023's founder placement, and its locked tests are re-locked under the M002 rules rather than kept for both.
- **The lab bots and the sale form.** Removing `agreedUnitPrice` from `SALE` breaks the lab strategies (`tools/economy-lab/src/greedy-spot.ts`, `contract-taker.ts`, `sprint-zero.ts`, `headless-strategy.ts`) and `apps/game/src/panels/market/sale-form.tsx`, whatever the founder-rules flag says. **The contract task for this ADR moves them to `AGREE_DEAL` plus a deal dispatch** at the same quote. With the flag off, that reproduces M001's economics, so nightly results stay comparable. T-LAB (#184) later teaches the bots travel, on spec and fog.
- The ECO-001 liquidity formula moves from dispatch to arrival for on-spec runs, so a run can bring cargo home. That's ADR 0019's return path, already built for failed deals.
- **Phones (ADR 0024) plug in at three points:** by-phone `AGREE_DEAL` and `ACCEPT_CONTRACT`, and the communication gate. **Employees (ADR 0025)** plug in at the issuer field, the `EmployeeView`, and the authority gate.
- A founder who arrives with cargo nobody wanted learns it on the spot: that's the risk GDD §16 asks for, and a held deal is the way to buy it down.

### Contract changes (their own task)

- `commands.ts`:
  - `AGREE_DEAL`;
  - `DeliveryPurpose` `SALE` becomes `{ buyerId; dealId: DealId | null }`;
  - `RELEASE_RESERVATION.facilityId`;
  - the new rejection reasons (decision 9);
  - `CommandEnvelope.issuer`, with the `FOUNDER` variant only (decision 5).
- `ids.ts`: `DealId`, with the dynamic prefix `deal`.
- `state.ts`:
  - `HeldDealState` and `GameState.heldDeals`;
  - buyer commitments re-keyed to `dealId`, with quality;
  - `ProductionJobState.conversionPrepaid: Money | null`;
  - `VehicleState.tripCount`;
  - the `Deal` counter.
- `events.ts`: `DEAL_AGREED`, `DEAL_EXPIRED`, `SPEC_SALE_SETTLED`, `ROUTE_FOUND_CLOSED`, plus the `DEAL_FELL_THROUGH` reasons `NOT_WANTED` and `CONTRACT_CLOSED`.
- `ledger.ts`: the account `PRODUCTION_IN_PROGRESS` (asset), and the kind `PRODUCTION_START`, with cash-flow default `WAGES`.
- `snapshot.ts`: `BalanceSheet.assets.productionInProgress`.
- The `IssuerView` interface (simulation-internal, but named here so the review can check it).
- `schemas.ts`: Zod for all of the above.
- `save.ts`: a schema bump with a migration, reading only the save's own fields:
  - **In-flight M001 `SALE` deliveries:** each buyer commitment becomes a held deal, so the commitment isn't counted twice. The delivery's purpose gets that `dealId`, and its existing `dealDeadline` still governs arrival (decision 6), so a deal migrated past its expiry simply resolves on arrival. The deal's fields:
    - `unitPrice`: the purpose's `agreedUnitPrice`
    - `quantity` and `quality`: from the cargo; the want quality from `matchWant` over the save's own `buyer.wants`
    - `agreedAt`: the outbound trip's `departedAt`
    - `expiresAt`: `dealDeadline`
    - status `DISPATCHED`, and `budgetCommitted: true`
  - **Command envelopes** in `queuedCommands` and `commandLog` get `issuer: { kind: "FOUNDER" }`. `SALE` purposes in them get `dealId: null`. A **queued** M001 sale therefore goes on spec when it applies. That's accepted: it's rare, the founder set it up, and on spec can't lose the cargo. A migrated `commandLog` is kept for debugging only. Replay is supported only for logs recorded under the current schema (ADR 0004 replays from a start state under one ruleset).
  - **Running jobs** get `conversionPrepaid: null`.
  - **Vehicles** get `tripCount: 0`. A trip already in progress keeps its existing draws. Dispatch increments `tripCount` before seeding, so the first M002 trip uses ordinal 1.
  - **`heldDeals`** holds only the migrated deals, and the `Deal` counter continues after them.
- Game-data: `DEAL_HOLD_TICKS` (PLACEHOLDER 2 880 ticks, two game days, longer than any M001 round trip). The `AGREE_DEAL` activity duration is ADR 0023's table.
- Callers: the lab strategies and the sale form, moved to `AGREE_DEAL` (Consequences).

Founder fields and travel commands are ADR 0023's task. Standing-order shapes and the `EMPLOYEE` issuer are ADR 0025's.
