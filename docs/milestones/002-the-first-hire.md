# Milestone 002: The First Hire

*(Name approved by the human. Role labels Distiller, Driver and Office Hand are approved as provisional labels; character identities, scene art and place stories remain human decisions.)*

Objective: turn M001's working economy into a game. You're one person in one place, you know only what you've seen or been told, every day has more to do than you can do, and hiring people gets you out from under it. Design: [GDD Part II, §16–§21](../game-design/gdd-v0.5.md).

M001 asked whether the system is correct. M002 asks whether it's fun. Automated checks still guard correctness, but **human playtests are the release gate**, not a final step. They run after each playable step, and their notes can change the task graph.

GitHub issues are the source of truth for task status. This file holds the graph, the acceptance criteria, and the factory metrics.

## Scenario

M001's economy, buyers, supplier, and routes, mostly unchanged, with a new start:

- **The founder starts alone.** There's no foreman. M001's foreman becomes the first distiller you can hire.
- **No phone of your own.** The nearest public phone is at the general store (placeholder).
- **One truck, which the founder drives.**
- Victory starts as in M001 (ADR 0020). At M002's slower pacing that run takes about 120 real minutes at 1× (GDD §16), so PT1 and T-LAB may revise session length, victory and contract timing.

## Experience criteria (human playtests)

The playtester, without being told:

1. Within the first ten minutes, feels they can't be everywhere at once, and makes at least one deliberate choice about what to leave undone.
2. Plans a day around place hours and travel. The order of the day matters, not just which tasks are in it.
3. Recognises when information may be stale, and makes an intentional choice: verify it (visit, call, message) or go ahead and take the risk. Either way, understands the consequences afterwards. A precaution that worked counts as proof the system works; being caught out isn't required.
4. Fits sleep into the day: it makes planning more interesting, not a chore, and they never feel trapped by it.
5. Feels the first hire free them up, and spends the freed time on something they couldn't do before.
6. Says the scenes feel more like being there than M001's panels did, even with placeholder art.

Each playtest records these as met, partly met, or not met, with notes, in the playtest issue.

## Technical acceptance (automated)

- Everything from M001 still holds: determinism, replay, balanced ledger, atomic commands, save/load.
- **No leaks:** two worlds that differ only in state the founder hasn't observed produce byte-identical player snapshots (property test, INFO-001). This covers every surface: offered actions, disabled states, validation errors, outcomes, activity messages and route indicators.
- **First hire is reachable:** a scripted and property-based check that from the starting cash, with M002's travel and action times, hours, sleep, wages and production/contract limits, a sensible founder can afford a first hire without a soft-lock. If it fails, M002 is retuned; M001's balance is not assumed to hold.
- **Rest never traps:** the founder can always reach a place to rest, and resting never blocks progress.
- Knowledge, authority, communication and presence are checked as four separate gates (ORD-001); standing orders act within their authority without a call per action.
- Knowledge records, messages, standing orders and the founder's position are saved, loaded and replayed exactly.
- Player and employee commands use the same gateway. A standing order never does anything the player couldn't have ordered.
- The economy lab's bots play under fog through the same snapshot as the player. Their balance targets are re-set for M002 pacing in T-LAB.

## Task graph

Design records come first, because each one changes contracts. Then a walking skeleton (like M001's Sprint Zero) before anything runs in parallel.

Phases (the table below has the exact dependencies):

```
Design records      D1  D2  D3  ──►  D4  D5
Walking skeleton    SK1 ─► SK2      R1 (first-hire reachability, after SK1 + D5)
                                  ▼
                               PT1 (human)
                                  ▼
Build               K2 ─► U3     C1     E1 ─► PT2 (human)     T-LAB
                                  ▼            ▼
Delegation                        E2 (driver)  E3 (office hand)
                                  ▼
                               PT3 (human): release gate
```

| ID (issue) | Task | Depends on | Mode |
|---|---|---|---|
| D1 (#168) | ADR: knowledge model. World vs knowledge, records and sources, which fields each source reveals, the player snapshot, the non-leak property | — | orchestrator, contract review |
| D2 (#169) | ADR: orders and outcomes. Splitting commands, which rejections may be immediate, outcome events, presence-gated orders | D1 | orchestrator, contract review |
| D3 (#170) | ADR: presence, time of day and rest. Founder entity, travel, which activities cost time (not clicks), place hours, the first sleep/rest implementation, overnight pacing, M002 clock pacing (§16) | D1 | orchestrator, contract review |
| D4 (#171) | ADR: telephones and messages (COMM-001) | D1, D2 | orchestrator, contract review |
| D5 (#172) | ADR: employees and standing orders (PERS-001) | D1, D2 | orchestrator, contract review |
| SK1 (#173) | Walking skeleton, headless: founder travels to the feed store, buys, goes to the still, starts a batch, drives a delivery, sleeps; knowledge records and catch-up summaries throughout | D1–D3 | agent, locked tests first |
| SK2 (#174) | Walking skeleton, browser: map navigation, a placeholder scene per place with state layers, the ledger view with "last updated" | SK1 | agent; visual direction → `ready-for-human` |
| PT1 (#175) | **Playtest 1:** alone, no hires, no phones. Is presence plus stale knowledge interesting, or a chore? Did the need to sleep make planning the day more interesting, without turning into a chore? Tests the 8-minute-day hypothesis against travel, hours, idle time and deadlines | SK2 | **human** |
| K2 (#177) | Knowledge everywhere: every M001 panel's data moved behind knowledge; the non-leak property test over the full snapshot | PT1 | agent, locked tests first |
| U3 (#178) | Known to-do list built from knowledge (PLAY-001 rule 2) | K2 | agent |
| C1 (#179) | Public phone at the general store: calls out, unanswered calls, calls in, messages; a phone as a purchasable asset | PT1, D4 | agent |
| E1 (#180) | Hiring and the distiller: candidates, wages, the standing order, reports | PT1, D5, R1 | agent, locked tests first |
| PT2 (#181) | **Playtest 2:** the first hire. Does it free you up? Is there something worth doing with the freed time? | E1 | **human** |
| E2 (#182) | Driver: deliveries without the founder; reports | PT2, C1 | agent |
| E3 (#183) | Office hand: answers your phone, takes messages, passes on orders | PT2, C1 | agent |
| R1 (#176) | First-hire reachability check (scripted + property-based) and the M002 scenario retune it drives: starting cash, wages, travel, hours, sleep | SK1, D5 | agent, locked tests first |
| T-LAB (#184) | Lab bots play under fog with M002 pacing; new balance targets; session length and victory retune (§16 knock-on) | K2, E1, R1 | agent |
| PT3 (#185) | **Playtest 3:** full M002. All six experience criteria | E2, E3, U3, T-LAB | **human** |

### Why a walking skeleton first

SK1/SK2 do for M002 what Sprint Zero did for M001: one complete path, through both the headless engine and the browser, before parallel work. It also gets to the first playtest as fast as possible. If presence plus stale knowledge is a chore rather than a game, PT1 should find that out before phones and hiring get built on top.

### Story and visual decisions (human)

These are open; placeholders stand in until the human decides, each tracked as a `needs-design` issue:

- Milestone name, role names, candidate names, and the founder's name.
- Scene art direction (M002 ships with placeholder art; playtests inform the final look).
- How the ledger looks: period account book, faded ink, date stamps.
- Where and how you find people to hire.
- Which places have public phones.

## Factory metrics

| Task | PR | Merged without rework? | Review rounds | Caught by |
|---|---|---|---|---|
| Issue links (orchestrator) | #186 | y | 0 | Nothing blocking. The reviewer checked every task-to-issue mapping and dependency line. Merged by: auto |
| D1 ADR 0021 (#168) | #187 | n | 5 | Round 1 (5 findings): the non-leak property could be satisfied by any leak and global ID counters leaked, always-known cash leaked installment outcomes, the live view went stale after paused commands, stored values carried world-computed affordances (a phone call leaked the buyer's budget through `maxAcceptableQuantity`), and nothing recorded which book rows were known. Round 2: hidden differences spread through the economy (fixed with a divergence set), `inTransit` leaked seizures, and the books were classified per kind instead of per transaction. Round 3: production completions are cash postings and leaked batch progress. Hit the 3-round cap, so `needs-human`; the human allowed rounds 4 and 5. Round 4: the round-3 edit left midnight wages at cash 0 with no rule. Round 5 approved. Follow-ups to #169, #172, #188 (K1). Human touches: 2 (round-cap decisions). Merged by: auto |
