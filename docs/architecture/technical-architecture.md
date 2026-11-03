# Technical Architecture v1.0

Milestone 001 scope is frozen. Its one objective: prove that producing, transporting, and selling alcohol creates a satisfying economic gameplay loop. New ideas go to the backlog.

The architecture serves two equally important consumers of the simulation: the human player and the automated software factory.

Task breakdown and acceptance criteria live in [`docs/milestones/001-first-shipment.md`](../milestones/001-first-shipment.md), not here.

## 1. Approved implementation baseline

| Area | Approved rule |
|---|---|
| Simulation | Pausable real-time, 1 game day per 2 real minutes |
| Speed | Pause, 1×, 2×, 4× |
| Markets | Daily supply/demand updates, bounded pricing, recurring contracts |
| Accounting | Double-entry ledger, weighted-average inventory costing |
| Products | Three categories and three quality tiers in the model |
| Playable products | Basic and standard moonshine |
| Progression | Wealth and reputation |
| Victory | $5,000 net worth, 30 reputation, completed recurring contract |
| Persistence | Local save/load, no offline advancement |
| Platform | Desktop browser, single-player |

The broader 15 design decisions remain in force (rural beginnings, named leaders, strategic conflict, earned automation, eventual family succession). They are not all implemented in Milestone 001.

## 2. Architecture

```
┌───────────────────────────── apps/game (browser) ─────────────────────────────┐
│  React + TypeScript            PixiJS                  UI state (Zustand)     │
│  Dashboard, Production,        Isometric map,          Selections, panels,    │
│  Contracts, Finance,           buildings, routes,      overlays,              │
│  Personnel                     trucks, selection       notifications          │
│                        ▲ read-only snapshots / events                          │
│                        │ typed commands ▼                                      │
│                    Simulation gateway (Web Worker)                             │
└────────────────────────────────────┬──────────────────────────────────────────┘
                                     │
                    Deterministic simulation engine (packages/simulation)
                    Clock, Economy, Inventory, Production, Logistics,
                    Contracts, Progression
                       │                                  │
                IndexedDB (saves)               Headless runner (tools/economy-lab)
```

### Stack

| Layer | Technology | Reason |
|---|---|---|
| App | Vite + React + TypeScript | Lightweight browser application |
| Map | PixiJS | Efficient 2D rendering |
| UI state | Zustand | Simple interface state |
| Simulation | Pure TypeScript | Testable without browser or rendering |
| Runtime | Web Worker | Simulation off the UI thread |
| Persistence | IndexedDB + Dexie | Structured local saves |
| Validation | Zod | Runtime command and save validation |
| Unit tests | Vitest | Fast deterministic tests |
| Property tests | fast-check | Randomized invariant testing |
| Browser tests | Playwright | End-to-end and screenshot tests |
| Monorepo | pnpm workspaces | Shared packages, explicit boundaries |

No Next.js, no backend, no database server, no multiplayer infrastructure.

## 3. Repository structure

```
empire-of-vice/
├── apps/game/src/{app,components,map,panels,state,workers}
├── apps/game/tests/
├── packages/
│   ├── simulation/src/{clock,commands,events,economy,inventory,production,logistics,contracts,progression}
│   ├── contracts/src/{commands,events,schemas,snapshots}.ts
│   ├── game-data/src/{products,equipment,markets,progression}.ts
│   └── persistence/src/
├── tools/economy-lab/{agents,scenarios,reports}
└── docs/{game-design,architecture,milestones,decisions}
```

**Critical boundary:** `packages/simulation` cannot import React, PixiJS, browser storage APIs, or any UI package. The simulation must run identically in a browser worker and a Node.js test process. **This is enforced by lint rules in CI, not only by convention.**

## 4. Simulation contract

Commands express intent. Events record what happened. State is the resulting world.

```ts
type GameCommand =
  | { type: "PURCHASE_MATERIALS"; supplierId: string; materialId: string; quantity: number }
  | { type: "START_PRODUCTION"; facilityId: string; productId: string; quantity: number }
  | { type: "DISPATCH_DELIVERY"; vehicleId: string; destinationId: string; cargo: CargoItem[] }
  | { type: "ACCEPT_CONTRACT"; contractOfferId: string }
  | { type: "PURCHASE_EQUIPMENT"; facilityId: string; equipmentId: string };

type CommandEnvelope = {
  id: string;
  scheduledTick: number;
  sequence: number;
  command: GameCommand;
};

interface Simulation {
  dispatch(command: GameCommand): CommandResult;
  advance(ticks: number): void;
  snapshot(): GameSnapshot;
  serialize(): SaveGame;
}
```

- Events are a discriminated union, defined in full in `packages/contracts` (task T00b). No `payload: unknown`.
- Commands are validated at the gateway (Zod).
- A command is applied atomically or rejected with a typed reason. It never partially mutates inventory, cash, or contract state.
- Speed controls set how often the browser calls `advance()`. The headless runner advances thousands of ticks without waiting on real time.
- **One authoritative simulation state.** React and PixiJS receive read-only snapshots or projections. UI stores never hold their own copies of cash, inventory, or business data.
- The worker publishes snapshots periodically and important events immediately.
- **Test builds expose the current snapshot and a map scene query** (e.g. `window.__eov`), so Playwright can verify map state and not just the DOM.

## 5. Data model and configuration

The initial world is fully reproducible from a versioned scenario definition.

**Scenario: The First Shipment** (`scenario-first-shipment.json`). Seed 1920. Starts January 17, 1920. $1,000 cash, one distillery, one truck, three buyers, two named leaders.

| Entity | Essential properties |
|---|---|
| Family | ID, name, reputation, generation |
| Character | ID, role, skill, loyalty, wage |
| Facility | ID, location, equipment, workforce, capacity |
| Inventory pool | Owner, location, product, quality, quantity, cost basis |
| Vehicle | ID, capacity, location, cargo, route, status |
| Buyer | ID, demand, budget, preferences, reputation requirement |
| Market | Product, quality, supply, demand, modifiers, price |
| Contract | Buyer, terms, installments, fulfillment, penalties |
| Ledger entry | Transaction ID, account, debit, credit, tick |
| Unlock | Requirement, current state, unlocked tick |

Economy configuration is data-driven (`packages/game-data`). Prices, wages, production rates, and unlock thresholds are never scattered through source code.

### Transaction coordinator

All state changes that span systems go through one coordinator in the simulation core. Its interface is defined in T00b and implemented in T02b, so inventory, market, and contract work can proceed in parallel against it.

A completed sale atomically:

1. Removes inventory and its cost basis.
2. Transfers payment or creates a receivable.
3. Recognizes revenue and cost of goods sold.
4. Updates contract fulfillment if applicable.
5. Emits the relevant events.

If any step fails validation, none commit.

## 6. Factory operating rules

1. **Contracts first.** Agents don't invent domain types or command payloads. Contract changes need CODEOWNER review.
2. **One task, one owner.** Parallel tasks use separate worktrees and declared file ownership.
3. **Tests are deliverables.** Compiling isn't done.
4. **Continuous integration.** Merge small vertical increments, not giant branches at the end.
5. **Centralized configuration.** Gameplay values live in `game-data`.
6. **No silent scope expansion.** Agents propose. They don't implement unrelated systems.

A human merges every PR at first. See [`docs/factory.md`](../factory.md).

## 7. Milestone 001 release gate

| Criterion | Verified by |
|---|---|
| Player can produce, transport, and sell moonshine through the browser | Playwright |
| Market responds to supply, demand, and contract commitments | Simulation tests |
| Financial statements reconcile after every transaction | Property tests |
| Player can purchase equipment and unlock new capabilities | Simulation + Playwright |
| Pause, 1×, 2×, 4×, and local saves work | Playwright |
| One meaningful economic disruption requires adaptation | Lab report + **human** |
| Victory is reachable through multiple strategies | Lab: GDD §13 targets (competent strategies win 60–85%, dominant-strategy gap <20 points) |
| 1,000 seeded headless playthroughs produce reproducible reports | Nightly lab run |
| At least three human playtests evaluate clarity, pacing, enjoyment | **Human** |

## 8. Engineering details to settle in T00a/T00b

Record each outcome in `docs/decisions/`.

- **Scheduling:** fixed-timestep accumulator with bounded processing batches. Keep any backlog; never drop ticks. 1,440 ticks per game day means 12 ticks/s at 1× and 48 ticks/s at 4×.
- **Money:** integer cents, checked arithmetic, deterministic rounding.
- **Cross-engine determinism:** `Math.exp`, `Math.pow`, `Math.log`, and trig functions can return different results in V8, SpiderMonkey, and JavaScriptCore. Simulation code uses integer/fixed-point math or vetted pure-JS implementations only.
- **Save format:** versioned snapshots, explicit migrations, stored RNG state.
- **Command identity:** unique IDs and idempotent handling, so there are no duplicate sales or deliveries.
- **Map coordinates:** logical world coordinates, independent of isometric rendering.
- **Event history:** a compact journal for gameplay explanations and debugging, not full event sourcing.

## 9. Balancing concern

At the approved pacing, a 20–30 minute session covers about 10–15 game days at 1×. Production rates, contract intervals, reputation gains, and the $5,000 threshold must fit that window. The GDD (§14) flags the same risk, noting that "completed recurring contract" means all three installments settled. An early economy smoke loop (T07a) checks this before T05 sets victory thresholds and before any UI polish.
