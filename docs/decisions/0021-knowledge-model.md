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
| **Player knowledge** | New `GameState.knowledge` (decision 4) | The player snapshot builder only |
| **Channels** | Systems that write knowledge records (decision 6) | — |

Knowledge is **authoritative simulation state**, not a UI cache. It's deterministic, hashed, saved, and replayed. It's updated inside the tick, never in the worker or the UI (architecture rule 7).

### 2. Two projections

- **`snapshot(): GameSnapshot` stays as it is**, renamed in documentation to the **world snapshot**. The lab, tests, and a dev-only debug view use it. It's no longer sent to the game UI.
- **New `playerSnapshot(): PlayerSnapshot`** is what the worker publishes to the UI. It's built **only** from `knowledge`, the always-known state (decision 3), and the founder's current place (decision 5).
- **Events:** `takeEvents()` stays the full world event stream for the lab. The UI instead gets the player snapshot's `activity` feed (decision 8). The worker stops forwarding world events to the UI, because toasts built from world events are a channel.
- **Enforcement:** the game app's gateway client accepts only `PlayerSnapshot` messages. An ESLint boundary rule forbids `apps/game` code outside a `debug/` folder from importing `GameSnapshot`. The debug view exists only in dev builds.

Options considered: filter `GameSnapshot` in place (one type, but every field becomes a "maybe stale" question and the lab loses its truth), or a separate knowledge-only type (chosen: the world snapshot keeps working for everything M001 built, and the player snapshot can be checked on its own).

### 3. What is always known

These parts of the player snapshot come straight from world state, because the founder can't fail to know them:

- **The clock** and the **game outcome** (winning or losing ends the game, so it's announced).
- **The founder:** where they are or which route they're travelling, what they carry, and their rest state (shapes in ADR 0023).
- **Cash: the purse.** In M002 the business's money is one purse the founder controls (GDD §17). Every ledger transaction that moves cash is known when it posts. Money that has been earned but isn't in the purse yet (for example, a payment a hired driver is carrying home) isn't cash; ADR 0022 and ADR 0025 decide how that's booked (FIN-001 already has a receivables account).
- **Agreements the founder made:** contract terms signed, equipment and vehicles bought, wages agreed, standing orders given. How those agreements are *going* is knowledge (decision 4).
- **Geography:** places, names, positions, and route geometry and durations. The map is common knowledge. A route's *condition* isn't.

Nothing else is always known. That includes reputation and tier (decision 4, `STANDING`).

### 4. Knowledge records

`GameState.knowledge` holds one record per **subject**, the latest known value:

```ts
interface KnowledgeRecord {
  readonly subject: KnowledgeSubject;   // kind + id, e.g. { kind: "FACILITY_STOCK", facilityId }
  readonly value: KnowledgeValue;       // discriminated by subject kind
  readonly learnedAt: Tick;
  readonly source: KnowledgeSource;
}

type KnowledgeSource =
  | { kind: "IN_PERSON"; locationId }
  | { kind: "PHONE"; partyLocationId }                  // ADR 0024
  | { kind: "MESSAGE"; takenAtLocationId; takenBy }     // ADR 0024
  | { kind: "REPORT"; characterId };                    // ADR 0025
```

**Subjects are fact groups, not single fields.** A visit refreshes a whole group at once, so values within a group are always consistent with each other. M002's subject kinds:

| Subject kind | Keyed by | Value (reuses ADR 0007 snapshot types) |
|---|---|---|
| `FACILITY_STOCK` | facility | products (`InventoryPoolSnapshot[]`), materials (`MaterialStockSnapshot[]`), storage used |
| `FACILITY_OPERATIONS` | facility | production jobs there, workforce present, equipment in place |
| `SUPPLIER_OFFER` | supplier | materials with unit price, available quantity, shortage flag |
| `BUYER_WANTS` | buyer | wants (`BuyerWant[]`) and whether they'll deal |
| `BUYER_BUDGET` | buyer | budget remaining |
| `CONTRACT_OFFERS` | buyer | that buyer's open offers |
| `CONTRACT_PROGRESS` | contract | per installment: delivered, outcome, penalty |
| `MARKET_PRICES` | — (one) | the regional price table (`ProductPriceSnapshot[]`) |
| `ROUTE_CONDITION` | route | open/closed, reopening time if known, risk |
| `VEHICLE_WHEREABOUTS` | vehicle | parked at a place, or the trip as last seen |
| `STANDING` | — (one) | reputation, current tier, unlocks |

- **Values reuse the snapshot types** (contracts rule 2: no parallel types). A record's value is copied from the world projection at the moment it's learned, so it doesn't change afterwards.
- **One record per subject; the newest wins.** If two channels deliver the same subject on one tick, the later in tick order wins. There's no history in M002. Keeping older records (for unreliable reports or contradictions) is a later decision, and the `source` field already supports it.
- **Never known** is the absence of a record. The player snapshot shows it as `null`.
- **Records are sorted** by subject kind, then by key with `compareIds` (ADR 0007 amendment), so the state hash is stable.
- **`STANDING` isn't always known.** Reputation moves when an installment settles, and an always-visible reputation would leak whether it was missed. Instead, the founder learns their standing from anyone they deal with: any in-person visit or phone call refreshes `STANDING`. Equipment gating by tier is checked against the world (it's a rule). What the player sees, and any immediate rejection, uses known standing (ADR 0022 decides which).

### 5. Being there: the live view

While the founder is **present** at a place (not travelling; "present" is defined by ADR 0023), every subject belonging to that place is refreshed **every tick** as `IN_PERSON`:

- the facility, supplier, or buyer at that place (all its subject kinds)
- vehicles parked there
- routes that start or end there (`ROUTE_CONDITION`)
- `CONTRACT_PROGRESS` and `CONTRACT_OFFERS` for the buyer there
- `MARKET_PRICES` at any buyer or supplier (people in the trade talk prices)
- `STANDING`

A route's condition is also refreshed while the founder **travels** it. So the scene is always the truth, and everywhere else is the ledger.

**Tick order:** observation runs as a new last step of the tick, after every system and before the projection is published (SIM-001 step 6 becomes "observe, then emit events and publish"). A record's `learnedAt` is the tick it was observed.

### 6. Channels and what each reveals

A channel is a system that writes records. Which subject kinds each source can reveal is **game-data** (`KNOWLEDGE_VISIBILITY`), not simulation code:

| Source | Reveals |
|---|---|
| `IN_PERSON` | Everything at the place (decision 5) |
| `PHONE` to a buyer | `BUYER_WANTS`, `CONTRACT_OFFERS`, `CONTRACT_PROGRESS` for their contracts, `STANDING`. **Not** `BUYER_BUDGET`: Kessler tells you his price, not what's in his safe |
| `PHONE` to a supplier | `SUPPLIER_OFFER`, `STANDING` |
| `PHONE` to your own facility | Only what someone there tells you: ADR 0025 |
| `MESSAGE`, `REPORT` | Defined by ADR 0024 and ADR 0025, using this table's shape |

The table's shape is `Record<SourceKind, Record<PartyKind, readonly SubjectKind[]>>`, validated at load like other game-data. A source never reveals more than the table allows, and the channel copies the world value at the time of contact.

### 7. Catching up on arrival

When the founder arrives at a place, they learn what changed while they were away:

- **Diffs:** for each subject the arrival refreshes, the simulation compares the old record with the new value and produces structured catch-up lines, such as a stock change, a job finished, or a price change. They're structured data, not prose. The words are UI copy, and copy is a placeholder until the human decides it.
- **News:** some world events happen *at* a place and would be lost by a plain diff, such as materials running out mid-batch, a job failing, or cargo seized. Each such event type is tagged with the place it concerns, and while the founder isn't there it's appended to that place's **pending news** in `knowledge`. Each place keeps at most `PENDING_NEWS_LIMIT` items (game-data); older ones drop, and a dropped count is kept. Arriving, or a channel that covers the place, delivers the pending news and clears it.
- Arrival emits one `KNOWLEDGE_CAUGHT_UP { locationId, sinceTick, lines, news, droppedNews }` event. The player snapshot carries the latest one as `catchUp`, until the founder leaves.

**"You may learn late, but you always learn eventually"** (GDD §17) is guaranteed like this:

- Cash changes are always known (decision 3).
- A stock change at a place shows up in the diff on the next visit or in a channel covering it.
- Every ledger transaction that doesn't move cash (capitalised production, a cargo loss, a penalty accrued) carries the ID of the event that caused it (ADR 0006). It becomes visible in the player's books when that event becomes known, through news or a diff.

So the player's books can lag, but they never stay wrong.

### 8. The player snapshot

`PlayerSnapshot` (new `packages/contracts/src/player-snapshot.ts`) follows ADR 0007's rules: plain data, no optional fields, lists sorted with `compareIds`, and self-contained. Its sections:

- `clock`, `outcome`, `founder` (ADR 0023): always known.
- `places`: every location with its geography (always known), plus a `Known<…>` value for each subject belonging to it.
- `routes`: geometry (known) plus `Known<RouteCondition>`.
- `vehicles`: owned vehicles (known) plus `Known<VehicleWhereabouts>`.
- `market`: `Known<MarketPrices>`.
- `standing`: `Known<Standing>`.
- `contracts`: agreed terms (known) plus `Known<ContractProgress>` each; offers through `places`.
- `finance`: cash (always known), and **the books as known**. The ledger lists the cash transactions plus the non-cash transactions whose cause is known. **Known net worth** is cash + known inventory at cost + owned assets − known liabilities, labelled as known, with the oldest `learnedAt` it relies on. Victory progress shows known values; the outcome itself is evaluated on the world, as a rule.
- `activity`: replaces `recentEvents`. Only things the founder saw or was told: their own actions, catch-ups, messages, reports. Capped like `recentEvents`.
- `catchUp`: the latest arrival summary, or `null`.
- `here`: the place the founder is at, or `null` while travelling. The UI uses it to choose which scene to show; the values come from `places` (they're live, `learnedAt` = now).

`Known<T>` is `{ value: T; learnedAt: Tick; source: KnowledgeSource } | null`. That's what the ledger's "last updated" date and source are rendered from (GDD §17).

**Every computed affordance in the player snapshot uses only knowledge.** Values such as `blockedBy`, `maxStartableQuantity`, `maxAcceptableQuantity` and quotes are computed from known values and the live view, never from the world. A buyer's `maxAcceptableQuantity` from a phone call is computed without `BUYER_BUDGET`, because the call doesn't reveal it. ADR 0022 decides what an order does when known and true values disagree.

### 9. The non-leak property

Stated so it can be locked as a test (owned by K2, #177; SK1 tests its path):

> **Static.** Let S₁ and S₂ be valid states with identical `knowledge`, identical always-known state (decision 3), and an identical live view (every world value decision 5 would observe this tick). They may differ anywhere else in world state. Then `playerSnapshot(S₁)` and `playerSnapshot(S₂)` are byte-identical in canonical JSON.
>
> **Dynamic.** From such S₁ and S₂, dispatching the same command gives the same player-visible result: accepted or rejected, the same `RejectionReason`, and the same player snapshot afterwards. Advancing the same number of ticks keeps the player snapshots identical **until a channel delivers a subject on which they differ**.

The test generators perturb world values outside the live view: stock at facilities the founder isn't at, supplier and buyer state elsewhere, route conditions off the founder's route, vehicle trips out of sight, installment progress for contracts not at the current buyer, reputation, and pending news. Validation errors, `blockedBy`, activity and catch-up all fall under the property, because they're all part of the player snapshot or the dispatch result. The dynamic half needs ADR 0022's split between orders and outcomes, so SK1 locks the static half and K2 locks both.

### 10. Saves

- `GameState` gains `knowledge: KnowledgeState` (records plus pending news per place). It's a required field, so `SAVE_SCHEMA_VERSION` bumps (ADR 0009).
- **M001 saves migrate with empty knowledge:** the migration creates no records. Records are copies of world projections, and migrations never read game-data (ADR 0009), so they can't be rebuilt there. The first tick observes the founder's place, and the rest of the world starts as unknown. A migrated M001 game is playable, but it starts out not knowing anything, which is fine for saves that predate the mechanic. ADR 0023 decides where the founder stands in a migrated save.
- Size: one record per subject, bounded by game-data entity counts, plus pending news capped per place. That's comparable to the market state.

### 11. Contract changes (their own task)

The changes below go in one contract-change task (factory.md §7.3), filed when this ADR merges, before SK1:

- `packages/contracts/src/knowledge.ts` (new): `KnowledgeSubject`, `KnowledgeValue`, `KnowledgeSource`, `KnowledgeRecord`, `KnowledgeState`, pending news, `Known<T>`, catch-up line types.
- `packages/contracts/src/player-snapshot.ts` (new): `PlayerSnapshot` and its sections (decision 8).
- `state.ts`: `GameState.knowledge`.
- `events.ts`: `KNOWLEDGE_CAUGHT_UP`; a "concerns place" tag for the event types listed in decision 7. Adding union members doesn't bump the save version (ADR 0009); `GameState.knowledge` does.
- `engine.ts`: `playerSnapshot()`.
- `schemas.ts`: Zod schemas for all of the above.
- `save.ts`: `SAVE_SCHEMA_VERSION` bump and the migration from decision 10.
- `packages/game-data`: the types for `KNOWLEDGE_VISIBILITY` and `PENDING_NEWS_LIMIT` (ADR 0012 lets game-data own them).
- `eslint.config.js`: the `GameSnapshot` boundary rule from decision 2.

Founder fields (ADR 0023), order and outcome shapes (ADR 0022), and phone and report sources (ADR 0024, 0025) are added by their own tasks.

## Consequences

- The M001 UI panels can't render a `PlayerSnapshot` without changes. Until K2 (#177) moves them over, the walking skeleton (SK2) uses new scene and ledger views, and the old panels stay on the world snapshot in the dev-only debug view. The non-leak property only applies once the UI reads `PlayerSnapshot` alone, which is K2's acceptance criterion.
- The economy lab keeps working against the world snapshot until T-LAB (#184) moves its bots to `playerSnapshot()`. After that, bot results measure play under fog.
- Every new subject kind or source later (rival intel, informants, unreliable reports) extends the tables in decisions 4 and 6, instead of adding a parallel system. Unreliable reports will need records whose value differs from the world; the `source` field is where trust attaches.
- Observing every tick at the founder's place costs one projection of one place per tick. That's cheap at M002's sizes. If it shows up in profiles, it can observe only on ticks where that place's state changed. The result is the same.
- The world snapshot's `blockedBy` and the player snapshot's `blockedBy` can disagree, and that's intended. ADR 0022 decides how commands deal with it.
