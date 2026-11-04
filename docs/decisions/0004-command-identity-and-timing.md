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

### Results and rejections

- `CommandResult` is `applied` (with the event IDs it emitted), `queued`, or `rejected` (with a reason).
- `RejectionReason` is a closed union. Each code carries the data a UI needs to explain it, e.g. `BUYER_WILL_TAKE_LESS { requested, acceptable }`.
- A system that needs a new reason requests a contract change, rather than reusing a code that almost fits.

## Consequences

- T01 implements the queue, the eager-apply rule, and replay skipping. T02b implements transaction-ID dedupe.
- UI command buttons get synchronous feedback even while paused, without the UI holding any state of its own.
- Adding a command is a contract change: the type, `GAME_COMMAND_TYPES`, the Zod schema, and the docs table.
