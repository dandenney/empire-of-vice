# Retrospective: Empire of Vice as a software-factory experiment

*Written 2026-11-14, when the project was shelved after milestones 001 and part of 002.*

## The question

Can a software factory build a real, non-trivial system when the human only steers? In practice, that means agents write the issues, tests, code and reviews, and the human decides story and visual direction.

**Answer: yes, for the system. The game is a different question, and this experiment didn't answer it.** In 11 days the factory produced a deterministic economic simulation: double-entry accounting in integer cents, replayable, versioned saves with migrations, a per-player knowledge fog with a property-tested non-leak guarantee, founder presence and travel, telephones, and a hiring model. On top of it sit a React and PixiJS UI and a headless economy lab. The human played it. The part that would make it a *game* (a world you can move through, characters, feel) depends on a game designer's taste at the review gate. That's a question about the human, not the factory (see "The human at the gate").

## By the numbers

| | M001 *The First Shipment* | M002 *The First Hire* (partial) | Total |
|---|---|---|---|
| Calendar | Nov 3–10 | Nov 11–13 | 11 days |
| Merged task PRs in metrics tables | 68 | 29 | 97 |
| Merged without rework | 34 (50%) | 9 (31%) | 43 (44%) |
| Review rounds (total) | 34 | 55 | 89 |
| Merged automatically / by the human | 59 / 6 | 27 / 2 | 86 / 8 |
| Decision records (ADRs) | 0001–0020 | 0021–0029 | 29 |

Across the repo: 126 merged PRs, 484 commits, 121 issues, and about 74k lines of TypeScript including tests (simulation 37k, UI 16k, contracts 10k, lab 6k, game data 3k, persistence 2k).

The two milestones were different kinds of work. M001 built a system from a clear spec, and half its PRs merged without rework. M002 changed the rules of an existing system (knowledge, presence, orders) under a strict compatibility rule. Rework rose, and review rounds per PR more than tripled, from 0.5 to 1.9.

## What worked

**Contracts first, behaviour second.** A `contracts` package held every type, command, event and snapshot, so parallel agents couldn't invent their own versions. Changing a contract required a review. Behaviour tasks rarely conflicted.

**Locked acceptance tests written by a different agent.** A test-writer commits the `@locked` acceptance test, and the implementer starts from that commit and may not edit it. This was the factory's strongest guard against an agent "passing" by weakening the test. The walking skeleton's locked path test (SK1d, #233) passed unedited on its first run.

**Determinism as a test multiplier.** A seeded RNG, no wall clock, and replay hashes meant every change could prove "nothing else moved." For example, the flag-off run had to be byte-identical across the 1,000-seed lab. Reviewers used this constantly, and it made refactors safe.

**A separate review agent with real teeth.** It caught bugs that tests and CI missed, often by mutation testing: a rejected command that still advanced counters (T01, #23), a replay property that never exercised the path it claimed (T01b, #28), and a phone call that leaked a buyer's budget (ADR 0021). An agent never reviewed its own work.

**Issue refresh before dispatch.** Issues written ahead of time go stale as decisions merge. Re-reading each issue against `main` before marking it `agent-ready` (`factory.md` §1) removed a whole class of wrong-path and stale-contract failures after T01.

**Metrics in every milestone doc.** A row per merged PR (rework, rounds, what was caught, who merged it) made the factory's weak spots visible and drove most process changes. Keeping these rows in their own PRs stopped them from tangling with real reviews.

**Human decisions as plain issue comments.** Story and design questions went into `needs-design` issues, and the human answered them in a sentence. Each answer became an ADR amendment within hours: phones (#203 → ADR 0027), hiring (#209 → ADR 0028), two-stage production (→ ADR 0029).

## What cost too much

**ADR weight on design-heavy work.** M002's first three ADRs needed 12 review rounds between them, and one round turned up 12 findings. Most findings were *facts* the author hadn't gathered: which locked tests would break, which transaction producers existed, what the migration could read. The fix was a pre-writing fact checklist (`factory.md` §1, "Design-record tasks"), which helped. Even so, 29 ADRs in 11 days is heavy, and the cost fell on the parts that most needed fast iteration.

**Re-lock churn.** Every rule change in M002 broke locked tests written for M001. Some re-locks were planned and some found defective tests, and the process for telling them apart took two metrics PRs to settle (#220, #238). The "exhaustive re-lock table" in ADR 0029 shows how much bookkeeping this needed.

**The orchestrator reviewing its own process.** Process PRs (metrics definitions, checklist rules) went through the same review loop and sometimes took three rounds to agree on wording (#220). That was useful once and overhead after that.

**One gate failure that taught a rule.** A chained `checks; merge` merged P1 with red CI (#206) and broke the screenshot baseline on `main`. Fixed in #207. Since then the orchestrator merges only after a green check.

**Placeholder UI for too long.** The UI was correct and test-covered, but it stayed "enterprise software": panels, ledgers and forms. The factory's checks (typecheck, screenshots, Playwright) prove a screen is *right*, not that it feels like anything. Experience criterion 6 in M002 ("feels like being there") was never something the factory could check.

## The human at the gate

The clearest lesson. **A factory does best when the person at the gate can tell good from bad in seconds.**

Here, the human could do that for the economy and the rules. One look at the build produced the two-stage-production decision, which reshaped the game for the better. They couldn't do it for a game's feel, art and characters, and didn't want to learn that craft. The factory can implement anything a reviewer can specify, but it can't supply the taste that decides what to specify. So the next domain should be one where the human is already the expert judge.

## Where it stopped

- `main` is green. M001 is complete, and M002 runs through the employee contract, the map/scenes/ledger UI, and the two-stage-production design (ADR 0029).
- PR #248 (TS1, two-stage production contract, save v8) is open and green but unreviewed. Issues TS2 #244, TS3 #245, R1 #176 and PT1–PT3 (#175, #181, #185) remain. #246 is an open design question.
- To resume: review #248, then follow the task graph in `docs/milestones/002-the-first-hire.md`. The simulation is a usable base for anyone who wants to build the game layer on top.

## Carrying it forward

For the next factory, in a domain where the human is the expert, such as a page builder:

| Keep | How it maps |
|---|---|
| A contracts package | The document model / page schema, owned in one place |
| Atomic commands or a typed rejection | Editor operations, which also give undo/redo and replay |
| Determinism + replay hash | The same document always renders the same output (golden tests) |
| Data package; no hardcoded values | Component library and design tokens |
| UI renders read-only snapshots | The canvas renders the document and never owns it |
| Locked acceptance tests by a separate agent | Unchanged |
| Separate review agent; merge only on green CI | Unchanged |
| Refresh issues before dispatch | Unchanged |
| Per-PR metrics in the milestone doc | Unchanged, in metrics-only PRs |

| Change | Why |
|---|---|
| A **prototype lane** from day one: throwaway spikes with no locked tests or ADRs. The human picks one, then the factory hardens it | Feel needs iteration before rigour. Spec-first fought that here |
| ADRs only for contracts, data formats and cross-cutting rules, with the fact checklist gathered *before* writing | Most ADR review rounds here came from missing facts, not bad decisions |
| Visual evidence as the default PR proof for UI: a short recorded clip or GIF, not just screenshots | The human judges feel in seconds from motion, not from diffs |
| Process changes reviewed lightly | Rule-wording PRs don't need three rounds |
| Plan for re-locks when rules change: version acceptance tests with the rule they test | Most M002 rework came from rules changing under tests that were already locked |
