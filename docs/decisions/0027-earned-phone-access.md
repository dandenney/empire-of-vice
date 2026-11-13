# 0027: Earned phone access and message-taking

Status: accepted (decided by the orchestrator for M002 task D4b, issue #213, from the human's design decision on #203; implemented by PH1 #205 and C1 #179)

Amends: ADR 0023 decisions 2a, 4 and 7 (a founder-phase checkout step, the `CHECK_IN` activity, a rented room as a rest place), ADR 0024 decisions 1, 3, 4, 5, 6, 8, 9, 13, 14 and 15 (the phone table, who may call from where, the pause, the family's numbers and callers' hours, where messages are taken and delivered, the `phones` phase's delivery step, the call-in hook's tick, the save fields, the rejection reasons, the contract list), ADR 0025 decision 7 ("a public phone that `holdsMessages`" becomes a place that takes messages under an arrangement), ADR 0026 decisions 9 and 10 (road calls, which phones the founder may use to reach an Office Hand).

## Context

ADR 0024 modelled a telephone with two booleans: `public` (the founder may call from it while the place is open) and `holdsMessages` (whoever keeps the place takes messages for the family), `false` everywhere as a PLACEHOLDER. The human's decision on #203 replaces that. Its core principle: **relationships unlock access, and repeated dealings turn access into trust.** The binding points:

- **Three separate privileges** (#203 §1): a place *has a telephone*; the founder *is allowed to use it*; the place *agrees to receive messages for the founder*.
- **Per place in M002** (#203 §1): Miller's Feed & Seed has a business telephone that Miller lets the founder use because the Kerrigans buy supplies from him, earned through small, early, achievable dealings ("the first call should not require an elaborate relationship grind"). Kessler's has a private business line: Kessler answers for business, and the founder gets no use of it. Lakeview Hotel has a lobby/guest telephone: renting a room grants use for that stay, on the lobby's own hours, not the back room's 20:00–02:00. Riverside Depot has a genuinely public telephone, during its hours, for a fee. The Crossroads has none. Hollow Creek has none until a line is installed.
- **Messages are earned** (#203 §2): Miller can become the family's early message contact through continued supply purchases; a depot attendant never does. The hotel's progression (first-time guest → returning guest → established regular) is described, with the regular's line as "aspirational flavor for the later stage, not a promise that all message/room features ship immediately". Reputation alone never unlocks a private service. Privileges can be lost if the arrangement lapses. M002 prefers "a few explicit, explainable milestones to a sprawling relationship-point simulator".
- **Wording, time and pause** (#203 §3–4): approved operator and message lines; unanswered calls take a smaller, nonzero amount of game time; the game pauses while the player reads a connected call, with deterministic simulation timing and no wall-clock cost.
- **Scope** (#203 §5): the telephone is a quality-of-life and coordination upgrade, never a prerequisite for the first business. Introductions, credit, storage, lodging beyond the phone stay, party-line surveillance and incoming calls with requests are later.

**What the code has today (verified on `main` at 8a0e76b).** No phone code has landed: PH1 (#205) is the contract task for ADR 0024, and C1 (#179) its behaviour. `SAVE_SCHEMA_VERSION` is 4 (`packages/contracts/src/save.ts`).

- **Map and parties.** `packages/game-data/src/map.ts` has six locations: `HOLLOW_CREEK`, `MILLERS_FEED_LOCATION`, `CROSSROADS`, `KESSLER_PHARMACY`, `LAKEVIEW`, `RIVERSIDE_DEPOT`. The one supplier is `MILLERS_FEED` at `MILLERS_FEED_LOCATION` (`suppliers.ts`). The buyers are `CROSSROADS_ROADHOUSE`, `KESSLERS_BACK_ROOM` and `LAKEVIEW_HOTEL` at `CROSSROADS`, `KESSLER_PHARMACY` and `LAKEVIEW` (`buyers.ts`). The only scenario file is `scenarios/first-shipment.json`, with `founderRules: false`; the M002 scenario isn't on `main` yet.
- **Presence** (`packages/game-data/src/presence.ts`). `PlaceHoursInterval` is `{ opensAtMinute, closesAtMinute }`, built with the module's `hours(opensAtHour, closesAtHour)` helper and checked by `validatePlaceHours`. `PLACE_HOURS` has Crossroads 11–23, Kessler's 9–19, Lakeview `hours(20, 2)` (the back room, across midnight) and Miller's 7–18. The depot has no entry, so it's always open. `REST_PLACES` is `[HOLLOW_CREEK]`. `ACTIVITY_DURATIONS` is a `Record<ActivityKind, number>` that `validatePresence` checks against `ACTIVITY_KINDS` (`packages/contracts/src/state.ts`), so a new activity kind needs a row there.
- **Purchases.** `registerMarket` (`packages/simulation/src/economy/market/market.ts`) registers the `PURCHASE_MATERIALS` handler, which posts `MATERIAL_PURCHASE:<commandId>`. `REPEAT_OPERATION` (`commands/repeat.ts`) re-runs that handler with the repeat's own context. ADR 0022's gate table requires the founder to be present at an open supplier for it.
- **Founder.** `packages/simulation/src/founder/founder.ts` registers only flag-off no-ops for `TRAVEL`, `REST` and `WAKE`; the founder phase's flag-on behaviour is SK1a's (#198). `FounderState` is `{ whereabouts, awakeSince }`. `CommandIssuer` is `{ kind: "FOUNDER" }` only (`commands.ts`).
- **Kernel.** `PHASES` (`kernel/registry.ts`) is `production, vehicles, resolution, founder, deadlines, midnight`. `TickContext`'s doc says **"`state.tick` is still the previous tick"** while a phase hook runs. That matters for ADR 0026's `CallInAttendant` (decision 9).
- **Knowledge** (`packages/contracts/src/knowledge.ts`). `ACTIVITY_IMPORTANCE` is a `Record<ActivityItem["kind"], "notify" | "log">`. ADR 0024's "`info`" rows mean `"log"`. `transactionProducerOf` resolves a key to the longest family of its upper-case tags.
- **Time** (`packages/contracts/src/time.ts`). `dayIndex(t)` and `minuteOfDay(t)`; `TICKS_PER_DAY` is 1 440.
- **Scheduler** (`apps/game/src/workers/scheduler.ts`). `Speed` is `0 | SpeedMultiplier`, where 0 is paused. The host drives it, and the rest fast-forward is an internal rate, not a `Speed`.

Story and visual items this record doesn't settle (names beyond #203's, wording beyond the approved lines, the call and room scenes) are **PLACEHOLDER** and listed under *Needs design*. Every number here is PLACEHOLDER tuning.

## Decision

### 1. Three privileges, three shapes

ADR 0024's `PhoneDefinition { public; holdsMessages }` is replaced. Each privilege gets its own field:

```ts
// packages/game-data/src/phones.ts (replaces ADR 0024 decision 1's PhoneDefinition)

/** Whether, and on what basis, the founder may call out from a phone (privilege 2). */
export type PhoneUseRule =
  /** Anyone, during the phone's hours. A connected call costs `fee` instead of CALL_COST. */
  | { readonly kind: "PUBLIC"; readonly fee: Money }
  /** A guest: the founder holds a room here (decision 4). */
  | { readonly kind: "GUEST" }
  /** The keeper lets the founder use it under the place's arrangement (decision 3). */
  | { readonly kind: "ARRANGEMENT" }
  /** The keeper's own line. Never the founder's to use. */
  | { readonly kind: "PRIVATE" };

/** Whether the keeper takes messages for the family (privilege 3). */
export type MessageTakingRule = "NEVER" | "ARRANGEMENT";

export interface PhoneDefinition {
  /** Privilege 1: the place has a phone. At most one entry per location. */
  readonly locationId: LocationId;
  /**
   * When it can be used, answered, or take a message: minute-of-day intervals,
   * as in PLACE_HOURS. null: the place's PLACE_HOURS (always, if it has none).
   */
  readonly hours: readonly PlaceHoursInterval[] | null;
  readonly use: PhoneUseRule;
  readonly messages: MessageTakingRule;
}
```

**"The phone at L"** keeps ADR 0024's meaning: the family's line if the family has one at L, otherwise L's `PHONES` entry, otherwise none. A family line is always there, always the founder's to use, and open at every hour. Who answers it or takes messages on it stays ADR 0024–0026's (the attendant hooks).

**A phone's hours.** `phoneOpen(L, t)`: true for a family line; otherwise `minuteOfDay(t)` falls in `PHONES[L].hours`, or in `PLACE_HOURS[L]` when `hours` is null, or always when neither has an entry. One rule for using, answering and taking messages, so the founder can tell from known hours when a phone can be used or can take a message.

**Load validation** (`PhoneDataError`): at most one entry per location, sorted by `compareIds`; every location exists; `hours`, if set, passes the same interval checks as `validatePlaceHours` (at least one interval, whole minutes of the day, ends that differ); a `PUBLIC` fee is a whole number of cents ≥ 1, so a connected call always posts a balanced, non-empty `CASH` leg; a `GUEST` phone's location has a `ROOMS` entry (decision 4); an `ARRANGEMENT` rule, in `use` or `messages`, has an `ARRANGEMENTS` entry for the location (decision 3).

### 2. The M002 phone table

```ts
// packages/game-data/src/phones.ts (PLACEHOLDER tuning; the places and privileges are #203's)
export const PHONES: readonly PhoneDefinition[] = [
  // Kessler's private business line: he answers for business; the founder gets no use of it.
  { locationId: KESSLER_PHARMACY, hours: null, use: { kind: "PRIVATE" }, messages: "NEVER" },
  // The lobby/guest phone, on the lobby's hours, not the back room's 20:00–02:00.
  { locationId: LAKEVIEW, hours: LAKEVIEW_LOBBY_HOURS, use: { kind: "GUEST" }, messages: "NEVER" },
  // Miller's business phone: use and message-taking are both earned (decision 3).
  { locationId: MILLERS_FEED_LOCATION, hours: null, use: { kind: "ARRANGEMENT" }, messages: "ARRANGEMENT" },
  // The depot's public phone, during the depot's hours (always open), for a fee. PLACEHOLDER 10¢.
  { locationId: RIVERSIDE_DEPOT, hours: null, use: { kind: "PUBLIC", fee: cents(10) }, messages: "NEVER" },
  // The Crossroads: no phone. Hollow Creek: none until INSTALL_PHONE (ADR 0024 decision 2, unchanged).
].sort((a, b) => compareIds(a.locationId, b.locationId));
```

`LAKEVIEW_LOBBY_HOURS` is defined in `presence.ts` beside `ROOMS` (decision 4): PLACEHOLDER `[hours(7, 23)]`. The depot keeps ADR 0023's always-open hours. If a station agent's hours are wanted later, it's a `hours` value, not a new shape.

| Place | Has a phone | Founder may use it | Takes messages for the family |
|---|---|---|---|
| Miller's Feed & Seed | Yes, a business phone (PLACE_HOURS 07:00–18:00) | Once the arrangement grants `PHONE_USE` (decision 3) | Once the arrangement grants `TAKES_MESSAGES` |
| Kessler's Pharmacy | Yes, a private business line (09:00–19:00) | Never | Never |
| Lakeview Hotel | Yes, a lobby/guest phone (lobby hours, PLACEHOLDER 07:00–23:00) | While the founder holds a room there (decision 4) | Never in M002 (decision 7) |
| Riverside Depot | Yes, public | Always, during its hours, for the fee | Never |
| The Crossroads | No | — | — |
| Hollow Creek | Not until the family installs a line | The family line, any hour | The family line, as ADR 0024–0026 decide |

**Reputation unlocks none of these.** No privilege reads `STANDING`. It isn't always known (ADR 0021 decision 3), so a privilege that read it would leak too.

### 3. Arrangements: earned milestones at a contact

An **arrangement** is the founder's standing with one contact, built from concrete dealings. In M002 there's one, Miller's, built from supply purchases. It has two milestones and one way to lapse.

```ts
// packages/contracts/src/state.ts
/** A privilege a contact's arrangement can grant (ADR 0027). */
export type ArrangementPrivilege = "PHONE_USE" | "TAKES_MESSAGES";
export const ARRANGEMENT_PRIVILEGES = ["PHONE_USE", "TAKES_MESSAGES"] as const satisfies readonly ArrangementPrivilege[];

/** The family's dealings with one contact. An agreement the founder made: always known. */
export interface ArrangementState {
  readonly locationId: LocationId;
  /** Distinct game days with a qualifying dealing since the arrangement last began. ≥ 1. */
  readonly dealingDays: number;
  /** The tick of the latest qualifying dealing. */
  readonly lastDealingAt: Tick;
}

export interface GameState {
  // …existing fields, plus:
  /** One entry per contact the family has dealt with, sorted by locationId with compareIds (ADR 0027). */
  readonly arrangements: readonly ArrangementState[];
}

// packages/game-data/src/phones.ts
/** What counts as a dealing with a contact. M002: buying from the supplier at the place. */
export type DealingKind = "SUPPLY_PURCHASE";

export interface ArrangementDefinition {
  readonly locationId: LocationId;
  /** The contact's name, for copy ("left word with Miller"). */
  readonly contactName: string;
  readonly dealing: DealingKind;
  /** Dealing days needed for each privilege. Whole numbers ≥ 1. */
  readonly dealingDaysNeeded: Readonly<Record<ArrangementPrivilege, number>>;
  /** The arrangement lapses when no dealing happens for longer than this. ≥ 2 × TICKS_PER_DAY (decision 3's validation). */
  readonly lapseTicks: number;
}

export const ARRANGEMENTS: readonly ArrangementDefinition[] = [
  {
    locationId: MILLERS_FEED_LOCATION,
    contactName: "Miller",                       // #203
    dealing: "SUPPLY_PURCHASE",
    // PLACEHOLDER tuning: the first purchase earns the phone; three days of trade earn messages.
    dealingDaysNeeded: { PHONE_USE: 1, TAKES_MESSAGES: 3 },
    lapseTicks: 7 * TICKS_PER_DAY,               // PLACEHOLDER: a week without buying
  },
];
```

**A qualifying dealing** (`SUPPLY_PURCHASE`): a `PURCHASE_MATERIALS` command with a `FOUNDER` issuer that **applies**, where the named supplier's location is the arrangement's location. That includes one applied through `REPEAT_OPERATION`, which runs the same handler. It's counted inside the purchase's own transaction (`registerMarket`'s handler). A rejected purchase counts nothing. Employee-issued purchases never count: the arrangement is the founder's. ADR 0025 gives the Distiller no purchases in M002 anyway.

**Counting, at the apply tick `t`.** With `A` the arrangement's state and `D` its definition:

- **Lapsed** means `t > A.lastDealingAt + D.lapseTicks`.
- No state, or lapsed: the state becomes `{ dealingDays: 1, lastDealingAt: t }`. A lapsed arrangement starts again from one.
- Otherwise, if `dayIndex(t) > dayIndex(A.lastDealingAt)`: `dealingDays + 1`, `lastDealingAt = t`.
- Otherwise (the same day): `lastDealingAt = t` only. **At most one dealing day per game day**, so three sacks bought one at a time on Monday count as one day. That's "continued dealings", and it can't be ground out in one visit.

**Granted.** `granted(A, D, p, t) = A exists ∧ ¬lapsed ∧ A.dealingDays ≥ D.dealingDaysNeeded[p]`. It's computed, never stored, so a lapse needs no phase, no event and no tick-order slot. It's a pure function of the founder's own applied commands, game-data and the clock.

**What the founder can see** (decision 12): the contact, dealing days so far, each milestone's threshold and whether it's granted, and the last tick the arrangement holds without another dealing (`lastDealingAt + lapseTicks`). When a dealing newly grants a privilege (not granted at `t` before the dealing, granted after), the purchase's transaction emits `ARRANGEMENT_GRANTED { locationId, privilege }` and writes the activity item of the same name. A lapse writes nothing. The snapshot shows it as `lapsed: true`, and the UI can say "Miller hasn't seen you since …" (copy PLACEHOLDER).

**How it's lost.** Only by lapsing in M002: a week with no purchase from Miller (PLACEHOLDER). Both privileges go together. Messages Miller already took aren't lost: they're delivered as before (decision 6). Losing trust in other ways (unpaid credit, a raid traced to him) needs mechanics M002 doesn't have, and a later record adds them as new lapse conditions on the same shape.

**The first call needs no grind.** With `PHONE_USE: 1`, the founder's first sack of corn earns the phone the same morning. That's #203 §1's "small, understandable, and achievable early". Messages take three days of trade.

**Load validation:** one entry per location, sorted; the location has a supplier (for `SUPPLY_PURCHASE`); thresholds are whole numbers ≥ 1; `lapseTicks ≥ 2 × TICKS_PER_DAY`. Purchases on consecutive calendar days can be up to `2 × TICKS_PER_DAY − 1` ticks apart (midnight-to-midnight in general; with Miller's hours, 07:00 on day d to 17:59 on day d + 1, almost 35 h), so this bound is what guarantees a founder who buys on every calendar day never lapses; `contactName` isn't empty.

### 4. Renting a room at Lakeview

**Options considered:**

- **(a) Fold renting into `REST` at a hotel.** Rejected: #203 ties phone access to renting, not sleeping. A founder who wants the lobby phone at 18:00 would have to start a rest, and the rest's no-trap rules (ADR 0023 decision 8) would have to account for a charge.
- **(b) A new activity with a separate checkout command.** Rejected: two commands, and a forgotten checkout leaves a stay open forever.
- **(c) One timed command that pays for a stay ending at a fixed checkout (chosen).** Smallest shape. The stay ends by the clock, so it can't be left open.

```ts
// packages/contracts/src/commands.ts
export interface RentRoomCommand {
  readonly type: "RENT_ROOM";
  readonly locationId: LocationId;
}

// packages/contracts/src/state.ts
/** A paid room (ADR 0027). Always known: the founder's own agreement. */
export interface RoomStay {
  readonly locationId: LocationId;
  /** Checkout: the stay grants phone use while t < until. */
  readonly until: Tick;
}
export interface FounderState {
  readonly whereabouts: FounderWhereabouts;
  readonly awakeSince: Tick;
  /** The room the founder holds, or null (ADR 0027). At most one. */
  readonly room: RoomStay | null;
}
// ActivityKind gains "CHECK_IN".

// packages/game-data/src/presence.ts
export interface RoomDefinition {
  readonly locationId: LocationId;
  /** Paid at check-in, for one night. */
  readonly nightlyRate: Money;
  /** When the desk takes guests: minute-of-day intervals, like PLACE_HOURS. */
  readonly deskHours: readonly PlaceHoursInterval[];
  /** Checkout, as a minute of the day. */
  readonly checkoutMinute: number;
  /** A stay runs to the first checkout at least this long after it starts. */
  readonly minStayTicks: number;
}
export const LAKEVIEW_LOBBY_HOURS: readonly PlaceHoursInterval[] = [hours(7, 23)]; // PLACEHOLDER
export const ROOMS: readonly RoomDefinition[] = [
  // PLACEHOLDER tuning: $2.00 a night, checkout 11:00, at least 8 hours.
  { locationId: LAKEVIEW, nightlyRate: cents(200), deskHours: LAKEVIEW_LOBBY_HOURS, checkoutMinute: 11 * 60, minStayTicks: 8 * TICKS_PER_HOUR },
];
```

- **Presence and time.** The founder must be `PRESENT` at the room's location and not busy, and the desk must be open (`deskHours`, never the back room's `PLACE_HOURS`). It's a timed activity: `ACTIVITY_DURATIONS.CHECK_IN` (PLACEHOLDER 15 min).
- **How long.** Let `start = max(t, current.until)` if the founder already holds a room here with `t < current.until`, else `t`. Then `until = firstCheckoutAtOrAfter(start + minStayTicks)`, where `firstCheckoutAtOrAfter(x) = x + (checkoutMinute − minuteOfDay(x) + TICKS_PER_DAY) % TICKS_PER_DAY`. All integer. Checking in at 20:00 gives a stay to 11:00 the next day. Renting again at 10:00 during a stay extends it to 11:00 the day after. Renting at another place replaces a stay elsewhere, with no refund (M002 has one hotel).
- **Cost.** One transaction, kind `LODGING` (new), key `idempotencyKey("LODGING", "ROOM", commandId)`: Dr `OVERHEAD_EXPENSE` / Cr `CASH` at `nightlyRate`. It files under `OVERHEAD` through the account's category (ADR 0015), and `CASH_FLOW_CATEGORY.LODGING` is `"OVERHEAD"`. It's the founder's own command: rule 1, known at once. It emits `ROOM_RENTED { locationId, until, price, transactionId }`.
- **Phone access.** The founder may use a `GUEST` phone at L at apply tick `t` iff `founder.room?.locationId === L` and `t < room.until` (decision 5).
- **The room is a rest place for its stay** (amends ADR 0023 decision 7). `isRestPlace(state, L) = L ∈ REST_PLACES ∨ state.founder.room?.locationId === L`. A full rest there takes `FULL_REST_TICKS`. ADR 0023 reads "that place" when a rest ends (the founder phase's waking, or `WAKE`). Checkout never happens while the founder is `RESTING` in the room (below), so a rest that started in a held room ends in one: a guest who oversleeps checkout still had a bed. Resting at Lakeview with no room is sleeping rough, and `REST` is never refused for a missing room.
- **Checkout** (amends ADR 0023 decision 2a): a new founder-phase **step 5**, after waking: if `room !== null`, `tick ≥ room.until`, and the founder isn't `RESTING` at `room.locationId`, set `room` to `null`. No event, transaction or activity item: the checkout time was known when the room was rented. A late riser who wakes after `until` checks out in the same tick's step 5, after step 4 has used the room for recovery.

### 5. Calling out, restated (amends ADR 0024 decision 3)

**Where the founder can call from.** The founder is `PRESENT` at F, and **may use the phone at F at apply tick `t`**:

| The phone at F | May use it | Charge for a connected call |
|---|---|---|
| A family line | Always | `CALL_COST` |
| `PHONES[F]`, `PUBLIC` | Always | `use.fee` |
| `PHONES[F]`, `GUEST` | `founder.room?.locationId === F` and `t < room.until` | `CALL_COST` |
| `PHONES[F]`, `ARRANGEMENT` | `granted(arrangement at F, "PHONE_USE", t)` | `CALL_COST` |
| `PHONES[F]`, `PRIVATE` | Never | — |

No phone at F is `NO_PHONE_HERE`. A phone the founder may not use is **`PHONE_USE_NOT_GRANTED { locationId, rule }`** (new), whatever the hours. Then **`phoneOpen(F, t)`**, not `PLACE_HOURS`: `PLACE_CLOSED { locationId: F, opensAt }`, with `opensAt` from the phone's own hours. That's the lobby's hours at Lakeview, so the back room's 20:00 opening never gates a guest's call.

**The charge.** As in ADR 0024, only a connected call is charged, and the coin comes back otherwise. Funds are checked up front at the charge for F. The posting is ADR 0024's `TELEPHONE:CALL:<commandId>` (Dr `OVERHEAD_EXPENSE` / Cr `CASH`) at that amount. The depot's fee is the founder's own command, so rule 1 covers it, and it adds no producer.

**Who answers at the called place L** (ADR 0024's table, rows in order, the first that matches decides):

| The phone at L | Answered by | When |
|---|---|---|
| A family line | The call-out attendant hook (ADR 0024 decision 9, ADR 0026 decision 10) | Unchanged |
| A `PHONES` entry, with a buyer or supplier at L | That party (`PARTY`) | While L is open under `PLACE_HOURS` **and** `phoneOpen(L, t)`. Then iff the keyed draw is below `CALL_ANSWER_PPM[partyKind]` (unchanged). Otherwise no answer and no draw |
| A `PHONES` entry with no party, whose keeper takes messages for the family at `t` (decision 6) | `PROPRIETOR` | While `phoneOpen(L, t)`. Deterministic |
| Anything else (the depot) | Nobody | Never |

The use rule doesn't affect answering. Kessler's private line answers for business (#203 §1); Miller answers his own phone whether or not the founder may use it. At Lakeview the back room answers only while both the back room (20:00–02:00) and the lobby phone (07:00–23:00) are open: the desk puts calls through while it's staffed. No M002 place matches the `PROPRIETOR` row, because Miller's has a party (Miller himself). The row stays for a later message-taking place with no party.

**Held messages on an answered call.** If messages are held at L, a call to L answered by `PARTY` or `PROPRIETOR` delivers them inside `PLACE_CALL`, **whether or not L takes new messages at `t`**. A keeper who took a message hands it over even after the arrangement lapses. At a family line, ADR 0024 and ADR 0026 decide unchanged.

Everything else in ADR 0024 decisions 3 and 4 stands: `PLACE_CALL` is applied whether or not anyone answers, the call view, by-phone orders and the busy rules.

### 6. Calls in and message-taking, restated (amends ADR 0024 decisions 5 and 6)

Every use of `holdsMessages` in ADR 0024 is replaced by **`takesMessages(L, t)`**:

```ts
// true for a family line (ADR 0024: messages there are taken by the call-in attendant hook);
// for a PHONES entry: messages === "ARRANGEMENT" and granted(arrangement at L, "TAKES_MESSAGES", t).
```

- **The family's numbers** (ADR 0024 decision 5): the locations with a family line, plus every `PHONES` location with `takesMessages(L, t)`, excluding the caller's own place. In M002 that's Miller's once three days of trade earn it, and Hollow Creek once it has a line.
- **Who answers a call in** (ADR 0024 decision 5's order):
  1. **The founder**, if `PRESENT` (busy or not) at a family line, or at a `PHONES` place with `takesMessages(L, t)` and `phoneOpen(L, t)`, and that line isn't engaged. At Miller's, Miller hands the founder the phone.
  2. Otherwise the numbers that aren't engaged, in `compareIds` order. At a family line, the call-in attendant hook takes a message. At a `PHONES` place with `takesMessages(L, t)` and `phoneOpen(L, t)`, the keeper takes one, `takenBy: null`.
  3. Otherwise it rings out.
- **Delivering held messages** (ADR 0024 decision 6, and decision 8's `phones` step 1, whose "it's open" becomes `phoneOpen`): on arrival or waking at L, and while `PRESENT` at L, if `phoneOpen(L, t)` (a family line always is), and on an answered call to L (this record's decision 5). As there, delivery doesn't need `takesMessages(L, t)`: a lapse stops new messages, never delivery of old ones.
- **Common conditions for a call in** ("the family has at least one number") read the same set.
- **A party calls only while its own phone is in its hours.** ADR 0024 decision 5's caller condition "the caller's place is open (`PLACE_HOURS`)" becomes "the caller's place is open (`PLACE_HOURS`) **and** `phoneOpen(caller, t)`", the mirror of this record's decision 5 answering rule: the back room at Lakeview can't ring out through a lobby phone the desk has shut, so at 01:00 it doesn't call, and its rule's window is skipped with no draw. Employees' calls in come from a family line, which is always open, so ADR 0025's rule is unchanged.
- **The `PROPRIETOR` row** (ADR 0024 decision 3): restated in this record's decision 5.
- **`takenBy: null`** still means "the keeper of the place". The copy names them from `ARRANGEMENTS[L].contactName` (decision 10).

`takesMessages` reads the founder's arrangements (always known), game-data and the tick, the same inputs ADR 0024's static `holdsMessages` had plus two always-known ones. So ADR 0024 decision 9's argument that the founder answers first still holds, and so does its decision 10's non-leak argument.

**What a message carries** is unchanged: ADR 0024's `MESSAGE` rows, ADR 0025's report messages and ADR 0026's Driver observations. A depot attendant never takes a message: the depot's `messages` is `"NEVER"`.

### 7. How much of the hotel progression ships in M002

An orchestrator call (the issue's recommendation, under factory.md §8).

**Options considered:**

- **(a) All three stages.** First-time guest, returning guest who may pass a message, and established regular with reliable message-taking and calls through the desk. Rejected for M002: two more milestones, a "when feasible" rule that would be either a draw (a new randomness surface) or a second hours table, and calls *for* the founder routed through a desk. That's the relationship simulator #203 §2 warns against, before PT3 has shown that message-taking at Miller's is even used.
- **(b) Room-stay phone access only; message-taking at Miller's only; the returning guest and the regular deferred to a planned issue (recommended, chosen).** One new command, no new randomness, and every hotel privilege comes from a concrete stay.
- **(c) Add a "returning guest" message stage.** Rejected: half of (a)'s cost, and messages at two places before either is playtested.

**The deferred stages fit the shapes here.** A later record adds `DealingKind` `"ROOM_STAY"` (a `RENT_ROOM` that applies), an `ARRANGEMENTS` row for Lakeview, and `messages: "ARRANGEMENT"` on its phone. The returning-guest and regular milestones are then `dealingDaysNeeded` thresholds, and #203's line "Evening, Mr. Kerrigan. Two messages for you. Your usual room?" becomes reachable. The orchestrator files the planned issue (listed in the PR's left-out items).

### 8. Calls from the road (resolves ADR 0026 decision 9's deferral)

**M002 has no calls from the road.** **Options considered:**

- **(a) A Driver calls from any phone a stranger may use.** In M002 that's only the depot's `PUBLIC` phone, and no M002 run stops at the depot: a run stops at its buyer, or at a family facility for a `TRANSFER` (ADR 0026 decision 5), and the depot is neither a buyer nor, in M002, a family facility (ADR 0024 decision 1's empty place). The channel would never fire, yet it would need a fee posted without a founder command, which is a new `WORLD` producer with a `CASH` leg, a coverage row in ADR 0021 decision 6, and a non-leak argument for when the Driver chose to call.
- **(b) None in M002 (chosen).** A Driver reports at the station, on a call to the station an Office Hand answers, and by ADR 0025's window-tick call in from the station, as ADR 0026 decision 9 has it.

**The rule a later record must keep:** a Driver may call from the road only at a `PUBLIC` phone, during `phoneOpen`. Never at a `PRIVATE` line, never at a `GUEST` phone (the founder's room isn't the Driver's), and never under the founder's `ARRANGEMENT` (it's the founder's standing with Miller, not the Driver's). The fee posts under a new producer family with its own ADR 0021 decision 6 coverage row.

### 9. ADR 0026's uses of phones, checked

- **The Office Hand at a family line** (ADR 0026 decision 10). A family line is always the founder's to use, at any hour, and who answers it is still the attendant hooks' call under the availability rule (ADR 0028, #214). Nothing here changes either. "From any phone the founder may use" (ADR 0026's Context and Consequences) now means: the family's own line, Miller's once `PHONE_USE` is granted, Lakeview's during a room stay, and the depot's for its fee (decision 5).
- **Report calls in from the station** (ADR 0025 decision 7, ADR 0026 decision 9's table). They need a family number other than the station. Miller's counts once `TAKES_MESSAGES` is granted (decision 6), so "Walt calls the store, Miller takes it, you hear it when you buy corn" works in M002 once the still has a line. ADR 0026's "as a message" row reads `takesMessages(L, t)` for "a contact who takes messages for the family", and so does ADR 0025 decision 7's "a public phone that `holdsMessages`" (its *Needs design* item is settled the same way).
- **The call-in attendant hook's tick** (the #211 review's non-blocking note). ADR 0026 decision 10 has `CallInAttendant` evaluate `isAvailable(employee, tick)`, but ADR 0024's type takes no tick, and `TickContext` says `state.tick` is still the previous tick while a phase runs. Reading `state.tick` would be one tick early. **The hook gains the tick argument**, as `CallOutAttendant` already has:

  ```ts
  // packages/simulation (internal; amends ADR 0024 decision 9)
  type CallInAttendant = (state: GameState, data: GameData, locationId: LocationId, tick: Tick) => CharacterId | null;
  ```

  The `phones` phase passes `ctx.tick`. ADR 0026's requirements on the two hooks are otherwise unchanged.
- **Road calls:** decision 8.

### 10. Wording, time and the pause

**Approved copy (#203 §3), for the UI tasks (C1's call scene, E3, the activity feed):**

| Moment | Line | Shown when |
|---|---|---|
| The operator, as the founder places a call | "Number, please." | Composing `PLACE_CALL` at a phone the founder may use |
| Connecting | "One moment. I'll try that line." | After `PLACE_CALL` is sent, until its outcome lands |
| Unanswered | "No answer. You can try again later." | `CALL_PLACED` with `answered: false` |
| Messages held at Miller's | "Miller says someone called while you were away. He left word for you." | A `MESSAGES_DELIVERED` with `count > 0` at `MILLERS_FEED_LOCATION`, by any `via`. **Only then**: never as filler when nothing is waiting |
| A message entry | "{date/time} — {caller} left word with {contact}: {message}." | Each `MESSAGE_DELIVERED` activity item. {date/time} is `message.takenAt`. When the item's `tick` (when the founder learned it) differs, it's shown too. {caller} is the calling party's or employee's name. {contact} is the employee's name for a `takenBy` character, else `ARRANGEMENTS[heldAt].contactName` |
| The established hotel regular (later; not in M002) | "Evening, Mr. Kerrigan. Two messages for you. Your usual room?" | Not shipped (decision 7). Recorded so the later record uses it |

No shape changes are needed for the message entry: `DeliveredMessage.takenAt` (ADR 0024) is the time taken, and the activity item's `tick` is when it was learned. The operator is unnamed in M002. Party lines and listeners are atmosphere in the call scene, with no mechanics (ADR 0024 decision 11). The {message} wording for each `CallInReason` is still PLACEHOLDER (*Needs design*).

**Call scene actions** (#203 §4: "only promise action choices actually implemented"). With a buyer: the call view (prices they'd pay, contract offers) plus by-phone `AGREE_DEAL` and `ACCEPT_CONTRACT`. With a supplier: the call view (`SUPPLIER_OFFER`). With an employee at a station: the call view and the employee orders `Reach = "PHONE"` allows (ADR 0025, 0026). In every case, "End call", which is UI only (below). No supplier ordering by phone in M002.

**Time.** Unchanged from ADR 0024, and now validated: `ACTIVITY_DURATIONS.PHONE_NO_ANSWER` (PLACEHOLDER 5 min) must be at least 1 and less than `PHONE_CALL` (PLACEHOLDER 15 min). `validatePresence` checks `0 < PHONE_NO_ANSWER < PHONE_CALL`. Unanswered calls take less time, but never none. The in-world conversation's time is the call's fixed duration, whatever the player's reading speed.

**Where the pause lives: the worker's speed control, never the simulation.** ADR 0024 decision 4's mechanism stands, and this record pins it down:

- **The batch is split at the call** (C1, in `apps/game`). Today `simulation-host.ts`'s `step()` passes the scheduler's whole batch to `sim.advance(ticks)`, up to `MAX_TICKS_PER_STEP` (60) ticks, which is longer than a `PHONE_CALL` (15). A call could start and end inside one `advance`, and the host would never see it connected. So while a `PLACE_CALL` the player sent hasn't applied yet (the host dispatched it, or it sits in `queuedCommands`), the host ends the batch at that command's apply tick: it advances only up to and including that tick (one tick for an eager command, `state.tick + 1`). Then it reads `founder.whereabouts.call`, which is always known. If it's non-null, the host sets the scheduler's `Speed` to 0, the same pause the player's button sets, and the rest of the batch stays in the scheduler's backlog, as for any pause. If it's null (no answer, or rejected), stepping carries on as usual.
- **Determinism is untouched.** The same ticks run in the same order, only cut into different `advance` calls, which ADR 0014 lets the host choose. While paused, every by-phone order applies at `state.tick + 1 ≤ busy.until`, so it lands on the call (ADR 0024 decision 4).
- **Calls in may overshoot.** The host also pauses when a `CALL_RECEIVED` activity item lands (the founder answered a call in), but it doesn't split batches for it. A call in can't be foreseen without reading hidden state, and it leaves no `call` to act on. So, like the victory pause (ADR 0020 decision 16, "past the deciding tick by up to one batch"), the clock may be up to one batch past the call when it stops. The item stays in `activity` to read.
- An unanswered call doesn't pause: there's nothing to read but one line.
- "End call" restores the speed from before the pause. It isn't a command, and the call's game time is spent either way.
- There's no simulation field, command or event for the pause, and the simulation never reads wall-clock time. The lab never pauses. Menus and scenes never cost game time (ADR 0023 decision 4).

### 11. The first hire stays reachable without a phone

ADR 0025 decision 17 holds: hiring is in person at `HIRING_PLACES` (Miller's, during its hours), and the Distiller works and reports without a phone. This record adds **no gate** on hiring, production, buying, selling or delivering. An arrangement costs nothing beyond purchases the founder makes anyway, and a room is optional: rest is never refused without one (ADR 0023 decision 8). R1 (#176) needs no new scripted step. Its sensible founder may ignore phones entirely. If it rents rooms, it counts `nightlyRate` against cash.

### 12. The player snapshot (amends ADR 0024 decision 1)

```ts
// packages/contracts/src/player-snapshot.ts
interface PlaceGeography {
  readonly id: LocationId;
  readonly name: string;
  readonly position: WorldPoint;
  /** ADR 0024/0027: the phone here, or null. Geography and agreements, always known. */
  readonly phone: PlacePhone | null;
  /** ADR 0027: the family's arrangement with the contact here, or null if the place has none in game-data. */
  readonly arrangement: PlayerArrangement | null;
  /** ADR 0027: rooms to rent here, or null. */
  readonly rooms: PlaceRooms | null;
}

export interface PlacePhone {
  readonly familyLine: boolean;
  /** The founder may call out from here now, and on what basis. */
  readonly use: {
    readonly rule: "FAMILY_LINE" | "PUBLIC" | "GUEST" | "ARRANGEMENT" | "PRIVATE";
    readonly allowed: boolean;
  };
  /** What a connected call from here costs: the public fee, or CALL_COST. */
  readonly callCharge: Money;
  /** phoneOpen now; and, if closed, the next tick it opens (null when open). */
  readonly open: boolean;
  readonly opensAt: Tick | null;
  /**
   * The keeper here takes messages for the family now: takesMessages(L, now) for a PHONES
   * entry. false for a family line, where the Office Hand takes them (ADR 0026), as the
   * employee's availability shows. Never whether messages are waiting (ADR 0024 decision 1).
   */
  readonly takesMessages: boolean;
}

export interface PlayerArrangement {
  readonly contactName: string;
  /** 0 when there's no arrangement or it has lapsed. */
  readonly dealingDays: number;
  /** lastDealingAt + lapseTicks while it holds; null when there's none or it lapsed. */
  readonly holdsUntil: Tick | null;
  /** There was one, and it lapsed. */
  readonly lapsed: boolean;
  /** Each milestone, in ARRANGEMENT_PRIVILEGES order. */
  readonly milestones: readonly {
    readonly privilege: ArrangementPrivilege;
    readonly dealingDaysNeeded: number;
    readonly granted: boolean;
  }[];
}

export interface PlaceRooms {
  readonly nightlyRate: Money;
  readonly deskOpen: boolean;
  readonly deskOpensAt: Tick | null;
}
```

ADR 0024's `PlacePhone.public` and `PlacePhone.holdsMessages` are gone. PH1 builds the type with the fields above, not ADR 0024's. `PlayerFounder` extends `FounderState`, so it carries `room` with no further change. Every field is computed from game-data, the clock, the founder's arrangements and room, and family lines, all always known. The snapshot still never shows whether messages are waiting anywhere.

### 13. Tick order

`PHASES` is unchanged from ADR 0026: `production, employees, vehicles, [world events], resolution, founder, phones, deadlines, midnight`, then the persist step.

- **Commands** (first in the tick): `RENT_ROOM` and `PURCHASE_MATERIALS` update the room and the arrangement inside their own transactions. `PLACE_CALL`'s use rule reads both at its apply tick `t`. A purchase that earns `PHONE_USE` leaves the founder busy (`BUY_MATERIALS`), so the first call can go from the next free tick.
- **`founder`:** ADR 0023's steps 1–4, then the new **step 5** (checkout, decision 4). Waking (step 4) reads the room for recovery before step 5 can clear it.
- **`phones`:** the family's numbers and the founder's answering place are evaluated at `ctx.tick` with `takesMessages` and `phoneOpen`. The call-in attendant hook gets `ctx.tick` (decision 9).
- **Lapses** need no slot: `granted` is computed from the tick.
- **On the tick an activity ends** (ADR 0023 decision 2a): `CHECK_IN` ends like any activity. The stay already holds from the apply tick, and the founder is free from `busy.until + 1`. A stay ending at `u`: `PLACE_CALL` from a `GUEST` phone at `t = u` is `PHONE_USE_NOT_GRANTED` (`t < until` fails), and step 5 clears the room at `u` unless the founder is asleep in it.
- **No-trap bound** (ADR 0023 decision 8): `CHECK_IN` is an `ACTIVITY_DURATIONS` row, so `B` covers it. `REST` is never refused for anything here.

### 14. Flag off (`founderRules: false`)

- `RENT_ROOM` applies as an accepted no-op, like ADR 0024's phone commands and ADR 0023's founder commands. Its envelope goes into `commandLog`.
- `PURCHASE_MATERIALS` doesn't count dealings: `arrangements` stays `[]` and no `ARRANGEMENT_GRANTED` is emitted. The purchase's transaction, entries and events are exactly M001's.
- `founder.room` stays `null`, the founder phase does nothing (ADR 0023), and the `phones` phase is idle (ADR 0024).

M001 and the lab play exactly as before. Their state hashes move only by the two new empty fields, which PH1 regenerates with ADR 0024's.

### 15. Saves (amends ADR 0024 decision 13)

The new required fields ride in PH1's save bump, the same bump as ADR 0024's (the next version after O1b's). The migration reads only the save's own fields:

| New field | Value | Source |
|---|---|---|
| `founder.room` | `null` | None needed: no earlier save can rent a room (no command could) |
| `arrangements` | `[]` | None. An earlier M002 save may hold founder purchases at Miller's in `commandLog`, but turning them into dealings would need game-data (which supplier is at which location), which ADR 0009 forbids. Arrangements start counting at this version, and a migrated game re-earns `PHONE_USE` with its next purchase |

New union members (`ActivityKind` `CHECK_IN`, the command, the events, the activity item, the reasons, `TransactionKind` `LODGING`) are additive and need no step. `PlayerPlace` isn't saved.

### 16. Rejection reasons (amends ADR 0024 decision 14)

`PLACE_CALL`, restated in ADR 0022 §1's gate order, table order within a gate:

| Gate | Failure | Reason |
|---|---|---|
| 1 | `locationId` isn't a location | `UNKNOWN_ENTITY { kind: "Location", id }` |
| 2 | Travelling, riding or resting | `FOUNDER_AWAY { whereabouts }` |
| 2 | No family line and no `PHONES` entry where the founder stands | `NO_PHONE_HERE { locationId }` (ADR 0024; now only "no phone at all") |
| 2 | A phone the founder may not use now (`PRIVATE`; `GUEST` with no room held here; `ARRANGEMENT` without `PHONE_USE`), whatever the hours | **`PHONE_USE_NOT_GRANTED { locationId, rule: "PRIVATE" \| "GUEST" \| "ARRANGEMENT" }`** (new) |
| 2 | Busy, including on a call | `FOUNDER_BUSY { until }` |
| 2 | `phoneOpen(F, t)` is false | `PLACE_CLOSED { locationId, opensAt }`, with `opensAt` from the phone's hours |
| 5 | The target is the founder's own place | `ALREADY_THERE` |
| 5 | No phone at the target | `NO_PHONE_THERE { locationId }` (ADR 0024) |
| 5 | Cash below the charge for F (decision 5) | `INSUFFICIENT_FUNDS { required, available }` |

`RENT_ROOM`:

| Gate | Failure | Reason |
|---|---|---|
| 1 | `locationId` isn't a location | `UNKNOWN_ENTITY { kind: "Location", id }` |
| 1 | No `ROOMS` entry there (static) | **`NO_ROOMS_HERE { locationId }`** (new) |
| 2 | Travelling, riding or resting | `FOUNDER_AWAY { whereabouts }` |
| 2 | Not `PRESENT` there | `NOT_PRESENT { requiredLocationId, issuerLocationId }` |
| 2 | Busy | `FOUNDER_BUSY { until }` |
| 2 | The desk is closed | `PLACE_CLOSED { locationId, opensAt }`, from `deskHours` |
| 5 | Cash below `nightlyRate` | `INSUFFICIENT_FUNDS { required, available }` |

`PURCHASE_MATERIALS` gains no reason: counting a dealing never rejects. "No answer" and "rang out" remain outcomes.

### 17. Contract changes: ADR 0024 decision 15, restated as amended (for PH1, #205)

One contract-change task, PH1, after O1b in the contract sequence. **Bold** marks what this record adds or changes. Everything else repeats ADR 0024's list, with its payloads, so PH1 can work from this list alone.

- `state.ts`:
  - `FacilityState.phoneLine: { readonly bookValue: Money } | null`;
  - `CallParty`, `ActiveCall`, `CallAnswerer`, `FounderWhereabouts.PRESENT.call`;
  - `ActivityKind` gains `PHONE_CALL`, `PHONE_NO_ANSWER`, `INSTALL_PHONE` **and `CHECK_IN`**;
  - **`RoomStay` and `FounderState.room: RoomStay | null`;**
  - **`ArrangementPrivilege`, `ARRANGEMENT_PRIVILEGES`, `ArrangementState`, and `GameState.arrangements`.**
- `commands.ts`:
  - `PlaceCallCommand`, `InstallPhoneCommand` **and `RentRoomCommand`** (types, `GameCommand`, `GAME_COMMAND_TYPES`);
  - reasons `NO_PHONE_HERE { locationId }` (**doc: no phone at all at the founder's place**), `NO_PHONE_THERE { locationId }`, `PHONE_ALREADY_INSTALLED { facilityId }`, **`PHONE_USE_NOT_GRANTED { locationId, rule: "PRIVATE" | "GUEST" | "ARRANGEMENT" }`**, **`NO_ROOMS_HERE { locationId }`**;
  - **`PLACE_CLOSED`'s doc comment:** `opensAt` comes from the phone's or the desk's hours when the command is `PLACE_CALL` or `RENT_ROOM`.
- `events.ts`: `CALL_PLACED { fromLocationId, locationId, answered, answeredBy: CallAnswerer | null, transactionId }`, `CALL_RECEIVED { callerLocationId, phoneLocationId, reason }`, `MESSAGE_TAKEN { callerLocationId, heldAtLocationId, takenBy, reason }`, `MESSAGES_DELIVERED { locationId, count, dropped, via }`, `PHONE_INSTALLED { facilityId, price, transactionId }`, **`ROOM_RENTED { locationId, until, price, transactionId }`**, **`ARRANGEMENT_GRANTED { locationId, privilege }`**.
- `ledger.ts`: `TransactionKind` `TELEPHONE` **and `LODGING`**. `projection/finance.ts`'s `CASH_FLOW_CATEGORY` maps both to `OVERHEAD` (simulation code, landing with whichever task adds the kind, as ADR 0024 says for `TELEPHONE`).
- `knowledge.ts`:
  - `HeldMessage`, `DeliveredMessage`, `PendingMessages`, `KnowledgeState.pendingMessages` (and `EMPTY_KNOWLEDGE.pendingMessages: []`);
  - `CatchUp` and `KNOWLEDGE_CAUGHT_UP` unchanged;
  - `ActivityItem` gains `CALL_PLACED { locationId, answered, answeredBy: CallAnswerer["kind"] | null }`, `CALL_RECEIVED { callerLocationId, phoneLocationId, reason }`, `MESSAGE_DELIVERED { message: DeliveredMessage }`, `MESSAGES_DROPPED { locationId, count }`, `PHONE_INSTALLED { facilityId }` **and `ARRANGEMENT_GRANTED { locationId, privilege: ArrangementPrivilege }`**, each with K1's `tick`;
  - `ACTIVITY_IMPORTANCE`: `CALL_RECEIVED` and `MESSAGE_DELIVERED` are `"notify"`; the others, **including `ARRANGEMENT_GRANTED`**, are `"log"` (ADR 0024's "`info`" is the code's `"log"`). PLACEHOLDER;
  - `CallInReason = "NEW_CONTRACT_OFFER" | "INSTALLMENT_DUE"`, defined here in contracts (a domain type: held messages carry it), so game-data's `CallInRule` imports it (ADR 0012). ADR 0025 later adds `"EMPLOYEE_REPORT"`;
  - `TRANSACTION_PRODUCERS`: ADR 0024's three `TELEPHONE` families **and `"LODGING:ROOM": { trigger: "FOUNDER_COMMAND", legs: ["CASH"] }`** land with their call sites in C1 (the #179 follow-up), so the coverage test keeps passing in PH1.
- `player-snapshot.ts`: **`PlacePhone` as restated in decision 12** (no `public`, no `holdsMessages`), `PlaceGeography.phone`, **`PlaceGeography.arrangement` with `PlayerArrangement`, `PlaceGeography.rooms` with `PlaceRooms`**, and the `EmptyPlace` variant (`kind: "NONE"`).
- `snapshot.ts` (world): `FacilitySnapshot.phoneLine: { bookValue: Money } | null`, for the debug view.
- `schemas.ts`, `save.ts`: Zod for all of the above; the bump and migration in ADR 0024 decision 13 **plus decision 15's two fields**, with an old-version fixture.
- `packages/game-data/src/phones.ts` (new): **`PhoneUseRule`, `MessageTakingRule`, `PhoneDefinition` and `PHONES` as in decisions 1–2**, `PhoneLineDefinition`, `PHONE_LINE`, `CALL_COST`, `CALL_ANSWER_PPM`, `CallInRule`, `CALL_IN_RULES`, `CALL_IN_INTERVAL_TICKS`, `MESSAGE_LIMIT`, **`DealingKind`, `ArrangementDefinition`, `ARRANGEMENTS`**, with load validation (ADR 0024's, **plus decisions 1 and 3's**).
- `packages/game-data/src/presence.ts`: `ACTIVITY_DURATIONS` rows `PHONE_CALL`, `PHONE_NO_ANSWER`, `INSTALL_PHONE` **and `CHECK_IN` (15)**; **`RoomDefinition`, `ROOMS`, `LAKEVIEW_LOBBY_HOURS`; `PresenceDefinition.rooms`; `validatePresence` checks rooms (known, unique locations; non-empty valid `deskHours`; `checkoutMinute` a minute of the day; `minStayTicks ≥ 1`; `nightlyRate ≥ 1` cent, so the rental always posts a non-empty `CASH` leg) and `0 < PHONE_NO_ANSWER < PHONE_CALL`**. PH1's owned files need `presence.ts` for the duration rows anyway.
- Other game-data: `KNOWLEDGE_VISIBILITY` `MESSAGE` rows (ADR 0024 decision 6).
- **`GameData` (`packages/game-data/src/index.ts`) gains `phones: PhoneData`**, one bundle with `PHONES`, `PHONE_LINE`, `CALL_COST`, `CALL_ANSWER_PPM`, `CALL_IN_RULES`, `CALL_IN_INTERVAL_TICKS`, `MESSAGE_LIMIT` and `ARRANGEMENTS`, because the hooks and the handlers take `data: GameData` and need them (ADR 0025 does the same for its tables). `ROOMS` and `LAKEVIEW_LOBBY_HOURS` ride in `PresenceDefinition` with the other presence tables. `PRESENCE` isn't in `GameData` on `main`, so `ROOMS` goes wherever SK1a (#198) puts `PRESENCE`, without a separate decision.
- `packages/simulation/src/kernel/registry.ts` and `simulation.ts`: `phones` in `PHASES` between `founder` and `deadlines` (its hooks are C1's), plus the flag-off no-op handlers for `PLACE_CALL`, `INSTALL_PHONE` **and `RENT_ROOM`**.

**C1 (#179) implements the behaviour**: ADR 0024's list; **the use rule and charge (decision 5); `phoneOpen`; `takesMessages` and the family's numbers (decision 6); dealing counts in `registerMarket`'s `PURCHASE_MATERIALS` handler (decision 3); `RENT_ROOM`; the room as a rest place and checkout step 5 (decision 4, in SK1a's founder phase); the host's batch split at a pending `PLACE_CALL` and the pause on `CALL_RECEIVED` (decision 10, `apps/game/src/workers/simulation-host.ts`); the callers' `phoneOpen` condition (decision 6)**; and the `TELEPHONE` and `LODGING:ROOM` producer rows. If C1 is too big at its refresh, the orchestrator may split `RENT_ROOM` with the rest-place and checkout rules into its own task. E3 (#183) passes `ctx.tick` to the call-in hook (decision 9).

## Design-record checklist (factory.md §1)

### 1. Non-leak, per command and surface

Every input below is always-known state (the founder's whereabouts, `busy`, `call` and `room`; cash; agreements, including family lines and `arrangements`, which come only from the founder's own applied commands), geography (`PHONES`, `ROOMS`, `ARRANGEMENTS`, `PLACE_HOURS`, the phone and desk hours), the clock, knowledge, the live and call views, or a channel.

| Command or surface | Immediate result | Activity item | Catch-up | Books row | Snapshot field |
|---|---|---|---|---|---|
| `PLACE_CALL` (restated) | Decision 16's reasons: phone geography, the founder's room and arrangement, phone hours, cash. All known | `CALL_PLACED`. The answer comes from known hours (now intersected with the phone's), the keyed draw, or the call-out hook (ADR 0024) | None | `TELEPHONE:CALL`, charged at the known fee or `CALL_COST`; rule 1 | `founder.call`; the call view; delivered messages |
| `RENT_ROOM` | Decision 16's reasons: game-data, presence, desk hours, cash | The command item only | None | `LODGING:ROOM`, rule 1 | `founder.room`; `places[].phone.use`; `places[].rooms` |
| `PURCHASE_MATERIALS` (dealing count) | Unchanged. Counting rejects nothing | `ARRANGEMENT_GRANTED` when a milestone is newly met. It depends only on whether the founder's purchase applied (validated against the live view at an open supplier, ADR 0022) and the tick | None | Unchanged `MATERIAL_PURCHASE` | `places[].arrangement`; `places[].phone.use.allowed`, `.takesMessages` |
| Lapse (derived) | — | None | None | None | `arrangement.lapsed`, `holdsUntil`: a function of always-known state and the clock |
| Call in, founder answers at a message-taking place | — | `CALL_RECEIVED` (ADR 0024). Whether the founder is at such a place reads `takesMessages` and `phoneOpen`, both known | None | Entry-less | Records with source `PHONE` |
| Call in, message taken at Miller's | — | None until delivered | None until delivered | Entry-less | None. `pendingMessages` isn't projected |
| Message delivery after a lapse | — | `MESSAGE_DELIVERED` as ADR 0024 | Unchanged | As ADR 0024 | As ADR 0024. Delivery doesn't read `takesMessages`, so whether held messages are delivered depends only on the channel |
| Checkout (founder phase step 5) | — | None | None | None | `founder.room` cleared: tick and founder state only |
| Pause on connect or `CALL_RECEIVED` | — | — | — | — | Scheduler state, not snapshot. The batch split reads only the founder's own pending `PLACE_CALL` and its apply tick; the pause reads `founder.call` and `activity`. All known, and the split doesn't change which ticks run |

**The static half of ADR 0021 decision 9.** `arrangements` and `room` are equal in two worlds that differ only in hidden state, given the same commands. A purchase's acceptance depends only on the player view (the live view at the supplier, cash), and a room's on game-data, presence and cash. So `granted`, `takesMessages`, the family's numbers and the use rule are equal too.

**The dynamic half.** No new channel. The added `phoneOpen` conditions, for answering (decision 5) and for a caller (decision 6), are geography. Where a call in ends up follows ADR 0024 decision 5:
- Step 1, whether the founder answers, reads only always-known state (`takesMessages` and `phoneOpen` included). It comes first, so whether the founder hears a call never depends on a hook.
- Step 2 visits the numbers in `compareIds` order, so `hollow-creek` (a family line, once installed) comes before `millers-feed`. The still's `CallInAttendant` is therefore consulted first, and Miller takes the message only when the hook returns null. **Where a message is held can depend on the hook's output.** That's allowed: ADR 0024 decision 9 lets `CallInAttendant`'s output become player-visible only "through a delivered message", and a message held at Miller's rather than at the still reaches the founder only when it's delivered, which is a channel (ADR 0024 decision 10's delivery clause). In M002 the hook reads only agreements, game-data and the tick (ADR 0026 decision 10), so its output is always-known anyway.

So ADR 0024's non-leak argument holds with Miller's as a number.

### 2. Coverage tables (ADR 0021 decisions 6 and 7)

| Producer (idempotency-key family) | Entries | Classification |
|---|---|---|
| `LODGING:ROOM:<commandId>` (new) | Dr `OVERHEAD_EXPENSE` / Cr `CASH` | Rule 1: the founder's own command. No row in either table |
| `TELEPHONE:CALL:<commandId>` (ADR 0024) | Now at the public fee or `CALL_COST` | Rule 1, unchanged |
| `MATERIAL_PURCHASE:<commandId>` | Unchanged; the dealing count posts nothing | Rule 1, unchanged |

No producer posts without a founder command, so neither table gains a row. A Driver's road-call fee would have been the only one, and decision 8 defers it with the rule that it needs a row. `TRANSACTION_PRODUCERS` gains `"LODGING:ROOM"` (decision 17).

### 3. Migration

From save fields only (decision 15): `founder.room: null`; `arrangements: []`, deliberately not reconstructed from `commandLog`, because that would need game-data's supplier locations. No game-data reads. ADR 0024's three fields are unchanged.

### 4. Re-locks

**None.** Checked against the ten `@locked` files under `packages/simulation/test` (`grep -rl "@locked" packages/simulation/test`):

- None builds a `FounderState`, `GameState` or `PlayerSnapshot` literal, or reads `whereabouts`, `awakeSince` or `ACTIVITY_DURATIONS`.
- The `PURCHASE_MATERIALS` paths in them run with `founderRules: false`, where nothing changes (decision 14).
- None enumerates `ActivityKind`, `GameCommandType`, `RejectionCode`, `TransactionKind` or `PHASES` exhaustively. `fin-001.locked.test.ts`'s `KIND_DEFAULT` is a `Partial`, so `LODGING` doesn't break it.
- `eco-001-contracts.locked.test.ts` checks `SPRINT_ZERO_HASH`, imported from the unlocked `test/sprint-zero/reference-hash.ts`. PH1 regenerates it with ADR 0024's fields, as K1, P1 and O1a did.

### 5. Tick order

Decision 13. Room and arrangement change only inside commands. Checkout is founder-phase step 5, after waking. Lapses are derived. The `phones` phase reads `takesMessages` and `phoneOpen` at `ctx.tick` and passes `ctx.tick` to the call-in hook. On the tick an activity ends: `CHECK_IN` frees the founder from `busy.until + 1`, and a stay ending at `u` grants no call at `t = u`.

### 6. Flag off

Decision 14. `RENT_ROOM` is a no-op, purchases count nothing, and the room, arrangements, phones phase and founder phase stay empty or idle. M001 and lab economics are unchanged.

### 7. Randomness

No new draws. Arrangements, rooms, checkout, `phoneOpen` and `takesMessages` are deterministic. ADR 0024's keyed draws keep their keys (`call-out:<locationId>` with the apply tick, `call-in:<caller>:<reason>` with the window). The added `phoneOpen` conditions (answering a call out, and a party calling in) only skip draws at hours the founder knows, and a keyed draw stores nothing, so skipping one shifts no other.

### 8. Rejection reasons

- **New:** `PHONE_USE_NOT_GRANTED { locationId, rule }` and `NO_ROOMS_HERE { locationId }`.
- **Narrowed:** `NO_PHONE_HERE` means no phone at all.
- **Reused:** `UNKNOWN_ENTITY`, `FOUNDER_AWAY`, `FOUNDER_BUSY`, `NOT_PRESENT`, `PLACE_CLOSED` (with the phone's or the desk's hours), `ALREADY_THERE`, `NO_PHONE_THERE`, `INSUFFICIENT_FUNDS`.
- **Not reasons:** a lapse, an unanswered call, a missed message and checkout are states or outcomes.

Every payload is always known: the founder's place, game-data rules, and hours.

## Consequences

- **Phones become a progression of relationships, not geography.** The first morning's purchase at Miller's earns a phone. Three days of trade make Miller the family's message contact, which is what makes calls in and employee report calls work before the family owns a line. The depot is the no-strings fallback, a walk away and a dime a call. Lakeview trades cash and a stay for a phone in the east of the map.
- **The arrangement shape is reusable.** Kessler's later favours, the hotel regular, introductions and credit become a `DealingKind`, an `ARRANGEMENTS` row and a privilege. #203 §5 asks that those stay out of M002, and they do.
- **Lapsing is silent but visible.** No event fires when Miller stops taking messages: the snapshot shows the date it holds until, and that it has lapsed. If PT3 finds players are surprised, a later change can add a midnight check that writes an activity item, with no shape change.
- **A cheap purchase keeps the arrangement alive.** Any purchase counts, once a day. If playtests find a token sack too cheap a way to keep Miller's goodwill, a minimum spend per dealing is one game-data field.
- **Lakeview's back room is reachable by phone only from 20:00 to 23:00, both ways** (the back room's hours intersected with the lobby's; decisions 5 and 6). That's a consequence of #203's separate lobby hours, and it's listed under *Needs design*. PT3 judges it.
- **The pause covers answered calls in as well as calls out.** Calls out stop exactly on the connect tick, because the host splits its batch there. Calls in may stop up to one batch late. If either interrupts too often, it's a host setting, not a simulation change.

## Needs design (placeholders in this record)

Story and visual direction (factory.md §8). #203 settled which places have phones, who may use them, which take messages, the lobby's separate hours, the operator's and the message lines, and the call-scene direction. Still open:

- **Message wording per reason:** the {message} text for `NEW_CONTRACT_OFFER`, `INSTALLMENT_DUE` and `EMPLOYEE_REPORT` in the approved template.
- **Copy for milestones and lapses:** what the founder sees when Miller agrees to let them use the phone or to take messages (`ARRANGEMENT_GRANTED`), and when the arrangement has lapsed.
- **The room scene:** checking in at the Lakeview desk, and how the stay and checkout read.
- **The call scene's visuals** at Miller's counter, the Lakeview lobby and the depot (direction approved in #203 §4; the visual design is open), and how the pause and "End call" look.
- **Lakeview's back room by phone only 20:00–23:00.** Decisions 5 and 6 derive this from #203's separate lobby hours (the back room's 20:00–02:00 intersected with the lobby's 07:00–23:00), which narrows ADR 0024's reachability. It wasn't stated in #203, so the human may want later lobby hours or a night clerk.
- **Tuning (R1, PT3, T-LAB):** `ARRANGEMENTS` thresholds (1 and 3 dealing days) and `lapseTicks` (7 days); `ROOMS` rate ($2.00), checkout (11:00), minimum stay (8 h) and `LAKEVIEW_LOBBY_HOURS` (07:00–23:00); the depot fee (10¢); `CHECK_IN` (15 min); and ADR 0024's numbers.
- **Later stages, not M002:** the returning guest and the established regular at Lakeview (decision 7, a planned issue), Kessler's favours, and road calls under decision 8's rule.
