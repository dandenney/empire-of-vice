# Software factory

How work moves from an idea to merged code. The goal: agents do the implementation, checks catch most mistakes cheaply, a review agent approves every merge, and the human decides story and visual direction (§8).

## 1. Intake

All work is a GitHub issue created from the **Agent task** template. Each issue has:

- **Goal**: one or two sentences.
- **Design references**: links to the relevant `docs/` sections.
- **Depends on**: issue numbers. Don't start until they're merged.
- **Owned files**: the paths this task may create or change.
- **Acceptance criteria**: checkable statements. Prefer ones a test can verify.
- **Out of scope**: things that are tempting but belong to other tasks.
- **Test command**: what has to pass.

Labels:

| Label | Meaning |
|---|---|
| `agent-ready` | Fully specified, dependencies merged, safe to hand to an agent |
| `needs-design` | Blocked on a story or visual-direction decision, or stuck (§8) |
| `human-paired` | Done interactively with a human, not autonomously |
| `size:S` / `size:M` | Rough size. Anything bigger gets split before it's `agent-ready` |
| `area:*` | `sim`, `ui`, `contracts`, `data`, `infra`, `lab` |

### Refresh before `agent-ready`

Issues are written ahead of time, and the decisions merged after them can make them stale. Before adding `agent-ready`, re-read the issue against what's on `main` now:

- **Contracts and decision records.** Does it name the current types, commands, and ADRs? Does any criterion contradict a decision merged since it was written? Link the relevant ADRs under Design references.
- **Owned files.** Do the paths match the real layout, including test folders the test runner actually picks up? Does the task need a file it can't touch, such as a `package.json` dependency or the lockfile? If so, add it.
- **Test command.** Does it run in the current workspace?
- **Scope.** Does it now overlap work another task owns, or depend on something that isn't built yet? Say which task owns what under Out of scope.

Edit the issue in place, and list what changed in a comment, so the agent and the reviewer both see why the issue differs from the original plan.

## 2. Execution

- One issue → one branch (`t02a-inventory`) → one PR. Parallel tasks run in separate git worktrees.
- Locked acceptance tests (`// @locked`) come first, written by a human or a separate agent. The implementing agent may add tests but must not edit locked ones.
- If the spec is ambiguous or the contract is missing something, the agent stops and comments on the issue instead of guessing.

## 3. Checks (cheapest first)

1. `pnpm typecheck`
2. `pnpm lint`, including package-boundary rules
3. `pnpm test`: unit and property tests for touched packages
4. CI: full test suite, 50-seed headless smoke run, Playwright (once T04 exists)
5. Review agent (§7.4): scope, acceptance evidence, contract adherence, and the `CLAUDE.md` rules
6. Merge: automatic when §5 allows it. Story and visual-direction PRs wait for the human

The full 1,000-seed balance run happens nightly, not on every PR.

## 4. PR evidence

Every PR includes:

- Linked issue (`Closes #N`)
- Output of the test command
- For simulation changes: replay hash for the reference scenario, before and after
- For UI changes: screenshots before and after
- Anything the agent wanted to do but left out, as a list

## 5. Merge gate

**Every agent PR and orchestrator PR auto-merges** when all of these hold for the PR's latest commit:

- CI is green.
- The review agent approved this commit, not an earlier one.
- Every changed file is in the issue's owned files. (Orchestrator PRs have no issue. Their review checks that the diff matches what the PR body says it changes.)
- No `// @locked` test changed.
- The branch is up to date with `main`. If it has fallen behind, the orchestrator merges `main` into it (a merge commit, no force-push) and CI runs again.
- The PR isn't a story or visual-direction PR (below).

There are no protected paths. Contracts, decision records, CI config, `CLAUDE.md`, and this file all merge the same way, after review-agent approval.

**Story and visual-direction PRs go to the human.** A PR whose main purpose, as the orchestrator judges it, is a story or visual-direction decision (§8), such as player-facing text, names, setting, tone, or the look of the UI and map, gets `ready-for-human` once it has green CI and a review-agent approval of its latest commit. The orchestrator notifies the human. **Humans merge only PRs labelled `ready-for-human`**, or human PRs (below). The label stays only while the **latest verdict on the head SHA is APPROVE**. A new commit, or a later REQUEST_CHANGES on the same SHA, removes it.

A PR that fails any auto-merge criterion above doesn't merge: it goes back for a fix round (§7.5), or gets `needs-human` when §7.7 says so.

**Approval carry-over (the one exception to "approved this commit").** When the orchestrator merges `main` into a PR branch and the merge changes none of the files in the PR's diff, the approval carries over to the new SHA, and the orchestrator records that in a PR comment. If the merge touches any file in the PR's diff, the PR is reviewed again.

Every PR comes from the same GitHub account, so the orchestrator tells PRs apart by **markers it writes itself**:

- **Agent PR:** its body has `Closes #N`, and issue #N has a comment whose first line starts with `Orchestrator: dispatched` (§7.3).
- **Orchestrator PR:** a PR the orchestrator opened itself (metrics updates, rule changes). Its body's first line is `Orchestrator PR`.
- **Human PR:** anything else. The orchestrator neither reviews nor merges it unless asked.

Agent PRs and orchestrator PRs follow the same review and merge rules: review, then auto-merge, or `ready-for-human` for story and visual-direction PRs. The one exception is metrics-only PRs (§7.6), which auto-merge on green CI without a review.

**If a PR merges before review anyway,** the orchestrator still runs the review on the merged commit. Any findings become a follow-up issue linked to the PR, and the metrics row records it under "Merged before review" (§6).

**Tightening rule:** if an auto-merged PR has to be reverted or causes a regression, the orchestrator pauses auto-merge (every PR then waits for a human merge, as if it carried `ready-for-human`) until the cause is understood and the criteria are changed in this file.

## 6. Factory metrics

Track these per merged task in the milestone doc:

- Merged without rework? (y/n)
- Number of review rounds
- What a check or reviewer caught
- Merged by: `auto` or `human`
- Merged before review? (y/n), with a link to the follow-up issue if the review found something
- Human touches: how many times a human had to act (story or visual decisions, `needs-human` escalations, vetoes)

Because every agent uses the human's account, GitHub's "merged by" can't tell a human merge from an automatic one. The orchestrator records `auto` when it merged the PR itself, and `human` otherwise.

These numbers decide when to add parallelism or loosen the merge gate further.

## 7. Orchestration

The orchestrator moves work through the factory without a human starting each step. It runs as a loop: first in a Claude Code session (`/loop`), later as GitHub Actions triggered by events. Each run reads the current GitHub state (issues, labels, PRs, CI, reviews) and takes every action the rules below allow. Runs are **idempotent**: any action that already happened is detected from GitHub state and skipped, so running the loop twice is harmless.

**The orchestrator never edits product code itself.** It refreshes issues, starts agents, labels, merges, files follow-ups, and records metrics. Implementation and review are done by separate agents, and **an agent never reviews its own work**.

### 7.1 Labels as state

| Label | Meaning |
|---|---|
| (none) | Planned. Not yet considered. |
| `agent-ready` | Refreshed and ready to start. |
| `in-progress` | An implementing agent is working on it, or its PR is open. |
| `needs-design` | Blocked on a story or visual-direction decision, or stuck (§8). |
| `needs-human` | The loop gave up on something and a human has to look. Says why in a comment. |
| `ready-for-human` | A story or visual-direction PR that has passed CI and review, and is waiting for a human merge. |
| `human-paired` | Never started automatically. Done with a human. |

### 7.2 Refresh

When an open issue has every dependency merged and carries none of `agent-ready`, `in-progress`, `needs-design`, `needs-human`, or `human-paired`, run the refresh check from §1 on it:

- **Mechanical fixes** (paths, dependency lists, test commands, links to merged ADRs, semantics an ADR has already settled) are made in place, and listed in a comment. The issue then gets `agent-ready`.
- **Real decisions** (a choice between designs, a new contract type, a gameplay call the GDD doesn't settle) are made by the orchestrator under §8: a comment (or an ADR) states the question, the options, and the recommendation it picked, and the issue then gets `agent-ready`. Only a story or visual-direction question gets `needs-design`, and the human is notified.
- **Oversized issues** (bigger than `size:M`) are split by the orchestrator into new issues, with the split recorded in a comment on the original.

### 7.3 Dispatch

Start an implementing agent for an `agent-ready` issue when:

- every dependency is merged,
- its owned files don't overlap the owned files of any `in-progress` issue (if they do, it waits), and
- fewer than **3** agents are running (the concurrency cap for M001).

When several issues qualify, start them in issue-number order.

The orchestrator posts a comment on the issue whose **first line is** `Orchestrator: dispatched <branch>`. That marker is how the agent's PR is recognized later (§5). The agent runs in its own git worktree, on a branch named after the issue (`t01b-command-log`), with the standard prompt: read the issue, `CLAUDE.md`, this file, and the referenced docs; stay inside owned files; report contract gaps instead of editing contracts, unless the issue owns contract files (below); open a PR with the §4 evidence; never merge. The issue gets `in-progress`.

**Contract changes are ordinary agent tasks.** The orchestrator decides the change first (§8), in an ADR when it shapes more than one task, then writes an issue that lists the affected `packages/contracts/**` files under owned files. The agent dispatched for that issue may edit those files; every other agent still may not. The PR follows the normal review and auto-merge rules.

When `main` has moved and a PR branch needs it, the implementing agent merges `main` into its branch and resolves any conflicts (§5).

If the agent stops with a question instead of a PR, it comments the question on the issue and `in-progress` comes off. The orchestrator answers it under §8 and the issue goes back to `agent-ready`, or, for a story or visual-direction question, it gets `needs-design`.

### 7.4 Review

When an agent PR's or orchestrator PR's CI finishes:

- **CI failed:** the implementing agent fixes it and pushes a new commit. This counts as a review round. For an orchestrator PR, the orchestrator is the implementing agent.
- **CI passed:** a **fresh review agent** reviews the latest commit. The orchestrator starts it for agent PRs and orchestrator PRs alike, so the orchestrator never reviews its own PRs. It checks:
  - every changed file is in the owned files
  - each acceptance criterion has evidence (a test, output, or screenshot)
  - contract types are used as defined, with no parallel types, and no edits to contracts unless the issue owns those contract files
  - the `CLAUDE.md` rules (determinism, money, game-data, atomic commands, UI state)
  - tests exercise the behavior, rather than only executing it
  - any "contract gaps" or "left out" items are real gaps, not shortcuts

  It posts a single PR review. All agents act through the human's GitHub account, and GitHub doesn't let an account approve its own PR, so the review is posted as a **comment** (`gh pr review --comment`). Its **first line** is the verdict, which the orchestrator reads:

  ```
  Review agent verdict: APPROVE @ <full commit SHA>
  Review agent verdict: REQUEST_CHANGES @ <full commit SHA>
  ```

  A verdict counts only for the SHA it names. The orchestrator reads verdicts **only from PR reviews**, never from issue comments, PR comments, or the PR body. If one SHA has several verdicts, the latest one wins. By instruction, only review agents post reviews: implementing agents are told never to. This can't be checked from GitHub, because every agent shares the account, so a verdict also counts only if it names the PR's current head SHA. For REQUEST_CHANGES, each finding is concrete and checkable: file and line, what's wrong, and what would fix it. Preferences go under a separate "Non-blocking" heading.

### 7.5 Fix rounds

When the review requests changes, the implementing agent (the orchestrator, for an orchestrator PR) addresses every finding in a **new commit** (no force-push), and adds a "Review round N" note to the PR description. CI and review run again.

**Cap: 3 rounds.** After the third request for changes, the PR gets `needs-human` with a summary of what's still disputed.

### 7.6 After merge

- The linked issue closes (`Closes #N`), and `in-progress` comes off.
- **Metrics:** the orchestrator appends the task's row to the metrics table, in an orchestrator PR (§5) that changes only that table. Such PRs auto-merge on green CI.
- **Contract gaps** the PR listed become new issues: a contract-change task (§7.3) if they need one, otherwise planned issues with the affected task named.
- **Follow-ups:** each item under "left out" that names an owner task is copied to that task's issue as a comment, so its refresh picks it up.
- The loop runs again immediately, because the merge may have unblocked other issues.

### 7.7 Escalation

The human is notified (push notification, and a comment that mentions them) when:

- an issue gets `needs-design` (a story or visual-direction question, or stuck work),
- a PR gets `ready-for-human` (a story or visual-direction PR),
- a PR gets `needs-human`: round cap reached, CI failed twice in a row with the same error after a fix attempt, a conflict from merging `main` that the implementing agent couldn't resolve, or a review finding the implementing agent disputes, or
- auto-merge was paused by the tightening rule (§5).

Everything else proceeds without asking. A human resolves an escalation by answering on the issue or PR and removing the label. The next loop run picks it up from there.

## 8. Decision authority

The orchestrator decides everything except **story** and **visual direction**, which stay with the human.

| Who decides | What |
|---|---|
| Human | **Story:** narrative, setting, characters, names, tone, and any player-facing text. **Visual direction:** the look of the UI and map, such as layout style, palette, typography, and art. |
| Orchestrator | Everything else: game rules and formulas the GDD doesn't settle, experience targets, tuning, contract shapes, architecture, task splits, process changes to this file, and placeholder content. |

For an orchestrator decision, write down the options and a recommendation, pick the recommendation, and record it: as an ADR in `docs/decisions/` when it shapes code or rules, otherwise as a comment on the issue. Work then continues without waiting. The human can veto any decision afterwards, and a veto becomes a new issue.

Placeholder content may stand in for a story or visual decision so that work isn't blocked. Mark it as a placeholder (in a code comment or the data file) and file a `needs-design` issue for the real decision.

`needs-design` is for human decisions only (story, visual direction) and for work the orchestrator is genuinely stuck on. Any other question that would have been `needs-design` is decided and recorded as above.
