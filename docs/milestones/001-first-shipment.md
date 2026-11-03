# Milestone 001: The First Shipment

Objective: prove that producing, transporting, and selling moonshine creates a satisfying economic loop. Full scope: [GDD §4](../game-design/gdd-v0.5.md).

GitHub issues are the source of truth for task status. This file holds the graph and the factory metrics.

## Task graph

```
T00a ─► T00b ─► T01 ─► S0 ─┬─► T02a ─┬─► T02c ──────────────┬─► T07a ─┐
                           │         │                      │         │
                           ├─► T02b ─┼─► T02d ─► T02e ──────┤         ├─► T05 ─► T06
                           │         │                      │         │
                           │         └─► T03 ───────────────┴─────────┘
                           │
                           └─► T04 ─────────────────────────────────────────► T06
T05 ─► T07
```

| ID | Task | Depends on | Mode |
|---|---|---|---|
| T00a | Workspace, tooling, CI | — | agent |
| T00b | Shared contracts and coordinator interface | T00a | **human-paired** |
| T01 | Deterministic simulation kernel (SIM-001) | T00b | agent |
| S0 | Sprint Zero: one case of moonshine, end to end | T01 | agent, closely reviewed |
| T02a | Inventory and weighted-average costing (FIN-001) | S0 | agent, locked tests first |
| T02b | Ledger and transaction coordinator (FIN-001) | S0 | agent, locked tests first |
| T02c | Production, equipment, workforce (PROD-001) | T02a, T02b | agent |
| T02d | Daily market, buyers, spot sales, shortages (ECO-001) | T02a, T02b | agent |
| T02e | Recurring contracts (ECO-001) | T02d | agent |
| T03 | Logistics and route disruption | T02a | agent |
| T04 | Map and management UI | S0 | agent |
| T07a | Economy smoke loop (balance early warning) | T02c, T02d | agent |
| T05 | Progression, scenario, repeat orders, victory (PROG-001) | T02c, T02e, T03, T07a | agent |
| T06 | Integration and persistence | T04, T05 | agent |
| T07 | Balance laboratory (GDD §13) | T05 | agent |

### Why Sprint Zero first

GDD §12: before parallelizing, build one complete path, *create game → buy ingredients → produce one case → dispatch truck → deliver → sell → record profit → save → reload*, through both browser and headless engine. It flushes out contract gaps while they're cheap to fix and gives every later task a working skeleton to extend. Each T02/T03/T04 task then owns the module S0 stubbed and deepens it to full spec.

### Parallelism

- T00a → T00b (with you) → T01 → S0, strictly one at a time.
- After S0: T02a, T02b, and T04 in parallel.
- After T02a + T02b: T02c, T02d, and T03 in parallel.

### GDD §14 open details: where each gets decided

| # | Detail | Decided in |
|---|---|---|
| 1 | Starting balance sheet | T05 |
| 2 | Starting reputation | T05 |
| 3 | Recipes and wages | T02c |
| 4 | Buyer configuration | T02d |
| 5 | Contract availability timing | T02e, validated by T07a |
| 6 | Route configuration | T03 |
| 7 | Payment timing (immediate vs receivable) | T00b |
| 8 | Reservation release rules | T02a |
| 9 | Recovery mechanism | T05 |
| 10 | Save migration policy | T00b |

## Factory metrics

| Task | PR | Merged without rework? | Review rounds | Caught by |
|---|---|---|---|---|
| | | | | |
