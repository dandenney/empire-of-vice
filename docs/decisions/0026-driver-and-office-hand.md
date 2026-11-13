# 0026: The Driver and the Office Hand

Status: accepted (decided by the orchestrator for M002 task D5b, issue #196; implemented by the contract task it names, E2 #182 and E3 #183)

Amends: ADR 0020 decision 10 (insolvency waits for takings riding home), ADR 0021 decisions 6 and 7 (new producer rows), ADR 0022 decisions 3, 6 and 8 (who may be named as a dispatch's driver, deals handed to a Driver, a road closing while a Driver loads, the installment cap, `tripCount`), ADR 0023 decision 5 (a Driver's dispatch origin), ADR 0024 decisions 3 and 9 (both attendant hooks, which employees a call reaches), ADR 0025 decisions 1, 3, 5, 6, 7, 8 and 10 (two new roles, hiring places, standing-order variants, the policy for a second role, report lines and observations, what `batchesRun` counts, a report delivery in the `founder` phase).

Defers to: ADR 0027 (#213, earned phone access and message-taking, from the human's decision on #203) and ADR 0028 (#214, the hiring scene and employees' hours, from the human's decision on #209). Both are written after this record and amend it. Where this record depends on them, it says so by issue number and doesn't decide the point itself.

## Context

GDD §21 (PERS-001): hiring removes a responsibility, not clicks, and the design test for any role is "what can now happen without the founder there?" The M002 roles table gives two more hires after the Distiller:

| Role | Takes off your hands | Reports | Tradeoff |
|---|---|---|---|
| **Driver** | Making the deliveries you order, and collecting payment | On return, or by phone from the road | Wages; the truck and cargo are in someone else's hands |
| **Office hand** | Answering your phone, taking messages, passing on your orders by phone | Messages waiting when you call in or visit | Wages; only useful once you own a phone |

GDD §18 says the founder starts as the driver and that "hiring a driver breaks this link". GDD §20 says that once you've hired someone to sit by your phone, calls get answered and turned into messages, and the ledger records who took one ("via Ruth, at the office"). GDD §19: a standing order acts without a call per action, communication gates new instructions, and a standing order can never do what the founder couldn't have ordered.

**The play this record is for.** With a Distiller and no Driver, every sale is still a round trip the founder drives: load at the still, ride to the buyer, ride back. With a Driver, the founder hands a load over at the still ("take Kessler's twenty cases") and walks off to the feed store. The Driver loads, drives, collects, and comes home, and the founder finds out how it went from the Driver: at the still, or on a call to the still that an Office Hand answers. (GDD §21's "by phone from the road" waits for the phone-access rules of ADR 0027, #213: decision 9.) With a standing "regular run" ("every morning at eight, ten cases to the Crossroads on spec"), the Driver doesn't even need telling. With a phone line at the still and an Office Hand minding it, the founder can do all of this from a phone in town the founder may use (ADR 0027, #213): hand the Driver a load, hear what the buyers called about, and hear the Driver's report. The cost is wages, a hiring trip, and not knowing what's happening on the road until someone tells you. A poor Driver on the back roads gets into trouble more often (decision 8). The freed hours go where GDD §16 rule 3 wants them: negotiating at more buyers, contracts, and the still.

**Earlier records left these hooks:**

- **ADR 0021** decision 3: "Money earned but not yet in the purse (a payment a hired driver is carrying home, say) isn't cash", leaving its booking to later records. Decision 6 and 7's producer tables need rows for anything that posts without a founder command.
- **ADR 0022** decision 3 names `NO_DRIVER` ("the named driver can't drive: not the founder present there, and not a hired Driver stationed there"). Decision 6: a road that closes while the truck is loaded returns a deal-backed delivery's deal to `HELD`, "because the founder is present and sees it". The #191 follow-up notes that with a hired Driver loading alone, that would leak. Decision 6 also says a closure at dispatch time can go unseen on a hired Driver's run. Decision 8 seeds a trip's route draws from the vehicle's `tripCount`.
- **ADR 0023** decision 5: the dispatch origin is "the facility at the founder's place (later, a hired Driver's station)". `DriverRef = { FOUNDER } | { EMPLOYEE; characterId }` rides on `DISPATCH_DELIVERY.driver` and `DeliveryState.driver`.
- **ADR 0024** decision 9 defines the two attendant hooks, `CallOutAttendant` (reads only the player view, the seed and the tick) and `CallInAttendant` (may read world state; its only output is a held message), and asks this record to fill them and to decide "which employees a call reaches". Decision 4 asks whether an attendant passes news on.
- **ADR 0025** defines employees, hiring, standing orders, the `employees` phase, replay-safe employee commands (no envelope, `causedBy: null`, `EMPLOYEE_ACTED` as the identity), reports (`ReportLine`, `PendingReport`, `ReportContent`), `EMPLOYEE_PERFORMANCE`, `formerEmployees`, and the call-out hook's Distiller case. It leaves the `DRIVER` and `OFFICE_HAND` roles, their `StandingOrderTerms` variants and `ROLE_TERMS` rows, `REPORT` rows for buyers, precedence between a Distiller and an Office Hand at one phone, and the hired-driver deal case to this record.

**What the code has today (verified on `main` at c7ba936).**

- **Contracts.** K1 and P1 have landed. `DriverRef` is in `packages/contracts/src/state.ts`, but `DeliveryState` and `DISPATCH_DELIVERY` don't carry `driver` yet: O1a (#192) adds them, with ADR 0022's `HeldDealState`, `AGREE_DEAL`, the `SALE` purpose `{ buyerId; dealId }` and `VehicleState.tripCount`. O1a's branch so far holds only its re-locked tests, which dispatch with `driver: { kind: "FOUNDER" }` and `dealId`. This record uses ADR 0022 and 0023's shapes wherever `main` still has M001's. ADR 0024's contract task and EM1 (#210, ADR 0025) haven't landed either.
- **Logistics** (`packages/simulation/src/logistics/logistics.ts`). `planDispatch` takes the origin, stock and route from the vehicle's home facility. The `DISPATCH_DELIVERY` handler posts `DISPATCH:<deliveryId>` (Dr `GOODS_IN_TRANSIT` / Cr `FINISHED_GOODS`) with `causedBy: ctx.envelope.id`. In the `vehicles` phase, `resolveOutbound` draws the disruption from the shared `rng.routes` (`drawDisruption`: draw *a* against `riskPpm`, then *b* against `seizureSharePpm`), then `arriveForSale` / `arriveForContract` post `SALE:<deliveryId>` with Dr `CASH` / Cr `SALES_REVENUE` plus COGS (`saleEntries`). `returnHome` posts `VEHICLE_RETURN:<deliveryId>`: transport cost paid from cash or accrued to `WAGES_PAYABLE`, and a `FAILED` delivery's cargo booked back into the home facility. The return leg draws nothing.
- **Ledger** (`packages/contracts/src/ledger.ts`). `RECEIVABLES` is an asset account, "kept for later credit terms; unused in M001 (ADR 0005)". ADR 0015 leaves it without a cash-flow category, so a transaction whose only non-cash account is `RECEIVABLES` files under its kind's default. `projection/finance.ts` already projects `BalanceSheet.assets.receivables`.
- **Knowledge** (`packages/contracts/src/knowledge.ts`). `TRANSACTION_PRODUCERS.SALE` is `WORLD` with legs `["CASH"]`; `DISPATCH` is `FOUNDER_COMMAND` with `["NON_CASH", "NO_ENTRIES"]`. `CASH_POSTING_REVEALS.SALE` reveals `CONTRACT_PROGRESS` and `VEHICLE_WHEREABOUTS`. `transactionProducerOf` resolves a key to the longest registered family of its constant tags. `EVENT_CONCERNS_PLACE` (`events.ts`) tags `DEAL_FELL_THROUGH`, `CARGO_LOST` and `DELIVERY_DELAYED` as `DELIVERY_ORIGIN` news.
- **Game-data.** One truck (Model TT, 20 cases, home `distillery-main` at Hollow Creek). Every buyer has a safe default route from Hollow Creek and a risky back road (`riskPpm` 150 000). `riverside-warehouse` at Riverside Depot is a facility the M001 scenario doesn't own. `LIVE_VIEW_ROUTES` gives every place the routes that start or end there.
- **Kernel.** `PHASES` is `production, vehicles, resolution, founder, deadlines, midnight`; ADR 0024 and 0025 add `phones` and `employees`. `SAVE_SCHEMA_VERSION` is 3.
- **Locked tests.** Ten `@locked` files under `packages/simulation/test`. `economy/fin-001.locked.test.ts` builds a `DeliveryState` literal (lines 1104–1113) and spreads it into `deliveries`, so a new required `DeliveryState` field would break it (decision 7 avoids one). No locked file builds a `HeldDealState`, an employee or a report, and none enumerates producers, phases or rejection codes.

Story and visual items (candidate names, where Drivers and Office Hands are found, report and message wording, the hand-over scene) are **PLACEHOLDER** here and listed under *Needs design*. This record decides the mechanism they plug into.

**The human's later decisions** (#203 on telephones, #209 on hiring) bind this record. Three of them shape it: people sleep, so nobody answers a phone day and night (#209 §5); having a phone, being allowed to use it and taking messages are separate, earned privileges (#203 §1–2); and the hiring scene never shows an unearned exact skill value (#209 §3). The rules that implement the first two are ADR 0028's (#214) and ADR 0027's (#213). This record keys on them (decisions 5, 9 and 10) and doesn't design them.

## Decision

### 1. Two new roles

```ts
// packages/contracts/src/state.ts (amends ADR 0025 decision 1)
export type EmployeeRole = "DISTILLER" | "DRIVER" | "OFFICE_HAND";
```

**Stations** (ADR 0025 decision 4's `STATION_UNSUITABLE` and `POSITION_FILLED` apply unchanged):

- **Driver:** any family facility. It's where they wait for orders, load and come home to. A Driver's dispatches start there (decision 5).
- **Office Hand:** a family facility **with a family phone line** (`FacilityState.phoneLine !== null`, ADR 0024 decision 2). That's what "only useful once you own a phone" means mechanically: you can't hire one without a line to sit by. A line can't be removed in M002, so a station never stops being suitable. Hollow Creek starts with no line, so the Office Hand comes after installing one, which is #203 §5's progression ("Established operation: hire an office worker to answer, take messages, and relay instructions").
- At most one employee per role per station, as for the Distiller. Hollow Creek can have one of each.

**Candidates and terms** (game-data, `packages/game-data/src/personnel.ts`; every value PLACEHOLDER):

```ts
// CANDIDATE_POOL gains (PLACEHOLDER names, needs-design):
{ id: asId("Character", "sal-moretti"),  name: "Sal Moretti",  roles: ["DRIVER"], competence: { min: 30, max: 90 }, reliability: 50, loyalty: 50 },
{ id: asId("Character", "jim-doyle"),    name: "Jim Doyle",    roles: ["DRIVER"], competence: { min: 20, max: 80 }, reliability: 50, loyalty: 50 },
{ id: asId("Character", "frank-kowalski"), name: "Frank Kowalski", roles: ["DRIVER"], competence: { min: 40, max: 70 }, reliability: 50, loyalty: 50 },
{ id: asId("Character", "ruth-ellison"), name: "Ruth Ellison", roles: ["OFFICE_HAND"], competence: { min: 50, max: 50 }, reliability: 50, loyalty: 50 }, // inert, never shown
{ id: asId("Character", "ada-pruitt"),   name: "Ada Pruitt",   roles: ["OFFICE_HAND"], competence: { min: 50, max: 50 }, reliability: 50, loyalty: 50 }, // inert, never shown

// ROLE_TERMS gains:
DRIVER: {
  dailyWage: { min: cents(250), max: cents(500) },   // PLACEHOLDER (R1, T-LAB)
  signingCost: cents(1_500),                          // PLACEHOLDER
  slateSize: 2,
  estimateSpread: 30,
  reportingDelayTicks: 120,                           // PLACEHOLDER: out to the station
},
OFFICE_HAND: {
  dailyWage: { min: cents(200), max: cents(200) },   // PLACEHOLDER
  signingCost: cents(1_000),                          // PLACEHOLDER
  slateSize: 2,
  estimateSpread: null,                               // no estimate shown: competence is inert for this role (decision 10)
  reportingDelayTicks: 120,
},

// HIRING_PLACES (PLACEHOLDER, story):
{ locationId: MILLERS_FEED_LOCATION, roles: ["DISTILLER", "OFFICE_HAND"] },  // word of mouth at the general store
{ locationId: RIVERSIDE_DEPOT, roles: ["DRIVER"] },                         // PLACEHOLDER
```

ADR 0025's load validation already covers these: every role has a hiring place, and each role's pool holds at least `slateSize` people. Putting the Driver at the depot makes the second hire a trip the founder plans for (GDD §16: the order of the day matters). The depot is always open and is on a route from Hollow Creek.

The names are PLACEHOLDER. #209 approved Walt Hagen, Eddie Novak, Mae Brennan, Gus Lindqvist and Otto Krause as M002 candidates, as names only, with no invented histories. ADR 0028 (#214) places them. This record gives the new roles no story beyond a name.

**No estimate for a role whose competence is inert** (amends ADR 0025 decisions 1 and 3). #209 §3 rules out showing an unearned exact skill value, and a spread of 0 would show one for every Office Hand. So:

```ts
// packages/game-data/src/personnel.ts (amends ADR 0025's RoleTerms)
/** null: the role shows no competence estimate (its competence is inert). Otherwise 0–100. */
readonly estimateSpread: number | null;

// packages/contracts: EmployeeState, PlayerEmployee and PlayerCandidate (amends ADR 0025)
readonly competenceEstimate: CompetenceEstimate | null;
```

For a role with `estimateSpread: null`, the slate draws no estimate, `competenceEstimate` is `null` on the candidate and the employee, and the asking wage is `dailyWage.min`. True competence is still drawn by ADR 0025's keyed draw, and nothing reads it. The hiring scene shows no competence line for that role: no band and no range. `OFFICE_HAND` is the only such role in M002. Roles with an estimate keep ADR 0025's range, and ADR 0028 (#214) decides how it's presented (#209's bands, labelled *Estimate*). A `null` comes from game-data and the role, both always known, so it leaks nothing.

### 2. Who drives, and who may be named as the driver

- **A hired Driver drives only on their own orders**: run orders the founder gives them (decision 3) and the regular run in their standing order (decision 4). Both reach the world as a `DISPATCH_DELIVERY` the Driver issues through the gateway, with issuer `{ kind: "EMPLOYEE", characterId, standingOrderId }` and `driver: { kind: "EMPLOYEE", characterId }` (decision 5).
- **A founder-issued `DISPATCH_DELIVERY` must name `driver: { kind: "FOUNDER" }`** (or `null` only where ADR 0023 decision 10 still allows it, with the flag off). Naming an employee is `NO_DRIVER { vehicleId }` (amends ADR 0022 decision 3's "not a hired Driver stationed there"). The founder hands a load to a Driver with `ORDER_RUN`, never by naming them on a dispatch. That keeps one path for the Driver's work, and it means a founder's dispatch is always loaded and ridden by the founder, exactly as SK1a builds it.
- The founder never rides a Driver's run. `ON_DELIVERY` is only ever the founder's own run. Riding along is out of scope for M002, as staying behind at a buyer is (ADR 0023 decision 5).

### 3. Run orders: telling the Driver what to carry

GDD §21: the Driver makes "the deliveries you order". A run order is a one-off instruction, given in person or passed on by phone, that the Driver carries out when they can.

**Options considered:**

- **(a) The founder dispatches with an employee driver, and it applies at once.** Rejected: whether the Driver and truck are at the station is hidden while the founder is away, so the result of a by-phone dispatch would depend on it. And a call answered by someone at the still can't make a Driver who's on the road load a truck that isn't there.
- **(b) The Driver carries every deal the founder agrees, automatically.** Rejected: a deal agreed at Kessler's is a new instruction, and nothing carries it to the still. It breaks GDD §19's communication gate and takes the point out of phones.
- **(c) A queue of run orders on the Driver, given through the communication gate and carried out when the Driver is at the station with the truck (chosen).**

**Shapes:**

```ts
// packages/contracts/src/ids.ts: a new dynamic ID kind
export type RunOrderId = Id<"RunOrder">;   // DYNAMIC_ID_PREFIXES.RunOrder = "run"

// packages/contracts/src/state.ts
/** What to carry: DISPATCH_DELIVERY's fields without the vehicle and driver. */
export interface RunOrderTerms {
  /** Exactly one line, as DISPATCH_DELIVERY requires. */
  readonly cargo: readonly CargoLine[];
  /** ADR 0022's purposes: SALE { buyerId, dealId | null }, CONTRACT_INSTALLMENT, TRANSFER. */
  readonly purpose: DeliveryPurpose;
  readonly routeId: RouteId | null;
}

/** A run order the founder gave. An agreement: always known (ADR 0021 decision 3). */
export interface RunOrderState {
  readonly id: RunOrderId;
  readonly givenAt: Tick;
  /** If the Driver hasn't set out with it by this tick, it lapses (below). */
  readonly expiresAt: Tick;
  readonly terms: RunOrderTerms;
}

export interface EmployeeState {
  // ADR 0025's fields, plus:
  /**
   * Run orders given to this Driver that the founder hasn't yet been told have ended,
   * in the order given (givenAt, then id). Always empty for other roles.
   */
  readonly runOrders: readonly RunOrderState[];
}

// packages/contracts/src/commands.ts
export interface OrderRunCommand {
  readonly type: "ORDER_RUN";
  readonly characterId: CharacterId;
  readonly terms: RunOrderTerms;
}
```

**Giving one.** `ORDER_RUN` reaches the Driver through decision 10's `Reach`: in person at the Driver's station, or on a call to the station answered by an Office Hand there. Whether the Driver is at the station doesn't matter: an order left at the still waits for them, which keeps `Reach` a function of always-known state.

- **Time.** In person it's **instant**: a word with the Driver, or a note left for them. ADR 0023 lets instant commands through while the founder is busy at that place. Loading is the Driver's time, not the founder's. On a call it takes the call's time and passes the busy gate, as ADR 0024 decision 4 does for every order on a call. This differs on purpose from ADR 0025's in-person `SET_STANDING_ORDER` and `DISMISS_EMPLOYEE`, which take `BRIEF_EMPLOYEE` (15 minutes): those change the standing arrangement and need a talk, while a run order names one load within it.
- **Effects,** in one transaction keyed `idempotencyKey("PERSONNEL", "RUN", commandId)` with no entries: a `RunOrderState` is appended, with `id` from the `RunOrder` counter, `givenAt = t`, and `expiresAt` = the deal's `expiresAt` for a deal-backed sale, otherwise `t + RUN_ORDER_HOLD_TICKS` (game-data, PLACEHOLDER 2 880: two days). A deal-backed run hands the deal over (below). Emits `RUN_ORDERED { characterId, runOrderId, terms, transactionId }`.
- **Validation** (decision 15 has the reasons) reads only the founder's view: agreements (the employee, their standing order, run orders, held deals, contract terms), known `CONTRACT_PROGRESS`, known or viewed route conditions, and geography. It doesn't check stock at the station. A Driver who finds the cases aren't there yet waits and says so (decision 5), so the founder can order a run for cases the Distiller is still making.
- **At most `RUN_ORDER_LIMIT` run orders per Driver** (game-data, PLACEHOLDER 3), counted over `runOrders`. Past it, `RUN_ORDERS_FULL`.
- A Driver must have a standing order of kind `DRIVE` (decision 4) to take run orders, because it names the truck. Otherwise `NO_STANDING_ORDER`.

**When the founder learns a run ended.** `runOrders` is an agreement list, so it can't shrink when the world finishes a run: that would leak. A run order leaves `runOrders` only when a report **tells the founder** it ended (decision 9's `endedRuns`). So the founder always sees "run orders given, not yet heard back on". That's also what `RUN_ORDER_LIMIT` counts: a founder who never hears back can't stack up orders.

**Deals handed to a Driver** (amends ADR 0022 decision 6):

```ts
// HeldDealState (ADR 0022) gains:
/** The Driver carrying this deal, from the ORDER_RUN that handed it over; null while the founder holds it. An agreement. */
readonly carrier: CharacterId | null;
```

- `ORDER_RUN` with a deal sets `carrier` to the Driver. The deal must be `HELD`, have no carrier, not have passed its `expiresAt`, and match the cargo (`DEAL_UNAVAILABLE`, `CARGO_DOES_NOT_MATCH_DEAL`).
- **A deal with a carrier is shown only through the run order.** The player snapshot lists the founder's held deals as `heldDeals` filtered to `carrier === null` (both `HELD` and `DISPATCHED`, as SK1c builds it). A deal handed over leaves that list when the founder hands it over, and is shown as part of the Driver's run order. Its world status (`HELD`, `DISPATCHED`, or gone) is never projected, because whether the Driver has set out is hidden.
- **The founder can't use a handed-over deal:** a founder dispatch naming it is `DEAL_UNAVAILABLE { dealId }`. `carrier` is an agreement, so the reason leaks nothing.
- **Expiry.** A deal with a carrier still expires by time if it's `HELD` at `expiresAt` (the Driver never set out with it), and its commitment is released as ADR 0022 decides. But `DEAL_EXPIRED` writes **no activity item** for a deal with a carrier: whether it was still `HELD` is hidden. The Driver reports it (`RUN_LAPSED`, decision 9). Amends ADR 0022's "an activity item when it fires", which stays true for deals the founder holds.
- **No cancelling a run order in M002.** A cancel's outcome (in time, or too late because the Driver already set out) depends on hidden state, so it would have to be another reported outcome. Every run order ends by itself in bounded time instead: it lapses at `expiresAt` if the Driver never set out, and a run that sets out ends when the truck comes home. PLACEHOLDER: a later record can add a cancel whose result is reported.

**Installment runs count against the cap** (amends ADR 0022 decision 6 and ADR 0021 decision 8's `inTransit`). The founder's installment checks (`ORDER_RUN` here, and the founder's own installment dispatch) count, for that contract: known `delivered`, plus the founder's own known in-transit cases, plus the cases in every run order in `runOrders` for that contract. The player snapshot's `inTransit` adds the same run-order cases. All three are knowledge or agreements. When a report tells the founder an installment run ended, the same delivery writes the Driver's `CONTRACT_PROGRESS` observation from the stop (decision 9) and removes the run order, so the cases move from "ordered" to "delivered" in one step and are never counted twice. (If a message carrying that report is dropped, decision 9 re-tells the ended run but not the observation, so the count can run short until the contract's progress is next learned. Extra cases are then paid as ADR 0018 decision 6 already pays them: a lag, never a wrong book.)

### 4. The Driver's standing order: the truck, and a regular run

```ts
// packages/contracts/src/state.ts (amends ADR 0025 decision 5)
export type StandingOrderTerms = DistillOrderTerms | DriveOrderTerms;   // the Office Hand has none (decision 10)

export interface DriveOrderTerms {
  readonly kind: "DRIVE";
  /** The truck this Driver drives. */
  readonly vehicleId: VehicleId;
  /** A delivery the Driver makes on their own once a day, without being told; null: only run orders. */
  readonly regularRun: RegularRunTerms | null;
  /** Whether they phone the family's numbers: never, about problems, or after every run (decision 9). */
  readonly callWhen: "NEVER" | "PROBLEMS" | "EVERY_RUN";
}

/** "Every morning at eight, ten cases to the Crossroads on spec, if we've more than twenty." */
export interface RegularRunTerms {
  readonly buyerId: BuyerId;
  readonly productId: ProductId;
  readonly quality: QualityTier;
  readonly quantity: number;
  /** Go only while unreserved cases of that product and quality at the station are ≥ quantity + keepOnHand. */
  readonly keepOnHand: number;
  /** The earliest minute of the day to set out (0–1439). */
  readonly departMinute: number;
  readonly routeId: RouteId | null;
}
```

`DRIVE_ORDER_DEFAULTS` (game-data, PLACEHOLDER) prefills the form: `{ regularRun: null, callWhen: "PROBLEMS" }`. As in ADR 0025, a UI convenience only.

**Why a regular run.** Run orders still need the founder to say "go" each time, which is the communication gate working as intended, but it's not delegation. The regular run is the Driver's standing authority: a fixed on-spec delivery the founder decided once. It's the Driver's version of the Distiller's "keep 20 on hand". It's on spec only, because a deal is a new agreement with a buyer that only the founder makes (GDD §21: the authority you hand out). A regular run is at most once per game day.

**The authority gate** (ADR 0022 gate 4) for a Driver's `DISPATCH_DELIVERY`:

- `vehicleId` is the order's vehicle, otherwise `OUTSIDE_AUTHORITY { limit: "VEHICLE" }`;
- the origin is the station (it always is: decision 5 dispatches from there), otherwise `"STATION"`;
- `driver` is `{ kind: "EMPLOYEE", characterId }` of the issuer, otherwise `"COMMAND"`;
- the cargo, purpose and route equal a waiting run order's terms, **or** the dispatch is the regular run: `SALE { buyerId: regularRun.buyerId, dealId: null }`, the run's product and quality, `quantity ≤ regularRun.quantity`, the run's `routeId`. Otherwise `"RUN"`.

```ts
// amends ADR 0025's AuthorityLimit
type AuthorityLimit = "COMMAND" | "STATION" | "RECIPE" | "BATCH_SIZE" | "SPENDING_CAP" | "VEHICLE" | "RUN";
```

**What a Driver may not do:** agree or change deals, accept contracts, buy anything, or drive anything but their order's truck from their station. The transport cost of a run is ADR 0019's charge on return, which the founder agreed by sending the truck; the Driver spends nothing else, so `DriveOrderTerms` has no spending cap and `work.spending` stays at 0 for a Driver.

`SET_STANDING_ORDER` takes `DRIVE` terms for a Driver exactly as ADR 0025 decision 5 takes `DISTILL` terms for a Distiller, with the same `Reach`, timing, new `StandingOrderId` and clearing of `lastHold` and `lastRefusal`. Terms of a kind that doesn't fit the role are `ORDER_NOT_FOR_ROLE` (decision 15). A run already under way finishes under the order it set out with.

### 5. A run, step by step

**The Driver's `EmployeeView`** (ADR 0022 decision 2, ADR 0025's for the Distiller): the world at the station, which is what a founder present there sees. That's the station's `FACILITY_STOCK`, the vehicles parked there, `ROUTE_CONDITION` for the station's `LIVE_VIEW_ROUTES`, plus the cash balance, the founder's agreements (held deals with their `carrier`, contract terms), static geography, and the Driver's own `EmployeeState`. It doesn't include buyers or contract progress: the Driver at the still doesn't know them either.

**Who loads, and when they're free.** The Driver loads. They're at the station unless they're on the road: "away" means `work.run !== null` and the run's truck has left (`parkedAt === null`).

```ts
// EmployeeWork (ADR 0025) gains, used by Drivers only:
/** The run under way: loading or on the road. runOrderId null is the regular run. */
readonly run: { readonly runOrderId: RunOrderId | null; readonly deliveryId: DeliveryId; readonly vehicleId: VehicleId } | null;
/** Run orders that have ended and that no delivered report has told the founder about yet (decision 9). Sorted. */
readonly endedRuns: readonly RunOrderId[];
/** The game day the last regular run set out, or null. */
readonly lastRegularDay: number | null;
```

**The Driver's hours.** As written, a Driver can take up a run and set out at any tick, including a run order taken up at 03:00. #209 §5's principle that people sleep applies to Drivers too. ADR 0028 (#214) defines employees' working hours, and decides whether and how they gate steps 1 and 3 below (a new hold reason, say). Whatever it decides must read only agreements, game-data and the tick, with no draw, so this policy and its non-leak argument stand with one more condition. A truck already on the road keeps going.

**The policy step** (in the `employees` phase, after any Distiller with a lower `characterId`, for each Driver with `t ≥ startsAt` and a `DRIVE` order):

1. **Departure.** If `work.run`'s delivery has `trip.departedAt === t` (loading is done), the truck sets out or finds its road closed (decision 6).
2. **Lapses.** Each run order that isn't the run under way and isn't in `endedRuns` lapses if `expiresAt ≤ t`, or if it's deal-backed and the deal is no longer `HELD` with this carrier (it expired in an earlier tick's `deadlines`). A lapse writes `RUN_LAPSED` (reason `DEAL_EXPIRED` or `ORDER_EXPIRED`) and adds the ID to `endedRuns`. Lapses are found here, not in `deadlines`, so that report lines are written only in the phases decision 11 lists.
3. **Pick the next run,** if `work.run === null`: the first waiting run order, in the order given, that can set out now, else the regular run if it's due. "Can set out now" means the gates would pass: the order's truck is parked at the station with no trip, the cargo is there (unreserved stock, or the contract's reservations first for an installment, as `takeForContract` does), and the route is open in the view. "Due" means `regularRun !== null`, `lastRegularDay ≠` today, minute of day `≥ departMinute`, and unreserved stock `≥ quantity + keepOnHand`.
4. **Issue it:** `DISPATCH_DELIVERY { vehicleId, cargo, purpose, routeId, driver: { EMPLOYEE, characterId } }` with issuer `{ EMPLOYEE, characterId, standingOrderId }`, through ADR 0025 decision 6's `applyIssued` path: no envelope, no command counters, `causedBy: null`, `EMPLOYEE_ACTED` as its identity. If it applies, `work.run` is set (and `lastRegularDay` for the regular run), and `lastHold` and `lastRefusal` clear. If it's rejected (sizing should make that impossible), an `ORDER_REFUSED` line is written once, as ADR 0025 does.
5. **Otherwise hold.** The first applicable reason, for the first waiting run order (or the regular run if none is waiting): `NO_VEHICLE` (the truck isn't parked here free: the founder has it, or it's being loaded), `NO_STOCK { productId, quality }`, `ROUTE_CLOSED { routeId }`. Written as `HELD_BACK` only if it differs from `lastHold`, as ADR 0025 does. With nothing waiting and no regular run due, `lastHold` clears.

```ts
// HoldReason (ADR 0025) gains:
| { readonly kind: "NO_VEHICLE" }
| { readonly kind: "NO_STOCK"; readonly productId: ProductId; readonly quality: QualityTier }
| { readonly kind: "ROUTE_CLOSED"; readonly routeId: RouteId }
```

**The dispatch** is ADR 0022 and 0023's, with the station as the origin (`fromFacilityId`, amending ADR 0023 decision 5's "later, a hired Driver's station"). Gate 5 uses the Driver's view: stock at the station, the truck parked there, the route condition, and for a deal-backed sale the deal (`HELD`, `carrier` = the issuer, cargo matching). An installment's contract checks were made against the founder's knowledge when the run was ordered, and aren't repeated: the Driver can't see contract progress, and a contract that closed meanwhile resolves on arrival (`CONTRACT_CLOSED`, ADR 0022). The deal becomes `DISPATCHED` and the delivery's `dealDeadline` is set as ADR 0022 decides. The trip's `departedAt = t + ACTIVITY_DURATIONS.LOAD_TRUCK`: the Driver takes the founder's loading time. `TIRED_DURATION_PPM` doesn't apply (employees aren't tired), and competence doesn't change loading (decision 8). The truck stays parked, with its trip set, until departure. The founder's `busy` never changes.

The posting is `DISPATCH:EMPLOYEE:<deliveryId>` (Dr `GOODS_IN_TRANSIT` / Cr `FINISHED_GOODS`), its own producer, because it's not a founder command (decision 12).

**ADR 0022's test applies:** for every Driver command applied, the same command validated by a founder present at the station, with gates 1 and 5 only, also applies, once `driver` is read as `{ kind: "FOUNDER" }`, the deal's `carrier` as the founder's (null), and the run order being carried left out of the installment count. Those are the three places the command names the Driver, not the world.

**The stop** (the `vehicles` phase, ADR 0022's arrival rules unchanged, except for money and lines):

- A sale or installment arrival posts `SALE:CARRIED:<deliveryId>`: Dr `RECEIVABLES` / Cr `SALES_REVENUE` for the accepted cases, plus COGS as `saleEntries` posts it. No cash moves (decision 7). `SALE_COMPLETED`, `SPEC_SALE_SETTLED` and every progression effect are as for any sale.
- Lines: `RUN_DELIVERED`, or `RUN_TURNED_BACK` for a fall-through (`TOO_LATE`, `NOT_WANTED`, `CONTRACT_CLOSED`), `RUN_SEIZED`, or `RUN_DELAYED` (decision 9). Observations at the stop: `CONTRACT_PROGRESS` of an installment's contract, `ROUTE_CONDITION` of the route, `VEHICLE_WHEREABOUTS` of the truck.
- A `TRANSFER` run unloads at the destination as ADR 0019 and T03b do, and its line is `RUN_DELIVERED` with `collected: 0`.

**The return** (the `vehicles` phase). The truck comes home to the station (`fromFacilityId`), as ADR 0023 decision 5 decides for every dispatch under founder rules. `VEHICLE_RETURN:<deliveryId>` is unchanged: transport cost paid or accrued, unsold cargo booked back into the station. Then the takings are handed in (decision 7). The Driver writes `RUN_RETURNED`, observes `VEHICLE_WHEREABOUTS` and `ROUTE_CONDITION`, adds 1 to `batchesRun` (decision 8), clears `work.run`, and adds the run order's ID (if any) to `endedRuns`. The truck is parked at the station, free for the next run, the same tick.

### 6. Roads closed: while loading, and on the road (the #191 follow-up)

**Found at departure.** At the Driver's departure tick (policy step 1), if the trip's route is closed, the truck doesn't set out. This is ADR 0022 and 0023's `ROUTE_FOUND_CLOSED` at departure, applied by the Driver:

- One transaction keyed `idempotencyKey("DISPATCH", "EMPLOYEE", deliveryId, "UNLOADED")`: the cargo goes back into the station with `returnFromTransitEntries`, cargo drawn from contract reservations comes back unreserved (ADR 0013 decision 6), the truck's trip clears, the delivery is `FAILED` with empty cargo, and `ROUTE_FOUND_CLOSED { deliveryId, routeId }` is emitted. That event is `DELIVERY_ORIGIN` news at the station (ADR 0022).
- **The deal goes back to `HELD`, keeping its `carrier`.** The Driver still has it, and will try again.
- The run order goes back to waiting (`work.run = null`), and it lapses at its `expiresAt` like any waiting order, which for a deal is the deal's expiry. The Driver writes `HELD_BACK { ROUTE_CLOSED }` if it differs from `lastHold`, and observes the route's `ROUTE_CONDITION`.

**Options considered for the deal:**

- **(a) Return it to the founder** (`HELD`, carrier cleared), as ADR 0022 does when the founder loads. Rejected: the deal would reappear in the founder's held list at the moment of a closure the founder has no channel to see. That's the leak #191 names.
- **(b) Resolve it as a fall-through** (`FELL_THROUGH`, reason `ROUTE_CLOSED`), reported by the Driver. Leak-free, but it throws away a deal the founder negotiated because of a closure the Driver could simply wait out, and the founder has no way to prevent it.
- **(c) The deal stays with the Driver (chosen).** Leak-free, because a deal with a carrier is projected only through its run order, whatever its world status (decision 3), so `HELD`-with-carrier and `DISPATCHED` look the same to the founder. It's also what a sensible driver does: wait for the road to open, or until the buyer's patience runs out.

**When the closure is found.** A Driver's run checks its route twice: when it's dispatched (gate 5, in the station's view, so a closure already there holds the run) and when it departs. A closure that begins after departure doesn't affect a trip in flight (ADR 0019). So on a Driver's run, ADR 0022's "found on the road" always happens at departure. The founder's view isn't involved either time: the founder may order a run on a road that's closed without knowing it, and learns that from the Driver's hold, the news, or the route's observation.

**One tick earlier than the founder's.** The founder's departure runs in the `founder` phase, after world events, so it sees a closure that starts on the departure tick. The Driver's runs in the `employees` phase, before world events, so a closure starting on the departure tick itself comes too late, and the truck is already on its way. That's a one-tick difference with no leak in it, and it keeps every Driver step in one phase.

### 7. Payment carried home

ADR 0021 decision 3: money a hired Driver carries isn't purse cash until it's handed in.

**Options considered:**

- **(a) Cash at the buyer, as the founder's sale posts it.** Rejected: it contradicts ADR 0021 decision 3, and it would make every Driver sale known from anywhere at the moment of the hand-over.
- **(b) Handed in only when the Driver meets the founder.** Rejected: it splits the business's money across places, which GDD §17 defers to later milestones ("a safe at the still"), and money piling up at the still while the founder can't buy corn turns the Driver into a chore rather than freedom.
- **(c) A receivable from the stop until the truck is home, then cash (chosen).** The takings ride home with the Driver. When the truck is back at the station, they go into the family's money.

**The postings:**

| When | Transaction | Entries |
|---|---|---|
| The stop: the buyer pays the Driver | `SALE:CARRIED:<deliveryId>` (kind `SALE`) | Dr `RECEIVABLES` / Cr `SALES_REVENUE` for the takings; Dr `COST_OF_GOODS_SOLD` / Cr `GOODS_IN_TRANSIT` |
| The return, after `VEHICLE_RETURN` | `SALE:HANDED_IN:<deliveryId>` (kind `SALE`) | Dr `CASH` / Cr `RECEIVABLES` for the takings. None if the takings are 0 (no posting at all) |

- **Revenue is recognised at the stop** (FIN-001: the sale happens when the buyer takes the goods). Net worth doesn't change at the hand-in.
- **Cash flow (ADR 0015).** The hand-in's only non-cash account is `RECEIVABLES`, which has no category, so it files under `SALE`'s default, `SALES`. No change to ADR 0015's table.
- **The takings are derived, not stored:** the hand-in amount is the `RECEIVABLES` debit of that delivery's `SALE:CARRIED` transaction, found by its idempotency key (ADR 0008: derived values aren't stored). That's why `DeliveryState` gains no field, and `fin-001.locked.test.ts`'s `DeliveryState` literal still compiles. Invariant: the `RECEIVABLES` balance equals the sum of `SALE:CARRIED` debits whose `SALE:HANDED_IN` hasn't posted.
- **Risk.** The return leg draws nothing (`returnHome`), so takings are never lost on the way home in M002. PLACEHOLDER: robbery on the way home is a later rule, and it would post `LOSSES` against `RECEIVABLES`.
- **A Driver dismissed mid-run** (only possible on a regular run, decision 15): the delivery keeps its `driver`, and its stop and return post as above. Postings follow `DeliveryState.driver`, not employment. ADR 0025's "the pending report is delivered" at dismissal applies only if the Driver is at the station; a Driver on the road takes it with them, and the run's later lines have no report to go into and are dropped. The run still counts: `batchesRun` rises on their `formerEmployees` entry at the return. The founder learns the outcome from the hand-in and `VEHICLE_RETURN` cash postings, and from the news at the station.

**Insolvency waits for takings** (amends ADR 0020 decision 10). The midnight check's **"no goods"** condition gains: the `RECEIVABLES` balance is 0. The recovery policy's step 1 waits for every truck bringing takings home, and the horizon `H` gains a row: each `DELIVERED` delivery whose truck is still on its return leg with takings, at its homeward `arrivesAt`. With `founderRules: false` there are no Drivers and `RECEIVABLES` stays 0, so nothing changes for M001 or `prog-001-outcome.locked.test.ts`.

**Known net worth** (ADR 0021 decision 8) counts receivables from the **known books**, as ADR 0022 does for `PRODUCTION_IN_PROGRESS`. A `SALE:CARRIED` row is pending until learned (decision 12), so known net worth doesn't rise until the founder learns of the sale, and it doesn't move again at the hand-in.

### 8. Competence and the Driver's randomness

**What competence does: trouble on risky roads.** On a Driver's run, ADR 0019's disruption draw *a* is compared with `riskPpm × competenceRiskPpm / 1 000 000` (rounded up, capped at 1 000 000) instead of `riskPpm`, where `competenceRiskPpm = atZero + (atHundred − atZero) × competence / 100` (integer, floor) from `COMPETENCE_RISK_PPM` (game-data, PLACEHOLDER `{ atZero: 1 500 000, atHundred: 500 000 }`). A middling Driver (50) has the founder's odds, a very good one half of them, a poor one half again. Draw *b* (seizure or delay) is unchanged. Safe routes (`riskPpm` 0) stay safe, so competence matters exactly when the run order or regular run names a back road, which is the tradeoff GDD §21 lists: the truck and cargo are in someone else's hands.

**Options considered:** loading time (rejected: 30 minutes scaled by ±40% is nearly invisible); price or takings (rejected: deals fix the price, and skimming is loyalty's, a later milestone); **risk on risky routes (chosen)**: visible in reports, deterministic given the draws, and it makes "which road?" a decision that depends on who's driving.

A dismissed Driver's run in flight still uses their competence: ADR 0025 decision 3's keyed draw gives the same value for that person in this game, so it's recomputed from the seed when they're no longer in `employees`.

**Learning it.** `EMPLOYEE_PERFORMANCE` (ADR 0025 decision 8) is unchanged in shape. Its `batchesRun`, and `EmployeeWork.batchesRun` and `formerEmployees[].batchesRun`, count **the role's completed work**: batches finished for a Distiller, runs that came home for a Driver, nothing for an Office Hand. The contract task updates their doc comments; renaming the field would need a migration of saved records, catch-up lines and journaled catch-up events for no reader. A Driver's competence is revealed once `batchesRun ≥ COMPETENCE_REVEAL_RUNS` (game-data, PLACEHOLDER 3: you need a few runs to judge a driver). `COMPETENCE_REVEAL_BATCHES` stays the Distiller's.

**The Driver's trip draws** (amends ADR 0022 decision 8). A Driver's trip draws *a* and *b*, in order, from `keyedRng(seed, "employee-trip:<vehicleId>:<characterId>", n)`, where `n` is the Driver's `batchesRun` when the run is dispatched. A Driver has one run at a time and `batchesRun` rises only when it comes home, so `n` names the run, and the outbound resolution reads the same `n` (from `employees`, or from `formerEmployees` if they've been dismissed). **`VehicleState.tripCount` counts only trips the founder drives** (and, with the flag off, every dispatch, as today). Otherwise hidden Driver runs would advance the ordinal of the founder's next trip in the same truck and shift draws the founder sees. If SK1c's per-trip helper is already a keyed stream, E2 reuses it with this key.

### 9. How the outcome reaches the founder

**Report lines** (amends ADR 0025 decision 7's `ReportLine`):

```ts
// packages/contracts/src/knowledge.ts
/** What a run line is about: self-contained, so a line makes sense without an earlier report. */
export interface ReportRun {
  readonly runOrderId: RunOrderId | null;   // null: the regular run
  readonly cargo: readonly CargoLine[];
  readonly purpose: DeliveryPurpose;
}

export type ReportLine =
  | /* ADR 0025's BATCH_STARTED, BATCH_FINISHED, HELD_BACK, ORDER_REFUSED */
  | { readonly kind: "RUN_SET_OUT"; readonly tick: Tick; readonly standingOrderId: StandingOrderId; readonly run: ReportRun; readonly routeId: RouteId }
  | { readonly kind: "RUN_DELIVERED"; readonly tick: Tick; readonly run: ReportRun;
      readonly offered: number; readonly accepted: number; readonly collected: Money }
  | { readonly kind: "RUN_TURNED_BACK"; readonly tick: Tick; readonly run: ReportRun;
      readonly reason: "TOO_LATE" | "NOT_WANTED" | "CONTRACT_CLOSED" }
  | { readonly kind: "RUN_SEIZED"; readonly tick: Tick; readonly run: ReportRun; readonly cases: number }
  | { readonly kind: "RUN_DELAYED"; readonly tick: Tick; readonly run: ReportRun; readonly arrivesAt: Tick }
  | { readonly kind: "RUN_RETURNED"; readonly tick: Tick; readonly run: ReportRun;
      readonly casesHome: number; readonly handedIn: Money }
  | { readonly kind: "RUN_LAPSED"; readonly tick: Tick; readonly run: ReportRun;
      readonly reason: "DEAL_EXPIRED" | "ORDER_EXPIRED" };
```

**Problem lines** (they set `callPending` under `callWhen: "PROBLEMS"`): `HELD_BACK`, `ORDER_REFUSED`, `RUN_TURNED_BACK`, `RUN_SEIZED`, `RUN_DELAYED`, `RUN_LAPSED`, and `RUN_DELIVERED` with `accepted < offered`. Under `EVERY_RUN`, `RUN_DELIVERED` and `RUN_RETURNED` set it too.

**Observations: what a Driver saw, dated.** A Distiller reports the station as it is when the report is delivered (ADR 0025). A Driver reports things seen elsewhere and earlier, so their values are stored with the time they were seen:

```ts
export interface ReportObservation {
  readonly subject: KnowledgeSubject;
  readonly value: KnowledgeValue;
  readonly observedAt: Tick;
}

export interface PendingReport {
  // ADR 0025's lines, dropped, callPending, plus:
  /** One per subject, the newest replacing older ones, sorted with compareKnowledgeSubjects. Drivers only. */
  readonly observations: readonly ReportObservation[];
}

export interface ReportContent {
  // ADR 0025's characterId, lines, dropped, plus:
  readonly observations: readonly ReportObservation[];
  /** Run orders this report tells the founder have ended. Delivering it removes them from runOrders. */
  readonly endedRuns: readonly RunOrderId[];
}
```

- **What a Driver observes:** `VEHICLE_WHEREABOUTS` of the truck, and `ROUTE_CONDITION` of the run's route, when the truck sets out, at the stop, when a closure holds it, and on return; and at the stop, `CONTRACT_PROGRESS` of the contract an installment run served (the buyer's receipt). Never `BUYER_WANTS`, `BUYER_BUDGET` or `STANDING`: the Driver isn't a negotiator, and being there yourself should pay (GDD §18).
- **The `REPORT` rows** (ADR 0025 decision 7 asked for them). A row is the most any report about a party of that kind may reveal; each role's rule says which it does:

  | Source | Party | Reveals |
  |---|---|---|
  | `REPORT` | Facility | ADR 0025's `FACILITY_STOCK`, `FACILITY_OPERATIONS`, `EMPLOYEE_PERFORMANCE` (the Distiller's, read at delivery), plus `ROUTE_CONDITION` and `VEHICLE_WHEREABOUTS` (the Driver's observations, filed as about the station) |
  | `REPORT` | Buyer | `CONTRACT_PROGRESS` (the Driver's receipt from the stop) |
  | `REPORT` | Supplier | Nothing in M002 |

  No `REPORT` row reveals `BUYER_WANTS`, so ADR 0021's pairing rule holds trivially.
- **Writing them.** On any delivery, by any channel, each observation is written with source `REPORT { characterId }` and `learnedAt = observedAt`, under ADR 0024 decision 6's rule: only if there's no record or `record.learnedAt < observedAt` (strict). It clears from `pendingBooks` only entries concerning its subject with tick `< observedAt`, and only if it was written. The source is the Driver even when the report travels in a message, because the Driver is who saw it, and `observedAt` keeps it from passing for newer than it is. That's why observations ride in `ReportContent`, not in `HeldMessage.values`, which are stamped `takenAt`.
- **Telling the founder a run ended.** Every report delivered **directly** (in person, call out, call in answered) carries `endedRuns` = the Driver's `work.endedRuns` at that moment. A report taken as a **message** carries the `work.endedRuns` at `takenAt`. Delivering a report, either way, removes its `endedRuns` from `runOrders` and from `work.endedRuns`. If a message is dropped (`MESSAGE_LIMIT`), its run orders are still in `work.endedRuns`, so the next direct report tells them again. Nothing is ever stuck. A report counts as non-empty if it has lines, a dropped count, observations or `endedRuns`.
- **News.** A report delivers the station's pending news (ADR 0025) only when the reporting employee is at the station. A Distiller always is. A Driver is unless away, so a Driver's report at the still delivers it. Messages never carry news (ADR 0025).

**The channels for a Driver's report:**

| Channel | When | Notes |
|---|---|---|
| **In person** | The founder is `PRESENT` at the station and the Driver isn't away: at the end of the `employees` phase, at the start of the `founder` phase (decision 11), and on arrival or waking at the station | As ADR 0025. A Driver coming home while the founder waits at the still reports the same tick |
| **Call out** | A call to the station answered by an Office Hand (decision 10), inside `PLACE_CALL` and then at each delivery point while connected, if the Driver isn't away | A call answered by a Distiller doesn't reach the Driver, so it doesn't deliver their report |
| **Call in from the station** | ADR 0025's window-tick rule, if the Driver isn't away | Needs a family number other than the station. ADR 0024's PLACEHOLDER table gives none; whether a contact who takes messages for the family (Miller's, #203 §2) counts as one is ADR 0027's (#213) |
| **As a message** | A call in from the station taken by a contact who takes messages for the family. Which contacts those are, and when, is ADR 0027's (#213): it replaces ADR 0024's `holdsMessages` boolean with an earned privilege | ADR 0025's `EMPLOYEE_REPORT` message. Its `values` are empty for a Driver: the observations ride in `report`. ADR 0025's replacement rule (same caller location and same `report.characterId`) also merges `observations` (newest per subject) and `endedRuns` (union) |

**No call from the road in M002** (deferred to ADR 0027, #213). **Options considered:**

- **(a) Call from any buyer stop with a `public` `PHONES` entry that's open by `PLACE_HOURS`, free.** Rejected: it contradicts #203. Whether someone may use a phone is a separate, earned privilege, not ADR 0024's `public` boolean. Lakeview's phone is a guest phone on lobby hours, not the back room's `PLACE_HOURS`. Kessler's private line gives no use to the founder, so none to a hired Driver. And the one genuinely public phone, the depot's, costs a fee.
- **(b) Call only where ADR 0027 lets a non-guest stranger use the phone, during that phone's own hours, with the fee left to ADR 0027.** Rejected for now. No M002 buyer stop has such a phone (the depot isn't a buyer), so the channel would never fire. A fee would be cash posted without a founder command, which needs its own coverage row.
- **(c) Defer calls from the road entirely to ADR 0027 (chosen).**

A Driver reports at the station (in person, or on a call the Office Hand answers) and by ADR 0025's window-tick call. If ADR 0027 adds road calls, they must use its access rule, never a buyer's private line or a guest phone, and post its fee with a coverage row.

**Cash postings and news.** Independently of reports, the return's `VEHICLE_RETURN` and `SALE:HANDED_IN` cash postings tell the founder the truck is home and how much came in (decision 12), and road events (`DEAL_FELL_THROUGH`, `CARGO_LOST`, `DELIVERY_DELAYED`, `ROUTE_FOUND_CLOSED`) are news at the station, as for any delivery. So a founder who never phones still learns the money at once and the story on their next visit. GDD §17: you may learn late, but you always learn.

**The report invariant** (ADR 0025 decision 7), restated for Drivers: at the end of any tick at which an order can reach employee E **and E isn't away**, E's pending report is empty. A Driver on the road isn't there to report, and an order left for them waits too. Lines are written in the `production`, `employees` and `vehicles` phases, and decision 11 adds a delivery point after `vehicles`, so the invariant holds within the tick.

### 10. The Office Hand

**What they do:** sit by the family line at their station, answer it, take messages, and pass on the founder's orders to everyone stationed there. They don't run batches or drive, so they issue no commands, have no policy step and **no standing order**: `StandingOrderTerms` has no variant for them, and `HIRE_EMPLOYEE` or `SET_STANDING_ORDER` with terms for an Office Hand is `ORDER_NOT_FOR_ROLE`. Their report never has lines.

**When they answer.** People sleep, so nobody answers day and night (#209 §5, which vetoes ADR 0025's placeholder for the Distiller too). An Office Hand answers, and a Distiller answers for the still, only while **available** under the deterministic rule ADR 0028 (#214) defines, written here as `isAvailable(employee, tick)`. That rule reads only agreements, game-data and the tick, never world state and never a draw, so both hooks below still read only the player view, the seed and the tick, and the founder can know ahead of time when someone will pick up. Outside it, the call is unanswered, on ADR 0024's path as ADR 0027 (#213) and ADR 0028 amend it. This record doesn't choose the hours.

**The call-out attendant hook** (fills ADR 0024 decision 9, extends ADR 0025's Distiller case). Among the employees stationed at the facility at L with `startsAt ≤ tick` **and `isAvailable(employee, tick)`**: the `OFFICE_HAND`, else the `DISTILLER`, else null (by `characterId` within a role, though a station holds at most one of each). The precedence applies among available employees only: an Office Hand off duty doesn't stop an available Distiller answering, and an available Office Hand answers ahead of a Distiller. **A Driver never answers the station's phone**: whether they're at the still is hidden, and the hook may read only the player view, the seed and the tick. Every input is an agreement, game-data or the tick. No draw.

**The call-in attendant hook.** The `OFFICE_HAND` stationed at the facility at L with `startsAt ≤ tick` and `isAvailable(employee, tick)`, or null. In M002 it reads the same inputs as the call-out hook, so the two agree. ADR 0024 lets it read world state (an Office Hand out on an errand), and a later record may use that. A Distiller still doesn't take messages (ADR 0025). So while an Office Hand is available, buyers' calls in to the still become messages there. Otherwise they go unanswered unless the founder is standing at the line.

**Which employees a call reaches** (ADR 0024 decision 9 left it to this record; amends ADR 0025 decision 5's `Reach`):

```ts
// Reach for employee E stationed at S, at apply tick t (always-known inputs only):
// IN_PERSON: founder PRESENT at S's location, and t ≥ E.startsAt.
// PHONE:     founder PRESENT elsewhere, call !== null, call.locationId === S's location, t ≤ busy.until,
//            t ≥ E.startsAt, call.answeredBy.kind === "EMPLOYEE", and the answerer is
//            E itself, or the OFFICE_HAND stationed at S.
// null:      NO_WAY_TO_REACH { characterId }.
```

`Reach` reads `call.answeredBy`, which the call-out hook set from the availability rule when the call connected, so availability reaches it through the answerer. ADR 0028 (#214) decides whether an answerer can go off duty mid-call, and whether a relayed order waits for its recipient's working hours; either way the order is an agreement and is never refused for the recipient's hours.

- **An Office Hand passes orders on to everyone at the station.** `SET_STANDING_ORDER`, `DISMISS_EMPLOYEE` and `ORDER_RUN` reach the Distiller and the Driver through them. That's GDD §21's "passing on your orders by phone", and it's what the Office Hand adds beyond messages.
- **A Distiller answers for themselves only.** On a call they answered, orders reach the Distiller (ADR 0025) and nobody else. **Options considered:** anyone who answers passes orders on (rejected: the Office Hand would add only messages, and GDD §21 gives relaying orders to them); **only the Office Hand relays (chosen)**. PT2/PT3 can revisit it (*Needs design*: who at the still minds the phone for whom).
- The call reaches the station's employees, not other stations: relaying to another family facility by phone is later (M002 has one facility).

**What a call answered by an Office Hand delivers:** ADR 0024's held messages at L (the line now holds messages); the call view (`PHONE.FACILITY`, ADR 0025's row: what someone at the still can tell you); and the report of every employee the call reaches who isn't away, each as a `REPORT` item with `via: "CALL_OUT"`, inside `PLACE_CALL` and then at each delivery point while connected (decision 11). So a Driver who comes home during the call reports on it. **The Office Hand doesn't pass on the station's news themselves** (ADR 0024 decision 4 asked): news comes with the reports of employees who are at the station, which already covers everything that happened there.

**Competence is inert for an Office Hand in M002.** Nothing they do depends on skill yet, so `ROLE_TERMS.OFFICE_HAND.estimateSpread` is `null` (decision 1): the founder is shown no competence estimate for an Office Hand, in the hiring scene or on `PlayerEmployee`, rather than an exact value (#209 §3). The wage range is a single value, and `EMPLOYEE_PERFORMANCE.competence` stays null for them. A later record can give it an effect (garbled messages, say: that's reliability's territory too).

### 11. Tick order

`PHASES` is unchanged from ADR 0025: `production, employees, vehicles, [world events], resolution, founder, phones, deadlines, midnight`, then the persist step.

- **Commands:** `ORDER_RUN` applies here, before the Driver's step, so an order given in person at the still is taken up the same tick. A founder's own `DISPATCH_DELIVERY` or `TRAVEL` with the truck also applies first, and the Driver then finds no truck (`NO_VEHICLE`), as the founder's batch goes before the Distiller's.
- **`employees`:** each employee in `characterId` order: a Distiller's step (ADR 0025), a Driver's step (decision 5: departure, lapses, the next run, holds). Then deliveries, in `characterId` order, in person or on a connected call, for every employee E that the founder reaches and who isn't away.
- **`vehicles`:** a Driver's stop and return (decision 5), with their lines, observations and postings.
- **`founder`, new step 0** (amends ADR 0023 decision 2a and ADR 0025 decision 10): before step 1 ends any call, run the same deliveries as at the end of `employees`, in person and on a connected call. That delivers lines the `vehicles` phase wrote this tick. Then steps 1–4 as ADR 0023 has them, with arrivals delivering reports in the catch-up step (ADR 0025).
- **`phones`:** messages at the founder's place (ADR 0024); then window-tick calls in (parties, then employees, ADR 0024 and 0025). No call from the road (decision 9).
- **`deadlines`:** a deal with a carrier that's still `HELD` expires here with no activity item (decision 3); the Driver's `RUN_LAPSED` line follows in the next tick's `employees` phase.
- **`midnight`:** wages for Drivers and Office Hands as for every employee (ADR 0025 decision 9).

**Same tick as the end of a founder activity:**

- **The founder ends a timed activity at the still at `u`** (a batch, a briefing): the Driver's step at `u` doesn't read `busy`. `ORDER_RUN` is instant, so it's never `FOUNDER_BUSY` in person.
- **The founder's loading ends at `u`** (their own dispatch): they drive, and the Driver has no truck until it's back.
- **The Driver's truck returns at `u` while the founder is at the still:** the return is in `vehicles`, step 0 of `founder` delivers `RUN_RETURNED`, and both postings were made at the founder's place while present, so they're known at once (ADR 0021 rule 1).
- **The founder arrives at the still at `u` and the truck returns at `u`:** the arrival in the `founder` phase delivers the report with the catch-up.
- **A call to the station ends at `u`:** step 0 delivers before step 1 ends the call, so lines from this tick's `vehicles` phase are heard on the call.
- **The founder departs the still at `u`** by command: the live view is persisted in the command, and the Driver's lines at `u` wait for the next channel (ADR 0025).

**No-trap bound (ADR 0023 decision 8).** `ORDER_RUN` takes no founder time in person and the call's time on a call, which `PHONE_CALL` already bounds. Employees never make the founder busy, and `REST` is never refused for anything here.

### 12. Coverage: producers and what each reveals

| Producer (idempotency-key family) | Entries | Classification |
|---|---|---|
| `PERSONNEL:RUN` (`ORDER_RUN`) | None | Rule 1: the founder's command |
| `DISPATCH:EMPLOYEE` | Dr `GOODS_IN_TRANSIT` / Cr `FINISHED_GOODS` | **World, non-cash: a books row** concerning `FACILITY_STOCK` of the station (the cases left it). Known at once if the founder is present at the station |
| `DISPATCH:EMPLOYEE:UNLOADED` | Dr `FINISHED_GOODS` / Cr `GOODS_IN_TRANSIT` | **World, non-cash: a books row** concerning `FACILITY_STOCK` of the station |
| `SALE:CARRIED` | Dr `RECEIVABLES` / Cr `SALES_REVENUE`; Dr `COST_OF_GOODS_SOLD` / Cr `GOODS_IN_TRANSIT` | **World, non-cash: a books row** concerning `VEHICLE_WHEREABOUTS` of the truck. Known at once if the founder is present at the buyer |
| `SALE:HANDED_IN` | Dr `CASH` / Cr `RECEIVABLES` | **World, cash: a cash-posting row**. Known at once if the founder is present at the station |
| `PERSONNEL:REPORT` (Driver deliveries) | None | ADR 0025's family, rule 4 |
| `VEHICLE_RETURN`, `CARGO_LOSS`, `DISPATCH:CLEAR`, `DISPATCH:DELAY`, `DISPATCH:FELL_THROUGH`, ADR 0022's `DISPATCH:…:SPEC_SETTLED` | Unchanged | Existing rows. A Driver's run uses the same producers as the founder's for everything but the dispatch, the sale and the hand-in |
| `DAILY_SETTLEMENT:WAGES` | Unchanged | Still `AGREED_CHARGE`: Drivers and Office Hands are hired and dismissed only by founder commands, and no standing order can change the wage bill (ADR 0025 decision 9) |

**The new cash-posting row** (ADR 0021 decision 6):

| Posting | Kind | Reveals |
|---|---|---|
| A Driver hands in the takings when the truck is home (`SALE:HANDED_IN`) | `SALE` | `VEHICLE_WHEREABOUTS` of the truck (it's home) and the amount, as activity. **Not** the sale's details, the buyer's state or `CONTRACT_PROGRESS`: those come with the Driver's report. `CASH_POSTING_REVEALS["SALE:HANDED_IN"] = { subjects: ["VEHICLE_WHEREABOUTS"], news: "NONE" }` |

**The new books rows** (ADR 0021 decision 7):

| Producer | Concerns |
|---|---|
| `DISPATCH:EMPLOYEE` | `FACILITY_STOCK` of the delivery's `fromFacilityId` |
| `DISPATCH:EMPLOYEE:UNLOADED` | `FACILITY_STOCK` of the delivery's `fromFacilityId` |
| `SALE:CARRIED` | `VEHICLE_WHEREABOUTS` of the delivery's vehicle. The hand-in posting at the return reveals it with a later `learnedAt`, so the sale is in the known books from the return at the latest |

K1's registry (`packages/contracts/src/knowledge.ts`) gains:

```ts
"PERSONNEL:RUN": { trigger: "FOUNDER_COMMAND", legs: ["NO_ENTRIES"] },
"DISPATCH:EMPLOYEE": { trigger: "WORLD", legs: ["NON_CASH"] },
"DISPATCH:EMPLOYEE:UNLOADED": { trigger: "WORLD", legs: ["NON_CASH"] },
"SALE:CARRIED": { trigger: "WORLD", legs: ["NON_CASH"] },
"SALE:HANDED_IN": { trigger: "WORLD", legs: ["CASH"] },
// CASH_POSTING_REVEALS:
"SALE:HANDED_IN": { subjects: ["VEHICLE_WHEREABOUTS"], news: "NONE" },
// PENDING_BOOKS_CONCERNS:
"DISPATCH:EMPLOYEE": "FACILITY_STOCK",
"DISPATCH:EMPLOYEE:UNLOADED": "FACILITY_STOCK",
"SALE:CARRIED": "VEHICLE_WHEREABOUTS",
```

`transactionProducerOf` resolves `DISPATCH:EMPLOYEE:delivery-4` to `DISPATCH:EMPLOYEE`, `DISPATCH:EMPLOYEE:delivery-4:UNLOADED` to `DISPATCH:EMPLOYEE:UNLOADED`, and `SALE:CARRIED:delivery-4` to `SALE:CARRIED`, all apart from the founder's `DISPATCH` and `SALE`, whose rows don't change. `KNOWLEDGE_VISIBILITY.CASH_POSTING.FACILITY` already includes `VEHICLE_WHEREABOUTS`.

### 13. Flag off (`founderRules: false`)

- `ORDER_RUN` applies as a no-op, as ADR 0025 decision 13 does for its commands. `HIRE_EMPLOYEE` is already a no-op, so no Driver or Office Hand exists, and both attendant hooks return null (the `phones` phase is idle anyway, ADR 0024).
- A dispatch naming an `EMPLOYEE` driver is `NO_DRIVER`, as under founder rules. M001 commands name `FOUNDER` or `null` (O1a), so nothing M001 sends changes.
- Every sale posts `SALE:<deliveryId>` with cash on delivery; `RECEIVABLES` stays 0, so the insolvency amendment and the recovery horizon row never apply.
- `tripCount` increments on every dispatch, as ADR 0022 decides: no dispatch has an `EMPLOYEE` driver.
- `heldDeals[].carrier` stays null, so the recovery policy's `AGREE_DEAL` plus deal dispatch (ADR 0022) is unchanged.

So M001 and the lab play exactly as before. The new fields and the `RunOrder` counter move the state hashes, and the contract task regenerates the fixtures and the Sprint Zero reference hash, as its predecessors do.

### 14. Saves (ADR 0009)

The new required fields bump `SAVE_SCHEMA_VERSION` to the next version after EM1's (v8 if the K1 → P1 → O1a → O1b → ADR 0024 → EM1 sequence holds). The migration reads only the save's own fields and never game-data:

| New field | Value | Source |
|---|---|---|
| `employees[i].runOrders` | `[]` | None needed: no earlier save can hold a Driver (the role didn't exist) |
| `employees[i].work.run` | `null` | As above |
| `employees[i].work.endedRuns` | `[]` | As above |
| `employees[i].work.lastRegularDay` | `null` | As above |
| `employees[i].report.observations` | `[]` | As above: only Drivers observe |
| `heldDeals[i].carrier` | `null` | None needed: no earlier save can hand a deal to a Driver |
| `counters.nextId.RunOrder` | `1` | None needed: counters start at 1 (`new-game.ts`) |
| `report.observations` and `report.endedRuns` on every non-null `report` of `knowledge.pendingMessages[].items[]` | `[]`, `[]` | The item's own `report`: only a Distiller's report can be in an earlier save |
| The same two fields on every `knowledge.activity[i]` of kind `REPORT` (its `report`) and of kind `MESSAGE_DELIVERED` with a non-null `message.report` | `[]`, `[]` | The item's own `kind` and `report` |

**`competenceEstimate` becoming nullable** (decision 1) needs no step: it's a widening, and every saved value is a Distiller's non-null estimate.

**Fields that don't change:** `EMPLOYEE_PERFORMANCE` records, `CatchUp` lines and journaled `KNOWLEDGE_CAUGHT_UP` events (the value's shape is unchanged: `batchesRun` keeps its name, decision 8); `formerEmployees` (the same); `DeliveryState` (takings are derived, decision 7); `VehicleState.tripCount` (only its counting rule changes, and no earlier save holds a Driver's trip). New union members (`EmployeeRole`, `StandingOrderTerms`, `HoldReason`, `ReportLine`, commands, events, rejection reasons, `AuthorityLimit`) are additive. The task adds the old-version fixture save and migration test, as its predecessors do.

### 15. Rejection reasons

`ORDER_RUN`, in ADR 0022 §1's gate order, table order within a gate:

| Gate | Failure | Reason |
|---|---|---|
| 1 | Cargo isn't exactly one line with a positive safe-integer quantity | `INVALID_QUANTITY { field, value }` (existing) |
| 1 | `characterId` isn't an employee; the buyer, contract, route or destination facility doesn't exist | `UNKNOWN_ENTITY` (existing) |
| 1 | The employee isn't a Driver | **`ORDER_NOT_FOR_ROLE { characterId, role }`** (new) |
| 1 | The deal isn't `HELD` with no carrier, or its `expiresAt` has passed | `DEAL_UNAVAILABLE { dealId }` (ADR 0022) |
| 3 | `Reach` is null (decision 10), including before `startsAt` | `NO_WAY_TO_REACH { characterId }` (ADR 0022) |
| 5 | The Driver has no `DRIVE` standing order | **`NO_STANDING_ORDER { characterId }`** (new) |
| 5 | `runOrders.length ≥ RUN_ORDER_LIMIT` | **`RUN_ORDERS_FULL { characterId, limit }`** (new) |
| 5 | Cargo above the order's truck's capacity | `VEHICLE_CAPACITY_EXCEEDED` (existing) |
| 5 | Cargo doesn't match the deal | `CARGO_DOES_NOT_MATCH_DEAL { dealId }` (ADR 0022) |
| 5 | No route from the station to the destination (or a transfer to the station itself) | `NO_ROUTE` (existing) |
| 5 | The route is known closed (a record, or the live or call view) | `ROUTE_CLOSED` (existing; `reopensAt` from the record) |
| 5 | Installment: contract known not active; cargo doesn't fit its terms; known delivered + known in transit + run orders + this run above the requirement | `CONTRACT_NOT_ACTIVE`, `CARGO_DOES_NOT_MATCH_CONTRACT`, `BUYER_WILL_TAKE_LESS` (existing; judged on knowledge, ADR 0022) |

`ORDER_RUN` has no gate-2 reason: in person it's instant, and on a call the exemption applies. The founder's whereabouts reach it through `Reach` at gate 3.

`SET_STANDING_ORDER` and `HIRE_EMPLOYEE` with `DRIVE` terms add, at gate 1: terms of a kind that doesn't fit the role (any terms for an Office Hand) → `ORDER_NOT_FOR_ROLE`; an unknown vehicle, buyer or route → `UNKNOWN_ENTITY`; `quantity < 1`, `keepOnHand < 0` or `departMinute` outside 0–1439 → `INVALID_QUANTITY`. At gate 5: `quantity` above the truck's capacity → `VEHICLE_CAPACITY_EXCEEDED`; no route from the station to the regular run's buyer → `NO_ROUTE`. A regular run's route isn't checked for closure: it's standing authority, and a closed road just holds it.

`DISMISS_EMPLOYEE` adds, at gate 5: **`RUN_ORDER_PENDING { characterId }`** (new) while the employee's `runOrders` isn't empty. It reads an agreement list, so it leaks nothing, and it means a Driver is never dismissed holding a deal or an installment the founder handed them. They can be dismissed while out on a regular run (an on-spec load); decision 7 covers that.

`DISPATCH_DELIVERY` from the founder naming an employee driver: `NO_DRIVER { vehicleId }` (ADR 0022, decision 2). A founder dispatch with a handed-over deal: `DEAL_UNAVAILABLE { dealId }`.

Driver commands use ADR 0022's gates with `OUTSIDE_AUTHORITY { characterId, standingOrderId, limit }`, limits `VEHICLE` and `RUN` added (decision 4). Any rejection is a report line (`ORDER_REFUSED`), never an immediate result. Holds (`NO_VEHICLE`, `NO_STOCK`, `ROUTE_CLOSED`), lapses, turn-backs and calls that ring out are outcomes and report lines, not reasons.

Every new reason's payload is always-known: the employee, their role, standing order and run orders (agreements), and the limit (game-data).

### 16. Contract changes (their own task)

One contract-change task, filed when this ADR merges, **after EM1 (#210)** in the contract sequence (it shares `state.ts`, `commands.ts`, `events.ts`, `knowledge.ts`, `player-snapshot.ts`, `schemas.ts`, `save.ts` and the hash fixtures, and builds on EM1's types):

- `ids.ts`: `"RunOrder"` in `IdKind` and `DYNAMIC_ID_KINDS`, prefix `"run"`; `RunOrderId`.
- `state.ts`:
  - `EmployeeRole` gains `DRIVER` and `OFFICE_HAND`;
  - `EmployeeState.competenceEstimate: CompetenceEstimate | null` (decision 1);
  - `StandingOrderTerms = DistillOrderTerms | DriveOrderTerms`; `DriveOrderTerms`, `RegularRunTerms`;
  - `RunOrderTerms`, `RunOrderState`; `EmployeeState.runOrders`; `EmployeeWork.run`, `.endedRuns`, `.lastRegularDay`, and the doc comments on `batchesRun` (decision 8);
  - `HeldDealState.carrier` (on O1a's type).
- `commands.ts`: `OrderRunCommand` (type, `GameCommand`, `GAME_COMMAND_TYPES`); the reasons `ORDER_NOT_FOR_ROLE { characterId, role }`, `NO_STANDING_ORDER { characterId }`, `RUN_ORDERS_FULL { characterId, limit }`, `RUN_ORDER_PENDING { characterId }`; `AuthorityLimit` gains `VEHICLE` and `RUN`.
- `events.ts`: `RUN_ORDERED { characterId, runOrderId, terms, transactionId }`, `RUN_ENDED { characterId, runOrderId: RunOrderId | null, deliveryId: DeliveryId | null, outcome: "RETURNED" | "LAPSED" }`, `TAKINGS_HANDED_IN { characterId, deliveryId, amount, transactionId }`. All `null` in `EVENT_CONCERNS_PLACE`: the road events they summarise are already news. The task finalises the payloads, using these fields at least.
- `knowledge.ts`:
  - `HoldReason` gains `NO_VEHICLE`, `NO_STOCK`, `ROUTE_CLOSED`;
  - `ReportRun`, the seven `RUN_*` `ReportLine` members, `ReportObservation`; `PendingReport.observations`; `ReportContent.observations` and `.endedRuns`;
  - `TRANSACTION_PRODUCERS`, `CASH_POSTING_REVEALS` and `PENDING_BOOKS_CONCERNS` rows (decision 12).
- `player-snapshot.ts`: `PlayerEmployee.runOrders: readonly RunOrderState[]`; `PlayerEmployee.competenceEstimate` and `PlayerCandidate.competenceEstimate` become `CompetenceEstimate | null` (decision 1); the held-deals list filtered to `carrier === null` (decision 3); `inTransit` counting run orders (decision 3).
- `schemas.ts`, `save.ts`: Zod for all of the above; the bump and migration in decision 14, with an old-version fixture.
- `packages/game-data`:
  - `personnel.ts`: the `CANDIDATE_POOL` entries, `ROLE_TERMS.DRIVER` and `.OFFICE_HAND`, `HIRING_PLACES`, `RoleTerms.estimateSpread: number | null` with load validation accepting `null` or 0–100, and the slate skipping the estimate draw for a `null` role (decision 1); `DRIVE_ORDER_DEFAULTS`, `RUN_ORDER_LIMIT`, `RUN_ORDER_HOLD_TICKS`, `COMPETENCE_RISK_PPM`, `COMPETENCE_REVEAL_RUNS`; `GameData` gains them;
  - `knowledge.ts`: `KNOWLEDGE_VISIBILITY.REPORT.FACILITY` gains `ROUTE_CONDITION` and `VEHICLE_WHEREABOUTS`; `REPORT.BUYER` = `CONTRACT_PROGRESS` (decision 9).

E2 (#182) implements the Driver: `ORDER_RUN`, the policy and the dispatch path, departure and closures, the carried-sale and hand-in postings, insolvency's wait, competence risk and the trip key, report lines and observations on every channel, the founder-phase delivery step, and the coverage rows. E3 (#183) implements the Office Hand: both attendant hooks (with ADR 0028's availability rule, #214), the relaying `Reach`, no estimate for the role, and the reports delivered on a call answered by them. E2 and E3 share the report and `Reach` code; whichever lands second extends the first's.

### 17. What E2, E3, R1 and T-LAB need

| Number | Value | Where |
|---|---|---|
| Driver asking wage | $2.50–$5.00 a day, by estimate | `ROLE_TERMS.DRIVER.dailyWage` |
| Driver signing cost | $15.00 | `ROLE_TERMS.DRIVER.signingCost` |
| Driver competence | 20–90 by candidate; risk ×1.5 (0) to ×0.5 (100) on risky roads | `CANDIDATE_POOL`, `COMPETENCE_RISK_PPM` |
| Where Drivers are found | Riverside Depot | `HIRING_PLACES` |
| Office Hand wage | $2.00 a day, fixed | `ROLE_TERMS.OFFICE_HAND.dailyWage` |
| Office Hand signing cost | $10.00 | `ROLE_TERMS.OFFICE_HAND.signingCost` |
| Where Office Hands are found | The general store | `HIRING_PLACES` |
| Run orders outstanding | 3 per Driver | `RUN_ORDER_LIMIT` |
| A run order without a deal lapses after | 2 days | `RUN_ORDER_HOLD_TICKS` |
| Competence revealed after | 3 runs | `COMPETENCE_REVEAL_RUNS` |
| Loading | the founder's `LOAD_TRUCK` (30 min) | `ACTIVITY_DURATIONS` |

R1's first-hire check is about the Distiller and needs nothing from this record. T-LAB's bots can hire a Driver and use run orders and regular runs through the same commands as the player.

## Design-record checklist (factory.md §1)

### 1. Non-leak, per command and surface

The inputs to every surface below are always-known state (founder whereabouts including `busy` and `call`, cash, agreements including employees, standing orders, run orders and deals with their `carrier`, geography including `PHONES`, `PLACE_HOURS` and `LIVE_VIEW_ROUTES`), knowledge, the live and call views, or a channel.

| Command or event | Immediate result | Activity item | Catch-up | Books row | Snapshot field |
|---|---|---|---|---|---|
| `ORDER_RUN` | Reasons in decision 15: agreements, `Reach` (founder state, the call, the answerer's role), known or viewed route condition, known contract progress plus run orders. Never stock, the truck or the Driver's whereabouts | `COMMAND` (inputs only) | None | Entry-less | `employees[].runOrders`; the deal leaves the founder's held list (`carrier`, an agreement) |
| Founder `DISPATCH_DELIVERY` naming an employee or a handed-over deal | `NO_DRIVER`, `DEAL_UNAVAILABLE`: from the command and agreements | `COMMAND` | None | None | None |
| `SET_STANDING_ORDER` (`DRIVE`), `HIRE_EMPLOYEE` (Driver, Office Hand) | ADR 0025's, plus decision 15's: terms, role, vehicles, buyers, routes (agreements and geography) | `COMMAND` | None | ADR 0025's | `employees`; an Office Hand's `competenceEstimate` is `null` (game-data) |
| `DISMISS_EMPLOYEE` (Driver) | Adds `RUN_ORDER_PENDING` from `runOrders` (agreements). Never from `work.run` | `COMMAND`; `REPORT` only if the Driver is at the station with lines pending (none, by the invariant) | None | Entry-less | `employees` |
| Driver's dispatch (`employees` phase) | None for the founder (ADR 0022 decision 5) | None | None | `DISPATCH:EMPLOYEE`, pending on the station's `FACILITY_STOCK` | None. The deal's world status isn't projected (decision 3) |
| Departure, or the road found closed | — | None | None | `DISPATCH:EMPLOYEE:UNLOADED`, pending as above | None; `ROUTE_FOUND_CLOSED` is news at the station |
| The stop | — | None, unless the founder is present at the buyer (live view) | None | `SALE:CARRIED`, pending on `VEHICLE_WHEREABOUTS` | None. Cash is unchanged |
| The return | — | `CASH_POSTING` items for `VEHICLE_RETURN` (existing row) and `SALE:HANDED_IN` (new row) | None | Both are cash postings, known | Cash; records `VEHICLE_WHEREABOUTS` with source `CASH_POSTING` |
| Deal with a carrier expires | — | None (decision 3) | None | None | None until the Driver's `RUN_LAPSED` arrives |
| Driver's report, in person or call out | — | `REPORT` | Arrival delivery shares the catch-up step | Observations clear entries with tick `< observedAt` | Records with source `REPORT`; `runOrders` loses `endedRuns` |
| Report message delivered | — | `MESSAGE_DELIVERED` carrying `report` | Unchanged | As above | As above |
| A call to the station (`CallOutAttendant`) | — | `CALL_PLACED`: the answerer comes from agreements and ADR 0028's availability rule (game-data and the tick) only (decision 10) | None | ADR 0024's | `founder.call` |
| A call in taken (`CallInAttendant`) | — | None until delivered | None | Entry-less | None |

**Hidden Driver state** (`work.run`, `work.endedRuns`, `work.lastRegularDay`, `report`, deliveries they dispatched, the world status of deals with a carrier, `RECEIVABLES`) never reaches the player snapshot except through a report, a message, a cash posting, news, or the live view of a place the founder stands at.

**`Reach` and the hooks read agreements only**, plus ADR 0028's availability rule, which reads agreements, game-data and the tick. Whether the Driver is at the station is hidden, so the Driver never answers the phone, orders to them are queued rather than refused when they're away, and dismissal is gated on the run-order list, not on whether they're out.

**The dynamic half.** ADR 0025's clause already counts a report whose content differs as a channel. Calls from the road are deferred (decision 9), so the only call a Driver places is ADR 0025's window-tick call from the station, whose argument ADR 0025 already makes. A run's cash postings are channels in their own right. K2's generators perturb Driver `work`, `report` (with `observations`), and the world status of deals with a carrier, as they perturb pending news and messages. **The founder's own trip draws** don't depend on Driver runs, because `tripCount` counts founder trips only and a Driver's draws are keyed by their own run count (decision 8).

### 2. Coverage tables (ADR 0021 decisions 6 and 7)

Decision 12: one new cash-posting row (`SALE:HANDED_IN`), three new books rows (`DISPATCH:EMPLOYEE`, `DISPATCH:EMPLOYEE:UNLOADED`, `SALE:CARRIED`), one rule-1 family (`PERSONNEL:RUN`), and the existing families a Driver's run shares with the founder's confirmed unchanged.

### 3. Migration

From save fields only (decision 14): the nullable `competenceEstimate` is a widening with no step; empty run orders, run state, observations and `endedRuns`; `carrier: null`; `RunOrder: 1`; and the two new `ReportContent` fields on saved messages and activity items, each read from the item's own `kind` and `report`. No game-data reads. `EMPLOYEE_PERFORMANCE` keeps its shape, so records, catch-up lines and journaled catch-up events need no step.

### 4. Re-locks

**None.** Verified against the ten `@locked` files under `packages/simulation/test`:

- **Every locked file runs the M001 scenario with `founderRules: false`**, where nothing here applies (decision 13): no Drivers, cash on delivery, `tripCount` as ADR 0022, `RECEIVABLES` 0.
- **`economy/fin-001.locked.test.ts`** builds a `DeliveryState` literal (lines 1104–1113) and spreads it into `deliveries`. This record adds no `DeliveryState` field (takings are derived, decision 7). Its balance-sheet helper reads `RECEIVABLES` (line 298), which stays 0 in its games. `KIND_DEFAULT` is a `Partial<Record<TransactionKind, …>>`, and no `TransactionKind` or account is added.
- **`progression/prog-001-outcome.locked.test.ts`** pins insolvency and the recovery horizon on the M001 scenario. The amendment (decision 7) only adds conditions that hold trivially when `RECEIVABLES` is 0.
- **`logistics/logistics.locked.test.ts`** (as O1a re-locks it, dispatching with `driver: { kind: "FOUNDER" }`) pins the founder's dispatch, sale and return postings, which are unchanged.
- **No locked file builds a `HeldDealState`, `EmployeeState`, `PendingReport` or `ReportContent`**, or enumerates `GAME_COMMAND_TYPES`, `RejectionCode`, `DYNAMIC_ID_KINDS`, `PHASES` or `TRANSACTION_PRODUCERS`.

The state-hash fixtures and the Sprint Zero reference hash (not locked) move with the new fields; the contract task regenerates them.

### 5. Tick order

Decision 11. No new phase. The Driver's step runs in `employees` (departure, lapses, the next run), the stop and return in `vehicles`, and a new step 0 of `founder` delivers lines `vehicles` wrote, so the report invariant holds within a tick. `ORDER_RUN` is instant in person and never `FOUNDER_BUSY`; on a call it uses ADR 0024's exemption through `busy.until`. Employees never read or change `busy`.

### 6. Flag off

Decision 13: `ORDER_RUN` is a no-op, no Driver or Office Hand can exist, sales stay cash on delivery, `tripCount` counts every dispatch, `carrier` stays null, and insolvency is unchanged. M001 and the lab play exactly as before.

### 7. Randomness

A Driver's trip draws come from `keyedRng(seed, "employee-trip:<vehicleId>:<characterId>", batchesRun)` (decision 8): a keyed one-shot stream, never a shared one, and its ordinal changes only with that Driver's own runs. The founder's trips keep ADR 0022's per-trip stream with `tripCount` counting founder trips only, so no hidden run can shift a draw the founder sees. Competence changes a threshold, not the number or order of draws. The candidate slate, competence and estimate for the new roles are ADR 0025's keyed draws; an Office Hand candidate skips the estimate draw (decision 1), which is keyed, so no other draw moves. The hooks (with ADR 0028's availability rule), `Reach` and run orders draw nothing. With the flag off, nothing here draws.

### 8. Rejection reasons

- **New:** `ORDER_NOT_FOR_ROLE { characterId, role }`, `NO_STANDING_ORDER { characterId }`, `RUN_ORDERS_FULL { characterId, limit }`, `RUN_ORDER_PENDING { characterId }`; `AuthorityLimit` gains `VEHICLE` and `RUN`.
- **Reused:** `INVALID_QUANTITY`, `UNKNOWN_ENTITY`, `DEAL_UNAVAILABLE`, `CARGO_DOES_NOT_MATCH_DEAL`, `NO_WAY_TO_REACH`, `VEHICLE_CAPACITY_EXCEEDED`, `NO_ROUTE`, `ROUTE_CLOSED`, `CONTRACT_NOT_ACTIVE`, `CARGO_DOES_NOT_MATCH_CONTRACT`, `BUYER_WILL_TAKE_LESS`, `NO_DRIVER`, `STATION_UNSUITABLE`, `POSITION_FILLED`, `OUTSIDE_AUTHORITY`, and every `DISPATCH_DELIVERY` reason for Driver commands.
- **Not reasons:** a Driver holding back, a run lapsing or turning back, a road found closed at departure, and a call ringing out or going unanswered are outcomes and report lines.

## Consequences

- **The Driver removes the round trip, not the decision.** The founder still decides what goes where (run orders), or decides it once (a regular run). What disappears is riding the truck. That's GDD §21's test: deliveries now happen without the founder there.
- **Handing over costs a visit or a phone with someone on it.** Without a line and an Office Hand, the founder gives run orders at the still. With both, from any phone the founder may use (ADR 0027, #213), while the Office Hand is available (ADR 0028, #214). That makes the phone and the Office Hand a pair, as GDD §20 and §21 intend: the line lets you call, and the Office Hand makes it worth calling.
- **The founder knows the money first and the story later.** Takings land in the purse when the truck is home, from anywhere. What happened on the road (how many Kessler took, a seizure, a closed road) waits for the Driver's report. A run order stays "not heard back on" until then, and at most three can be outstanding, so a founder who never checks in runs out of orders to give.
- **Back roads become a hiring question.** A good Driver on the shortcut is faster with little risk; a poor one loses loads. You find out which you hired after a few runs.
- **A road closed while loading doesn't cost a deal.** The Driver keeps it and tries again until the deal's expiry. That's kinder than ADR 0022's founder case only because the founder isn't there to take it back.
- **The Distiller answers the still's phone in their hours (ADR 0028, #214), but only the Office Hand relays.** If PT2/PT3 find that a Distiller who won't pass a message to the Driver feels wrong, decision 10's `Reach` is the one place to change, and the non-leak argument doesn't depend on it.
- **No cancelling run orders, and no dismissing a Driver who holds one,** in M002. Both are bounded by `expiresAt`, so a founder is never stuck for longer than a deal's life or `RUN_ORDER_HOLD_TICKS`.
- **Receivables are used for the first time.** Insolvency waits for takings riding home, and known net worth counts them from the known books.
- **Office Hand competence does nothing yet.** It's the cleanest place for a later reliability rule (a message garbled or lost), through ADR 0021's source field.

## Needs design (placeholders in this record)

These are story and visual direction (factory.md §8). They stay PLACEHOLDER until the human decides, and the orchestrator files or links `needs-design` issues for them (the milestone already lists "candidate names" and "where and how you find people to hire"):

- **Candidate names and who they are:** the three Drivers and two Office Hands in decision 1. "Ruth" is the GDD's own example of who takes a message. #209 approved a set of M002 names, as names only; ADR 0028 (#214) places them.
- **Where Drivers and Office Hands are found:** the freight depot for Drivers, the general store for Office Hands.
- **Hours: when the Office Hand and the Distiller answer, and when the Driver works.** Not open for this record: #209 §5 decided people sleep, and ADR 0028 (#214) defines the deterministic availability rule both hooks apply (decision 10) and whether it gates the Driver's step (decision 5).
- **How an Office Hand candidate reads with no competence estimate** in the hiring scene (decision 1): ADR 0028 (#214), with the rest of the scene.
- **Who at the still passes a message to whom:** whether a Distiller who answers should relay orders to the Driver (decision 10).
- **The hand-over scene and copy:** giving a run order, the regular-run form, how a Driver's report reads ("Kessler took 15 of 20, paid $270; the back road was clear"), the hand-in line in the books.
- **Calls from the road.** Settled in part by #203: a Driver never uses a buyer's private line (Kessler's) or a guest phone. Whether a Driver may call from a phone a stranger can use, during its hours and for its fee, is ADR 0027's (#213). This record defers road calls to it (decision 9).
- **Tuning (E2, E3, PT3, T-LAB):** every number in decision 17.
