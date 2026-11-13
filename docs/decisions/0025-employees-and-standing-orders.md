# 0025: Employees, hiring, standing orders and reports

Status: accepted (decided by the orchestrator for M002 task D5a, issue #172; implemented by the contract task it names, E1 #180 and R1 #176)

Amends: ADR 0017 decisions 1 and 10 (job duration under an employee, who the leaders are), ADR 0021 decisions 4–6 and 9 (a new subject kind, the `REPORT` rows, the dynamic delivery clause), ADR 0022 decisions 5 and 8 (the employee issuer, carried on the command context rather than an envelope; `OUTSIDE_AUTHORITY`'s payload; production failure draws), ADR 0023 decisions 1, 2a and 4 (two activity kinds, the `employees` phase), ADR 0024 decisions 3, 4, 5, 6, 8, 9 and 10 (an employee answering the family line, a report delivering pending news on a call, employees calling in, report messages, the `employees` phase before `phones`, the attendant hook before E3, the dynamic delivery clause).

Amended by ADR 0027 (#213, earned phone access and message-taking): decision 7. "A public phone that `holdsMessages`" becomes a place that takes messages under an arrangement: a Distiller's report call in reaches Miller's as a family number once it takes messages, while its phone is open (ADR 0027 decisions 6 and 9).

Amended by ADR 0028 (#214, the hiring scene, the Distiller's hours and reports): decisions 1, 2, 3, 5, 6, 7, 16 and 17. The candidate names and Miller's are approved (#209). Employees start batches, answer the still's phone and call in only within their role's working hours (`isAvailable`), and the "answers day and night" placeholder is gone. Orders still reach them at any hour. An estimate's width is drawn per meeting and is shown as one of four bands. `BATCH_STARTED` says what limited a short batch, and a report delivered on arrival is marked `atArrival`. ADR 0028 decision 11 restates decision 16 as amended.

Amended by ADR 0029 (#241, two-stage production): decisions 5, 6, 12, 16 and 17. A `DISTILL` order authorises `SET_MASH` and `START_DISTILLATION` instead of `START_PRODUCTION`. The policy sets a mash when barrels are free and inputs exist, and distills ready wash only when the run fits the shift. Competence sets the run's length, the spending cap is charged at the mash, and the employee's producers become `PRODUCTION_START:EMPLOYEE:MASH` and `:RUN`. ADR 0029 decision 15 re-checks R1.

## Context

GDD §21 (PERS-001): hiring removes a responsibility, not clicks. You start as the whole business and hire your way out of being everywhere. The design test for any role is "what can now happen without the founder there?" The **Distiller** (M001's foreman) runs batches at the still while you're away, following a standing order. They report when you visit, or by phone if the still has one, and their output depends on competence. Named employees have competence, reliability and loyalty. M002 uses competence only: candidates show an estimate, and you learn the real value by working with them. Wages, candidate pools and competence ranges are game-data. Where you find candidates is story. GDD §16 rule 1 says the first hire must be reachable, and rule 3 says hiring must add choices, not just remove them.

**The play this record is for.** Without a hire, the founder's day is a loop of trips: the feed store for corn, the still to start a batch, the still again to load the truck, the buyer, and back. A batch is one job at a time, so the still sits idle whenever the founder is somewhere else when it finishes. With a Distiller, the still keeps running between the founder's visits. The founder's loop becomes: buy corn (the supplier delivers it to the still), drive loads to buyers, and drop in on the still or call it now and then to see how it's going. The freed hours go to farther buyers, contracts and a second operation (rule 3). The cost is wages, a signing payment, and not knowing exactly what's happening at the still until a report reaches you. Later milestones add the question "is my distiller telling me the truth?", and this record leaves room for it without building it.

**Earlier records left these hooks:**

- **ADR 0021** defines the source `REPORT { characterId }` and leaves its `KNOWLEDGE_VISIBILITY` rows, and the `PHONE` row for the family's own facility, to this record (decision 6). Rule 1 of decision 6 treats midnight wages as known at once **because they depend only on agreements**. The #172 follow-up asks this record to revisit that if anything can change wages or the workforce without a founder command.
- **ADR 0022** decision 5 already decides: the issuer `{ kind: "EMPLOYEE"; characterId; standingOrderId }`; an `EmployeeView` that validates against the world at the employee's station; `OUTSIDE_AUTHORITY` recorded in the report, not shown; a test that every employee command also passes the founder's gates 1 and 5 at that place; standing orders act without a call per action, and changing one needs presence or a call; employee spending is a cash posting. It leaves `StandingOrderId`, the `EMPLOYEE` issuer variant and the standing order shapes to this record.
- **ADR 0023** owns the founder's state, `busy`, `ACTIVITY_DURATIONS` and the tick order, and leaves "employees' work" to this record (decision 4).
- **ADR 0024** owns phones and messages. A call out to a family line is answered by whoever the **call-out attendant hook** returns, and a call in is taken as a message by the **call-in attendant hook**. Both return null until ADR 0026 (D5b) fills them. A call answered by an employee reveals the `PHONE` row for `FACILITY`, empty until this record. "Employees calling in use the same numbers and the same answering order. Their content is `REPORT` (ADR 0025)." Orders to an employee on a call pass the busy gate the same way by-phone deals do, and this record applies that to its commands. Messages' "older values never overwrite newer ones" rule may be reused for reports.

**What the code has today (verified on `main` at ec2f276).**

- **People are static game-data.** `CharacterDefinition { id, name, role: "FOUNDER" | "FOREMAN", skill, loyalty, dailyWage }` in `packages/game-data/src/personnel.ts`, with two entries: Thomas Kerrigan (`FOUNDER`, $0.00 a day) and Walt Hagen (`FOREMAN`, skill 55, loyalty 70, $3.00 a day). `WORKFORCE.workerDailyWage` is $2.00. There's no character state in `GameState`. Skill and loyalty have no mechanical effect, and `prod-001-labor.locked.test.ts` pins that.
- **Leaders are every game-data character.** The world snapshot's `family.leaders` maps `data.characters` (`projection/snapshot.ts`, `projectSnapshot`). `CharacterSnapshot.role` is `"FOUNDER" | "FOREMAN"` (`packages/contracts/src/snapshot.ts`).
- **Wages.** `dailyWagesDue` in `packages/simulation/src/production/settlement.ts` is Σ `data.characters[].dailyWage` + Σ `facilities[].workerCount × workerDailyWage`, charged at midnight as `DAILY_SETTLEMENT:WAGES:<day>`. `SET_WORKFORCE` (`production/workforce.ts`) is the only thing that changes `workerCount`.
- **Production.** `START_PRODUCTION` (`production/jobs.ts`) rejects with `PRODUCTION_CAPACITY_EXCEEDED` while any job runs at the facility, so a facility runs one job at a time. Job duration is crew-aware (`capacity.ts`, `jobDuration`). A recipe with `failureChance > 0` draws once from `rng.production` at completion; every shipped recipe has `failureChance: 0`, so nothing is drawn today.
- **The kernel.** `PHASES` in `kernel/registry.ts` is `production, vehicles, resolution, founder, deadlines, midnight` on `main`: P1 added the `founder` phase (ADR 0023). ADR 0024 adds `phones`, not yet implemented. Counters in `counters.nextId` start at 1 (`game/new-game.ts`). `SAVE_SCHEMA_VERSION` is 3 (P1).
- **Replay.** `KernelSimulation.replay` (`kernel/simulation.ts`) places each logged envelope by raising `counters.nextId.Command` and `nextCommandSequence` to just past that envelope's, and `replayJournal` (`kernel/replay-journal.ts`) places every envelope due by a tick before advancing to it. So during a replay those two counters can run ahead of where they stood in the original run. Nothing in M001 mints from them during a tick, and decision 6 keeps it that way.
- **K1's contract** (`packages/contracts/src/knowledge.ts`): `SOURCE_KINDS` already includes `REPORT`; `SUBJECT_KINDS` sets the record order and so the state hash; `TRANSACTION_PRODUCERS` lists M001's producers only; `CASH_POSTING_REVEALS` and `PENDING_BOOKS_CONCERNS` are decision 6's and 7's tables; `ActivityItem` has `COMMAND`, `CATCH_UP` and `CASH_POSTING`. In `packages/game-data/src/knowledge.ts`, `KNOWLEDGE_VISIBILITY.REPORT` is empty for every party and `PHONE.FACILITY` is empty.

Story and visual items (candidate names, where candidates are found, report wording, the hiring and report scenes) are **PLACEHOLDER** here and listed under *Needs design* at the end. This record decides the mechanism they plug into. The Driver and the Office Hand, and the hired-driver deal case from #191, are ADR 0026's (D5b).

## Decision

### 1. People: static identities, dynamic employees

**Options considered:**

- **(a) Make `CHARACTERS` dynamic** (move people into state). Rejected: names are story and static, ADR 0008 keeps static facts out of state, and `prod-001-labor.locked.test.ts` pins `GAME_DATA.characters` to exactly a founder and a foreman.
- **(b) Mint character IDs from a counter at hire.** Rejected: simulation-created IDs are renamed in the non-leak comparison (ADR 0021 decision 9) and are never shown, but an employee's name and identity are shown everywhere, and a hired person's ID has to be the same as the candidate's.
- **(c) A static candidate pool in game-data, plus employee state for the people actually hired (chosen).** Identity (ID, name, role eligibility, competence range) is static. Being employed, the agreed wage, the station, the standing order and the true competence drawn for this game are dynamic.

**Game-data** (`packages/game-data/src/personnel.ts`; ADR 0012 lets game-data own these definition types):

```ts
export interface CandidateDefinition {
  readonly id: CharacterId;
  readonly name: string;                         // PLACEHOLDER (story)
  readonly roles: readonly EmployeeRole[];
  /** The true competence is drawn once per game in [min, max] (decision 3). min === max fixes it. */
  readonly competence: { readonly min: number; readonly max: number };   // 0–100
  /** Reserved for later milestones. Copied into EmployeeState at hire; no rule reads them in M002. */
  readonly reliability: number;                  // 0–100, PLACEHOLDER 50
  readonly loyalty: number;                      // 0–100, PLACEHOLDER 50
}

export const CANDIDATE_POOL: readonly CandidateDefinition[] = [
  // PLACEHOLDER names (story, needs-design). Walt Hagen keeps his M001 identity:
  // the same CharacterId and name as the FOREMAN entry in CHARACTERS, and his M001 skill.
  { id: asId("Character", "walt-hagen"),    name: "Walt Hagen",    roles: ["DISTILLER"], competence: { min: 55, max: 55 }, reliability: 50, loyalty: 50 },
  { id: asId("Character", "eddie-novak"),   name: "Eddie Novak",   roles: ["DISTILLER"], competence: { min: 30, max: 80 }, reliability: 50, loyalty: 50 },
  { id: asId("Character", "mae-brennan"),   name: "Mae Brennan",   roles: ["DISTILLER"], competence: { min: 40, max: 90 }, reliability: 50, loyalty: 50 },
  { id: asId("Character", "gus-lindqvist"), name: "Gus Lindqvist", roles: ["DISTILLER"], competence: { min: 20, max: 70 }, reliability: 50, loyalty: 50 },
  { id: asId("Character", "otto-krause"),   name: "Otto Krause",   roles: ["DISTILLER"], competence: { min: 35, max: 75 }, reliability: 50, loyalty: 50 },
];
```

Load validation: IDs unique and valid; every range within 0–100 with `min ≤ max`; reliability and loyalty in 0–100; a pool entry that shares an ID with a `CHARACTERS` entry has the same name; no pool entry has the `FOUNDER`'s ID; and for each role, the pool holds at least `ROLE_TERMS[role].slateSize` people, so a slate drawn with no one employed is never short (decision 3).

`CHARACTERS` and `CharacterDefinition` don't change.

**State** (`packages/contracts/src/state.ts`):

```ts
/** M002 roles. ADR 0026 adds "DRIVER" and "OFFICE_HAND". */
export type EmployeeRole = "DISTILLER";

/** What the founder was told about a candidate's competence: a range that contains the true value. */
export interface CompetenceEstimate {
  readonly low: number;   // 0–100
  readonly high: number;  // 0–100, low ≤ high
}

export interface EmployeeState {
  // Agreements: always known (decision 2).
  readonly characterId: CharacterId;
  readonly role: EmployeeRole;
  /** The family facility they work at. Their place for presence (ADR 0022 decision 5). */
  readonly stationId: FacilityId;
  readonly dailyWage: Money;
  readonly hiredAt: Tick;
  /** They're at the station and acting from this tick (hiredAt + ROLE_TERMS.reportingDelayTicks). */
  readonly startsAt: Tick;
  readonly competenceEstimate: CompetenceEstimate;
  readonly standingOrder: StandingOrderState | null;

  // World state: hidden from the founder except through channels.
  /** The true competence, 0–100, drawn when the candidate was first generated (decision 3). */
  readonly competence: number;
  /** Reserved, inert in M002: no rule, projection or draw reads them (decision 11). */
  readonly reliability: number;
  readonly loyalty: number;
  readonly work: EmployeeWork;
  /** What they'll tell the founder next (decision 7). */
  readonly report: PendingReport;
}

export interface EmployeeWork {
  /** The job this employee started that is still running, or null. */
  readonly currentJobId: ProductionJobId | null;
  /**
   * Jobs this person has started for the family that have finished (completed or failed), over every
   * stint: a re-hire starts from the count in `GameState.formerEmployees`. Drives EMPLOYEE_PERFORMANCE.
   */
  readonly batchesRun: number;
  /** The last reason the policy couldn't act, so a hold is reported once, not every tick. */
  readonly lastHold: HoldReason | null;
  /** The last refusal of a command the policy issued, so a stuck refusal is reported once (decision 6). */
  readonly lastRefusal: RejectionReason | null;
  /** Spending against the standing order's cap, per SPENDING_PERIOD_TICKS window. */
  readonly spending: { readonly periodIndex: number; readonly spent: Money };
}

export interface GameState {
  // existing fields, plus:
  /** Sorted by characterId with compareIds. Empty with founderRules off. */
  readonly employees: readonly EmployeeState[];
  /**
   * People who worked for the family and were dismissed, with what they'd done, so a re-hire keeps
   * their record (decision 8). Sorted by characterId. An entry is removed when the person is re-hired.
   */
  readonly formerEmployees: readonly { readonly characterId: CharacterId; readonly batchesRun: number }[];
}
```

`HoldReason` and `PendingReport` are in decisions 6 and 7.

**Who the leaders are** (amends ADR 0017 decision 10). With `founderRules: false`, the leaders are every `data.characters` entry, exactly as today: M001 keeps Walt as a static foreman. With `founderRules: true`, the leaders are the `FOUNDER` entry of `data.characters` plus one per `GameState.employees` entry. Static `FOREMAN` entries are not leaders under founder rules. In the M002 scenario, Walt is a candidate (decision 3) and becomes a leader only if hired.

### 2. What's always known about employees

Hiring, wages, stations and standing orders are **agreements the founder made** (ADR 0021 decision 3, which already lists "standing orders given" and "wages agreed"). So these `EmployeeState` fields are always known: `characterId`, `role`, `stationId`, `dailyWage`, `hiredAt`, `startsAt`, `competenceEstimate` and `standingOrder`.

The rest is world state: the true `competence`, `reliability`, `loyalty`, `work` and `report`. The founder learns how the work is going only through channels (decision 7), and learns the true competence through the `EMPLOYEE_PERFORMANCE` subject (decision 8).

**The player snapshot** gains an `employees` section (`packages/contracts/src/player-snapshot.ts`):

```ts
export interface PlayerEmployee {
  readonly characterId: CharacterId;
  readonly name: string;                      // CANDIDATE_POOL, static
  readonly role: EmployeeRole;
  readonly stationId: FacilityId;
  readonly dailyWage: Money;
  readonly hiredAt: Tick;
  readonly startsAt: Tick;
  readonly competenceEstimate: CompetenceEstimate;
  readonly standingOrder: StandingOrderState | null;
  readonly performance: Known<KnowledgeValueOf<"EMPLOYEE_PERFORMANCE">>;
}

export interface PlayerSnapshot {
  // K1's sections, plus:
  /** Employees, sorted by characterId. Agreements, plus known performance. */
  readonly employees: readonly PlayerEmployee[];
  /** The candidates in front of the founder, or null (decision 3). */
  readonly hiring: PlayerHiring | null;
}
```

`spending.spent` isn't projected. With one Distiller it equals the sum of known cash postings for the period, but with several employees the books don't say whose posting is whose, so projecting it per employee would reveal more than the postings do.

### 3. Candidates: a seeded slate the founder sees in person

**Options considered:**

- **A candidate pool in state, drawn from a shared stream.** Rejected: it needs state and a migration, and a shared stream can be advanced by hidden activity (ADR 0022 decision 8's problem).
- **A pure function of the seed, the time and agreements (chosen).** Who's looking for work, and what they ask, depends on nothing the founder can't know, so it can't leak, needs no state, and hidden activity can't shift it.

**Where.** Candidates are found at **hiring places** (game-data, PLACEHOLDER, needs-design):

```ts
// packages/game-data/src/personnel.ts
export interface HiringPlaceDefinition {
  readonly locationId: LocationId;
  readonly roles: readonly EmployeeRole[];
}
export const HIRING_PLACES: readonly HiringPlaceDefinition[] = [
  // PLACEHOLDER (story: where and how you find people). Word of mouth at the general store.
  { locationId: MILLERS_FEED_LOCATION, roles: ["DISTILLER"] },
];
```

Load validation: locations exist, at most one entry per location, and every role has at least one hiring place. The feed store is a deliberate placeholder: the founder goes there for corn anyway, so the first hire costs no extra trip.

**The slate.** For each role, a **slate** of candidates is on offer at every hiring place for that role, and changes every `CANDIDATE_SLATE_TICKS` (game-data, PLACEHOLDER 4 320: three days). At tick `t`, with `slateIndex = floor(t / CANDIDATE_SLATE_TICKS)`:

1. **The role's pool:** `CANDIDATE_POOL` entries whose `roles` include the role, sorted by ID with `compareIds`.
2. **Forced:** if `slateIndex === 0`, the scenario's `firstCandidates` whose `roles` include the role, in listed order. `ScenarioDefinition` gains `firstCandidates: readonly CharacterId[]`: `["walt-hagen"]` in the M002 scenario ("M001's foreman becomes the first distiller you can hire"), `[]` in the M001 scenario.
3. **Drawn:** the rest of the slate, `ROLE_TERMS[role].slateSize − forced.length` people, picked from the role's pool minus the forced ones by a partial Fisher–Yates shuffle with `rng = keyedRng(seed, "slate:<role>", slateIndex)`.
4. **Shown:** forced followed by drawn, in pick order, **leaving out anyone in `GameState.employees`**.

The draw ignores who's employed, and step 4 only filters. So hiring one candidate takes them off the slate without reshuffling the others, and a slate can show fewer than `slateSize` people (none, if everyone drawn is already working for the family). With no one employed, as at the start, every slate is full.

**Each candidate's terms**, for candidate `c` on slate `s`:

- **True competence:** `c.competence.min + nextInt(keyedRng(seed, "competence:<c.id>", 0), max − min + 1)`. The ordinal is 0, so a person has the same true competence every time they appear in this game. It's stored in `EmployeeState.competence` at hire.
- **Estimate:** `o = nextInt(keyedRng(seed, "estimate:<c.id>", s), spread + 1)`, where `spread = ROLE_TERMS[role].estimateSpread`. Then `low = max(0, competence − o)` and `high = min(100, low + spread)`. The true value always lies in `[low, high]`, and where it lies changes from slate to slate.
- **Asking wage:** `wage.min + floor((wage.max − wage.min) × (low + high) / 200)`, in cents. The asking wage follows the **estimate**, not the truth: everyone in town thinks Eddie is good, and he charges like it. A cheap hire who turns out good, or a dear one who doesn't, is the hiring gamble.
- **Signing cost:** `ROLE_TERMS[role].signingCost`.

All of it is integer arithmetic; `keyedRng` is ADR 0024 decision 7's.

```ts
// packages/game-data/src/personnel.ts
export interface RoleTerms {
  readonly dailyWage: { readonly min: Money; readonly max: Money };
  /** Paid in cash at hire: a week's pay up front, or the cost of finding them. */
  readonly signingCost: Money;
  readonly slateSize: number;
  readonly estimateSpread: number;
  /** Time from hire until they're at the station and acting. */
  readonly reportingDelayTicks: number;
}
export const ROLE_TERMS: Readonly<Record<EmployeeRole, RoleTerms>> = {
  DISTILLER: {
    dailyWage: { min: cents(300), max: cents(600) },   // PLACEHOLDER (R1)
    signingCost: cents(2_500),                          // PLACEHOLDER (R1)
    slateSize: 2,                                       // PLACEHOLDER
    estimateSpread: 30,                                 // PLACEHOLDER
    reportingDelayTicks: 120,                           // PLACEHOLDER: two hours to get out to the still
  },
};
export const CANDIDATE_SLATE_TICKS = 4_320;            // PLACEHOLDER
```

**What the founder sees.** While the founder is `PRESENT` at an open hiring place (`PLACE_HOURS`, ADR 0023), the player snapshot's `hiring` is that place's slates:

```ts
export interface PlayerHiring {
  readonly locationId: LocationId;
  /** The tick the current slate is replaced. */
  readonly slateEndsAt: Tick;
  /** Every role this place hires for, sorted by role, then in slate order. */
  readonly candidates: readonly PlayerCandidate[];
}

export interface PlayerCandidate {
  readonly characterId: CharacterId;
  readonly name: string;
  readonly role: EmployeeRole;
  readonly competenceEstimate: CompetenceEstimate;
  readonly dailyWage: Money;
  readonly signingCost: Money;
}
```

Elsewhere, `hiring` is `null`. Candidates aren't knowledge records in M002: they're shown live, like a scene, and not remembered after leaving (PLACEHOLDER: a remembered list is a later convenience).

**Why this can't leak.** The slate's inputs are `GameState.seed`, the tick, game-data, the scenario and the set of employees (agreements). The two worlds of the non-leak property share all of them. Draws are keyed one-shots, so nothing is stored and no stream advances.

### 4. Hiring

```ts
// packages/contracts/src/commands.ts
export interface HireEmployeeCommand {
  readonly type: "HIRE_EMPLOYEE";
  readonly characterId: CharacterId;
  readonly role: EmployeeRole;
  readonly stationId: FacilityId;
  /** The asking wage the founder accepted. Guards against a slate changing under a stale UI. */
  readonly dailyWage: Money;
  /** Instructions given at hire, or null to brief them later (decision 5). */
  readonly standingOrder: StandingOrderTerms | null;
}
```

- **Presence.** The founder must be `PRESENT` at an open hiring place for the role, and not busy. It's a timed activity: `ACTIVITY_DURATIONS` gains `HIRE` (PLACEHOLDER 60 min: a talk and a handshake). Hiring is always in person: there's no hiring by phone in M002.
- **Station.** It must be a family facility that can host the role. For a Distiller: a facility that owns recipe equipment (its `crewTerms(...).producing` is true; ADR 0017). At most one employee per role per station: a second Distiller at Hollow Creek is `POSITION_FILLED`.
- **Standing order at hire.** The founder is talking to the person, so instructions given at hire reach them (communication gate: in person). It saves a trip to the still just to brief them. GDD §18: the trip is the choice, and the clicks after it should be quick.
- **Effects,** in one transaction keyed `idempotencyKey("PERSONNEL", "HIRE", commandId)`, kind `PERSONNEL` (new):
  - Dr `WAGES_EXPENSE` / Cr `CASH` at the signing cost. A cost of 0 posts no entries. Cash-flow category `WAGES` (the kind's default).
  - A new `EmployeeState`: the slate's terms, `hiredAt = t`, `startsAt = t + reportingDelayTicks`, an empty `report`, and `work` empty except `batchesRun`, which is taken from the person's `formerEmployees` entry (removing it) if they have one, else 0. A `StandingOrderState` if terms were given (decision 5); that order's `STANDING_ORDER_SET` rides this transaction, with no separate `PERSONNEL:ORDER` one.
  - Emits `EMPLOYEE_HIRED { characterId, role, stationId, dailyWage, signingCost, startsAt, transactionId }`, and `STANDING_ORDER_SET` if terms were given.
- **Wages** run from the first midnight after hire (decision 9).

`HIRE_EMPLOYEE` isn't repeatable (`RepeatableCommand` is unchanged).

**Dismissal:**

```ts
export interface DismissEmployeeCommand {
  readonly type: "DISMISS_EMPLOYEE";
  readonly characterId: CharacterId;
}
```

- **Reach:** in person at the station or on a call that reaches them (decision 5's `Reach`); otherwise `NO_WAY_TO_REACH`. In person it's timed: `BRIEF_EMPLOYEE` (below). On a call, it takes the call's time.
- **Effects,** in a transaction keyed `idempotencyKey("PERSONNEL", "DISMISS", commandId)` with no entries: their `batchesRun` is written to `formerEmployees`, their pending report is delivered (decision 7; empty by the invariant there, but delivered for safety), the `EmployeeState` is removed, and `EMPLOYEE_DISMISSED { characterId, transactionId }` is emitted.
- A job they started keeps running: the crew finishes it. Its completion just isn't anyone's `BATCH_FINISHED` line.
- No severance and no notice in M002 (PLACEHOLDER). They're paid nothing that night, because wages count the employees on the books at midnight (decision 9). The signing cost makes hire-and-fire churn cost something.
- A dismissed person goes back into the pool and can appear on a later slate. Their true competence is the same (decision 3). The founder's `EMPLOYEE_PERFORMANCE` record of them is kept, and stays right if they're hired again (decision 8).

### 5. Standing orders

**Shape** (`packages/contracts/src/state.ts`):

```ts
// packages/contracts/src/ids.ts: a new dynamic ID kind
export type StandingOrderId = Id<"StandingOrder">;   // DYNAMIC_ID_PREFIXES.StandingOrder = "standing"

export interface StandingOrderState {
  readonly id: StandingOrderId;
  readonly givenAt: Tick;
  readonly terms: StandingOrderTerms;
}

/** One variant per role. ADR 0026 adds the Driver's and the Office Hand's. */
export type StandingOrderTerms = DistillOrderTerms;

/**
 * After GDD §21's example ("produce basic moonshine; keep at least 20 cases on hand; spend no more than
 * $25 a week on supplies; report problems by phone"). The Distiller doesn't buy supplies in M002, so the
 * cap is on what they do spend: the batch's conversion cost. At basic moonshine's $4.00 a case, a still
 * running flat out spends about $280 a week, so the GDD's $25 would allow about six cases. The order
 * form's defaults are DISTILL_ORDER_DEFAULTS (game-data, PLACEHOLDER, R1 tunes).
 */
export interface DistillOrderTerms {
  readonly kind: "DISTILL";
  readonly recipeId: RecipeId;
  /** Start a batch only while unreserved cases of the recipe's product and quality at the station are below this. */
  readonly keepOnHand: number;
  /** The most cases in one batch. */
  readonly batchSize: number;
  /** The most conversion cost (ADR 0022 decision 7) they may spend per SPENDING_PERIOD_TICKS. */
  readonly spendingCap: Money;
  /** Whether they phone the family's numbers when something goes wrong (decision 7). */
  readonly callWhen: "NEVER" | "PROBLEMS";
}
```

`SPENDING_PERIOD_TICKS` is game-data (PLACEHOLDER 10 080: a week), and periods count from tick 0: `periodIndex = floor(t / SPENDING_PERIOD_TICKS)`.

`DISTILL_ORDER_DEFAULTS` (game-data, PLACEHOLDER) prefills the order form: `{ keepOnHand: 20, batchSize: 10, spendingCap: cents(30_000), callWhen: "PROBLEMS" }`. That's a week of the still's full output at basic moonshine's conversion cost, so the default cap doesn't throttle a Distiller who has corn. It's a UI convenience: the simulation reads only the terms in the command.

**Giving, changing or cancelling one:**

```ts
export interface SetStandingOrderCommand {
  readonly type: "SET_STANDING_ORDER";
  readonly characterId: CharacterId;
  /** null cancels: the employee stays on the books and idles. */
  readonly terms: StandingOrderTerms | null;
}
```

A new order always gets a new `StandingOrderId`, from the `StandingOrder` counter, with `givenAt = t`. The command's transaction is keyed `idempotencyKey("PERSONNEL", "ORDER", commandId)`, has no entries, and emits `STANDING_ORDER_SET`. Report lines name the order they acted under (decision 7). Setting an order clears `work.lastHold` and `work.lastRefusal`, so a hold that persists under the new order is reported again. `work.spending` carries over: the cap is per employee per period, whatever the order.

**The communication gate** (ADR 0022 decision 4, ADR 0024 decision 9's `Reach`). An order for employee E reaches them:

- **`IN_PERSON`:** the founder is `PRESENT` at E's station's location and `t ≥ E.startsAt`.
- **`PHONE`:** the founder is on a call (`call !== null`, `t ≤ busy.until`) to E's station's location, answered by `{ kind: "EMPLOYEE" }` (decision 7, "Calls out").
- Otherwise it doesn't, and the result is `NO_WAY_TO_REACH { characterId }`.

Every input is founder state, the station and `startsAt` (agreements) and the call, all always known.

**Time.** In person, `SET_STANDING_ORDER` and `DISMISS_EMPLOYEE` are timed: `ACTIVITY_DURATIONS` gains `BRIEF_EMPLOYEE` (PLACEHOLDER 15 min). On a call, they apply ADR 0024 decision 4's exemption: they pass the busy gate while `busy.activity === "PHONE_CALL"` and `Reach` is `PHONE`, they don't change `busy`, and they take the call's time. The order takes effect at once: the `employees` phase of the same tick (decision 10) uses it.

**What a Distiller may do: the authority gate** (ADR 0022 gate 4). A standing order of kind `DISTILL` authorises exactly one command: `START_PRODUCTION` with `facilityId` = the station, `recipeId` = the order's, `quantity ≤ batchSize`, and conversion cost ≤ `spendingCap − spending.spent` for the current period. Anything else is `OUTSIDE_AUTHORITY`:

```ts
type AuthorityLimit = "COMMAND" | "STATION" | "RECIPE" | "BATCH_SIZE" | "SPENDING_CAP";

// RejectionReason member (ADR 0022 names it; this record fixes the payload):
| { readonly code: "OUTSIDE_AUTHORITY"; readonly characterId: CharacterId; readonly standingOrderId: StandingOrderId; readonly limit: AuthorityLimit }
```

**What a Distiller may not do in M002:** buy materials (that needs presence at the supplier, and a runner is a later role), load or drive the truck (ADR 0026's Driver), change the workforce, or buy or sell equipment. Keeping `SET_WORKFORCE` out of every standing order is deliberate: it keeps the workforce, and so the wage bill, a founder agreement (decision 9).

### 6. The policy: what the Distiller does each tick

Employees act in a new **`employees` phase** (decision 10). For each employee in `characterId` order with `t ≥ startsAt` and a standing order, the policy reads only that employee's **`EmployeeView`** (ADR 0022 decision 2): the world at the station (`FACILITY_STOCK`, `FACILITY_OPERATIONS`, the facility's equipment, crew and storage), the cash balance (always known), and the employee's own state. For a `DISTILL` order with recipe R, product P and quality Q:

1. **A job is running at the station** (theirs or the founder's): do nothing.
2. **Enough on hand:** if the unreserved quantity of P at quality Q at the station is `≥ keepOnHand`, do nothing and set `lastHold = null`. That's the order being met, not a problem.
3. **Size the batch:** `q = min(batchSize, storage room, min over R's inputs of floor(available ÷ per case))`. If R's conversion cost per case `k` is above 0, also `q = min(q, floor(cash ÷ k), floor((spendingCap − spent) ÷ k))`.
4. **`q ≥ 1`:** issue `START_PRODUCTION { facilityId: station, recipeId: R, quantity: q }` with issuer `{ kind: "EMPLOYEE", characterId, standingOrderId }` through the gateway (below). If it applies: `currentJobId` is the new job, `spent += q × k`, `lastHold = null`, and a `BATCH_STARTED` line goes into the report.
5. **`q = 0`:** find the hold, the first that applies in this order:
   - `RECIPE_NOT_SUPPORTED`: the station no longer owns R's equipment (it was sold);
   - `NO_STORAGE`;
   - `NO_MATERIALS { materialId }`: the first of R's inputs, in recipe order, that's short;
   - `NO_CASH`;
   - `SPENDING_CAP`.

   If it differs from `lastHold`, write a `HELD_BACK` line and set `lastHold`. So a Distiller who runs out of corn says so once, not every minute.

```ts
export type HoldReason =
  | { readonly kind: "RECIPE_NOT_SUPPORTED" }
  | { readonly kind: "NO_STORAGE" }
  | { readonly kind: "NO_MATERIALS"; readonly materialId: MaterialId }
  | { readonly kind: "NO_CASH" }
  | { readonly kind: "SPENDING_CAP" };
```

At the start of each employee's step, if `periodIndex` has moved on, `spending` resets to `{ periodIndex, spent: 0 }`.

Sizing reads exactly what the gates read, so a command the policy issues passes them. The gates still run in full; they're the check, and the policy is the plan.

**Through the same gateway.** An employee command goes through the same handler and the same five gates as a founder's (ADR 0022 decision 1), with ADR 0022 decision 5's differences: presence is the station (`NOT_PRESENT { requiredLocationId: station's location, issuerLocationId: null }` before `startsAt`), communication passes (the standing order is already given), authority is checked against the order, and validation uses the `EmployeeView`.

- **No envelope, no command counters.** An employee command isn't a `CommandEnvelope`. It never takes a `CommandId` from `counters.nextId.Command` or a number from `nextCommandSequence`, and it's never in `commandLog` or `queuedCommands`. Replay re-derives it from state, because the policy is a deterministic function of state, so logging it would apply it twice. Minting from the founder's command counters would break exact replay: `KernelSimulation.replay` raises those counters as it places each logged envelope, ahead of the ticks in between. An employee command would then get a different ID in the replay than in the original run, and so would its events' `causedBy` and the state hash.
  - **Options considered:** a separate counter (`EmployeeAction`) that replay never touches (works, but adds a dynamic ID kind and widens `causedBy` for no reader); an identity derived from `(characterId, tick)` (works, but `causedBy` is typed `CommandId`); **no command identity (chosen)**.
  - The handler runs through an internal `applyIssued` path whose `CommandContext` carries `issuer: CommandIssuer` and `envelope: null`. That amends ADR 0022 decision 5, which put the `EMPLOYEE` issuer on the envelope. Handlers read the issuer from the context, never from an envelope.
  - Its transactions and events have `causedBy: null`, like phase-driven ones. For the lab and the debug view, the employee command's identity is its `EMPLOYEE_ACTED` event, `(characterId, standingOrderId, tick)`. That's unique, because an employee issues at most one command per tick.
  - Every ID it does mint (`ProductionJob`, `Reservation`, `Transaction`, `Event`) comes from counters that only tick processing advances, in the same order in the original run and in a replay.
  - **E1 acceptance test:** a founder-rules run with a working Distiller is replayed from its start state and `commandLog` through `replayJournal`. The run includes batches started and finished, a hold, and an order changed by the founder. The replay gives the same `stateHash` at the end and at every journaled tick.
- **No activity item.** `COMMAND` items are the founder's own commands (ADR 0021 decision 8). The founder hears about employee commands only through the report.
- **A rejection** (which the sizing rule should make impossible): the command changes nothing (architecture rule 6). The policy then writes an `ORDER_REFUSED` line only if the reason differs from `work.lastRefusal`, and sets `lastRefusal`, exactly as holds use `lastHold`. So a stuck order is reported once, not every tick, even while the founder stands at the still and the report is cleared every tick. An applied command clears `lastRefusal`. A rejection is never shown at once (ADR 0022 decision 5).
- It emits a world event `EMPLOYEE_ACTED { characterId, standingOrderId, command, status: "APPLIED" | "REJECTED", reason: RejectionReason | null }` for the lab and debug view.
- **ADR 0022's test applies:** for every employee command applied, the same command validated by a founder present at that place, with gates 1 and 5 only, also applies.

**What the batch looks like** (amends ADR 0017 decision 1 for employee jobs):

- **Setting up takes time,** as it does for the founder: `startedAt = t + ACTIVITY_DURATIONS.START_BATCH` (ADR 0023 decision 4). Employees aren't tired, so `TIRED_DURATION_PPM` doesn't apply.
- **Competence sets the pace.** The duration ADR 0017 computes is multiplied by `competencePpm / 1 000 000`, rounded up, where `competencePpm = atZero + (atHundred − atZero) × competence / 100` (integer, floor) from `COMPETENCE_DURATION_PPM` (game-data, PLACEHOLDER `{ atZero: 1 400 000, atHundred: 800 000 }`). A middling Distiller (50) takes 10% longer than the founder would; a very good one (100) is 20% quicker; a poor one (0) takes 40% longer. Jobs the founder starts are unchanged.
- **Paid at start:** the conversion cost is prepaid in cash (ADR 0022 decision 7). The key is `idempotencyKey("PRODUCTION_START", "EMPLOYEE", jobId)`, so it's its own producer (decision 12).

**Options considered for competence's effect:** failure chance (rejected: every shipped recipe has `failureChance: 0`, so it would do nothing until tuned, and it would add draws); quality (rejected for M002: a recipe fixes its quality, and making it depend on a person needs new rules. GDD §21 says "output and quality", and quality is left for later); **duration (chosen)**. It's visible, deterministic, and it's what the founder pays for.

**Production failure draws become keyed** (amends ADR 0022 decision 8). With an employee running batches the founder doesn't see, any recipe with `failureChance > 0` would make the shared `rng.production` stream depend on hidden activity: the number of draws before the founder's own job would differ. With `founderRules: true`, a job's failure draw is `nextInt(keyedRng(seed, "production:<facilityId>", job.startedAt), RATIO_SCALE)`. A facility runs one job at a time, so `(facilityId, startedAt)` names a job uniquely, and `startedAt` of the founder's own job is fixed by the founder's command. With `founderRules: false`, `rng.production` is used as today. No shipped recipe can fail, so nothing changes in practice yet.

**When the batch finishes.** The production phase, when it settles a job that is some employee's `currentJobId`, writes a `BATCH_FINISHED` line (with `outcome: "COMPLETED" | "FAILED"`), adds 1 to `batchesRun`, and clears `currentJobId`. The job's postings are unchanged: completion is a non-cash posting learned through `FACILITY_STOCK` (ADR 0022 decision 7, ADR 0021 decision 7).

### 7. Reports: how the founder finds out

**What's waiting** (`packages/contracts/src/knowledge.ts`, beside messages, because messages carry reports too):

```ts
export type ReportLine =
  | { readonly kind: "BATCH_STARTED"; readonly tick: Tick; readonly standingOrderId: StandingOrderId;
      readonly recipeId: RecipeId; readonly quantity: number; readonly conversionCost: Money }
  | { readonly kind: "BATCH_FINISHED"; readonly tick: Tick; readonly recipeId: RecipeId;
      readonly quantity: number; readonly outcome: "COMPLETED" | "FAILED" }
  | { readonly kind: "HELD_BACK"; readonly tick: Tick; readonly standingOrderId: StandingOrderId; readonly hold: HoldReason }
  | { readonly kind: "ORDER_REFUSED"; readonly tick: Tick; readonly standingOrderId: StandingOrderId;
      readonly command: GameCommand; readonly reason: RejectionReason };

/** EmployeeState.report: what an employee will tell the founder next. */
export interface PendingReport {
  /** Oldest first, at most REPORT_LINE_LIMIT (game-data, PLACEHOLDER 20); older lines drop and are counted. */
  readonly lines: readonly ReportLine[];
  readonly dropped: number;
  /** A problem line (HELD_BACK, ORDER_REFUSED, BATCH_FINISHED FAILED) arrived under callWhen PROBLEMS, and no report has gone out since. */
  readonly callPending: boolean;
}

/** A report as delivered. */
export interface ReportContent {
  readonly characterId: CharacterId;
  readonly lines: readonly ReportLine[];
  readonly dropped: number;
}
```

`HoldReason` lives in `knowledge.ts` too, and `state.ts` imports it, as it imports `KnowledgeState`.

**What a report reveals: the `REPORT` rows** (ADR 0021 decision 6 asked for them):

| Source | Party | Reveals |
|---|---|---|
| `REPORT` | Facility | The station's **facility-party subjects**: `FACILITY_STOCK` and `FACILITY_OPERATIONS` of the station, and `EMPLOYEE_PERFORMANCE` of each employee stationed there |
| `REPORT` | Supplier, Buyer | Nothing in M002 (ADR 0026 adds rows for the Driver) |

A report also **delivers the station's pending news** (ADR 0021 decision 7: "another channel covering the place delivers the news"). A Distiller tells you the batch failed or a load was seized on the road from the still. Delivering it clears the station's `NEWS` concerns from `pendingBooks`, and values written by a report clear the `pendingBooks` entries for their subjects, as for any channel.

A report never reveals `STANDING`, `ROUTE_CONDITION` or anything about buyers, so ADR 0021's `BUYER_WANTS` ⇒ `STANDING` pairing holds trivially.

**Delivering a report** always does the same thing, whichever channel:

- writes the revealed values as records (source below), clearing books as above;
- delivers the station's pending news;
- writes one `REPORT { tick, characterId, via, report: ReportContent }` activity item, if there are lines or a dropped count;
- clears the employee's `report` (`lines: [], dropped: 0, callPending: false`);
- emits `REPORT_DELIVERED { characterId, via, lineCount, dropped }`.

An empty report with no news delivers nothing, writes nothing and emits nothing.

**The channels:**

| Channel | When | Values' source | Transaction |
|---|---|---|---|
| **In person** | On arrival or waking at the station (founder phase, same step as ADR 0021's catch-up); on an early `WAKE` at the station, inside the `WAKE` transaction with its catch-up (ADR 0023 decision 7); and at the end of each tick's `employees` phase while the founder is `PRESENT` at the station | The live view already shows the values (`IN_PERSON`); the delivery adds the lines and news | Inside `WAKE` for an early wake; otherwise `PERSONNEL:REPORT:<characterId>:<tick>:IN_PERSON`, no entries |
| **Calls out** (the founder calls the station) | Inside the `PLACE_CALL` transaction when the call is answered by an employee stationed there; then at the end of each `employees` phase while that call is connected | The call view (`PHONE`, ADR 0024 decision 4) | Inside `PLACE_CALL`; afterwards `PERSONNEL:REPORT:<characterId>:<tick>:CALL_OUT`, no entries |
| **Calls in** (the employee calls the founder) | In the `phones` phase, as below | `REPORT { characterId }`, `learnedAt = t` | ADR 0024's entry-less `TELEPHONE:IN` |
| **As a message** | The employee's call in is taken by an attendant (below), and the message is delivered later (ADR 0024 decision 6) | `MESSAGE { takenAtLocationId, takenBy }`, `learnedAt = takenAt`, under ADR 0024's "older never overwrites newer" rule | ADR 0024's |

`via` is `"IN_PERSON" | "CALL_OUT" | "CALL_IN"`. A report delivered in a message comes through ADR 0024's `MESSAGE_DELIVERED` item, whose `DeliveredMessage` carries it (below).

**The invariant:** at the end of any tick at which an order can reach employee E (`Reach` is `IN_PERSON` or `PHONE`), E's pending report is empty. Lines are only written in the `production` and `employees` phases, and the in-person and call deliveries run after them in the same tick. Arrival happens in the `founder` phase, after both. So when the founder gives an order or dismisses someone, they've heard everything first.

**Calls out: who answers the still's phone** (amends ADR 0024 decisions 3 and 9). The **call-out attendant hook** before E3 isn't null for every line. From E1, it returns the employee with role `DISTILLER` stationed at the facility at L with `startsAt ≤ t`, first by `characterId`, or null. That reads only agreements, which ADR 0024's hook type requires. The Distiller lives at the still and answers day and night (PLACEHOLDER, story). ADR 0026 extends the hook for the Office Hand and decides who takes precedence. A call answered this way:

- reveals the `PHONE` row for `FACILITY`, which this record fills with the same facility-party subjects as `REPORT`: what someone at the still can tell you over the line;
- delivers that employee's report and, with it, the station's pending news. This amends ADR 0024's "calls don't deliver pending news": a call doesn't, but the report it carries does;
- is a `Reach = "PHONE"` context for `SET_STANDING_ORDER` and `DISMISS_EMPLOYEE` to that employee (decision 5).

The **call-in attendant hook** is unchanged by this record. A Distiller doesn't take messages for the family: answering the phone for the business is the Office Hand's job (GDD §21), and that's what makes the Office Hand worth hiring.

**Calls in: an employee phones the founder** (fills ADR 0024 decision 5's "employees calling in"):

- **Trigger:** the standing order's `callWhen` is `PROBLEMS`, `report.callPending` is true, and the station has a family line.
- **Common conditions,** ADR 0024's plus one:
  - the founder isn't `PRESENT` at the station and isn't on a call with it;
  - the founder isn't `RESTING` at the station's location. They're asleep in the next room, so the Distiller tells them when they wake, rather than phoning a message to the store;
  - the family has a number other than the station.
- **When:** on window ticks (`tick % CALL_IN_INTERVAL_TICKS === 0`), in the `phones` phase, after the parties' rules, in `characterId` order.
- **No draw.** Employees are reliable in M002 (reliability is inert, decision 11): if the trigger holds, they call.
- **Numbers and answering order** are ADR 0024's: the founder first, if present at a family number; then the other numbers in `compareIds` order, skipping engaged lines; else it rings out.
- **Outcomes:**
  - **The founder answers:** the report is delivered (`via: "CALL_IN"`, source `REPORT`), and ADR 0024's `CALL_RECEIVED` item is written with `reason: "EMPLOYEE_REPORT"`. As with every call in, it isn't an order context: to change the order, the founder calls back.
  - **A message is taken** at another family number: the report moves into a `HeldMessage` (below), and the employee's `report` is cleared.
  - **Rings out:** nothing changes. They try again next window.
- **Transaction:** ADR 0024's entry-less `TELEPHONE:IN`, keyed `idempotencyKey("TELEPHONE", "IN", stationLocationId, "EMPLOYEE_REPORT", windowIndex, characterId)`. The trailing `characterId` keeps two employees at one place apart (ADR 0026).
- **Cost:** employees' calls are free in M002 (PLACEHOLDER: the family's own line, a local call). That keeps the call in entry-less, so it never posts cash without a founder command.

**Reports as messages** (amends ADR 0024 decision 6):

- `CallInReason` gains `"EMPLOYEE_REPORT"`.
- `HeldMessage` and `DeliveredMessage` gain `report: ReportContent | null`, non-null exactly when `reason === "EMPLOYEE_REPORT"`.
- `HeldMessage.values` are the `MESSAGE` row for `FACILITY`, which this record fills with the same facility-party subjects, copied at `takenAt`.
- **Replacing a message:** for reason `EMPLOYEE_REPORT`, "the same caller" in ADR 0024's replacement rule means the same `callerLocationId` **and** the same `report.characterId`, so reports from two employees at one station (ADR 0026) never merge. When a newer report message replaces an older one at the same place, the new message's `report.lines` are the older message's lines followed by the new ones, capped at `REPORT_LINE_LIMIT` with the overflow added to `dropped`. Report lines are a log, so replacing them would lose what the employee said.
- Messages don't carry the station's pending news. That still waits for a visit, a call answered there, or a report delivered directly.

**In M002, practically:** the founder gets reports by going to the still, and by calling the still from a public phone once the still has a line. A Distiller calling in needs a second family number: another family line, or a public phone that `holdsMessages` (all false in ADR 0024's PLACEHOLDER table). The mechanism is complete, and it comes alive when the human places such a phone (*Needs design*).

### 8. Learning the real competence: `EMPLOYEE_PERFORMANCE`

"You learn the real value by working with them" (GDD §21) becomes a knowledge subject (amends ADR 0021 decision 4):

```ts
// SUBJECT_KINDS gains "EMPLOYEE_PERFORMANCE", appended last so existing records keep their order and hash.
| { readonly kind: "EMPLOYEE_PERFORMANCE"; readonly characterId: CharacterId }       // KnowledgeSubject

| { readonly kind: "EMPLOYEE_PERFORMANCE"; readonly characterId: CharacterId;        // KnowledgeValue
    readonly batchesRun: number;
    /** The true competence, once batchesRun (over every stint) ≥ COMPETENCE_REVEAL_BATCHES (game-data, PLACEHOLDER 1); null before. */
    readonly competence: number | null }
```

`knowledgeSubjectKey` returns `characterId` for it.

- **It belongs to the station** (a facility-party subject, decision 7): it's in the live view at the station (`IN_PERSON.FACILITY` gains it), in a call answered there, and in reports and report messages.
- **Before the reveal,** the founder still sees the work: `FACILITY_OPERATIONS` shows a running job's `startedAt` and `completesAt`. The reveal turns that into a number the UI can show beside the estimate ("Walt: 55; you guessed 40–70").
- **A dismissed employee's record is kept,** stale, like any record. **A re-hire keeps what was learned:** `batchesRun` counts every stint, carried through `GameState.formerEmployees` (decisions 1 and 4). So the first visit after a re-hire writes the same or a higher `batchesRun`, with the same non-null `competence`, and the founder never "forgets" a revealed competence.
- No transaction concerns it, so it needs no `pendingBooks` row.

### 9. Wages and ADR 0021 rule 1 (the #172 follow-up)

With `founderRules: true`, `dailyWagesDue` becomes: the `FOUNDER` entry's `dailyWage` + Σ `employees[].dailyWage` + Σ `facilities[].workerCount × workerDailyWage`, as they stand when the `midnight` phase runs. That's the same "as it stands at midnight" rule `SET_WORKFORCE` already follows. An employee hired on the midnight tick counts, and one dismissed on it doesn't. With `founderRules: false`, it's Σ `data.characters[].dailyWage` + workers, exactly as today.

**Rule 1 still holds for `DAILY_SETTLEMENT:WAGES`:** the amount depends only on agreements the founder made, because in M002:

- `employees` and their `dailyWage` change only by `HIRE_EMPLOYEE` and `DISMISS_EMPLOYEE`, which are founder commands;
- `workerCount` changes only by `SET_WORKFORCE`, a founder command, and **no standing order may issue it** (decision 5);
- there's **no attrition, quitting or raise** in M002: reliability and loyalty are inert (decision 11).

So `TRANSACTION_PRODUCERS["DAILY_SETTLEMENT:WAGES"]` stays `AGREED_CHARGE`, and ADR 0021 decision 6's wages row is unchanged. **Any later rule that lets the wage bill change without a founder command** (an employee quitting, asking for a raise, a standing order that hires) must move that change's effect out of rule 1, or deliver the change to the founder first through a channel.

### 10. Tick order

`PHASES` becomes `production, employees, vehicles, [world events], resolution, founder, phones, deadlines, midnight` (amends ADR 0023 decision 2a and ADR 0024 decision 8), followed by ADR 0021's persist step.

- **Commands** (first in the tick): `HIRE_EMPLOYEE`, `SET_STANDING_ORDER` and `DISMISS_EMPLOYEE` apply here, under the busy rules in decision 5. A founder's `START_PRODUCTION` at the station applies here too, so it always comes before the Distiller's: the Distiller then finds a job running and waits.
- **`production`:** settles due jobs; writes `BATCH_FINISHED` lines for employees' jobs (decision 6).
- **`employees` (new):**
  1. Each employee's policy step, in `characterId` order (decision 6).
  2. Deliveries, in `characterId` order: in person, if the founder is `PRESENT` at the station; or on a call, if a call answered by that employee is connected (decision 7).

  It runs right after `production`, so a still whose batch finished this tick is restarted on the same tick, with no idle minute.
- **`founder`:** arrivals and wakings at a station deliver the report in the catch-up step (decision 7).
  - A departure in this phase (the truck leaving when loading ends) persists a live view that already includes anything the Distiller did this tick, because they did it while the founder was still there.
  - A `TRAVEL` or `REST` applied in the command step persists the live view before the `employees` phase, so that tick's lines stay pending until the next channel.

  Nothing leaks either way.
- **`phones`:** employees' calls in, after the parties' rules (decision 7).
- **`midnight`:** wages count the employees on the books (decision 9).

**Same tick as the end of a founder activity** (ADR 0023 decision 2a). Employees never read `busy` and never change founder state, so nothing races the founder phase:

- **Loading at the still ends at `u`:** the Distiller's step at `u` runs while the founder is still `PRESENT`. Its report line is delivered at the end of `employees`, and the departure in `founder` at `u` persists a live view that includes it.
- **Arrival at the still at `u`:** the step at `u` ran before the arrival, so its lines are pending, and the arrival delivers them with the catch-up.
- **`BRIEF_EMPLOYEE` or `HIRE` ending at `u`:** the order (or hire) took effect when the command applied. The end of the busy changes nothing for the employee.
- **A hire's `startsAt`:** the employee's first step is in the `employees` phase of tick `startsAt`.

**No-trap bound (ADR 0023 decision 8).** `HIRE` and `BRIEF_EMPLOYEE` are `ACTIVITY_DURATIONS` rows, so the bound's "longest `ACTIVITY_DURATIONS` × `TIRED_DURATION_PPM`" covers them. Employees never make the founder busy. `REST` is never refused for anything employee-related.

### 11. Reliability and loyalty: reserved, inert

`CandidateDefinition` and `EmployeeState` carry `reliability` and `loyalty` (0–100), copied from game-data at hire. In M002:

- no rule, policy, draw, projection or formula reads them;
- the player snapshot doesn't show them. They're hidden traits, not agreements, and the founder isn't given an estimate of them;
- the world snapshot shows them (debug), as `CharacterSnapshot.loyalty` does today.

E1 adds a test, after `prod-001-labor.locked.test.ts`'s "skill and loyalty have no mechanical effect": two games whose employees differ only in `reliability` and `loyalty` give the same state hash after the same commands, once those two fields are blanked. Later milestones give them effects through the `REPORT` source (unreliable reports, skimming), as GDD §21 and ADR 0021's Consequences anticipate. Those records must revisit decision 9.

### 12. Coverage: producers and what each reveals

| Producer (idempotency-key family) | Entries | Classification |
|---|---|---|
| `PERSONNEL:HIRE` | Dr `WAGES_EXPENSE` / Cr `CASH` at the signing cost; none at cost 0 | Rule 1: the founder's command |
| `PERSONNEL:ORDER` (`SET_STANDING_ORDER`) | None | Rule 1 |
| `PERSONNEL:DISMISS` | None | Rule 1 |
| `PERSONNEL:REPORT` | None, ever | Rule 4: never in the books |
| `PRODUCTION_START:EMPLOYEE` | Dr `PRODUCTION_IN_PROGRESS` / Cr `CASH` (conversion cost); none for a zero-cost recipe. Never a non-cash leg: the gate rejects when cash is below the cost, so it never accrues | **World, with a cash leg: a row in ADR 0021 decision 6's cash-posting table** |
| `PRODUCTION`, `PRODUCTION_WRITE_OFF` of an employee's job | Unchanged (ADR 0022 decision 7) | Existing rows: non-cash, concerning `FACILITY_STOCK` |
| `TELEPHONE:IN` for `EMPLOYEE_REPORT` | None | ADR 0024's family, rule 4 |
| `DAILY_SETTLEMENT:WAGES` | Unchanged | Still `AGREED_CHARGE` (decision 9) |

**The new cash-posting row** (ADR 0021 decision 6):

| Posting | Kind | Reveals |
|---|---|---|
| An employee starts a batch: conversion cost prepaid (`PRODUCTION_START:EMPLOYEE`) | `PRODUCTION_START` | **Nothing beyond the posting itself.** The activity item shows the producer and the cash change, so the founder knows money went on a batch at a still. Stock and operations at the still wait for a report or a visit. `CASH_POSTING_REVEALS["PRODUCTION_START:EMPLOYEE"] = { subjects: [], news: "NONE" }` |

This is ADR 0022 decision 5's "employee spending is a cash posting and known". The posting is the narrowest channel that keeps the purse true, and it leaves GDD §21's "your ledger changes only when a report reaches you" true for everything but cash.

K1's registry (`packages/contracts/src/knowledge.ts`) gains:

```ts
"PERSONNEL:HIRE": { trigger: "FOUNDER_COMMAND", legs: ["CASH", "NO_ENTRIES"] },
"PERSONNEL:ORDER": { trigger: "FOUNDER_COMMAND", legs: ["NO_ENTRIES"] },
"PERSONNEL:DISMISS": { trigger: "FOUNDER_COMMAND", legs: ["NO_ENTRIES"] },
"PERSONNEL:REPORT": { trigger: "WORLD", legs: ["NO_ENTRIES"] },
"PRODUCTION_START:EMPLOYEE": { trigger: "WORLD", legs: ["CASH", "NO_ENTRIES"] },
```

`transactionProducerOf` resolves `PERSONNEL:REPORT:walt-hagen:1234:IN_PERSON` to `PERSONNEL:REPORT` (the longest registered family of its constant tags), and `PRODUCTION_START:EMPLOYEE:job-7` to `PRODUCTION_START:EMPLOYEE`, separate from the founder's `PRODUCTION_START` (O1b's). No producer here can post a non-cash leg without a founder command, so ADR 0021 decision 7's table gains no row.

### 13. Flag off (`founderRules: false`)

- **`HIRE_EMPLOYEE`, `SET_STANDING_ORDER` and `DISMISS_EMPLOYEE` apply as no-ops,** as ADR 0023 decision 9 does for `TRAVEL`: accepted, no domain state changed, no transaction. Their envelopes still go into `commandLog`. Lab strategies don't send them.
- **`employees` and `formerEmployees` stay empty,** the `employees` phase does nothing, and no employee calls in.
- **Leaders and wages are `data.characters`** (decisions 1 and 9): Walt is the static foreman, paid $3.00 a day, as in M001.
- **Production failure draws use `rng.production`** (decision 6).
- **No keyed draw runs:** the slate is only computed for a player snapshot at a hiring place under founder rules.

So M001 and the lab play exactly as before. The new `employees` and `formerEmployees` fields and the `StandingOrder` counter move the state hashes, and the contract task regenerates the fixtures and the Sprint Zero reference hash (the unlocked `test/sprint-zero/reference-hash.ts`), as K1 and its successors do.

### 14. Saves (ADR 0009)

The required fields `GameState.employees` and `GameState.formerEmployees`, the counter `counters.nextId.StandingOrder`, and `HeldMessage.report` and `DeliveredMessage.report` bump `SAVE_SCHEMA_VERSION`: the next version after ADR 0024's contract task (v7 if the K1 → P1 → O1a → O1b → ADR 0024 sequence holds). The migration reads only the save's own fields and never game-data:

| New field | Value | Source |
|---|---|---|
| `employees` | `[]` | None needed: no earlier save can hold an employee (no command could hire) |
| `counters.nextId.StandingOrder` | `1` | None needed: no earlier save holds a standing order; counters start at 1 (`new-game.ts`) |
| `formerEmployees` | `[]` | None needed: no earlier save can have dismissed an employee |
| `knowledge.pendingMessages[].items[].report` | `null` | The message's own `reason`: no earlier save can hold an `EMPLOYEE_REPORT` message, because the reason didn't exist |
| `knowledge.activity[i].message.report`, for every item with `kind === "MESSAGE_DELIVERED"` | `null` | The item's own `message.reason`: no earlier save can hold a delivered `EMPLOYEE_REPORT` message. `DeliveredMessage` is saved inside `knowledge.activity` (ADR 0024 decision 15) |

**Fields that don't change:** `knowledge.records` (no earlier save holds an `EMPLOYEE_PERFORMANCE` record, and appending the kind last to `SUBJECT_KINDS` keeps every existing record's sort position); `ProductionJobState` (decision 6 tracks an employee's job on the employee, not the job); `CatchUp`. `CommandEnvelope.issuer`: only `FOUNDER` is ever stored (decision 6). New union members (commands, events, rejection reasons, `ActivityKind`, `ActivityItem`, `CallInReason`, `TransactionKind`) are additive, so existing saves satisfy them (ADR 0009). `ScenarioDefinition.firstCandidates` is game-data, not saved. The task adds the old-version fixture save and migration test, as K1 and its successors do.

### 15. Rejection reasons

`HIRE_EMPLOYEE`, in ADR 0022 §1's gate order, table order within a gate:

| Gate | Failure | Reason |
|---|---|---|
| 1 | `dailyWage` isn't a non-negative safe integer; order terms out of shape (`batchSize` < 1, `keepOnHand` < 0, `spendingCap` < 0, not safe integers) | `INVALID_QUANTITY { field, value }` (existing) |
| 1 | `characterId` isn't in `CANDIDATE_POOL` | `UNKNOWN_ENTITY { kind: "Character", id }` (existing) |
| 1 | `stationId` isn't a family facility | `UNKNOWN_ENTITY { kind: "Facility", id }` |
| 1 | The order's `recipeId` isn't a recipe | `UNKNOWN_ENTITY { kind: "Recipe", id }` |
| 2 | Not `PRESENT` at a hiring place for the role | `NOT_PRESENT { requiredLocationId, issuerLocationId }` (ADR 0022): `requiredLocationId` is the role's first `HIRING_PLACES` entry by `compareIds` |
| 2 | Busy | `FOUNDER_BUSY { until }` (ADR 0022) |
| 2 | The hiring place is closed | `PLACE_CLOSED { locationId, opensAt }` (ADR 0022) |
| 5 | Not on the role's current slate (including someone already employed) | **`CANDIDATE_UNAVAILABLE { characterId }`** (new) |
| 5 | On the slate, at a different asking wage | **`CANDIDATE_TERMS_CHANGED { characterId, agreed, current }`** (new) |
| 5 | The station can't host the role (a Distiller at a facility without recipe equipment) | **`STATION_UNSUITABLE { facilityId, role }`** (new) |
| 5 | The station already has someone in that role | **`POSITION_FILLED { facilityId, role }`** (new) |
| 5 | The order's recipe isn't supported at the station | `RECIPE_NOT_SUPPORTED { facilityId, recipeId }` (existing) |
| 5 | Cash below the signing cost | `INSUFFICIENT_FUNDS { required, available }` (existing) |

`SET_STANDING_ORDER` and `DISMISS_EMPLOYEE`:

| Gate | Failure | Reason |
|---|---|---|
| 1 | Order terms out of shape (`SET_STANDING_ORDER`) | `INVALID_QUANTITY` |
| 1 | `characterId` isn't an employee | `UNKNOWN_ENTITY { kind: "Character", id }` |
| 1 | The order's `recipeId` isn't a recipe | `UNKNOWN_ENTITY { kind: "Recipe", id }` |
| 2 | `PRESENT` at the station and busy (a call to the station from there is impossible: `ALREADY_THERE`) | `FOUNDER_BUSY { until }` |
| 3 | `Reach` is null (decision 5), including before `startsAt` | `NO_WAY_TO_REACH { characterId }` (ADR 0022) |
| 5 | The recipe isn't supported at the station (`SET_STANDING_ORDER`) | `RECIPE_NOT_SUPPORTED` |

Employee commands (`START_PRODUCTION` under a standing order) use ADR 0022's gates, with `OUTSIDE_AUTHORITY { characterId, standingOrderId, limit }` at gate 4 (decision 5). Any rejection is a report line, never an immediate result.

Every new payload is always-known or in the founder's view: the candidate's ID and the slate's wage (shown in person), the founder's own facilities and their equipment (agreements), and the role.

### 16. Contract changes (their own task)

One contract-change task, filed when this ADR merges, after ADR 0024's in the contract sequence (it shares `state.ts`, `commands.ts`, `events.ts`, `knowledge.ts`, `schemas.ts`, `save.ts` and the hash fixtures):

- `ids.ts`: `"StandingOrder"` in `IdKind` and `DYNAMIC_ID_KINDS`, prefix `"standing"`; `StandingOrderId`.
- `state.ts`: `EmployeeRole`, `CompetenceEstimate`, `EmployeeState`, `EmployeeWork`, `StandingOrderState`, `StandingOrderTerms`, `DistillOrderTerms`; `GameState.employees` and `GameState.formerEmployees`; `ActivityKind` gains `HIRE` and `BRIEF_EMPLOYEE`.
- `commands.ts`:
  - `HireEmployeeCommand`, `SetStandingOrderCommand`, `DismissEmployeeCommand` (types, `GameCommand`, `GAME_COMMAND_TYPES`);
  - `CommandIssuer = { kind: "FOUNDER" } | { kind: "EMPLOYEE"; characterId: CharacterId; standingOrderId: StandingOrderId }`, exported for the simulation's `CommandContext.issuer` and for `EMPLOYEE_ACTED`. `CommandEnvelope.issuer` stays `{ kind: "FOUNDER" }` (O1a's shape), because employee commands have no envelope (decision 6, amending ADR 0022 decision 5). `causedBy` keeps its type `CommandId | null`;
  - the reasons `CANDIDATE_UNAVAILABLE { characterId }`, `CANDIDATE_TERMS_CHANGED { characterId, agreed, current }`, `STATION_UNSUITABLE { facilityId, role }`, `POSITION_FILLED { facilityId, role }`;
  - `OUTSIDE_AUTHORITY`'s payload with `AuthorityLimit` (added here if O1a hasn't, finalised here if it has).
- `events.ts`: `EMPLOYEE_HIRED { characterId, role, stationId, dailyWage, signingCost, startsAt, transactionId }`, `STANDING_ORDER_SET { characterId, standingOrderId: StandingOrderId | null, terms: StandingOrderTerms | null, transactionId }`, `EMPLOYEE_DISMISSED { characterId, transactionId }`, `EMPLOYEE_ACTED { characterId, standingOrderId, command, status, reason }` (with `causedBy: null`; it's the employee command's identity, decision 6), `REPORT_DELIVERED { characterId, via, lineCount, dropped }`. All `null` in `EVENT_CONCERNS_PLACE`: they never become news. The task finalises the payloads, using these fields at least.
- `ledger.ts`: `TransactionKind` `PERSONNEL`, cash-flow default `WAGES` (`projection/finance.ts`'s `CASH_FLOW_CATEGORY` is E1's).
- `knowledge.ts`:
  - `SUBJECT_KINDS` appends `EMPLOYEE_PERFORMANCE`; its `KnowledgeSubject` and `KnowledgeValue` members; `knowledgeSubjectKey`;
  - `HoldReason`, `ReportLine`, `PendingReport`, `ReportContent`;
  - `ActivityItem` gains `REPORT { tick, characterId, via: "IN_PERSON" | "CALL_OUT" | "CALL_IN", report: ReportContent }`;
  - `CallInReason` gains `EMPLOYEE_REPORT`; `HeldMessage.report` and `DeliveredMessage.report` (decision 7);
  - `TRANSACTION_PRODUCERS` gains the five families, and `CASH_POSTING_REVEALS` gains `PRODUCTION_START:EMPLOYEE` (decision 12).
- `player-snapshot.ts`: `PlayerEmployee`, `PlayerHiring`, `PlayerCandidate`; `PlayerSnapshot.employees` and `.hiring`.
- `snapshot.ts` (world): `CharacterSnapshot.role` widens to `"FOUNDER" | "FOREMAN" | EmployeeRole` (an employee leader shows `skill` = true competence); `GameSnapshot.employees: readonly EmployeeSnapshot[]` (`EmployeeState` plus `name`), for the lab and the debug view.
- `schemas.ts`, `save.ts`: Zod for all of the above; the bump and migration in decision 14, with an old-version fixture.
- `packages/game-data`:
  - `personnel.ts`: `CandidateDefinition`, `CANDIDATE_POOL`, `HiringPlaceDefinition`, `HIRING_PLACES`, `RoleTerms`, `ROLE_TERMS`, `CANDIDATE_SLATE_TICKS`, `SPENDING_PERIOD_TICKS`, `DISTILL_ORDER_DEFAULTS`, `COMPETENCE_DURATION_PPM`, `COMPETENCE_REVEAL_BATCHES`, `REPORT_LINE_LIMIT`, with the load validation in decisions 1 and 3; `GameData` gains them;
  - `scenario.ts`: `ScenarioDefinition.firstCandidates` (M001 `[]`; the M002 scenario `["walt-hagen"]`);
  - `knowledge.ts`: `KNOWLEDGE_VISIBILITY` rows `IN_PERSON.FACILITY` + `EMPLOYEE_PERFORMANCE`, and `PHONE.FACILITY`, `MESSAGE.FACILITY` and `REPORT.FACILITY` = `FACILITY_STOCK`, `FACILITY_OPERATIONS`, `EMPLOYEE_PERFORMANCE`;
  - `ACTIVITY_DURATIONS` rows `HIRE` (60) and `BRIEF_EMPLOYEE` (15); `ACTIVITY_IMPORTANCE`: `REPORT` is `notify` (PLACEHOLDER).
- `packages/simulation/src/kernel/registry.ts` and `simulation.ts`: `employees` in `PHASES` between `production` and `vehicles`; `CommandContext` gains `issuer: CommandIssuer`, and its `envelope` becomes `CommandEnvelope | null` (decision 6). Its hooks and `applyIssued` are E1's.
- `IssuerView`'s `EmployeeView` (simulation-internal, named here so the review can check it): the station's world subjects, its equipment, crew and storage, the cash balance, and the employee's own `EmployeeState`.

E1 (#180) implements the behaviour: the commands, the slate, the policy and the `employees` phase, competence timing, keyed failure draws under founder rules, report delivery on every channel, the call-out hook's Distiller case, employees' calls in, the wage rule, the projections, and the producer coverage rows. R1 (#176) uses the numbers in decision 17.

### 17. What R1 needs: the first hire is reachable

GDD §16 rule 1 and R1 (#176): from the starting position, a founder playing sensibly can afford a first hire without a soft-lock. The numbers, all PLACEHOLDER game-data that R1 tunes:

| Number | Value | Where |
|---|---|---|
| Distiller asking wage | $3.00–$6.00 a day, by estimate (decision 3) | `ROLE_TERMS.DISTILLER.dailyWage` |
| Signing cost | $25.00, cash at hire | `ROLE_TERMS.DISTILLER.signingCost` |
| Competence | Walt 55 (fixed); others drawn from their ranges, 20–90 | `CANDIDATE_POOL` |
| Estimate spread | 30 points | `ROLE_TERMS.DISTILLER.estimateSpread` |
| Slate | 2 candidates, a new slate every 3 days; Walt on the first | `slateSize`, `CANDIDATE_SLATE_TICKS`, `firstCandidates` |
| Where | The general store (Miller's Feed & Seed), during its hours | `HIRING_PLACES` |
| Time to hire | 60 min; at the still 2 h later | `ACTIVITY_DURATIONS.HIRE`, `reportingDelayTicks` |
| Briefing | 15 min in person, or on a call | `ACTIVITY_DURATIONS.BRIEF_EMPLOYEE` |
| Pace | 1.4× (competence 0) to 0.8× (competence 100) of the founder's batch time | `COMPETENCE_DURATION_PPM` |
| Spending period | 7 days | `SPENDING_PERIOD_TICKS` |
| Order form defaults | keep 20 on hand, batches of 10, cap $300 a week, phone about problems | `DISTILL_ORDER_DEFAULTS` |

**What R1 checks against them:**

- A hire is **possible** at tick `t` when the founder is `PRESENT` at an open hiring place, the role's slate shows a candidate (with no one employed every slate is full, and the first one has Walt), and cash ≥ the signing cost.
- It's **sustainable** when the still's margin under a Distiller covers their wage plus the existing wage and overhead bill. That's the rule-1 reachability property: from the start, a scripted sensible founder (and a property-based family of them) reaches such a `t` without a soft-lock.
- A sensible founder doesn't need a phone for any of this: the Distiller works and reports without one.
- At M001's starting cash ($1,000) the hire itself is trivially affordable. The pressure is the daily wage against the still's margin, plus the founder's time. R1 retunes the M002 starting cash, wages and signing cost together; M001's balance isn't assumed to hold (milestone doc).

## Design-record checklist (factory.md §1)

### 1. Non-leak, per command and surface

The inputs to every surface below are always-known state (founder whereabouts including `busy` and `call`, cash, agreements including employees' agreed fields and standing orders, geography including `HIRING_PLACES` and `PLACE_HOURS`), knowledge, the live and call views, the slate (a function of the seed, the tick, game-data and the employees on the books), or a channel.

| Command or event | Immediate result | Activity item | Catch-up | Books row | Snapshot field |
|---|---|---|---|---|---|
| `HIRE_EMPLOYEE` | Reasons in decision 15: founder state, hours, the slate, family facilities and their equipment (agreements), cash | `COMMAND` (inputs only) | None | `PERSONNEL:HIRE`, rule 1 | `employees` (agreements); `hiring` |
| `SET_STANDING_ORDER` | Reasons in decision 15: employees (agreements), founder state, the call, station equipment. Never reads stock | `COMMAND` | None | Entry-less; never in books | `employees[].standingOrder` |
| `DISMISS_EMPLOYEE` | As above | `COMMAND`; a `REPORT` item only if lines were pending (none, by decision 7's invariant) | None | Entry-less | `employees` |
| Policy step (`employees` phase) | None for the founder: employee results go only into the report (ADR 0022 decision 5) | None | None | `PRODUCTION_START:EMPLOYEE` is a cash posting that reveals no subjects (decision 12); its activity item is the posting itself | Cash (always known). Nothing else until a channel |
| Employee job settles | — | None | Via the station's `FACILITY_STOCK`/`OPERATIONS` diff on the next visit | Existing non-cash production rows, pending until learned | None until a channel |
| Report, in person | — | `REPORT` | Arrival delivery shares the catch-up step; `CatchUp` is unchanged | Clears entries for the station's subjects and news, as the live view already does | The live view, as before |
| Report, call out | — | `REPORT` (from `PLACE_CALL` and while connected) | None | Call-view books rule (ADR 0024 decision 4), plus the station's news | Call view (`PHONE`) |
| Report, call in answered | — | `CALL_RECEIVED` and `REPORT` | None | Clears the revealed subjects' entries and the station's news | Records with source `REPORT` |
| Report, call in taken as a message | — | None until delivered | None until delivered | Entry-less | None. `pendingMessages` isn't projected |
| Report, call in rings out | — | None | None | None | None. No state changes at all |
| Report message delivered | — | `MESSAGE_DELIVERED` carrying `report` | Unchanged | ADR 0024's message books rule | Records with source `MESSAGE`, under "older never overwrites newer" |
| Hiring slate | — | — | — | — | `hiring`, only while `PRESENT` at an open hiring place; seed, tick, game-data and agreements only |

**Hidden employee state** (`competence`, `reliability`, `loyalty`, `work`, `report`, and `formerEmployees`) never reaches the player snapshot except through `EMPLOYEE_PERFORMANCE` in the live view, a call view, a report or a message, and through cash postings.

**Amendment to ADR 0021 decision 9** (with ADR 0024 decision 10's): the dynamic half's delivery clause reads "…until the first tick at which a channel delivers a subject in D_t, news, a held message **or a report** whose content differs between the runs, or a cash posting that differs." An employee's call in is triggered by `callPending`, which is set only by a line in the report the call delivers, so a call that differs between runs delivers a differing report. K2's generators perturb employees' `work`, `report` and `competence`, and `formerEmployees`, as they perturb pending news and held messages. The static half needs no change: employee hidden fields aren't in the player view.

### 2. Coverage tables (ADR 0021 decisions 6 and 7)

Decision 12. One new cash-posting row (`PRODUCTION_START:EMPLOYEE`, revealing no subjects), no new books row (no new producer has a non-cash leg without a founder command), four rule-1 or rule-4 families, and the wages row confirmed as `AGREED_CHARGE` (decision 9).

### 3. Migration

From save fields only (decision 14): `employees: []`, `formerEmployees: []`, `counters.nextId.StandingOrder: 1`, and `report: null` on held messages and on the `DeliveredMessage` of every saved `MESSAGE_DELIVERED` activity item, each read from the message's own `reason`. No game-data reads.

### 4. Re-locks

**None.** Verified against the ten `@locked` files under `packages/simulation/test`:

- **`production/prod-001-labor.locked.test.ts`** pins leaders and wages: `GAME_DATA.characters` roles are exactly `FOREMAN` and `FOUNDER` (line 536); wages are Σ `data.characters[].dailyWage` + workers (lines 251–252, 912, 978–984); `family.leaders` lists every `GAME_DATA.characters` entry (lines 1293–1297); skill and loyalty are inert. All of it builds games from `FIRST_SHIPMENT_SCENARIO` (`scenarioWith`, line 305), which keeps `founderRules: false` (ADR 0023 decision 9). Decisions 1 and 9 change leaders and wages only with founder rules on, `CHARACTERS` is unchanged, and the candidate pool is a separate list. Its `runningJob` helper builds a `ProductionJobState` literal (line 335); this record adds no field to it (decision 6 tracks an employee's job on the employee). **If a later re-lock pass moves this file to a founder-rules scenario, it must re-lock the leader and wage tests for decisions 1 and 9.**
- **`progression/prog-001-outcome.locked.test.ts`**'s `dailyCost` sums `data.characters` (line 407), on the M001 scenario: unchanged for the same reason.
- **`economy/fin-001.locked.test.ts`**'s `KIND_DEFAULT` is a `Partial<Record<TransactionKind, …>>`, so `PERSONNEL` doesn't break it. No new ledger account.
- **No locked file builds a `GameState` from scratch** (they spread `sim.state`), so `employees` and `formerEmployees` don't break them. None enumerates `PHASES`, `DYNAMIC_ID_KINDS`, `GameCommandType`, `RejectionCode` or `SUBJECT_KINDS` exhaustively; `fin-001.locked.test.ts` reads only `counters.nextId.Transaction`.
- **No locked test draws from a stream this record touches:** production failure draws change only with founder rules on, and every shipped recipe has `failureChance: 0`.

The Sprint Zero reference hash (`test/sprint-zero/reference-hash.ts`, not locked; `contracts/eco-001-contracts.locked.test.ts` imports it) and the state-hash fixtures move with the new fields. The contract task regenerates them, as its predecessors do.

### 5. Tick order

`employees` runs between `production` and `vehicles` (decision 10). Employees never read or change founder state, so the tick a founder activity ends has nothing to race: a departure in the founder phase at `u` (the truck leaving) persists a live view that already includes the Distiller's step at `u` (a `TRAVEL` or `REST` command persists before it, leaving that step's lines pending), and an arrival at `u` delivers that step's lines with the catch-up. Orders to an employee in person are `FOUNDER_BUSY` while busy; on a call they use ADR 0024 decision 4's exemption through `busy.until`.

### 6. Flag off

M001 and the lab are unchanged (decision 13): the three commands are no-ops, `employees` stays empty, the phase is idle, leaders and wages are `data.characters`, and production failure draws use `rng.production`.

### 7. Randomness

Keyed one-shot draws (ADR 0024 decision 7) for the slate, true competence, the estimate, and, under founder rules, production failure (decisions 3 and 6), never a shared stream. Their keys are static strings and IDs, and their ordinals are the slate index, 0, or a job's `startedAt`, none of which hidden activity can change. The policy and employees' calls in draw nothing. With founder rules off, `rng.production` is drawn exactly as in M001.

**Replay.** Employee commands mint nothing from the command counters that `KernelSimulation.replay` advances at placement (decision 6), and every counter they do use advances only during tick processing. So a replay derives the same employee commands, IDs and hash, and E1's acceptance test checks it.

### 8. Rejection reasons

- **New:** `CANDIDATE_UNAVAILABLE { characterId }`, `CANDIDATE_TERMS_CHANGED { characterId, agreed, current }`, `STATION_UNSUITABLE { facilityId, role }`, `POSITION_FILLED { facilityId, role }`; and `OUTSIDE_AUTHORITY`'s payload `{ characterId, standingOrderId, limit: AuthorityLimit }` (ADR 0022 named the code).
- **Reused:** `INVALID_QUANTITY`, `UNKNOWN_ENTITY`, `NOT_PRESENT`, `FOUNDER_BUSY`, `PLACE_CLOSED`, `NO_WAY_TO_REACH`, `RECIPE_NOT_SUPPORTED`, `INSUFFICIENT_FUNDS`, and every `START_PRODUCTION` reason for employee commands.
- **Not reasons:** an employee holding back, a call in ringing out, and a report not yet heard are outcomes and report lines.

## Consequences

- **The first hire changes the founder's day, not just their clicks** (GDD §21's design test). With a Distiller, the still runs while the founder is at the feed store, on the road or asleep. What the founder still does: buy corn (it's delivered to the still), drive loads, find buyers. Those are the hours rule 3 wants spent on something new: farther buyers, contracts, a second operation (E2 and E3 build on it).
- **Hiring is a judgement under uncertainty.** The estimate is a range, the wage follows the estimate, and the truth shows up only after working together. A good Distiller is faster than the founder, a poor one slower, and you find out at the still, on the phone, or from the books.
- **The founder pays for not knowing.** Cash leaving for a batch is known at once, but how much is on hand, and whether the corn ran out, waits for a report. "Keep at least N on hand" plus "report problems by phone" is the player's way to buy that knowledge back, once a phone exists.
- **The Distiller doesn't buy supplies.** Keeping the still fed is still the founder's errand, so a Distiller without corn stalls and says so. That's the pressure that makes a runner (GDD §21, later) or a phone worth having. PT2 (#181) judges whether it feels like freedom or like babysitting.
- **The Office Hand keeps a job.** A Distiller answers the still's phone when the founder calls, but doesn't take messages from buyers. ADR 0026 decides precedence when both are at one place.
- **Employees' calls in need a second number,** which the PLACEHOLDER phone table doesn't give in M002 (decision 7). If the human makes the general store hold messages, the loop "Walt calls the store, the storekeeper takes it, you hear it when you buy corn" works with no new rules.
- **Wages stay known at once** (decision 9) only because nothing but the founder can change the wage bill in M002. Attrition, raises or hiring by a standing order must revisit ADR 0021 rule 1.
- **Competence affects time only.** Quality and failure stay recipe properties until a later record gives them a person.
- **ADR 0026 (D5b) builds on this:** new `EmployeeRole` members, `StandingOrderTerms` variants and `ROLE_TERMS` rows; `REPORT` rows for buyers and vehicles; both attendant hooks for the Office Hand; and the hired-driver deal case from #191, which can report a turned-back deal through the Driver's report.

## Needs design (placeholders in this record)

These are story and visual direction (factory.md §8). The human answered most of them on #209, and ADR 0028 (#214) records the answers. What's settled, and what's still open:

- **Candidate names and who they are.** Settled (#209 §2, ADR 0028 decision 4): Walt Hagen, Eddie Novak, Mae Brennan, Gus Lindqvist and Otto Krause are approved, as names only. Walt keeps his M001 name and ID and is on the first slate. Their appearances and voices are open (ADR 0028's *Needs design*).
- **Where and how candidates are found** (`HIRING_PLACES`). Settled (#209 §1, ADR 0028 decision 4): Miller's Feed & Seed, by word of mouth, during its hours. The slate is the people available to meet there.
- **The hiring scene and copy.** Settled in part (#209 §3, ADR 0028 decisions 4, 5 and 10): four approved bands, the inspectable range labelled "Estimate", wage terms before hiring, and the first standing order set in the hiring conversation. The rest is open in ADR 0028's *Needs design*.
- **Report wording.** Settled for six lines (#209 §4, ADR 0028 decisions 8 and 10). The lines without approved wording are open in ADR 0028's *Needs design*.
- **Whether the Distiller lives at the still and answers day and night** (decision 7). Settled (#209 §5, ADR 0028 decisions 1, 2 and 7): they live on-site, with no commuting, and they don't answer day and night. They work, answer and call in only within the role's working hours.
- **Whether any public phone holds messages.** Settled by ADR 0027 (#213): Miller's takes messages once its arrangement grants `TAKES_MESSAGES`, so a Distiller can call in during M002 once the still has a line.
- **Tuning (R1, PT2, T-LAB):** every number in decision 17 as ADR 0028 decision 12 amends it, plus `COMPETENCE_REVEAL_BATCHES`, `REPORT_LINE_LIMIT`, the working hours, the estimate width and the band thresholds. Under two-stage production (ADR 0029 decision 15) competence scales only the distillation run, so the best and worst Distillers differ by about 7% in output: whether the wage range still reads as a choice is for T-LAB and PT2.
- **Two-stage wording** (ADR 0029): the words for a mash, wash, barrels and a distillation run, and a line for a mash set (`BATCH_STARTED`), are open in ADR 0029's *Needs design*.
