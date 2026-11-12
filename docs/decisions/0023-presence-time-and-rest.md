# 0023: Presence, time of day, and rest

Status: accepted (decided by the orchestrator for M002 task D3, issue #170; implemented by the contract task it names and SK1)

## Context

GDD §18 (PRES-001) makes the founder a piece on the map. Arriving at a place opens its scene, being there gates what the founder can do, and time costs represent meaningful in-world activity, not interface clicks. The founder needs sleep. GDD §16 (PLAY-001) says the day has a shape (places keep hours, the founder needs rest), and it sets the M002 pacing hypothesis: 1× = 1 game hour per 20 real seconds. It also notes the knock-on effect on session length.

ADR 0021 (the knowledge model) needs a definition of **present**: its live view is the founder's current place. It also assumes the founder's whereabouts are always known. ADR 0022 (#169, written in parallel) owns the order/outcome split, the table of which gate each command needs, and rejection reasons in general. This record gives it two mechanisms to cite: the founder's state, and how a command takes time.

M001 has no founder entity. The truck drives itself (ADR 0019), and every command applies from anywhere (ADR 0004). Routes join Hollow Creek to each buyer and to the depot; nothing joins the feed store, because buying never needed a trip.

## Decision

### 1. The founder's state

`GameState.founder` is a new required field:

```ts
interface FounderState {
  readonly characterId: CharacterId;               // the FOUNDER from personnel data
  readonly whereabouts: FounderWhereabouts;
  /** The last tick the founder finished a rest (decision 7). Drives tiredness. */
  readonly awakeSince: Tick;
}

type FounderWhereabouts =
  | { kind: "PRESENT"; locationId: LocationId;
      busy: { activity: ActivityKind; until: Tick } | null }        // decision 4
  | { kind: "TRAVELLING"; mode: "FOOT" | "VEHICLE"; vehicleId: VehicleId | null;
      path: readonly RouteLeg[]; legIndex: number;
      legDepartedAt: Tick; legArrivesAt: Tick;
      destinationLocationId: LocationId }
  | { kind: "ON_DELIVERY"; deliveryId: DeliveryId; vehicleId: VehicleId }
  | { kind: "RESTING"; locationId: LocationId; startedAt: Tick; until: Tick };

interface RouteLeg { readonly routeId: RouteId; readonly reversed: boolean }
```

- **Carried goods:** in M002 the founder carries only the purse. Goods move on vehicles, and a vehicle's cargo is always known while the founder is aboard it (`ON_DELIVERY`, or `TRAVELLING` with `mode: "VEHICLE"`). Carrying goods on foot isn't needed for any M002 action, so it's left out. It can be added later as a field.
- **All of `founder` is always known** (ADR 0021 decision 3). It goes into `PlayerSnapshot.founder` unchanged, plus derived display fields: the current leg's waypoints and progress for the map, and whether the founder is tired (decision 7).
- **Vehicles gain `parkedAt: LocationId`** (`VehicleState`). In M001 a truck is always at its home facility when idle. In M002 the founder can drive it elsewhere (decision 3), and ADR 0021's `VEHICLE_WHEREABOUTS` already expects `parkedAt`. A truck still turns for home after a delivery, as today.

### 2. What "present" means (for ADR 0021)

The founder is **present** at location L exactly when:

- `whereabouts` is `PRESENT` at L, busy or not. Doing something at a place is still being there.
- or `whereabouts` is `ON_DELIVERY` and the delivery's truck **arrives at L on this tick**. The founder is present at the buyer for the arrival tick, so ADR 0021's tick-end persist records what they saw at the hand-over. They're also present at the origin when the delivery is dispatched, because dispatching requires `PRESENT` there (decision 5).

The founder is **not present** anywhere while `TRAVELLING`, while `ON_DELIVERY` (except the arrival tick), or while `RESTING`. A sleeping founder doesn't watch the still: waking counts as an arrival, so ADR 0021's catch-up runs and shows what changed overnight. Travelling still refreshes the current route's `ROUTE_CONDITION` (ADR 0021 decision 5).

### 3. Travel

**A road network for the founder.** Founder travel uses the same `RouteDefinition`s as trucks, in either direction (`reversed`). M002 game-data adds a route from Hollow Creek to the feed store (PLACEHOLDER duration, name and waypoints; names are story, factory.md §8). Game-data validation checks that the route graph connects every location, so every place is reachable.

**New command: `TRAVEL`**

```ts
interface TravelCommand {
  readonly type: "TRAVEL";
  readonly destinationLocationId: LocationId;
  readonly mode: "FOOT" | "VEHICLE";
  readonly vehicleId: VehicleId | null;       // required for VEHICLE: a truck parked here, not on a delivery
  readonly via: readonly RouteLeg[] | null;   // null: the default path (below)
}
```

- **The default path** is the shortest by total duration over routes the founder doesn't **know** to be closed. It uses known `ROUTE_CONDITION` records and the live view (ADR 0021), never the world, so choosing a path leaks nothing. Ties break by `compareIds` on the route IDs in order.
- **Durations.** By vehicle, each leg takes the route's `durationTicks`. On foot, a leg takes `durationTicks × FOOT_TRAVEL_PPM / 1 000 000`, rounded up (game-data, PLACEHOLDER 3 000 000: walking is three times slower than the truck).
- **Leg by leg.** At the start of each leg the actual route condition applies. A closure stops **vehicles only**: a truck can't enter a closed route, but someone walking can always get through (decision 8 depends on this). If a vehicle leg's route is closed when the leg should start, the trip **halts**: the founder becomes `PRESENT` at the junction with the truck parked there, and `FOUNDER_HALTED { routeId }` is emitted. The founder was at that junction and saw the closure, so this leaks nothing, and the live view records the closure.
- **Arrival:** the founder becomes `PRESENT` at the destination. If they drove, the truck's `parkedAt` becomes the destination. `FOUNDER_ARRIVED` is emitted, and ADR 0021's catch-up runs.
- **Departure** ends the founder's presence, so ADR 0021's persist-on-departure applies inside the `TRAVEL` transaction.
- **Risk:** the founder's own trips, on foot or driving the empty truck, aren't exposed to route risk in M002 (ADR 0019's risk applies to deliveries). Rivals and police targeting the founder come in a later milestone.
- **Cost:** travel costs time only. The truck's transport charge (ADR 0019) stays on deliveries; driving yourself pays no transport cost in M002. That's a PLACEHOLDER simplification to revisit with fuel or wear.

Options considered for travel: free movement on the map grid (rejected: the simulation has no fractional positions, ADR 0003, and roads are what risk and closures attach to); teleport with a fixed delay (rejected: the founder wouldn't pass through, or see, the roads); a route graph (chosen).

### 4. How a command takes time

GDD §18: presence gates what the founder can do, and time costs represent meaningful in-world activity, not interface clicks. The mechanism:

- **`ACTIVITY_DURATIONS`** (game-data) gives each founder activity a duration in ticks. Activities with duration 0 are **instant**.
- **A timed command applies atomically when it's dispatched**, as every command does under ADR 0004: validation, reservations, payments and ledger entries all happen at once. The founder becomes **busy**: `PRESENT` with `busy: { activity, until: now + duration }`.
- **Physical effects that naturally follow the activity start when it ends.** A truck leaves when loading is done (`departedAt = busy.until`). A production job's clock starts when the batch is set up (`startedAt = busy.until`). Effects with no physical follow-on (a purchase, a signed contract) are complete at once.
- **While busy**, the founder can't start another timed activity, travel, or rest. Instant activities at the same place are still allowed. ADR 0022 defines the rejection reason (expected: `FOUNDER_BUSY { until }`). Being busy is always known, so this rejection leaks nothing.
- **Tired founders take longer.** While tired (decision 7), each duration is multiplied by `TIRED_DURATION_PPM`, rounded up.

Options considered: applying the effect only when the activity ends (rejected: it would split every command into a reservation and a later completion, the work ADR 0022 is already doing for outcomes, and the effect would be invisible while paused); applying everything now and blocking the founder (chosen: it matches ADR 0004's eager apply, it's atomic, and the time cost is real because the founder can't be anywhere else meanwhile).

**`ACTIVITY_DURATIONS` (M002 starting values, all PLACEHOLDER tuning for PT1):**

| Activity | Duration | Why it costs time |
|---|---|---|
| Buying materials at the feed store | 30 min | Picking, haggling, settling up |
| Starting a production batch | 30 min | Setting up the still |
| Loading the truck for a delivery | 30 min | Loading cases (the truck leaves after) |
| Negotiating and accepting a contract | 60 min | A sit-down with the buyer |
| Buying or selling equipment | 60 min | A deal plus installation or removal |
| Changing the workforce | 30 min | Talking to the men |
| Driving a delivery | the trip | The founder is aboard (decision 5) |
| Travel | the route legs | Decision 3 |
| Rest | the rest block | Decision 7 |
| Releasing a reservation | 0 | Instant: a decision, not an activity |
| `REPEAT_OPERATION` | the repeated activity's duration | Same work as the first time |

**Never costs time:** opening menus or scenes, reading the ledger, the catch-up or the activity feed, planning a route, pausing or changing speed, and collecting a payment already agreed (a sale's proceeds post on arrival, ADR 0005). Repeated micro-steps after arriving somewhere aren't a design option: each place's actions are single commands (GDD §18).

### 5. The founder as the starting driver

- **A delivery needs a driver aboard.** `DISPATCH_DELIVERY` gains `driverCharacterId: CharacterId`. In M002 the founder is the only driver until a Driver is hired (ADR 0025).
- **When the founder drives,** they must be `PRESENT` and not busy at the facility where the truck is parked and the cargo is held. Loading takes its activity time (decision 4). Then the founder becomes `ON_DELIVERY`, rides out, is present at the buyer on the arrival tick (decision 2), rides home on the return leg, and becomes `PRESENT` at the home facility when the truck returns (`VEHICLE_RETURNED`). Arriving home runs the catch-up.
- **The truck must be parked at the cargo's facility.** In M002, `fromFacilityId` is where the truck is parked, and dispatching a truck parked elsewhere is rejected (reason in ADR 0022).
- **Staying behind at the buyer** (letting the truck wait, or sending it home without the founder) is out of scope for M002. A truck can't move without a driver, and the founder rides the whole round trip.
- **Grandfathered trips:** a delivery already in flight in a migrated M001 save completes without a driver, as M001 did (decision 10).

ADR 0022 lists "a driver aboard" and "present at the truck" in its per-command gate table. The mechanics are here.

### 6. Place hours

- **`PLACE_HOURS`** (game-data) gives each location its opening hours as minute-of-day intervals. An interval may cross midnight (a back room open 20:00–02:00). A location with no entry is always open. **Your own facilities are always open.** Starting values (PLACEHOLDER, story and tuning): feed store 07:00–18:00; Kessler's Pharmacy 09:00–19:00; the Crossroads 11:00–23:00; Lakeview Hotel's back room 20:00–02:00; the depot always open.
- **Hours are geography and always known** (ADR 0021 decision 3). Whether a buyer is actually in on a given day isn't modelled in M002. If it is later, it becomes knowledge (a subject), never always-known.
- **Arriving at a closed place** is allowed. The founder is present outside: the live view still covers what can be seen from the road (`ROUTE_CONDITION` for its routes, vehicles parked there). Nothing belonging to the closed party is covered (`SUPPLIER_OFFER`, `BUYER_*`, `CONTRACT_*`, `MARKET_PRICES`), and neither is `STANDING`, which needs someone to deal with. ADR 0021's `LIVE_VIEW_ROUTES` table is unchanged; the closed-hours filter applies on top of it.
- **Activities with the party** (buying, negotiating) need the place to be open when the activity **starts**. It may run past closing. The rejection reason is ADR 0022's (expected: `PLACE_CLOSED { opensAt }`). It's computed from hours, which are known, so it leaks nothing.
- **Deliveries arrive any hour.** A truck reaching a buyer outside their hours still hands over through the back door, as in M001. Hours shape the founder's dealings, not freight. This is a tuning choice PT1 can revisit.
- Day-of-week hours (closed on Sundays) are left out of M002. The date is already in the snapshot, so they can be added in game-data later.

### 7. Rest

GDD §18: rest is a required part of the day's time budget, with a clear time cost, no meter to babysit, a mild provisional tradeoff for late nights, and never a trap.

- **Commands:** `REST { untilTick }` and `WAKE`.
  - `REST` starts `RESTING` at the founder's current place until `untilTick`, which must be between `MIN_REST_TICKS` and `MAX_REST_TICKS` ahead (game-data, PLACEHOLDER 2 h and 14 h). The UI offers "rest until morning" (a whole block) as one click. There are no hourly bedtime clicks.
  - `WAKE` ends a rest early. It's instant.
  - When the block ends, the founder wakes and becomes `PRESENT` at the same place, and the catch-up runs (decision 2).
- **Where:** anywhere the founder is present. **Rest places** (`REST_PLACES`, game-data: the cot at Hollow Creek, PLACEHOLDER; a home is story) give a full rest in `FULL_REST_TICKS` (PLACEHOLDER 8 h). Anywhere else is sleeping rough (the truck cab, a back room), which needs `ROUGH_REST_TICKS` (PLACEHOLDER 12 h) for a full rest. Resting is never refused for where the founder is.
- **Tiredness is one rule, not a meter.** The founder is **tired** when `now − awakeSince > TIRED_AFTER_TICKS` (PLACEHOLDER 18 h). While tired, activity durations are multiplied by `TIRED_DURATION_PPM` (PLACEHOLDER 1 500 000: 50% longer). That's the whole penalty. There's no collapse, no randomness, no lost money, and nothing is refused. Late nights are allowed and cost time the next day, which is the tradeoff GDD §18 asks for.
- **Recovery:**
  - A completed rest of at least the full length for that place sets `awakeSince` to the wake tick.
  - A shorter rest (woken early, or a short block) moves `awakeSince` forward by `rested × TIRED_AFTER_TICKS / fullRestTicks` (integer division, floor), capped at the wake tick. Half a night's sleep buys half a day.
  - All integer arithmetic, no floats.
- **The world doesn't wait.** While the founder rests, every system runs as usual: production, deliveries, markets, contracts, and later employees' standing orders. Resting is the founder's state, not a simulation mode. Pause works as always, and ticks are unchanged.
- **Starting state:** a new M002 game starts with the founder `RESTING` at Hollow Creek from tick 0 (00:00) until `START_WAKE_TICK` (game-data, PLACEHOLDER 06:00), with `awakeSince = 0`. The first morning starts naturally.

### 8. No traps (provable)

From any state, the founder can rest within a bounded number of ticks, and no state blocks progress because of rest. Proof sketch for the locked property test (SK1):

1. **`REST` is refused only while the founder is `TRAVELLING`, `ON_DELIVERY`, `RESTING`, or busy.** It's never refused for location, hours, cash or tiredness.
2. **Each of those ends in bounded time:**
   - busy ends at `busy.until`
   - a rest ends at its `until`
   - a delivery ends when the truck gets home: each leg is a route duration, and an ADR 0019 delay adds at most `delayTicks`
   - travel ends at the destination or at a halt, and each leg is a route duration.
3. **Walking is never blocked:** closures stop vehicles only (decision 3), and the route graph is connected (validated). So the founder can always walk to a rest place, and resting where they stand is allowed anyway.
4. **Tiredness only lengthens durations, by a bounded factor.** It never makes a command invalid. So rest can't make an action impossible: no command requires being rested, and no rejection reason mentions tiredness.

The test property: for random valid states and command sequences, `REST` is accepted within at most `B` ticks (computed from the data: the longest busy activity × the tired factor, plus the longest delivery round trip plus delay, plus the longest rest), and the set of commands a rested founder could dispatch is the same as a tired one's, apart from durations.

### 9. Pacing

- **The M002 hypothesis:** `REAL_MS_PER_GAME_HOUR_AT_1X` changes from 5 000 to **20 000** in `packages/game-data/src/pacing.ts` (ADR 0014 decision 9). That's 3 ticks per real second at 1×, 8 real minutes per game day, 4 at 2× and 2 at 4×. The tick (1 game minute), the accumulator and the batch bounds don't change. ADR 0014's integer arithmetic still holds.
- **Overnight pacing.** A night at 8 minutes per game day would be about 2.7 real minutes of watching the founder sleep. Instead, **while the founder is `RESTING` and the game is running**, the worker's scheduler runs at `REST_SPEED_MULTIPLIER` (game-data, PLACEHOLDER 16×), so 8 hours of sleep take 10 real seconds at the default. It drops back to the player's chosen speed when the founder wakes, or as soon as a `notify`-importance item reaches the player's activity feed (ADR 0021 decision 7: knowledge only, so the speed change leaks nothing). The scheduler reads the founder's whereabouts from the player snapshot, which is always known. Determinism is unaffected, because the scheduler only chooses batch sizes (ADR 0014 Consequences).
- **The knock-on (GDD §16).** At M002 pacing, a game day is about 16 waking hours at 20 s per hour (≈ 5.3 min) plus about 8 hours of fast-forwarded sleep (≈ 10 s), so ≈ 5.5 real minutes at 1×. M001's ~15-day victory would take ≈ 83 real minutes at 1×, or ≈ 42 at 2×, against M001's 20–30 minute target. This record doesn't retune victory. PT1 (#175) judges the day length, and T-LAB (#184) owns the retune (victory thresholds, contract timing, or fewer days), measured in game days by the lab and converted with this rest model.

### 10. Saves

- `GameState.founder` is required and `VehicleState.parkedAt` is required, so `SAVE_SCHEMA_VERSION` bumps (ADR 0009). It's one bump with K1's if both land in the same release; otherwise a second bump.
- **M001 saves migrate** with the founder `PRESENT`, not busy, at the home location of the scenario's first facility (Hollow Creek), and `awakeSince` = the save's tick. Every vehicle gets `parkedAt` = its home facility's location. A delivery in flight in the save completes without a driver (decision 5), and the founder isn't aboard. The migration reads only the save's own fields, never game-data (ADR 0009): the home location is taken from the save's facility state.

### 11. Contract changes (their own task)

The changes below go in one contract-change task (factory.md §7.3), filed when this ADR merges:

- `state.ts`: `FounderState`, `FounderWhereabouts`, `RouteLeg`, `GameState.founder`; `VehicleState.parkedAt`.
- `commands.ts`: `TRAVEL`, `REST`, `WAKE` (types, `GAME_COMMAND_TYPES`, docs table); `DISPATCH_DELIVERY.driverCharacterId`. The rejection reasons these commands need are named in ADR 0022 (#169), which owns the rejection list; this task adds whichever ones 0022 settles.
- `events.ts`: `FOUNDER_DEPARTED`, `FOUNDER_ARRIVED`, `FOUNDER_HALTED`, `FOUNDER_RESTED` (rest started), `FOUNDER_WOKE`. New union members don't bump the save version.
- `player-snapshot.ts`: the `founder` section (decision 1), extending K1's `PlayerSnapshot`.
- `schemas.ts`, `save.ts`: Zod schemas, and the bump and migration from decision 10.
- `packages/game-data`: types and starting values for `ACTIVITY_DURATIONS`, `FOOT_TRAVEL_PPM`, `PLACE_HOURS`, `REST_PLACES`, `MIN_REST_TICKS`, `MAX_REST_TICKS`, `FULL_REST_TICKS`, `ROUGH_REST_TICKS`, `TIRED_AFTER_TICKS`, `TIRED_DURATION_PPM`, `START_WAKE_TICK`, `REST_SPEED_MULTIPLIER`; the new feed-store route; route-graph connectivity validation; `REAL_MS_PER_GAME_HOUR_AT_1X` = 20 000.

It depends on K1 (#188) for `PlayerSnapshot`. SK1 (#173) implements the behaviour.

## Consequences

- **Every command now has a "where is the founder" question.** ADR 0022's gate table answers it per command, using decision 2's definition and decision 4's mechanism.
- **M001 strategies change.** The lab's bots dispatch from anywhere and never sleep. Until T-LAB (#184) teaches them travel and rest, the lab runs the M001 scenario with the founder rules off (a scenario flag in game-data), so the nightly balance run keeps working. The M002 scenario turns them on.
- **Production and deliveries now take the founder's time.** With one truck and a founder who must drive it, every sale is a round trip away from the still. That's the M002 pressure GDD §16 wants. The first-hire reachability check (R1, #176) has to show it's survivable.
- **Pacing changes everywhere.** M001 e2e tests that rely on real-time rates read the constant, and `window.__eov.advance` is unaffected. Playwright tolerance checks may need new tolerances.
- **Late-night penalties stay mild until playtests say otherwise.** Anything harsher (lost skill, mistakes, collapse) needs a later design decision (GDD §18).
- **Later milestones** can add carried goods, disembarking, risk on the founder's own trips, and day-of-week hours as fields and game-data, without changing the shape of the founder's state.
