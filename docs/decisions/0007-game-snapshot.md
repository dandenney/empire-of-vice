# 0007: The game snapshot

Status: proposed (T00b, issue #2)

## Context

Architecture §4: the UI holds no authoritative state and renders read-only snapshots the worker publishes. T04a's panels (dashboard, production, market, contracts, finance) and T04b's map have to be buildable from the snapshot alone, and T00b ships fixture snapshots so UI work can start before the simulation is real. GDD §8 requires profit, cash flow, and net worth as distinct metrics, and the finance panel has to explain why money changed.

## Decision

### Shape

`GameSnapshot` (`snapshot.ts`) has these top-level sections: `clock`, `outcome`, `family`, `finance`, `progression`, `locations`, `routes`, `facilities`, `productionJobs`, `vehicles`, `market`, `contracts`, `recentEvents`. Each maps to a panel or a map layer.

### Rules

- **Plain data only.** No functions, Maps, Sets, Dates, bigint, or `undefined`, and **no optional fields**: absent values are explicit `null`. A type-level test enforces this. The snapshot survives `postMessage`, JSON, and fixture files unchanged, and UI code never has to ask whether a key exists.
- **Lists are arrays sorted by ID**, so output is deterministic and fixture diffs are readable. The UI indexes them if it needs lookups.
- **Self-contained.** Entities carry display names, so panels don't join against game-data, and fixtures are complete.
- **The simulation computes anything the UI could get subtly wrong:**
  - net worth and the balance sheet totals
  - buyer quotes and `maxAcceptableQuantity` (the ECO-001 liquidity formula)
  - average unit cost
  - `maxStartableQuantity` for each recipe
  - **`blockedBy: RejectionReason | null`** on equipment, recipes, and contract offers

  `blockedBy` uses the same reason a command would be rejected with. The UI disables a button and shows exactly why, without reimplementing any rules.
- **Prices are explainable.** Each product price carries its base price, its clamped multipliers (M_D, M_S, M_E in ppm), and yesterday's price (ECO-001: "publish an explainable market report").

### Finance

- `cash`, `netWorth`, and per-period **profit** (`IncomeStatement`) and **cash flow** (`CashFlowStatement`) are separate fields, for today, the previous day, and to date. Buying a still uses cash but isn't an expense; producing goods costs cash but isn't a loss. Showing them separately is the point.
- `balanceSheet.equity` equals `netWorth`, and assets = liabilities + equity is a tested invariant (T02b).
- `recentTransactions` holds the latest balanced ledger transactions, each linked to its event. With ADR 0006's transaction IDs, that's what answers "why did cash drop?"
- The ledger types (`ledger.ts`) are defined here, because the snapshot and the coordinator both use them. The chart of accounts has a receivables account (unused in M001, per ADR 0005) and an explicit `LOSSES` account for write-offs (FIN-001).

### Map

- `locations` have an integer `WorldPoint` and an occupant (facility, supplier, or buyer).
- `routes` have waypoints, a duration, a transport cost, an open/closed status, and a risk figure, so route choice during a disruption is informed (GDD §4 action 8).
- A vehicle on the road has a `trip` with `departedAt`/`arrivesAt`, and the map interpolates its position along the waypoints (ADR 0003). The simulation never stores fractional positions.

### Size

`recentEvents` carries the last 100 events, and the full 1,000-event journal stays in state. Scheduling and throttling snapshots is T04a's job (the worker publishes periodically).

## Consequences

- T04a/T04b can build entirely against fixture snapshots (the fixtures come later in T00b).
- Every system task has to fill its part of the snapshot. Adding a field is a contract change, and the plain-data test keeps new fields honest.
- Some fields name tuning values that game-data defines (risk, wages, capacities). The snapshot only reports them.
