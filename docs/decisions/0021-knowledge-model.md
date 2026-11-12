# 0021: The knowledge model

Status: accepted (decided by the orchestrator for M002 task D1, issue #168; implemented by the contract task it names and SK1)

## Context

GDD §17 (INFO-001): information is local, timestamped, and comes from being there or being told. M001's `GameSnapshot` (ADR 0007) is a projection of the whole world, and the UI renders all of it, which is exactly the "modern CEO with an internet connection" problem from the first playtest. GDD §19 (ORD-001) makes knowledge one of four separate gates (knowledge, authority, communication, presence), and the M002 milestone requires a **non-leak property**: two worlds that differ only in state the founder hasn't observed give byte-identical player snapshots, across every surface (offered actions, disabled states, validation errors, outcomes, activity messages, route indicators).

This record decides how knowledge exists in the simulation and the contracts. Commands and rejections (ORD-001) are ADR 0022's (D2). The founder's position, travel and rest are ADR 0023's (D3). Phones and messages are ADR 0024's (D4), and employee reports are ADR 0025's (D5). Those records produce knowledge through the mechanism defined here and don't invent their own.

## Decision

### 1. Three layers, and who reads which

| Layer | Lives in | Read by |
|---|---|---|
| **World state** | `GameState` as today (ADR 0008) | Systems, tests, the economy lab, debug tools |
| **Player knowledge** | New `GameState.knowledge` (decisions 4 and 7) | The player snapshot builder only |
| **Channels** | Systems that write knowledge (decision 6) | — |

Knowledge is **authoritative simulation state**, not a UI cache. It's deterministic, hashed, saved, and replayed. It's updated inside the simulation, never in the worker or the UI (architecture rule 7).

### 2. Two projections

- **`snapshot(): GameSnapshot` stays as it is**, renamed in documentation to the **world snapshot**. The lab, tests, and a dev-only debug view use it. It's no longer sent to the game UI.
- **New `playerSnapshot(): PlayerSnapshot`** is what the worker publishes to the UI. It's built **only** from `knowledge`, the always-known state (decision 3), and the live view of the founder's current place (decision 5).
- **Events:** `takeEvents()` stays the full world event stream for the lab. The UI instead gets the player snapshot's `activity` feed (decision 8). The worker stops forwarding world events to the UI, because toasts built from world events are a channel.
- **Command results:** the worker returns a **`PlayerCommandResult`** to the UI: the status, the command ID and, if rejected, the reason. It has no `eventIds`, because event IDs come from one global counter and their numbers depend on unobserved activity (decision 9).
- **Enforcement:** the game app's gateway client accepts only `PlayerSnapshot` and `PlayerCommandResult` messages. An ESLint boundary rule forbids `apps/game` code outside a `debug/` folder from importing `GameSnapshot`. The debug view exists only in dev builds.

Options considered: filter `GameSnapshot` in place (one type, but every field becomes a "maybe stale" question and the lab loses its truth), or a separate knowledge-only type (chosen: the world snapshot keeps working for everything M001 built, and the player snapshot can be checked on its own).

### 3. What is always known

These parts of the player snapshot come straight from world state, because the founder can't fail to know them:

- **The clock** and the **game outcome**. Winning or losing ends the game, so it's announced. It's evaluated on the world, as a rule, and is the one accepted exception to the non-leak property (decision 9).
- **The founder:** where they are or which route they're travelling, what they carry, and their rest state (shapes in ADR 0023).
- **The cash balance: the purse.** In M002 the business's money is one purse the founder controls (GDD §17). Every **cash posting** is known when it posts, and it's a channel: it tells the founder its cause (decision 6, table of cash postings). Money earned but not yet in the purse (a payment a hired driver is carrying home, say) isn't cash. ADR 0022 and ADR 0025 decide how that's booked, and they may move some postings that now happen away from the founder into payables and receivables. That would narrow this channel; it doesn't change the rule.
- **Agreements the founder made:** contract terms signed, equipment and vehicles bought, wages agreed, standing orders given. How those agreements are *going* is knowledge (decision 4).
- **Geography:** places, names, positions, route geometry and durations, and each route's **risk** (`riskPpm`, static game-data, ADR 0019). A route's *condition* (open or closed) isn't always known. **Place discovery is out of scope for M002**: every place is on the map from the start. "Hearing about a new buyer" (GDD §18) would later be a subject kind for places, added to the tables in decisions 4 and 6.

Nothing else is always known. That includes reputation and tier (decision 4, `STANDING`).

### 4. Knowledge records and their values

`GameState.knowledge.records` holds one record per **subject**, with the latest known value:

```ts
interface KnowledgeRecord {
  readonly subject: KnowledgeSubject;   // kind + key, e.g. { kind: "FACILITY_STOCK", facilityId }
  readonly value: KnowledgeValue;       // discriminated by the same kind
  readonly learnedAt: Tick;
  readonly source: KnowledgeSource;
}

type PartyKind = LocationOccupant["kind"];   // "FACILITY" | "SUPPLIER" | "BUYER" (ADR 0007)

type KnowledgeSource =
  | { kind: "IN_PERSON"; locationId: LocationId }
  | { kind: "CASH_POSTING"; transactionId: TransactionId }            // decision 6
  | { kind: "PHONE"; partyLocationId: LocationId }                    // ADR 0024
  | { kind: "MESSAGE"; takenAtLocationId: LocationId; takenBy: CharacterId | null }  // ADR 0024
  | { kind: "REPORT"; characterId: CharacterId };                     // ADR 0025
```

**Subjects are fact groups, not single fields.** A visit refreshes a whole group at once, so values within a group always agree with each other.

**Values are observed data only.** A value never carries a number the simulation computed from the world for the UI's convenience. Affordances such as `blockedBy`, `maxStartableQuantity` and `maxAcceptableQuantity` are recomputed by the player snapshot builder from known values (decision 8), and never stored in a record. Values reuse ADR 0007 types where those contain no affordances, and use `Omit<…>` of them where they do, so there are no parallel types:

```ts
type KnowledgeValue =
  | { kind: "FACILITY_STOCK"; facilityId: FacilityId;
      products: readonly InventoryPoolSnapshot[];          // quantities, reservations, cost
      materials: readonly MaterialStockSnapshot[];
      storageUsed: number }
  | { kind: "FACILITY_OPERATIONS"; facilityId: FacilityId;
      jobs: readonly ProductionJobSnapshot[];
      workersPresent: number }
  | { kind: "SUPPLIER_OFFER"; supplierId: SupplierId;
      materials: SupplierSnapshot["materials"] }           // price, available, shortage
  | { kind: "BUYER_WANTS"; buyerId: BuyerId;
      willDeal: boolean;
      wants: readonly Omit<BuyerWant, "maxAcceptableQuantity">[] }
  | { kind: "BUYER_BUDGET"; buyerId: BuyerId; budgetRemaining: Money }
  | { kind: "CONTRACT_OFFERS"; buyerId: BuyerId;
      offers: readonly Omit<ContractOfferSnapshot, "blockedBy">[] }
  | { kind: "CONTRACT_PROGRESS"; contractId: ContractId;
      status: ContractSnapshot["status"];
      installments: readonly Omit<InstallmentSnapshot, "inTransit">[] }
  | { kind: "MARKET_PRICES"; products: readonly ProductPriceSnapshot[] }
  | { kind: "ROUTE_CONDITION"; routeId: RouteId; status: RouteSnapshot["status"] }
  | { kind: "VEHICLE_WHEREABOUTS"; vehicleId: VehicleId;
      parkedAt: LocationId | null; trip: VehicleTrip | null }
  | { kind: "STANDING"; reputation: number; tierId: TierId; unlocked: readonly UnlockId[] };
```

`BUYER_WANTS.willDeal` compares the buyer's minimum reputation with the world's reputation. Every source that reveals `BUYER_WANTS` must also reveal `STANDING`, so the two always agree. The visibility table (decision 6) is validated for that pairing, including ADR 0024's `MESSAGE` rows.

Equipment installed at a facility isn't a subject: the founder bought it, so it's an agreement (decision 3).

- **One record per subject; the newest wins.** If two channels deliver the same subject on one tick, the later in tick order wins. There's no history in M002. Keeping older records (for unreliable reports or contradictions) is a later decision, and the `source` field already supports it.
- **Never known** is the absence of a record. The player snapshot shows it as `null`.
- **Records are sorted** by subject kind, then by key with `compareIds` (ADR 0007 amendment), so the state hash is stable.
- **`STANDING` isn't always known.** Reputation moves when installments settle and deliveries complete, and it's a fact about what others think of you. The founder learns it from anyone they deal with: any in-person visit or phone call refreshes it. With cash postings as a channel (decision 6), an installment that costs a penalty is learned at once anyway. Hiding standing still matters for changes that move no cash, like a fulfilled installment's reputation gain while the founder is on the road. **Tier gating:** equipment purchases are checked against the world's tier, as a rule. That can't leak, because buying equipment requires being at the facility, and being anywhere refreshes `STANDING` (decision 5), so known and world tier agree whenever the check can run. ADR 0022 can rely on this.

### 5. Being there: the live view

While the founder is **present** at a place (not travelling; ADR 0023 defines "present"), the subjects belonging to that place are the **live view**:

- the facility, supplier, or buyer at that place (all its subject kinds)
- vehicles parked there
- `ROUTE_CONDITION` for routes listed for that place in game-data's `LIVE_VIEW_ROUTES` (default: every route that starts or ends there; "people talk" about the roads in and out). It's a tuning table.
- `CONTRACT_PROGRESS` and `CONTRACT_OFFERS` for the buyer there
- `MARKET_PRICES` at any buyer or supplier (people in the trade talk prices)
- `STANDING`

A route's condition is also live while the founder **travels** it.

**The live view is read from the world when the player snapshot is built**, with `learnedAt` = the current tick and source `IN_PERSON`. It's never stale, even after a command applied while paused (ADR 0004 applies commands immediately) or at tick 0 of a new or loaded game. Building it changes no state, so loading leaves the state hash unchanged.

**Persisting:** the live view is written into `knowledge.records`, so it's still known after the founder leaves:

- at the end of every tick (a new last step of the tick: SIM-001 step 6 becomes "persist the live view, then emit events and publish"), and
- inside the transaction of any command that ends the founder's presence (departing; ADR 0023), so a purchase made while paused and followed by leaving is remembered as it ended.

### 6. Channels and what each reveals

A channel is something that writes records or delivers news. Which subject kinds each source can reveal is **game-data** (`KNOWLEDGE_VISIBILITY`), not simulation code. Its shape is `Record<SourceKind, Record<PartyKind, readonly SubjectKind[]>>`, validated at load like other game-data.

| Source | Reveals |
|---|---|
| `IN_PERSON` | The live view (decision 5) |
| `PHONE` to a buyer | `BUYER_WANTS`, `CONTRACT_OFFERS`, `CONTRACT_PROGRESS` for their contracts, `STANDING`. **Not** `BUYER_BUDGET`: Kessler tells you his price, not what's in his safe |
| `PHONE` to a supplier | `SUPPLIER_OFFER`, `STANDING` |
| `PHONE` to your own facility | Only what someone there tells you: ADR 0025 |
| `MESSAGE`, `REPORT` | Defined by ADR 0024 and ADR 0025, in this table's shape |
| `CASH_POSTING` | The cause of the posting: the subjects and news in the table below |

A source never reveals more than the table allows, and the channel copies the world value at the time of contact.

**Classifying transactions.** Whether a ledger transaction is known is decided **per transaction**, not per `TransactionKind`. A kind doesn't determine whether a transaction moves cash: wages accrue without a cash line when cash is 0, for example.

1. **Known at once:** posted at game creation, or caused by the founder's own command, or posted at the founder's place while they're present. This last test applies only to transactions concerning a place. Also known at once, with or without a cash leg: **charges whose amount depends only on agreements the founder made** (decision 3). In M001 those are the midnight wage and overhead charges (`DAILY_SETTLEMENT:WAGES` / `:OVERHEAD`). Any other transaction with no place goes on to rules 2 and 3.
2. **Otherwise, if it has a CASH entry, it's a cash posting:** known, and a channel for its cause (the table below).
3. **Otherwise, if it has entries,** it goes into `pendingBooks` (decision 7).
4. **Transactions with no entries never appear in the player's books.** They aren't money lines (the finance ledger already skips `PROGRESSION`). What they report (offers, route closures, shortages, delays, the market cycle) reaches the player only through records, news and activity.

**Cash postings that can happen while the founder is elsewhere** (M001 behaviour), and what each one reveals when it posts:

| Posting | Kind | Reveals |
|---|---|---|
| Installment penalty paid at the deadline (ADR 0018 decision 7) | `INSTALLMENT_SETTLEMENT` | `CONTRACT_PROGRESS` for that contract |
| Penalty paydown at midnight (`DAILY_SETTLEMENT:PENALTIES`, ADR 0018 decision 8) | `DAILY_SETTLEMENT` | Nothing new. The accrued penalty is already known, because the installment's settlement revealed `CONTRACT_PROGRESS` (above) |
| Payroll paydown at midnight (`DAILY_SETTLEMENT:PAYROLL`, ADR 0017 decision 9) | `DAILY_SETTLEMENT` | Nothing new: it pays down agreed wages already known |
| Truck home: transport cost (ADR 0019 decision 2) | `VEHICLE_RETURN` | `VEHICLE_WHEREABOUTS` for that truck, plus news of a failed deal if cargo came home (decision 7). The whole transaction is known, including any cargo booked back into stock, but not the rest of the home facility's `FACILITY_STOCK` |
| Sale proceeds on arrival | `SALE` | `CONTRACT_PROGRESS` if it was an installment, `VEHICLE_WHEREABOUTS`, and the sale itself as activity. In M002 the founder is usually on the truck, so they're present anyway |
| A shakedown (T07f) | `LOSS` | The shakedown, as news |
| A production job completing or failing, conversion cost paid from cash (`settleJob` → `conversionPosting`, ADR 0017) | `PRODUCTION`, `PRODUCTION_WRITE_OFF` | `FACILITY_OPERATIONS` and `FACILITY_STOCK` of that facility. That's broader than `VEHICLE_RETURN`, and deliberately so: the posting is the batch itself. A recipe with no conversion cost posts no cash leg, so it falls under decision 7 |
| Wages and overhead charged at midnight (`DAILY_SETTLEMENT:WAGES` / `:OVERHEAD`) | `DAILY_SETTLEMENT` | Nothing new: agreed amounts, summed over facilities. Known at once even with no cash leg (rule 1), so they need no decision 7 row |

A new producer of away-from-founder cash postings has to add its row to this table. The coverage test runs over the transaction **producers** (identified by idempotency-key family, such as `DAILY_SETTLEMENT:PAYROLL`), not over `TransactionKind`. A producer needs a row **in each table it can post to**: one that can post with or without a cash leg (production, installment settlement, `VEHICLE_RETURN`) needs a row in both, and the test fails for any missing one.

### 7. Catching up, news, and the books

`GameState.knowledge` also holds **pending news** and **pending books**:

```ts
interface KnowledgeState {
  readonly records: readonly KnowledgeRecord[];
  readonly pendingNews: readonly { locationId: LocationId; items: readonly NewsItem[]; dropped: number }[];
  readonly pendingBooks: readonly { transactionId: TransactionId; concerns: KnowledgeSubject | { kind: "NEWS"; locationId: LocationId } }[];
  /** What the founder saw or was told, newest last, capped at ACTIVITY_LIMIT (game-data). */
  readonly activity: readonly ActivityItem[];
  /** The latest arrival summary; cleared when the founder departs. */
  readonly lastCatchUp: CatchUp | null;
}
```

**Catching up on arrival.** When the founder arrives at a place, they learn what changed while they were away:

- **Diffs:** for each subject in the live view, the simulation compares the stored record with the new value and produces structured catch-up lines, such as a stock change, a job finished, or a price change. They're structured data, not prose. The words are UI copy, and copy is a placeholder until the human decides it.
- **News:** some world events happen *at* a place and a plain diff would lose them, such as materials running out mid-batch, a job failing, or a deal falling through. Each such event type is tagged with the place it concerns. Events on a road (cargo seized, a delay, a deal falling through) concern the **origin facility of the delivery**, where the crew would bring the story home. While the founder isn't there, the event becomes a `NewsItem` in that place's pending news. Each place keeps at most `PENDING_NEWS_LIMIT` items (game-data); older ones drop and are counted in `dropped`. Arriving, a cash posting that reveals the event, or another channel covering the place delivers the news and clears it.
- Arrival emits one `KNOWLEDGE_CAUGHT_UP { locationId, sinceTick, lines, news, droppedNews }` event and stores the same content in `knowledge.lastCatchUp`. In that same step, it clears the pending news and the `pendingBooks` entries concerning that place, so no published snapshot shows a live `FACILITY_STOCK` next to books still pending for it.

**The books.** A transaction in rule 3 of decision 6 (it has entries, no CASH entry, and isn't known) goes into `pendingBooks` with the subject or news place it **concerns**. That's taken from **what caused it**, by producer:

| Producer (idempotency-key family) | Concerns |
|---|---|
| A production job completing or failing with no cash leg (cash 0 at settlement) | `FACILITY_STOCK` of that facility |
| An installment settling with no cash leg (penalty accrued while cash is 0) | `CONTRACT_PROGRESS` of that contract |
| A truck home with no cash leg (`VEHICLE_RETURN` at cash 0) | `VEHICLE_WHEREABOUTS` of that truck |
| Cargo lost on a road (`CARGO_LOSS`) | News at the delivery's origin facility |
| Cargo moved between owned places (`TRANSFER`) | `FACILITY_STOCK` of the destination facility, where the cases land |
| Any other producer that can post entries without a founder command | Must be added here; the producer coverage test applies |

Rows with no entries never reach the books (decision 6 rule 4), so offers, closures, shortages, delays, reservations with no entries and `PROGRESSION` rows don't need rows here.

When the subject a transaction concerns is next learned (through the live view, a phone call, a report, or a cash posting), or its news is delivered, the transaction leaves `pendingBooks`. The player's books show **every ledger transaction with entries, except those in `pendingBooks`**. While the founder is present, entries concerning the live view count as known when the snapshot is built and are cleared from state at the next persist (decision 5), so books and live values never disagree.

**"You may learn late, but you always learn eventually"** (GDD §17) holds because every unknown transaction is in `pendingBooks` with a subject or a place, and visiting that place delivers every subject and all the news it concerns. The books can lag, but they never stay wrong. `pendingBooks` holds only what's still unknown, so it stays small.

### 8. The player snapshot

`PlayerSnapshot` (new `packages/contracts/src/player-snapshot.ts`) follows ADR 0007's rules: plain data, no optional fields, lists sorted with `compareIds`, and self-contained. Its sections:

- `clock`, `outcome`, `founder` (ADR 0023): always known.
- `places`: every location with its geography (always known), plus a `Known<…>` value for each subject belonging to it, with recomputed affordances.
- `routes`: geometry and risk (known), plus `Known<ROUTE_CONDITION value>`.
- `vehicles`: owned vehicles (known), plus `Known<VEHICLE_WHEREABOUTS value>`.
- `market`: `Known<MARKET_PRICES value>`.
- `standing`: `Known<STANDING value>`.
- `contracts`: agreed terms (known), plus `Known<CONTRACT_PROGRESS value>` each. Offers come through `places`.
- `finance`: the cash balance (always known), and **the books as known** (decision 7), as `PlayerBookRow`s: tick, kind, cash-flow category and entries, **without** `idempotencyKey` or `eventIds`, which carry simulation IDs. **Known net worth** is cash + known inventory at cost + owned assets − known liabilities, labelled as known, with the oldest `learnedAt` it relies on. Victory progress shows known values. The outcome itself is evaluated on the world (decision 3), so the game can announce a win while known net worth still looks short. That's accepted.
- `activity`: replaces `recentEvents`. It's `knowledge.activity` (decision 7), written only by the founder's own commands and by channels: catch-ups, cash postings, messages and reports. It isn't filtered from the world event journal.
- `catchUp`: `knowledge.lastCatchUp`.
- `here`: the place the founder is at, or `null` while travelling. The UI uses it to choose which scene to show. Its values in `places` are the live view (decision 5).

`Known<T>` is `{ value: T; learnedAt: Tick; source: KnowledgeSource } | null`. That's what the ledger's "last updated" date and source are rendered from (GDD §17).

**Affordances are recomputed from knowledge.** The builder computes `blockedBy`, `maxStartableQuantity`, `maxAcceptableQuantity`, quotes, and each installment's `inTransit` from known values and the live view, never from the world. `inTransit` counts the founder's own dispatches toward the installment that known `VEHICLE_WHEREABOUTS` still shows on the road. For example, if `BUYER_BUDGET` isn't known, `maxAcceptableQuantity` is `demandRemaining`. ADR 0022 decides what an order does when known and true values disagree.

**Raw simulation-created IDs are never shown to the player.** The UI uses them only as handles for commands (accepting an offer, say). Labels come from names and known data. Decision 9 relies on this.

### 9. The non-leak property

Stated so it can be locked as a test. SK1 locks the static half on its path, and K2 (#177) locks both halves.

**Renaming.** Simulation-created IDs (`DYNAMIC_ID_PREFIXES`) come from global counters, so their numbers can differ between two worlds even when everything the player knows is the same. Comparisons are made **modulo a consistent renaming**: before comparing, each distinct dynamic ID is replaced with `<prefix>#k`, numbered by first appearance in canonical JSON. This includes ID tokens inside strings, although the player snapshot avoids those (decision 8's `PlayerBookRow`). Two snapshots that differ only in counter values then compare equal, while different structure (an extra offer, a different quantity) still shows up. Decision 8's "IDs are never shown" makes this sound.

> **Static.** Let S₁ and S₂ be valid states with identical `knowledge`, identical always-known state (decision 3) and an identical live view (decision 5), up to renaming. They may differ anywhere else in world state. Then `playerSnapshot(S₁)` and `playerSnapshot(S₂)` are equal in canonical JSON after renaming.
>
> **Dynamic.** Build S₂ from S₁ by perturbing a set **P** of subjects (and their pending news) that are outside the live view. From S₁ and S₂, apply the same commands and advance the same ticks. Let the **divergence set** D_t be the subjects whose world values (projected as knowledge values) differ between the two runs after tick t, with D_0 = P. It grows as hidden differences spread: a demand change at one buyer moves the next spot price, and with it `MARKET_PRICES` and every buyer's `CONTRACT_OFFERS`. Then the player snapshots and the `PlayerCommandResult`s stay equal after renaming **until the first tick at which a channel delivers a subject in D_t, news whose content differs between the runs, or a cash posting that differs**. From that tick on, they may differ.
>
> A leak is a player-visible difference at a tick when no channel delivered a diverged subject. That's what the test looks for. It computes D_t each tick by projecting both worlds subject by subject.

The test generators perturb world values outside the live view: stock at facilities the founder isn't at, supplier and buyer state elsewhere, route conditions off the founder's route, vehicle trips out of sight, installment progress for contracts not at the current buyer, reputation, and pending news. Validation errors, `blockedBy`, activity and catch-up all fall under the property, because they're part of the player snapshot or the command result.

The dynamic half needs ADR 0022's split between orders and outcomes, because M001 commands are checked against the world and are rejected with world reasons.

**The only exception is the game outcome** (decision 3): a WON or LOST status may appear while the player snapshots otherwise agree. K2's test excludes the `outcome` field and stops at a game-ending tick.

### 10. Saves

- `GameState` gains `knowledge: KnowledgeState` (records, pending news, pending books, activity, the last catch-up). It's a required field, so `SAVE_SCHEMA_VERSION` bumps (ADR 0009).
- **M001 saves migrate with empty knowledge:** no records, no pending news, no pending books, no activity, no catch-up. Records are copies of world projections, and migrations never read game-data (ADR 0009), so they can't be rebuilt there. The live view (decision 5) shows the founder's place at once, and the rest of the world starts out unknown. With empty `pendingBooks`, a migrated game's whole M001 ledger counts as known. That fits, because M001 players saw everything. ADR 0023 decides where the founder stands in a migrated save.
- Size: one record per subject (bounded by game-data entity counts), pending news capped per place, and pending books holding only what's unknown. That's comparable to the market state.

### 11. Contract changes (their own task)

The changes below go in one contract-change task (factory.md §7.3), filed when this ADR merges, before SK1:

- `packages/contracts/src/knowledge.ts` (new): `KnowledgeSubject`, `KnowledgeValue`, `KnowledgeSource`, `PartyKind`, `KnowledgeRecord`, `KnowledgeState`, `NewsItem`, `ActivityItem`, `CatchUp` and its line types, `Known<T>`.
- `packages/contracts/src/player-snapshot.ts` (new): `PlayerSnapshot` and its sections, including `PlayerBookRow` (decision 8).
- `commands.ts`: `PlayerCommandResult` (decision 2).
- `state.ts`: `GameState.knowledge`.
- `events.ts`: `KNOWLEDGE_CAUGHT_UP`; a "concerns place" tag for the event types listed in decision 7. Adding union members doesn't bump the save version (ADR 0009); `GameState.knowledge` does.
- `engine.ts`: `playerSnapshot()`.
- `schemas.ts`: Zod schemas for all of the above.
- `save.ts`: `SAVE_SCHEMA_VERSION` bump and the migration from decision 10.
- `packages/game-data`: the types for `KNOWLEDGE_VISIBILITY`, `LIVE_VIEW_ROUTES`, `PENDING_NEWS_LIMIT` and `ACTIVITY_LIMIT` (ADR 0012 lets game-data own them), with load validation that every source revealing `BUYER_WANTS` also reveals `STANDING`.
- Tests: the producer coverage test (decisions 6 and 7): every transaction producer that can post without a founder command has a row in one of the two tables.
- `eslint.config.js`: the `GameSnapshot` boundary rule from decision 2.

Founder fields (ADR 0023), order and outcome shapes (ADR 0022), and phone and report sources (ADR 0024, 0025) are added by their own tasks.

## Consequences

- The M001 UI panels can't render a `PlayerSnapshot` without changes. Until K2 (#177) moves them over, the walking skeleton (SK2) uses new scene and ledger views, and the old panels stay on the world snapshot in the dev-only debug view. The non-leak property only applies once the UI reads `PlayerSnapshot` alone, which is K2's acceptance criterion.
- The economy lab keeps working against the world snapshot until T-LAB (#184) moves its bots to `playerSnapshot()`. After that, bot results measure play under fog.
- **Production pays its conversion cost in cash when a job settles (ADR 0017), so under this ADR a finished or failed batch is known at once, from anywhere** (decision 6). That contradicts GDD §17, which lists production progress as something to observe ("Since Monday: 20 cases finished"). **ADR 0022 must fix it**, by charging the conversion cost when the job starts (the founder is present to start it) or by accruing it to a payable settled in person. Once it does, production completion becomes a non-cash posting and falls under decision 7's production row. Until then, SK1 follows this ADR as written.
- Cash postings as a channel mean a missed installment that costs a penalty is known at its deadline. That's the honest result of "the purse is always known". If playtests want contract fog to last longer, ADR 0022/0025 can move away-from-founder postings to payables, as decision 3 allows.
- Every new subject kind or source later (place discovery, rival intel, informants, unreliable reports) extends the tables in decisions 4, 6 and 7, instead of adding a parallel system. Unreliable reports will need records whose value differs from the world; the `source` field is where trust attaches.
- Building the live view costs one projection of one place per player snapshot, plus persisting it once per tick. That's cheap at M002's sizes. If it shows up in profiles, persisting can skip ticks where that place's state didn't change. The result is the same.
- The world snapshot's `blockedBy` and the player snapshot's `blockedBy` can disagree, and that's intended. ADR 0022 decides how commands deal with it.
- The `routes` RNG stream is shared, so a hidden truck's draws can change the outcome of a trip the founder is on. The dynamic property allows that (the founder learns the outcome through a channel), but it's a hidden coupling. K2 or ADR 0022 may give each trip its own stream.
