# 0004: Command identity and timing

Status: proposed (T00b, issue #2)

## Context

SIM-001's tick order starts with "validate and apply due commands in `(scheduledTick, sequence)` order". Architecture §8 asks for unique command IDs and idempotent handling, and the engine API (`dispatch(command): CommandResult`) must not depend on wall-clock time.

Three questions needed answers:

1. Who assigns command IDs?
2. When does a command take effect, especially while the game is paused?
3. What does idempotency protect against?

## Decision

### The command set (`commands.ts`)

There are eight commands, covering every GDD §4 player action:

| Command | GDD §4 action |
|---|---|
| `PURCHASE_MATERIALS` | 1. Buy raw materials |
| `START_PRODUCTION` | 2. Schedule production |
| `DISPATCH_DELIVERY` | 4. Assign inventory and a truck, and 8. route around a disruption (`routeId`, or `null` for the default route) |
| `ACCEPT_CONTRACT` | 7. Take a recurring contract |
| `PURCHASE_EQUIPMENT` | 6. Reinvest in equipment, including storage expansion |
| `SET_WORKFORCE` | 6. Hire workers, and lay them off during recovery (GDD §9) |
| `RELEASE_RESERVATION` | GDD §7: free reserved stock, accepting the risk of missing an installment |
| `REPEAT_OPERATION` | GDD §9: earned automation level 2 |

Changes from earlier drafts:

- **`START_PRODUCTION` takes a `recipeId`, not a `productId`.** A recipe fixes the inputs, the output product, and the quality tier, so "standard moonshine" isn't ambiguous.
- **`SET_WORKFORCE` replaces a hire-only command.** Recovery (GDD §9) means cutting costs, so one target-count command covers both directions.
- **`DISPATCH_DELIVERY` has a `purpose`:** sale, contract installment, or transfer between the player's own facilities. Sales are deals struck at dispatch (ADR 0005).
- **`REPEAT_OPERATION` copies a previously applied purchase, production, or delivery command and re-validates it in full.** A repeated sale uses the buyer's current quote, so a stale price can't be locked in.

### Identity

- **The simulation assigns every dispatched command a `CommandId` and a `sequence`**, from a counter in state (`cmd-<n>`). The caller doesn't choose IDs, so they're deterministic and can't collide when the UI reloads.
- Rejected commands get an ID too, so the UI can match results to requests, but they aren't journaled.
- Idempotency is enforced in two places:
  - **Replay:** an envelope whose sequence has already been applied is skipped. Loading a save and replaying its journal never applies a command twice.
  - **Economic effects:** sales, payments, penalties, and installment settlements carry transaction IDs (the coordinator, later in T00b). A delivery or penalty can't settle twice, even across save/load at midnight (GDD §7, FIN-001).
- Double-clicks are a UI concern. From the simulation's view, two dispatches are two intents, and the second is validated against the state the first left behind.

### Timing

- **`dispatch` without `scheduledTick` applies the command now**, as the first thing of the next tick (`state.tick + 1`). It works the same way while the game is paused: buying materials while paused updates the snapshot at once. Applying eagerly is equivalent to applying at step 1 of the next tick, because nothing happens in between. Before applying, the simulation first applies any already-queued commands due on that tick, in sequence order, so `(scheduledTick, sequence)` order holds.
- **`dispatch` with a future `scheduledTick` queues the command.** The result is `queued`. When the tick arrives, the command is validated again. If it fails then, a `COMMAND_REJECTED` event carries the reason. Lab strategies and SIM-001's "same seed and timed commands give identical hashes at 1× and 4×" test rely on this.
- A `scheduledTick` in the past is rejected with `SCHEDULED_IN_PAST`.
- Queued commands are saved (SaveGame), and so are applied commands, in the journal used for replay.

#### Amendment, 2026-11-04 (T01b, issue #25): the journal covers apply-time rejections

A queued command that fails when its tick arrives was still accepted at dispatch: it used up a command ID and a sequence. Leaving it out of the journal meant replaying the journal gave a different state hash. So:

- **`commandLog` holds every command accepted at dispatch, once its tick has been processed,** in `(scheduledTick, sequence)` order: commands that applied immediately, queued commands that applied when their tick arrived, and queued commands that were rejected then. The entry is the original envelope. The outcome isn't stored, because replay derives it again deterministically.
- Commands rejected at dispatch still never reach the journal, and still change nothing.
- **Replay treats a journaled envelope as already accepted.** A future envelope is queued without the handler's dispatch-time validation, since that would judge it against the replaying state, not the state the original dispatch saw. An envelope due on the next tick applies at once, and if it fails, that's an apply-time rejection: it's journaled and a `COMMAND_REJECTED` event carries the reason, as in the original run. Only a `scheduledTick` already in the past is still rejected outright.
- Replaying the journal on a fresh simulation from the same start state reproduces the original state hash and the same events, including the `COMMAND_REJECTED` events and their IDs.
- **Replay procedure (2026-11-05, issue #66).** To replay a run that ended at tick E: place the envelopes with `scheduledTick` ≤ E (all up front, or each one just before its tick), advance to E, and only then place the envelopes with `scheduledTick` E + 1. Only immediate dispatches made on the run's last tick can have that tick, because a queued command enters the journal only once its tick is processed. Placed after the advance, each one is due on the next tick, so it applies at once, as in the original run. Placed before the advance, it would stay queued and never apply, and the hash would differ.
- The bullet above about saved commands now reads "applied **or apply-time rejected** commands". This changes what the journal means, not its shape, so the save schema version stays 1.
- Under Identity, "Rejected commands … aren't journaled" now means commands **rejected at dispatch** only. The replay bullet there ("an envelope whose sequence has already been applied is skipped") now covers any envelope already in the journal or the queue, including apply-time rejections.

### Results and rejections

- `CommandResult` is `applied` (with the event IDs it emitted), `queued`, or `rejected` (with a reason).
- `RejectionReason` is a closed union. Each code carries the data a UI needs to explain it, e.g. `BUYER_WILL_TAKE_LESS { requested, acceptable }`.
- A system that needs a new reason requests a contract change, rather than reusing a code that almost fits.

## Consequences

- T01 implements the queue, the eager-apply rule, and replay skipping. T02b implements transaction-ID dedupe.
- UI command buttons get synchronous feedback even while paused, without the UI holding any state of its own.
- Adding a command is a contract change: the type, `GAME_COMMAND_TYPES`, the Zod schema, and the docs table.
