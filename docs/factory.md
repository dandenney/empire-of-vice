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

### Design-record tasks

An ADR task's issue lists the **facts the record must account for** before anyone writes it: the code it makes claims about (file and function), the transaction producers and commands it touches, the `@locked` files it could break (`grep -rl "@locked" packages/simulation/test`), and the follow-ups other records left on the issue. M002's first three records needed 12 review rounds, and most findings were facts like these, discovered one round at a time (#187, #190, #191).

Every ADR that touches simulation rules is checked against the list below, by its author before review and by the reviewer (§7.4):

1. **Non-leak** (ADR 0021 decision 9): for each command and surface it adds or changes (immediate result, activity item, catch-up, books row, snapshot field), nothing depends on world state outside the issuer's view.
2. **Coverage tables:** each new transaction producer, named by idempotency-key family, is known by ADR 0021 decision 6 rule 1 or has a row in ADR 0021 decisions 6 and 7, in each table it can post to.
3. **Migration:** reads only the save's own fields (ADR 0009), with the source of each new field named.
4. **Re-locks:** every `@locked` file it breaks, by path, with the reason.
5. **Tick order:** where new behaviour runs in `PHASES`, and what happens on the tick a founder activity ends (ADR 0023 decision 2a).
6. **Flag off:** with `founderRules: false` (the M001 scenario and the lab), behaviour and economics are unchanged.
7. **Randomness:** which RNG stream, and no new way for hidden activity to shift draws the founder sees (ADR 0022 decision 8).
8. **Rejection reasons:** new ones named, with payloads; existing ones reused where they fit.

Design records that depend on each other are written one after another, not in parallel. Dispatch only waits on `Depends on` (§7.3), so the refresh (§7.2) lists the earlier record's issue under **Depends on** in the later one.

## 2. Execution

- One issue → one branch (`t02a-inventory`) → one PR. Parallel tasks run in separate git worktrees.
- Locked acceptance tests (`// @locked`) come first, written by a human or by a test-writer agent that is not the implementing agent. When an issue names a locked test file, dispatch has two steps (§7.3): the test-writer commits only that file to the issue's branch and pushes it, and the implementing agent starts from that commit. The implementing agent may add tests but must not edit locked ones.
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
- No `// @locked` test changed. A locked file that the issue names and the test-writer added at the **locked SHA** (§7.3) is exempt from this check and from the owned-files check; it counts only if `git diff <locked SHA>..HEAD -- <locked file>` is empty.
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
- Number of review rounds: every review-agent verdict on the PR, the approving one included (a PR approved first time has 1). CI fix rounds aren't counted here; note them under what was caught
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

When the orchestrator merges `main` into a PR branch (§5) and the merge conflicts, the implementing agent resolves the conflicts in a new commit.

**Locked-test dispatch (two steps).** When an issue names a locked test file (§2), the orchestrator posts the `Orchestrator: dispatched <branch>` marker and adds `in-progress` before step 1. Step 1 is a test-writer agent on that branch; it counts toward the cap like any agent. When step 1 has pushed, the orchestrator checks that the commit changes only the locked file. It then records the **locked SHA** in an issue comment whose first line is `Orchestrator: locked <file> @ <full SHA>`, and only then starts step 2. The review takes the locked SHA from the latest such comment, never from the PR body. It checks that this commit is an ancestor of the PR head, that it changes only the locked file, and that `git diff <locked SHA>..HEAD -- <locked file>` is empty. If a human writes the locked test, the orchestrator records the human's commit the same way.

If the implementing agent finds a locked test defective (it contradicts the issue or can't be satisfied), it stops and comments on the issue. The orchestrator decides under §8. A fresh test-writer agent then pushes the fix to the same branch as a new commit that changes only the locked file, and the orchestrator records it as the new locked SHA. The implementing agent then merges or continues from that commit; the issue isn't re-dispatched.

If the agent stops with a question instead of a PR, it comments the question on the issue and `in-progress` comes off. The orchestrator answers it under §8 and the issue goes back to `agent-ready`, or, for a story or visual-direction question, it gets `needs-design`.

### 7.4 Review

When an agent PR's or orchestrator PR's CI finishes:

- **CI failed:** the implementing agent fixes it and pushes a new commit. It doesn't count toward the round cap (§7.5), which counts requests for changes; repeated CI failure escalates under §7.7 instead. The metrics table records it under "Caught by" (§6). For an orchestrator PR, the orchestrator is the implementing agent.
- **CI passed:** a **fresh review agent** reviews the latest commit. The orchestrator starts it for agent PRs and orchestrator PRs alike, so the orchestrator never reviews its own PRs. It checks:
  - every changed file is in the owned files, except a locked file added at the locked SHA (§5)
  - for a locked file: the locked SHA comes from the latest `Orchestrator: locked` issue comment; it is an ancestor of HEAD and changes only the locked file; and `git diff <locked SHA>..HEAD -- <locked file>` is empty
  - each acceptance criterion has evidence (a test, output, or screenshot)
  - contract types are used as defined, with no parallel types, and no edits to contracts unless the issue owns those contract files
  - the `CLAUDE.md` rules (determinism, money, game-data, atomic commands, UI state)
  - tests exercise the behavior, rather than only executing it
  - any "contract gaps" or "left out" items are real gaps, not shortcuts
  - for a design-record task (§1): every fact the issue lists has a concrete decision, and each of the eight checklist items is applied and stated in the record

  It posts a single PR review. All agents act through the human's GitHub account, and GitHub doesn't let an account approve its own PR, so the review is posted as a **comment** (`gh pr review --comment`). Its **first line** is the verdict, which the orchestrator reads:

  ```
  Review agent verdict: APPROVE @ <full commit SHA>
  Review agent verdict: REQUEST_CHANGES @ <full commit SHA>
  ```

  A verdict counts only for the SHA it names. The orchestrator reads verdicts **only from PR reviews**, never from issue comments, PR comments, or the PR body. If one SHA has several verdicts, the latest one wins. By instruction, only review agents post reviews: implementing agents are told never to. This can't be checked from GitHub, because every agent shares the account, so a verdict also counts only if it names the PR's current head SHA. For REQUEST_CHANGES, each finding is concrete and checkable: file and line, what's wrong, and what would fix it. Preferences go under a separate "Non-blocking" heading.

### 7.5 Fix rounds

When the review requests changes, the implementing agent (the orchestrator, for an orchestrator PR) addresses every finding in a **new commit** (no force-push), and adds a "Review round N" note to the PR description. Before pushing, it re-reads the **whole** changed document or diff, not only the edited lines, for contradictions the fix introduced; in #187 and #190 the findings that went past the round cap came from earlier fixes. CI and review run again.

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
