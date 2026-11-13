# 0023: Presence, time of day, and rest

Status: accepted (decided by the orchestrator for M002 task D3, issue #170; implemented by the contract task it names and SK1)

Amended by ADR 0027 (#213, earned phone access and message-taking): decisions 2a (a founder-phase checkout step 5), 4 (the `CHECK_IN` activity) and 7 (a rented room is a rest place for its stay).

## Context

GDD §18 (PRES-001) makes the founder a piece on the map. Arriving at a place opens its scene, being there gates what the founder can do, and time costs represent meaningful in-world activity, not interface clicks. The founder needs sleep. GDD §16 (PLAY-001) says the day has a shape (places keep hours, the founder needs rest), and it sets the M002 pacing hypothesis: 1× = 1 game hour per 20 real seconds. It also notes the knock-on effect on session length.

ADR 0021 (the knowledge model) needs a definition of **present**: its live view is the founder's current place. It also assumes the founder's whereabouts are always known, and it leaves "departing" to this record. ADR 0022 (#169) owns the order/outcome split, the table of which gate each command needs, and the rejection reasons for every command except the three founder commands defined here (decision 3a). This record gives 0022 two mechanisms to cite: the founder's state, and how a command takes time.

M001 has no founder entity. The truck drives itself (ADR 0019), and every command applies from anywhere (ADR 0004). Routes join Hollow Creek to each buyer and to the depot; nothing joins the feed store, because buying never needed a trip.

## Decision

### 1. The founder's state

`GameState.founder` is a new required field. It holds **dynamic state only** (ADR 0008). The founder's identity is static: they're the personnel entry with role `FOUNDER` in game-data, so state doesn't store a character ID.

```ts
interface FounderState {
  readonly whereabouts: FounderWhereabouts;
  /**
   * The effective start of the founder's waking day: the tick a full rest ended,
   * moved forward by partial rests (decision 7). Drives tiredness.
   */
  readonly awakeSince: Tick;
}

type FounderWhereabouts =
  | { kind: "PRESENT"; locationId: LocationId;
      busy: { activity: ActivityKind; until: Tick } | null }        // decision 4
  | { kind: "TRAVELLING"; transport: Transport;
      path: readonly RouteLeg[]; legIndex: number;
      legDepartedAt: Tick; legArrivesAt: Tick;
      destinationLocationId: LocationId }
  | { kind: "ON_DELIVERY"; deliveryId: DeliveryId; vehicleId: VehicleId;
      /** Set on the tick the outbound leg resolves at its destination; see decision 2. */
      atStop: { locationId: LocationId; tick: Tick } | null }
  | { kind: "RESTING"; locationId: LocationId; startedAt: Tick; until: Tick };

type Transport = { kind: "FOOT" } | { kind: "VEHICLE"; vehicleId: VehicleId };
interface RouteLeg { readonly routeId: RouteId; readonly reversed: boolean }

type ActivityKind =
  | "BUY_MATERIALS" | "START_BATCH" | "LOAD_TRUCK" | "AGREE_DEAL" | "ACCEPT_CONTRACT"
  | "BUY_EQUIPMENT" | "SELL_EQUIPMENT" | "SET_WORKFORCE";

/** Who drives a delivery. Same shape as ADR 0022's issuer. */
type DriverRef = { kind: "FOUNDER" } | { kind: "EMPLOYEE"; characterId: CharacterId };
```

- **Carried goods:** in M002 the founder carries only the purse. Goods move on vehicles, and a vehicle's cargo is always known while the founder is aboard it. Carrying goods on foot isn't needed for any M002 action, so it's left out. It can be added later as a field.
- **All of `founder` is always known** (ADR 0021 decision 3). It goes into `PlayerSnapshot.founder` unchanged, plus derived display fields: the current leg's waypoints and progress for the map, and whether the founder is tired (decision 7).
- **Vehicles gain `parkedAt: LocationId | null`** (`VehicleState`). The invariant: it's `null` from the truck's departure until its return (or, on `TRAVEL`, from setting out until arrival or a halt), and otherwise names where it stands. A truck being loaded already has its `trip` (set at dispatch, with `departedAt` = the end of loading) but is still parked: `parkedAt` becomes `null` when the founder phase handles the departure (decision 2a). How a hired Driver is told "this truck is being loaded here" is ADR 0025's. This matches ADR 0021's `VEHICLE_WHEREABOUTS`. With `founderRules` on, a truck that isn't parked in the live view of the place the founder acts from (on a trip, carrying the founder, or parked elsewhere) is rejected with `VEHICLE_NOT_AT { vehicleId, locationId }`, where `locationId` is the founder's place, never the truck's (ADR 0022). That way the reason doesn't reveal `VEHICLE_WHEREABOUTS` once a hired Driver runs the truck. `VEHICLE_UNAVAILABLE` remains only for `founderRules` off.
- **Deliveries record their driver:** `DeliveryState.driver: DriverRef | null`. `null` means a pre-M002 delivery with no driver (decision 10).

### 2. What "present" means (for ADR 0021 and ADR 0022)

The founder is **present** at location L exactly when `whereabouts` is `PRESENT` at L, busy or not. Doing something at a place is still being there. **Commands that need presence (ADR 0022's gate table) use only this definition.** Anything else gets `NOT_PRESENT`.

**Observation also counts a stop on a delivery.** While `whereabouts` is `ON_DELIVERY` and `atStop.tick === state.tick`, the founder **observes** at `atStop.locationId`, which is the buyer for a sale or installment and the destination facility for a `TRANSFER`: ADR 0021's live view, catch-up and tick-end persist treat them as present there. That's what "face to face with the buyer" means in M002: the founder sees the hand-over and everything at the buyer that the live view covers, so the delivery's result is known. Agreeing new business there is a command, and it needs `PRESENT`. In M002 the founder can't step off the truck (decision 5), so new deals at a buyer need a separate trip. This replaces "plus the arrival tick" in ADR 0022 §3 for commands. **ADR 0022 must align: its presence gate is `PRESENT` only.**

The founder isn't present anywhere while `TRAVELLING`, `ON_DELIVERY` (apart from that observation tick), or `RESTING`. A sleeping founder doesn't watch the still: waking counts as an arrival, so ADR 0021's catch-up runs and shows what changed overnight. Travelling still refreshes the current route's `ROUTE_CONDITION` (ADR 0021 decision 5).

**Every end of presence persists the live view at that moment** (ADR 0021 decision 5, "departing"):

- by command: `TRAVEL` and `REST`, inside their transactions
- by tick: loading finishing and the founder riding out (decision 5), inside the founder phase (decision 2a).

### 2a. The founder phase in the tick order

Founder transitions run in a new **founder phase**. The kernel's full order (`#processTick`, `registry.ts` `PHASES`) becomes:

1. due commands, in `(scheduledTick, sequence)` order
2. `production`
3. `vehicles`
4. world events (`#resolveWorldEvents`: route closures and reopenings, shakedowns)
5. `resolution`
6. **`founder`** (new)
7. `deadlines`
8. `midnight` (on midnight ticks)
9. ADR 0021's persist step, then commit, emit and publish.

The founder phase runs after the vehicles phase, so this tick's arrivals and returns are visible to it. It also runs after world events, so leg starts and departures see this tick's closures, the same way dispatch validation does on the next tick. `founder` becomes a new entry in the kernel's `PHASES` (decision 11).

**When a busy activity ends.** A command applied at tick `t` (`state.tick + 1` for an eager command, ADR 0004) checks the busy gate as `busy !== null && busy.until ≥ t`, for **every** activity. So a timed command, `TRAVEL` or `REST` on the tick an activity ends is rejected with `FOUNDER_BUSY`. The founder phase handles the end of the activity later in that tick: a departure (`LOAD_TRUCK`) or simply the founder becoming free. The founder is free from the next tick. That way nothing can race the founder phase: a `TRAVEL`, `REST` or second dispatch on the departure tick can't override boarding the truck. `now + duration` in decision 4 uses the same `t`, so while paused it counts from `state.tick + 1`.

In order, the founder phase does this for the current tick:

1. **Busy ends:** if `busy.until ≤ tick`, clear it. If the activity was `LOAD_TRUCK`, it's the truck's departure:
   - If the trip's first route is open, persist the live view, become `ON_DELIVERY`, and set the truck's `parkedAt` to `null` (decision 5).
   - If it's closed (including a closure from this tick's world events), the truck doesn't set out. That's ADR 0022's `ROUTE_FOUND_CLOSED` at departure: the cargo is unloaded back into the facility, the founder stays `PRESENT`, and the route's `ROUTE_CONDITION` record is written directly, as `IN_PERSON`, because the founder is standing there.
2. **Travel legs:** if `legArrivesAt ≤ tick`, either start the next leg or arrive (decision 3). A vehicle leg that's closed halts the trip (decision 3).
3. **Delivery stops:** if the outbound leg of this founder's delivery resolved at its destination this tick and the cargo wasn't seized, set `atStop`. That covers a sale, an installment or a `TRANSFER`. If the truck returned this tick (`VEHICLE_RETURNED`), become `PRESENT` at the return location (decision 5).
4. **Waking:** if `RESTING` and `until ≤ tick`, become `PRESENT` at the same place (decision 7).

Every arrival in steps 2–4 (destination, halt, return, waking, a delivery stop) runs ADR 0021's **arrival catch-up** in this phase. An early `WAKE` runs the catch-up inside its own transaction instead (decision 7). The deadlines and midnight phases may change things later in the same tick, and the tick-end persist records the final values.

### 3. Travel

**A road network for the founder.** Founder travel uses the same `RouteDefinition`s as trucks, in either direction (`reversed`). M002 game-data adds a route from Hollow Creek to the feed store (PLACEHOLDER duration, name and waypoints; names are story, factory.md §8). Game-data validation checks that the route graph connects every location.

**New command: `TRAVEL`**

```ts
interface TravelCommand {
  readonly type: "TRAVEL";
  readonly destinationLocationId: LocationId;
  readonly transport: Transport;               // VEHICLE: a truck parked here, free
  readonly via: readonly RouteLeg[] | null;    // null: the default path (below)
}
```

- **A path is a simple path:** consecutive legs connect, it starts at the founder's place, it ends at the destination, and it visits no location twice. Simple paths keep the no-trap bound finite (decision 8).
- **The default path** is the shortest by total duration. By vehicle, it uses only routes the founder doesn't **know** to be closed (known `ROUTE_CONDITION` records and the live view, never the world), so choosing a path leaks nothing. On foot, closures are ignored, because they don't stop walkers. Ties break by `compareIds` on the route IDs in order.
- **Durations.** By vehicle, each leg takes the route's `durationTicks`. On foot, a leg takes `durationTicks × FOOT_TRAVEL_PPM / 1 000 000`, rounded up (game-data, PLACEHOLDER 3 000 000: walking is three times slower than the truck). Tiredness doesn't change travel (decision 7).
- **Leg by leg.** The actual route condition applies at the start of each leg. A closure stops **vehicles only**: a truck can't enter a closed route, but someone walking can always get through (decision 8 relies on this). If a vehicle leg's route is closed when the leg should start, the trip **halts**:
  - the founder becomes `PRESENT` at the junction, with the truck parked there
  - `FOUNDER_HALTED { routeId, locationId }` is emitted
  - the halt **writes that route's `ROUTE_CONDITION` record directly**, as `IN_PERSON`, whatever `LIVE_VIEW_ROUTES` says
  - the arrival catch-up runs at the junction.

  The founder was at the junction and saw the closure, so this leaks nothing.
- **Arrival:** the founder becomes `PRESENT` at the destination. If they drove, the truck's `parkedAt` becomes the destination. `FOUNDER_ARRIVED` is emitted, and the catch-up runs.
- **Departure** persists the live view inside the `TRAVEL` transaction (decision 2). By vehicle, it also sets the truck's `parkedAt` to `null`.
- **Risk:** the founder's own trips, on foot or driving the empty truck, aren't exposed to route risk in M002 (ADR 0019's risk applies to deliveries). Rivals and police targeting the founder come in a later milestone.
- **Cost:** travel costs time only. The truck's transport charge (ADR 0019) stays on deliveries. Driving yourself pays no transport cost in M002, a PLACEHOLDER simplification to revisit with fuel or wear.

Options considered for travel: free movement on the map grid (rejected: the simulation has no fractional positions, ADR 0003, and roads are what risk and closures attach to); teleporting with a fixed delay (rejected: the founder wouldn't pass through, or see, the roads); a route graph (chosen).

### 3a. Rejection reasons for the founder's commands

This record owns the rejection reasons for its three commands: `TRAVEL`, `REST` and `WAKE`. ADR 0022 owns the reasons for every other command. Each reason below depends only on always-known or known state, so showing it leaks nothing (ADR 0021 decision 9).

| Command | Failure | Reason |
|---|---|---|
| `TRAVEL` | The destination or a route in `via` doesn't exist | `UNKNOWN_ENTITY` (existing) |
| `TRAVEL` | The founder is travelling, riding or resting | **`FOUNDER_AWAY { whereabouts: "TRAVELLING" \| "ON_DELIVERY" \| "RESTING" }`** (new) |
| `TRAVEL` | The founder is busy | `FOUNDER_BUSY { until }` (ADR 0022) |
| `TRAVEL` | The destination is where the founder already is | **`ALREADY_THERE`** (new) |
| `TRAVEL` | `via` isn't a simple path from here to the destination | **`INVALID_PATH`** (new) |
| `TRAVEL` (vehicle) | No path avoids routes known to be closed | **`NO_PATH { destinationLocationId }`** (new) |
| `TRAVEL` (vehicle) | A route in `via` is known to be closed | `ROUTE_CLOSED` (existing; known) |
| `TRAVEL` (vehicle) | The truck isn't parked at the founder's place: on a trip, carrying the founder, or parked elsewhere | `VEHICLE_NOT_AT { vehicleId, locationId }` (ADR 0022), where `locationId` is the founder's place |
| `REST` | The founder is travelling, riding or already resting | `FOUNDER_AWAY` |
| `REST` | The founder is busy | `FOUNDER_BUSY` |
| `REST` | `untilTick` isn't within [`now + MIN_REST_TICKS`, `now + MAX_REST_TICKS`] | **`INVALID_REST_LENGTH { min, max }`** (new) |
| `WAKE` | The founder isn't resting | **`NOT_RESTING`** (new) |

**Check order.** When more than one row applies, the first one in ADR 0022 §1's gate order wins:

1. shape and identity (`UNKNOWN_ENTITY`, including an unknown `transport.vehicleId`, `INVALID_REST_LENGTH`)
2. presence and busy (`FOUNDER_AWAY`, `FOUNDER_BUSY`, `NOT_RESTING`)
3. validity against what the founder can see (`ALREADY_THERE`, `INVALID_PATH`, `VEHICLE_NOT_AT`, `ROUTE_CLOSED`, `NO_PATH`).

Within a step, table order wins.

**Units.** `INVALID_REST_LENGTH { min, max }` holds **absolute ticks**: the earliest and latest valid `untilTick` for the apply tick.

On foot there's always a path, because the graph is connected and walkers ignore closures. The mismatched-mode case can't happen: `Transport` is a discriminated union.

### 4. How a command takes time

GDD §18: presence gates what the founder can do, and time costs represent meaningful in-world activity, not interface clicks. The mechanism:

- **`ACTIVITY_DURATIONS`** (game-data) gives each `ActivityKind` a duration in ticks.
- **A timed command applies atomically when it's dispatched**, as every command does under ADR 0004: validation, reservations, payments and ledger entries all happen at once. The founder becomes **busy**: `PRESENT` with `busy: { activity, until: now + duration }`.
- **Physical effects that naturally follow the activity start when it ends.**
  - A truck leaves when loading is done (`departedAt = busy.until`). Its `arrivesAt` and any `dealDeadline` count from `departedAt`.
  - A production job's clock starts when the batch is set up (`startedAt = busy.until`).
  - Effects with no physical follow-on (a purchase, a signed contract, an agreed deal) are complete at once.
- **While busy**, the founder can't start another timed activity, travel, or rest (`FOUNDER_BUSY`). Instant commands at the same place are still allowed. Being busy is always known, so this leaks nothing.
- **Tired founders work slower:** while tired (decision 7), each `ACTIVITY_DURATIONS` value is multiplied by `TIRED_DURATION_PPM`, rounded up. Travel, riding and rest durations aren't affected.
- **A route closing while the truck is being loaded:** the departure at `busy.until` is the start of the trip's first leg, handled in the founder phase (decision 2a step 1). If the route is closed then, the truck doesn't set out. That's ADR 0022's `ROUTE_FOUND_CLOSED` outcome, applied at departure: the cargo is unloaded back into the facility, the founder stays `PRESENT`, and the route's `ROUTE_CONDITION` is recorded as `IN_PERSON` (decision 2a step 1 is the single definition). ADR 0019's "trips in flight are unaffected" applies from `departedAt` on.
- **Snapshot progress:** a job or trip whose `startedAt` or `departedAt` is still in the future must show 0 progress, not a negative value. That's for SK1's projection.

Options considered: applying the effect only when the activity ends (rejected: it would split every command into a reservation and a later completion, the work ADR 0022 is already doing for outcomes, and the effect would be invisible while paused); applying everything now and blocking the founder (chosen: it matches ADR 0004's eager apply, it's atomic, and the time cost is real, because the founder can't be anywhere else meanwhile).

**`ACTIVITY_DURATIONS` (M002 starting values, all PLACEHOLDER tuning for PT1):**

| `ActivityKind` | Command | Duration | Why it costs time |
|---|---|---|---|
| `BUY_MATERIALS` | `PURCHASE_MATERIALS` | 30 min | Picking, haggling, settling up |
| `START_BATCH` | `START_PRODUCTION` | 30 min | Setting up the still |
| `LOAD_TRUCK` | `DISPATCH_DELIVERY` (founder drives) | 30 min | Loading cases; the truck leaves after |
| `AGREE_DEAL` | `AGREE_DEAL` (ADR 0022) | 30 min | Settling price and quantity face to face |
| `ACCEPT_CONTRACT` | `ACCEPT_CONTRACT` | 60 min | A sit-down with the buyer |
| `BUY_EQUIPMENT` | `PURCHASE_EQUIPMENT` | 60 min | A deal plus installation |
| `SELL_EQUIPMENT` | `SELL_EQUIPMENT` | 60 min | A deal plus removal |
| `SET_WORKFORCE` | `SET_WORKFORCE` | 30 min | Talking to the men |
| — | `RELEASE_RESERVATION` | 0 | Instant: a decision, not an activity |
| — | `REPEAT_OPERATION` | The repeated command's activity | Same work as the first time |

Travel, riding a delivery and rest take their own time (decisions 3, 5, 7) and aren't in this table. Phone calls are ADR 0024's, and employees' work is ADR 0025's.

**Never costs time:** opening menus or scenes, reading the ledger, the catch-up or the activity feed, planning a route, pausing or changing speed, and collecting a payment already agreed (a sale's proceeds post on arrival). Repeated micro-steps after arriving somewhere aren't a design option: each place's actions are single commands (GDD §18).

### 5. The founder as the starting driver

- **A delivery needs a driver aboard.** `DISPATCH_DELIVERY` gains `driver: DriverRef | null`. A newly dispatched delivery must name a driver, or ADR 0022 rejects it with `NO_DRIVER`. `null` exists only in migrated pre-M002 commands and deliveries (decision 10). In M002 the founder is the only driver until a Driver is hired (ADR 0025).
- **When the founder drives,** they must be `PRESENT` and not busy at the facility where the truck is parked and the cargo is held. They load (`LOAD_TRUCK`, decision 4). At `busy.until` the founder phase persists the live view and sets `ON_DELIVERY`, and the truck sets out with `parkedAt: null`. The founder observes at the buyer on the arrival tick (decision 2), rides back on the return leg, and becomes `PRESENT` when the truck returns.
- **The dispatch origin is where the truck is, not its home.** Today `logistics.ts` takes the origin, the stock and the route from the vehicle's home facility (`planDispatch`), and `returnHome` books returned cargo into the home facility and reports `VEHICLE_RETURNED.locationId` as home. Those only agree in M001, because every dispatch starts from home. **SK1 changes this with `founderRules` on:**
  - The origin is the facility at the founder's place (later, a hired Driver's station, ADR 0025), recorded in `DeliveryState.fromFacilityId`.
  - Route resolution and the stock check use that facility.
  - The return leg reverses the outbound route back to it. On return, cargo is unloaded into `fromFacilityId`, `VEHICLE_RETURNED.locationId` is that facility's location, and the truck's `parkedAt` and the founder's `PRESENT` are set there.
  - A truck dispatched from the depot returns to the depot.

  With `founderRules` off, the origin stays the home facility, so M001 is unchanged.
- **The truck must be parked at the cargo's facility, which is where the founder is acting** (`VEHICLE_NOT_AT { vehicleId, locationId: the founder's place }` otherwise, ADR 0022, whatever the truck is doing).
- **Staying behind at the buyer** (letting the truck wait, or sending it on without the founder) is out of scope for M002. A truck can't move without a driver, and the founder rides the whole round trip.
- **Stranded trucks:** a truck parked somewhere whose only road out is closed with `reopensAt: null` can't be driven away until the scenario reopens the road (ADR 0019 decision 5). R1 (#176) and ADR 0020's soft-lock analysis must account for that.

ADR 0022 lists "a driver aboard" and "present at the truck" in its per-command gate table. The mechanics are here.

### 6. Place hours

- **`PLACE_HOURS`** (game-data) gives each location its opening hours as minute-of-day intervals. An interval may cross midnight (a back room open 20:00–02:00). A location with no entry is always open. **Your own facilities are always open.** Starting values (PLACEHOLDER, story and tuning): feed store 07:00–18:00; Kessler's Pharmacy 09:00–19:00; the Crossroads 11:00–23:00; Lakeview Hotel's back room 20:00–02:00; the depot always open.
- **Hours are geography and always known** (ADR 0021 decision 3). Whether a buyer is actually in on a given day isn't modelled in M002. If it is later, it becomes knowledge (a subject), never always-known.
- **Arriving at a closed place** is allowed. The founder is present outside. **This amends ADR 0021 decision 5:** at a place that's closed now, the live view covers only what can be seen from the road (`ROUTE_CONDITION` for its routes, and vehicles parked there). It doesn't cover the closed party's subjects (`SUPPLIER_OFFER`, `BUYER_*`, `CONTRACT_*`, `MARKET_PRICES`), or `STANDING`, which needs someone to deal with. The arrival catch-up and the clearing of `pendingBooks` use this filtered view, so `CONTRACT_PROGRESS` books at a closed buyer stay pending. ADR 0021's static non-leak property compares this filtered live view, and since hours are known, it's the same in both worlds.
- **Activities with the party** (buying, negotiating, accepting) need the place to be open when the activity **starts**. They may run past closing. Otherwise the command is rejected with `PLACE_CLOSED { locationId, opensAt }` (ADR 0022), computed from known hours.
- **Deliveries arrive any hour.** A truck reaching a buyer outside their hours still hands over through the back door, as in M001. Hours shape the founder's dealings, not freight. If the founder is riding, they observe the hand-over (decision 2): its result (ADR 0022's settlement events) and the delivery's own subjects (`VEHICLE_WHEREABOUTS`, and `CONTRACT_PROGRESS` if it's an installment) are known. The closed-hours filter still hides the buyer's other subjects. This is a tuning choice PT1 can revisit.
- Day-of-week hours (closed on Sundays) are left out of M002. The date is already in the snapshot, so they can be added in game-data later.

### 7. Rest

GDD §18: rest is a required part of the day's time budget, with a clear time cost, no meter to babysit, a mild provisional tradeoff for late nights, and never a trap.

- **Commands:** `REST { untilTick }` and `WAKE`.
  - `REST` starts `RESTING` at the founder's current place until `untilTick`, which must be between `now + MIN_REST_TICKS` and `now + MAX_REST_TICKS` (game-data, PLACEHOLDER 2 h and 14 h). It persists the live view first (decision 2).
  - The UI offers **"rest until morning"** as one click. It sends `untilTick = clamp(next WAKE_HOUR, now + MIN_REST_TICKS, now + MAX_REST_TICKS)`, where `WAKE_HOUR` is game-data (PLACEHOLDER 06:00) and "next" is the first one after `now + MIN_REST_TICKS`. So at 04:30 it's 06:00 the next day if that's within the maximum, otherwise the maximum. The UI computes it from a snapshot that may be up to one scheduler batch behind the apply tick (`MAX_TICKS_PER_STEP` = 60, ADR 0014). An eager command can apply up to 61 ticks after the snapshot (a 60-tick batch in flight, then `state.tick + 1`). So the UI uses margins: it clamps into [`now + MIN_REST_TICKS + 61`, `now + MAX_REST_TICKS − 60`], and the one-click form can't get `INVALID_REST_LENGTH`. While paused, the snapshot is exact. There are no hourly bedtime clicks.
  - `WAKE` ends a rest early. It's instant. In its own transaction the founder becomes `PRESENT`, the arrival catch-up runs, and recovery counts `rested = apply tick − startedAt`.
  - When the rest ends, the founder wakes and becomes `PRESENT` at the same place, and the catch-up runs (decision 2a).
- **Where:** anywhere the founder is present. **Rest places** (`REST_PLACES`, game-data: the cot at Hollow Creek, PLACEHOLDER; a home is story) give a full rest in `FULL_REST_TICKS` (PLACEHOLDER 8 h). Anywhere else is sleeping rough (the truck cab, a back room), which needs `ROUGH_REST_TICKS` (PLACEHOLDER 12 h) for a full rest. Resting is never refused because of where the founder is. GDD §18 speaks of resting "at a place where the founder can sleep". This record deliberately reads that as "anywhere, with rest places better", for the no-trap rule (decision 8).
- **Tiredness is one rule, not a meter.** The founder is **tired** when `now − awakeSince > TIRED_AFTER_TICKS` (PLACEHOLDER 18 h). While tired, `ACTIVITY_DURATIONS` values are multiplied by `TIRED_DURATION_PPM` (PLACEHOLDER 1 500 000: 50% longer). That's the whole penalty. There's no collapse, no randomness, no lost money, nothing is refused, and travel, riding and rest are unaffected. Late nights are allowed and cost time the next day, which is the tradeoff GDD §18 asks for.
- **Recovery:**
  - A rest of at least the full length for that place sets `awakeSince` to the wake tick.
  - A shorter rest (woken early, or a short block) moves `awakeSince` forward by `rested × TIRED_AFTER_TICKS / fullRestTicks` (integer division, floor), capped at the wake tick. Half a night's sleep buys half a day.
  - All integer arithmetic, no floats.
- **The world doesn't wait.** While the founder rests, every system runs as usual: production, deliveries, markets, contracts, and later employees' standing orders. Resting is the founder's state, not a simulation mode. Pause works as always, and ticks are unchanged.
- **Starting state:** a new M002 game starts with the founder `RESTING` at Hollow Creek from tick 0 (00:00) until `START_WAKE_TICK` (game-data, PLACEHOLDER 06:00), with `awakeSince = 0`. The first morning starts naturally. The start location is the M002 scenario's `founderStartLocationId` (game-data).

### 8. No traps (provable)

From any state, the founder can rest within a bounded number of ticks, and no state blocks progress because of rest. Proof sketch for the locked property test (SK1):

1. **`REST` is refused only while the founder is `TRAVELLING`, `ON_DELIVERY`, `RESTING` or busy** (`FOUNDER_AWAY`, `FOUNDER_BUSY`), or for an out-of-range `untilTick`, which the one-click form never sends. It's never refused for location, hours, cash or tiredness. Counting starts from the tick the player stops issuing other founder commands. Commands already queued for later ticks apply before a fresh command on their tick (ADR 0004), and there's no way to cancel them, so they extend the wait. The bound below accounts for that.
2. **Each of those states ends in bounded time:**
   - busy ends at `busy.until` (at most the longest `ACTIVITY_DURATIONS` value × the tired factor)
   - a rest ends at its `until` (at most `MAX_REST_TICKS`)
   - a delivery ends when the truck gets home: two route durations, plus at most `delayTicks` (ADR 0019), plus loading
   - travel ends at the destination or at a halt, on a simple path (decision 3).
3. **Walking is never blocked:** closures stop vehicles only, and the route graph is connected (validated). The founder can always walk to a rest place, and resting where they stand is allowed anyway.
4. **Tiredness only lengthens activity durations, by a bounded factor.** It never makes a command invalid: no command requires being rested, and no rejection reason mentions tiredness.

The bound for the test is `B = max(`longest `ACTIVITY_DURATIONS` × `TIRED_DURATION_PPM`, `MAX_REST_TICKS`, the longest delivery round trip + `delayTicks` + the longest `LOAD_TRUCK` duration × `TIRED_DURATION_PPM`, the longest simple path's duration on foot (× `FOOT_TRAVEL_PPM`) and by vehicle`)`, all computed from game-data.

The property: from any reachable state, if from tick `now` the player issues only the one-click `REST` each tick, it's accepted at an apply tick no later than `now + max(0, Q − now) + B + 1`, where `Q` is the latest `scheduledTick` among queued founder commands (or `now` if there are none). The `+ 1` is because founder-phase transitions (finishing an activity, arriving, returning, waking) take effect after that tick's commands, and the busy gate's `≥` holds the founder for the end tick itself. So `REST` is accepted from the next tick. Also, the set of commands a rested founder could dispatch is the same as a tired one's, apart from durations.

### 9. Pacing

- **Pacing becomes per-scenario game-data.** `ScenarioDefinition` gains `realMsPerGameHourAt1x` and `founderRules: boolean`.
  - **The M001 scenario keeps 5 000 and `founderRules: false`.** The lab and its M001 targets keep working until T-LAB (#184).
  - **The M002 scenario uses 20 000 and `founderRules: true`.** That's 3 ticks per real second at 1×, 8 real minutes per game day, 4 at 2× and 2 at 4×.
  - `REAL_MS_PER_GAME_HOUR_AT_1X` in `packages/game-data/src/pacing.ts` becomes the default the M001 scenario uses (5 000, unchanged). The worker's scheduler reads the loaded scenario's value instead of the constant (ADR 0014 decision 9).
  - The tick (1 game minute), the accumulator, its integer arithmetic and the batch bounds don't change.
- **With `founderRules: false`**, the founder state still exists (the save shape is the same), but it never gates anything and **never changes**:
  - ADR 0022's presence gate passes everywhere, deliveries need no driver, and no command takes the founder's time.
  - A dispatch with `driver: FOUNDER` doesn't put the founder aboard.
  - `TRAVEL`, `REST` and `WAKE` apply as no-ops: they're accepted, change **no domain state**, and post no transaction. `LOCKED` doesn't fit, because it carries an `unlockId`, and a no-op needs no new reason. Like any applied command, their envelopes still go into `commandLog`, so `stateHash` moves. Lab strategies don't send them.
  - `LOAD_TRUCK` sets no `busy`, so a delivery's `departedAt` is the dispatch tick, as in M001.
  - The founder phase does nothing.

  So a migrated or lab M001 run plays exactly as today. Its state differs only by the new fields. Because of those fields, the Sprint Zero and fixture state hashes still move, and the contract task regenerates them (alongside ADR 0022's per-trip RNG change, which SK1 owns). That's ADR 0022's lab mode, and it never reaches the M002 game.
- **Overnight pacing.** At 8 minutes per game day, a night would be about 2.7 real minutes of watching the founder sleep. Instead, **while the founder is `RESTING` and the game is running**, the worker's scheduler runs at `REST_SPEED_MULTIPLIER` × 1× (game-data, PLACEHOLDER 16), whatever speed the player chose, so 8 hours of sleep take 10 real seconds.
  - It's not a player `Speed`: the scheduler's `Speed` stays `0 | 1 | 2 | 4`. The fast-forward is a separate internal rate. The status that rides on `SNAPSHOT` (ADR 0014 decision 7) adds a `fastForward: boolean` so the UI can say so.
  - It drops back to the player's speed when the founder wakes, or as soon as an activity item whose importance is `notify` lands in `knowledge.activity` (ADR 0021 decision 8). Importance comes from a new **`ACTIVITY_IMPORTANCE`** table keyed by activity item kind, never from world events (ADR 0021 decision 2), so the speed change leaks nothing.
  - The scheduler reads the founder's whereabouts and the activity from the player snapshot. Determinism is unaffected, because the scheduler only chooses batch sizes (ADR 0014 Consequences).
- **The knock-on (GDD §16).** At M002 pacing, a game day is about 16 waking hours at 20 s per hour (≈ 5.3 min) plus about 8 hours of fast-forwarded sleep (≈ 10 s), so ≈ 5.5 real minutes at 1×. M001's ~15-day victory would take ≈ 83 real minutes at 1×, or ≈ 42 at 2×, against M001's 20–30 minute target. This record doesn't retune victory. PT1 (#175) judges the day length, and T-LAB (#184) owns the retune (victory thresholds, contract timing, or fewer days) and the M002 lab targets, measured in game days and converted with the M002 scenario's pacing and this rest model.

### 10. Saves

- `GameState.founder`, `VehicleState.parkedAt` and `DeliveryState.driver` are required, and `DISPATCH_DELIVERY` gains `driver`, so `SAVE_SCHEMA_VERSION` bumps (ADR 0009). It's one bump together with K1's if both land in the same release, otherwise a second bump.
- **M001 saves migrate from the save alone**, without reading game-data (ADR 0009):
  - **The founder's placement is a frozen copy.** The migration holds the M001 scenario's one start location as a literal: `hollow-creek` for `scenarioId` `first-shipment`. This is frozen migration code, not a game-data read, so later edits to game-data don't change what a v1 save becomes. A v1 save with any other `scenarioId` fails with `MIGRATION_FAILED`. The founder becomes `PRESENT` there, not busy, with `awakeSince` = the save's tick.
  - **Vehicles:** an idle truck (`trip: null`) gets `parkedAt: "hollow-creek"` by the same frozen rule (M001's one truck lives there). A truck with a trip gets `parkedAt: null`.
  - **Deliveries and commands:** every `DeliveryState` gets `driver: null`, and so does every `DISPATCH_DELIVERY` envelope in `commandLog` and `queuedCommands`. `null` means a pre-M002 dispatch with no driver. Such deliveries complete as in M001, and the founder isn't aboard. A queued dispatch with `driver: null` that applies after the migration is rejected under the M002 rules when `founderRules` is on (`NO_DRIVER`, ADR 0022), and accepted as before when it's off. Replay derives the same outcome either way, because the rules come from the scenario.
  - M001 saves load into the M001 scenario (`founderRules: false`), so in practice migrated games play exactly as before, with the founder sitting at Hollow Creek.

### 11. Contract changes (their own task)

The changes below go in one contract-change task (factory.md §7.3), filed when this ADR merges:

- `state.ts`: `FounderState`, `FounderWhereabouts`, `Transport`, `RouteLeg`, `ActivityKind`, `DriverRef`, `GameState.founder`; `VehicleState.parkedAt: LocationId | null`; `DeliveryState.driver: DriverRef | null`.
- `commands.ts`: `TRAVEL`, `REST`, `WAKE` (types, `GAME_COMMAND_TYPES`, docs table); `DISPATCH_DELIVERY.driver: DriverRef | null`; the new rejection reasons in decision 3a (`FOUNDER_AWAY`, `ALREADY_THERE`, `INVALID_PATH`, `NO_PATH`, `INVALID_REST_LENGTH`, `NOT_RESTING`). `FOUNDER_BUSY`, `VEHICLE_NOT_AT`, `PLACE_CLOSED`, `NOT_PRESENT` and `NO_DRIVER` come from ADR 0022's task; whichever task lands first adds the shared ones.
- `events.ts`: `FOUNDER_DEPARTED { from, to, transport }`, `FOUNDER_ARRIVED { locationId }`, `FOUNDER_HALTED { routeId, locationId }`, `FOUNDER_RESTED { locationId, until }`, `FOUNDER_WOKE { locationId, early }`. The contract task finalises the payloads, using these fields at least. New union members don't bump the save version.
- `knowledge.ts` / `player-snapshot.ts`: `ACTIVITY_IMPORTANCE` keyed by activity item kind (extending K1's `ActivityItem`), and the `founder` section (decision 1), extending K1's `PlayerSnapshot`.
- `schemas.ts`, `save.ts`: Zod schemas, and the bump and migration from decision 10, with an old-version fixture test.
- `packages/game-data`:
  - types and starting values for `ACTIVITY_DURATIONS`, `FOOT_TRAVEL_PPM`, `PLACE_HOURS`, `REST_PLACES`, `MIN_REST_TICKS`, `MAX_REST_TICKS`, `FULL_REST_TICKS`, `ROUGH_REST_TICKS`, `TIRED_AFTER_TICKS`, `TIRED_DURATION_PPM`, `WAKE_HOUR`, `START_WAKE_TICK`, `REST_SPEED_MULTIPLIER`
  - `ScenarioDefinition.realMsPerGameHourAt1x`, `founderRules` and `founderStartLocationId` (the M001 scenario: 5 000, `false`, Hollow Creek)
  - the new feed-store route, and validation that the route graph is connected
  - `packages/game-data/test/pacing.test.ts` updated for per-scenario pacing (M001 still 5 000).
- `packages/simulation/src/kernel/registry.ts` and `simulation.ts`: `founder` added to `PHASES` and run between `resolution` and `deadlines` (decision 2a). Its hooks are SK1's.
- `apps/game/src/workers/scheduler.ts`: reads the scenario's pacing, plus the rest fast-forward and the `fastForward` status flag.
- `tools/economy-lab/src/targets.ts`: `TICKS_PER_REAL_MINUTE` comes from the M001 scenario's pacing (unchanged at 720), so the M001 targets keep their meaning until T-LAB.

It depends on K1 (#188) for `PlayerSnapshot` and `ActivityItem`. SK1 (#173) implements the behaviour.

## Consequences

- **Every command now has a "where is the founder" question.** ADR 0022's gate table answers it per command, using decision 2's definition (`PRESENT` only) and decision 4's mechanism.
- **ADR 0022 must align on three points:** its presence gate is `PRESENT` only, with no arrival-tick exception for commands (decision 2); `ROUTE_FOUND_CLOSED` also covers a closure found at departure after loading (decision 4); and `NO_DRIVER` rejects new dispatches with `driver: null` while `founderRules` is on (decision 10).
- **M001 strategies change only in the M002 scenario.** The lab keeps running the M001 scenario with `founderRules: false` and its own pacing, so `tools/economy-lab/src/targets.ts` and the nightly report keep their M001 meaning. T-LAB (#184) adds M002 targets and teaches the bots travel and rest.
- **Production and deliveries now take the founder's time.** With one truck and a founder who must drive it, every sale is a round trip away from the still. That's the M002 pressure GDD §16 wants. The first-hire reachability check (R1, #176) has to show it's survivable, including stranded trucks (decision 5).
- **Pacing differs by scenario.** M001 e2e tests keep M001 pacing. M002 e2e tests use `window.__eov.advance` (unaffected), and any Playwright real-time tolerance checks need M002 values.
- **Late-night penalties stay mild until playtests say otherwise.** Anything harsher (lost skill, mistakes, collapse) needs a later design decision (GDD §18).
- **Later milestones** can add carried goods, stepping off the truck, risk on the founder's own trips, and day-of-week hours as fields and game-data, without changing the shape of the founder's state.
