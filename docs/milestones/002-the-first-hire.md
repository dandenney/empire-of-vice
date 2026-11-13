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

Phases (the table below has the exact dependencies). Refreshed on 2026-11-12 after D1–D3 (factory.md §1): D5 and O1 were split, SK1 was split by ADR, and the contract tasks run one after another because they share files.

```
Design records      D1  D2  D3 (merged)  ──►  D4 ─► D5a ─► D5b       (one after another)
Contracts           K1 ─► P1 ─► O1a ─► O1b                          (one after another, save v2–v5)
Behaviour           SK1a (presence) ─► SK1b (knowledge) ─► SK1c (orders)
Walking skeleton    SK1d ─► SK2      R1 (first-hire reachability, after SK1d + D5a)
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
| D1 (#168) | ADR 0021: knowledge model (merged) | — | orchestrator, contract review |
| D2 (#169) | ADR 0022: orders, authority and outcomes (merged) | D1 | orchestrator, contract review |
| D3 (#170) | ADR 0023: presence, time of day and rest (merged) | D1 | orchestrator, contract review |
| D4 (#171) | ADR 0024: telephones and messages (COMM-001) | D1–D3 | orchestrator, contract review |
| D5a (#172) | ADR 0025: employees, hiring, authority and standing orders, reports, the Distiller (PERS-001) | D1–D3, D4 | orchestrator, contract review |
| D5b (#196) | ADR 0026: the Driver and the Office Hand | D4, D5a | orchestrator, contract review |
| D4b (#213) | ADR 0027: earned phone access and message-taking (the human's #203 decision), amending ADR 0024 | D4, D5b | orchestrator, contract review |
| D5c (#214) | ADR 0028: the hiring scene, the Distiller's hours and reports (the human's #209 decision), amending ADR 0025 | D5a, D5b, D4b | orchestrator, contract review |
| K1 (#188) | Knowledge contract (ADR 0021), save v2 | D1 | agent, contract review |
| P1 (#193) | Presence contract (ADR 0023), save v3; flag-off no-op founder commands | D3, K1 | agent, contract review |
| O1a (#192) | Deals and every command-shape change (ADR 0022 + 0023 `driver`), save v4; one re-lock pass over nine locked files; M001-equivalent with the flag off | D2, D3, P1 | agent, contract review, two-step re-lock |
| O1b (#197) | Production conversion cost paid at start (ADR 0022 decision 7), save v5 | O1a | agent, contract review, two-step re-lock |
| SK1a (#198) | Presence behaviour: travel, rest, busy, hours, the founder phase, the founder as driver | P1 | agent, locked tests first |
| SK1b (#199) | Knowledge behaviour: live view, persist, catch-up, news, books, the `playerSnapshot()` builder | K1, SK1a | agent, locked tests first |
| SK1c (#200) | Orders behaviour: `IssuerView` validation, presence gates, on-spec sales, per-trip randomness | O1a, O1b, SK1a, SK1b | agent, locked tests first |
| SK1d (#173) | Walking skeleton, headless: the M002 scenario end to end (wake, feed store, still, on-spec delivery, sleep) | SK1a–c | agent, locked tests first |
| SK2 (#174) | Walking skeleton, browser: map navigation, a placeholder scene per place with state layers, the ledger view with "last updated" | SK1d | agent; visual direction → `ready-for-human` |
| PT1 (#175) | **Playtest 1:** alone, no hires, no phones. Is presence plus stale knowledge interesting, or a chore? Did the need to sleep make planning the day more interesting, without turning into a chore? Tests the day-length hypothesis against travel, hours, idle time and deadlines | SK2 | **human** |
| K2 (#177) | Knowledge everywhere: every M001 panel's data moved behind knowledge; the `GameSnapshot` lint boundary; the non-leak property test over the full snapshot | PT1 | agent, locked tests first |
| U3 (#178) | Known to-do list built from knowledge (PLAY-001 rule 2) | K2 | agent |
| C1 (#179) | Public phone: calls out, unanswered calls, calls in, messages; a phone as a purchasable asset | PT1, D4 | agent |
| E1 (#180) | Hiring and the Distiller: candidates, wages, the standing order, reports | PT1, D5a, R1 | agent, locked tests first |
| PT2 (#181) | **Playtest 2:** the first hire. Does it free you up? Is there something worth doing with the freed time? | E1 | **human** |
| E2 (#182) | Driver: deliveries without the founder; reports | PT2, C1, D5b | agent |
| E3 (#183) | Office Hand: answers your phone, takes messages, passes on orders | PT2, C1, D5b | agent |
| R1 (#176) | First-hire reachability check (scripted + property-based) and the M002 scenario retune it drives: starting cash, wages, travel, hours, sleep | SK1d, D5a | agent, locked tests first |
| T-LAB (#184) | Lab bots play under fog with M002 pacing; new balance targets; session length and victory retune (§16 knock-on) | K2, E1, R1 | agent |
| PT3 (#185) | **Playtest 3:** full M002. All six experience criteria | E2, E3, U3, T-LAB | **human** |

### Why a walking skeleton first

SK1/SK2 do for M002 what Sprint Zero did for M001: one complete path, through both the headless engine and the browser, before parallel work. It also gets to the first playtest as fast as possible. If presence plus stale knowledge is a chore rather than a game, PT1 should find that out before phones and hiring get built on top.

### Story and visual decisions (human)

These are open; placeholders stand in until the human decides, each tracked as a `needs-design` issue:

- Milestone name, role names, candidate names, and the founder's name.
- Scene art direction (M002 ships with placeholder art; playtests inform the final look).
- How the ledger looks: period account book, faded ink, date stamps.
- Where and how you find people to hire: decided in #209 (Miller's, by word of mouth), recorded by D5c (#214).
- Which places have phones, and who may use them: decided in #203 (earned access), recorded by D4b (#213).

## Factory metrics

| Task | PR | Merged without rework? | Review rounds | Caught by |
|---|---|---|---|---|
| Issue links (orchestrator) | #186 | y | 1 | Nothing blocking. The reviewer checked every task-to-issue mapping and dependency line. Merged by: auto |
| D1 ADR 0021 (#168) | #187 | n | 5 | Round 1 (5 findings): the non-leak property could be satisfied by any leak and global ID counters leaked, always-known cash leaked installment outcomes, the live view went stale after paused commands, stored values carried world-computed affordances (a phone call leaked the buyer's budget through `maxAcceptableQuantity`), and nothing recorded which book rows were known. Round 2: hidden differences spread through the economy (fixed with a divergence set), `inTransit` leaked seizures, and the books were classified per kind instead of per transaction. Round 3: production completions are cash postings and leaked batch progress. Hit the 3-round cap, so `needs-human`; the human allowed rounds 4 and 5. Round 4: the round-3 edit left midnight wages at cash 0 with no rule. Round 5 approved. Follow-ups to #169, #172, #188 (K1). Human touches: 2 (round-cap decisions). Merged by: auto |
| D2 ADR 0022 (#169) | #191 | n | 3 | Round 1 (12 findings): commands naming simulation-created IDs resolved their place from the world (`ACCEPT_CONTRACT`, `RELEASE_RESERVATION`, `REPEAT_OPERATION`); installment checks read hidden progress; a by-phone deal leaked the budget; vehicle rejections leaked whereabouts; the on-spec arrival was undefined (a false `GAME_LOST` risk); commitments keyed by delivery; an unsound migration; the new account missing from finance; a wrong funds-check claim; per-trip RNG still coupled; no channel mapping; the lab and sale form broken. Round 2: dispatched deals leaked through time-based expiry, the deal deadline silently changed M001's `TOO_LATE` rule, and the re-lock list was incomplete (all ten locked files). Round 3 approved. Written in parallel with ADR 0023 and aligned twice. Follow-ups to O1 #192, #172. Merged by: auto |
| D3 ADR 0023 (#170) | #190 | n | 4 | Written by a forked agent. Round 1 (8 findings): the migration read game-data, `parkedAt` couldn't describe a moving truck, arrival-tick presence was undefined, the tick order and departure persistence were missing, the tiredness scope and no-trap bound were wrong, shapes were undefined, the TRAVEL/REST/WAKE rejections fell between ADRs, and pacing broke the lab's M001 targets. Round 2: the tick order didn't match the kernel, the no-trap bound could be postponed by queued commands, and a false claim about the dispatch origin. Round 3: a same-tick race at the end of a busy activity plus an off-by-one in the bound. Hit the cap, so `needs-human`; the human allowed round 4, which approved. Follow-ups to P1 #193. Human touches: 1. Merged by: auto |
| Factory checklist (orchestrator) | #195 | n | 2 | Round 1: the reviewer half of the design-record checklist wasn't in §7.4's review steps, and "written one after another" had no dispatch mechanism (fixed: the refresh lists the earlier record under Depends on). Merged by: auto |
| Milestone table (orchestrator) | #201 | n | 2 | Round 1: E2/E3 issues lacked the D5b dependency the table gave them, and K2's issue didn't carry the `GameSnapshot` lint boundary. Fixed in the issues; the table commit was re-approved unchanged. Merged by: auto |
| D4 ADR 0024 (#171) | #202 | n | 2 | Round 1: "older never overwrites newer" let a same-tick older value win, the migration missed `CatchUp.messages`/`droppedMessages`, and one attendant hook signature couldn't express two requirements. Placeholders became #203, later answered by the human. Merged by: auto |
| K1 knowledge contract (#188) | #204 | y | 1 | Nothing blocking. Merged by: auto |
| P1 presence contract (#193) | #206 | y | 1 | Approved first round, but merged with red CI (a chained `checks; merge`): P1 broke the Linux map screenshot baseline. Fixed by #207; the orchestrator now gates merges on a green check. Merged by: auto |
| Fix map baseline (orchestrator) | #207 | y | 1 | Restored green `main` after #206. Merged by: auto |
| D5a ADR 0025 (#172) | #208 | n | 2 | Round 1: employee commands minting IDs from the founder's counters broke exact replay, the migration missed saved `DeliveredMessage`s, and re-hiring someone contradicted "the founder already knows them". Placeholders became #209, later answered by the human. Merged by: auto |
| O1a deals and command shapes (#192) | #212 | n | 1 | CI fix round 1: the Linux `activity.png` baseline. `AGREE_DEAL` posts an entry-less transaction that takes a slot in the 50-transaction snapshot window, so three old rows dropped off (intended). Approved first review; files outside the owned list were judged forced caller updates. Main merged in, approval carried over. Non-blocking follow-ups to #199, #177, #200. Merged by: auto |
| D5b ADR 0026 (#196) | #211 | n | 2 | Round 1 (4 findings, all from the human's #203/#209 answers that landed after it was written): the Office Hand and Distiller answered day and night, the Driver's road calls used a guest/fee phone for free, a settled Kessler question stayed open, and the Office Hand showed an exact competence. Deferred to ADR 0027/0028. Merged by: auto |
| O1b production cost at start (#197) | #217 | n | 1 | Step-1 re-lock took four files (incl. `repeat.locked.test.ts`, which the ADR's list missed). CI fix round 1: `finance.png`/`activity.png` baselines. Approved first review; lab outcomes and final net worth identical, cash only shifts earlier. Follow-ups to #199. Merged by: auto |
| D4b ADR 0027 (#213) | #216 | n | 3 | From the human's #203 decision. Round 1: the call pause couldn't fire under batched advance, the lapse bound was wrong (consecutive-day purchases can be ~2 days apart), a false premise in the non-leak argument, callers' hours on calls in. Round 2: the pause fix didn't match the code (`step()` removes the batch; an eager `PLACE_CALL` applies inside `dispatch`). Round 3 approved. Follow-ups to #205, #179, #183, #214; planned #219. Merged by: auto |
| SK1a presence behaviour (#198) | #218 | n | 2 | Rework: a locked-test re-lock before review (no review or CI fix round). The implementer found the locked no-trap test defective (example 8 dispatched on spec, rejected since O1a); the orchestrator re-locked it (§7.3). Flag off byte-identical over the 1 000-seed lab. Approved; re-reviewed after a `main` merge touched ADR 0023 in its diff. Follow-ups to #200, #199→#174, #177. Merged by: auto |
| Metrics and process (orchestrator) | #220 | n | 3 | Round 1: §6's new review-round definition contradicted §7.4 ("a CI fix counts as a review round"). Round 2: the orchestrator's own fix made §7.4 count CI fixes toward the cap, which §7.5 doesn't. Resolved: CI fixes are noted under "Caught by" and escalate under §7.7. Merged by: auto |
| D5c ADR 0028 (#214) | #221 | n | 2 | From the human's #209 decision. Round 1: "reports never toast" rested on `EVENT_IMPORTANCE` "log", but an employee's batch emits `PRODUCTION_COMPLETED`/`FAILED` (notify, toast mappers) and "log" doesn't stop toasts. Re-grounded in ADR 0021's no-forwarding rule, owned by K2 (#177). The EM1 contract list was incomplete. Main merged in, approval carried over. Follow-ups to #177, #180, #210; planned #223; needs-design #224 (answered). Merged by: auto |
| SK1b knowledge behaviour (#199) | #225 | n | 1 | Locked non-leak test re-locked once: the two property tests exceeded Vitest's 5 s default on CI (timeouts only). Approved first review; flag off byte-identical. K1 follow-ups and review notes moved to #177, #205, #182, #200 before merge. Merged by: auto |
| PH1 phone contract (#205) | #227 | n | 1 | ADR 0027's "Re-locks: None" missed SK1a's no-trap test, which compares a PRESENT founder exactly; re-locked for the new required `call: null`. Approved first review; lab outcomes identical, the Sprint Zero hash moves only by the five new fields. Follow-ups to #179, #200, #210. Merged by: auto |
| SK1c-1 orders: issuer view and presence gates (#200) | #229 | n | 2 | Split from SK1c (oversized). Two re-locks before review: PH1's five codes missing from the exhaustive `COVERAGE`, and no-trap agreed a deal remotely, which the presence rule now forbids. Round 1: a contract delivery accepted on stale known progress was paid in full on arrival after the contract closed; fixed with a `CONTRACT_CLOSED` fall-through. Follow-ups to #177, #226. Merged by: auto |
| SK1c-2 on-spec, per-trip randomness, #222 (#226) | #230 | n | 2 | Four locked files re-locked step 1. Round 1: events at a delivery stop were treated as road events, so the truck's record at the stop was stamped at the route start. Hashes unchanged (safe routes draw nothing); the lab shifts only market-opportunist, within variance. Implements the human's #222 decision. Merged by: auto |
| SK1d M002 walking skeleton (#173) | #233 | y | 1 | The locked path test passed unedited on first run. Approved first review; tuning notes to R1 (#176), founder-alone/foreman to E1 (#180), road-record provenance to SK2 (#174). Merged by: auto |
| SK2a browser plumbing (#174) | #235 | y | 1 | Split from SK2. The player snapshot only, no world events to the UI (both gates mutation-tested by the reviewer), fast-forward, save scenario. Approved first review; `stateHash` on the player message moves to test-only in K2 (#177). Merged by: auto |
| EM1 employee contract (#210) | #236 | y | 2 | Step-1 re-lock of `issuer-view` for five new codes. Approved first review; re-reviewed after a `main` merge touched `sprint-zero.spec.ts`. Lab outcomes identical; hashes move only by new fields. Follow-ups to #180, #231. Merged by: auto |
