# 0008: Game state and the save format

Status: proposed (T00b, issue #2)

## Context

T00b's acceptance criteria require a `SaveGame` with the schema version, authoritative state, RNG state, queued commands, and scheduled events. SIM-001 requires save → load → continue to give the same future as an uninterrupted run, and FIN-001 requires save/load to preserve the ledger and cost basis exactly.

A save is only as well defined as the state inside it, so T00b defines `GameState` too. Otherwise each system would invent its own saved shape, which is exactly what the "contracts first" rule (architecture §6) is meant to prevent.

## Decision

### State holds dynamic facts only (`state.ts`)

- **Static definitions** (names, recipes, base prices, market baselines, route geometry, equipment stats, characters) come from game-data and the scenario file, referenced by ID. They aren't copied into state.
- **Derived values** (net worth, balance-sheet totals, profit and cash-flow reports) are computed from state, never stored, so they can't drift from the ledger.
- What's left is the minimum needed to continue the game exactly:
  - the clock, seed, outcome, ID counters, and per-system RNG state
  - family and progression flags, facilities, inventory pools (total cost, never unit cost), reservations, production jobs, vehicles and deliveries (cargo keeps its cost basis)
  - market, supplier, buyer (including deal commitments), and route state
  - contract offers and contracts
  - the full ledger transaction log
  - queued commands, the applied-command log, scheduled world events, and the event journal
- **Same rules as the snapshot:** plain JSON-safe data, no optional fields (explicit `null`), arrays sorted by ID or by `(tick, sequence)`. A type-level test enforces the first two. Applying them caught `DispatchDeliveryCommand.routeId`, which was optional and is now `RouteId | null`.

### Determinism plumbing

- **RNG: xoshiro128\*\***, four 32-bit words per stream. It uses only integer operations (`Math.imul`, shifts), which behave identically in every engine. T01 implements it.
- **Separate streams per system** (`market`, `contracts`, `routes`, `production`). If one system starts drawing random numbers more often, the others' outcomes don't shift, so balance comparisons between lab runs stay meaningful.
- **Entity timers stay on entities.** A job's `completesAt`, a trip's `arrivesAt`, and an installment's `deadline` live on those records. `scheduledEvents` holds only world happenings with no owner (route closures and reopenings, shortages, contract offers). Each timer has one source of truth.

### The ledger is the full transaction log

Balances and every report are derived from the log. An M001 campaign produces a few thousand transactions at most. If longer campaigns make that heavy, compacting closed periods into opening balances is a later migration.

### Two layers (`save.ts`)

- **`SaveGame`** is what `Simulation.serialize()` returns: format tag, schema version, scenario ID, game-data version, and state. It contains no wall-clock time, so the simulation stays deterministic.
- **`SaveFile`** is what persistence (T06) writes: the `SaveGame`, app-written metadata (slot, label, real save time, app version), and a **state hash** checked on load. A mismatch is rejected (`HASH_MISMATCH`), not loaded. The hash algorithm over canonical JSON is T01's to define, since T01 also uses it for replay checks.

## Consequences

- This is the largest part of the contract, and the part most likely to have gaps. S0a and S0b are expected to find some. Their PRs list gaps, and fixes go through contract-change review, never inline (milestone 001).
- Any change to `GameState` bumps `SAVE_SCHEMA_VERSION` and needs a migration (ADR 0009).
- Snapshots are built from state plus game-data. `ContractTerms` in the snapshot extends the stored `ContractTermsData`, so the two can't diverge.

#### Amendment, 2026-11-04 (issue #36, from #34): what "sorted by ID" means

"Arrays sorted by ID" in state means sorted with **`compareIds`** from contracts, the same rule as the snapshot (see the ADR 0007 amendment): fixed-data IDs sort as text, and simulation-created IDs sort by prefix, then by numeric suffix (`res-9` before `res-10`). Lists of simulation-created records (reservations, production jobs, deliveries, contract offers, contracts) are kept in this order whenever a record is added.

The order feeds the state hash, which is why it's defined once in contracts rather than by each system. For simulation-created IDs it matches creation order, which is what S0a already produced, so existing saves already follow it and the save schema version stays 1. Lists in `(tick, sequence)` order are unchanged.
