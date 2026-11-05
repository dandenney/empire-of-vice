# 0017: Production capacity, labor, and failure

Status: accepted (decided by the orchestrator while refreshing T02c, issue #7; implemented in T02c1 and T02c2)

## Context

GDD §6 (PROD-001) says a facility has equipment slots, recipes, workforce, capacity, storage, and operating costs. Starting a job reserves inputs and capacity, labor and overhead go into the cost basis, and purchases have to respect cash, slots, eligibility, and capacity. GDD §10 gives the founder and the foreman skill, loyalty, and a wage, and treats generic workers as abstract labor. SIM-001 settles recurring costs at midnight. GDD §14.3 leaves recipes, wages, durations, and throughput open.

Main also constrains the design:

- Locked tests read `RecipeDefinition.ticksPerCase` and expect a basic job to take `ticksPerCase × cases` ticks.
- The Sprint Zero hash is pinned in the app's e2e test.
- The app's copy tables are exhaustive over `RejectionCode` and `TransactionKind`, so a new code or kind needs a coordinated contract task.

## Decision

1. **Throughput.**
   - **Terms.**
     - `base = RATIO_SCALE + Σ throughputBonus` of the facility's owned equipment. The improved condenser adds 400 000.
     - `crew` = the sum of the owned equipment's `crew`. In game-data the still is 3, the condenser 1, and the QC station and storage expansion 0.
     - `staffed = min(workers, crew)`.
     - The crew factor is `staffed / crew`. When `crew = 0`, the factor is 1×.
   - **Zero throughput.** A facility's throughput is **0** if it owns no equipment that any recipe requires, or if `crew > 0` and `staffed = 0`.
   - **Duration.** Otherwise a job takes `ceil(ticksPerCase × quantity × RATIO_SCALE × crew / (base × staffed))` ticks, computed exactly in BigInt with no intermediate rounding. When `crew = 0`, use `crew = staffed = 1`. The crew factor is folded into this one division, so durations never pass through a rounded throughput.
   - **Displayed ratio.** The throughput `Ratio` the snapshot shows (and `productionCapacityPerDay`) is `floor(base × staffed / crew)` ppm. It is for display only.
   - **T02c1** has no crew yet, so it uses `crew = staffed = 1`. Its `jobDuration(recipe, quantity, throughput)` then equals the formula above. T02c2 extends the helper to take the crew terms, and the results for a full crew stay the same.
   - Example: the still alone, 2 of 3 workers, 10 cases of a 1 440-tick recipe gives `ceil(1440 × 10 × 3 / 2)` = 21 600 ticks.
   - `completesAt` is fixed when the job starts (ADR 0008). Later equipment or workforce changes don't re-time a running job.
   - When several jobs complete on the same tick, they're processed in job ID order (`compareIds`), and so are their failure draws.
2. **One job at a time per facility.** A running job holds the facility's capacity. Starting a second one is rejected with `PRODUCTION_CAPACITY_EXCEEDED { requested, available: 0 }`. So is a start at a facility whose throughput is 0 (decision 1).
3. **Storage.** Capacity is the facility's `baseStorage` plus the `storageBonus` of the equipment it owns. A start is rejected with `STORAGE_CAPACITY_EXCEEDED` when the finished cases held, plus the output of running jobs, plus the new quantity would exceed capacity. Materials don't count: this is T02a refresh decision 5 (issue #5), implemented as `storageUsed`. GDD §6 also limits jobs whose "reserved inputs" would exceed capacity. That half is covered by `INSUFFICIENT_MATERIALS`: inputs must already be in stock (and so already stored) before a job can reserve them. A start therefore adds no new material to storage, and storage counts finished cases only. Completion never fails for lack of space. Other inflows use the same helpers in their own tasks (T03).
4. **Facility numbers** live in `packages/game-data/src/facilities.ts`, keyed by `FacilityId`: equipment slots, base storage, maximum workers, and daily overhead.
5. **Failure.** Each recipe has a `failureChance` (a `Ratio`).
   - **Draw.** At completion, if the chance is above 0, one `nextInt(rng.production, 1 000 000)` draw that falls below it fails the job. At 0, nothing is drawn.
   - **Consuming inputs and charging cost.** A failed job consumes its reserved inputs (`consumeReservations`). It is charged its conversion cost just as a completed job would be: from cash first, then `WAGES_PAYABLE`.
   - **Write-off.** Everything is written off to `LOSSES` in a `PRODUCTION_WRITE_OFF` transaction keyed `PRODUCTION_WRITE_OFF:<jobId>`.
   - **Events.** It emits `RESERVATION_RELEASED { reason: "PRODUCTION_FAILED" }` for each reservation, then `PRODUCTION_FAILED { reason: "DISRUPTION", writtenOff }`. `writtenOff` is the whole `LOSSES` debit, materials plus conversion.
   - **This amends ADR 0013 rule 4**, which named only the removed materials.
   - **M001 data** sets every `failureChance` to 0 until the balance lab tunes it.
6. **Equipment purchase.** The checks run in this order:
   1. `UNKNOWN_ENTITY`
   2. one of each item per facility (`EQUIPMENT_ALREADY_OWNED`)
   3. the item's `requiredUnlockId`, if set, must be in `family.unlocked` (`LOCKED`). T05 sets the QC station's
   4. each item uses a slot (`NO_EQUIPMENT_SLOT`)
   5. cash (`INSUFFICIENT_FUNDS`)

    A purchase posts Dr `EQUIPMENT` / Cr `CASH` at the price, which becomes the item's book value.
7. **Two labor costs, each defined once.**
   - **Conversion cost.** A recipe's `laborPerCase` + `overheadPerCase` is the variable cost of a run. It is capitalized into the goods when the job completes, and paid in cash or accrued to `WAGES_PAYABLE`, as in FIN-001's worked example.
   - **Period costs.** Daily wages (the leaders' `dailyWage`, plus workers × `workerDailyWage`) and each facility's `dailyOverhead` are expensed at midnight and never capitalized.
   - Game-data defines each cost once, so no labor is counted twice.
8. **Workforce.** `SET_WORKFORCE` rejects a count above the facility's maximum with `WORKFORCE_LIMIT_EXCEEDED`. While a job runs there, it also rejects a count below `min(workerCount, crew)`, with `INVALID_QUANTITY { field: "workerCount" }` until a dedicated code exists. It commits a `DAILY_SETTLEMENT` transaction with no entries, keyed `DAILY_SETTLEMENT:WORKFORCE:<commandId>`, and emits `WORKFORCE_CHANGED`. Setting the current count is accepted as a no-op: there is no transaction, no event, and no state change.
9. **Midnight settlement.** The production system's midnight hook commits three transactions in order. `<day>` is the day that just ended.
   1. Tonight's wages, in `DAILY_SETTLEMENT:WAGES:<day>`, through `payOrAccrueEntries(amount, cashBalance)`. This transaction is **skipped when the amount is 0**.
   2. Tonight's overhead, in `DAILY_SETTLEMENT:OVERHEAD:<day>`, the same way. It is also skipped when the amount is 0.
   3. Earlier `WAGES_PAYABLE` paid down in `DAILY_SETTLEMENT:PAYROLL:<day>`, by `min(WAGES_PAYABLE balance, cashBalance)`. This one **always commits**, even with no entries, and carries `DAY_SETTLED`.

   Each step reads `cashBalance` as it stands after the previous step commits, so cash never goes negative. The `DAY_SETTLED` fields are:
   - `wagesDue`: tonight's wages
   - `overheadDue`: tonight's overhead
   - `paidInCash`: the cash credited by steps 1 and 2, **excluding** the paydown
   - `addedToLiabilities`: the `WAGES_PAYABLE` credited by steps 1 and 2
   - `liabilitiesPaid`: step 3's paydown. In M001 that's `WAGES_PAYABLE` only; `PENALTIES_PAYABLE` paydown is T02e's
   - `transactionId`: step 3's ID

   Overhead that has to accrue goes to `WAGES_PAYABLE`, so its later paydown shows under `WAGES` in the cash flow statement (ADR 0015).

   Separate transactions let the cash flow statement report `WAGES` and `OVERHEAD` separately (ADR 0015). The market's midnight hook (ADR 0016) runs first, in registration order. SIM-001 step 5 lists settling costs before replenishing supply, but the two hooks touch disjoint state (the ledger and payables here; markets, suppliers and buyers there), so the order has no observable effect beyond transaction IDs, and registration order fixes those.
10. **Leaders** have skill and loyalty (0–100) and a daily wage in game-data, and the snapshot shows them. In M001 neither skill nor loyalty has a mechanical effect.

## Alternatives considered

- **Throughput:**
  - As a cases-per-day facility figure. This drops the per-recipe time the locked tests read.
  - As per-tick job progress. This needs a contract change to `ProductionJobState`.
- **Job queue or concurrent jobs per facility:** more scheduling rules for little M001 gain. `storageCommitted` already counts running jobs, so a queue can come later.
- **Checking storage at completion** and failing or spilling the job: this turns a planning check into a surprise loss.
- **Other failure rules:**
  - Failure never happening, which leaves the write-off path dead.
  - Failing a job when workers are laid off, so a staffing slip destroys a batch.
- **Writing off only a failed job's materials:** this makes failure free in conversion terms.
- **Other labor costing:**
  - Absorption costing, where labor moves out of wages expense at completion and payroll is paid at midnight. This needs under- and over-absorption handling and changes S0's ledger.
  - Daily wages only. This contradicts FIN-001's example.
  - Accruing all conversion cost to `WAGES_PAYABLE`. This changes the pinned S0 hash.
- **Other settlement shapes:**
  - One settlement transaction, which ADR 0015 would file entirely under WAGES.
  - A list of transaction IDs on `DAY_SETTLED`, which needs a contract change.
- **Recording workforce changes:**
  - Emitting `WORKFORCE_CHANGED` outside the coordinator. This breaks the ADR 0010 amendment.
  - A new transaction kind. This needs a contract change while the app's copy tables are exhaustive.
- **A foreman skill bonus to throughput:** a tuning knob before there's a lab to tune it.

## Consequences

- The basic recipe keeps S0's numbers, and a zero failure chance draws no RNG. The S0 path also ends before the first midnight (tick 1440), so neither T02c1 nor T02c2's settlement changes the Sprint Zero hash.
- The comment at `test/inventory/fin-001.locked.test.ts:43` describes the old write-off. Its assertion still holds, because that test's job has no conversion cost. The comment is stale but locked, so leave it as is.
- Hiring matters once the condenser is bought: the full +40% needs 4 workers. Laying off workers a running job needs is blocked, so skipping wages isn't a strategy.
- Two stand-ins wait for one contract task, which can run once the app's copy tables can be updated alongside it:
  - `INVALID_QUANTITY` stands in for a "workforce in use" code.
  - `DAILY_SETTLEMENT` stands in for a workforce transaction kind.
- Other tasks pick up from here:
  - T03 calls `storageCapacity` and `storageCommitted` for returned cargo.
  - T05 sets the QC station's `requiredUnlockId`.
  - T07a and T07 tune failure chances, wages, overhead, slots, and storage.
