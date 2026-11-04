# Software factory

How work moves from an idea to merged code. The goal: agents do the implementation, checks catch most mistakes cheaply, and a human makes every merge decision.

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
| `needs-design` | Blocked on a human decision |
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
6. Merge: automatic when §5 allows it, otherwise human

The full 1,000-seed balance run happens nightly, not on every PR.

## 4. PR evidence

Every PR includes:

- Linked issue (`Closes #N`)
- Output of the test command
- For simulation changes: replay hash for the reference scenario, before and after
- For UI changes: screenshots before and after
- Anything the agent wanted to do but left out, as a list

## 5. Merge gate

**Agent task PRs auto-merge** when every one of these holds for the PR's latest commit:

- CI is green.
- The review agent approved this commit, not an earlier one.
- Every changed file is in the issue's owned files.
- No `// @locked` test changed.
- The PR touches none of the **protected paths** below.
- The branch is up to date with `main`, or rebases cleanly and CI passes again after the rebase.

**Protected paths always need a human merge:**

- `packages/contracts/**` (also needs the CODEOWNER's review)
- `CLAUDE.md`, `docs/factory.md`, and existing files in `docs/decisions/` (new ADR files are fine)
- `.github/**`, root `package.json`, `eslint.config.js`, and `tsconfig.base.json`
- The milestone doc, except a PR that only appends rows to the factory metrics table (§7.6)

Everything that fails a criterion gets `needs-human` (§7.7) rather than merging.

**Protected-path PRs reach the human only after review.** When a PR touching protected paths has green CI and a review-agent approval of its latest commit, the orchestrator adds `ready-for-human` and notifies the human. **Humans merge only PRs labelled `ready-for-human`** (or the human's own PRs). A new commit removes the label until it's reviewed again.

**If a PR merges before review anyway,** the orchestrator still runs the review on the merged commit. Any findings become a follow-up issue linked to the PR, and the metrics row records "merged before review".

**Tightening rule:** if an auto-merged PR has to be reverted or causes a regression, the orchestrator pauses auto-merge (all merges become human) until the cause is understood and the criteria are changed in this file.

## 6. Factory metrics

Track these per merged task in the milestone doc:

- Merged without rework? (y/n)
- Number of review rounds
- What a check or reviewer caught
- Merged by: `auto` or `human`
- Human touches: how many times a human had to act (decisions, `needs-human` escalations, contract reviews)

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
| `needs-design` | Blocked on a human decision. |
| `needs-human` | The loop gave up on something and a human has to look. Says why in a comment. |
| `ready-for-human` | A protected-path PR that has passed CI and review, and is waiting for a human merge. |
| `human-paired` | Never started automatically. Done with a human. |

### 7.2 Refresh

When an open issue has every dependency merged and carries none of `agent-ready`, `in-progress`, `needs-design`, `needs-human`, or `human-paired`, run the refresh check from §1 on it:

- **Mechanical fixes** (paths, dependency lists, test commands, links to merged ADRs, semantics an ADR has already settled) are made in place, and listed in a comment. The issue then gets `agent-ready`.
- **Real decisions** (a choice between designs, a new contract type, a gameplay call the GDD doesn't settle) get `needs-design`, with a comment that states the question, the options, and a recommendation. The human is notified.
- **Oversized issues** (bigger than `size:M`) get `needs-design`, with a proposed split.

### 7.3 Dispatch

Start an implementing agent for an `agent-ready` issue when:

- every dependency is merged,
- its owned files don't overlap the owned files of any `in-progress` issue (if they do, it waits), and
- fewer than **3** agents are running (the concurrency cap for M001).

When several issues qualify, start them in issue-number order.

The agent runs in its own git worktree, on a branch named after the issue (`t01b-command-log`), with the standard prompt: read the issue, `CLAUDE.md`, this file, and the referenced docs; stay inside owned files; report contract gaps instead of editing contracts; open a PR with the §4 evidence; never merge. The issue gets `in-progress`.

If the agent stops with a question instead of a PR, it comments the question on the issue, the issue gets `needs-design`, and `in-progress` comes off.

### 7.4 Review

When an agent PR's CI finishes:

- **CI failed:** the implementing agent fixes it and pushes a new commit. This counts as a review round.
- **CI passed:** a **fresh review agent** reviews the latest commit. It checks:
  - every changed file is in the owned files
  - each acceptance criterion has evidence (a test, output, or screenshot)
  - contract types are used as defined, with no parallel types and no edits to contracts
  - the `CLAUDE.md` rules (determinism, money, game-data, atomic commands, UI state)
  - tests exercise the behavior, rather than only executing it
  - any "contract gaps" or "left out" items are real gaps, not shortcuts

  It posts a single PR review. All agents act through the human's GitHub account, and GitHub doesn't let an account approve its own PR, so the review is posted as a **comment** (`gh pr review --comment`). Its **first line** is the verdict, which the orchestrator reads:

  ```
  Review agent verdict: APPROVE @ <full commit SHA>
  Review agent verdict: REQUEST_CHANGES @ <full commit SHA>
  ```

  A verdict counts only for the SHA it names. For REQUEST_CHANGES, each finding is concrete and checkable: file and line, what's wrong, and what would fix it. Preferences go under a separate "Non-blocking" heading.

### 7.5 Fix rounds

When the review requests changes, the implementing agent addresses every finding in a **new commit** (no force-push), and adds a "Review round N" note to the PR description. CI and review run again.

**Cap: 3 rounds.** After the third request for changes, the PR gets `needs-human` with a summary of what's still disputed.

### 7.6 After merge

- The linked issue closes (`Closes #N`), and `in-progress` comes off.
- **Metrics:** the orchestrator appends the task's row to the metrics table, in a PR that changes only that table. Such PRs auto-merge (§5).
- **Contract gaps** the PR listed become new issues: `needs-design` if they need a contract change, otherwise planned issues with the affected task named.
- **Follow-ups:** each item under "left out" that names an owner task is copied to that task's issue as a comment, so its refresh picks it up.
- The loop runs again immediately, because the merge may have unblocked other issues.

### 7.7 Escalation

The human is notified (push notification, and a comment that mentions them) when:

- an issue gets `needs-design` (a decision, a split, or an agent question),
- a PR touches protected paths and is otherwise ready (a contract or policy review),
- a PR gets `needs-human`: round cap reached, CI failed twice in a row with the same error after a fix attempt, a rebase conflict the agent couldn't resolve, or a review finding the implementing agent disputes, or
- auto-merge was paused by the tightening rule (§5).

Everything else proceeds without asking. A human resolves an escalation by answering on the issue or PR and removing the label. The next loop run picks it up from there.
