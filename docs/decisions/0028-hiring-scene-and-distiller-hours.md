# 0028: The hiring scene, the Distiller's hours and reports

Status: accepted (decided by the orchestrator for M002 task D5c, issue #214, from the human's design decision on #209; implemented by the contract tasks it names, EM1 #210 and ADR 0026's, and by E1 #180, E2 #182, E3 #183 and R1 #176)

Amends: ADR 0024 decision 5 (clarified: a family line whose call-in attendant hook returns null doesn't answer, and the caller tries the next number; decision 6), ADR 0025 decisions 1, 2, 3, 5, 6, 7, 16 and 17 (approved names and hiring place, a band beside each estimate, an estimate width drawn per meeting, orders to an employee off duty, the policy only in working hours, what limited a short batch, who answers the still's phone and when an employee calls in, a report delivered on arrival, the contract list, R1's numbers), ADR 0026 decisions 1, 5, 10, 15, 16 and 17 (the estimate width for the Driver, the Driver's hours, `isAvailable` for both attendant hooks, a call that outlasts a shift, relayed orders, a regular run outside the Driver's hours, the contract list and the numbers).

## Context

The human answered #209 (hiring, the hiring scene, the Distiller). The answer is binding for story and gameplay feel, and it's a sign-off on direction, not permission to invent lore. The points this record has to turn into rules:

- **§1 Where.** Miller's Feed & Seed, by word of mouth. Miller knows who's looking for work. The slate is the **people available to meet there**, not a recruitment queue. The 60-minute `HIRE` stays as starting tuning, and the first hire can share the supply trip. Miller's introduction line is approved copy.
- **§2 Names.** Walt Hagen (M001's foreman) is guaranteed on the first slate. Eddie Novak, Mae Brennan, Gus Lindqvist and Otto Krause are approved as M002 candidates, as names only: no invented family histories, criminal connections or personality traits. Candidates will look and sound distinct, and competence is never inferred from appearance, ethnicity, gender or accent.
- **§3 The scene.** Qualitative first, transparent numbers second. Each candidate shows an asking wage, a signing payment and an approximate competence estimate, in four approved bands, with the numeric range inspectable, labelled **Estimate**, and revealing only the range the founder was given. Wage terms come before hiring. The player can review or set the first standing order during the hiring conversation, without a second trip.
- **§4 Reports.** Six approved lines and templates, in plain language with the actual quantity and reason. Cash shortage and a spending cap reached are distinct reasons. Reports arrive through the knowledge and communications system, not as omniscient toasts.
- **§5 The Distiller lives at the still** (on-site quarters at Hollow Creek, no commuting simulation). **Veto:** ADR 0025's placeholder "answers its phone day and night". People sleep. Answering respects a simple availability window, with an unanswered call as a reason to visit, wait or try again. Standing orders continue through normal operating hours without a call per batch. No nondeterministic availability.
- **§6 No supply buying.** The Distiller runs batches and follows standing orders. They don't visit Miller's, buy corn, arrange delivery or exceed their delegated authority. A spending cap on production conversion costs is not authority to buy materials. The Runner (purchasing agent) is a later hire.

**Earlier records left these hooks:**

- **ADR 0025** has the mechanism this plugs into: `CANDIDATE_POOL`, `HIRING_PLACES`, the keyed slate, `CompetenceEstimate { low, high }`, `HIRE_EMPLOYEE.standingOrder`, the policy and its `HoldReason`s (`NO_CASH` and `SPENDING_CAP` are already separate members), `ReportLine`, the four report channels, and the call-out hook's Distiller case with its "day and night" placeholder.
- **ADR 0026** decision 10 has both attendant hooks return an employee only while `isAvailable(employee, tick)` holds, and asks this record to define it for the Office Hand and the Distiller, to say whether an answerer can go off duty mid-call, and whether an order an Office Hand relays waits for its recipient's working hours. An order is an agreement and is never refused for the recipient's hours. Decision 5 defers whether working hours gate a Driver's departure (step 1) and taking up the next run (step 3). The rule must read only agreements, game-data and the tick, with no draw, and a truck already on the road keeps going. Decision 1 makes the estimate nullable (`RoleTerms.estimateSpread: number | null`) and leaves the scene's presentation to this record.
- **The #211 review** (on #214): `isAvailable` must also govern employees' window-tick calls in. ADR 0026's *Needs design* item on the Office Hand's estimate should be limited to the visual and copy treatment, because decision 1 already settles the mechanism.
- **ADR 0027**: a party calls in only while its place is open and its phone is in its hours (decision 6). Miller's counts as a family number once message-taking is earned. The still's `CallInAttendant` is consulted before Miller's, and Miller takes the message only when the hook returns null (its checklist §1). `CallInAttendant` gains the tick (decision 9). It amends ADR 0025 decision 7 but couldn't touch that file, so this record adds the header line there.
- **ADR 0023**: the founder's rest model. `PLACE_HOURS` intervals, `FULL_REST_TICKS` (8 h), `WAKE_HOUR` (06:00).

**What the code has today (verified on `main` at 56859d3).**

- **No employee code exists yet.** `packages/contracts/src` has no `EmployeeRole`, `HoldReason`, `ReportLine` or `CallInReason`. `SAVE_SCHEMA_VERSION` is 5 (`save.ts`). `PHASES` is `production, vehicles, resolution, founder, deadlines, midnight` (`kernel/registry.ts`). EM1 (#210) adds ADR 0025's contract after PH1 (#205), and it depends on this record. So every shape decided here becomes part of EM1's first version of a type, not a change to a saved one.
- **Personnel game-data** (`packages/game-data/src/personnel.ts`) is still M001's: `CharacterDefinition` with Thomas Kerrigan (`FOUNDER`) and Walt Hagen (`FOREMAN`, skill 55, $3.00 a day).
- **Presence game-data** (`packages/game-data/src/presence.ts`): `PlaceHoursInterval { opensAtMinute; closesAtMinute }`, half-open and crossing midnight when `closesAtMinute < opensAtMinute`; `validatePlaceHours` checks intervals (at least one, whole minutes in 0..1439, ends that differ). `PLACE_HOURS` has Miller's at 07:00–18:00. `FULL_REST_TICKS` is 8 h, `WAKE_HOUR` 6, `START_WAKE_TICK` 06:00. `ACTIVITY_DURATIONS` has M001's eight activities: `HIRE`, `BRIEF_EMPLOYEE` and the phone rows aren't there yet.
- **Time** (`packages/contracts/src/time.ts`): `TICKS_PER_DAY = 1 440`, `minuteOfDay(t) = t % TICKS_PER_DAY`.
- **Production** (`packages/simulation/src/production/jobs.ts`, O1b): `START_PRODUCTION` prepays the conversion cost (`conversionCost` = (`laborPerCase` + `overheadPerCase`) × quantity, `capacity.ts`) in `PRODUCTION_START:<jobId>` and rejects with `INSUFFICIENT_FUNDS` when cash is below it. Basic moonshine: `ticksPerCase` 144, 2 corn and 1 sugar a case, $3.00 + $1.00 conversion a case. The copper still's crew is 3. The M001 scenario staffs 3 workers. `jobDuration` is 1 440 ticks for 10 cases at full crew.
- **Prices** (M001 game-data; the M002 scenario isn't on `main` yet): basic moonshine's base price $31.20; corn $2.50 and sugar $2.00 at Miller's.
- **Copy** lives in `apps/game/src/components/copy.ts` (shell and shared components) and per-panel `copy.ts` files, marked PLACEHOLDER until the human approves wording.
- **Locked tests:** ten `@locked` files under `packages/simulation/test` (`grep -rl "@locked" packages/simulation/test`). None mentions employees, hiring, report lines or working hours (checklist §4).

## Decision

### 1. Working hours: one deterministic rule for every employee

**Options considered:**

- **(a) Hours as an agreement per employee,** set at hire (a field on `HIRE_EMPLOYEE` and `EmployeeState`). Rejected for M002: a new choice in the hiring scene the human didn't ask for, a save field, and a form to change it later.
- **(b) A rest period that follows the employee's own day** (awake since, like the founder's `awakeSince`). Rejected: it would make hours depend on when the employee last worked, which is hidden state. Answering the phone would then leak it.
- **(c) Working hours per role, in game-data (chosen).** A role works, answers and calls in during fixed minute-of-day intervals. The founder can know ahead of time when someone will pick up, and every rule that reads it reads only the tick.

```ts
// packages/game-data/src/personnel.ts (amends ADR 0025's RoleTerms, with ADR 0026's changes)
import { FULL_REST_TICKS, type PlaceHoursInterval } from "./presence.ts";

export interface RoleTerms {
  readonly dailyWage: { readonly min: Money; readonly max: Money };
  readonly signingCost: Money;
  readonly slateSize: number;
  /**
   * The width (high − low) of a candidate's estimate, drawn per meeting in [min, max] (decision 4).
   * null: the role shows no estimate, because its competence is inert (ADR 0026 decision 1).
   */
  readonly estimateSpread: { readonly min: number; readonly max: number } | null;
  readonly reportingDelayTicks: number;
  /**
   * When people in this role work, answer the phone and call in: minute-of-day intervals,
   * read as PLACE_HOURS is (ADR 0023 decision 6). Outside them they're off duty.
   */
  readonly workingHours: readonly PlaceHoursInterval[];
}

// ROLE_TERMS, the new field (every value PLACEHOLDER tuning: R1, PT2, PT3):
DISTILLER:   { /* ADR 0025's fields */ workingHours: [hours(6, 20)] },  // 06:00–20:00
DRIVER:      { /* ADR 0026's fields */ workingHours: [hours(6, 20)] },  // 06:00–20:00
OFFICE_HAND: { /* ADR 0026's fields */ workingHours: [hours(7, 19)] },  // 07:00–19:00
```

`hours(open, close)` is presence.ts's local helper (whole hours to a `PlaceHoursInterval`). presence.ts doesn't export it and isn't in EM1's owned files, so EM1 repeats it in personnel.ts.

**Load validation** (thrown with the personnel module's other checks): each role's `workingHours` passes the interval checks of `validatePlaceHours`, and its **on-duty minutes**, counted minute by minute over 0..1 439, are at least 1 and at most `TICKS_PER_DAY − FULL_REST_TICKS` (960). That puts #209 §5 into the data: no role is on duty day and night, and every role has at least the founder's full night's rest (ADR 0023) off.

**The rule:**

```ts
// packages/simulation/src/personnel/availability.ts (E1; E2 and E3 call it)
/** True while the role's working hours include `minute` (0–1439). */
export function onDutyAtMinute(role: EmployeeRole, minute: number, data: GameData): boolean {
  return data.roleTerms[role].workingHours.some(({ opensAtMinute: open, closesAtMinute: close }) =>
    open < close ? minute >= open && minute < close : minute >= open || minute < close);
}

/** True while the role's working hours include the minute of `tick`. */
export function onDuty(role: EmployeeRole, tick: Tick, data: GameData): boolean {
  return onDutyAtMinute(role, minuteOfDay(tick), data);
}

/** ADR 0026 decision 10's isAvailable: at the station (startsAt reached) and on duty. */
export function isAvailable(employee: Pick<EmployeeState, "role" | "startsAt">, tick: Tick, data: GameData): boolean {
  return tick >= employee.startsAt && onDuty(employee.role, tick, data);
}
```

`data.roleTerms` is `ROLE_TERMS` under whatever name EM1 gives it in `GameData`. ADR 0026 wrote `isAvailable(employee, tick)`. The extra `data` argument is game-data, which ADR 0026 already allows. The interval test is ADR 0023's `PLACE_HOURS` test; if SK1a (#198) or C1 (#179) lands a shared helper first, E1 uses it.

**Inputs:** the employee's `role` and `startsAt` (agreements, always known), `ROLE_TERMS` (game-data) and the tick. No world state, no draw. The same function serves the Distiller, the Driver and the Office Hand.

**Why these hours.** 06:00 is the founder's `WAKE_HOUR` and the start of a new game's first morning, so the still starts when the founder does. 20:00 leaves ten hours off, more than `FULL_REST_TICKS`. The Distiller's window covers Miller's hours (07:00–18:00), so a founder calling the still from Miller's phone always finds someone up. The Office Hand's 07:00–19:00 sits inside it. All of it is tuning, and the human's #209 note lists "telephone hours" as needing implementation validation (R1, PT2).

### 2. What hours govern, and what they don't

Hours limit **the work, the phone and calls in**. They never refuse an order, never stop a running job, and never stop a truck on the road.

| Behaviour | Outside working hours | Rule |
|---|---|---|
| **The Distiller's policy step** (ADR 0025 decision 6) | Skipped entirely: no batch started, no hold found, `lastHold` and `lastRefusal` unchanged, no line | Runs only while `isAvailable(e, t)` |
| **A batch already running** | Keeps running. The `production` phase settles it when due and writes `BATCH_FINISHED` with that tick, as ADR 0025 decides | Not gated: it's the still and the crew, not the Distiller |
| **The spending period reset** | Happens at the next step that runs. The result is the same, because the reset is keyed by `periodIndex` and `spending` isn't projected | — |
| **A Driver's step** (ADR 0026 decision 5) | Step 1 (departure of a truck already loading) and step 2 (lapses) run. Step 3 (take up the next run order, or the regular run) and step 5 (find a hold) are skipped: no dispatch, no hold line | Steps 3 and 5 only while `isAvailable(e, t)` (decision 3) |
| **A truck on the road** | Keeps going: stop, return, takings handed in, lines and observations, all in `vehicles` | Not gated |
| **A call out to the station** | The hook returns no one off duty (decision 7) | ADR 0026 decision 10's hooks, with `isAvailable` |
| **An employee's call in** | Not placed; `callPending` stays set, and they call at the first window on duty | Decision 6 |
| **Orders: `SET_STANDING_ORDER`, `DISMISS_EMPLOYEE`, `ORDER_RUN`** | Applied, as at any hour. The employee acts on a new order at their next on-duty step | Decision 7 |
| **Reports delivered in person, or on a connected call** | Delivered, as at any hour | `Reach` is unchanged (decision 7) |

**Options considered for the Distiller's night** (the #214 fact: "decide whether the Distiller works through the night or only in their hours"):

- **(a) Works through the night, answers only in hours.** Rejected: #209 §5 says the Distiller is a person who sleeps, and that standing orders continue "through normal operating hours". A Distiller who restarts the still at 03:00 but doesn't pick up the phone is the "day and night" the human vetoed, with the phone switched off.
- **(b) Works and answers only in their hours; batches already running finish on their own (chosen).** A batch started at 19:30 runs overnight, because the still and the crew run it (ADR 0017). Only starting the next one waits for the morning.
- **(c) Only in hours, and a running batch pauses overnight.** Rejected: it changes ADR 0017's job duration for employee jobs, and it'd make the still's output depend on the clock in a way the founder's own batches don't.

**What it costs in throughput, and why R1 still holds** (ADR 0025 decision 17). A batch that finishes off duty waits for 06:00. With 840 minutes on and 600 off, the wait is at most 600 ticks, and about 125 on average if finishing times are spread evenly (600² ÷ (2 × 1 440)). At M001's game-data, a batch of 10 basic moonshine at full crew is 1 440 ticks before competence, plus `START_BATCH`'s 30 minutes of setup:

| Distiller | Batch (ticks) | Cases a day, round the clock | Cases a day, worst case with hours |
|---|---|---|---|
| Competence 0 (×1.4) | 2 016 + 30 | 7.0 | 5.4 (cycle 2 646) |
| Walt Hagen, 55 (×1.07) | 1 541 + 30 | 9.2 | 6.6 (cycle 2 171) |
| Competence 100 (×0.8) | 1 152 + 30 | 12.2 | 8.1 (cycle 1 782) |

R1's two properties:

- **Possible** (presence at an open hiring place, a candidate on the slate, cash ≥ the signing cost): unchanged. Hiring is gated by Miller's hours, never by an employee's.
- **Sustainable** (the still's margin under a Distiller covers their wage plus the existing bill): at M001's prices a basic case earns about $20.20 over materials and conversion ($31.20 − $7.00 − $4.00), before transport and market movement. The worst case above, 5.4 cases a day, is about $110 a day against a wage of at most $6.00. So hours don't come near the wage bill. The binding constraints stay what they were: the founder's corn runs, sales trips and buyers' demand. R1 runs its check with `workingHours` applied, and retunes from there.

### 3. The Driver's hours (fills ADR 0026 decision 5's deferral)

- **Step 3** (pick the next run) runs only while `isAvailable(driver, t)`. Off duty, a waiting run order waits and a due regular run isn't taken up.
- **Step 5** (hold) runs only on duty, so step 5 writes no `HELD_BACK` line at night. (Step 1 can still write one for a road found closed at a departure after the shift, below.)
- **Step 1** (departure) isn't gated. A run taken up at 19:50 loads for `LOAD_TRUCK` (30 minutes) and sets out at 20:20. The Driver took up the run on duty, and the truck is already being loaded. A road found closed at that departure is handled as ADR 0026 decision 6 says, including its `HELD_BACK { ROUTE_CLOSED }` line.
- **Step 2** (lapses) isn't gated: a lapse is a time fact about an agreement, and gating it would let a run order outlive its `expiresAt` by a night.
- **The stop and the return** (`vehicles` phase) aren't gated: a truck already on the road keeps going.

**Options considered:** **(a) a new hold reason `OFF_DUTY`,** written when a run is waiting at night. Rejected: a line every evening that says what the founder already knows from game-data. **(b) Skip steps 3 and 5 silently (chosen).**

**A regular run must fall inside the Driver's hours.** ADR 0026's regular run is due when the minute of day is `≥ departMinute`. With hours, it's also due only on duty. So a `departMinute` outside the Driver's working hours could never be due. `SET_STANDING_ORDER` and `HIRE_EMPLOYEE` with `DRIVE` terms reject it at gate 1:

```ts
// packages/contracts/src/commands.ts (RejectionReason member; ADR 0026's contract task)
| { readonly code: "DEPARTURE_OUTSIDE_HOURS"; readonly role: EmployeeRole; readonly departMinute: number }
```

The check is `onDutyAtMinute("DRIVER", departMinute, data)`. The payload is the command's own field and the role (game-data), so it leaks nothing.

**Run orders survive a night.** Load validation adds `RUN_ORDER_HOLD_TICKS ≥ TICKS_PER_DAY` (it's 2 880), so a run order without a deal always sees at least one full shift before it lapses. A deal-backed run order lapses at the deal's `expiresAt`, as ADR 0026 decides. The deal's expiry and the Driver's hours are both known to the founder when handing it over.

### 4. The hiring scene

**Where.** `HIRING_PLACES`' Distiller row, Miller's Feed & Seed, is approved (#209 §1): no longer PLACEHOLDER. ADR 0026's rows (the Office Hand at Miller's, the Driver at Riverside Depot) stay ADR 0026's placeholders.

**The slate is "people available to meet there".** No mechanism changes. ADR 0025's slate already is a pure function of the seed, the tick, game-data and who's employed, replaced every `CANDIDATE_SLATE_TICKS`, and shown only while the founder is `PRESENT` at an open hiring place. #209's framing fixes how it's presented: candidates Miller introduces, out front, in the store or at the loading dock, not a queue of applicants. `PlayerHiring`'s doc comment says so: "The people available to meet at this place now." `HIRE` stays 60 minutes (PLACEHOLDER tuning). Hiring needs no trip beyond the one for corn.

**Names** (#209 §2). `CANDIDATE_POOL`'s five Distiller entries keep ADR 0025's IDs and names, and their `// PLACEHOLDER (story)` comments become `// #209: approved name`. `scenario.firstCandidates` stays `["walt-hagen"]` in the M002 scenario, so Walt is on the first slate. **Names only:** `CandidateDefinition` has no biography, trait or flavour field, and this record adds none. The competence ranges stay PLACEHOLDER tuning.

**Competence is never read from a face or a voice.** When candidate portraits and voices are made (visual direction, *Needs design*), they're chosen per `characterId` only. No UI asset, line or style may vary with a candidate's competence range, estimate, band or wage. The UI test for the hiring scene checks that a candidate's portrait, voice and style assets are the same across two games whose estimates for that candidate differ. The band line, the Estimate range and the wage terms are meant to differ, and the test leaves them out.

**The estimate's width varies by meeting.** ADR 0025 drew every estimate with one width (`estimateSpread: 30`), so "wide" couldn't be told apart from "narrow": every Distiller estimate was 30 points wide, except where the 100 cap clipped it. #209's fourth band, "Hard to judge from a conversation", needs some conversations to tell the founder less than others.

**Options considered:**

- **(a) Keep one width per role.** Rejected: the fourth band would be all or nothing per role.
- **(b) A width per candidate in game-data.** Rejected: "Mae is hard to read" is a personality trait, which #209 §2 rules out as canon.
- **(c) A width drawn per meeting (chosen).** How much a conversation tells you varies from one slate to the next, for everyone. It's a keyed one-shot draw, so nothing is stored and no stream moves.

For candidate `c` on slate `s`, with `spread = ROLE_TERMS[role].estimateSpread` (amends ADR 0025 decision 3's estimate):

```
w    = spread.min === spread.max
         ? spread.min
         : spread.min + nextInt(keyedRng(seed, "estimate-width:<c.id>", s), spread.max − spread.min + 1)
o    = nextInt(keyedRng(seed, "estimate:<c.id>", s), w + 1)
low  = max(0, competence − o)
high = min(100, low + w)
```

The true value still lies in `[low, high]`: `low = max(0, competence − o) ≤ competence`, and `low + w ≥ competence − o + w ≥ competence` because `o ≤ w`, so `high = min(100, low + w) ≥ competence`. The asking wage still follows the midpoint, `(low + high) / 200` (ADR 0025). A role with `estimateSpread: null` draws neither (ADR 0026 decision 1). ROLE_TERMS: `DISTILLER.estimateSpread = { min: 20, max: 50 }` (PLACEHOLDER), and `DRIVER.estimateSpread = { min: 20, max: 50 }` (PLACEHOLDER, replacing ADR 0026's 30).

**The four bands** (#209 §3). A band is computed from the estimate's shape alone, `{ low, high }`:

```ts
// packages/contracts/src/player-snapshot.ts
/** How an estimate reads in the scene. UNCERTAIN: too wide to say. */
export type CompetenceBand = "LOW" | "MODERATE" | "HIGH" | "UNCERTAIN";

// packages/game-data/src/personnel.ts (PLACEHOLDER thresholds; the band copy is the human's, decision 10)
export interface CompetenceBandThresholds {
  /** An estimate at least this wide (high − low) is UNCERTAIN, whatever its midpoint. */
  readonly uncertainAtLeast: number;
  /** A narrower estimate whose midpoint is below this is LOW. */
  readonly moderateFrom: number;
  /** A narrower estimate whose midpoint is at or above this is HIGH; in between, MODERATE. */
  readonly highFrom: number;
}
export const COMPETENCE_BANDS: CompetenceBandThresholds = { uncertainAtLeast: 40, moderateFrom: 40, highFrom: 65 };

// packages/simulation (projection, E1)
export function competenceBand(e: CompetenceEstimate, b: CompetenceBandThresholds): CompetenceBand {
  if (e.high - e.low >= b.uncertainAtLeast) return "UNCERTAIN";
  const mid = Math.floor((e.low + e.high) / 2);
  return mid < b.moderateFrom ? "LOW" : mid < b.highFrom ? "MODERATE" : "HIGH";
}
```

**How "wide" is detected:** `high − low ≥ uncertainAtLeast`. With widths 20–50 and a threshold of 40, about a third of meetings (widths 40–50, 11 of 31 values) read "Hard to judge", for any candidate. A clipped estimate near 100 is narrower than `w`, which is right: it tells the founder more.

**Load validation:** `0 < moderateFrom < highFrom ≤ 100`; `1 ≤ uncertainAtLeast ≤ 100`; for each role, `estimateSpread` is `null` or `0 ≤ min ≤ max ≤ 100`; and for each role with a spread, `min < uncertainAtLeast ≤ max`, so the fourth band can appear and doesn't always appear.

**Projected, not computed in the UI.** `PlayerCandidate` and `PlayerEmployee` gain `competenceBand`, computed by the projection from the estimate and `COMPETENCE_BANDS`. The UI renders it (CLAUDE.md rule 7). An employee's band is computed from the estimate stored at hire, so it doesn't change after hiring.

**Roles with no estimate** (ADR 0026 decision 1): `competenceEstimate` and `competenceBand` are both `null`. The scene shows no competence line, no band and no range for that role. How that reads on the page is visual and copy (*Needs design*), not mechanism.

**What the scene shows for each candidate** (#209 §3), from `PlayerCandidate`, before the hire can be confirmed:

1. The name.
2. **The band** (approved copy, decision 10), first.
3. **"Estimate"**, inspectable: `competenceEstimate.low`–`competenceEstimate.high`, exactly the range the founder was given. Nothing else about competence is shown or derivable: the true value stays hidden until `EMPLOYEE_PERFORMANCE` reveals it (ADR 0025 decision 8).
4. **The asking wage** (`dailyWage`, a day) and **the signing payment** (`signingCost`, once, in cash at hire).
5. The standing-order form (decision 5).

The confirm action sends `HIRE_EMPLOYEE` with the shown `dailyWage`. ADR 0025's `CANDIDATE_TERMS_CHANGED` guards against a slate that changed under a stale screen. The signing cost is static game-data per role, so it can't change within a game and needs no guard.

**Miller's introduction** (approved copy, decision 10) opens the scene at Miller's when the slate shows at least one Distiller candidate. With no Distiller candidate showing, the line isn't used (an empty slate's copy is *Needs design*).

### 5. The first standing order is set in the hiring conversation

**ADR 0025 already allows it.** `HIRE_EMPLOYEE.standingOrder: StandingOrderTerms | null` carries the first order, the communication gate passes because the founder is talking to the person (ADR 0025 decision 4), and the order's `STANDING_ORDER_SET` rides the hire's transaction. No change.

**Options considered:**

- **(a) The order rides on `HIRE_EMPLOYEE` (chosen, ADR 0025's shape).** One command, one 60-minute activity, no second trip.
- **(b) `SET_STANDING_ORDER` at the hiring place, right after the hire.** Rejected: ADR 0025's `Reach` is `IN_PERSON` only at the employee's station, so it'd need a new `Reach` case ("just hired, still here") and a second timed `BRIEF_EMPLOYEE`, for no gain over (a).

**The scene:** the order form sits in the hiring conversation, prefilled from `DISTILL_ORDER_DEFAULTS` (ADR 0025) for review. The player can confirm the defaults, change them, or choose to brief the Distiller later, which sends `standingOrder: null`. The form labels the spending cap as a limit on **batch costs** (conversion), never as money to buy supplies (decision 9). A Driver hired at the depot gets ADR 0026's `DRIVE` form the same way. An Office Hand has no order (ADR 0026 decision 10), so the form isn't shown.

### 6. Calls in respect working hours

ADR 0025 decision 7's trigger for an employee's call in gains one condition: **`isAvailable(employee, t)`** at the window tick. It mirrors ADR 0027 decision 6's rule for parties: a caller calls only while their own phone is in its hours, and an employee's phone hours are their working hours. The rest is unchanged: `callWhen` (`PROBLEMS`, or ADR 0026's `EVERY_RUN`), `report.callPending`, a family line at the station, the common conditions, the numbers and the answering order (ADR 0027's family numbers, Miller's included once it takes messages and while `phoneOpen`), no draw, and a Driver only when not away (ADR 0026).

- **Off duty, `callPending` stays set.** The employee calls at the first window on duty. A problem at 23:00 is phoned in at 06:00, or found earlier by a visit or a call.
- **The Office Hand never calls in:** their report never has lines (ADR 0026 decision 10).
- **The call-in hook reading null.** ADR 0024 decision 5's step 2 says that at a family line "the call-in attendant hook takes a message". When the hook returns null (no Office Hand, or one off duty), that number doesn't answer, and the caller moves on to the next one, as for an engaged line. That's how ADR 0026 decision 10 ("otherwise they go unanswered unless the founder is standing at the line") and ADR 0027's checklist ("Miller takes the message only when the hook returns null") already read it. This record states it so C1 and E3 implement one reading.

### 7. Calls out, orders and deliveries outside hours

**Calls out to the still** (replaces ADR 0025 decision 7's "The Distiller lives at the still and answers day and night (PLACEHOLDER, story)"). The call-out attendant hook returns the station's Distiller only while `isAvailable(distiller, t)`, at the `PLACE_CALL` apply tick, with ADR 0026 decision 10's precedence (an available Office Hand first) when E3 lands. Before E3, E1 implements the Distiller case alone with the same condition. Off duty, the call is **unanswered**, on ADR 0024 and 0027's path: `CALL_PLACED { answered: false }`, `PHONE_NO_ANSWER` busy for its 5 minutes, no charge, and ADR 0027's approved line "No answer. You can try again later." The founder can then wait, try later or go there (#209 §5).

**A call that outlasts a shift** (ADR 0026 decision 10's question).

**Options considered:**

- **(a) The answerer stays on the line until the call ends (chosen).** Availability is decided once, when the call connects, and stored in `call.answeredBy`. `Reach` and the deliveries while connected read `answeredBy`, as ADR 0026 has them. A call is at most `PHONE_CALL` × `TIRED_DURATION_PPM` (23 minutes at the placeholder values) past the shift's end. Nobody hangs up on the boss.
- **(b) The call drops when the shift ends.** Rejected: it needs a rule to end a call mid-`busy` that ADR 0024 doesn't have, it makes orders on one call flip from applied to `NO_WAY_TO_REACH` part way through, and it makes the call scene's pause (ADR 0027 decision 10) show a call that can vanish while paused.

**Orders to an employee who's off duty** (ADR 0026 decision 10's other question). An order is an agreement and is never refused for the recipient's hours (ADR 0026). So:

- **In person** at the station, at any hour: `SET_STANDING_ORDER`, `DISMISS_EMPLOYEE` and `ORDER_RUN` reach the employee, with ADR 0025 and 0026's timing. `Reach` doesn't read hours. The Distiller lives at the still (#209 §5), so the founder there can always speak to them. Hours limit the work and the phone, not a word face to face.
- **Relayed by an Office Hand** on a call: the order applies at once, as ADR 0026 decides. It **waits for its recipient's hours** only in the sense that the recipient acts on it at their next on-duty step: a new `DISTILL` order is used at the Distiller's next policy step, and a run order is taken up at the Driver's next step 3. Nothing about the order itself is queued or deferred.
- **Dismissal** takes effect at once, at any hour. A dismissed Distiller's running batch keeps running (ADR 0025).

**Reports delivered in person or on a connected call** stay as ADR 0025 and 0026 have them, at any hour. That keeps ADR 0025's invariant (at the end of any tick at which an order can reach E, E's pending report is empty, unless E is a Driver away) intact, because `Reach` is unchanged. Off duty, the Distiller writes no policy lines anyway. The only lines that can appear at night are `BATCH_FINISHED` (from `production`) and a Driver's road lines (from `vehicles`).

**Living on-site** (#209 §5): the Distiller's station is their home. There's no state for where they sleep and no commuting. ADR 0025's `reportingDelayTicks` (two hours, PLACEHOLDER) stays the time to get out to the still after the hire. ADR 0025 decision 7's call-in condition "the founder isn't `RESTING` at the station's location" stays: asleep under the same roof, they hear it in the morning.

### 8. Report lines: the approved wording, mapped to kinds

Every approved line maps to a report line kind and reason, or to a derived status, so the copy always states the simulation's actual reason and quantity (#209 §4).

| #209 line | Shown for | Fields used |
|---|---|---|
| Out of corn | `HELD_BACK` with `hold: { kind: "NO_MATERIALS", materialId: CORN }` | `materialId` |
| Storage full | `HELD_BACK` with `hold: { kind: "NO_STORAGE" }` | — |
| Spending cap reached | `HELD_BACK` with `hold: { kind: "SPENDING_CAP" }`; `ORDER_REFUSED` with `reason: OUTSIDE_AUTHORITY { limit: "SPENDING_CAP" }` | — |
| Cash shortage | `HELD_BACK` with `hold: { kind: "NO_CASH" }`; `ORDER_REFUSED` with `reason: INSUFFICIENT_FUNDS` | — |
| Production proceeding | A derived status, below. Not a report line | The live or call view's `FACILITY_OPERATIONS` |
| Batch complete | `BATCH_FINISHED` with `outcome: "COMPLETED"` | `quantity`, the recipe's product and quality, the station's location name |
| Catch-up on a visit | The header of a `REPORT` activity item with `atArrival: true` (below) | The item's lines |

**Cash shortage and the spending cap are distinct** (#209 §4). ADR 0025 already keeps them apart: `HoldReason` has `NO_CASH` and `SPENDING_CAP` as separate members, and its hold order checks `NO_CASH` (`floor(cash ÷ k) = 0`) before `SPENDING_CAP` (`floor((spendingCap − spent) ÷ k) = 0`). Nothing merges them, so no split is needed. When both hold, the line reports `NO_CASH`, the first in ADR 0025's order: the purse being empty is the more pressing fact, and a raised cap wouldn't help. The two `ORDER_REFUSED` rows can only arise if sizing and the gates disagree, which ADR 0025 says shouldn't happen. They're mapped so even that case names the right reason.

**A short batch says why** (amends ADR 0025 decision 7's `BATCH_STARTED`). ADR 0025's sizing can start a batch smaller than `batchSize` because cash or the cap ran low, which is the same distinction one step earlier. So the line carries it:

```ts
// packages/contracts/src/knowledge.ts
/** What made a batch smaller than the order's batchSize. */
export type BatchLimit =
  | { readonly kind: "STORAGE" }
  | { readonly kind: "MATERIALS"; readonly materialId: MaterialId }
  | { readonly kind: "CASH" }
  | { readonly kind: "SPENDING_CAP" };

// ReportLine's BATCH_STARTED gains:
/** null when quantity === the order's batchSize. Otherwise the first bound, in ADR 0025's hold order, equal to quantity. */
readonly limitedBy: BatchLimit | null;
```

"In hold order" means storage room, then each input in recipe order, then cash, then the cap: the same order as `HoldReason`, so ties resolve the same way. Its copy isn't approved yet (*Needs design*).

**Production proceeding.** "The still's running. Nothing needs your attention right now." is a status, not an event, so it isn't a `ReportLine`. ADR 0025 delivers nothing for an empty report, and that stays. The scene shows the line when:

- the founder is on a call to the station answered by an employee there, or is `PRESENT` at the station;
- the view in front of them (the call view or the live view, both in the player snapshot) has `FACILITY_OPERATIONS` for the station showing a running job; and
- no problem line (`HELD_BACK`, `ORDER_REFUSED`, `BATCH_FINISHED` with `FAILED`, ADR 0026's Driver problem lines) was delivered in a `REPORT` item during this call or visit (items with `tick ≥ call.connectedAt`, or since the arrival).

It reads only the player snapshot. The human's note says exact report triggers still need implementation validation: PT2 judges this one.

**Catch-up on a visit.** "Since you were last here: {brief factual changes}." heads a report delivered when the founder arrives at, or wakes at, the station: the catch-up step's in-person delivery, or an early `WAKE`'s (ADR 0025 decision 7's in-person channel, first two cases). It doesn't head the deliveries made while the founder is already there. The `REPORT` activity item says which:

```ts
// ActivityItem's REPORT member (ADR 0025) gains:
/** True when delivered with an arrival's or waking's catch-up (in the founder phase, or inside WAKE). */
readonly atArrival: boolean;
```

{brief factual changes} is the item's lines in short form, with the dropped count. The short forms aren't approved yet (*Needs design*).

**Batch complete.** "Finished {quantity} cases of {product}. They're ready at Hollow Creek." {quantity} is the line's `quantity`. {product} is the recipe's product and quality as the UI names them elsewhere. "Hollow Creek" is the station's location name, which in M002 is always Hollow Creek. The UI fills it from the station, so a later second still reads right without new copy.

**Lines without approved wording** (PLACEHOLDER, *Needs design*): `BATCH_STARTED`, `BATCH_FINISHED` with `FAILED` (no shipped recipe can fail), `HELD_BACK` for `RECIPE_NOT_SUPPORTED` and for an input other than corn, `ORDER_REFUSED` for other reasons, `limitedBy`, and ADR 0026's Driver lines.

**Delivery stays on the channels, and nothing about the still is a toast.** Report lines reach the founder only through ADR 0025's four channels and ADR 0024's messages, as `REPORT` and `MESSAGE_DELIVERED` activity items in the activity feed and message ledger (#209 §4: "not omniscient toasts").

**The guarantee is ADR 0021's rule, not `EVENT_IMPORTANCE`.** ADR 0021 (Context, "Events"): "The worker stops forwarding world events to the UI, because toasts built from world events are a channel." Under founder rules the UI gets the player snapshot's `activity` feed, and **no world event reaches the UI as a toast**. That includes the events an employee's work emits through existing code: a Distiller's batch settles in the `production` phase and emits `PRODUCTION_COMPLETED` (or `PRODUCTION_FAILED` once a recipe can fail), both `"notify"` with toast mappers today; a Driver's run emits ADR 0022's delivery events; and ADR 0025's five new events. On `main` that rule isn't built yet: `apps/game/src/workers/simulation-host.ts` forwards `sim.takeEvents()` to the UI whatever `founderRules` is, and `apps/game/src/ui/toasts/toast-view.ts` toasts every `notify` event plus the `log` events in `LoggedToastEventType` (`EQUIPMENT_SOLD`). So `"log"` alone doesn't stop a toast.

- **Who enforces it: K2 (#177)**, which moves every remaining surface behind knowledge and locks the non-leak property over every surface. Event forwarding and the toast host are such a surface. Under `founderRules: true` the worker forwards no world events to the UI (toasts come only from `activity` items, if at all). With the flag off, M001's toasts are unchanged.
- **E1 must not ship ahead of it.** E1 (#180) depends on PT1 and R1, not K2. So E1's refresh either adds K2 (#177) to E1's Depends on, or moves the founder-rules gate on event forwarding into E1's owned files (`apps/game/src/workers/simulation-host.ts`). Either way, E1's acceptance includes a test: under founder rules, a Distiller's batch completing while the founder is elsewhere produces no toast.
- **Defence in depth.** ADR 0025's five events (`EMPLOYEE_HIRED`, `STANDING_ORDER_SET`, `EMPLOYEE_DISMISSED`, `EMPLOYEE_ACTED`, `REPORT_DELIVERED`) are `"log"` in `EVENT_IMPORTANCE`, and none of them may be added to `LoggedToastEventType`. With the flag off no employee exists, so they never fire in M001 anyway.

The `REPORT` activity item stays `notify` in `ACTIVITY_IMPORTANCE` (ADR 0025). That slows the rest fast-forward (ADR 0023 decision 9). It's an activity item delivered by a channel, not a world-event toast.

### 9. No supply buying; the Runner is later

**Confirmed, no change to ADR 0025 decision 5.** A `DISTILL` order authorises exactly one command, `START_PRODUCTION` at the station within `recipeId`, `batchSize` and the cap. `PURCHASE_MATERIALS`, or anything else, from a Distiller is `OUTSIDE_AUTHORITY { limit: "COMMAND" }`. Buying needs presence at the supplier, and no employee's view includes one.

- **The spending cap covers conversion costs only.** It's charged against `PRODUCTION_START:EMPLOYEE`'s prepaid conversion cost (ADR 0025 decisions 6 and 12) and nothing else. It is never authority to buy materials, arrange a delivery or spend on anything else. The order form says so (decision 5).
- **Keeping the still fed stays the founder's job** (#209 §6): buy corn at Miller's, which delivers it to the still. A Distiller who runs out says so (decision 8's "out of corn") and waits.
- **The Runner (purchasing agent) is a later role,** with its own wages, trust and spending authority. It isn't in M002: `EmployeeRole` gains no member for it, and no standing-order variant buys anything. The orchestrator files it as a planned issue, outside M002 (the PR lists it under left out). PT2's question stands: if the first hire feels pointless, retune batch timing, output or travel first, and don't fold the Runner into the Distiller.

### 10. Approved copy

From #209, for the UI task that builds the hiring scene and the report feed (E1, #180, unless its refresh splits the UI out; E3 for the Office Hand's scene). These rows go into the relevant `copy.ts` marked as approved by #209, not PLACEHOLDER. The exact text is binding. Typography (curly quotes, dashes) is visual direction.

| Moment | Line | Shown when |
|---|---|---|
| Miller introduces candidates | "Looking for a hand? I know a couple who can work a still. Whether they're worth their asking price, that's yours to find out." | The hiring scene at Miller's, with at least one Distiller candidate showing (decision 4) |
| Distiller estimate, `LOW` | "Still learning the trade." | `competenceBand === "LOW"` for a Distiller candidate or employee |
| Distiller estimate, `MODERATE` | "Knows the basics of a still." | `"MODERATE"` |
| Distiller estimate, `HIGH` | "Has run a still without supervision." | `"HIGH"` |
| Distiller estimate, `UNCERTAIN` | "Hard to judge from a conversation." | `"UNCERTAIN"` |
| The inspectable range | "Estimate" (the label), then `low`–`high` | When the player inspects the band. Only the founder's range |
| Out of corn | "We're out of corn. Can't start another batch until more comes in." | Decision 8 |
| Storage full | "The shed's full. There's nowhere to put another batch." | Decision 8 |
| Spending cap reached | "I can't start the next batch with what you've allowed me to spend." | Decision 8. **Only** for the cap |
| Cash shortage | "There's not enough money to start the next batch." | Decision 8. **Only** for cash |
| Production proceeding | "The still's running. Nothing needs your attention right now." | Decision 8's derived status |
| Batch complete | "Finished {quantity} cases of {product}. They're ready at Hollow Creek." | `BATCH_FINISHED` `COMPLETED` (decision 8) |
| Catch-up on a visit | "Since you were last here: {brief factual changes}." | A `REPORT` item with `atArrival: true` |
| A call to the still off hours | "No answer. You can try again later." | ADR 0027's approved line, reused (decision 7) |

The band lines describe a still, so they're the Distiller's. A Driver's bands use the same thresholds and need their own wording (*Needs design*). The scene's labels for the asking wage and signing payment follow #209 §3's words ("asking wage", "signing payment"); their final form is copy for the UI task to confirm with the human.

### 11. Contract and game-data changes for EM1 (#210): ADR 0025 decision 16, restated as amended

EM1 is the contract task for ADR 0025 and depends on this record. **Bold** marks what this record adds or changes. Everything else repeats ADR 0025 decision 16, with its payloads and rows, so EM1 can work from this list alone. ADR 0027 changes nothing in this list (its amendment to ADR 0025 decision 7 is behaviour: Miller's as a family number, for C1 and E1). ADR 0026's own contract task follows EM1 and is listed after.

- `ids.ts`: `"StandingOrder"` in `IdKind` and `DYNAMIC_ID_KINDS`, prefix `"standing"`; `StandingOrderId`.
- `state.ts`: `EmployeeRole` (`"DISTILLER"`), `CompetenceEstimate`, `EmployeeState`, `EmployeeWork`, `StandingOrderState`, `StandingOrderTerms`, `DistillOrderTerms`; `GameState.employees` and `GameState.formerEmployees`; `ActivityKind` gains `HIRE` and `BRIEF_EMPLOYEE`.
- `commands.ts`:
  - `HireEmployeeCommand` (with `standingOrder: StandingOrderTerms | null`, **which carries the first order from the hiring conversation, decision 5**), `SetStandingOrderCommand`, `DismissEmployeeCommand` (types, `GameCommand`, `GAME_COMMAND_TYPES`);
  - `CommandIssuer = { kind: "FOUNDER" } | { kind: "EMPLOYEE"; characterId; standingOrderId }`; `CommandEnvelope.issuer` stays `{ kind: "FOUNDER" }`; `causedBy` stays `CommandId | null`;
  - the reasons `CANDIDATE_UNAVAILABLE { characterId }`, `CANDIDATE_TERMS_CHANGED { characterId, agreed, current }`, `STATION_UNSUITABLE { facilityId, role }`, `POSITION_FILLED { facilityId, role }`;
  - `OUTSIDE_AUTHORITY { characterId, standingOrderId, limit: AuthorityLimit }`, with `AuthorityLimit = "COMMAND" | "STATION" | "RECIPE" | "BATCH_SIZE" | "SPENDING_CAP"`. O1a didn't add either (neither is in `commands.ts` on `main`), so EM1 adds both.
- `events.ts`: `EMPLOYEE_HIRED { characterId, role, stationId, dailyWage, signingCost, startsAt, transactionId }`, `STANDING_ORDER_SET { characterId, standingOrderId: StandingOrderId | null, terms: StandingOrderTerms | null, transactionId }`, `EMPLOYEE_DISMISSED { characterId, transactionId }`, `EMPLOYEE_ACTED { characterId, standingOrderId, command, status: "APPLIED" | "REJECTED", reason: RejectionReason | null }` (with `causedBy: null`; it's the employee command's identity, ADR 0025 decision 6), `REPORT_DELIVERED { characterId, via, lineCount, dropped }`. The task finalises the payloads, using these fields at least. All `null` in `EVENT_CONCERNS_PLACE`, **and all `"log"` in `EVENT_IMPORTANCE`, never in `LoggedToastEventType` (defence in depth; the guarantee is ADR 0021's no-forwarding rule, enforced by K2, decision 8)**.
- `ledger.ts`: `TransactionKind` `PERSONNEL`, cash-flow default `WAGES`. `projection/finance.ts`'s `CASH_FLOW_CATEGORY` row is E1's, not EM1's.
- `knowledge.ts`:
  - `SUBJECT_KINDS` appends `EMPLOYEE_PERFORMANCE`; its `KnowledgeSubject` and `KnowledgeValue` members; `knowledgeSubjectKey`;
  - `HoldReason` (with `NO_CASH` and `SPENDING_CAP` as separate members, **confirmed by decision 8**), `ReportLine`, `PendingReport`, `ReportContent`;
  - **`BatchLimit`, and `ReportLine`'s `BATCH_STARTED` gains `limitedBy: BatchLimit | null` (decision 8);**
  - `ActivityItem` gains `REPORT { tick, characterId, via, report, atArrival }`, **with `atArrival: boolean` (decision 8)**;
  - `CallInReason` gains `EMPLOYEE_REPORT`; `HeldMessage.report` and `DeliveredMessage.report`;
  - `TRANSACTION_PRODUCERS` gains the five `PERSONNEL` and `PRODUCTION_START:EMPLOYEE` families, and `CASH_POSTING_REVEALS` gains `PRODUCTION_START:EMPLOYEE`.
- `player-snapshot.ts`: `PlayerEmployee`, `PlayerHiring` (**doc: "The people available to meet at this place now"**), `PlayerCandidate`; `PlayerSnapshot.employees` and `.hiring`; **`CompetenceBand`, and `PlayerCandidate.competenceBand` and `PlayerEmployee.competenceBand: CompetenceBand` (decision 4)**.
- `snapshot.ts` (world): `CharacterSnapshot.role` widens to `"FOUNDER" | "FOREMAN" | EmployeeRole` (an employee leader shows `skill` = true competence); `GameSnapshot.employees: readonly EmployeeSnapshot[]` (`EmployeeState` plus `name`), for the lab and the debug view.
- `schemas.ts`, `save.ts`: Zod for all of the above; ADR 0025 decision 14's bump and migration, with an old-version fixture. **This record's fields are part of those types' first version, so they need no step of their own** (checklist §3).
- `packages/game-data`:
  - `personnel.ts`: `CandidateDefinition`, `CANDIDATE_POOL` (**the five Distiller names approved by #209: comments say so, not PLACEHOLDER**), `HiringPlaceDefinition`, `HIRING_PLACES` (**Miller's Distiller row approved**), `RoleTerms` (**`estimateSpread: { min; max }` instead of a number, and `workingHours: readonly PlaceHoursInterval[]`, decisions 1 and 4**), `ROLE_TERMS` (**`DISTILLER.estimateSpread = { min: 20, max: 50 }`, `DISTILLER.workingHours = [06:00–20:00]`**), **`CompetenceBandThresholds`, `COMPETENCE_BANDS`**, `CANDIDATE_SLATE_TICKS`, `SPENDING_PERIOD_TICKS`, `DISTILL_ORDER_DEFAULTS`, `COMPETENCE_DURATION_PPM`, `COMPETENCE_REVEAL_BATCHES`, `REPORT_LINE_LIMIT`, with ADR 0025's load validation **plus decision 1's working-hours checks and decision 4's spread and band checks**; `GameData` gains them;
  - `scenario.ts`: `ScenarioDefinition.firstCandidates` (M001 `[]`; the M002 scenario `["walt-hagen"]`);
  - `knowledge.ts`: `KNOWLEDGE_VISIBILITY` rows `IN_PERSON.FACILITY` gains `EMPLOYEE_PERFORMANCE`, and `PHONE.FACILITY`, `MESSAGE.FACILITY` and `REPORT.FACILITY` = `FACILITY_STOCK`, `FACILITY_OPERATIONS`, `EMPLOYEE_PERFORMANCE`;
  - `ACTIVITY_DURATIONS` rows `HIRE` (60) and `BRIEF_EMPLOYEE` (15); `ACTIVITY_IMPORTANCE`: `REPORT` is `notify`.
- `packages/simulation/src/kernel/registry.ts` and `simulation.ts`: `employees` in `PHASES` between `production` and `vehicles`; `CommandContext.issuer: CommandIssuer`, and `envelope: CommandEnvelope | null`. Its hooks and `applyIssued` are E1's.
- `IssuerView`'s `EmployeeView` (simulation-internal, named here so the review can check it): the station's world subjects, its equipment, crew and storage, the cash balance, and the employee's own `EmployeeState`.

**E1 (#180)** implements, beyond ADR 0025's list: `onDutyAtMinute`, `onDuty` and `isAvailable` (decision 1); the policy step only on duty (decision 2); the Distiller's call-out hook case with `isAvailable` (decision 7); calls in only on duty (decision 6); the estimate width draw and `competenceBand` projection (decision 4); `limitedBy` and `atArrival` (decision 8); the no-toast test under founder rules, and the event-forwarding gate if K2 (#177) hasn't landed (decision 8); and the approved copy rows for the hiring scene and reports (decision 10).

**ADR 0026's contract task (after EM1)** applies ADR 0026 decision 16, with these changes:

- `RoleTerms.estimateSpread` becomes `{ min; max } | null` (ADR 0026 had `number | null`); `ROLE_TERMS.DRIVER` gets `estimateSpread: { min: 20, max: 50 }` and `workingHours: [06:00–20:00]`; `ROLE_TERMS.OFFICE_HAND` gets `estimateSpread: null` and `workingHours: [07:00–19:00]`;
- `PlayerCandidate.competenceBand` and `PlayerEmployee.competenceBand` become `CompetenceBand | null`, beside ADR 0026's nullable `competenceEstimate`;
- `commands.ts`: the reason `DEPARTURE_OUTSIDE_HOURS { role, departMinute }` (decision 3);
- load validation: `RUN_ORDER_HOLD_TICKS ≥ TICKS_PER_DAY` (decision 3).

**E2 (#182)** gates the Driver's steps 3 and 5 and calls in with `isAvailable`, and rejects a regular run outside hours (decision 3). **E3 (#183)** applies `isAvailable` in both attendant hooks, passes `ctx.tick` to `CallInAttendant` (ADR 0027 decision 9), and keeps the answerer for the whole call (decision 7). **C1 (#179)** reads a null call-in hook as "this number doesn't answer" (decision 6).

### 12. What R1 needs (amends ADR 0025 decision 17's table)

ADR 0025 decision 17's rows stand, with these changes and additions (all PLACEHOLDER):

| Number | Value | Where |
|---|---|---|
| Estimate width | 20–50 points, drawn per meeting (was a fixed 30) | `ROLE_TERMS.DISTILLER.estimateSpread` |
| Bands | uncertain at width ≥ 40; otherwise midpoint < 40 low, 40–64 moderate, ≥ 65 high | `COMPETENCE_BANDS` |
| Distiller's hours | 06:00–20:00: starts batches, answers the still's phone and calls in only then | `ROLE_TERMS.DISTILLER.workingHours` |
| Where | Miller's Feed & Seed, during its hours (approved, no longer PLACEHOLDER) | `HIRING_PLACES` |

R1's check runs with the hours applied. Decision 2 shows the sustainability margin survives them by a wide margin at M001's prices. Hiring itself isn't gated by the Distiller's hours, so "possible" is unchanged.

## Design-record checklist (factory.md §1)

### 1. Non-leak, per command and surface

Every input below is always-known state (founder whereabouts including `busy` and `call`, cash, agreements including employees' `role`, `startsAt`, stored estimate and standing orders), game-data (`ROLE_TERMS` including `workingHours` and `estimateSpread`, `COMPETENCE_BANDS`, `HIRING_PLACES`, `PLACE_HOURS`), the clock, the seed (for keyed draws), knowledge, the live and call views, or a channel.

| Command or surface | Immediate result | Activity item | Catch-up | Books row | Snapshot field |
|---|---|---|---|---|---|
| `isAvailable` / `onDuty` | — | — | — | — | Not projected. Role, `startsAt`, game-data and the tick only |
| A call out to the station off duty | — | `CALL_PLACED { answered: false }`: the hook's inputs are the player view, game-data and the tick (ADR 0024 decision 9) | None | None: an unanswered call posts nothing (ADR 0024) | `founder.busy` (`PHONE_NO_ANSWER`) |
| A call that outlasts a shift | — | Unchanged | None | Unchanged | `founder.call.answeredBy`, set at connect from known inputs |
| An employee's call in, gated by hours | — | ADR 0025's | None | ADR 0025's | ADR 0025's. Whether it's placed adds one known condition |
| The Distiller's policy step, gated by hours | None (ADR 0022 decision 5) | None | None | `PRODUCTION_START:EMPLOYEE` fires only on duty: it's a cash posting, and a channel, as ADR 0025 decides | Cash |
| The Driver's steps 3 and 5, gated | None | None | None | ADR 0026's | None |
| Orders off duty (`SET_STANDING_ORDER`, `DISMISS_EMPLOYEE`, `ORDER_RUN`) | ADR 0025 and 0026's reasons, unchanged: hours aren't read | `COMMAND` | None | Entry-less | Agreements |
| `HIRE_EMPLOYEE` / `SET_STANDING_ORDER` with a `DRIVE` regular run outside hours | `DEPARTURE_OUTSIDE_HOURS { role, departMinute }`: the command's field and game-data | `COMMAND` | None | None | None |
| The hiring slate | — | — | — | — | `hiring.candidates[].competenceEstimate` and `.competenceBand`: the seed, the slate index, game-data and the employees on the books (ADR 0025's argument), plus `COMPETENCE_BANDS` |
| `PlayerEmployee.competenceBand` | — | — | — | — | From the stored `competenceEstimate` (an agreement) and game-data |
| `BATCH_STARTED.limitedBy` | — | Inside a `REPORT` item, only when a report is delivered | Delivered with the report | None | Through the report only |
| `REPORT.atArrival` | — | `REPORT`: set from which delivery step ran (founder state) | The arrival delivery | None | Activity |
| World events from employee work (`PRODUCTION_COMPLETED`/`PRODUCTION_FAILED` of an employee's batch, a Driver's delivery events, ADR 0025's five events) | — | None | None | Existing rows | None: under founder rules the worker forwards no world event to the UI, so none is a toast (ADR 0021, enforced by K2 #177; decision 8) |
| The "still's running" status | — | — | — | — | None: the UI derives it from the call or live view and delivered `REPORT` items, all in the player snapshot |

**The static half of ADR 0021 decision 9.** Two worlds that differ only in hidden state, given the same commands, have the same agreements, game-data, seed and clock. So `isAvailable`, the call-out hook's answer, the estimate (width and offset are keyed draws on static keys), the band, and the `DEPARTURE_OUTSIDE_HOURS` result are equal in both.

**The dynamic half.** No new channel. Hours only narrow when existing channels can fire: an employee's call in now also needs `isAvailable` (known), and is still triggered by `callPending`, so ADR 0025's argument holds (a call that differs between the runs delivers a report that differs). `limitedBy` is part of a report line, so it reaches the founder only in a delivered report, which ADR 0025's delivery clause already counts. K2's generators perturb `work` and `report` as before, now including `limitedBy`.

### 2. Coverage tables (ADR 0021 decisions 6 and 7)

**No new producer.** Hours change *when* `PRODUCTION_START:EMPLOYEE` (ADR 0025's cash-posting row) and ADR 0026's Driver producers fire, not what they post or reveal. An unanswered call posts nothing. The hiring scene and the bands post nothing. `TRANSACTION_PRODUCERS`, `CASH_POSTING_REVEALS` and `PENDING_BOOKS_CONCERNS` gain nothing beyond ADR 0025's and 0026's rows.

### 3. Migration

**No step of its own.** EM1 (#210) depends on this record and hasn't landed, so `BatchLimit`, `BATCH_STARTED.limitedBy` and `REPORT.atArrival` are part of the first version of `ReportLine` and `ActivityItem`'s `REPORT` member. No earlier save can hold either: before EM1's bump, no command could hire. ADR 0025 decision 14's migration stands as written. `competenceBand` is in the player snapshot, which isn't saved. `workingHours`, `estimateSpread` and `COMPETENCE_BANDS` are game-data, never read by a migration (ADR 0009). `DEPARTURE_OUTSIDE_HOURS` is an additive union member. The refresh of EM1 (factory.md §7.2) checks that this still holds.

### 4. Re-locks

**Erratum (#231):** the claim below predates the founder-rules locked tests (`founder/no-trap`, `knowledge/non-leak`, `view/issuer-view`, `walking-skeleton/path`). EM1 (#210, PR #236) had to re-lock `view/issuer-view.locked.test.ts`, whose exhaustive `COVERAGE` lists every `RejectionCode`, for the new hiring codes. The original text follows.

**None.** Checked against the ten `@locked` files under `packages/simulation/test`:

- None mentions employees, hiring, `ROLE_TERMS`, `CANDIDATE_POOL`, report lines or working hours. A case-insensitive search of the locked files for `employee`, `hiring`, `ROLE_TERMS` and `workingHours` finds nothing; `candidate`, `report` and `role` appear only in other senses (a recovery-horizon variable in `prog-001-outcome`, finance reports and "reports `COMMAND_REJECTED`" in test names, and `CharacterDefinition.role` in `prod-001-labor`).
- Every locked file runs the M001 scenario with `founderRules: false`, where no employee exists (checklist §6).
- None enumerates `RejectionCode`, `ActivityItem` kinds or `ReportLine` kinds, so `DEPARTURE_OUTSIDE_HOURS`, `atArrival` and `limitedBy` break nothing.
- `prod-001-labor.locked.test.ts` pins `CHARACTERS` (unchanged: the candidate pool is a separate list, ADR 0025 decision 1).

### 5. Tick order

`PHASES` is unchanged from ADR 0026: `production, employees, vehicles, [world events], resolution, founder, phones, deadlines, midnight`, then the persist step.

- **Commands:** `PLACE_CALL` evaluates the call-out hook, and so `isAvailable`, at its apply tick `t`. Orders apply whatever the hour.
- **`production`:** unchanged; a batch finishing off duty writes its `BATCH_FINISHED` line.
- **`employees`:** each employee in `characterId` order. A Distiller's step runs only if `isAvailable(e, ctx.tick)`. A Driver's steps 1 and 2 always run, steps 3 and 5 only on duty. Deliveries are unchanged.
- **`vehicles`, `founder`:** unchanged. Arrival and waking deliveries set `atArrival: true`; the founder's step-0 deliveries (ADR 0026) and the end-of-`employees` deliveries set it false.
- **`phones`:** an employee's call in also needs `isAvailable(e, ctx.tick)`. The call-in hook gets `ctx.tick` (ADR 0027 decision 9) and evaluates `isAvailable` with it.
- **Shift edges:** an interval is half-open, so at the tick whose minute is `opensAtMinute` (06:00) the employee is on duty and steps in that tick's `employees` phase. At `closesAtMinute` (20:00) they're off.
- **On the tick a founder activity ends** (ADR 0023 decision 2a): employees still never read `busy` and never change founder state, and working hours depend only on the tick. A `PHONE_CALL` ending at `u` after the shift ended keeps its answerer through `u` (decision 7), and the founder phase ends it at `u` as ADR 0024 decides. A `HIRE` ending at `u` with `startsAt` off duty: the employee's first step is at the first on-duty tick at or after `startsAt`.
- **No-trap bound** (ADR 0023 decision 8): unchanged. Nothing here makes the founder busy, and `REST` is never refused for anything here.

### 6. Flag off (`founderRules: false`)

No employee can exist (ADR 0025 decision 13), so `isAvailable` is never called, no call is placed, and no slate, estimate or band is computed. The new game-data fields are read only under founder rules. M001 and the lab play exactly as before, and their state hashes move only by EM1's fields, as ADR 0025 says.

### 7. Randomness

**One new keyed draw:** the estimate's width, `keyedRng(seed, "estimate-width:<characterId>", slateIndex)`, only for a role whose `estimateSpread` has `min < max`, and only when a slate is computed (a player snapshot at a hiring place, or `HIRE_EMPLOYEE`'s check), under founder rules. It's a keyed one-shot (ADR 0024 decision 7): its key is static and its ordinal is the slate index, so hidden activity can't change it, and it moves no other draw. ADR 0025's `estimate:<characterId>` draw keeps its key and ordinal, with `w + 1` in place of `spread + 1`. Working hours, availability, the bands and the status line draw nothing. With the flag off, nothing here draws.

### 8. Rejection reasons

- **New:** `DEPARTURE_OUTSIDE_HOURS { role, departMinute }` (decision 3), at gate 1 for `HIRE_EMPLOYEE` and `SET_STANDING_ORDER` with `DRIVE` terms whose regular run departs outside the Driver's working hours. In ADR 0026 decision 15's gate-1 order, it comes after the `INVALID_QUANTITY` check on `departMinute`.
- **Reused:** none newly; ADR 0025 and 0026's reasons are unchanged.
- **Not reasons:** an off-duty employee not answering, not calling in, not starting a batch or not taking up a run are outcomes. **No order is ever refused for the recipient's hours** (decision 7).

Every payload is always known: the command's field and the role.

## Consequences

- **The still has a working day.** Batches run overnight, but the next one starts in the morning, at a worst-case cost of a quarter to a third of round-the-clock output (decision 2's table). That's far inside the margin that pays a Distiller (decision 2). A founder who wants the still busy at dawn can size batches to finish in the day. That's a choice worth having, not a chore, and PT2 judges it.
- **Phoning the still is a daytime thing.** From Miller's, during its hours, someone always answers. From the depot at night, nobody does, and the founder knows that in advance. A problem at night is phoned in at 06:00, or found on a visit.
- **"Hard to judge" is a property of a meeting, not a person.** The same candidate can read clearly on one slate and not on the next. Waiting three days for a new slate is a way to learn more, at the cost of time.
- **Every approved report line maps to a reason the simulation already distinguishes.** Cash shortage and the spending cap were already separate holds. A batch cut short now says which one cut it.
- **The first hire stays a single relief.** The Distiller runs batches only, keeping the still fed is still the founder's errand, and the Runner is a planned later role.
- **Hours are game-data, per role.** If PT2 or PT3 want hours as an agreement per employee (a night man for the still), it's a field on `HIRE_EMPLOYEE` and `EmployeeState` feeding the same `isAvailable`, and the non-leak argument doesn't change.

## Needs design (placeholders in this record)

Story and visual direction (factory.md §8). #209 settled where people are hired, the five Distiller names, the bands' copy, the six report lines, that the Distiller lives at the still, the end of day-and-night answering, and that the Distiller doesn't buy supplies. Still open:

- **Candidates' appearances and voices** (#209 §2: distinct, brief conversational voices), under decision 4's rule that nothing varies with competence.
- **The Office Hand in the hiring scene:** how a candidate with no competence line reads on the page (visual and copy only; ADR 0026 decision 1 settles that there's no band and no range).
- **Band copy for Drivers** (and any later role whose work isn't a still).
- **Report lines without approved wording** (decision 8): a batch started, a batch failed, what limited a short batch, a recipe the still can't run, out of an input other than corn (is "We're out of sugar. …" the same template?), refusals for other reasons, the short forms inside "Since you were last here", "1 case" in the singular, and ADR 0026's Driver lines.
- **An empty slate,** and Miller's line when only Office Hand candidates are showing.
- **How working hours are shown:** whether the scene or the ledger tells the player when the Distiller is up, and in what words.
- **Labels for the wage terms:** "asking wage" and "signing payment" from #209 §3, in their final form.
- **Tuning (R1, PT2, PT3, T-LAB):** `workingHours` for each role, `estimateSpread` (20–50), `COMPETENCE_BANDS` (40 / 40 / 65), and ADR 0025's and 0026's numbers. #209 lists telephone hours and report triggers as needing implementation validation.
- **Later roles, not M002:** the Runner (purchasing agent), filed as a planned issue (decision 9).
