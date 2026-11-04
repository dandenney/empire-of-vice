# Milestone 001: The First Shipment

Objective: prove that producing, transporting, and selling moonshine creates a satisfying economic loop. Full scope: [GDD §4](../game-design/gdd-v0.5.md).

GitHub issues are the source of truth for task status. This file holds the graph and the factory metrics.

## Task graph

```
T00a ─► T00b ─► T01 ─► S0a ─► S0b ─┬─► T02a ─┬─► T02c ──────────────┬─► T07a ─┐
                                   │         │                      │         │
                                   ├─► T02b ─┼─► T02d ─► T02e ──────┤         ├─► T05 ─► T06
                                   │         │                      │         │
                                   │         └─► T03 ───────────────┴─────────┘
                                   │
                                   └─► T04a ─► T04b ─────────────────────────────────────► T06
T05 ─► T07
```

| ID | Task | Depends on | Mode |
|---|---|---|---|
| T00a | Workspace, tooling, CI | — | agent |
| T00b | Shared contracts and coordinator interface | T00a | **human-paired** |
| T01 | Deterministic simulation kernel (SIM-001) | T00b | agent |
| T01b | Command log covers apply-time rejections (#25) | T01 | agent, contract review |
| S0a | Sprint Zero, headless: one case of moonshine, end to end in Node | T01 | agent, closely reviewed |
| S0b | Sprint Zero, browser: same path through a Web Worker | S0a | agent, closely reviewed |
| T02a | Inventory and weighted-average costing (FIN-001) | S0b | agent, locked tests first |
| T02b | Ledger and transaction coordinator (FIN-001) | S0b | agent, locked tests first |
| T02c | Production, equipment, workforce (PROD-001) | T02a, T02b | agent |
| T02d | Daily market, buyers, spot sales, shortages (ECO-001) | T02a, T02b | agent |
| T02e | Recurring contracts (ECO-001) | T02d | agent |
| T03 | Logistics and route disruption | T02a | agent |
| T04a | Management panels and speed scheduler | S0b | agent |
| T04b | PixiJS map | T04a | agent |
| T07a | Economy smoke loop (balance early warning) | T02c, T02d, T01b | agent |
| T05 | Progression, scenario, repeat orders, victory (PROG-001) | T02c, T02e, T03, T07a | agent |
| T06 | Integration and persistence | T04a, T04b, T05 | agent |
| T07 | Balance laboratory (GDD §13) | T05 | agent |

### Why Sprint Zero first

GDD §12: before parallelizing, build one complete path, *create game → buy ingredients → produce one case → dispatch truck → deliver → sell → record profit → save → reload*, through both browser and headless engine. It flushes out contract gaps while they're cheap to fix and gives every later task a working skeleton to extend. S0 is split into a headless half (S0a) and a browser half (S0b) to keep each PR M-sized, and both finish before parallel work starts. Each T02/T03/T04 task then owns the module S0 stubbed and deepens it to full spec.

### Parallelism

- T00a → T00b (with you) → T01 → S0a → S0b, strictly one at a time.
- After S0b: T02a, T02b, and T04a in parallel. T04b follows T04a.
- T01b (a follow-up from T01 review) can run alongside S0a: it touches only the kernel, the command queue, and one doc comment in contracts. It has to land before T07a.
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
| T00a | #18 | y | 0 (merged with no review comments) | Nothing caught by checks or review. The agent flagged its own open questions: TS 7 vs typescript-eslint, `.nvmrc`, and the wrong `CLAUDE.md` section number |
| T00b | #21 | y | 7 (one per step, paired; every step approved, none sent back) | The type-level plain-data test caught an optional `routeId` on `DISPATCH_DELIVERY`, which broke the no-optional-fields rule for stored state. Fixed before the step was approved |
| T01 | #23 | n | 1 | Orchestrator review: a rejected dispatch still advanced the command counters, contradicting the contract ("rejected: nothing changed") and breaking replay. CI and the agent's tests missed it because nothing tested that promise directly. Also, the issue needed a refresh before handoff (wrong test path, missing dependency, stale command semantics), which led to the refresh rule in `factory.md` (#22). Follow-up: #25 |
