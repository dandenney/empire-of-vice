# 0022: Orders, authority and outcomes

Status: accepted (decided by the orchestrator for M002 task D2, issue #169; implemented by the contract task it names, SK1, and E1–E3)

## Context

GDD §19 (ORD-001): under M001, a command is checked against the true world and accepted or rejected immediately with a reason. With local knowledge (ADR 0021) that leaks: "Buyer will only take 10" tells the founder something they had no way to know. ORD-001 splits a command into an **order**, checked against what the founder knows or can see, and an **outcome**, which happens in the world later and reaches the founder through a channel. It also names four gates that are modelled separately: **knowledge**, **authority**, **communication** and **presence**.

ADR 0021 (decision 9) requires the dynamic half of the non-leak property for `PlayerCommandResult`s. That is only possible if a command's immediate result depends on nothing the founder can't see. The #169 follow-ups (from the ADR 0021 reviews) add five more requirements:

1. Production's conversion cost is paid in cash when a job settles, so a finished batch is known from anywhere. That contradicts GDD §17, and this ADR must fix it.
2. Away-from-founder cash postings are a lever if playtests want more fog.
3. The shared `routes` RNG stream couples hidden trucks to the founder's trip.
4. Tier gating relies on ADR 0021 decision 4.
5. The dynamic non-leak property needs the order/outcome split.

ADR 0023 (D3) owns the founder's state (`GameState.founder`, with whereabouts `PRESENT` / `TRAVELLING` / `ON_DELIVERY` / `RESTING`), what "present" means, travel, how a command takes time (the founder is `busy` until the activity's duration has passed), place hours, the founder as the starting driver, and rest. This ADR cites those and doesn't define them. It names the rejection reasons ADR 0023 left to it.

## Decision

### 1. Every command passes four gates, in a fixed order

For each command, the gates are checked in this order, and the first failure is the rejection:

1. **Shape and scheduling** (as today: `INVALID_QUANTITY`, `SCHEDULED_IN_PAST`, `UNKNOWN_ENTITY` for IDs that don't exist in game-data or the founder's own agreements).
2. **Presence:** does the issuer have to be physically at a place for this, and are they free to act there? (Decision 3 table. This gate also covers ADR 0023's busy and opening-hours rules.)
3. **Communication:** if the issuer isn't the one who carries it out, can the instruction reach whoever does? (Decision 4.)
4. **Authority:** may this issuer make this decision? (Decision 5.)
5. **Validity against what the issuer can see:** stock, prices, capacity, funds. (Decision 2.)

Each gate's rejection reason is new or existing, and each depends only on data the issuer knows. That's what makes the result safe to show (decision 2).

### 2. Orders are validated against the player view; outcomes happen in the world

**The rule.** The immediate result of a founder command (applied, queued, or rejected with a reason) is a function of the **player view only**. The player view is exactly the inputs ADR 0021 builds the player snapshot from: knowledge, the always-known state, and the live view. No immediate rejection may read a world value outside the live view.

**Why this is cheap.** When the founder is present at a place, the live view *is* the world for that place (ADR 0021 decision 5). Every M001 command acts on one place: a supplier, a facility, or a truck at a facility. Once each command requires presence at the place it acts on (decision 3), M001's validation of that place is already validation against the live view. Most M001 rejection logic stays as it is. What changes is the handful of checks that reach **another** place: a buyer at the far end of a sale, a route condition outside the live view, or a contract's remote stock.

**Outcomes.** Anything a command sets in motion that depends on a world value outside the player view is resolved later, in the world, as an **outcome**: its own atomic transaction (architecture rule 6 still holds for each), reported through channels (ADR 0021 decision 6). A command never fails halfway because the world differed from what was known. Either the order is rejected from the view, or it's applied and its later outcome reflects the world.

**Implementation shape.** Command validation takes a `PlayerView` (a read-only facade over knowledge, the always-known state and the live view) instead of `GameState`. The apply step still mutates world state, but for every command in decision 3 it touches only places in the live view, where the view and the world agree, so it can't hit a world-only failure. An `assertViewMatchesWorld` check in tests confirms that for each applied command, everything validation read from the view equals the world value.

**Queued commands** (a future `scheduledTick`) are validated again when they apply, against the issuer's view at that tick. A rejection then is reported by `COMMAND_REJECTED` into the founder's activity (ADR 0021 decision 8). The founder issued the command, so its fate is theirs to know, and the reason comes from the view.

### 3. Presence: what each command needs

"Present at P" is ADR 0023's definition: whereabouts `PRESENT` at P (busy or not), plus the arrival tick of a delivery the founder rides. Under M002, every existing command is **presence-gated** for the founder. An employee acting within authority is present where they work (decision 5).

| Command | Founder must be present at | Checks moved out of the immediate result (decision 2) | Outcome |
|---|---|---|---|
| `PURCHASE_MATERIALS` | The supplier, open (ADR 0023 hours) | None: the supplier is the live view, and M001 doesn't check storage for materials. The goods go straight into the named facility's raw stock, as in M001, delivered by the supplier. The founder carries only the purse (ADR 0023). The purchase is the founder's own transaction, so it's known. The facility's `FACILITY_STOCK` record updates on the next visit | Immediate, as in M001 |
| `START_PRODUCTION` | The facility | None | Job completes or fails later (ADR 0017), plus decision 7's cost move |
| `DISPATCH_DELIVERY` | The facility where the truck is parked, not busy, as its driver (`driverCharacterId`, ADR 0023 decision 5). The founder then rides the whole round trip. A hired Driver can drive instead (ADR 0025) | `QUOTE_CHANGED`, `BUYER_WILL_TAKE_LESS` and `PRODUCT_NOT_WANTED` against a buyer elsewhere; `ROUTE_CLOSED` for a route outside the live view | Arrival at the buyer (decision 6) |
| `ACCEPT_CONTRACT` | The buyer, open (or a phone call with them: ADR 0024) | None: acceptance reserves stock where it finds it but is never rejected for stock (ADR 0018 decision 4), and the reservations show only in `FACILITY_STOCK`, which isn't observed remotely | Remote reservations, unseen until visited |
| `PURCHASE_EQUIPMENT`, `SELL_EQUIPMENT` | The facility | None. Tier gating reads the world, which agrees with known `STANDING` whenever the founder is present (ADR 0021 decision 4) | Immediate |
| `SET_WORKFORCE` | The facility | None | Immediate |
| `RELEASE_RESERVATION` | The facility holding the reservation | None | Immediate |
| `REPEAT_OPERATION` | Whatever the repeated command needs | As for that command | As for that command |
| `AGREE_DEAL` (new, decision 6) | The buyer, open (or a phone call: ADR 0024) | None | A held deal |
| Founder travel and rest (ADR 0023) | Defined there | — | — |

The presence gate's rejections all reveal nothing, because the founder's whereabouts, the hours and their own trucks' parking are always known (ADR 0021 decision 3, ADR 0023):

- **`NOT_PRESENT { requiredLocationId, issuerLocationId | null }`**: not at the place (travelling, riding or resting count as not present).
- **`FOUNDER_BUSY { until }`**: a timed activity is still running (ADR 0023 decision 4). Instant actions at the same place are still allowed.
- **`PLACE_CLOSED { locationId, opensAt }`**: an activity with the party (buying, negotiating, accepting) must start during their hours (ADR 0023). Working at your own facility isn't hours-gated.
- **`VEHICLE_NOT_AT { vehicleId, locationId }`**: the truck isn't parked at the cargo's facility (ADR 0023 decision 5).
- **`NO_DRIVER { vehicleId }`**: the named driver can't drive (not the founder present there, and not a hired Driver stationed there).

Tiredness never causes a rejection (ADR 0023: it only stretches durations).

**A presence check moves a world check into the live view; it doesn't remove it.** `INSUFFICIENT_STOCK`, `STORAGE_CAPACITY_EXCEEDED`, `SUPPLIER_STOCK_LOW` and the rest keep their meaning. They're now always evaluated against a place the founder can see.

### 4. Communication

An order that someone other than the issuer must carry out has to **reach** them:

- **In person:** the issuer is present where the person is.
- **By phone:** the issuer is at a phone, the person is at a phone, and the call connects (ADR 0024).
- **By standing order:** already given, so nothing has to travel again (decision 5).

If there's no way to reach them, the command is rejected with **`NO_WAY_TO_REACH { characterId }`**. That uses only always-known facts: where the founder is, which places have phones (geography, ADR 0024), and where the employee is stationed (an agreement). Whether a call is **answered** is an outcome, not a rejection (ADR 0024), because it depends on the other end.

In M002 before phones (SK1, PT1), the founder is the only person who carries anything out, so the communication gate is always "present in person". It becomes real with C1 (#179) and E1–E3.

### 5. Authority

- **The founder** has all authority over the family's operations.
- **Employees** act only through **standing orders** (ADR 0025 defines their shapes). A standing order is an authority grant: the commands an employee may issue (by command type), where (their station), and limits (for example a weekly spending cap, or a maximum quantity).
- **Command envelopes gain an issuer:** `issuer: { kind: "FOUNDER" } | { kind: "EMPLOYEE"; characterId; standingOrderId }`. Player commands are always `FOUNDER`. Employee commands come from the simulation's policy step (ADR 0025), go through the same gateway (GDD §9 and §19) and the same gates, with these differences:
  - presence is checked against the employee's location, not the founder's;
  - validity (gate 5) is checked against **the world at the employee's place**. The employee can see their own place. Its results reach the founder only through reports (ADR 0021 `REPORT` source), so no player-visible result depends on it;
  - authority (gate 4) is checked against the standing order. A failure is **`OUTSIDE_AUTHORITY { characterId, standingOrderId, limit }`**, recorded in the employee's report, not shown immediately.
- **A standing order can never do what the founder couldn't have ordered.** Every employee command must also pass the founder's version of gates 1 and 5 for that place. This is a test: for each employee command applied, the same command issued by a founder present at that place would also apply.
- **Standing orders act without a call per action** (GDD §19). Communication gates only *new* instructions: giving, changing or cancelling a standing order needs presence or a call, like any other order to that person.
- **Spending.** Employees spend from the family purse, so their spending is a cash posting and known (ADR 0021 decision 3). That's intended: you know money went out, but you know *what for* only to the extent the posting's cause is revealed (ADR 0021 decision 6, the employee row in ADR 0025).

### 6. Sales: deals agreed in person, or runs "on spec"

ADR 0005 struck a sale's deal at dispatch: quantity and price fixed, buyer demand committed, cash on delivery. That checked a buyer who's usually somewhere else. M002 keeps ADR 0005's core (cash on delivery, the run is the risky part, no partial *commitments*) and splits it by whether a deal was agreed:

- **New command `AGREE_DEAL { buyerId, productId, quality, quantity, agreedUnitPrice }`.** It needs presence at the buyer, or a phone call with them (ADR 0024). It's validated against the live view (the buyer is there, or on the line), with ADR 0005's checks: `QUOTE_CHANGED`, `BUYER_WILL_TAKE_LESS`, `PRODUCT_NOT_WANTED`. On success it **commits the buyer's demand and budget**, exactly as ADR 0005's dispatch did, and creates a **held deal** with an expiry (`DEAL_HOLD_TICKS`, game-data). A held deal is an agreement, so it's always known.
- **`DISPATCH_DELIVERY` purpose `SALE` names the deal or not:** `{ kind: "SALE"; buyerId; dealId: DealId | null }`. `agreedUnitPrice` moves onto the deal.
  - **With a deal:** M001 behaviour. The cargo must match the deal (product, quality, quantity) or it's rejected with **`CARGO_DOES_NOT_MATCH_DEAL`**. Payment on arrival at the agreed price. If the truck arrives after the deal's expiry, the deal falls through (ADR 0019's `TOO_LATE` path) and the commitment is released.
  - **On spec (no deal):** nothing is checked against the buyer at dispatch. On arrival the buyer takes `min(cargo, demandRemaining, floor(budgetRemaining / quote))` at **that day's quote**: the ECO-001 liquidity formula, applied when the truck gets there. The rest of the cargo comes home on the return leg (ADR 0019's return path). It emits **`SPEC_SALE_SETTLED { deliveryId, buyerId, offered, accepted, unitPrice }`** and, if `accepted` is 0, `DEAL_FELL_THROUGH { reason: "NOT_WANTED" }`.
- **Which comes first in play.** Early on the founder drives every load, so on spec is the natural first path: drive to Kessler's, he takes what he wants at today's price. A held deal is how a phone (or a stop at the buyer) removes that risk later. That's GDD §16's "the order of the day matters".
- **`CONTRACT_INSTALLMENT` and `TRANSFER` dispatches are unchanged.** They act on agreements and owned places.
- **Route condition at dispatch.** `ROUTE_CLOSED` is rejected immediately only if the route is in the live view (ADR 0021 `LIVE_VIEW_ROUTES`; by default every route out of the founder's place) or is known closed. Otherwise the truck sets out, and a closure is found as an outcome: **`ROUTE_FOUND_CLOSED { deliveryId, routeId }`** turns the truck back on the return leg, and the trip reveals the route's condition (ADR 0021 decision 5, travel). This matches ADR 0023's rule for the founder's own travel (a vehicle halts at a closure the founder can see). With the default table it can't happen for a departure the founder drives, but it can for a hired Driver's runs (ADR 0025), or if game-data narrows the table.
- **Arrivals at any hour.** Deliveries arrive whenever the road gets them there (ADR 0023). On-spec and deal settlement happen on arrival whatever the hour. A founder riding the truck is present for it, so the result is known.

### 7. Production's conversion cost is paid when the job starts

Today a job pays its conversion cost (`laborPerCase` + `overheadPerCase`, ADR 0017) from cash when it settles, so a finished or failed batch is a cash posting and known from anywhere (ADR 0021, Consequences). That contradicts GDD §17. Options:

- **(a) Pay at start (chosen).** `START_PRODUCTION` needs the founder present (decision 3), so the cash is paid where they can see it. The job's conversion cost moves from cash into a new asset account, **`PRODUCTION_IN_PROGRESS`**, when the job starts: Dr `PRODUCTION_IN_PROGRESS`, Cr `CASH`. Net worth doesn't change, because it's a prepaid cost, not an expense. On completion it's capitalized into the goods: Dr `FINISHED_GOODS`, Cr `RAW_MATERIALS` (reserved inputs), Cr `PRODUCTION_IN_PROGRESS`. On failure it's written off: Dr `LOSSES`, Cr `RAW_MATERIALS`, Cr `PRODUCTION_IN_PROGRESS`, as ADR 0017 does today with cash. Neither completion nor failure moves cash any more. They become non-cash postings under ADR 0021 decision 7's production row, learned on the next visit.
- (b) Accrue at settlement to a payable and pay it in person: it keeps settlement off cash too, but adds a per-facility payable to manage and a payment chore with no decision in it (GDD §18: time and clicks are for meaningful activity).
- (c) Leave it and accept the leak: it contradicts the GDD.

**Funds check.** `START_PRODUCTION` is rejected with `INSUFFICIENT_FUNDS` if the purse can't cover the conversion cost. This replaces ADR 0017's "cash first, then `WAGES_PAYABLE`" for conversion. The purse is always known, so nothing leaks. The soft-lock analysis (ADR 0020 decision 10) must be rerun: a founder with materials but less cash than one batch's conversion cost can still sell stock, or start a smaller batch, since conversion cost scales with cases. R1 (#176) covers this in its reachability check.

**Throughput doesn't change**, and neither do job timing or failure odds.

### 8. Other ADR 0021 follow-ups

- **Away-from-founder cash postings stay cash postings in M002** (installment penalties, transport cost on return, the shakedown). Moving them to payables is a tuning lever for after PT1 (#175). If playtests want contract fog to last longer, a later ADR moves installment penalties to `PENALTIES_PAYABLE` until settled in person.
- **Per-trip route randomness.** Each delivery draws its route outcomes from a stream seeded from the `routes` stream state at dispatch plus the delivery's sequence. Hidden trucks then no longer change the draws of the founder's own trip. It's a small determinism change (it moves the Sprint Zero hash) owned by SK1, and it makes the dynamic non-leak test less noisy.
- **Tier gating** relies on ADR 0021 decision 4 (presence refreshes `STANDING`), and decision 3 above makes equipment purchases presence-gated, so the argument holds.

### 9. Rejection reasons: what's new and what changes

- **New:** `NOT_PRESENT`, `FOUNDER_BUSY`, `PLACE_CLOSED`, `VEHICLE_NOT_AT`, `NO_DRIVER` (decision 3); `NO_WAY_TO_REACH`, `OUTSIDE_AUTHORITY`; `CARGO_DOES_NOT_MATCH_DEAL`, `DEAL_UNAVAILABLE { dealId }` (expired or used). This is the list ADR 0023's contract task takes its reasons from.
- **Moved to `AGREE_DEAL` only:** `QUOTE_CHANGED`, `BUYER_WILL_TAKE_LESS`, `PRODUCT_NOT_WANTED`.
- **Now limited to the live view or known state:** `ROUTE_CLOSED` (decision 6).
- **Unchanged, now always about a place the founder can see:** every stock, capacity, funds and equipment reason.

A test enumerates every `RejectionCode` and, for each command that can produce it, confirms it reads only from the `PlayerView` facade (decision 2). The facade type makes that a compile-time property: validators receive a `PlayerView`, which doesn't expose hidden world state.

## Consequences

- **This changes M001 behaviour, and some `@locked` tests will need re-locking** (factory.md §7.3, two-step):
  - ADR 0005's deal-at-dispatch becomes `AGREE_DEAL`, plus deal or on-spec dispatch.
  - ADR 0017's conversion cost moves to job start.
  - Commands become presence-gated.

  The contract task and SK1 own the re-locks. The M001 scenario stays playable through ADR 0021's migration and ADR 0023's founder placement. Its locked tests are re-locked under the M002 rules rather than kept for both.
- The ECO-001 liquidity formula moves from dispatch to arrival for on-spec runs, so a run can bring cargo home. That's ADR 0019's return path, already built for failed deals.
- **The economy lab bots** must issue the founder's travel (ADR 0023) and deal commands to play. T-LAB (#184) owns that. Until then, the lab runs the M001 scenario with ADR 0023's scenario flag turning the founder rules off. With the flag off, the presence gate passes everywhere, and validation reads the world as in M001. The M002 scenario turns the flag on, so this mode never reaches the game.
- **Phones (ADR 0024) plug in at two points:** `AGREE_DEAL` and `ACCEPT_CONTRACT` by call, and the communication gate. **Employees (ADR 0025)** plug in at the issuer field and the authority gate.
- A founder who arrives with cargo nobody wanted learns it on the spot: that's the risk GDD §16 asks for, and a held deal is the way to buy it down.

### Contract changes (their own task)

- `commands.ts`: `AGREE_DEAL`; `DeliveryPurpose` `SALE` becomes `{ buyerId; dealId: DealId | null }`; the new rejection reasons (decision 9); `CommandEnvelope.issuer`.
- `ids.ts`: `DealId` (a dynamic prefix `deal`).
- `state.ts`: held deals (buyer, terms, expiry, status); the per-delivery route stream on `DeliveryState`.
- `events.ts`: `DEAL_AGREED`, `DEAL_EXPIRED`, `SPEC_SALE_SETTLED`, `ROUTE_FOUND_CLOSED`, and `DEAL_FELL_THROUGH` reason `NOT_WANTED`.
- `ledger.ts`: account `PRODUCTION_IN_PROGRESS` (asset), and a `PRODUCTION_START` transaction kind for the prepaid cost.
- The `PlayerView` facade type for validators (simulation-internal, but named here so the review can check it).
- `state.ts` also gets `ProductionJobState.conversionPrepaid: boolean`.
- `schemas.ts`: Zod for all of the above.
- `save.ts`: a schema bump with a migration. Old `SALE` purposes become on spec with no deal. Jobs in progress get `conversionPrepaid: false` and settle under the old pay-at-settlement rule, because a migration can't read game-data to compute the cost (ADR 0009).
- Game-data: `DEAL_HOLD_TICKS`.

Founder fields and travel commands are ADR 0023's task. Standing-order shapes are ADR 0025's.
