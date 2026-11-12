# Chicago Prohibition
## Game Design Document v0.6
**Status:** v0.5 baseline built in M001. v0.6 adds the game layer for M002 (§16–§21), proposed for review  
**Working title:** Chicago Prohibition (final title TBD)  
**Platform:** Desktop browser, single-player  
**Setting:** Fictionalized Prohibition-era Chicago and surrounding rural areas  
**Primary milestone:** M001, *The First Shipment*  
**Last updated:** November 12, 2026 (v0.6). The file keeps its v0.5 name because issues and ADRs link to it.

> **Design promise:** Build the business. Control the city. Leave a legacy.

> **v0.6 in one line:** M001 proved the economy works, but it plays like a dashboard. The player knows everything, everywhere, all the time. v0.6 makes it a game. You are one person in one place, you know only what you've seen or been told, every day has more to do than you can do, and hiring people is how you get out from under it. See §16–§21.

## 1. Vision

An economic strategy and criminal-empire simulation in which the player begins as a rural moonshiner, establishes production and distribution routes into Chicago, acquires businesses and influence, and eventually builds a multi-generational dynasty.

The game emphasizes economic systems worth learning, visible consequences, persistent progress, and strategic rather than tactical conflict. It draws inspiration from *Gangsters 2: Vendetta*, *Genghis Khan* (NES), *Wall Street Kid* (NES), and the rural bootlegging atmosphere of *Lawless*. From *Schedule I* (TVGS, 2025) it takes the arc of doing everything yourself and hiring your way out, and the rule that you only know an inventory while you're looking at it. Its smartphone becomes period telephones that sit in fixed places.

**Core loop:** Procure → Produce → Store → Transport → Sell → Reinvest → Expand.

**Player experience goals:**
- The player understands why money was earned or lost.
- Investments change operational capabilities, not merely abstract multipliers.
- Dynamic markets reward observation, planning, and calculated risk.
- Economic and criminal threats interact.
- Delegation replaces repetition as the empire grows.
- Every day there's more to do than one person can do, and the game is choosing (PLAY-001).
- The player knows only what they've seen or been told, and the ledger shows how old each piece of knowledge is (INFO-001).
- Setbacks are consequential but generally recoverable.
- A failed empire can leave a meaningful, diminished legacy for a successor.

## 2. Locked design decisions

These **15 foundational decisions** are approved. They remain changeable through explicit design revision, but must not be silently overridden.

| # | Domain | Locked decision |
|---|---|---|
| 1 | Time | Pausable real-time with deterministic discrete simulation ticks |
| 2 | History | Fictionalized Chicago, authentic period atmosphere |
| 3 | Starting position | Rural moonshiner |
| 4 | Markets | Dynamic supply and demand **plus** contracts |
| 5 | Production | Supply-chain-focused abstraction, not distillation chemistry |
| 6 | Interface | Equal importance for interactive map and management screens |
| 7 | Personnel | Named leaders and generic hired workforce |
| 8 | Conflict | Mostly strategic resolution |
| 9 | Threats | Economic, rival, and law-enforcement threats interact |
| 10 | Collapse | Family legacy carries some progress across generations |
| 11 | Products | Alcohol categories and quality tiers |
| 12 | Upgrades | Equipment and facilities as purchasable assets |
| 13 | Unlocks | Wealth **and** reputation |
| 14 | Difficulty | Recoverable setbacks; genuine failure remains possible |
| 15 | Automation | Earned delegation of routine work |
| 16 | Core feel *(v0.6)* | Daily time and priority management: every day you choose what to do and in what order |
| 17 | Information *(v0.6)* | Information is local, timestamped, and comes from being there or being told. The player is not all-knowing |
| 18 | Presence *(v0.6)* | The founder is a piece on the map. Arriving at a place opens a scene of it, where you act on what's there. Not an RTS |
| 19 | Personnel *(v0.6)* | Hiring removes a responsibility, not clicks. Employees act while you're away and keep you informed |

Decisions 16–19 came out of the design conversation of November 12, 2026, after the first M001 playtest. They refine #6, #7 and #15 and contradict none of the original fifteen.

### Approved v0.5 implementation assumptions

The following **five additional assumptions were explicitly approved** as the initial M001 engineering baseline, **not permanent balancing values**:

1. **Simulation pacing:** 1 game day = 2 real minutes at 1×; pause, 2×, and 4×.
2. **Market complexity:** Daily bounded supply/demand pricing, plus three-delivery recurring contracts.
3. **Accounting:** Double-entry ledger, weighted-average inventory cost, equipment initially valued at cost.
4. **Product scope:** Model moonshine, whiskey, beer, each with basic/standard/premium tiers; only basic and standard moonshine need to be producible in M001.
5. **Progression:** Initial M001 victory target $5,000 net worth and reputation 30, plus a completed recurring contract.

## 3. Campaign progression

These are thematic stages, not rigid missions.

1. **The Moonshiner:** Produce alcohol, acquire materials, find buyers, manage cash, and survive.
2. **The Distributor:** Build routes and warehouses, negotiate contracts, hire logistics staff.
3. **The Proprietor:** Acquire speakeasies and fronts, control neighborhoods, develop political and rival relationships.
4. **The Dynasty:** Diversify holdings, groom successors, endure changing laws, preserve family assets and reputation.

Prohibition ending in 1933 is a **future campaign-design opportunity**, not part of M001.

### Family succession (post-M001)

When an empire collapses, a new generation may inherit some surviving assets, relationships, knowledge, and family reputation. Loss must be meaningful: debt, confiscation, betrayal, and organizational collapse can destroy progress. Exact inheritance rules are **not yet specified**.

## 4. Milestone 001: The First Shipment

### Player scenario

Start in rural Illinois in 1920 with a small distillery, one truck, limited capital, two named leaders, and three potential buyers. Establish a viable bootlegging business and earn access to expansion toward Chicago.

### Proposed starting scenario configuration

| Variable | Initial value |
|---|---|
| Starting date | January 17, 1920 |
| Random seed (example) | 1920 |
| Cash | $1,000 |
| Production facility | 1 small distillery |
| Starting equipment | Copper still |
| Initial basic moonshine throughput | 10 cases / game day |
| Vehicles | 1 truck |
| Potential buyers | 3 |
| Named leaders | Founder and foreman |
| Workforce | Generic workers |
| Rival presence | 1 simple disruption source |
| First-playable session target | 20–30 real minutes |
| Victory | $5,000 net worth; reputation ≥30; complete a recurring contract |

**Important:** Starting cash is not starting net worth. The scenario must explicitly value the owned still, truck, building, inventory, and any liabilities. Starting reputation, ingredient inventory, wages, and transport costs remain to be specified in versioned scenario data.

### Player actions in the vertical slice

1. Buy raw materials from a supplier.
2. Schedule and complete production of basic moonshine.
3. View market offers and buyer constraints.
4. Assign inventory and a truck to a delivery.
5. Receive sale proceeds and inspect cash flow, profit, and net worth.
6. Reinvest in equipment, workers, or storage.
7. Unlock and fulfill a recurring contract.
8. Respond to an economic shortage or strategic route disruption.
9. Reach victory conditions; save, close, and resume.

### In scope

- Fixed deterministic simulation clock and speed controls.
- Basic and standard moonshine production.
- Inventory, facilities, equipment, and upgrades.
- Three buyers, bounded spot prices, and a recurring contract.
- One truck, cargo capacity, travel time, delivery resolution.
- Simple strategic disruption and recoverability.
- Founder, foreman, and abstract workforce.
- Wealth/reputation unlocks and victory.
- Interactive small-area map **and** functional management panels.
- Financial statements, local save/load, automated tests.

### Out of scope

Full Chicago map, complex autonomous rival AI, tactical combat, playable family succession, full nine-recipe production, sophisticated law-enforcement investigations, political systems, multiplayer, backend accounts, and offline advancement.

## 5. Simulation calendar (SIM-001)

| Parameter | Rule |
|---|---|
| Clock representation | Integer tick |
| Tick duration | 1 game minute |
| Game day | 1,440 ticks |
| 1× | 1 game hour / 5 real seconds |
| 2× | 1 game hour / 2.5 real seconds |
| 4× | 1 game hour / 1.25 real seconds |
| Paused | No ticks advance |
| Daily settlement | Midnight |
| Calendar | Gregorian with leap years |
| Browser hidden | Auto-pause; no catch-up |
| Browser closed | No offline progression |

At 1×, one game day lasts 120 real seconds. Thus 20–30 real minutes represents 10–15 game days **if played entirely at 1× without pauses**.

### Deterministic tick order

1. Validate and apply due commands in `(scheduledTick, sequence)` order.
2. Advance production jobs.
3. Advance vehicles and resolve arrivals.
4. Resolve contract fulfillment, due payments, and events.
5. At midnight, settle recurring costs, replenish supply, update demand/prices, and evaluate progression.
6. Emit events and publish a read-only state projection.

**Ordering clarification for implementation:** Events due on a tick, including a delivery exactly on a deadline, must resolve before missed-contract penalties for that tick. Midnight production and arrivals must not be double-settled.

The wall-clock scheduler only determines **how many** ticks to execute. It must never change the economic rules. If processing falls behind, retain the backlog and catch up in bounded batches; never discard ticks. Saving must include the tick, pending commands/events, and seeded RNG state. A hidden-tab pause must reset wall-clock accumulation to avoid accidental catch-up.

**Acceptance:**
- 1,440 ticks advance exactly one game day.
- Pausing for 60 real seconds advances zero ticks.
- Same seed and timed commands yield identical state hashes at 1× and 4×.
- Save/load and replay produce identical future outcomes.
- Exact-deadline deliveries count as on time.
- Leap days, midnight jobs, hidden tabs, and repeated speed changes behave consistently.

## 6. Products and production (PROD-001)

### Product matrix: illustrative base spot prices per standardized case

| Category | Basic | Standard | Premium |
|---|---:|---:|---:|
| Moonshine | $14 | $20 | $30 |
| Whiskey | $22 | $34 | $52 |
| Beer | $8 | $12 | $18 |

Prices are **fictional gameplay numbers**, not historical prices. M001 only requires production of **basic and standard moonshine**. Other product definitions exist in configuration for future expansion.

Product identity includes `category`, `qualityTier`, and `quantity`. Inventory additionally tracks owner, location, and historical cost basis.

### Production jobs

A facility defines equipment slots, supported recipes/tiers, workforce, capacity, storage, and operating costs. Starting a job reserves required ingredients and capacity. Completion consumes the reserved inputs and creates finished goods. Labor and overhead are incorporated into cost basis. Jobs are deterministic for a given state and seed.

**M001 equipment candidates (tuning defaults):**

| Equipment | Price | Function |
|---|---:|---|
| Copper still | $300 book value | Owned at start; 10 basic moonshine cases/day |
| Improved condenser | $450 | +40% throughput |
| Quality control station | $650 | Unlock standard moonshine, with higher production costs |
| Storage expansion | $350 | +100 cases storage |

Purchases must respect cash, equipment slots, eligibility, and capacity. A facility cannot accept jobs whose reserved inputs or finished output would exceed capacity. Exact recipes, costs, and job durations still require configuration and balancing.

## 7. Dynamic market (ECO-001)

Each `(product, quality)` market has baseline demand `D₀`, current demand `D`, baseline available supply `S₀`, current available supply `S`, and event modifier `M_E`.

### Spot price

`P_spot = roundHalfUpToCent(P_base × M_D × M_S × M_E)`

Where:

- `M_D = clamp(D / D₀, 0.80, 1.25)`
- `M_S = clamp(S₀ / max(S, 1), 0.80, 1.25)`
- `M_E ∈ [0.90, 1.10]`

**Precondition:** `D₀ > 0` and `S₀ > 0`. Invalid market configuration fails validation rather than dividing by zero.

Example: standard moonshine has a $20 base price, demand 10% above normal, supply 20% below baseline, and no event. Price = `$20 × 1.10 × 1.25 = $27.50`.

The combined permitted multiplier range is **0.576 to 1.71875** before rounding. These are mathematical bounds, not promises that buyers always transact at those prices.

### Daily market cycle

At midnight:
1. Replenish supplier stock according to explicit capacity.
2. Refresh buyer demand and budgets.
3. Apply seeded events, shortages, and rival effects.
4. Calculate daily spot prices.
5. Publish an explainable market report.

Prices remain stable between daily updates for M001. Actual purchases and sales reduce stock and remaining demand immediately. Supply and demand changes influence the **next daily quote**, not a mid-day recalculation.

### Buyer liquidity

`Q_accepted = min(Q_offered, Q_demandRemaining, floor(buyerBudgetCents / pricePerCaseCents))`

Transactions reject zero or negative quantities, unavailable goods, insufficient player stock, or invalid prices. Buyer preferences and minimum reputation also constrain acceptance. Selling cannot create inventory or exceed a buyer's budget.

### Contracts (M001)

| Term | Default |
|---|---|
| Duration | 3 scheduled installments |
| Frequency | Every 2 game days |
| Price | 95% of spot price when signed, rounded to cents |
| Missed quantity penalty | 20% of contracted value of missing cases |
| Successful installment reputation | +5 |
| Partial installment reputation | −3 |
| Completely missed installment reputation | −8 |
| Partial fulfillment | Allowed |
| Early cancellation | Not available in M001 |

Contracts store buyer, product, minimum quality, quantity, price, first deadline tick, interval, remaining installments, and status. Contract funds are reserved when an offer is accepted. Contract inventory reservations must prevent accidental double sale. A player may explicitly release reserved inventory if willing to risk nonfulfillment.

A shipment arriving at its deadline counts on time. Fulfillment and penalties are **idempotent**. Unpaid penalties create a liability, not negative cash.

**Implementation clarification:** A three-installment contract is marked `completed` only after all three installments have settled, with fulfillment status recorded per installment. The victory condition requires at least one **completed recurring contract**, not merely one successful installment. This is the stricter reading and must be reflected in balance testing.

**Acceptance:** prices bounded and explainable; supply and buyer liquidity conserved; no unlimited repeat arbitrage; contracts retain agreed prices; duplicate deliveries/penalties cannot settle twice; save/load preserves contract state.

## 8. Accounting and valuation (FIN-001)

### Monetary representation

- All money stored in **integer cents**, with checked safe arithmetic.
- Quantities are whole cases in M001.
- Journal uses balanced double-entry transactions.
- Negative cash disallowed; negative net worth permitted.
- Inventory uses **weighted-average historical cost**.
- Equipment uses acquisition cost less explicitly recognized impairment; depreciation deferred beyond M001.
- Revenue and cost of goods sold recognized on sale, not on production.
- Transport between owned locations does not change consolidated net worth.

### Inventory cost formula

`averageUnitCost = poolTotalCostCents / poolQuantity`

Store total pool cost in integer cents, **not a rounded per-unit cost**. On partial removal, allocate cost deterministically using integer rounding; the final removal receives the remaining cost residue. Transfer both quantity and allocated cost basis.

Example: 20 cases at $8 plus 30 at $12 gives 50 cases costing $520 total. Sell 15 at $20:

- Revenue: $300.
- COGS: $156.
- Gross profit: $144.
- Remaining inventory: 35 cases valued at $364.

### Production accounting

Example 10-case production run:
- Raw materials consumed: $80.
- Labor: $30.
- Overhead: $10.
- Finished inventory capitalized: $120 ($12 per case).

Journal: debit finished inventory $120; credit raw inventory $80; credit cash or accrued payables $40. **Production creates no immediate profit.**

### Balance sheet

`Net worth = Assets − Liabilities`

Assets include cash, raw and finished inventory, vehicles, equipment, and receivables. Liabilities include wages and penalties payable. Profit, cash flow, and net worth are distinct dashboard metrics.

### Atomic economic operations

A completed sale must atomically:
1. Validate ownership, stock, buyer eligibility, and liquidity.
2. Remove inventory and allocate its cost basis.
3. Transfer cash or recognize receivable.
4. Recognize revenue and COGS.
5. Apply contract fulfillment if relevant.
6. Emit a unique event.

If any validation fails, **no state change commits**. Transaction IDs and command IDs must prevent duplicate processing.

### Accounting acceptance

- Sum of debits equals sum of credits per transaction.
- Assets = liabilities + equity.
- No negative inventory or inventory cost.
- Transfers preserve consolidated book value.
- No sale recognized twice.
- Equipment purchase converts cash into a book asset.
- Cargo loss or asset impairment is recorded explicitly.
- Save/load preserves ledger, balances, and cost basis exactly.
- Randomized transaction sequences preserve all invariants.

## 9. Progression (PROG-001)

| Tier | Net worth threshold | Reputation threshold | Unlock |
|---|---:|---:|---|
| Starting Operation | None | None | Basic moonshine, spot sales |
| Trusted Supplier | $1,500 | 10 | Recurring contracts |
| Established Producer | $2,500 | 20 | Quality equipment and improved buyers |
| Regional Distributor | $5,000 | 30 | Next region / M001 victory |

**Initial reputation is still an explicit scenario-config decision.** For early testing, use 0 unless balancing shows it makes 10–15 in-game days unrealistic.

Example reputation adjustments:
- First qualifying delivery: +3.
- Fulfilled contract installment: +5.
- Consecutive installment bonus: +2.
- Late/partial installment: −3.
- Missed installment: −8.
- Rejected/unreliable product: −4.

Rewards must be bounded and resistant to tiny-delivery farming. Reputation range proposed as 0–100. Eligibility to purchase new items uses current wealth and reputation; already-purchased assets and permanently earned unlocks are not revoked solely because net worth later declines. Specific buyer access can change with reputation.

### Earned automation

1. **Manual:** Player schedules production and deliveries.
2. **Repeat order:** Player reuses a previously successful operation (M001).
3. **Delegated:** Named manager executes player-defined policies (post-M001).

Player commands and future manager commands must use the same validated simulation gateway.

### Recovery

Setbacks can include ingredient shortages, failed shipments, market downturns, or rival interference. Players can respond through alternative buyers, reduced production, asset liquidation, and lower-margin deals. The full loan and dynasty systems are later work. No unwinnable soft-lock should occur without explicit failure or a recovery route.

## 10. People, map, and conflict

**People:** Founder and foreman are named individuals with skill, loyalty, and wage attributes. Ordinary workers are abstract labor units. Deep relationships and succession are later systems.

**Map:** A small rural area with a distillery, supplier, warehouse/storage, buyer destinations, and truck routes. Clicking a location opens its management panel; commands create visible changes. Map coordinates are logical world data, independent of rendering. *(M001. From M002 on, PRES-001 replaces "click any location to manage it": you travel there and act in its scene.)*

**Conflict:** M001 includes one understandable strategic disruption, such as a risky route or shortage. No tactical combat. Rival and police systems later interact with the same economy, routes, reputation, and assets.

## 11. Technical architecture

> **Superseded for implementation by [`docs/architecture/technical-architecture.md`](../architecture/technical-architecture.md).** Kept here for design context.

**Recommended stack:** Vite + React + TypeScript, PixiJS map, Zustand for UI-only state, pure TypeScript simulation, Web Worker, IndexedDB/Dexie persistence, Zod validation, Vitest, fast-check, Playwright, pnpm workspaces.

No backend or multiplayer infrastructure for M001.

### Repository

```text
chicago-prohibition/
├── apps/
│   └── game/
│       └── src/
│           ├── app/
│           ├── components/
│           ├── map/
│           ├── panels/
│           ├── state/
│           └── workers/
├── packages/
│   ├── simulation/
│   │   └── src/
│   │       ├── clock/
│   │       ├── commands/
│   │       ├── events/
│   │       ├── economy/
│   │       ├── inventory/
│   │       ├── production/
│   │       ├── logistics/
│   │       ├── contracts/
│   │       └── progression/
│   ├── contracts/
│   │   └── src/
│   ├── game-data/
│   │   └── src/
│   └── persistence/
│       └── src/
├── tools/
│   └── economy-lab/
│       ├── agents/
│       ├── scenarios/
│       └── reports/
├── docs/
│   ├── game-design/
│   ├── architecture/
│   └── milestones/
└── package.json
```

### Hard architectural boundaries

- `simulation` must not import React, PixiJS, DOM, storage, or UI packages.
- Simulation is the **only authority** for cash, inventory, jobs, deliveries, contracts, and progression.
- React and PixiJS consume read-only snapshots/projections and submit typed commands.
- Commands are atomic and validated; events describe completed changes.
- Commands are ordered deterministically; RNG is seeded and serializable.
- Scenario configuration is versioned and separate from engine logic.
- Saves contain schema version, authoritative state, RNG state, queued commands, and scheduled events.
- Headless testing uses the **same engine** as browser gameplay.
- A compact event journal supports debugging and explanations; full event sourcing is not required.

### Suggested engine API

```ts
interface Simulation {
  dispatch(command: GameCommand): CommandResult;
  advance(ticks: number): void;
  snapshot(): GameSnapshot;
  serialize(): SaveGame;
}
```

Command types include material purchase, production start, delivery dispatch, contract acceptance, and equipment purchase. Use discriminated unions and stable IDs for commands/events. `dispatch` must not rely on current wall-clock time.

## 12. Milestone 001 task graph

> **Superseded by [`docs/milestones/001-first-shipment.md`](../milestones/001-first-shipment.md) and the GitHub issues.** The table below is the original sketch. Sprint Zero is carried forward as task S0.

| Task | Deliverable | Dependencies |
|---|---|---|
| T00 | Workspace, shared contracts, CI, type schemas | None |
| T01 | Deterministic clock, command/event pipeline, seeded RNG | T00 |
| T02a | Inventory pools, reservations, weighted-average costing | T01 |
| T02b | Ledger, balanced journal, atomic transactions | T01 |
| T02c | Production, facilities, equipment | T02a, T02b |
| T02d | Daily markets, buyers, contracts | T02a, T02b |
| T03 | Vehicles, routes, cargo, deliveries | T01, T02a |
| T04 | React management UI and PixiJS map | T00 + snapshot contract |
| T05 | Progression, scenario integration, victory | T02c, T02d, T03 |
| T06 | IndexedDB persistence and browser acceptance | T04, T05 |
| T07 | Headless economy laboratory and reports | T05 |

**Factory rules:** Contracts first; one task owner; isolated branches/worktrees; test evidence required; frequent integration; gameplay config centralized; no silent scope expansion; human review before merging.

### Sprint Zero: One Case of Moonshine

Before parallelizing the full graph, implement one complete path:

`Create game → Buy ingredients → Produce one case → Dispatch truck → Deliver → Sell → Record profit → Save → Reload`

It must work through the browser and headless engine, with deterministic replay and balanced accounting. Graphics can be placeholders.

## 13. Testing and balance laboratory

### Test layers

1. **Unit:** Tick advancement, formulas, inventory cost, ledger postings.
2. **Property-based:** Randomized valid commands and financial/inventory invariants.
3. **Scenario:** Shortages, failed deliveries, penalties, low-cash recovery.
4. **Headless playthroughs:** 1,000 seeded campaigns.
5. **Browser:** Map selection, controls, worker messages, persistence, complete campaign.
6. **Human:** At least three playtests focused on comprehension, pacing, and enjoyment.

### Headless player strategies

- **Volume Producer:** Low-cost capacity and volume.
- **Quality Specialist:** Equipment and premium margins.
- **Contract Operator:** Predictable fulfillment and reputation.
- **Market Opportunist:** Responds to price and demand changes.

Because standard moonshine is reputation-gated, the quality specialist must first establish access through legal progression. Every strategy must follow the same command and unlock rules as the player.

### Provisional balance targets

| Metric | Target |
|---|---|
| First profitable sale | Within 5 real minutes |
| First meaningful upgrade | 10–15 real minutes |
| M001 victory | 20–30 real minutes |
| Competent strategy success | 60–85% |
| Recovery from one moderate setback | Usually possible |
| Dominant strategy advantage | Less than 20 percentage points |
| Financial reconciliation failures | Zero |
| Deterministic replay divergence | Zero |

These are **targets**, not measured results. Report median and distribution of time-to-victory, win rates by strategy, bankruptcy/soft-lock rates, cash troughs, profitability, and source of economic losses.

### M001 release gate

- Browser player can produce, transport, sell, reinvest, and win.
- Spot market and contract obligations behave according to spec.
- Ledger reconciles after every transaction.
- Progression gates and reputation work.
- Pause/speed and save/load work without simulation divergence.
- At least one strategic disruption creates a recoverable decision.
- Multiple viable strategies can reach victory.
- 1,000 seeded headless runs produce reproducible reports without invariant violations.
- Three human playtests assess clarity, pacing, and fun.

## 14. Open implementation details and risks

The **design direction and five v0.5 assumptions are approved**. These are remaining engineering/tuning decisions, not reasons to reopen the foundation:

1. **Starting balance sheet:** Exact book value of starting still, truck, facility, inventory, and liabilities.
2. **Starting reputation:** Explicit starting value and reachable reputation schedule.
3. **Recipes and wages:** Material inputs, labor costs, job duration, and throughput.
4. **Buyer configuration:** Daily demand, budgets, location, reputation requirements.
5. **Contract availability:** First deadline and all three installments must fit target session length.
6. **Route configuration:** Capacity, travel duration, transport expense, and disruption probability.
7. **Transaction timing:** Whether buyer payment is immediate at delivery (recommended for M001) or uses receivables.
8. **Inventory reservations:** Reservation release rules for failed production or delivery.
9. **Recovery mechanism:** Exact asset resale values and minimum viable restart path.
10. **Save migration:** Schema versioning and compatibility policy.

**Important balancing risk:** Starting with $1,000 cash and a $5,000 net-worth victory target, plus reputation 30 and a fully completed three-installment contract, may be too demanding within 10–15 game days. Validate this in headless simulations before polishing the UI. Tune configuration values rather than weakening the accounting or deterministic rules.

## 15. Next step

Create the repository and check in:

- `docs/game-design/GDD-v0.5.md` (this document)
- `docs/architecture/architecture.md`
- `docs/milestones/milestone-001.md`
- `packages/game-data` with versioned scenario and economic configuration
- Initial T00/T01 tests

Then complete Sprint Zero before distributing parallel agent work.

---

**Status:** Design baseline approved; implementation not yet started.  
**Naming note:** The repository may be renamed independently of the game's working title. Suggested candidate from naming discussion: `empire-of-vice`, subject to availability and branding checks.

---

# Part II: The game (v0.6, Milestone 002)

M001 built a correct simulation and a set of management panels on top of it. Playing it showed the problem: the player has the information of a modern CEO with an internet connection. Every price, every case, every buyer, everywhere, live. Nothing was wrong with the economy; the player simply had nothing to work around.

Part II puts the player inside the world. The simulation (SIM, PROD, ECO, FIN, PROG) stays as it is. What changes is what the player knows, where they are, and who does the work.

**Placeholder content:** names, roles, scene art, and copy in Part II are placeholders unless marked otherwise. Story and visual direction belong to the human (factory.md §8).

## 16. The daily choice (PLAY-001)

> **Pillar:** Every day there's more to do than one person can do, and the game is choosing.

Every M002 feature is judged by one question: does it make the day's choice of what to do, and in what order, more interesting?

**What creates the choice:**
- **Being there costs time.** Travel and on-site actions take game time (PRES-001). Every trip means something else isn't happening.
- **Knowledge goes stale.** You plan with partial, dated information (INFO-001). "Is the still about to run dry, or did I check recently enough?"
- **The day has a shape.** Places keep hours. The feed store closes at evening; some buyers only meet after dark; the founder needs the night. Hours make the *order* matter, not just the choice of tasks. Hours are game-data per location.
- **Obligations pile up.** Contract installments, wages, and a buyer waiting on an answer all compete for the same day.

**Rules:**
1. **Pressure without unfairness.** There should always be competing demands, but never a day on which every available choice was doomed. This extends §9's recovery rule: no soft-locks, and no unwinnable days.
2. **The known to-do list is built from knowledge, not truth.** The game may keep a list of obligations and concerns ("Kessler installment due Thursday", "corn was low as of Monday"), but only from things the player knows. It must not leak world state (INFO-001).
3. **Hiring adds choices, not just removes them.** When a hire frees up your time, there must be something worth spending it on that you couldn't do before: a far buyer, a better supplier, a second operation. Otherwise the game gets emptier as you grow instead of bigger.

**Pacing (revises approved assumption #1 for M002):** 2 real minutes per game day was tuned for watching a dashboard. With travel and on-site actions taking time, a day needs room to plan. M002 starts at **1× = 1 game hour per 20 real seconds (8 real minutes per day)**, keeping pause, 2× and 4×. This is a tuning value, set in game-data and settled by playtest. The tick (1 game minute) and the deterministic rules in SIM-001 don't change.

## 17. Information (INFO-001)

> **Rule:** Information is local, timestamped, and comes from being there or being told. The world knows; the player doesn't.

### Three layers

| Layer | What it is | Who reads it |
|---|---|---|
| **World state** | Everything the simulation knows: stock, prices, demand, jobs, vehicles, routes | The simulation, tests, the economy lab, debug tools |
| **Player knowledge** | What the founder has seen or been told: a value, when it was learned, and who said so | The player's UI |
| **Channels** | How knowledge reaches the founder: being there, phone calls, messages, employee reports | The simulation, which writes knowledge |

Player knowledge is **simulation state**. It's deterministic, saved, replayed, and updated during the tick, never in the UI (architecture rule 7). The browser renders a snapshot built from knowledge, not from world state, except for what the founder can see right now.

### What the founder always knows

- Where they are, the date and time, and what they're carrying.
- **Cash.** In M002 the business's money is one purse the founder controls. This keeps FIN-001 whole: the ledger is always true and always visible. Later milestones may split cash across places (a safe at the still, a bookkeeper's account).
- Agreements they made: contracts signed, standing orders given, wages owed, and equipment bought. How those agreements are *going* is knowledge, not a given.

### What the founder has to observe

Stock at any place, including their own still and shed. Supplier stock and prices. Buyer demand, prices and budget. Production progress. Where the truck is, if the founder isn't on it. Route conditions. Whether a contract installment arrived.

### Knowledge records

Each record holds a subject (a place, a party, or one field of it), a value, the tick it was learned, and a **source**: *seen in person*, *by phone from X*, *message via Y*, or *report from employee Z*. Different sources reveal different fields. A visit shows everything visible at a place. On the phone, Kessler will tell you today's price and how many cases he wants, but not what's in his safe. Which fields each source reveals is game-data.

### The ledger view

Away from a place, the player sees the **ledger**: dated entries, written like a period account book.

```
Kessler's Back Room                        last updated Mon 17 Jan, 10:30 (in person)
  Wants          30 cases basic moonshine
  Paying         $18.00 a case
  Hollow Creek still                       last updated Tue 18 Jan, 19:00 (Eddie, by phone)
  On hand        40 cases (20 more ordered Mon)
```

An entry's age is always visible. How it looks is visual direction (placeholder until decided).

### Visiting catches you up

When the founder arrives somewhere, the scene shows the current state, and the game summarises what changed since the last visit: "Since Monday: 20 cases finished; the corn ran out Wednesday." The rule: **you may learn late, but you always learn eventually.** A change to your money or stock always reaches you through some channel, so §1's goal that the player understands why money was earned or lost still holds. The explanation can arrive late, but it always arrives.

### Non-leak rule

The player's snapshot must not change because of a world change the founder had no channel to learn about. This gets a property test: two worlds that differ only in unobserved state produce identical player snapshots. Errors, toasts, prices on buttons and disabled states are all channels. None may reveal what the player doesn't know.

## 18. Presence (PRES-001)

> **Rule:** The founder is a piece on the map. Arriving at a place opens a scene of it.

- **Map:** the founder travels along roads. Travel takes game time from route data (the M001 routes, extended to the founder). While traveling, the founder can't act anywhere. The map shows the founder, the truck, and known places. Not an RTS: you pick destinations, you don't steer.
- **Scenes:** arriving opens a scene of the place: an illustration (placeholder art in M002), with layers driven by state, such as crates stacked by the still, the truck in the yard or not, the foreman at the still or nowhere to be seen. The scene shows what's true right now. Its actions are what can be done *there*: buy at the feed store, start a batch at the still, sell or negotiate at a buyer, use the phone where there is one. M001's management panels turn into these scene actions.
- **Actions take time.** Buying, loading the truck, starting a batch, and negotiating each have a game-time cost (game-data). Together with travel, this is what makes the day's choices compete.
- **The founder starts as the driver.** At the start there's one truck and no driver. A delivery means the founder drives it, and is away from everything else for the trip. Arriving with the truck puts the founder face to face with the buyer, which is worth something (see *Being there should pay* below). Hiring a driver (PERS-001) breaks this link.
- **Being there should pay.** In person you see everything, and some things only happen face to face: negotiating a better price, hearing about a new buyer, noticing the still needs a part. Visits must be worth it, not just a way to refresh numbers.
- **Not in M002:** founder fatigue or sleep as a stat. Nights are shaped by business hours only. Revisit after playtests.

## 19. Orders and outcomes (ORD-001)

Under M001, a command is checked against the true world and accepted or rejected immediately with a reason. With fog, an immediate "buyer only wants 10 more" leaks information. So commands split in two:

1. **The order** is checked only against what the founder knows or can see right there: you can't load 30 cases onto a truck you're standing next to if only 20 are in the shed. The order is applied atomically or rejected with a typed reason (architecture rule 6 still holds).
2. **The outcome** happens in the world later, when the truck arrives or the batch finishes. It's its own atomic transaction. It may differ from what the founder expected: Kessler takes 10 of the 30 and the truck brings 20 home. The founder learns the outcome through a channel.

**Orders need a way to arrive.** An order to a person is given face to face, or by phone to someone who has one. Standing at the still, you can tell the foreman what to make. From across town with no phone at the still, you can't. Geography, communication and delegation are one system.

Player commands and employee commands still go through the same validated gateway (§9). This needs an ADR and a contract change (orders, outcomes, knowledge events), reviewed under factory.md §5.

## 20. Telephones (COMM-001)

> **Rule:** A telephone sits in one place. To call, you go to it. To be called, someone has to be there to answer.

- **Phones are places.** The general store, the train depot, a hotel lobby. Your own phone (at the still or at an office) is a purchasable asset (locked decision #12), and a milestone in the run: the moment you stop having to drive everywhere.
- **Calling out:** from a phone, call any party that has one. It costs a few cents (game-data). They may not answer, depending on their hours (seeded). A call reveals the fields that party gives by phone (INFO-001).
- **Calls in:** a party calls a phone. If nobody's there, it rings out and nothing is learned. The caller may try again later or give up. Once you've hired someone to sit by your phone, calls get answered and turned into messages.
- **Messages** are held where they were taken, and reach the founder when the founder visits or calls that place. The ledger records who took it: "Tue 16:00 — Kessler wants 20 more by Thursday (via Ruth, at the office)."
- **Party lines.** Rural lines are shared, and the operator can listen. In M002 this is period flavour only. Later it becomes a surveillance and police channel.

## 21. People and delegation (PERS-001)

> **Rule:** Hiring removes a responsibility, not clicks. You start as the whole business and hire your way out of being everywhere.

**The design test for any role:** what can now happen without the founder there? If the answer is only "the same thing with fewer clicks," the role isn't ready.

### The arc

You start alone: buying supplies, running the still, driving deliveries, and finding buyers yourself. You can't be everywhere, so you hire. Each hire lets some part of the business run without you, and you pay for it with wages, risk, and dependence on another person. Later, the question turns from "how do I get everything done?" into "how do I know my people are doing what I want?"

### Roles (M002 set; names are placeholders)

| Role | Takes off your hands | Reports | Tradeoff |
|---|---|---|---|
| **Distiller** (M001's foreman) | Running batches at the still while you're away, following a standing order | When you visit, or by phone if the still has one | Wages; output and quality depend on competence |
| **Driver** | Making the deliveries you order, and collecting payment | On return, or by phone from the road | Wages; the truck and cargo are in someone else's hands |
| **Office hand** | Answering your phone, taking messages, passing on your orders by phone | Messages waiting when you call in or visit | Wages; only useful once you own a phone |

Later roles: a **runner** (purchasing agent) who buys supplies and brings back prices, and a **bookkeeper** who pays the bills and reconciles the books. "Buyer" stays reserved for customers.

### Standing orders

You give an employee instructions, and the simulation follows them as a policy each tick, through the same command gateway the player uses (ORD-001). Example for the distiller: produce basic moonshine; keep at least 20 cases on hand; spend no more than $25 a week on supplies; report problems by phone. Limits matter: spending caps and what the employee may decide alone (pay a recurring bill: yes; buy a warehouse: no) are the authority you hand out.

An employee can be doing well without you knowing it yet. Their actions change the world; your ledger changes only when a report reaches you.

### Attributes

Named employees have **competence**, **reliability**, and **loyalty**. M002 uses competence only: candidates show an estimate, and you learn the real value by working with them. Reliability (follows instructions, keeps things running) and loyalty (acts for the family when incentives conflict) arrive with unreliable reports, skimming, and betrayal in later milestones. INFO-001's source field is what will make those possible without a separate system.

### Hiring

Wages, candidate pools, and competence ranges are game-data. Where and how you find candidates (word of mouth at the general store, a recommendation from a buyer) is story, placeholder until decided. Ordinary workers remain abstract labour at the still (§10).

### Legacy

Contacts, phones, and trusted people are part of what a successor inherits (§3), not just money.
