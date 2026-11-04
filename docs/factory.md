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
4. Review agent: did the PR stay within its owned files and scope? Do the acceptance criteria have evidence?
5. CI: full test suite, 50-seed headless smoke run, Playwright (once T04 exists)
6. Human review and merge

The full 1,000-seed balance run happens nightly, not on every PR.

## 4. PR evidence

Every PR includes:

- Linked issue (`Closes #N`)
- Output of the test command
- For simulation changes: replay hash for the reference scenario, before and after
- For UI changes: screenshots before and after
- Anything the agent wanted to do but left out, as a list

## 5. Merge gate

A human merges every PR during Milestone 001. `packages/contracts` additionally requires the CODEOWNER's review. Revisit auto-merge for mechanical changes only after the metrics below justify it.

## 6. Factory metrics

Track these per merged task in the milestone doc:

- Merged without rework? (y/n)
- Number of review rounds
- What a check or reviewer caught

These numbers decide when to add parallelism or loosen the merge gate.
