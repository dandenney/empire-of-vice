# 0029: Two-stage production: fermentation and distillation

Status: accepted (decided by the orchestrator for M002 task D6, issue #241, from the human's gameplay decision of 2026-11-13; implemented by the tasks it names in decision 17: TS1, TS2, TS3, E1 #180 and R1 #176)

Amends, under founder rules only: ADR 0017 decisions 1, 2, 3, 5, 7 and 8 (duration, one job at a time, storage, where failure applies, when conversion is paid, the workforce check), ADR 0021 decisions 4 and 6 (the `FACILITY_OPERATIONS` value, producer rows), ADR 0022 decisions 3 and 7 (two presence rows; the conversion cost is paid at the mash, and O1b's invariant counts washes), ADR 0023 decisions 4 and 8 (two activities; the distillation busy is the run; the no-trap bound), ADR 0025 decisions 5, 6, 12, 16 and 17 (what a `DISTILL` order authorises, the policy, the employee producers, the contract list, R1's numbers), ADR 0028 decisions 2, 8, 11 and 12 (what hours govern, the report lines, the contract list, R1's numbers). With `founderRules: false`, nothing changes.

## Context

**The human's decision** (2026-11-13, after a first look at the M002 build; binding for gameplay feel):

- **Fermentation:** 4–5 in-game days, passive, in barrels. A small operation at Hollow Creek.
- **Distillation:** 6–12 in-game hours, and someone has to operate the still.
- **Ready wash keeps safely.** Wash that has finished fermenting waits in the barrel until someone distills it, with no spoilage or loss. The only cost of being away is that full barrels can't take a new mash.
- **The operator is busy for the whole distillation run.** The founder, or later the Distiller, is tied to the still for the run and can't do anything else (ADR 0023 `busy`).
- **Why:** the human researched how distillation worked after playtesting and wants the period-accurate rhythm. It also makes the first hire's relief concrete: "I don't have to babysit the still."

GDD §1 keeps production "a supply-chain abstraction, not distillation chemistry". This record stays inside that: two steps with a wait between them, no temperatures, cuts or proofs. GDD §6's "10 basic moonshine cases a day" is M001's figure and still holds with the flag off.

**What the code has today (verified on `main` at 161750c).**

- **Production** (`packages/simulation/src/production/jobs.ts`). `START_PRODUCTION` reserves the inputs and prepays the conversion cost (`conversionCost` = (`laborPerCase` + `overheadPerCase`) × quantity, `capacity.ts`) in one `PRODUCTION_START:<jobId>` transaction, Dr `PRODUCTION_IN_PROGRESS` / Cr `CASH` (O1b, ADR 0022 decision 7). Under founder rules the founder must be present and free, and the job's clock starts when setup ends: `startTick` returns `at + activityTicks(founder, "START_BATCH", at)`, so `startedAt = busy.until` (SK1a/SK1c, ADR 0023 decision 4). The `production` phase (`settleDueJobs`) settles jobs with `completesAt ≤ tick` in ID order, and draws failure from `rng.production` when `failureChance > 0`, **whatever the flag**: ADR 0025's keyed draw under founder rules isn't built yet (E1).
- **Capacity** (`capacity.ts`). `crewTerms` gives `base`, `crew` and `staffed`; `throughput` is 0 when `crew > 0` and `staffed = 0`, and `START_PRODUCTION` then rejects with `PRODUCTION_CAPACITY_EXCEEDED`, as it does when any job is running at the facility. `storageCommitted` is the cases held plus every running job's `quantity`.
- **Workforce** (`workforce.ts`). While a job runs, `SET_WORKFORCE` rejects a count below `min(workerCount, crew)`.
- **Contracts.** `ProductionJobState { id, facilityId, recipeId, quantity, startedAt, completesAt, reservationIds, conversionPrepaid }` (`state.ts`). `ReservationHolder` is `CONTRACT | PRODUCTION_JOB`, and `RELEASE_RESERVATION` releases only `CONTRACT` holders (`inventory/release.ts`). `FACILITY_OPERATIONS`'s value is `{ facilityId, jobs: ProductionJobSnapshot[], workersPresent }` (`knowledge.ts`). `RecipeOption` carries `ticksPerCase`, `maxStartableQuantity` and `blockedBy` (`snapshot.ts`). `GAME_COMMAND_TYPES` has 19 commands; `ACTIVITY_KINDS` has 14. `SAVE_SCHEMA_VERSION` is 7. `TRANSACTION_PRODUCERS` has O1b's `PRODUCTION_START` (founder command, `CASH`/`NO_ENTRIES`); ADR 0025's `PRODUCTION_START:EMPLOYEE` lands with E1. `ReportLine`, `HoldReason`, `BatchLimit` and `EmployeeWork.currentJobId` are EM1's (`knowledge.ts`, `state.ts`).
- **Employees** (`packages/simulation/src/personnel/personnel.ts`). EM1 registered `HIRE_EMPLOYEE`, `SET_STANDING_ORDER` and `DISMISS_EMPLOYEE` as accepted no-ops. The policy, the `employees` phase hooks and the keyed failure draw are E1's (#180), not built.
- **Game-data.** Basic moonshine: `ticksPerCase` 144, 2 corn and 1 sugar a case, $3.00 + $1.00 conversion a case, `failureChance` 0; standard moonshine also 0 (`recipes.ts`). `FACILITY_PRODUCTION` for Hollow Creek's distillery: 4 slots, storage 50, at most 8 workers, $2.00 a day overhead (`facilities.ts`). `ACTIVITY_DURATIONS`' longest is 60 (`presence.ts`). `ROLE_TERMS.DISTILLER.workingHours` is 06:00–20:00 and `COMPETENCE_DURATION_PPM` is 1.4×–0.8× (`personnel.ts`). Corn $2.50 and sugar $2.00 at Miller's (`suppliers.ts`); basic moonshine's base price $31.20 (`products.ts`).
- **The M002 scenario** (`the-first-hire.json`): `founderRules: true`, $250 cash, the copper still with `workerCount: 1`. That worker is SK1d's stand-in for the founder at the still, because a crew-3 still with nobody staffing it has throughput 0 (#180: "make 'the founder alone' real").
- **`PHASES`** (`kernel/registry.ts`): `production, employees, vehicles, resolution, founder, phones, deadlines, midnight`.
- **The UI.** `apps/game/src/scenes/scene-view.ts` `facilityScene` offers a start-batch action per `RecipeOption` and derives the still's `doneAt` from known jobs' `completesAt`.
- **Locked tests:** 14 `@locked` files under `packages/simulation/test`. Four run with `founderRules: true` and dispatch `START_PRODUCTION`: `founder/no-trap`, `knowledge/non-leak`, `view/issuer-view` and `walking-skeleton/path` (checklist §4).

**The no-trap bound today.** ADR 0023 decision 8's `B`, computed from game-data on `main`: `max(tired(60) = 90, MAX_REST_TICKS = 840, 2 × 300 + 240 + tired(30) = 885, longest walk 1 350, longest drive 450) = 1 350`.

## Decision

### 1. One switch: founder rules turn production into two stages

**Options considered:**

- **(a) A new rule switch, `twoStageProduction`,** beside `founderRules` in `GameRules`. Rejected: a second flag doubles the matrix every later record has to reason about (four combinations for one milestone), and no scenario wants one without the other.
- **(b) Per-recipe data:** a recipe with two-stage terms is two-stage, whatever the flag. Rejected: M001's recipes would need different data from M002's, or M001 would change.
- **(c) `founderRules` (chosen).** With the flag on, every recipe is two-stage. With it off, M001's single-stage `START_PRODUCTION` is unchanged. The four founder-rules locked files are the ones that change (checklist §4).

Every recipe carries its two-stage terms (decision 2), and the flag decides which model reads the data.

### 2. Game-data: durations, barrels and yields

Every value is PLACEHOLDER tuning for R1 (#176), PT2 and T-LAB, inside the human's ranges.

```ts
// packages/game-data/src/recipes.ts
export interface TwoStageTerms {
  /** Fermentation: from the mash being set to the wash being ready, in ticks. Passive; nobody's competence or tiredness changes it. */
  readonly fermentTicks: number;
  /** Cases one barrel of this recipe's mash yields when distilled (the yield). Inputs per barrel = inputsPerCase × this. */
  readonly casesPerBarrel: number;
}
export interface RecipeDefinition {
  // ...M001's fields, unchanged...
  /** Read only under founder rules (ADR 0029). */
  readonly twoStage: TwoStageTerms;
}
// BASIC_MOONSHINE_RECIPE:    twoStage: { fermentTicks: 6_480, casesPerBarrel: 10 }  // PLACEHOLDER: 4 days 12 h; 20 corn + 10 sugar a barrel
// STANDARD_MOONSHINE_RECIPE: twoStage: { fermentTicks: 6_480, casesPerBarrel: 10 }  // PLACEHOLDER

// packages/game-data/src/facilities.ts
export interface FacilityProductionDefinition {
  // ...M001's fields, unchanged...
  /** Barrels for fermenting mash (ADR 0029). Read only under founder rules. */
  readonly barrels: number;
}
// DISTILLERY_MAIN: barrels: 4   // PLACEHOLDER: "a small operation at Hollow Creek"
// RIVERSIDE_WAREHOUSE: barrels: 0

// packages/game-data/src/presence.ts, ACTIVITY_DURATIONS gains (decision 10):
MASH: 30,     // PLACEHOLDER: filling barrels with mash; a short in-person activity
DISTILL: 480, // PLACEHOLDER: a distillation run at 1×, 8 h (the human's 6–12 h)
```

`ticksPerCase` stays: it's M001's job time, and with the flag on nothing reads it.

**Load validation** (thrown with each module's other checks):

- `fermentTicks` is a whole number in `[4 × TICKS_PER_DAY, 5 × TICKS_PER_DAY]` (5 760–7 200), and `casesPerBarrel` a whole number ≥ 1. The fermentation range is the human's, so tuning can't leave it without a new decision.
- `barrels` is a whole number ≥ 0.
- **Every run is 6–12 hours, whoever operates it** (the human's range): `ceil(DISTILL × min(atZero, atHundred) / 1 000 000) ≥ 360` and `ceil(DISTILL × max(atZero, atHundred, TIRED_DURATION_PPM) / 1 000 000) ≤ 720`, with `COMPETENCE_DURATION_PPM`'s ends and the founder's tired factor (decision 6). At the placeholders: `ceil(480 × 0.8) = 384 ≥ 360` and `ceil(480 × 1.5) = 720 ≤ 720`. With today's factors that allows `DISTILL` from 450 to 480; widening it means narrowing the competence or tiredness factors, which is R1's call.
- `MASH` ≥ 1, so setting a mash always takes time (decision 9's step 2 reads it).
- **A Distiller's slowest run fits in a shift:** `ceil(DISTILL × max(atZero, atHundred) / 1 000 000)` ≤ the longest single interval of `ROLE_TERMS.DISTILLER.workingHours`. At the placeholders that's `ceil(480 × 1.4) = 672 ≤ 840`. Without it, a poor Distiller could never distill (decision 9). The range check above already keeps runs ≤ 720, so this binds only if the hours are cut below 12 hours.
- `DISTILL_ORDER_DEFAULTS.batchSize` ≥ every recipe's `casesPerBarrel`, so the order form's defaults always mash at least one barrel (decision 9).

### 3. The wash is barrel state, held apart from jobs

**Options considered for "wash as an intermediate":**

- **(a) Wash as inventory:** a material per recipe ("basic wash"), made by a fermentation job and consumed by a distillation job. Rejected: material inflows need a capacity rule (ADR 0017 decision 3 says materials don't count), fermentation's end becomes a posting while the founder is away (a new books producer), several fermentation jobs need ADR 0017 decision 2's "one job at a time" undone, and "a full barrel can't take a new mash" turns into a storage formula instead of a count.
- **(b) The wash as a stage of `ProductionJobState`** (`completesAt: Tick | null`, a `stage` field). Rejected: `completesAt` becomes nullable and a field is added to a type the flag-off locked tests build literally and do arithmetic on (`economy/fin-001` lines 518, 944, 989; `production/prod-001-labor` line 341; `completesAt` read as a number in six files). Every one would need a re-lock for a change that does nothing with the flag off.
- **(c) A wash is its own state, one per full barrel, and a distillation run is an ordinary production job (chosen).** `ProductionJobState` keeps its shape and meaning: a job is a run with a known `completesAt`, settled by ADR 0017's completion and failure. Fermentation reaching its end changes no state at all.

```ts
// packages/contracts/src/state.ts
/**
 * One full barrel (ADR 0029 decision 3): a mash fermenting, or ready wash waiting to be distilled.
 * Ready wash keeps: nothing happens to it until a run takes it. World state, learned through
 * FACILITY_OPERATIONS.
 */
export interface WashState {
  readonly facilityId: FacilityId;
  /** Which barrel, 0-based, below the facility's FACILITY_PRODUCTION.barrels. One wash per barrel. */
  readonly barrel: number;
  readonly recipeId: RecipeId;
  /** Cases it yields: the recipe's casesPerBarrel. */
  readonly quantity: number;
  /** When the mash was set (the end of MASH). Fermentation starts here. */
  readonly mashedAt: Tick;
  /** mashedAt + fermentTicks. Ready from this tick on, and it stays ready. */
  readonly readyAt: Tick;
  /** The input reservations, held by this barrel until a run takes them. */
  readonly reservationIds: readonly ReservationId[];
  /** The conversion cost paid at the mash (decision 5). */
  readonly conversionPrepaid: Money;
}

// GameState gains, beside productionJobs:
/** Full barrels, sorted by (facilityId with compareIds, barrel). Always [] with founder rules off. */
readonly washes: readonly WashState[];

// ReservationHolder gains:
| { readonly kind: "BARREL"; readonly facilityId: FacilityId; readonly barrel: number }
```

**Derived, never stored:** a wash is *fermenting* while `tick < readyAt` and *ready* from `readyAt`. A barrel is *full* while a wash names it, and *free* otherwise. Free barrels = `barrels − (washes at the facility)`.

**Barrel reservations** aren't releasable: `RELEASE_RESERVATION` already releases only `CONTRACT` holders (`release.ts`), so a `BARREL` holder gets `RESERVATION_NOT_ACTIVE` like a `PRODUCTION_JOB` one. There's no command to empty a barrel in M002: a wash leaves only when a run takes it. A wash at a facility that no longer owns its recipe's equipment (the still sold) waits, safely, until it does again.

### 4. Commands: two new ones, and `START_PRODUCTION` stays for the flag off

**Options considered:**

- **(a) Keep `START_PRODUCTION` and add a `stage` field.** Rejected: one command with two meanings, two activity kinds and two rejection orders; the employee authority gate and `REPEAT_OPERATION` would have to look inside it.
- **(b) `START_PRODUCTION` sets a mash, and a second command distills.** Rejected: its `quantity` would have to become a multiple of a barrel, M001's meaning would change under a flag, and the copy and history would read "start production" for a mash.
- **(c) Split (chosen).** `SET_MASH` and `START_DISTILLATION` are the founder-rules production commands. `START_PRODUCTION` is M001's, unchanged with the flag off. With the flag on it's rejected with `TWO_STAGE_RECIPE` (decision 14) after gate 1's shape and identity checks, so a lab script, a replayed M001 command or a stale UI gets a typed reason.

```ts
// packages/contracts/src/commands.ts
/** Fill free barrels with mash (ADR 0029). In person at the facility; MASH long. */
export interface SetMashCommand {
  readonly type: "SET_MASH";
  readonly facilityId: FacilityId;
  readonly recipeId: RecipeId;
  /** How many free barrels to fill, each with one barrel of the recipe's mash. */
  readonly barrels: number;
}

/** Distill every ready wash of the recipe at the facility in one run (ADR 0029). The operator is tied to the still for the run. */
export interface StartDistillationCommand {
  readonly type: "START_DISTILLATION";
  readonly facilityId: FacilityId;
  readonly recipeId: RecipeId;
}
```

Both join `GameCommand` and `GAME_COMMAND_TYPES`. Neither is repeatable: `REPEAT_OPERATION` keeps M001's three source types, and repeating a founder-rules `START_PRODUCTION` is rejected as the command itself is (`repeat-order.ts` runs its validator).

**`SET_MASH` applied at `t`** (gates in decision 14):

1. The barrels: the `barrels` lowest-indexed free barrels at the facility.
2. `mashedAt = t + MASH` (for the founder, `activityTicks(founder, "MASH", t)`, so `mashedAt = busy.until`; for an employee, `ACTIVITY_DURATIONS.MASH`, as ADR 0025 times employee setup), and `readyAt = mashedAt + fermentTicks`.
3. For each barrel: one reservation per recipe input of `perCase × casesPerBarrel`, holder `BARREL`, and a `WashState` with `quantity = casesPerBarrel` and `conversionPrepaid = conversionCost(recipe, casesPerBarrel)`.
4. One transaction, kind `PRODUCTION_START` (decision 5), posting Dr `PRODUCTION_IN_PROGRESS` / Cr `CASH` for the sum, with no entries when it's 0.
5. One event:

```ts
// packages/contracts/src/events.ts
| { readonly type: "MASH_SET"; readonly facilityId: FacilityId; readonly recipeId: RecipeId;
    readonly barrels: readonly number[]; readonly quantity: number; readonly readyAt: Tick; readonly conversionPrepaid: Money }
```

**`START_DISTILLATION` applied at `t`:**

1. The run takes **every ready wash of the recipe at the facility** (`readyAt ≤ t`), in barrel order. Their barrels are free from `t`.
2. A new `ProductionJobState` from the `ProductionJob` counter: `quantity` = Σ the washes' quantities, `startedAt = t`, `completesAt = t + runTicks` (decision 6), `reservationIds` = the washes' reservations in barrel order, re-held by `PRODUCTION_JOB { jobId }`, and `conversionPrepaid` = Σ the washes' prepaid amounts.
3. The washes are removed.
4. One transaction, kind `PRODUCTION_START`, with no entries (decision 5): the prepaid amount stays in `PRODUCTION_IN_PROGRESS`, now on the job.
5. One event:

```ts
| { readonly type: "DISTILLATION_STARTED"; readonly jobId: ProductionJobId; readonly facilityId: FacilityId; readonly recipeId: RecipeId;
    readonly barrels: readonly number[]; readonly quantity: number; readonly operator: DriverRef; readonly completesAt: Tick }
```

`operator` reuses `DriverRef` (`{ FOUNDER } | { EMPLOYEE; characterId }`, ADR 0023 decision 5), the contract's existing "which person" shape, rather than a parallel type. Both events are `"log"` in `EVENT_IMPORTANCE`, `null` in `EVENT_CONCERNS_PLACE` (like `PRODUCTION_STARTED`), and never in `LoggedToastEventType`. The run settles through ADR 0017's existing path, with `PRODUCTION_COMPLETED` or `PRODUCTION_FAILED`.

**Why a run takes all the ready wash.** It's one decision with one known outcome, so the founder never has to choose barrels, and a run never leaves ready wash behind that could have gone with it. **Options considered:** a run per barrel (rejected: four barrels would be four runs of 6–12 hours, more than a day of the operator's time for one cycle); a still charge size in game-data (rejected for M002: a number with no decision behind it yet; T-LAB can add one if runs turn out too large).

### 5. Money: the conversion cost is paid at the mash

**Options considered:**

- **(a) At the mash (chosen).** The founder pays when committing the inputs, in person, as O1b does at `START_PRODUCTION`. Once a mash is set, distilling it costs nothing, so **ready wash can always be turned into cases**: a founder who spends their last dollar on a mash can still distill and sell. ADR 0020 decision 10's restart cost and soft-lock analysis are unchanged. One cash moment per batch, as now.
- **(b) At the run.** It keeps O1b's invariant word for word (only jobs prepay), but ready wash could be stranded by an empty purse: `INSUFFICIENT_FUNDS` at the still, nothing to sell, and wages accruing. That's a new soft-lock path, and the human's "ready wash keeps safely" would hide a trap.
- **(c) Split:** overhead at the mash, labour at the run (the operator's work). Rejected: two postings per batch, two producers per operator, and option (b)'s stranding risk for the labour part.

**The postings:**

| When | Transaction | Entries | Key (producer, decision 12) |
|---|---|---|---|
| A mash, by the founder | `PRODUCTION_START` | Dr `PRODUCTION_IN_PROGRESS` / Cr `CASH`, Σ prepaid; none at 0 | `idempotencyKey("PRODUCTION_START", "MASH", facilityId, t)` |
| A mash, by an employee | `PRODUCTION_START` | As above | `idempotencyKey("PRODUCTION_START", "EMPLOYEE", "MASH", facilityId, t)` |
| A run starts, founder | `PRODUCTION_START` | None | `idempotencyKey("PRODUCTION_START", "RUN", jobId)` |
| A run starts, employee | `PRODUCTION_START` | None | `idempotencyKey("PRODUCTION_START", "EMPLOYEE", "RUN", jobId)` |
| A run completes | `PRODUCTION` | O1b's: Dr `FINISHED_GOODS`; Cr `RAW_MATERIALS`; Cr `PRODUCTION_IN_PROGRESS` (exactly `conversionPrepaid`) | `PRODUCTION:<jobId>`, unchanged |
| A run fails | `PRODUCTION_WRITE_OFF` | O1b's: Dr `LOSSES`; Cr `RAW_MATERIALS`; Cr `PRODUCTION_IN_PROGRESS` | `PRODUCTION_WRITE_OFF:<jobId>`, unchanged |

Mash keys are unique: one founder timed command applies per tick at most (the busy gate), and an employee issues at most one command per tick (ADR 0025 decision 6). Cash flow is unchanged: `PRODUCTION_START`'s default is `WAGES` (ADR 0022 decision 7), and run starts have no entries.

**O1b's invariant, restated:** the `PRODUCTION_IN_PROGRESS` balance equals **Σ `conversionPrepaid` over running jobs plus Σ `conversionPrepaid` over washes**. With the flag off there are no washes, so it reads exactly as before. A run start moves the amount from washes to a job without touching the ledger, so the sum holds across it.

**Funds check:** `SET_MASH` rejects with `INSUFFICIENT_FUNDS { required, available }` when cash is below the sum, like `START_PRODUCTION`. `START_DISTILLATION` checks no funds.

### 6. The run: how long, who, and what can go wrong

**Run length.** It depends on the operator only:

- **The founder operates:** `runTicks = activityTicks(founder, "DISTILL", t)`: `ACTIVITY_DURATIONS.DISTILL`, × `TIRED_DURATION_PPM` rounded up while tired (ADR 0023 decision 4). The founder becomes `PRESENT` with `busy: { activity: "DISTILL", until: t + runTicks }`, and the job's `completesAt` is the same tick. **The run and the founder's busy are one interval**, set together when the command applies, so neither can outlast the other.
- **An employee operates:** `runTicks = ceil(DISTILL × competencePpm / 1 000 000)` (ADR 0025 decision 6's pace, now on the run instead of the batch). The employee's `work.currentJobId` is the run until it settles.

At the placeholders every run is inside the human's 6–12 hours: 384 (a Distiller at competence 100) to 672 (competence 0), 480 for a rested founder and 720 for a tired one. Decision 2's load check keeps it that way.

**Equipment bonuses and crew don't change a run** under founder rules (decision 7 for crew). **Options considered for the condenser's `throughputBonus`:** (a) it shortens the run (rejected: 480 ÷ 1.4 = 343 ticks, under the human's 6 hours, and the founder's busy would need a facility-specific duration); **(b) it has no effect under founder rules (chosen):** it keeps the run equal to an `ACTIVITY_DURATIONS` row, and M002's progression doesn't depend on it. A later record can give the condenser a two-stage role (yield, or more barrels).

**One run at a time per facility** (ADR 0017 decision 2, under founder rules): a `START_DISTILLATION` while a job runs at the facility is `PRODUCTION_CAPACITY_EXCEEDED`. Barrels are separate from the still: a mash can be set while a run is going, by anyone free to set one.

**Ready wash keeps safely.** No rule reads how long a wash has been ready. There's no spoilage, decay, loss or draw on a waiting wash, and fermentation's end has no event, no transaction and no state change. The only cost of not being there is decision 3's: a full barrel isn't free.

**Failure applies to the run.** `failureChance` is drawn when the run settles, through ADR 0017 decision 5's write-off: the whole run's materials and prepaid conversion go to `LOSSES`.

- **Options considered:** at fermentation's end (rejected: a loss with no one there and no command behind it, at a time fixed by the clock, which contradicts "ready wash keeps safely"); per barrel (rejected: a run is one batch through one still, and per-barrel draws would need per-barrel keys for nothing); **at the run's end (chosen):** the stage someone operates.
- **Stream:** ADR 0025 decision 6's keyed draw, unchanged: under founder rules, `nextInt(keyedRng(seed, "production:<facilityId>", job.startedAt), RATIO_SCALE)`. A run's `startedAt` is its `START_DISTILLATION` apply tick, and a facility starts at most one run per tick, so the key names the run. With the flag off, `rng.production` as today. Every shipped recipe has `failureChance: 0`, so nothing is drawn in practice yet.

### 7. Crew and `workerCount` under founder rules

The founder operates the still, and later the Distiller does. That's what SK1d's `workerCount: 1` stood in for (#180).

**Options considered:**

- **(a) Workers set the run's pace** (ADR 0017's crew factor on the run). Rejected: a founder alone with a crew-3 still would run 3× longer (24 h), outside the human's 6–12 h; and the human's operator is a person, not a crew.
- **(b) The founder counts as one worker while present.** Rejected: it keeps ADR 0017's factor alive under a different name, the run length would still depend on the workforce, and it makes "present" a production input.
- **(c) Under founder rules, workers have no production role (chosen).** Neither stage reads `workerCount`, `crew` or `staffed`, and a crewed still with no workers can still mash and distill.

What follows:

- `throughput`'s zero rule (`crew > 0` and `staffed = 0`) isn't read by `SET_MASH` or `START_DISTILLATION`. They need only the recipe's equipment (`supportsRecipe`).
- `SET_WORKFORCE` stays a founder agreement that sets a wage line (ADR 0017 decision 7, ADR 0025 decision 9). Its in-use check (ADR 0017 decision 8) reads only jobs that need a crew, so with the flag on it never applies: runs hold no workers.
- **R1 sets the M002 scenario's `workerCount` to 0** (decision 15), retiring SK1d's stand-in and its $2.00 a day. GDD §21's "ordinary workers remain abstract labour" has no mechanical role in M002. A later record can give them one (more barrels, a faster run), as a choice the founder pays for.
- `FACILITY_OPERATIONS.workersPresent` and `PlayerFacility.workforce` stay as they are: agreements, shown.

### 8. Knowledge: barrels are part of the still's operations

**Options considered:**

- **(a) A new subject kind, `FACILITY_BARRELS`.** Rejected: a second "as of" for the same place, and a row in every `KNOWLEDGE_VISIBILITY` source, the live view and the cash-posting reveals, so that the barrels and the still could be known at different times.
- **(b) `FACILITY_OPERATIONS` gains the washes (chosen).** Every channel that tells the founder about the still already carries it: `IN_PERSON`, `PHONE` and `MESSAGE` for a facility, `REPORT` (ADR 0025 decision 7), and the production cash-posting reveal. "What's going on at the still" stays one record with one `learnedAt`.

```ts
// packages/contracts/src/snapshot.ts
export interface WashSnapshot {
  readonly facilityId: FacilityId;
  readonly barrel: number;
  readonly recipeId: RecipeId;
  readonly productId: ProductId;
  readonly quality: QualityTier;
  readonly quantity: number;
  readonly mashedAt: Tick;
  readonly readyAt: Tick;
}
// GameSnapshot gains `washes: readonly WashSnapshot[]` (the lab and the debug view).
// FacilitySnapshot gains `barrels: number` (game-data, so always known).

// packages/contracts/src/knowledge.ts, KnowledgeValue's FACILITY_OPERATIONS member gains:
/** Full barrels at the facility (ADR 0029). Whether each is ready is readyAt against the tick. */
readonly washes: readonly WashSnapshot[];
```

**How each thing is known:**

- **Fermentation progress and ready wash:** from a known `FACILITY_OPERATIONS` value, by comparing `readyAt` with the snapshot's tick, as `facilityScene` already derives `doneAt` from known jobs' `completesAt`. A record learned on Monday that shows a wash ready on Wednesday reads "ready by now, as of Monday": it may already have been distilled, and the ledger's "last updated" says how old the record is.
- **In person at the still:** the live view (ADR 0021 decision 5).
- **By the Distiller:** in a report (ADR 0025 decision 7: `REPORT.FACILITY` includes `FACILITY_OPERATIONS`), on a call answered at the still (`PHONE`), or in a report message (`MESSAGE`), as ADR 0028 decision 8 delivers them. No new channel and no new visibility row.
- **The founder's own mash:** the founder sets it in person, so they leave knowing its `readyAt`. That stays true until someone else empties the barrel, which only a hired Distiller can do, and then their report says so (decision 9).
- **The barrel count** is game-data (`FacilitySnapshot.barrels`): always known.

**The player snapshot** (`player-snapshot.ts`): `PlayerFacility`'s `Pick` gains `barrels`, and `RecipeOption` gains the founder-rules affordances, recomputed from known stock and the purse like the rest of `RecipeOption`:

```ts
// packages/contracts/src/snapshot.ts, RecipeOption gains:
/** null with founder rules off. */
readonly twoStage: {
  readonly casesPerBarrel: number;
  readonly fermentTicks: number;
  /** The most barrels SET_MASH accepts now (free barrels, storage, materials, cash). 0 if blocked. */
  readonly maxMashBarrels: number;
  readonly mashBlockedBy: RejectionReason | null;
  /** Cases a START_DISTILLATION would take now: the ready washes of this recipe. */
  readonly readyQuantity: number;
  readonly distillBlockedBy: RejectionReason | null;
} | null;
```

With the flag on, `maxStartableQuantity` is 0 and `blockedBy` is `TWO_STAGE_RECIPE`.

### 9. The Distiller: the policy for two stages

**Restated** (amends ADR 0025 decision 6 and ADR 0028 decision 2). For an employee E with a `DISTILL` order (recipe R, product P, quality Q, `c = R.twoStage.casesPerBarrel`, `k = conversionCost(R, c)` per barrel) at station S, in the `employees` phase at tick t, only while `isAvailable(E, t)` (ADR 0028 decision 1):

0. The spending period resets if `periodIndex` moved on (ADR 0025).
1. **A run is going at S** (any job at S, E's or the founder's): do nothing. If it's E's, E is at the still for the run. That's the employee's counterpart of the founder's `busy`, read from E's own `currentJobId`.
2. **A mash is being set at S** (a wash at S with `mashedAt > t`): do nothing.
3. **Set a mash**, if S has free barrels `f ≥ 1` and the unreserved quantity of P at quality Q at S is below `keepOnHand`:
   - `n = min(f, floor(batchSize / c), floor(storage room / c), min over R's inputs of floor(available / (perCase × c)))`, and if `k > 0`, also `min(n, floor(cash / k), floor((spendingCap − spent) / k))`. `n = 0` if S doesn't own R's equipment.
   - **`n ≥ 1`:** issue `SET_MASH { S, R, barrels: n }`. If it applies: `spent += n × k`, `lastHold = null`, and a `BATCH_STARTED` line with `quantity = n × c`, `conversionCost = n × k` and `limitedBy` (below). Then stop: one command per tick.
   - **`n = 0`:** find the hold in ADR 0025's order (`RECIPE_NOT_SUPPORTED`, `NO_STORAGE`, `NO_MATERIALS { materialId }`, `NO_CASH`, `SPENDING_CAP`), and write `HELD_BACK` if it differs from `lastHold`. Go on to step 4: a mash that can't be set doesn't keep ready wash from being distilled.
   - With no free barrel, or enough on hand, set `lastHold = null` and go on. Full barrels and a met order aren't problems.
4. **Distill ready wash**, if S supports R, a wash of R at S has `readyAt ≤ t`, and **the run fits in the shift:** `t + runTicks(E) ≤ shiftEnd(E, t)` (decision 6's employee run), where `shiftEnd` is the first tick after t at which `onDuty(E.role, ·)` is false (ADR 0028 decision 1; a pure function of the tick and game-data). Issue `START_DISTILLATION { S, R }`; if it applies, `currentJobId` is the run. If the run doesn't fit, do nothing and write nothing: the wash keeps, and E distills it at the start of the next shift (#224: "Order paused outside working hours: no incident report").

Mashing comes before distilling because it's short and starts the next fermentation sooner. Barrels a run frees are refilled when the run ends, at the next step on duty.

**A run never outlasts a shift.** **Options considered for shift end:** **(a) start a run only if it fits (chosen):** the Distiller is a person who sleeps (#209 §5), and nothing has to happen at 20:00; (b) the run goes on past the shift (rejected: the "works through the night" ADR 0028 decision 2 rejected, a few hours at a time); (c) the run pauses overnight (rejected: ADR 0028 decision 2 option (c), and the still would hold a half-run). Decision 2's load check keeps the slowest Distiller's run inside the longest shift interval, so step 4 can always fire on some shift.

**Authority** (amends ADR 0025 decision 5). Under founder rules a `DISTILL` order authorises exactly two commands at the station for its recipe: `SET_MASH`, with `barrels × casesPerBarrel ≤ batchSize` and its conversion cost ≤ `spendingCap − spent`; and `START_DISTILLATION`, which spends nothing. Anything else is `OUTSIDE_AUTHORITY`, with ADR 0025's limits (`COMMAND`, `STATION`, `RECIPE`, `BATCH_SIZE`, `SPENDING_CAP`). The policy never issues `START_PRODUCTION`. `DistillOrderTerms` keeps its shape. Its docs change: `keepOnHand` gates setting a mash, `batchSize` caps the cases in one mash, and `spendingCap` is charged at the mash.

**An order a barrel can't satisfy:** under founder rules, `HIRE_EMPLOYEE` (with an order) and `SET_STANDING_ORDER` reject a `DISTILL` order whose `batchSize` is below its recipe's `casesPerBarrel` with `INVALID_QUANTITY { field: "batchSize", value }`, at gate 1, after the recipe's `UNKNOWN_ENTITY`. It reads the command and game-data only.

**`EmployeeWork`** keeps its shape. `currentJobId` is the run E operates (its doc says so). `batchesRun` counts runs E operated that settled, so `COMPETENCE_REVEAL_BATCHES` (1) reveals competence after the first run. Mashes aren't batches run.

**Report lines on the two stages** (amends ADR 0028 decision 8; the approved wording is #209's and #224's):

| Approved line | Two-stage trigger | Report line |
|---|---|---|
| "We're out of corn. …" / "Not enough {ingredient} to start another batch." | Step 3 can't set a mash for an input | `HELD_BACK { NO_MATERIALS { materialId } }` |
| "The shed's full. …" | Step 3: no storage room for a barrel's cases | `HELD_BACK { NO_STORAGE }` |
| "I can't start the next batch with what you've allowed me to spend." | Step 3: the cap | `HELD_BACK { SPENDING_CAP }` |
| "There's not enough money to start the next batch." | Step 3: cash | `HELD_BACK { NO_CASH }` |
| "Couldn't make the full batch. There wasn't enough {ingredient}." (and the cap and cash variants) | A mash smaller than its bound | `BATCH_STARTED.limitedBy` |
| "Finished {quantity} cases of {product}. They're ready at Hollow Creek." | E's run completes | `BATCH_FINISHED { COMPLETED }`, `quantity` = the run's |
| "Lost that batch of {product}. …" | E's run fails | `BATCH_FINISHED { FAILED }` |
| "I couldn't carry out that order: …" | `SET_MASH` or `START_DISTILLATION` refused | `ORDER_REFUSED` |
| "The still's running. Nothing needs your attention right now." | Derived, ADR 0028 decision 8's conditions, with "a running job" read as **a run or a wash** in the view's `FACILITY_OPERATIONS` | Not a line |
| (no line) | Barrels full; wash fermenting; ready wash waiting for a shift that fits; off duty | None (#224) |

**`limitedBy` for a mash:** `null` when `n = min(f, floor(batchSize / c))`, the most the barrels and the order allow. Otherwise it's the first bound equal to n, in hold order: storage, each input in recipe order, cash, the cap. Free barrels never count as a limit, because a barrel still fermenting isn't a problem. `BATCH_STARTED` now means a mash set, and its wording isn't approved yet (*Needs design*).

**A founder's run isn't anyone's line.** If the founder distills while a Distiller is employed, the Distiller reports nothing about it, as ADR 0025 decides for a dismissed employee's job.

### 10. Presence: two activities, and the no-trap bound

**`ACTIVITY_DURATIONS`** (ADR 0023 decision 4's table gains):

| `ActivityKind` | Command | Duration | Why it costs time |
|---|---|---|---|
| `MASH` | `SET_MASH` | 30 min | Filling barrels with mash; fermentation starts when it ends |
| `DISTILL` | `START_DISTILLATION` by the founder | 480 min (8 h): the whole run (decision 6) | The operator is tied to the still for the whole run |

`ACTIVITY_KINDS` appends `"MASH"` and `"DISTILL"`. `activityOf` maps `SET_MASH` to `MASH` and `START_DISTILLATION` to `DISTILL`. Tiredness stretches both like any activity, so a tired founder's run is 720 (decision 2 keeps that inside 12 hours).

**Presence** (ADR 0022 decision 3's table gains):

| Command | Founder must be present at | What moves out of the immediate result | Outcome |
|---|---|---|---|
| `SET_MASH` | The facility (not hours-gated: your own place) | Nothing | Washes ferment; ready at `readyAt`, with no event |
| `START_DISTILLATION` | The facility | Nothing | The run settles at `completesAt` (ADR 0017's completion or failure) |

While distilling, the founder is `PRESENT` and busy, so every timed command, `TRAVEL` and `REST` are `FOUNDER_BUSY` until the run ends (ADR 0023 decision 2a). Instant commands at the still stay allowed, as for any activity. There's no way to abandon a run in M002.

**The no-trap bound** (ADR 0023 decision 8). `B`'s first term is "the longest `ACTIVITY_DURATIONS` × `TIRED_DURATION_PPM`", and `DISTILL` is now the longest activity. A founder's run is exactly the `DISTILL` busy, so the bound covers runs as it covers every activity, and the proof's step 2 ("busy ends at `busy.until`") holds. With the numbers:

- At `DISTILL = 480`: `tired(480) = 720`, so `B = max(720, 840, 885, 1 350, 450) = 1 350`, unchanged.
- Decision 2 caps every run, tired included, at 720, so `tired(DISTILL) ≤ 720 < 1 350` for any value that loads. `B` would grow only past 1 350, which is 22.5 hours.

`REST` is never refused for anything here except the busy that every activity causes. The locked no-trap test computes `B` from `ACTIVITY_DURATIONS`, so it picks up `DISTILL` without a formula change.

### 11. Tick order

`PHASES` is unchanged: `production, employees, vehicles, [world events], resolution, founder, phones, deadlines, midnight`, then the persist step.

- **Commands** (first in the tick): `SET_MASH` and `START_DISTILLATION` apply here, so a founder's command at the still always comes before the Distiller's step on the same tick. The Distiller then finds the barrels taken or the still busy, and waits (steps 1 and 2).
- **`production`:** settles runs with `completesAt ≤ tick`, in job ID order, as today, and writes `BATCH_FINISHED` for an employee's run. Fermentation has no phase work: readiness is `readyAt ≤ tick`, read when needed.
- **`employees`:** the policy (decision 9). A run that settled in `production` this tick frees the Distiller, who can set a mash on the same tick. A wash whose `readyAt` is this tick can be distilled this tick.
- **`founder`:** ends a `MASH` or `DISTILL` busy whose `until ≤ tick`, as for any activity.
- **`midnight`:** unchanged. A founder's run can cross midnight; an employee's ends within their shift (decision 9).

**On the tick a founder activity ends** (ADR 0023 decision 2a):

- **`DISTILL` ending at `u`:** `production` settles the run at `u`, so the cases are in stock before the `founder` phase clears the busy, and the tick-end persist records them in the live view. A command applied at `u` is still `FOUNDER_BUSY` (the gate's `≥`). From `u + 1` the founder can load the truck with the new cases.
- **`MASH` ending at `u`:** the washes' `mashedAt` is `u`, so fermentation starts at `u` and the Distiller's step 2 stops waiting at `u`.
- **Arriving at the still at `u`** as an employee's run settles: `production` writes the line, the `employees` step at `u` runs before the arrival, and the arrival delivers the report with the catch-up (ADR 0025 decision 10), with `atArrival: true` (ADR 0028).

### 12. Coverage: the producers

| Producer (idempotency-key family) | Entries | Classification |
|---|---|---|
| `PRODUCTION_START:MASH` (new) | Dr `PRODUCTION_IN_PROGRESS` / Cr `CASH`; none at 0 | Rule 1: the founder's command. `{ trigger: "FOUNDER_COMMAND", legs: ["CASH", "NO_ENTRIES"] }` |
| `PRODUCTION_START:RUN` (new) | None | Rule 1. `{ trigger: "FOUNDER_COMMAND", legs: ["NO_ENTRIES"] }` |
| `PRODUCTION_START:EMPLOYEE:MASH` (new; replaces ADR 0025's `PRODUCTION_START:EMPLOYEE`) | As the founder's mash | World, with a cash leg: **a row in ADR 0021 decision 6's cash-posting table**. `{ trigger: "WORLD", legs: ["CASH", "NO_ENTRIES"] }`; `CASH_POSTING_REVEALS` = `{ subjects: [], news: "NONE" }` |
| `PRODUCTION_START:EMPLOYEE:RUN` (new) | None | Rule 4: never in the books. `{ trigger: "WORLD", legs: ["NO_ENTRIES"] }` |
| `PRODUCTION`, `PRODUCTION_WRITE_OFF` of a run | Non-cash (prepaid), unchanged | Existing rows. A founder's run settles while the founder is at the still, busy, so it's known by rule 1 ("posted at the founder's place while they're present"). An employee's goes to `pendingBooks`, concerning `FACILITY_STOCK` (ADR 0021 decision 7's production row) |
| `PRODUCTION_START` (O1b, `START_PRODUCTION`) | Unchanged | Flag off only |

**The cash-posting row** (ADR 0021 decision 6), restating ADR 0025's for the mash: an employee sets a mash, conversion cost prepaid (`PRODUCTION_START:EMPLOYEE:MASH`), kind `PRODUCTION_START`, reveals **nothing beyond the posting itself**. The founder knows money went on a mash at the still. The barrels and the stock wait for a report or a visit.

ADR 0025's `PRODUCTION_START:EMPLOYEE` family (an employee's `START_PRODUCTION`) has no call site under two stages, because the policy never issues `START_PRODUCTION`. E1 registers the `EMPLOYEE:MASH` and `EMPLOYEE:RUN` families instead. ADR 0021 decision 7's books table gains no row: no new producer posts a non-cash leg without a founder command.

### 13. Saves (ADR 0009)

The contract task bumps `SAVE_SCHEMA_VERSION` to the next version after 7. The migration reads only the save's own fields and never game-data:

| New field | Value | Source |
|---|---|---|
| `GameState.washes` | `[]` | None needed: no earlier save can hold a wash, because no command could set a mash |
| `washes` on every saved `FACILITY_OPERATIONS` value: in `knowledge.records[].value`, `knowledge.lastCatchUp.lines[].before`/`.after`, and `knowledge.pendingMessages[].items[].values[].value` (a `DeliveredMessage` carries subjects, not values) | `[]` | None needed, for the same reason. The contract task checks the Zod schema for any other place a `KnowledgeValue` is saved, and covers it |

**Fields that don't change:** `ProductionJobState` (decision 3); `counters` (washes have no IDs, and runs use the `ProductionJob` counter); `EmployeeState` and `DistillOrderTerms` (docs only). New union members (`SET_MASH`, `START_DISTILLATION`, `MASH_SET`, `DISTILLATION_STARTED`, `MASH`, `DISTILL`, the `BARREL` holder, two rejection codes) are additive, so existing saves satisfy them.

**A founder-rules save from before the bump** may hold a running single-stage job from `START_PRODUCTION`. It settles at its `completesAt` as before: settlement doesn't care how a job started. After the load, new production goes through the two stages. The task adds an old-version fixture and a migration test, as K1 and its successors did.

### 14. Rejection reasons

**`SET_MASH`**, in ADR 0022's gate order (founder rules):

| Gate | Failure | Reason |
|---|---|---|
| 1 | `barrels` isn't a positive safe integer | `INVALID_QUANTITY { field: "barrels", value }` |
| 1 | Not a family facility / not a recipe | `UNKNOWN_ENTITY { kind: "Facility" \| "Recipe", id }` |
| 2 | Not present at the facility; busy | `NOT_PRESENT`, `FOUNDER_BUSY` |
| 4 | An employee outside their order | `OUTSIDE_AUTHORITY` (decision 9) |
| 5 | The facility doesn't own the recipe's equipment | `RECIPE_NOT_SUPPORTED { facilityId, recipeId }` |
| 5 | Fewer free barrels than `barrels` | `PRODUCTION_CAPACITY_EXCEEDED { facilityId, requested: barrels × c, available: free × c }` (cases, as for `START_PRODUCTION`) |
| 5 | Storage room below `barrels × c` | `STORAGE_CAPACITY_EXCEEDED { facilityId, requested, available }` |
| 5 | An input short | `INSUFFICIENT_MATERIALS { materialId, required, available }` |
| 5 | Cash below the conversion cost | `INSUFFICIENT_FUNDS { required, available }` |

**`START_DISTILLATION`:**

| Gate | Failure | Reason |
|---|---|---|
| 1 | Not a family facility / not a recipe | `UNKNOWN_ENTITY` |
| 2 | Not present; busy | `NOT_PRESENT`, `FOUNDER_BUSY` |
| 4 | An employee outside their order | `OUTSIDE_AUTHORITY` |
| 5 | The facility doesn't own the recipe's equipment | `RECIPE_NOT_SUPPORTED` |
| 5 | A run is going at the facility | `PRODUCTION_CAPACITY_EXCEEDED { facilityId, requested: ready cases, available: 0 }` |
| 5 | No ready wash of the recipe there | **`NO_READY_WASH { facilityId, recipeId, readyAt }`** (new) |

**`START_PRODUCTION` with the flag on:** gate 1's existing checks (`INVALID_QUANTITY`, `UNKNOWN_ENTITY` facility then recipe), then **`TWO_STAGE_RECIPE { facilityId, recipeId }`** (new), before presence. With the flag off it's M001's, unchanged.

```ts
// packages/contracts/src/commands.ts, RejectionReason gains:
/** START_PRODUCTION under founder rules: production there is SET_MASH then START_DISTILLATION (ADR 0029). */
| { readonly code: "TWO_STAGE_RECIPE"; readonly facilityId: FacilityId; readonly recipeId: RecipeId }
/** No wash of the recipe is ready there. readyAt: the soonest a fermenting one is ready, or null if none is fermenting. */
| { readonly code: "NO_READY_WASH"; readonly facilityId: FacilityId; readonly recipeId: RecipeId; readonly readyAt: Tick | null }
```

**Reused:** `INVALID_QUANTITY` (including `field: "batchSize"` for an order a barrel can't satisfy, decision 9), `UNKNOWN_ENTITY`, `NOT_PRESENT`, `FOUNDER_BUSY`, `RECIPE_NOT_SUPPORTED`, `PRODUCTION_CAPACITY_EXCEEDED`, `STORAGE_CAPACITY_EXCEEDED`, `INSUFFICIENT_MATERIALS`, `INSUFFICIENT_FUNDS`, `OUTSIDE_AUTHORITY`, and `RESERVATION_NOT_ACTIVE` for a barrel's reservation. **Not reasons:** a wash still fermenting when a mash is wanted, ready wash waiting, and a run that won't fit the Distiller's shift are states and outcomes, not rejections.

Every payload is the command's own fields, game-data, or values from the view the founder is standing in.

### 15. R1: is the first hire still reachable?

**The numbers** (PLACEHOLDER): 4 barrels, 10 cases a barrel, fermentation 6 480 ticks (4 d 12 h), `MASH` 30, `DISTILL` 480. Per case: materials $7.00 (2 × $2.50 + $2.00), conversion $4.00 paid at the mash, basic base price $31.20, so a margin of about **$20.20** a case before transport and market movement, the same as now. A full cycle is 4 barrels = 40 cases = 80 corn + 40 sugar ($280) + $160 conversion.

**Output per cycle** (40 cases; competence pace from `COMPETENCE_DURATION_PPM`; the Distiller's shift 06:00–20:00):

| Operator | Run (ticks) | Latest start | Worst wait for a shift | Cycle, best (ticks) | Cycle, worst (ticks) | Cases a day, worst |
|---|---|---|---|---|---|---|
| The founder, alone, rested | 480 | — | — | 6 990 | — (the founder's own day) | 8.2 at best |
| Distiller, competence 0 (×1.4) | 672 | 08:48 | 1 271 | 7 182 | 8 453 | 6.8 |
| Walt Hagen, 55 (×1.07) | 514 | 11:26 | 1 113 | 7 024 | 8 137 | 7.1 |
| Distiller, competence 100 (×0.8) | 384 | 13:36 | 983 | 6 894 | 7 877 | 7.3 |

A cycle is `MASH + fermentTicks + wait + run`, and the next mash follows the run's end, which is always on duty: a run that waited starts at 06:00 and ends by 17:12. The worst wait is wash ready one minute after the latest start, held until 06:00. For comparison, today's M002 stand-in (one worker on a crew-3 still) makes 10 cases in 4 320 ticks, about 3.3 a day.

**R1's two properties** (ADR 0025 decision 17, ADR 0028 decision 2):

- **Possible** (present at Miller's while open, a candidate on the slate, cash ≥ the $25.00 signing cost): unchanged. Hiring isn't gated by production.
- **Sustainable** (the Distiller's output covers their wage and the bill): the worst case, 6.8 cases a day, is about **$137 a day** against a wage of at most $6.00 plus $2.00 overhead (with `workerCount` 0, decision 7). Hours and the run fitting the shift cost at most 15% against the best case, nowhere near the wage.

**The first sale, which is what R1 has to watch.** From the M002 start, with nothing in the barrels and $250: wake 06:00, walk to Miller's (3 h on foot), buy 40 corn and 20 sugar ($140, 1 h), walk back (3 h), mash 2 barrels ($80, 13:00–13:30), leaving $30. The wash is ready on day 6 at 01:30, distilled 06:00–14:00, and 20 cases sell for about $620 that evening. So **the first hire is reachable by day 7**, and no soft-lock appears: paying at the mash means distilling needs no cash (decision 5), and wages accrue to `WAGES_PAYABLE` while cash is short (ADR 0017 decision 9). **But the first five days have nothing to sell**: at 20 000 ms per game hour that's about half an hour of real time at 1×, even with rest's fast-forward at night. It breaks experience criterion 1 ("within the first ten minutes, feels they can't be everywhere at once").

**R1 decides the opening** (orchestrator decision, recorded here so R1 doesn't re-open it). **Options considered:** (a) shorten fermentation for the scenario (rejected: outside the human's 4–5 days); (b) start with finished cases on hand (it gives something to sell, but the still has nothing to do for days); **(c) start with washes already in the barrels (recommended):** for example two barrels ready at 06:00 on day 1 and two ready on day 3. The first day then has a run, a delivery and a supply trip, and the rhythm is already going. It needs `ScenarioFacility.washes: readonly { recipeId; barrels; readyAtTick }[]` (game-data's own type, ADR 0012), with `new-game.ts` creating the washes, their reservations of opening materials and their prepaid conversion in the opening balance (`OPENING_BALANCE` posts non-cash legs already). Opening washes were set before the story starts, so their `mashedAt` is tick 0 and their `readyAt` is the scenario's, which may be sooner than `fermentTicks`. That's R1's to build and tune, together with `workerCount: 0`, the starting cash, storage (4 barrels reserve 40 of the still's 50 cases of room, so with more than 10 cases on hand the fourth barrel doesn't fit; R1 should raise `baseStorage` or lower `keepOnHand`'s default of 20) and `DISTILL_ORDER_DEFAULTS.batchSize` (10 = one barrel a mash; 40 fills the barrels in one).

**Competence matters less now.** Fermentation dominates the cycle, so the best and worst Distillers differ by about 7% in output (7.3 vs 6.8 cases a day), against 50% when competence scaled the whole batch. That weakens "a good Distiller is worth a higher wage" (ADR 0025 Consequences). The lever is tuning, not story: T-LAB and PT2 judge whether a wage range of $3–$6 still reads as a choice, and a later record can give competence a yield or failure effect.

### 16. Contract changes (their own task: TS1)

One contract task, after this record, in the contract sequence (it shares `state.ts`, `commands.ts`, `events.ts`, `knowledge.ts`, `snapshot.ts`, `player-snapshot.ts`, `schemas.ts`, `save.ts` and the hash fixtures):

- `state.ts`: `WashState`; `GameState.washes`; `ReservationHolder` gains `BARREL { facilityId, barrel }`; `ACTIVITY_KINDS` appends `MASH` and `DISTILL`; doc changes on `ProductionJobState` (a run, under founder rules; `conversionPrepaid`'s invariant counts washes, decision 5), `EmployeeWork.currentJobId` (the run they operate) and `DistillOrderTerms` (decision 9).
- `commands.ts`: `SetMashCommand`, `StartDistillationCommand` (types, `GameCommand`, `GAME_COMMAND_TYPES`); the reasons `TWO_STAGE_RECIPE { facilityId, recipeId }` and `NO_READY_WASH { facilityId, recipeId, readyAt }`.
- `events.ts`: `MASH_SET` and `DISTILLATION_STARTED` (decision 4): `"log"` in `EVENT_IMPORTANCE`, `null` in `EVENT_CONCERNS_PLACE`, never in `LoggedToastEventType`.
- `snapshot.ts`: `WashSnapshot`; `GameSnapshot.washes`; `FacilitySnapshot.barrels`; `RecipeOption.twoStage` (decision 8).
- `knowledge.ts`: `FACILITY_OPERATIONS` value gains `washes`; `TRANSACTION_PRODUCERS` gains `PRODUCTION_START:MASH` and `PRODUCTION_START:RUN` (call sites in TS2). The two `EMPLOYEE` families and their `CASH_POSTING_REVEALS` row land with their call sites in E1 (decision 12), as ADR 0025's did.
- `player-snapshot.ts`: `PlayerFacility`'s `Pick` gains `barrels`.
- `schemas.ts`, `save.ts`: Zod for all of the above; decision 13's bump and migration, with an old-version fixture.
- `packages/game-data`: `TwoStageTerms` and `RecipeDefinition.twoStage`; `FacilityProductionDefinition.barrels`; `ACTIVITY_DURATIONS` rows `MASH` and `DISTILL`; decision 2's load validation (the shift-fit and order-default checks read `ACTIVITY_DURATIONS` and the recipes, so they live in `personnel.ts`, which already imports `presence.ts`).
- `packages/simulation`: `SET_MASH` and `START_DISTILLATION` registered as **accepted no-ops with either flag** (validators accept every view), as EM1 did for the employee commands. `activityOf` doesn't map them yet, so they take no time. `START_PRODUCTION` keeps its current behaviour with the flag on until TS2. So the four founder-rules locked files stay green except `view/issuer-view`'s exhaustive `COVERAGE` (checklist §4).
- `apps/game`: the copy tables that are exhaustive over `RejectionCode`, `ActivityKind` and `GameEventType` gain PLACEHOLDER rows for the new members.

### 17. Follow-up tasks

| Task | What | Depends on | Mode |
|---|---|---|---|
| **TS1** | Decision 16's contract and game-data changes; save bump | This record | agent, contract review; step-1 re-lock of `view/issuer-view` |
| **TS2** | Two-stage behaviour under founder rules: `SET_MASH`, `START_DISTILLATION`, `TWO_STAGE_RECIPE` for `START_PRODUCTION`, the run length and the founder's `DISTILL` busy, storage counting washes, the `FACILITY_OPERATIONS` washes, `RecipeOption.twoStage`, the keyed failure draw for runs (if E1 hasn't built it), the `PRODUCTION_START:MASH`/`:RUN` producers, the PIP invariant over jobs and washes | TS1 | agent, **locked tests first**: a new `production/two-stage.locked.test.ts`, and re-locks of `walking-skeleton/path`, `founder/no-trap`, `knowledge/non-leak` and `view/issuer-view` (checklist §4) |
| **TS3** | UI: the still scene's actions ("set a mash" with a barrel count from `maxMashBarrels`, "distill" with `readyQuantity`), layers for barrels (fermenting, ready, with "as of") and the still running while the founder is busy distilling, and the browser e2e paths that start a batch under founder rules. M001's production panel is unchanged | TS2 | agent; visual direction and copy → `ready-for-human` |
| **E1 (#180)** | Implements decision 9 instead of ADR 0025's single-stage policy: mash then distill, the shift-fit rule, the authority change, the `batchSize` gate, the `EMPLOYEE:MASH`/`:RUN` producers, report lines | TS2 (add to its Depends on) | agent, locked tests first |
| **R1 (#176)** | The reachability check run on two stages, and the retune decision 15 lists: starting washes, `workerCount: 0`, cash, storage, order defaults, and `DISTILL` against the Distiller's hours | TS2 | agent, locked tests first |

The orchestrator files TS1–TS3 and adds the dependencies to #180 and #176 at their refresh. `PT2` (#181) judges the rhythm.

## Design-record checklist (factory.md §1)

### 1. Non-leak, per command and surface

Every input is always-known state (founder whereabouts including `busy`, cash, agreements including standing orders), game-data (`twoStage`, `barrels`, `ACTIVITY_DURATIONS`, `ROLE_TERMS`), the clock, the live view the founder stands in, knowledge, or a channel.

| Command or surface | Immediate result | Activity item | Catch-up | Books row | Snapshot field |
|---|---|---|---|---|---|
| `SET_MASH` (founder) | Decision 14's reasons: the command, game-data, founder state, and the live view at the facility (barrels, stock, storage), cash | `COMMAND` | None | `PRODUCTION_START:MASH`, rule 1 | The live view's `FACILITY_OPERATIONS.washes`; cash |
| `START_DISTILLATION` (founder) | Decision 14's reasons, the same inputs; `NO_READY_WASH.readyAt` from the live view | `COMMAND` | None | `PRODUCTION_START:RUN`, entry-less, rule 1 | `founder.busy` (`DISTILL`, `until`); the job in the live view |
| `START_PRODUCTION`, flag on | `TWO_STAGE_RECIPE`: the command's fields | `COMMAND` | None | None | None |
| Fermentation reaching `readyAt` | — | — | — | — | Nothing: no event, no transaction, no state change |
| A founder's run settling | — | None (the founder is there) | None | `PRODUCTION`/`_WRITE_OFF`, rule 1: posted at the founder's place while present | The live view |
| An employee's mash | None (ADR 0022 decision 5) | None | None | `PRODUCTION_START:EMPLOYEE:MASH`: a cash posting that reveals nothing (decision 12) | Cash |
| An employee's run starting | None | None | None | Entry-less, rule 4 | None until a channel |
| An employee's run settling | — | None | The station's `FACILITY_OPERATIONS`/`STOCK` diff on the next visit | Existing non-cash rows, pending until learned | None until a channel; `BATCH_FINISHED` through a report |
| A Distiller waiting for a shift that fits | — | None | None | None | None: no line, no state |
| `HIRE_EMPLOYEE` / `SET_STANDING_ORDER` with `batchSize < casesPerBarrel` | `INVALID_QUANTITY { field: "batchSize" }`: the command and game-data | `COMMAND` | None | None | None |
| `RecipeOption.twoStage` | — | — | — | — | From the known `FACILITY_STOCK`/`OPERATIONS` and the purse, like `RecipeOption` today |
| `FacilitySnapshot.barrels` | — | — | — | — | Game-data |

**The static half of ADR 0021 decision 9.** Two worlds that differ only in hidden state, given the same commands: the founder's mash and run commands are judged at a place the founder is standing in, so their inputs are in the live view, not hidden. The barrel a founder's mash takes, its `readyAt`, the run's `startedAt` and length, and the failure key are equal in both. Fermentation produces nothing observable, so a hidden wash's `readyAt` can differ between the worlds without any surface differing.

**The dynamic half.** No new channel. Washes ride in `FACILITY_OPERATIONS`, which every existing channel already delivers. So a channel that delivers differing washes is "a channel delivering a subject in D_t", as ADR 0021 and 0025's delivery clause already counts. An employee's mash is a cash posting, under the clause's "a cash posting that differs". K2's and the re-locked non-leak test's generators perturb hidden washes' `readyAt` and presence, as they perturb hidden jobs' `completesAt` today.

### 2. Coverage tables (ADR 0021 decisions 6 and 7)

Decision 12. Four new families: two by founder command (rule 1), one employee cash posting with a cash-posting row that reveals nothing (replacing ADR 0025's `PRODUCTION_START:EMPLOYEE` row), and one entry-less world family (rule 4). Runs settle through the existing `PRODUCTION` and `PRODUCTION_WRITE_OFF` rows. The books table (decision 7) gains nothing.

### 3. Migration

Decision 13: `washes: []` in `GameState` and in every saved `FACILITY_OPERATIONS` value. No source is needed: no earlier save can hold a wash. No game-data reads. `ProductionJobState` doesn't change, and a saved single-stage job settles as before.

### 4. Re-locks

Checked against the 14 `@locked` files (`grep -rl "@locked" packages/simulation/test`).

**Re-locked, by path and reason:**

- **`view/issuer-view.locked.test.ts`**, in TS1: its `COVERAGE` is `Record<RejectionCode, Coverage>` (line 1504), so the two new codes break its typecheck. TS1 adds them, as EM1 added five (#236). In TS2 again: its founder-rules cases call `START_PRODUCTION` for gate order (lines 1185–1260; "no materials" and "a recipe the still can't run" become `TWO_STAGE_RECIPE`), so they move to `SET_MASH` and `START_DISTILLATION`. `COVERAGE` then gets real coverage for both new codes. The validator check over `GAME_COMMAND_TYPES` (line 1044) passes once TS1 registers both validators.
- **`walking-skeleton/path.locked.test.ts`**, in TS2: its batch step is a single-stage `START_PRODUCTION` with a `START_BATCH` busy (line 813), and its invariant check sums `conversionPrepaid` over jobs only (lines 253, 271). The path becomes: buy, set a mash, ferment, distill (`DISTILL` busy), deliver, sleep. The invariant counts washes (decision 5), and its hidden-world plan perturbs washes as well as jobs (line 523).
- **`founder/no-trap.locked.test.ts`**, in TS2: its stocked setup applies `START_PRODUCTION` and waits for the batch (line 315), and its command generator offers it (line 580). Both move to `SET_MASH` and `START_DISTILLATION`, so the property exercises `DISTILL`, now the longest busy. `B`'s formula is unchanged and still read from `ACTIVITY_DURATIONS` (decision 10).
- **`knowledge/non-leak.locked.test.ts`**, in TS2: it applies `START_PRODUCTION` (lines 305, 639, 939, 979) and checks a `PRODUCTION` posting from a single-stage job while the founder is away (line 997). These move to the two stages: the away-from-founder example becomes a run settling with nobody watching (through a test hook, until E1 makes a Distiller), and the hidden-world plan perturbs washes (line 510).

**Not affected:** the ten flag-off files (`economy/fin-001`, `economy/market/eco-001`, `contracts/eco-001-contracts`, `inventory/fin-001`, `production/prod-001`, `production/prod-001-labor`, `progression/prog-001-reputation`, `progression/prog-001-outcome`, `commands/repeat`, `logistics/logistics`). They run with `founderRules: false`, where nothing changes (checklist §6). The types they build are unchanged: `ProductionJobState` keeps its shape (decision 3, the reason for option (c)), `RecipeDefinition` and `FacilityProductionDefinition` are read from `GAME_DATA` or spread with a patch, never written out in full (`prod-001-labor` line 277), and the `BARREL` holder is a new union member that their `holder.kind === "CONTRACT"` / `"PRODUCTION_JOB"` checks don't see. None enumerates `ACTIVITY_KINDS`, `GAME_COMMAND_TYPES` or `GameEventType` exhaustively.

The Sprint Zero reference hash (`test/sprint-zero/reference-hash.ts`, not locked) and the state-hash fixtures move by `washes: []`, and TS1 regenerates them.

### 5. Tick order

Decision 11. No new phase. Commands at the still apply first in the tick. `production` settles runs (and writes an employee's `BATCH_FINISHED`), `employees` mashes and distills, and `founder` ends a `MASH` or `DISTILL` busy. On the tick a `DISTILL` ends, the cases are in stock before the busy clears, and the founder is free from the next tick. On the tick a `MASH` ends, fermentation starts.

### 6. Flag off (`founderRules: false`)

`SET_MASH` and `START_DISTILLATION` apply as accepted no-ops (ADR 0025 decision 13's precedent), and lab strategies don't send them. `START_PRODUCTION`, the crew rules, `SET_WORKFORCE`'s check and settlement are M001's. `washes` stays `[]`. `twoStage`, `barrels`, `MASH` and `DISTILL` aren't read. `rng.production` is drawn as today. M001 and the lab play exactly as before, and their hashes move only by `washes: []`.

### 7. Randomness

**No new draw.** The run's failure draw is ADR 0025 decision 6's keyed one-shot, `keyedRng(seed, "production:<facilityId>", startedAt)`, under founder rules, where `startedAt` is the run's start. That's the founder's own command tick for a founder's run, so hidden activity can't move it, and the draw touches no shared stream. Fermentation, the shift-fit rule and the barrel choice draw nothing. With the flag off, `rng.production` as today. No shipped recipe can fail, so no draw happens yet.

### 8. Rejection reasons

Decision 14. **New:** `TWO_STAGE_RECIPE { facilityId, recipeId }` and `NO_READY_WASH { facilityId, recipeId, readyAt }`. **Reused:** `INVALID_QUANTITY` (`barrels`, and `batchSize` for an order), `UNKNOWN_ENTITY`, `NOT_PRESENT`, `FOUNDER_BUSY`, `RECIPE_NOT_SUPPORTED`, `PRODUCTION_CAPACITY_EXCEEDED` (no free barrel, or a run going), `STORAGE_CAPACITY_EXCEEDED`, `INSUFFICIENT_MATERIALS`, `INSUFFICIENT_FUNDS`, `OUTSIDE_AUTHORITY`, `RESERVATION_NOT_ACTIVE`. **Not reasons:** fermenting wash, ready wash waiting, and a run that doesn't fit a shift. Every payload is the command, game-data or the live view.

## Consequences

- **Production has a rhythm.** Set a mash, leave for four and a half days, come back to run the still for most of a day. Time at the still is now the scarce thing, and being away costs only idle barrels, never lost wash.
- **The first hire's relief is concrete.** Without a Distiller, every cycle costs the founder about eight hours tied to the still, plus being there when the wash is ready. With one, the founder's production job is the supply run to Miller's.
- **Paying at the mash keeps every mash sellable.** A founder who spends their last cash on a mash can always turn it into cases. The cash leaves at the mash, in person, as it did at the start of a batch.
- **Workers have no production role in M002.** SK1d's stand-in goes, and the M002 wage bill drops by its $2.00 a day. Abstract labour gets a job again only if a later record gives it one.
- **The opening needs barrels already full** (decision 15), or the first five days have nothing to sell. R1 builds it.
- **Competence matters less to output** (decision 15). T-LAB and PT2 judge whether the wage range still reads as a choice.
- **A single-stage `START_PRODUCTION` disappears from founder-rules play.** The four founder-rules locked files that used it are re-locked in TS1 and TS2, and M001's ten are untouched.

## Needs design (placeholders in this record)

Story and visual direction (factory.md §8). The human decided the rhythm (#241). Still open, as PLACEHOLDER until the human decides:

- **Player-facing words** for the new actions and states: "set a mash", "distill", "wash", "fermenting", "ready", the barrel count, and the `DISTILL` busy line in the scene. Also the copy for `TWO_STAGE_RECIPE` (which the UI shouldn't reach) and `NO_READY_WASH`.
- **Report wording on two stages:** `BATCH_STARTED` now means a mash set, and it has no approved line (#224 approved "batch" wording for completions, failures, holds and limits, which decision 9 maps).
- **How the still scene shows barrels** (visual direction, TS3): fermenting and ready barrels, how stale a "ready" is, and the founder at the still for a run.

Tuning (orchestrator, not human): `fermentTicks`, `casesPerBarrel`, `barrels`, `MASH`, `DISTILL` (450–480 while the competence and tiredness factors keep every run inside 6–12 hours, decision 2), the M002 opening washes, `workerCount`, storage and the order defaults, all for R1, PT2 and T-LAB inside the human's ranges.
