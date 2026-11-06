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
                                   └─► T04a ─┬─► T04b ───────────────────────────────────► T06
                                             └─► T04c ───────────────────────────────────► T06
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
| T04c | Market, Contracts and Facility panels (split from T04a, #50) | T04a | agent |
| T07a | Economy smoke loop (balance early warning) | T02c, T02d, T01b | agent |
| T05 | Progression, scenario, repeat orders, victory (PROG-001) | T02c, T02e, T03, T07a | agent |
| T06 | Integration and persistence | T04a, T04b, T04c, T05 | agent |
| T07 | Balance laboratory (GDD §13) | T05 | agent |

### Why Sprint Zero first

GDD §12: before parallelizing, build one complete path, *create game → buy ingredients → produce one case → dispatch truck → deliver → sell → record profit → save → reload*, through both browser and headless engine. It flushes out contract gaps while they're cheap to fix and gives every later task a working skeleton to extend. S0 is split into a headless half (S0a) and a browser half (S0b) to keep each PR M-sized, and both finish before parallel work starts. Each T02/T03/T04 task then owns the module S0 stubbed and deepens it to full spec.

### Parallelism

- T00a → T00b (with you) → T01 → S0a → S0b, strictly one at a time.
- After S0b: T02a, T02b, and T04a in parallel. T04b and T04c follow T04a.
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
| T01b | #28 | n | 1 (post-merge review) | Merged before review, by a human. The post-merge review found the replay property never hit the eager `rejected-on-apply` path: replaying the whole log at the end meant a `drained`→`s` mutant in `simulation.ts` survived. Fixed in #30 (incremental replay, plus a check that the path fires). Merged by: human |
| S0a | #29 | n | 1 (post-merge review) | Merged before review, by a human. The post-merge review found the `INSUFFICIENT_FUNDS` purchase test sat behind an always-false guard, so disabling the cash check in `market.ts` survived. Fixed in #35 (#31), which also derived the hardcoded test numbers from game-data. Merged by: human |
| S0a-fix | #35 | y | 0 | Nothing. First auto-merge: review-agent APPROVE on the head commit, green CI. Merged by: auto |
| Rules (orchestrator) | #37 | n | 1 | Review agent: the issue template gave every new issue `needs-design`, and there was no consistent way to change contracts (the dispatch prompt and review checklist both forbade contract edits). Fixed in round 1. Merged by: human (the auto-mode permission check blocked the orchestrator's merge) |
| Contract batch (#36) | #39 | y | 0 | Nothing blocking. Mutation testing found that removing the job and delivery sorts goes uncaught (follow-up #44). Merged by: human |
| S0b | #40 | n | 0 (post-merge review) | Merged before review, by a human; the post-merge review approved. Merged in parallel with #39, and the combination turned `main` red (`VEHICLE_RETURN` missing from the projection map, stale e2e hash), even though both PRs were green on their own. Fixed in #42. Latent bugs filed as #43. Merged by: human |
| S0b-fix (#41) | #42 | y | 0 | Nothing blocking. A mutation survived because the no-cash guard has no test (added to #43). First merge by the orchestrator under the new rules. Merged by: auto |
| S0b-follow (#44) | #46 | n | 0 | The implementing agent found that moving the projection broke an assertion in a file #43 owned. The orchestrator gave #44 that one assertion (§8), so it was fixed before review. Review: nothing blocking; mutation tests confirmed the new ID-order tests bite. Merged by: auto |
| S0b-follow (#43) | #47 | y | 0 | Nothing blocking. The review checked that the throwaway-kernel dry run leaves the state hash and RNG unchanged, and measured its cost. Left out: `START_PRODUCTION` throws on overflow (rule 6), passed to #7. Approval carried over after merging `main`. Merged by: auto |
| Locked-test dispatch (orchestrator) | #51 | n | 2 | Round 1: the locked file conflicted with §5's owned-files and no-locked checks, and §7.3 didn't cover the test-writer step. Round 2: the locked SHA came from the PR body, so an implementer could certify its own edit. It's now recorded by the orchestrator. Approval carried over after merging `main`. Merged by: auto |
| T02b (#6) | #55 | y | 0 | Nothing blocking. First two-step locked dispatch to merge. The review used 44 one-line mutations and an instrumented run. The run checked that the coordinator stays incremental (0 full recomputes vs 370 for a naive version). Surviving mutants: the `cashAvailable < 0` clamp, the memo length guard, and the incrementality itself (non-blocking). Approval carried over after merging metrics-only `main`. Merged by: auto |
| T02a (#5) | #53 | n | 1 | Review mutation testing: `takeMaterial` ignored reservations and no test caught it (locked tests only checked `takeProduct`). Fixed in round 1 with a test for unreserved-only removal, plus overflow-guard tests. Approval carried over after merging `main` (incl. #55). Merged by: auto |
| T04a (#11) | #54 | n | 1 | Review mutation testing: the `#accrue()` before a speed change in `scheduler.ts` had no test, so ticks owed at the old speed could be lost. Fixed in round 1. The round-3 review also found the unseeded replay coverage flake (#64). Approval carried over after merging `main`. Merged by: auto |
| ADR 0016 (orchestrator) | #59 | n | 1 | The review found that the market RNG draw order, the multi-shortage `eventRatio` fold, the `dayIndex` convention, and the quote rounding were all unpinned. Each of them would have made the T02d locked tests ambiguous. Fixed in round 1. Merged by: auto |
| #49 rename | #65 | y | 0 | Nothing blocking. Non-blocking: the contract fixtures use `ticksPerCase` 1 440 vs game-data's 144. Approval carried over after merging `main` (#59, ADR only). Merged by: auto |
| ADR 0017 (orchestrator) | #62 | n | 2 | Round 1: throughput rounding and zero cases, `DAY_SETTLED` mapping, and a wrong GDD citation. Round 2: the T02c1 condenser timing wouldn't survive T02c2's crew factor at 3 workers, which would have forced a locked-test fix round. Fixed by pinning the fixture to the full crew. CI on the approved commit hit a pre-existing replay bug on `main` (#66). Approval carried over after merging `main`. Merged by: auto |
| #66 replay fix | #68 | n | 1 | Review: the new ADR 0004 bullet gave the wrong reason trailing envelopes land at end tick + 1 (the eager path drains queued E + 1 commands first). #14's `replayJournal` will take its rules from that ADR, so it blocked. Fixed in round 1. Merged by: auto |
| T02d (#8) | #69 | n | 1 | Review: the PR's Sprint Zero hash explanation named only the buyer data; a full-state diff showed the decision-2 market baselines (D₀/S₀) changed too. Fixed in round 1 (PR body and the hash History note). Merged by: auto |
| T02c1 (#7) | #70 | y | 0 | Nothing blocking. Hand mutation testing (36 mutants): the failure-threshold boundary (`<` vs `<=`) and the due-job sort survive, and a test hard-codes `"copper-still"`. Passed to T02c2 (#63) and T03 (#10). Merged by: auto |
| #64 replay coverage | #71 | y | 0 | Nothing. The reviewer reran the replay suite 40 times with no failures. Merged by: auto |
| #56 ledger re-exports | #72 | y | 0 | Nothing. The export test checks identity, not just presence. Merged by: auto |
| ADR 0018 (orchestrator) | #74 | n | 1 | Round 1: the contract reservation list was unpinned, and the midnight-tick offer rules (create vs expire on the same tick) were ambiguous. Either would have made the T02e locked tests ambiguous. Fixed in round 1. Merged by: auto |
| ADR 0019 (orchestrator) | #75 | n | 2 | Round 1 (7 findings): the dispatch funds check could soft-lock a player with cargo but no cash, and cargo after a seizure had no defined state, among others. Round 2: closures with a null `reopensAt` never reopened, and decision 2 changed tests the ADR didn't list. Fixed in round 2. Merged by: auto |
| T02c2 (#63) | #78 | y | 0 | Nothing blocking. The Production panel screenshot baseline was regenerated from a CI actual. 5 non-blocking mutants survived: the queue-time full-crew bound, the condenser overflow bound, and −0 handling. Approval carried over after merging `main`. Merged by: auto |
| T02e (#9) | #79 | y | 0 | Nothing blocking. Hand mutation testing (13 mutants): 7 killed, 3 equivalent, 3 real gaps survived (the reservation top-up's delivered-case subtraction, the closed-contracts tie-break, and the in-transit arrival order), copied to #13. The implementer was stopped mid-merge at a session pause; the orchestrator merged `main` (#78) before review. Approval carried over after merging `main` (#80). Merged by: auto |
| #83 flaky locked test | #84 | y | 0 | Found by the #81 agent's local run, then failed CI on #82. The locked PROD-001 `jobDuration` property generated durations above `MAX_SAFE_INTEGER`, which the implementation correctly rejects. It was a test defect, fixed by a test-writer. Non-blocking: the out-of-range branch is hit in under 1 in 1 000 cases (a removed range check was caught 7 of 40 runs), noted on #83. Merged by: auto |
| T07a (#12) | #85 | y | 0 | Nothing blocking (5 non-blocking, copied to #15). The reviewer re-ran two seeds with per-tick stepping and matched the event-driven runner exactly. Headline finding: a greedy spot seller loses money under placeholder tuning (S₀ volume cut, drift vs margin); report copied to #13. Approval carried over after merging `main` (#79, #80, #84); the orchestrator re-ran the smoke on the merged head and the report was unchanged. Merged by: auto |
