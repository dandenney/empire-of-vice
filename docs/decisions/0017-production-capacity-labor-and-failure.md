# 0017: Production capacity, labor, and failure

Status: accepted (decided by the orchestrator while refreshing T02c, issue #7; implemented in T02c1 and T02c2)

## Context

GDD §6 (PROD-001) says a facility has equipment slots, recipes, workforce, capacity, storage, and operating costs. Starting a job reserves inputs and capacity, labor and overhead go into the cost basis, and purchases have to respect cash, slots, eligibility, and capacity. GDD §10 gives the founder and the foreman skill, loyalty, and a wage, and treats generic workers as abstract labor. SIM-001 settles recurring costs at midnight. GDD §14.3 leaves recipes, wages, durations, and throughput open.

Main also constrains the design:

- Locked tests read `RecipeDefinition.ticksPerCase` and expect a basic job to take `ticksPerCase × cases` ticks.
- The Sprint Zero hash is pinned in the app's e2e test.
- The app's copy tables are exhaustive over `RejectionCode` and `TransactionKind`, so a new code or kind needs a coordinated contract task.

## Decision

1. **Throughput.** A facility's throughput is a `Ratio`. It is 1× plus the `throughputBonus` of the equipment it owns (the improved condenser adds 40%), times the crew factor `min(workers, crew) / crew`. `crew` is the sum of the crew of the owned equipment. A facility that owns no recipe equipment has zero throughput. A job takes `ceil(ticksPerCase × quantity × 1 000 000 / throughput)` ticks, computed in BigInt. `completesAt` is fixed when the job starts (ADR 0008), so later equipment or workforce changes don't re-time a running job.
2. **One job at a time per facility.** A running job holds the facility's capacity. Starting a second one is rejected with `PRODUCTION_CAPACITY_EXCEEDED { available: 0 }`.
3. **Storage.** Capacity is the facility's `baseStorage` plus the `storageBonus` of the equipment it owns. A start is rejected with `STORAGE_CAPACITY_EXCEEDED` when the finished cases held, plus the output of running jobs, plus the new quantity would exceed capacity. Materials don't count (ADR 0013 decision 5). Completion never fails for lack of space. Other inflows use the same helpers in their own tasks (T03).
4. **Facility numbers** live in `packages/game-data/src/facilities.ts`, keyed by `FacilityId`: equipment slots, base storage, maximum workers, and daily overhead.
5. **Failure.** Each recipe has a `failureChance` (a `Ratio`).
   - **Draw.** At completion, if the chance is above 0, one `nextInt(rng.production, 1 000 000)` draw that falls below it fails the job. At 0, nothing is drawn.
   - **Consuming inputs and charging cost.** A failed job consumes its reserved inputs (`consumeReservations`). It is charged its conversion cost just as a completed job would be: from cash first, then `WAGES_PAYABLE`.
   - **Write-off.** Everything is written off to `LOSSES` in a `PRODUCTION_WRITE_OFF` transaction keyed `PRODUCTION_WRITE_OFF:<jobId>`.
   - **Events.** It emits `RESERVATION_RELEASED { reason: "PRODUCTION_FAILED" }` for each reservation, then `PRODUCTION_FAILED { reason: "DISRUPTION", writtenOff }`. `writtenOff` is the whole `LOSSES` debit, materials plus conversion.
   - **This amends ADR 0013 rule 4**, which named only the removed materials.
   - **M001 data** sets every `failureChance` to 0 until the balance lab tunes it.
6. **Equipment purchase.** A facility can own one of each item (`EQUIPMENT_ALREADY_OWNED`), and each item uses a slot (`NO_EQUIPMENT_SLOT`). If an item has a `requiredUnlockId`, that unlock must be in `family.unlocked` (`LOCKED`); T05 sets the QC station's. The family must have the cash (`INSUFFICIENT_FUNDS`). A purchase posts Dr `EQUIPMENT` / Cr `CASH` at the price, which becomes the item's book value.
7. **Two labor costs, each defined once.**
   - **Conversion cost.** A recipe's `laborPerCase` + `overheadPerCase` is the variable cost of a run. It is capitalized into the goods when the job completes, and paid in cash or accrued to `WAGES_PAYABLE`, as in FIN-001's worked example.
   - **Period costs.** Daily wages (the leaders' `dailyWage`, plus workers × `workerDailyWage`) and each facility's `dailyOverhead` are expensed at midnight and never capitalized.
   - Game-data defines each cost once, so no labor is counted twice.
8. **Workforce.** `SET_WORKFORCE` rejects a count above the facility's maximum with `WORKFORCE_LIMIT_EXCEEDED`. While a job runs there, it also rejects a count below `min(workerCount, crew)`, with `INVALID_QUANTITY { field: "workerCount" }` until a dedicated code exists. It commits a `DAILY_SETTLEMENT` transaction with no entries, keyed `DAILY_SETTLEMENT:WORKFORCE:<commandId>`, and emits `WORKFORCE_CHANGED`.
9. **Midnight settlement.** The production system's midnight hook commits three transactions in order. `<day>` is the day that just ended.
   1. Tonight's wages, in `DAILY_SETTLEMENT:WAGES:<day>`, paid in cash or accrued to `WAGES_PAYABLE`.
   2. Tonight's overhead, in `DAILY_SETTLEMENT:OVERHEAD:<day>`, paid or accrued the same way.
   3. Earlier `WAGES_PAYABLE` paid down from the remaining cash, in `DAILY_SETTLEMENT:PAYROLL:<day>`. This one always commits and carries `DAY_SETTLED` with the night's totals.

   Separate transactions let the cash flow statement report `WAGES` and `OVERHEAD` separately (ADR 0015). The market's midnight hook (ADR 0016) runs first, in registration order. The two hooks touch disjoint state.
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

- The basic recipe keeps S0's numbers, and a zero failure chance draws no RNG, so the Sprint Zero hash is unchanged.
- Hiring matters once the condenser is bought: the full +40% needs 4 workers. Laying off workers a running job needs is blocked, so skipping wages isn't a strategy.
- Two stand-ins wait for one contract task, which can run once the app's copy tables can be updated alongside it:
  - `INVALID_QUANTITY` stands in for a "workforce in use" code.
  - `DAILY_SETTLEMENT` stands in for a workforce transaction kind.
- Other tasks pick up from here:
  - T03 calls `storageCapacity` and `storageCommitted` for returned cargo.
  - T05 sets the QC station's `requiredUnlockId`.
  - T07a and T07 tune failure chances, wages, overhead, slots, and storage.
