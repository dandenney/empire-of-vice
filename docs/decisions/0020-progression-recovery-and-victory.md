# 0020: Progression, scenario, recovery, and victory

Status: accepted (decided by the orchestrator while refreshing T05, issue #13; implemented by the T05 split issues)

## Context

GDD §9 (PROG-001) defines tiers, example reputation adjustments, repeat orders, and recovery. §4 fixes the scenario (January 17, 1920, seed 1920, $1,000 cash, one small distillery with a copper still, one truck, three buyers, founder and foreman, one disruption source) and the victory condition ($5,000 net worth, reputation ≥ 30, one completed recurring contract). §14 leaves three details to T05: the starting balance sheet (§14.1), the starting reputation (§14.2), and the recovery mechanism (§14.9). Issue #13 also asks for tier unlocks, a repeat order, and victory, with comments that this ADR routes (Consequences).

**Already decided or built on main.** This ADR doesn't reopen these:

- **Contracts.**
  - `FamilyState { reputation, tierId, unlocked, firstQualifyingDeliveryMade, consecutiveFulfilledInstallments }`; `GameState.outcome` (`PLAYING | WON | LOST { INSOLVENT }`).
  - Events: `REPUTATION_CHANGED { from, to, reason, deliveryId, contractId }` with `ReputationChangeReason`, `TIER_REACHED`, `UNLOCK_GRANTED`, `VICTORY_ACHIEVED { netWorth, reputation, completedContractId }`, and `GAME_LOST { INSOLVENT }`.
  - Snapshot: `ProgressionSnapshot`, `TierSnapshot`, and `VictoryProgress`, whose `completedContracts` counts "contracts with every installment settled".
  - Commands and reasons: `REPEAT_OPERATION { sourceCommandId }`, `RepeatableCommand` (purchase, production, dispatch), `NOT_REPEATABLE`, `LOCKED`, `REPUTATION_TOO_LOW`.
  - Asset sales: the `ASSET_SALE` transaction kind, the `GAIN_ON_ASSET_SALE` account, and the `ASSET_SALES` cash-flow category.
  - The coordinator's invariant that reputation stays in 0–100 (ADR 0010).
- **Built.**
  - `new-game.ts` books the opening balance: cash and buildings come from the scenario, equipment at its catalog price, the truck at its `bookValue`, and owner equity balances the sheet.
  - Buyers (ADR 0016) and contract offers (ADR 0018) check `minimumReputation`. Equipment and contract terms check `requiredUnlockId`.
  - **Missing.** Nothing applies reputation, promotes tiers, or sets `outcome`. `REPEAT_OPERATION` has no handler. The snapshot reports placeholder tiers and victory targets (`UNDEFINED_IN_GAME_DATA`).
- **Earlier ADRs.**
  - ADR 0018 decision 10: T05 applies installment reputation "from those events" (`INSTALLMENT_SETTLED`, `CONTRACT_COMPLETED`).
  - ADR 0019 decision 4: a failed spot deal changes no reputation. Decision 5: T05 schedules route closures.
  - ADR 0017: a running job's `completesAt` is fixed when it starts.
- **Locked tests constrain the design.** The ones that matter here:
  - `test/contracts/eco-001-contracts.locked.test.ts` pins `contracts.terms.requiredUnlockId` to `null`. It expects Kessler's offer at tick 1 440 in a default game, and it asserts the exact event list of each `INSTALLMENT_SETTLEMENT` transaction.
  - The logistics, PROD-001, and ECO-001 locked tests pin the route table, the truck's 20 cases, the crew numbers, the condenser's +40%, and the basic recipe's 144 ticks per case.
  - `test/production/prod-001.locked.test.ts` asserts the first purchase's key `EQUIPMENT_PURCHASE:<facility>:<equipment>`.
  - The Sprint Zero path sells **one** case.
- **The GDD tier table can't be reached as written.** The GDD's reputation sources are the first qualifying delivery (+3, once) and installment outcomes. Without contracts, reputation tops out at 3, yet tier 2 (reputation 10) is what unlocks recurring contracts.
- **The T07a smoke report (#85, on #13).** A greedy spot seller loses money under the placeholders: the median net worth falls from an opening $2,500. The opening cash also covers the condenser at tick 1. That bot never accepts contracts, so it can't meet a victory condition that needs a completed contract and reputation 30.

## Decision

Every number below is **PLACEHOLDER** tuning in `packages/game-data` (CLAUDE.md rule 3) unless it's quoted from the GDD. Display names are placeholder story content (factory.md §8).

1. **Opening balance sheet (§14.1).** The structure on main stands; this decision fixes what is valued and how.
   - **Assets**, each at cost (GDD §2 assumption 3):
     - cash: $1,000 (GDD §4)
     - the distillery building: $800, from `openingBalance.buildings`
     - the copper still: $300, its catalog price
     - the truck: $400, its `bookValue`; vehicles aren't purchasable in M001
   - **No starting inventory.** The first profitable sale already comes at 2.2 real minutes (#85), so starter ingredients would buy nothing.
   - **No liabilities.** Owner equity, $2,500, balances the sheet.
   - **Opening net worth is $2,500.** That already meets tier 2's and tier 3's wealth thresholds ($1,500 and $2,500). So reputation is the early gate, and wealth binds at tier 4 and victory. T05g and T07 may move the building value; the opening cash stays $1,000.
2. **Starting reputation (§14.2): 0**, the GDD default. Decision 5's rules make tiers 2–4 reachable inside the session. For a contract accepted on day 1 (installments at 18:00 on days 3, 5, and 7, per ADR 0018):

   | When | Change | Reputation | Unlocks reachable |
   |---|---|---:|---|
   | First delivery of ≥ 5 cases | +3 | 3 | |
   | Day 3, installment 0 fulfilled | +5 | 8 | |
   | Day 5, installment 1 fulfilled | +5, +2 consecutive | 15 | tier 2 (10) |
   | Day 7, installment 2 fulfilled | +5, +2 | 22 | tier 3 (20), if net worth ≥ $2,500 |
   | A second contract's first two installments (Kessler's again from day 8, or Lakeview's once standard moonshine exists) | +7, +7 | 29, 36 | reputation 30 |

   Reputation alone would allow victory around days 10–12, inside the 15-day window. Net worth is the binding constraint, and tuning it is T05g's job (decision 15).
3. **Tier ladder and unlocks.** The GDD table moves recurring contracts to tier 1. That's a deliberate deviation, and the human can veto it.

   | Tier (`TierId`) | Net worth | Reputation | Unlocks (`UnlockId`) | Gates |
   |---|---:|---:|---|---|
   | `starting-operation` | none | none | `spot-sales` | nothing (descriptive). Recurring contracts are open from the start, as T02e built them |
   | `trusted-supplier` | $1,500 | 10 | `capacity-equipment` | the improved condenser and storage expansion (`requiredUnlockId`) |
   | `established-producer` | $2,500 | 20 | `quality-equipment` | the QC station, and so standard moonshine |
   | `regional-distributor` | $5,000 | 30 | `next-region` | nothing in M001 |

   - **Thresholds** are the GDD's.
   - **Display names** are the GDD's tier names, marked PLACEHOLDER until the human confirms them.
   - **`contracts.terms.requiredUnlockId` stays `null`.**
   - **"Improved buyers"** (GDD tier 3) are delivered through reputation-gated buyer access (Lakeview's `minimumReputation`) and standard moonshine, not through an unlock.
   - **Why the deviation.** The table as written is a cycle: contracts need tier 2, and tier 2 needs reputation that only contracts give. The options are below. Option C keeps the shipped and locked T02e behavior, needs no new reputation source, and gives tier 2 a real unlock. Gating the condenser also answers #85's "upgrade affordable at tick 1": the first upgrade now lands at tier 2, around day 5 (about 10 real minutes, inside GDD §13's 10–15 minute target).
4. **Tier promotion.**
   - **Order.** Tiers are ordered as listed.
   - **The rule.** The family is promoted to tier *k* when it holds tier *k*−1, net worth ≥ *k*'s threshold, and reputation ≥ *k*'s threshold. A `null` threshold always passes. Several tiers can be reached on one tick, in ascending order.
   - **Transaction.** Each promotion is one `PROGRESSION` transaction with no entries, keyed `PROGRESSION:TIER:<tierId>`. It:
     - sets `family.tierId`;
     - adds the tier's unlocks to `family.unlocked`, sorted and without duplicates;
     - emits `TIER_REACHED`, then one `UNLOCK_GRANTED` per newly held unlock, in the tier's listed order.
   - **Never revoked.** Tiers and unlocks are never taken back, even if net worth or reputation later falls (GDD §9).
   - **The starting tier** is set by the scenario and emits nothing.
5. **Reputation.**
   - **Rules data** (`progression.reputation`):
     - `firstQualifyingDelivery` +3
     - `qualifyingDeliveryMinimumCases` 5
     - `installmentFulfilled` +5
     - `consecutiveInstallmentBonus` +2
     - `installmentPartial` −3
     - `installmentMissed` −8

     The bounds 0–100 are the contract invariant, not data.
   - **Source events.** The progression system's `deadlines` hook (decision 8) reads the events stamped with the current tick (`state.eventJournal` entries with `tick === ctx.tick`) in ID order. These are `SALE_COMPLETED` from this tick's arrivals and `INSTALLMENT_SETTLED` from this tick's settlements. This is ADR 0018 decision 10's "from those events". The kernel trims the journal only after a whole tick or a whole command (`#commit`), so the hook sees every event of its tick.
   - **First qualifying delivery.** A `SALE_COMPLETED` (spot or contract) whose cargo totals ≥ 5 cases, while `firstQualifyingDeliveryMade` is false.
     - Transaction: `PROGRESSION:FIRST_DELIVERY`. The key itself enforces once per game.
     - It sets the flag and applies +3 with reason `FIRST_QUALIFYING_DELIVERY`, carrying the event's `deliveryId` and `contractId`.
     - **The Sprint Zero path's one-case sale doesn't qualify.**
   - **Installments.** Each `INSTALLMENT_SETTLED` gets a transaction keyed `PROGRESSION:INSTALLMENT:<contractId>:<index>`, with `deliveryId: null`:
     - `FULFILLED`: the streak `consecutiveFulfilledInstallments` goes up by 1. It applies +5 (`INSTALLMENT_FULFILLED`), then +2 (`CONSECUTIVE_INSTALLMENT`) if the streak is now ≥ 2.
     - `PARTIAL`: −3 (`INSTALLMENT_PARTIAL`), and the streak resets to 0.
     - `MISSED`: −8 (`INSTALLMENT_MISSED`), and the streak resets to 0.
     - The streak is family-wide, in settlement order, across contracts. In M001 a late delivery is credited to nothing (ADR 0018 decision 6), so "late" is covered by `PARTIAL` or `MISSED`.
   - **Clamping and recording.**
     - Each change is clamped to 0–100.
     - `REPUTATION_CHANGED` is emitted only when `to ≠ from`.
     - A transaction commits only if it changes state (reputation, the streak, or the flag). Otherwise nothing is posted.
   - **Separate transactions.** A reputation change is never inside its cause's transaction. The locked ECO-001 contracts test asserts the exact events of each settlement transaction.
   - **Unused in M001.** `PRODUCT_REJECTED` (a mismatched cargo is rejected at dispatch, before anything ships) and `DEAL_FELL_THROUGH` (ADR 0019 decision 4).
   - **Anti-farming (GDD §9).**
     - Spot sales earn reputation once per game, and only for a delivery of ≥ 5 cases.
     - Installment reputation is per installment, not per delivery, so splitting a delivery earns nothing.
     - The most one contract can add is +19 (+3 once more for the first qualifying delivery).
6. **The unlock graph is acyclic and reachable.** T05e's static test checks over `GAME_DATA`:
   - tiers have unique IDs, the first tier has `null` thresholds, and both thresholds are non-decreasing up the ladder;
   - every `UnlockId` is granted by exactly one tier;
   - every `requiredUnlockId` in game-data (equipment, contract terms) is granted by some tier;
   - for each tier *k* ≥ 2, its reputation threshold is reachable with only what tiers below *k* grant. Concretely, some contract buyer with `minimumReputation` ≤ the scenario's starting reputation must exist:
     - with contract `requiredUnlockId` null or granted below *k*;
     - whose product has a recipe that needs only equipment that's ungated or gated below *k*.

     (Kessler's basic contract and the copper still satisfy this for every tier.)

   Dynamic reachability, meaning a bot actually reaching tier 4 and victory, is T05g's lab criterion.
7. **Victory.**
   - **Conditions.** While `outcome` is `PLAYING`, all of these hold:
     - `balanceSheet(state).netWorth ≥ victory.netWorth` ($5,000)
     - `reputation ≥ victory.reputation` (30)
     - at least `victory.completedContracts` (1) contract with status `COMPLETED`
   - **"Completed".** That's GDD §7's definition, already in the contract's doc comment: every installment settled, whatever the outcomes. Reputation 30 already penalizes missed installments.
   - **Transaction.** One `PROGRESSION` transaction keyed `PROGRESSION:VICTORY`. It sets `outcome = { status: "WON", tick }` and emits `VICTORY_ACHIEVED`.
   - **`completedContractId`** is the first `COMPLETED` contract in `state.contracts` order.
   - **The thresholds** live in `progression.victory`. They are GDD §2's approved assumption 5, so tuning doesn't change them.
8. **When things are evaluated.**
   - **Registration.** The progression system is appended to `SYSTEMS` last, after contracts (and after the repeat line, decision 11).
   - **Its `deadlines` hook** runs every tick, in this order: reputation (decision 5), tier promotion (decision 4), then victory (decision 7). Net worth only rises through sales (the vehicles phase) and reputation only through this hook, so a victory is detected on the tick it becomes true.
   - **Its `midnight` hook** runs last at midnight, after payroll and penalty paydown. It checks for insolvency (decision 10).
   - **The outcome is terminal and sticky.** Victory and loss are checked only while `PLAYING`, and the first one wins. The simulation doesn't freeze after `WON` or `LOST`: commands and ticks keep working, and reputation and tiers keep updating. So after a victory the player can keep playing. What the end screen offers is T06's call.
9. **Recovery: asset sales (§14.9).** This needs a new command (decision 14).
   - **`SELL_EQUIPMENT { facilityId, equipmentId }`.** Rejections, in order:
     1. `UNKNOWN_ENTITY` for the facility, then for the equipment definition
     2. `EQUIPMENT_NOT_OWNED`
   - **Resale value.** `applyRatios(bookValue, [progression.recovery.equipmentResaleRatio])`, with the ratio at 500 000 ppm (50%). The ratio is validated in (0, 1 000 000).
   - **Transaction.** One `ASSET_SALE` transaction keyed `ASSET_SALE:<commandId>`:
     - posts Dr `CASH` the proceeds, Dr `LOSSES` (book value − proceeds), Cr `EQUIPMENT` the book value;
     - removes the item from the facility;
     - emits `EQUIPMENT_SOLD`.
     - Cash flow files it under `ASSET_SALES`: the `EQUIPMENT` and `LOSSES` lines disagree, so the kind default applies (ADR 0015). `GAIN_ON_ASSET_SALE` stays unused in M001.
   - **What a sale doesn't change.** A running job's `completesAt` was fixed at its start, so selling equipment mid-run doesn't affect it. Workers stay employed; the player can lay them off. Selling a storage expansion may leave the facility over capacity, which is allowed, as for returned cargo (ADR 0019 decision 4).
   - **Not sellable.** The truck (selling it would end every route to revenue) and the building.
   - **Buying the item back.** The first purchase of an item at a facility keeps the key `EQUIPMENT_PURCHASE:<facility>:<equipment>`, which the PROD-001 locked test asserts. A purchase made when that key already exists uses `EQUIPMENT_PURCHASE:<facility>:<equipment>:<commandId>`. Without this, buying back a sold item would be swallowed as a duplicate.
   - **Snapshot.** Each owned equipment entry shows its `resaleValue`.
10. **Insolvency (`GAME_LOST { INSOLVENT }`) and the minimum restart path (§14.9).**
    - **The minimum restart path:**
      1. sell equipment the recipe doesn't need;
      2. buy one case's inputs;
      3. start a one-case run, hiring a worker if there are none (hiring costs no cash now; wages accrue);
      4. dispatch to a spot buyer on the safe route (no dispatch funds check, ADR 0019 decision 2).
    - **When the family is insolvent.** At the midnight check, while `PLAYING`, all of these hold:
      - **No goods that can still sell:** every product pool is empty, no delivery is `OUTBOUND`, and no production job is running.
      - **No recipe offers a restart.** At an owned facility, recipe *R* is a restart route if it is feasible and `funds(R) ≥ cost(R)`, where:
        - `cost(R)` = the price of each required item the facility lacks, plus for each input the shortfall against materials on hand × that material's cheapest game-data `unitPrice` (the base price, ignoring shortages), plus `laborPerCase + overheadPerCase`;
        - `funds(R)` = cash + the resale value of the owned equipment *R* doesn't require;
        - *R* is infeasible if a required item it lacks is `LOCKED`, or no supplier sells one of its inputs.
    - **Base prices on purpose.** A shortage can delay a restart for its few days, but it can't cause a loss.
    - **Transaction.** Insolvency commits `PROGRESSION:LOST`, sets `outcome = { status: "LOST", tick, reason: "INSOLVENT" }`, and emits `GAME_LOST`.
    - **No soft-lock (GDD §9)** is a locked property test (T05f): from random command sequences, at every midnight either the outcome is `LOST`, or a scripted restart policy produces a `SALE_COMPLETED` within 2 game days. And whenever `GAME_LOST` fires, that policy can't make its first paid step.
11. **`REPEAT_OPERATION`** (ADR 0004 leaves these points open):
    - **Source.** The envelope in `state.commandLog` whose `id` is `sourceCommandId`.
    - **Chain.** If the source is itself a `REPEAT_OPERATION`, follow it back to the underlying command. Every link must already be in the log and applied, and a command enters the log only after it applies, so the chain can't loop.
    - **"Previously successful" means applied:** the ledger holds a transaction with `causedBy` equal to that command's ID. Every applied repeatable command commits one, keyed by the command, job, or delivery. This must hold at every link of the chain.
    - **`NOT_REPEATABLE { sourceCommandId }`** covers every source problem:
      - not in the log (unknown, still queued, or rejected at dispatch);
      - a type outside `RepeatableCommand`;
      - never applied (rejected when its tick came).
    - **Applying.** The resolved command is copied and applied through its own handler, with the repeat's context. So its transactions are keyed and caused by the repeat's command ID, and its rejections are its own (`INSUFFICIENT_FUNDS`, `ROUTE_CLOSED`, …).
    - **What's copied.** Everything, except a `SALE` dispatch's `agreedUnitPrice`. That's replaced with the buyer's current quote for the cargo (the value the dispatch's `QUOTE_CHANGED` check compares against). If the buyer won't quote, the dispatch's own rejection explains why.
    - **No dispatch-time `validate`.** All checks run when the command applies (ADR 0004).
    - **No unlock.** "Earned" means the source succeeded.
    - **Snapshot.** No change. The UI can offer "repeat" on the `causedBy` of the events it already shows (`MATERIALS_PURCHASED`, `PRODUCTION_STARTED`, `DELIVERY_DISPATCHED`).
    - **Registration.** Its own `SYSTEMS` line, ahead of progression.
12. **Scenario contents and validation at load.**
    - **The family's display name** is game-data (`FAMILIES` in `personnel.ts`, PLACEHOLDER "The Kerrigans"), because the projection has game-data but not the scenario.
    - **The disruption source** is a rival. The scenario gains `scheduledEvents`, accepting only `ROUTE_CLOSURE { tick, routeId, reason, durationTicks }` with a positive, non-null `durationTicks`, so M001 has no open-ended closures. The First Shipment closes Kessler's safe route (`county-road`), reason `RIVAL`, from day 8 at 08:00 (tick 12 000) for 1 440 ticks.
      - Before then, the risky back road and a later delivery are the player's choices.
      - The window was picked to fall after the locked tests' contract deliveries (days 3–7). T05b re-checks that no locked test dispatches onto it.
      - The corn shortage (ADR 0016) stays the economic disruption.
    - **No scheduled `CONTRACT_OFFER` events.** The midnight hook supplies offers (ADR 0018).
    - **Validation.** `createInitialState` throws `ScenarioSetupError` when:
      - a scheduled closure names an unknown route, has `tick` < 1, or has a duration < 1;
      - `family.tierId` isn't a tier;
      - `family.unlocked` isn't exactly the sorted union of the unlocks of the tiers up to the starting tier;
      - the family ID has no `FAMILIES` entry.

      So a bad scenario fails when it loads, not inside a tick (the T03 review note).
13. **The warehouse isn't owned at the start.** GDD §4 lists one facility, and warehouses are the GDD §3 "Distributor" stage. M001 has no facility purchase, so T03b's warehouse and transfers serve fixtures and post-M001 play. Nothing in M001 waits on them.
14. **Contract change** (its own task, T05a, factory.md §7.3):
    - **`packages/contracts/src/commands.ts`:**
      - `SellEquipmentCommand { type: "SELL_EQUIPMENT"; facilityId: FacilityId; equipmentId: EquipmentId }`, in `GameCommand` and appended to `GAME_COMMAND_TYPES`. It's not a `RepeatableCommand`.
      - `RejectionReason` gains `{ code: "EQUIPMENT_NOT_OWNED"; facilityId: FacilityId; equipmentId: EquipmentId }`.
    - **`packages/contracts/src/events.ts`:**
      - `EquipmentSoldEvent = GameEventOf<"EQUIPMENT_SOLD", { facilityId; equipmentId; bookValue: Money; proceeds: Money; transactionId: TransactionId }>`, in `GameEvent`, with `EVENT_IMPORTANCE` `"log"`.
      - `GameLostEvent`'s doc comment cites this ADR.
    - **`packages/contracts/src/ledger.ts`:** `TransactionKind` gains `"PROGRESSION"`, for reputation, tier, unlock, and outcome changes. It never has entries.
    - **`packages/contracts/src/snapshot.ts`:** `FacilitySnapshot.equipment` entries gain `resaleValue: Money`.
    - **`packages/contracts/src/schemas.ts`:** matching schemas.
    - **Consumers** updated in the same task, so main stays green:
      - `packages/contracts/fixtures/**`;
      - `CASH_FLOW_CATEGORY` (`PROGRESSION: null`) in `projection/finance.ts`;
      - the `resaleValue` projection, reported 0 through `UNDEFINED_IN_GAME_DATA` until T05d (the S0b pattern);
      - placeholder copy in `REJECTION_COPY` and `TRANSACTION_KIND_COPY` (`apps/game`).
    - **Saves.** Additive enum members only, so existing saves stay valid (ADR 0009), and `SAVE_FORMAT` doesn't change.
    - **Not folded in.** ADR 0017's two stand-ins (a workforce kind and a workforce-in-use code) would move PROD-001 locked expectations.
15. **Tuning, and the victory-feasibility criterion.**
    - **T05g owns the first tuning pass**, in game-data only. GDD §14: tune values, don't weaken rules.
    - **Its levers:** product base prices, market baselines and drift, buyer quotes, demand, budgets, and minimum reputations, supplier prices and stock, recipe inputs, labor and overhead, equipment prices, wages and overhead, the building value, reputation amounts, the resale ratio, and the rival window.
    - **Not levers without a locked-test round:**
      - the contract terms and quantities;
      - the route table and truck capacity;
      - crews, the condenser bonus, and the basic recipe's 144 ticks;
      - market price bounds;
      - the opening cash, seed, and start date;
      - victory's thresholds (GDD-approved).
    - **The criterion is replaced.** #13's "the T07a bot reaches victory in some seeds within 15 game days" can't be met by construction: the greedy spot bot never takes a contract. T05g instead adds a contract-taking variant of the T07a bot. It must win in at least 1 of 50 seeds within 15 game days, the greedy spot bot's median daily net profit must turn positive, and the PR reports the distributions.
    - **T07 (#15) keeps the GDD §13 targets.** Those are win rates by strategy, the dominant-strategy gap, and time-to-victory. So the "competent strategies win 60–85%" bar moves to T07, not T05.
16. **The end-of-game pause.**
    - **When.** The worker host (`apps/game/src/workers/simulation-host.ts`) pauses the scheduler (`setSpeed(0)`) when a step's collected events include `VICTORY_ACHIEVED` or `GAME_LOST`. It then syncs the timer and publishes a snapshot at once.
    - **Overshoot.** The step finishes its batch, so the clock can run past the deciding tick by at most one scheduler batch (`MAX_TICKS_PER_STEP`). `advance()` keeps its semantics, so replay and the lab don't change.
    - **Resuming** isn't refused (decision 8).
17. **Data shapes** (`packages/game-data/src/progression.ts`, types per ADR 0012), added to `GameData` as `progression`:

    ```ts
    interface TierDefinition { id: TierId; name: string; netWorthRequired: Money | null; reputationRequired: number | null; unlocks: readonly UnlockId[] }
    interface ReputationRulesDefinition { firstQualifyingDelivery: number; qualifyingDeliveryMinimumCases: number; installmentFulfilled: number; consecutiveInstallmentBonus: number; installmentPartial: number; installmentMissed: number }
    interface VictoryDefinition { netWorth: Money; reputation: number; completedContracts: number }
    interface RecoveryDefinition { equipmentResaleRatio: Ratio }
    interface ProgressionDefinition { tiers: readonly TierDefinition[]; reputation: ReputationRulesDefinition; victory: VictoryDefinition; recovery: RecoveryDefinition }
    ```

    Penalty amounts are signed (−3, −8). `FamilyDefinition { id: FamilyId; name: string }` lives in `personnel.ts` as `GameData.families`.

## Alternatives considered

- **Tier table (decision 3).**
  - **A: gate contracts at tier 2 as the GDD lists, and add per-delivery spot reputation** so tier 2 is reachable. This needs a new `ReputationChangeReason` (a contract change) and a locked-test round on `eco-001-contracts.locked.test.ts` (it pins `requiredUnlockId: null` and default-game offers at tick 1 440). It also adds a farmable reward that needs per-buyer, per-day limits.
  - **B: start at reputation 10.** Tier 2 is reached at tick 1, so it's A's gate in name only, and Lakeview opens at once.
  - **C (picked):** contracts from the start, and tier 2 gates capacity equipment.
- **Applying reputation inside the cause's transaction.** That would be atomic with the sale or settlement, but it breaks the locked exact-event assertions on settlement transactions, and it would spread progression code into contracts and logistics.
- **Scanning state, not events, for this tick's causes.** "Settled this tick" isn't stored on an installment or a delivery, so it would have to be inferred from deadlines and arrival times. Events are what ADR 0018 already promised.
- **Victory needing every installment `FULFILLED`.** That's stricter than GDD §7's own definition of completed, and it would usually need a second contract inside 15 days. Reputation 30 already rewards fulfilment.
- **Evaluating victory only at midnight.** That's cheaper, but the win would show up hours after it happened. Net worth is memoized (T02b), so a per-tick check costs little.
- **Freezing the simulation on `WON`/`LOST`,** rejecting commands with a new code. That's a contract change and a kernel rule, for something the UI handles by pausing.
- **No asset sales**, so a player with no cash and no goods is simply `LOST`. GDD §9 and §14.9 name liquidation as the recovery route, and the contract already carried `ASSET_SALE` for it.
- **Blocking a sale while a job runs.** This isn't needed: job timing is fixed at the start, and the 50% resale makes selling mid-run gain nothing.
- **A seeded rival closure.** Seed-to-seed variety already comes from the shortage. A fixed window is easier to understand and to keep clear of locked tests.
- **A `DAILY_SETTLEMENT` stand-in instead of a `PROGRESSION` kind.** There's precedent for it (ADRs 0016, 0018, 0017), but reputation changes aren't settlements, and T05a is a contract task anyway.

## Consequences

- **Split.** #13 becomes T05a–T05h. The orchestrator files them after this ADR merges, records the split on #13, and makes #14 (T06) and #15 (T07) depend on T05c, T05f, and T05g.
  - T05a: contracts
  - T05b: data and scenario
  - T05c: repeat
  - T05d: asset sales
  - T05e: reputation and tiers
  - T05f: victory and insolvency
  - T05g: tuning
  - T05h: contract test gaps
- **Sprint Zero hash** (`fnv1a64:50c5ae9cdf05ff0d`; pinned in `test/sprint-zero/reference-hash.ts`, `apps/game/tests/e2e/sprint-zero.spec.ts`, and `tools/economy-lab/test/sprint-zero.test.ts`):
  - **Moves in T05b.** The rival closure is in `state.scheduledEvents`, and `nextScheduleSequence` advances, at tick 0.
  - **Moves in T05g,** with tuned base prices and initial markets.
  - **Unchanged in T05a, T05c, T05d, T05e, and T05f:**
    - the path sells one case, so nothing qualifies for reputation;
    - reputation 0 reaches no tier;
    - the path ends before the first midnight, so there's no insolvency check;
    - no command on it repeats or sells.

    If it moves in one of them, stop and comment.
- **Kernel reference hash** (`fnv1a64:0f3c258a09c81be8`): unchanged. It uses fakes and the `day0Save` fixture, which T05a doesn't change.
- **Unlocked tests that move:**
  - **T05a:** `packages/contracts/test/**` and the snapshot fixtures (`resaleValue`).
  - **T05b:** `test/projection/snapshot.test.ts` (progression section, family name) and `packages/game-data/test/data.test.ts` (scenario parsing).
  - **T05d:** `test/projection/snapshot.test.ts` (`resaleValue`).
  - **T05e:** `tools/economy-lab/test/smoke.test.ts` "acts only through dispatch…". The condenser is now `LOCKED` at the opening, so the bot's opening is buy, buy, produce.
  - **T05g:** possibly the dashboard, finance, and production panel screenshots, and the dashboard spec's literals.
- **Locked tests, rechecked.**
  - **ECO-001 contracts:**
    - Its exact settlement event lists hold, because reputation is a separate transaction.
    - The `requiredUnlockId: null` pin holds (decision 3).
    - Its reputation-100 scenarios now get tier promotions at tick 1. Those tests read offers and rejections, not tiers, so they should hold.
  - **Logistics:** its failed-deal "reputation unchanged" checks hold (4 cases, no sale).
  - **PROD-001:** it grants equipment unlocks through `unlockedFor`, so gating holds.
  - Any locked test that conflicts is a stop-and-comment under factory.md §7.3, never a workaround.
- **Routed #13 follow-ups:**
  - the S0a placeholder-numbers note → T05b
  - the scheduler pause → T05f (decision 16)
  - the ROUTE_REOPENING note → T05b (decision 12: durations are never null)
  - the T02e test gaps → T05h
  - the T02e snapshot header line and the `GAME_DATA_VERSION` bump → T05b
  - the T07a smoke report's tuning flags → T05g (its #85 non-blocking items are already on #15)
  - route-ID validation at load → T05b
- **#76 (T03b):** its last criterion is answered by decision 13.
- **Story placeholders for the human** (factory.md §8), each marked PLACEHOLDER where it's added:
  - the tier display names (the GDD's names are used for now)
  - the family display name
  - the rival's identity and flavor for the closure
  - copy for the new rejection, transaction kind, and event
  - the end-of-game text (T06)
