# 0024: Telephones and messages

Status: accepted (decided by the orchestrator for M002 task D4, issue #171; implemented by the contract task it names and C1 #179)

Amends: ADR 0021 decisions 5, 7, 8 and 9 (the call view, held messages, older values, a `PlayerPlace` for a place with no occupant), ADR 0023 decisions 1, 2a and 4 (the founder's call, the `phones` phase, orders on a call while busy).

Amended by ADR 0027 (#213, earned phone access and message-taking): decisions 1, 3, 4, 5, 6, 8, 9, 13, 14 and 15. `public` and `holdsMessages` are replaced by separate has-a-phone, may-use and takes-messages privileges; ADR 0027 decision 17 restates decision 15's contract list.

## Context

GDD §20 (COMM-001): a telephone sits in one place. To call, you go to it. To be called, someone has to be there to answer. Phones are places; your own phone is a purchasable asset (locked decision #12) and a milestone in the run. Calling out costs a few cents, and the party may not answer, depending on their hours (seeded). A call reveals the fields that party gives by phone. A call in to an empty phone rings out and nothing is learned. Messages are held where they were taken and reach the founder on a visit or a call to that place. Party lines are flavour in M002.

The earlier M002 records left these hooks for this one:

- **ADR 0021** defines the sources `PHONE { partyLocationId }` and `MESSAGE { takenAtLocationId; takenBy: CharacterId | null }` (decision 4), the `KNOWLEDGE_VISIBILITY` rows for calls to buyers and suppliers (a buyer call doesn't reveal `BUYER_BUDGET`), and the rule that every source revealing `BUYER_WANTS` also reveals `STANDING`. It asks this record to define the `MESSAGE` rows (decision 6).
- **ADR 0022** lets `AGREE_DEAL` and `ACCEPT_CONTRACT` be given "on a call" (decision 3). A by-phone deal is capped by demand only and sets `budgetCommitted: false` (decision 6). An order on a call is validated only against what that call reveals (decision 2). The communication gate's `NO_WAY_TO_REACH` reads "which places have phones" as geography (decision 4). Whether a call is answered is an outcome, never a rejection. Randomness the founder sees must be seeded so hidden activity can't shift it (decision 8).
- **ADR 0023** owns the founder's state, `busy`, `ACTIVITY_DURATIONS` and the tick order (`production, vehicles, [world events], resolution, founder, deadlines, midnight`). Its busy gate is `busy !== null && busy.until ≥ t` for every activity. It leaves phone calls to this record.

**What the code has today (verified on `main`).** There is no phone code. A place's occupant is `LocationOccupant = FACILITY | SUPPLIER | BUYER` (`packages/contracts/src/snapshot.ts`), one per location, and the world snapshot's `projectLocations` skips a location with no occupant in the scenario. `packages/game-data/src/map.ts` has six locations: Hollow Creek, Miller's Feed & Seed, the Crossroads, Kessler's Pharmacy, Lakeview Hotel and Riverside Depot (the depot's warehouse isn't owned in M001, so it has no occupant there). `EquipmentDefinition` (`equipment.ts`) is a per-facility catalog item with a price, throughput, storage, crew and `requiredUnlockId`. A facility's slots are `FacilityProductionDefinition.equipmentSlots` (`facilities.ts`), and `purchaseRejection` counts every owned item against them. RNG is `xoshiro128**` with four state streams (`RNG_STREAMS`: market, contracts, routes, production), seeded from `GameState.seed` by `seedRng` with splitmix32 and an FNV-1a salt (`rng/xoshiro128.ts`). The ledger's transaction kinds and accounts are in `ledger.ts`. Idempotency keys are built by `idempotencyKey(kind, ...parts)` (`coordinator.ts`), and parts can't contain `:`.

Story and visual items (which places have phones, names, copy, the call scene) are **placeholders** here, marked PLACEHOLDER and listed under *Needs design* at the end. This record decides the mechanism they plug into.

## Decision

### 1. Phones are places: a phone table, not an occupant kind

**Options considered:**

- **(a) A new occupant kind `PHONE`.** That doesn't work, because a location has exactly one occupant, and the GDD's phones mostly sit *with* a party (the general store's phone is the storekeeper's). It would also widen `PartyKind`, and with it the shape of `KNOWLEDGE_VISIBILITY`, for something that reveals nothing.
- **(b) A phone table keyed by location (chosen).** A phone is an attribute of a place, so it composes with any occupant, including none (a depot, a hotel lobby).

**Public and party phones are game-data, so they're geography** and always known (ADR 0021 decision 3):

```ts
// packages/game-data/src/phones.ts (new)
export interface PhoneDefinition {
  readonly locationId: LocationId;
  /** The founder may call out from it while present and the place is open (ADR 0023 PLACE_HOURS). */
  readonly public: boolean;
  /**
   * Whoever keeps the place takes messages for the family (decision 6). Such a phone is
   * one of the family's numbers for calls in (decision 5). PLACEHOLDER: false everywhere.
   */
  readonly holdsMessages: boolean;
}

export const PHONES: readonly PhoneDefinition[] = [
  // PLACEHOLDER (story: which places have phones; needs-design)
  { locationId: MILLERS_FEED_LOCATION, public: true, holdsMessages: false },   // "the general store"
  { locationId: KESSLER_PHARMACY, public: false, holdsMessages: false },       // Kessler's own line
  { locationId: LAKEVIEW, public: true, holdsMessages: false },                // the hotel lobby
  { locationId: RIVERSIDE_DEPOT, public: true, holdsMessages: false },         // the depot
  // The Crossroads has no phone: a reason to drive.
];
```

Load validation: at most one entry per location, and every `locationId` exists.

**Family phone lines are agreements** (decision 2), so they're always known too. **"The phone at L"** is the family's line if the family has one at L, otherwise L's `PHONES` entry, otherwise none. A party **has a phone** when its location's `PHONES` entry exists.

**In the player snapshot,** each place gets `phone: PlacePhone | null`, on K1's shared `PlaceGeography` (`packages/contracts/src/player-snapshot.ts`).

A place with a phone but no occupant (the depot, whose warehouse the family doesn't own) must still appear in `PlayerSnapshot.places`. Its contract says "every location", and ADR 0021 decision 8 says the same. But K1's `PlayerPlace` is the union `FacilityPlace | SupplierPlace | BuyerPlace`, which can't express such a place, so this record adds a fourth variant:

```ts
// packages/contracts/src/player-snapshot.ts (extends K1)
interface PlaceGeography {
  readonly id: LocationId;
  readonly name: string;
  readonly position: WorldPoint;
  /** ADR 0024: the phone here, or null. Geography and agreements, always known. */
  readonly phone: PlacePhone | null;
}

/** A location with nothing of the family's or the scenario's parties on it (ADR 0024). */
export interface EmptyPlace extends PlaceGeography {
  readonly kind: "NONE";
}

export type PlayerPlace = FacilityPlace | SupplierPlace | BuyerPlace | EmptyPlace;

export interface PlacePhone {
  readonly public: boolean;         // PHONES[L].public, or true for a family line (the family can always use its own)
  readonly familyLine: boolean;     // FacilityState.phoneLine !== null at L
  readonly holdsMessages: boolean;  // PHONES[L].holdsMessages
}
```

The snapshot **never shows whether messages are waiting** anywhere. The founder doesn't know that until they're delivered (decision 6).

### 2. Owning a phone: a new asset, not equipment

**Options considered:**

- **(a) An `EquipmentDefinition` with no bonuses.** It would reuse `PURCHASE_EQUIPMENT`, `SELL_EQUIPMENT` and the book value. But it breaks `@locked` tests in two files:
  - `production/prod-001.locked.test.ts` pins the catalog at four items. With a slotless phone, it also fails the test that expects every option to be blocked by `NO_EQUIPMENT_SLOT` when slots are full.
  - `production/prod-001-labor.locked.test.ts`'s `qcStation()` helper finds the QC station as "the one item that is neither the still, the condenser, nor the expansion", and a phone matches too.

  Hiding the phone with the flag off, so M001's offered actions don't change, would break two more tests in `prod-001.locked.test.ts`: the one that buys every catalog item, and the one that lists every unowned item as an option. It also needs a slot exception in `purchaseRejection`.
- **(b) A new asset on the facility (chosen).** It needs a small command and a nullable field, re-locks nothing, and keeps M001 untouched. A phone isn't production equipment: it doesn't change throughput, storage or crew, and it shouldn't compete with a condenser for a slot.

**Shape:**

```ts
// packages/contracts/src/state.ts
export interface FacilityState {
  readonly id: FacilityId;
  readonly equipment: readonly { readonly equipmentId: EquipmentId; readonly bookValue: Money }[];
  readonly workerCount: number;
  /** The family's telephone line here, or null (ADR 0024). One per facility. */
  readonly phoneLine: { readonly bookValue: Money } | null;
}

// packages/contracts/src/commands.ts
export interface InstallPhoneCommand {
  readonly type: "INSTALL_PHONE";
  readonly facilityId: FacilityId;
}

// packages/game-data/src/phones.ts
export interface PhoneLineDefinition {
  readonly price: Money;                     // PLACEHOLDER cents(5_000): $50
  readonly requiredUnlockId: UnlockId | null; // PLACEHOLDER null
}
export const PHONE_LINE: PhoneLineDefinition;
```

- **Presence:** the founder must be `PRESENT` at the facility, and not busy. It's a timed activity: `ACTIVITY_DURATIONS` gains `INSTALL_PHONE` (PLACEHOLDER 60 min: arranging the line with the exchange). The line works as soon as the command applies (PLACEHOLDER: an installation delay could later be a scheduled event).
- **Any family facility** can have a line, including a slotless warehouse. A warehouse is a natural "office" later.
- **Booking (FIN-001):** one transaction, kind `TELEPHONE` (new), key `idempotencyKey("TELEPHONE", "INSTALL", facilityId)`: Dr `EQUIPMENT` / Cr `CASH` at `PHONE_LINE.price`. That's a capital purchase, so net worth doesn't change, and the cash flow statement files it under `EQUIPMENT` through `EQUIPMENT`'s account category (ADR 0015). It emits `PHONE_INSTALLED { facilityId, price, transactionId }`. `phoneLine.bookValue` is the price. Each facility has at most one line, so the key is unique.
- **Where the line's value shows up:**
  - `BalanceSheet.assets.equipment` is the `EQUIPMENT` account balance, so it includes the line.
  - Known net worth's "owned assets" (ADR 0021 decision 8) includes it too, because it's an agreement.
  - The **invariant "`EQUIPMENT` balance = Σ `facilities[].equipment[].bookValue`"** becomes "… + Σ `facilities[].phoneLine.bookValue`". That invariant is asserted in the unlocked `packages/simulation/test/production/asset-sale.test.ts` (`expectBooksBalance`, lines 163–164), and C1 updates it there.
- **Not sellable in M002, and no running cost.** No line rental is charged (PLACEHOLDER: a rental would be a midnight charge depending only on an agreement, so it would be known at once under ADR 0021 rule 1). ADR 0020's restart analysis doesn't count the phone, because it can't be sold. Buying one with the last of the cash is a real choice, and it can be a bad one (locked decision #14). Selling a line is a later decision.
- **Starting phones:** no scenario starts with one, so `ScenarioFacility` doesn't change, and new games set `phoneLine: null`. The M002 scenario says "no phone of your own" (milestone doc).

### 3. Calling out

```ts
// packages/contracts/src/commands.ts
export interface PlaceCallCommand {
  readonly type: "PLACE_CALL";
  /** The place being called. Phones are places, so the target is a location, not a party. */
  readonly locationId: LocationId;
}
```

**Where the founder can call from.** The founder is `PRESENT` at a location F that **has a phone the founder may use**: a family line at F, or a `PHONES` entry at F with `public: true`. A party's private line (`public: false`) isn't usable by the founder. That test ignores hours, and it's `NO_PHONE_HERE` when it fails. A public phone also needs F to be open under `PLACE_HOURS` (ADR 0023 decision 6), which is `PLACE_CLOSED` when it fails. A family line is always open.

**Who answers at the called place L,** decided at the apply tick `t`. The rows are checked in order, and the first that matches decides. So at a `holdsMessages` phone that also has a party, the party answers (row 2), and the held messages are delivered when it does (below).

| The phone at L | Answered by | When |
|---|---|---|
| A family line | A character stationed at L who answers phones: the **call-out attendant hook** (decision 9) | Answered iff `CallOutAttendant` returns a character. By its type it reads only the player view, the seed and the tick |
| A `PHONES` entry, with a buyer or supplier at L | That party (`PARTY`) | Only while L is open (`PLACE_HOURS`). Then answered iff a keyed draw is below `CALL_ANSWER_PPM[partyKind]` (decision 7). Outside hours: no answer, and no draw |
| A `PHONES` entry with `holdsMessages`, and no party | Whoever keeps the place (`PROPRIETOR`) | While L is open. Deterministic |
| Anything else (the depot's bare public phone) | Nobody | Never |

```ts
// packages/contracts/src/state.ts
/** A party that can be on the other end of a call: never one of the family's facilities. */
export type CallParty = Exclude<LocationOccupant, { readonly kind: "FACILITY" }>;

export type CallAnswerer =
  | { readonly kind: "PARTY"; readonly party: CallParty }
  | { readonly kind: "EMPLOYEE"; readonly characterId: CharacterId } // the call-out attendant hook (ADR 0026)
  | { readonly kind: "PROPRIETOR" };                                  // a phone that holds messages
```

**What happens.** `PLACE_CALL` is one atomic transaction, keyed `idempotencyKey("TELEPHONE", "CALL", commandId)`, and it's **applied either way**. Whether anyone answers is an outcome resolved inside the command, never a rejection (ADR 0022 decision 4):

- **Answered:**
  - The founder becomes busy, `PRESENT` with `busy: { activity: "PHONE_CALL", until: t + duration }`, and `call` is set (decision 4).
  - The call costs `CALL_COST` (game-data, PLACEHOLDER `cents(5)`): Dr `OVERHEAD_EXPENSE` / Cr `CASH`. Calls are filed under `OVERHEAD` through that account's category.
  - If the phone at L holds messages (a family line with an attendant, or `holdsMessages`), the messages held at L are delivered (decision 6).
  - It emits `CALL_PLACED { fromLocationId, locationId, answered: true, answeredBy, transactionId }`.
- **No answer:**
  - The founder is busy with `PHONE_NO_ANSWER` until `t + duration`, with no call.
  - No charge. The coin comes back, as on a period payphone, and the transaction has no entries.
  - It emits `CALL_PLACED { …, answered: false, answeredBy: null }`.

`ACTIVITY_DURATIONS` (ADR 0023) gains `PHONE_CALL` (PLACEHOLDER 15 min) and `PHONE_NO_ANSWER` (PLACEHOLDER 5 min), with the command `PLACE_CALL`. `TIRED_DURATION_PPM` applies to them as to every row.

**Funds** are checked up front at `CALL_COST`, even though only a connected call is charged: the operator wants the coin first. Cash is always known.

**What a call reveals:** the subjects `KNOWLEDGE_VISIBILITY.PHONE[kind]` grants for the answerer.

- `PARTY`: the party kind's row, with `partyLocationId = L` (ADR 0021 decision 6: a buyer gives `BUYER_WANTS`, `CONTRACT_OFFERS`, `CONTRACT_PROGRESS` for their contracts, and `STANDING`, but not `BUYER_BUDGET`; a supplier gives `SUPPLIER_OFFER` and `STANDING`).
- `EMPLOYEE`: the `FACILITY` row, which is empty until ADR 0025 and ADR 0026 fill it.
- `PROPRIETOR`: nothing beyond the held messages.

The subjects are read live while the call lasts (decision 4).

`PLACE_CALL` isn't repeatable (`RepeatableCommand` is unchanged).

### 4. The call is the context for orders

**The founder's state carries the call.** `FounderWhereabouts.PRESENT` gains a field (amends ADR 0023 decision 1):

```ts
// packages/contracts/src/state.ts
export interface ActiveCall {
  readonly locationId: LocationId;     // the place called
  readonly answeredBy: CallAnswerer;
  readonly connectedAt: Tick;
}

type FounderWhereabouts =
  | { kind: "PRESENT"; locationId: LocationId;
      busy: { activity: ActivityKind; until: Tick } | null;
      /** Non-null exactly while busy.activity === "PHONE_CALL"; it ends at busy.until. */
      call: ActiveCall | null }
  | /* TRAVELLING, ON_DELIVERY, RESTING unchanged */;

type ActivityKind = /* ADR 0023's members */ | "PHONE_CALL" | "PHONE_NO_ANSWER" | "INSTALL_PHONE";
```

The invariant: `call !== null` exactly when `busy?.activity === "PHONE_CALL"`. A call ends when its busy ends. Like the rest of `founder`, it's always known.

**How a command is "on the call."** No command gains a field: the context is derived from always-known founder state. A party-facing command (`AGREE_DEAL`, `ACCEPT_CONTRACT`, ADR 0022 decision 3) for a party at location P acts:

1. **in person** if the founder is `PRESENT` at P (ADR 0022 and ADR 0023 unchanged);
2. **by phone** if the founder is `PRESENT` somewhere else, `call !== null`, `call.locationId === P`, `call.answeredBy.kind === "PARTY"`, and the apply tick `t ≤ busy.until`;
3. otherwise it's rejected with `NOT_PRESENT { requiredLocationId: P, issuerLocationId }` (ADR 0022).

Identity still resolves through the issuer's view first (ADR 0022 gate 1). So an offer from another buyer, known from a record, resolves to that buyer and fails gate 2 with `NOT_PRESENT`.

**The call view (amends ADR 0021 decision 5).** While a call is connected, the subjects decision 3 grants for its answerer are a **call view**: read from the world when the player snapshot is built, with `learnedAt` = the current tick and source `PHONE { partyLocationId: call.locationId }`. It works exactly like the live view, but is narrowed to the visibility row:

- **Validation:** by-phone orders validate against the call view and nothing else (ADR 0022 decision 2). `AGREE_DEAL` by phone reads `BUYER_WANTS` and `STANDING`, never the budget, caps by demand only and sets `budgetCommitted: false` (ADR 0022 decision 6). `ACCEPT_CONTRACT` by phone reads `CONTRACT_OFFERS` and `STANDING` for `OFFER_UNAVAILABLE`, `LOCKED` and `REPUTATION_TOO_LOW`.
- **Tier gating** reads the world's tier, as it does in person. That can't leak, because `STANDING` is in every party's phone row, so the call view refreshes it and known and world tier agree whenever the check runs. This extends ADR 0021 decision 4's argument to calls.
- **Persisting:** the call view is written into `knowledge.records` at the end of every tick (ADR 0021's persist step) and when the call ends (decision 8). That's the same rule as the live view, so what the founder heard on the call is still known after it ends.
- **Books:** `pendingBooks` entries concerning a subject in the call view count as known when the snapshot is built and are cleared at the next persist (ADR 0021 decision 7's live-view rule).
- **No catch-up lines for calls** in M002. The ledger's "last updated … (by phone)" shows the refresh. Calls don't deliver pending news either; news is delivered by visits and cash postings (ADR 0021 decision 7), and ADR 0026 decides whether an attendant passes news on.

**Busy and time (amends ADR 0023 decision 4).**

- **On-call orders pass the busy gate.** A by-phone `AGREE_DEAL` or `ACCEPT_CONTRACT` passes it when `busy.activity === "PHONE_CALL"` and the call is with that party, and it **doesn't change `busy`**. It takes the call's duration (ADR 0022 decision 3), and the founder may give several orders on one call. Orders to an **employee** on a call (`Reach = "PHONE"`, decision 9) need the same exemption. ADR 0025 and ADR 0026 define those commands, and they apply this rule to them.
- **Every other timed command, `TRAVEL`, `REST` and `PLACE_CALL` are `FOUNDER_BUSY` during the call,** including an in-person order at the founder's own place. You're on the phone. Instant commands at the founder's place stay allowed (ADR 0023).
- **On-call orders aren't hours-gated.** The call started in the party's hours, so `PLACE_CLOSED` isn't checked again. That's ADR 0023's "must be open when the activity starts", with the call as the activity.
- **Same tick.** On-call orders are allowed at every apply tick `t ≤ busy.until`, matching the busy gate's `≥`. The founder phase ends the call later in tick `busy.until` (decision 8), so at `t = busy.until` the order is still on the call, and from `busy.until + 1` it's `NOT_PRESENT`. A new `PLACE_CALL` at `t = busy.until` is `FOUNDER_BUSY`, so the founder is free from the next tick, as for every activity.

**Pacing: the game pauses when a call connects.** At M002 pacing, a 15-minute call is 5 real seconds at 1×. That's too short to read what Kessler says and decide. So the worker's scheduler sets speed 0 at the tick a call connects, as if the player had paused. The batch that applies the connecting `PLACE_CALL` ends at that tick (ADR 0014 lets the scheduler choose batch sizes). Resuming is the player's choice. The UI's "hang up" just restores the previous speed: hanging up early isn't a command in M002, because the call's time is spent either way. While paused, eager commands apply at `state.tick + 1 ≤ busy.until`, so every order lands on the call. The scheduler reads only founder state, which is always known, and only chooses batch sizes, so this leaks nothing and keeps determinism. The lab never pauses: it issues its orders at the connect tick. The presentation (a call scene, its copy) is visual direction: PLACEHOLDER.

### 5. Calls in

**What generates them.** The world knows things the founder doesn't, and parties call when something they'd tell you on the phone is news to you. Calls in come only from parties with a phone, and they're defined by game-data rules:

```ts
// packages/contracts/src/knowledge.ts (a domain type: held messages carry it)
export type CallInReason = "NEW_CONTRACT_OFFER" | "INSTALLMENT_DUE";

// packages/game-data/src/phones.ts (ADR 0012: game-data's own definition type, from contract primitives)

export interface CallInRule {
  readonly partyKind: Exclude<PartyKind, "FACILITY">;
  readonly reason: CallInReason;
  /** The subject the trigger reads. Validated: in KNOWLEDGE_VISIBILITY.PHONE[partyKind] and .MESSAGE[partyKind]. */
  readonly subjectKind: SubjectKind;
  /** Chance per window while the trigger holds. */
  readonly chancePpm: number;
  /** INSTALLMENT_DUE only: how close the deadline must be. null for other reasons. */
  readonly withinTicks: number | null;
}

export const CALL_IN_RULES: readonly CallInRule[] = [
  // PLACEHOLDER tuning
  { partyKind: "BUYER", reason: "NEW_CONTRACT_OFFER", subjectKind: "CONTRACT_OFFERS", chancePpm: 250_000, withinTicks: null },
  { partyKind: "BUYER", reason: "INSTALLMENT_DUE", subjectKind: "CONTRACT_PROGRESS", chancePpm: 250_000, withinTicks: 1_440 },
];
export const CALL_IN_INTERVAL_TICKS: number; // PLACEHOLDER 60: once an hour, on the hour
```

Suppliers have no rules in M002 (PLACEHOLDER). The table can add some, for example "your order is in", later.

**Triggers.** Each trigger reads only the caller's subject named by the rule (world values), the founder's knowledge, and always-known state:

- **`NEW_CONTRACT_OFFER`:** the world's `CONTRACT_OFFERS` for this buyer lists an offer whose ID isn't in the founder's known `CONTRACT_OFFERS` record for this buyer (or there's no record and at least one offer).
- **`INSTALLMENT_DUE`:** an `ACTIVE` contract with this buyer, per the world's `CONTRACT_PROGRESS`, has an installment with `outcome === null`, `delivered < required` and `now < deadline ≤ now + withinTicks`, and the founder's known `CONTRACT_PROGRESS` record for that contract is absent or has `learnedAt < deadline − withinTicks`. Once the founder learns the contract's progress inside that window, by any channel, the buyer stops calling about it.
- **Common conditions**, all always-known or knowledge:
  - the caller's place is open (`PLACE_HOURS`);
  - the founder isn't `PRESENT` at the caller's place, and isn't on a call with it;
  - the family has at least one number (below).

  "Knowledge" here means `knowledge.records` only, never pending news or held messages. Those are hidden until delivered, and K2 perturbs them (decision 10), so a trigger that read them would let hidden state decide whether the founder's phone rings. A waiting message isn't repeated by a different mechanism: a new message replaces an older one held at the same place from the same caller for the same reason (decision 6).

**Windows and the draw.** On every tick with `tick % CALL_IN_INTERVAL_TICKS === 0`, the `phones` phase (decision 8) visits each party with a phone in `compareIds` order of location, and each rule for its kind in table order. If the trigger holds, the caller calls iff a keyed draw (decision 7) is below `chancePpm`. "The caller may try again later or give up" (GDD §20) falls out of this: they try again each window while the trigger holds, and stop when it no longer does (the offer expires, the installment settles, or the founder learns it).

**The family's numbers, and who answers.** The family's numbers are the locations with a family line, plus every `PHONES` entry with `holdsMessages`, excluding the caller's own place. A call reaches the first of these that answers:

1. **The founder:** if the founder is `PRESENT` (busy or not) at a family line, or at a `holdsMessages` phone whose place is open, and that line isn't engaged, the founder answers. The founder's own presence comes first. That's always-known state, so it leaks nothing (decision 9 explains why it has to be first).
2. Otherwise, the numbers that aren't engaged, in `compareIds` order. At a family line, the **call-in attendant hook** (decision 9) takes a message (`takenBy: characterId`). At a `holdsMessages` phone whose place is open, whoever keeps it (the party there, or the proprietor) takes one (`takenBy: null`).
3. Otherwise it **rings out**.

**A line is engaged** while the founder's active call uses it: the phone at the founder's place, and the line at `call.locationId`. A caller who reaches an engaged number gets the busy signal and **moves on to the next number** in step 2. If every number is engaged or unanswered, the call rings out. A `RESTING` founder doesn't answer (they're asleep), and neither does one who is travelling or riding.

**Outcomes:**

| Outcome | State change | Transaction | Event | Player learns |
|---|---|---|---|---|
| The founder answers | The caller's `KNOWLEDGE_VISIBILITY.PHONE[partyKind]` subjects are written as records (source `PHONE { partyLocationId: caller }`, `learnedAt = tick`), clearing their `pendingBooks` entries (ADR 0021 decision 7); an activity item `CALL_RECEIVED` | One with **no entries**, kind `TELEPHONE`, key `idempotencyKey("TELEPHONE", "IN", callerLocationId, reason, windowIndex)` | `CALL_RECEIVED { callerLocationId, phoneLocationId, reason }` | At once |
| A message is taken | A `HeldMessage` is added to `pendingMessages` at that number (decision 6) | The same shape: no entries | `MESSAGE_TAKEN { callerLocationId, heldAtLocationId, takenBy, reason }` | When the message is delivered |
| Rings out | **None**: no state, no RNG state, no counter, no transaction, no event | None | None | Nothing, ever |

An answered call in is **informational in M002**. It isn't a call context for orders and doesn't make the founder busy (PLACEHOLDER simplification). To act on it, the founder calls back, which costs time and a coin. PT2 or PT3 may revisit that.

`windowIndex = tick / CALL_IN_INTERVAL_TICKS` (an exact integer on a window tick).

**Employees calling in** (a Distiller reporting by phone, GDD §21) use the same numbers and the same answering order. Their content is `REPORT` (ADR 0025), not `PHONE`.

### 6. Messages held where they were taken

**State (amends ADR 0021 decision 7):**

```ts
// packages/contracts/src/knowledge.ts
export interface HeldMessage {
  readonly takenAt: Tick;
  readonly callerLocationId: LocationId;
  /** null: the keeper of a phone that holds messages (not a character). */
  readonly takenBy: CharacterId | null;
  readonly reason: CallInReason;
  /**
   * Copies, at takenAt, of the caller's subjects that KNOWLEDGE_VISIBILITY.MESSAGE[partyKind]
   * grants, sorted like knowledge records.
   */
  readonly values: readonly { readonly subject: KnowledgeSubject; readonly value: KnowledgeValue }[];
}

/** Messages waiting at one place, oldest first, at most MESSAGE_LIMIT (game-data). Like K1's PendingNews. */
export interface PendingMessages {
  readonly locationId: LocationId;
  readonly items: readonly HeldMessage[];
  readonly dropped: number;
}

export interface KnowledgeState {
  // K1's fields (records, pendingNews, pendingBooks, activity, lastCatchUp), plus:
  /** One entry per place with messages waiting, sorted by `locationId` with `compareIds`. */
  readonly pendingMessages: readonly PendingMessages[];
}

/** A delivered message as the player sees it: what it said, not the values (those go into records). */
export interface DeliveredMessage {
  readonly takenAt: Tick;
  readonly heldAtLocationId: LocationId;
  readonly callerLocationId: LocationId;
  readonly takenBy: CharacterId | null;
  readonly reason: CallInReason;
  readonly subjects: readonly KnowledgeSubject[];
}
```

**Taking a message.** If the place already holds a message from the same caller for the same reason, the old one is removed and the new one appended, so the list stays oldest first. Otherwise the new one is simply appended. So a buyer who keeps calling about the same thing leaves one up-to-date message, not a pile. `MESSAGE_LIMIT` (game-data, PLACEHOLDER 10) caps each place. Past it, the oldest message drops and is counted in `dropped`, as for pending news.

**What a message carries: the `MESSAGE` rows of `KNOWLEDGE_VISIBILITY`** (ADR 0021 decision 6 asked for them):

| Source | Party | Reveals |
|---|---|---|
| `MESSAGE` | Buyer | `CONTRACT_OFFERS`, `CONTRACT_PROGRESS` for their contracts. **Not** `BUYER_WANTS`, `BUYER_BUDGET` or `STANDING`: "Kessler wants 20 more by Thursday" is about the contract, not his price |
| `MESSAGE` | Supplier | Nothing in M002 (no supplier rules) |
| `MESSAGE` | Facility | Nothing until ADR 0025 and ADR 0026 |

`MESSAGE` doesn't reveal `BUYER_WANTS`, so ADR 0021's pairing rule (`BUYER_WANTS` ⇒ `STANDING`) holds trivially. Load validation adds: every `CALL_IN_RULES[i].subjectKind` is in both `PHONE[partyKind]` and `MESSAGE[partyKind]`, so a call in's trigger is always among what it delivers (decision 9 relies on this).

**Delivery.** Messages held at L are delivered:

- **on arrival or waking at L**, in the same step as ADR 0021's arrival catch-up, but only if L is open (own facilities always are);
- **while the founder is `PRESENT` at L and L is open**, at the start of the `phones` phase (decision 8). That covers arriving before opening and waiting;
- **on an answered call to L** whose phone holds messages (decision 3), inside the `PLACE_CALL` transaction.

**How a delivery is reported.** Every delivery, whichever way it happens, writes one `MESSAGE_DELIVERED` activity item per message. If the place's `dropped` count is above 0, it adds a single `MESSAGES_DROPPED { locationId, count }` item. It emits `MESSAGES_DELIVERED { locationId, count, dropped, via: "ARRIVAL" | "PRESENT" | "CALL" }`, then clears that place's entry. A place with no messages and nothing dropped emits nothing.

**`CatchUp` and `KNOWLEDGE_CAUGHT_UP` don't change.** K1's `CatchUp` (`packages/contracts/src/knowledge.ts`), and the `KNOWLEDGE_CAUGHT_UP` payload derived from it (`Omit<CatchUp, "tick">`), stay as they are. Messages delivered on arrival are reported only through the activity items and `MESSAGES_DELIVERED { via: "ARRIVAL" }`, written in the same step. The UI can show them next to the arrival summary. This keeps a saved `knowledge.lastCatchUp`, and any `KNOWLEDGE_CAUGHT_UP` in `eventJournal`, valid without a migration (decision 13).

Messages are never taken where the founder is present, because the founder answers there (decision 5), so nothing piles up under their nose.

**Writing delivered values (clarifies ADR 0021 decision 4):**

- **Older values never overwrite newer ones.** A message's values are written with `learnedAt = takenAt` and source `MESSAGE { takenAtLocationId, takenBy }`. Each one replaces the stored record only if **`record.learnedAt < takenAt`** (strict), or if there's no record.
  - **Why strict:** a message is copied in the `phones` phase of tick `takenAt`, but later phases of that same tick can write a newer value with the same `learnedAt`. For example, an `INSTALLMENT_SETTLEMENT` cash posting in `deadlines` writes `CONTRACT_PROGRESS` with `learnedAt = takenAt` (ADR 0021 decision 6). On a tie, the existing record stays.
  - **The cost** is that a record learned earlier in tick `takenAt` (in `production`, `vehicles` or `resolution`) also stays. That's a lag of less than one tick, never a regression, and it matches the books clause below.
  - A message is the only M002 source that delivers values older than the current tick. ADR 0025's reports may reuse this rule.
- **Books.** A delivered value clears from `pendingBooks` only the entries concerning its subject whose transaction tick is **`< takenAt`**, and only when the value was actually written (the rule above). A value kept back by a tie clears nothing. Transactions posted at or after `takenAt` stay pending, so books never run ahead of the values the founder holds. A transaction posted earlier on the tick `takenAt` stays pending until the subject is next learned. That's a lag, never a wrong book (ADR 0021: "the books can lag, but they never stay wrong").

### 7. Randomness: keyed one-shot draws

**Options considered:** a new `RNG_STREAMS` member `phones` (rejected: one shared stream couples every call. A hidden call that rings out would advance it and shift the next draw the founder sees, which is exactly ADR 0022 decision 8's problem); a per-party ordinal in state (rejected: it needs state, a migration, and care that only the founder's actions advance it); **keyed draws seeded from values hidden activity can't change (chosen)**.

```ts
// packages/simulation/src/rng/xoshiro128.ts (new, beside seedRng)
/**
 * A fresh stream for one keyed draw: seed halves, fnv1a32(key) and the ordinal, mixed
 * with splitmix32 as seedRng does. Integer-only; no transcendental math.
 */
export function keyedRng(seed: number, key: string, ordinal: number): RngState;
```

If SK1c's per-trip helper (ADR 0022 decision 8) is already general enough, C1 reuses it rather than adding a second one.

| Draw | Key | Ordinal |
|---|---|---|
| Does the party answer a call out? `nextInt(rng, 1_000_000) < CALL_ANSWER_PPM[partyKind]` | `` `call-out:${locationId}` `` | the apply tick `t` |
| Does the party call in this window? `nextInt(rng, 1_000_000) < rule.chancePpm` | `` `call-in:${callerLocationId}:${reason}` `` | `windowIndex` |

`CALL_ANSWER_PPM: Readonly<Record<Exclude<PartyKind, "FACILITY">, number>>` (game-data): PLACEHOLDER `{ BUYER: 850_000, SUPPLIER: 900_000 }`.

- **Every input is fixed by things hidden activity can't change:** `GameState.seed`, static location IDs, static reasons, and the tick. No draw is stored, so a call that rings out or never happens advances nothing.
- **Phones draw from none of the four existing streams,** so M001's market, contract, route and production draws are untouched.
- **Retrying the same party later is a fresh draw.** Retrying on the same tick is impossible, because the founder is busy.

### 8. Tick order

`PHASES` becomes `production, vehicles, [world events], resolution, founder, phones, deadlines, midnight` (amends ADR 0023 decision 2a), followed by ADR 0021's persist step.

- **Commands** (first in the tick): `PLACE_CALL`, `INSTALL_PHONE`, and by-phone orders apply here, under the busy rule in decision 4.
- **`founder`, step 1 (busy ends):** if `busy.until ≤ tick` and the activity is `PHONE_CALL`, persist the call view into records, then clear `call` and `busy`. `PHONE_NO_ANSWER` and `INSTALL_PHONE` just clear `busy`. Arrival and waking (steps 2–4) deliver messages in the same step as the catch-up (decision 6).
- **`phones` (new, after `founder`):**
  1. Deliver messages at the founder's place if they're `PRESENT` and it's open.
  2. On a window tick, run calls in (decision 5).

  It runs after `founder` so that this tick's arrivals, wakings and call endings are settled. A founder who arrives at the still on a window tick can answer, and a line freed this tick isn't engaged. It runs before `deadlines`, so an `INSTALLMENT_DUE` call on a deadline tick sees the installment before it settles. The trigger needs `now < deadline`, so a call never happens for an installment settling on the same tick.
- **Persist step:** it also persists the call view (decision 4).
- **Same tick as a busy end:** a call that ends at tick `u` is cleared in `founder` at `u`. A call in at window tick `u` then finds the line free and the founder answering (if they're at a family number). The founder's next `PLACE_CALL` applies from `u + 1` (decision 4). That's consistent with ADR 0023's "free from the next tick", since answering a call in isn't a command.

**No-trap bound (ADR 0023 decision 8).** The new timed activities (`PHONE_CALL`, `PHONE_NO_ANSWER`, `INSTALL_PHONE`) are `ACTIVITY_DURATIONS` rows, so the bound `B`'s "longest `ACTIVITY_DURATIONS` × `TIRED_DURATION_PPM`" covers them. Calls in never make the founder busy. `REST` is still never refused for anything phone-related.

### 9. The attendant hook and the communication gate

**The attendant hooks.** "Someone stationed at a place with a phone" is ADR 0026's Office Hand (D5b). The two directions have different non-leak requirements, so there are **two hooks**, and the call-out hook's type enforces its requirement, as ADR 0022's `IssuerView` does for validators:

```ts
// packages/simulation (internal; ADR 0026 implements both. M002 before E3: both return null)

/**
 * Who answers the family line at `locationId` when the FOUNDER calls it. Its result decides
 * the call's immediate outcome and the CALL_PLACED activity item, so it sees only the
 * player view (knowledge, always-known state including agreements such as stations and
 * hours, the live view) plus the game seed and the tick for a keyed draw (decision 7).
 * It can't read GameState.
 */
type CallOutAttendant = (view: PlayerView, data: GameData, locationId: LocationId, seed: number, tick: Tick) => CharacterId | null;

/**
 * Who takes a message on the family line at `locationId` when a party calls in. It may read
 * world state (an Office Hand away on an errand), because its only output is a held message,
 * which is hidden until it's delivered (decision 10).
 */
type CallInAttendant = (state: GameState, data: GameData, locationId: LocationId) => CharacterId | null;
```

**Requirements on ADR 0026:**

- `CallOutAttendant` may not call `CallInAttendant`, or read anything outside its arguments.
- The two may disagree. For example, an Office Hand on an errand misses a call in, but by the agreements they're "at the office" for the founder's call out.
- Nothing player-visible may come from `CallInAttendant` except through a delivered message.

The last rule is also why the founder answers calls in first in decision 5: if the founder came after an attendant whose answer could depend on hidden state, whether the founder hears a call would leak that state.

**The communication gate (ADR 0022 decision 4).** An order for an employee reaches them:

```ts
type Reach = "IN_PERSON" | "PHONE" | null;
// IN_PERSON: the founder is PRESENT at the employee's station.
// PHONE: the founder is PRESENT, call !== null, call.locationId === the station, and
//        call.answeredBy is { kind: "EMPLOYEE" } (the attendant passes it on, or it's the employee:
//        ADR 0026 decides which employees a call reaches).
// null: NO_WAY_TO_REACH { characterId }.
```

Every input is founder state, the station (an agreement) and phone geography, which is what ADR 0022 requires. Placing the call is an order like any other, and it can go unanswered. That's how "the call connects" becomes an outcome rather than a rejection.

### 10. Non-leak: amendments to ADR 0021 decision 9

- **The static half** compares the player view: knowledge, the always-known state, and the live view. **The call view is part of the live view** for this purpose. It's a function of always-known founder state (`call`) and world values that the channel delivers.
- **The dynamic half's delivery clause** reads: "…until the first tick at which a channel delivers a subject in D_t, **news or a held message** whose content differs between the runs, or a cash posting that differs." A message copies values at `takenAt`, which may have converged again by the time it's delivered, so its delivery is a channel in its own right, like news.
- **K2's generators** perturb `pendingMessages` as they perturb pending news.

### 11. Party lines

Flavour only in M002 (GDD §20). There's no state, no rule and no event: an operator who listens is copy in the call scene (PLACEHOLDER, needs-design). The world events `CALL_PLACED`, `CALL_RECEIVED` and `MESSAGE_TAKEN` already record who called whom and when, which is all a later surveillance or police channel would read. Adding that later is new rules over existing events, not a new shape.

### 12. Flag off (`founderRules: false`)

- **`PLACE_CALL` and `INSTALL_PHONE` apply as no-ops,** as ADR 0023 decision 9 does for `TRAVEL`, `REST` and `WAKE`: accepted, no domain state changed, no transaction. Their envelopes still go into `commandLog`. Lab strategies don't send them.
- **The `phones` phase does nothing.** `pendingMessages` stays empty, `call` stays null and `phoneLine` stays null.
- **By-phone orders never arise:** the presence gate passes everywhere (ADR 0023 decision 9).
- **The phone isn't equipment** (decision 2), so M001's equipment catalog, `equipmentOptions` and slot rules are unchanged.
- **No existing RNG stream is drawn** (decision 7).

So M001 and the lab play exactly as before. The new fields move the state hashes, and the contract task regenerates the fixtures as K1, P1 and O1a do.

### 13. Saves (ADR 0009)

The required fields `FacilityState.phoneLine`, `PRESENT.call` and `KnowledgeState.pendingMessages` bump `SAVE_SCHEMA_VERSION`: the next version after O1b's (v6 if the K1 → P1 → O1a → O1b sequence holds). The migration reads only the save's own fields and never game-data:

| New field | Value | Source |
|---|---|---|
| `facilities[i].phoneLine` | `null` | None needed: no earlier save can own a line (no command could install one) |
| `founder.whereabouts.call`, when `whereabouts.kind === "PRESENT"` | `null` | The save's own `founder.whereabouts.kind`. No earlier save can be on a call |
| `knowledge.pendingMessages` | `[]` | None needed: no earlier save can hold a message |

**Fields that don't change:**

- **`knowledge.lastCatchUp`** and any `KNOWLEDGE_CAUGHT_UP` events in `eventJournal`: `CatchUp` doesn't change (decision 6), so a saved non-null `lastCatchUp` and journaled catch-up events still validate. No migration step reads them.
- **New union members** (`ActivityKind`, `ActivityItem`, `PlayerPlace`, command, event, rejection and `TransactionKind`) are additive. Existing saves satisfy them, so they need no migration (ADR 0009). `PlayerPlace` isn't saved at all.

No existing command changes shape, because the by-phone context is derived (decision 4). The task adds the fixture save and migration test the persistence tests expect (ADR 0009), as K1 and its successors do.

### 14. Rejection reasons

`PLACE_CALL` (this record owns its reasons), in ADR 0022 §1's gate order, table order within a gate:

| Gate | Failure | Reason |
|---|---|---|
| 1 Shape, identity | `locationId` isn't a location | `UNKNOWN_ENTITY { kind: "Location", id }` (existing) |
| 2 Presence | Travelling, riding or resting | `FOUNDER_AWAY { whereabouts }` (ADR 0023) |
| 2 Presence | No family line and no `public` `PHONES` entry where the founder stands, whatever the hours | **`NO_PHONE_HERE { locationId }`** (new): `locationId` is the founder's place |
| 2 Presence | Busy, including on a call | `FOUNDER_BUSY { until }` (ADR 0022) |
| 2 Presence | The public phone's place is closed (a family line never is) | `PLACE_CLOSED { locationId, opensAt }` (ADR 0022) |
| 5 Validity | The target is the founder's own place | `ALREADY_THERE` (ADR 0023) |
| 5 Validity | No phone at the target (no `PHONES` entry, no family line) | **`NO_PHONE_THERE { locationId }`** (new) |
| 5 Validity | Cash below `CALL_COST` | `INSUFFICIENT_FUNDS { required, available }` (existing) |

`INSTALL_PHONE`:

| Gate | Failure | Reason |
|---|---|---|
| 1 | Not a family facility | `UNKNOWN_ENTITY { kind: "Facility", id }` |
| 2 | Not present there | `NOT_PRESENT { requiredLocationId, issuerLocationId }` (ADR 0022) |
| 2 | Busy | `FOUNDER_BUSY { until }` |
| 5 | Already has a line | **`PHONE_ALREADY_INSTALLED { facilityId }`** (new) |
| 5 | `PHONE_LINE.requiredUnlockId` not held | `LOCKED { unlockId }` (existing; world tier, which agrees with known `STANDING` while present) |
| 5 | Cash below the price | `INSUFFICIENT_FUNDS` |

By-phone `AGREE_DEAL` and `ACCEPT_CONTRACT` reuse ADR 0022's reasons. `NOT_PRESENT` when neither present nor on a call with the party. "No answer", "rang out" and "line engaged" are outcomes, never reasons (ADR 0022 decision 4).

Every new reason's payload is always-known: the founder's place, phone geography and family lines, and the founder's own facility.

### 15. Contract changes (their own task)

One contract-change task, filed when this ADR merges, after O1b in the contract sequence (it shares `state.ts`, `commands.ts`, `events.ts`, `schemas.ts`, `save.ts` and the hash fixtures):

- `state.ts`:
  - `FacilityState.phoneLine`;
  - `ActiveCall`, `CallAnswerer`, and `FounderWhereabouts.PRESENT.call`;
  - `ActivityKind` gains `PHONE_CALL`, `PHONE_NO_ANSWER` and `INSTALL_PHONE`.
- `commands.ts`:
  - `PlaceCallCommand` and `InstallPhoneCommand` (types, `GameCommand`, `GAME_COMMAND_TYPES`);
  - the reasons `NO_PHONE_HERE { locationId }`, `NO_PHONE_THERE { locationId }` and `PHONE_ALREADY_INSTALLED { facilityId }`.
- `events.ts`: `CALL_PLACED { fromLocationId, locationId, answered, answeredBy: CallAnswerer | null, transactionId }`, `CALL_RECEIVED { callerLocationId, phoneLocationId, reason }`, `MESSAGE_TAKEN { callerLocationId, heldAtLocationId, takenBy, reason }`, `MESSAGES_DELIVERED { locationId, count, dropped, via }`, `PHONE_INSTALLED { facilityId, price, transactionId }`. The task finalises the payloads, using these fields at least.
- `ledger.ts`: `TransactionKind` `TELEPHONE`. `projection/finance.ts`'s `CASH_FLOW_CATEGORY` maps it to `OVERHEAD`. That's simulation code, C1's.
- `knowledge.ts`:
  - `HeldMessage`, `DeliveredMessage` and `KnowledgeState.pendingMessages`;
  - `PendingMessages`;
  - `CatchUp` is **unchanged** (decision 6), and so is `KNOWLEDGE_CAUGHT_UP`;
  - `ActivityItem` gains `CALL_PLACED { locationId, answered, answeredBy: CallAnswerer["kind"] | null }`, `CALL_RECEIVED { callerLocationId, phoneLocationId, reason }`, `MESSAGE_DELIVERED { message: DeliveredMessage }`, `MESSAGES_DROPPED { locationId, count }` and `PHONE_INSTALLED { facilityId }`, each with K1's `tick`;
  - `CallInReason` (defined here; game-data's `CallInRule` imports it, ADR 0012).
- `player-snapshot.ts`: `PlacePhone`; `PlaceGeography.phone`; the `EmptyPlace` variant (`kind: "NONE"`) of `PlayerPlace`, for a location with no occupant in the scenario (decision 1).
- `snapshot.ts` (world): `FacilitySnapshot.phoneLine: { bookValue: Money } | null`, for the debug view.
- `schemas.ts`, `save.ts`: Zod for all of the above; the bump and the migration in decision 13, with an old-version fixture.
- `packages/game-data/src/phones.ts` (new): `PhoneDefinition`, `PHONES`, `PhoneLineDefinition`, `PHONE_LINE`, `CALL_COST`, `CALL_ANSWER_PPM`, `CallInRule`, `CALL_IN_RULES`, `CALL_IN_INTERVAL_TICKS`, `MESSAGE_LIMIT`, with load validation (one entry per location; rule subjects in both the `PHONE` and `MESSAGE` rows).
- Other game-data:
  - `ACTIVITY_DURATIONS` rows `PHONE_CALL`, `PHONE_NO_ANSWER` and `INSTALL_PHONE`;
  - `KNOWLEDGE_VISIBILITY` `MESSAGE` rows (decision 6);
  - `ACTIVITY_IMPORTANCE` rows: `CALL_RECEIVED` and `MESSAGE_DELIVERED` are `notify`, the others `info` (PLACEHOLDER).
- `packages/simulation/src/kernel/registry.ts` and `simulation.ts`: `phones` in `PHASES` between `founder` and `deadlines`. Its hooks are C1's.

C1 (#179) implements the behaviour:

- the commands and the `phones` phase;
- the call view and message delivery in the player snapshot builder;
- `keyedRng`;
- the scheduler's pause on connect (`apps/game/src/workers/scheduler.ts`);
- the producer coverage rows.

ADR 0026 fills both attendant hooks and the `FACILITY` rows.

## Design-record checklist (factory.md §1)

### 1. Non-leak, per command and surface

Inputs to every surface below are always-known state (founder whereabouts including `busy` and `call`, cash, agreements including family lines, geography including `PHONES` and `PLACE_HOURS`), knowledge, the live and call views, or a keyed draw on hidden-independent inputs (decision 7).

| Command or event | Immediate result | Activity item | Catch-up | Books row | Snapshot field |
|---|---|---|---|---|---|
| `PLACE_CALL` | Reasons in decision 14, all from always-known state. Applied whether or not anyone answers | `CALL_PLACED`: the answer comes from hours (known), a keyed draw, or `CallOutAttendant`, which by its type reads only the player view, the seed and the tick (decision 9) | None | `TELEPHONE` row with entries iff answered; known by rule 1 | `founder.call`; the call view (a channel); delivered messages |
| By-phone `AGREE_DEAL` | Validated against the call view only; no budget (ADR 0022 decision 6) | Inputs plus call-view values | None | None (a deal moves no cash) | The held deal (an agreement) |
| By-phone `ACCEPT_CONTRACT` | `CONTRACT_OFFERS` and `STANDING` from the call view; world tier agrees (decision 4) | Inputs only (ADR 0022: not the reserved count) | None | Reservations with no entries never appear | Contract terms (an agreement) |
| `INSTALL_PHONE` | Reasons in decision 14: presence, own facility, cash, live-view tier | `PHONE_INSTALLED` | None | `TELEPHONE` install row, rule 1 | `places[].phone`, `phoneLine` |
| Call in, the founder answers | — | `CALL_RECEIVED`. The trigger reads only a subject the call delivers, plus knowledge (decision 6 validation), so a call that differs between runs delivers a subject in D_t | None | Entry-less; never in books | Records with source `PHONE` |
| Call in, message taken | — | None until delivered | None until delivered | Entry-less | None. `pendingMessages` isn't projected |
| Call in, rings out | — | None | None | None | None. No state changes at all |
| Message delivery (arrival, present, call) | — | `MESSAGE_DELIVERED` per message, plus `MESSAGES_DROPPED` (all three ways) | Unchanged (K1's `CatchUp`); arrival delivery is reported through activity | Clears only entries with tick `< takenAt`, and only for values actually written | Records with source `MESSAGE` (only where `record.learnedAt < takenAt`) |
| Call end (`founder` phase) | — | None | None | None | Call view persisted to records |

### 2. Coverage tables (ADR 0021 decisions 6 and 7)

| Producer (idempotency-key family) | Entries | Classification |
|---|---|---|
| `TELEPHONE:CALL:<commandId>` | Dr `OVERHEAD_EXPENSE` / Cr `CASH` when answered; none otherwise | Rule 1: the founder's own command. No row needed in either table |
| `TELEPHONE:INSTALL:<facilityId>` | Dr `EQUIPMENT` / Cr `CASH` | Rule 1. No row needed |
| `TELEPHONE:IN:<caller>:<reason>:<window>` | None, ever | Rule 4: never in the books. No row needed |

Phones add no producer that can post entries without a founder command, so neither table gains a row. K1's `TRANSACTION_PRODUCERS` registry (`packages/contracts/src/knowledge.ts`) gains the three families, which the coverage test checks against the simulation's `idempotencyKey(...)` call sites:

```ts
"TELEPHONE:CALL": { trigger: "FOUNDER_COMMAND", legs: ["CASH", "NO_ENTRIES"] },
"TELEPHONE:INSTALL": { trigger: "FOUNDER_COMMAND", legs: ["CASH"] },
"TELEPHONE:IN": { trigger: "WORLD", legs: ["NO_ENTRIES"] },
```

### 3. Migration

From save fields only (decision 13): `phoneLine: null`, `call: null` (read from `whereabouts.kind`) and `pendingMessages: []`. No game-data reads. `CatchUp` and `KNOWLEDGE_CAUGHT_UP` are deliberately left unchanged, so saved `lastCatchUp` values and journaled catch-up events need no step.

### 4. Re-locks

**None.** Verified against the ten `@locked` files under `packages/simulation/test`:

- **No locked file builds a `FacilityState` literal.** Fixtures spread existing facilities, and `prod-001.locked.test.ts` line 1282 builds a `ScenarioFacility`, which doesn't change.
- **None enumerates `PHASES`, `ActivityKind`, `GameCommandType` or `RejectionCode` exhaustively.** `fin-001.locked.test.ts`'s `KIND_DEFAULT` is a `Partial<Record<TransactionKind, …>>`, so a new kind doesn't break it.
- **The equipment catalog is unchanged** (decision 2, option (a) rejected for exactly this reason).
- **No locked test draws from a stream phones would touch** (decision 7).

The state-hash fixtures (not locked) move with the new fields. The contract task regenerates them, as its predecessors do.

### 5. Tick order

`phones` runs between `founder` and `deadlines` (decision 8). Calls end in `founder` step 1. On-call orders are allowed at `t ≤ busy.until`, and every other founder command is `FOUNDER_BUSY` through `busy.until` (decision 4). A call in on the tick a call ends finds the line free.

### 6. Flag off

M001 and the lab are unchanged (decision 12): the commands are no-ops, the phase is idle, the fields stay empty, and no RNG stream or equipment rule changes.

### 7. Randomness

Keyed one-shot draws (decision 7), never a shared stream. Their seeds come from `GameState.seed`, static IDs and the tick, and they store nothing. A hidden call (one that rings out, or never triggers) can't shift any draw the founder sees.

### 8. Rejection reasons

- **New:** `NO_PHONE_HERE { locationId }`, `NO_PHONE_THERE { locationId }`, `PHONE_ALREADY_INSTALLED { facilityId }`.
- **Reused:** `UNKNOWN_ENTITY`, `FOUNDER_AWAY`, `FOUNDER_BUSY`, `PLACE_CLOSED`, `ALREADY_THERE`, `NOT_PRESENT`, `LOCKED`, `INSUFFICIENT_FUNDS`, and ADR 0022's deal and offer reasons for by-phone orders.
- **Not reasons:** answering, ringing out and an engaged line are outcomes.

## Consequences

- **The phone becomes a milestone, as GDD §20 wants.** Before a line and an Office Hand, calls in from buyers reach the founder only while they stand at a family number. With both, they turn into messages. A line alone already lets the founder call out from home, and with the PLACEHOLDER table every public phone is a stop on someone's route.
- **By-phone deals arrive with C1,** and they're weaker than in-person ones: demand-capped, with no budget commitment (ADR 0022 decision 6). Being there still pays (GDD §18).
- **Pausing on connect is new scheduler behaviour.** It's the first time the scheduler stops itself rather than speeding up (ADR 0023's rest fast-forward). PT2 or PT3 judges whether it feels right, or whether calls should instead be a modal that holds the clock.
- **Answered calls in are informational only** in M002. If playtests want to accept an offer on the spot, a call in can open the same `call` context later, with the founder made busy. The shapes allow it.
- **The phone line can't be sold,** so ADR 0020's restart analysis ignores it, and buying one with the last cash is a real risk. R1 (#176) should check that a sensible founder doesn't need one to reach the first hire, or should account for its price if they do.
- **Message values can be older than records.** Decision 6's "older never overwrites newer" rule and its books clause are the first time ADR 0021's "newest wins" has to handle a late delivery. ADR 0025's reports can reuse them.
- **Party lines and surveillance** build on the world events defined here, without reshaping them.

## Needs design (placeholders in this record)

These are story and visual direction (factory.md §8). The human decided most of them on #203, and ADR 0027 (#213) records that decision:

- **Which places have phones, and who may use them:** settled by #203 and ADR 0027 decisions 1–2. Miller's has a business phone the founder earns the use of, Kessler's a private line, Lakeview a guest phone for a room stay, the depot a public phone for a fee; the Crossroads has none.
- **The hotel lobby phone's hours:** settled. The lobby has its own hours (ADR 0027 decisions 1, 2 and 4, `LAKEVIEW_LOBBY_HOURS`).
- **Whether any place holds messages for the family before the founder owns a phone:** settled. Miller's, once earned (ADR 0027 decisions 3 and 6). `holdsMessages` is replaced.
- **Names and copy:** the operator's lines, the unanswered line, Miller's message line and the message template are approved (ADR 0027 decision 10's copy table). Still open: the {message} wording for each `CallInReason` (ADR 0027 *Needs design*).
- **The call scene and the pause-on-connect presentation:** direction approved in #203 §4, and the pause lives in the worker's speed control (ADR 0027 decision 10). The visual design is still open.
- **Tuning (R1, T-LAB):** `PHONE_LINE.price`, `CALL_COST`, `CALL_ANSWER_PPM`, `CALL_IN_RULES` chances and windows, `MESSAGE_LIMIT`, and the three `ACTIVITY_DURATIONS` rows, plus ADR 0027's numbers.
