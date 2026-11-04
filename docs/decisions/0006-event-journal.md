# 0006: Events and the event journal

Status: proposed (T00b, issue #2)

## Context

Architecture §4 requires events to be a discriminated union with no `unknown` payloads, published immediately when important. Architecture §8 asks for "a compact journal for gameplay explanations and debugging, not full event sourcing". The T04 finance panel has to explain why money was earned or lost, and lab reports and tests need readable histories.

## Decision

### Events are records, not the source of truth

- **State is authoritative.** Events describe what happened during a tick or a command. The simulation never rebuilds state by replaying events. Replay works from the **command journal** plus the seed (ADR 0004), and save/load restores state directly.
- `GameEvent` (`events.ts`) is a closed union of 31 event types covering M001: commands, daily settlement, materials and production, equipment and workforce, deliveries and sales, market and disruptions, contracts and reservations, and progression. Adding a type is a contract change.

### Every event carries

- `id`: a simulation-assigned `EventId` (`evt-<n>`). It's stable, deterministic, and referenced by `CommandResult.eventIds`.
- `tick`: when it happened.
- `causedBy`: the `CommandId` that triggered it, or `null` for world-driven events (midnight, arrivals, disruptions). Arrivals and settlements link back to their origin through domain IDs (`deliveryId`, `contractId`), not `causedBy`. A truck arriving is the world acting on an earlier decision.
- **`transactionId` on every event that moved money**, pointing at its balanced ledger transaction. That link is how the finance panel answers "why did cash drop $40?": ledger entry → transaction → event → command.

### Publishing

`EVENT_IMPORTANCE` classifies each type as `notify` (publish immediately; the UI may show a notification) or `log` (send with the next periodic snapshot; shown in history only). It's a `Record` over all event types, so a new event that isn't classified won't compile. The UI decides how a `notify` event looks.

### The journal

- The simulation keeps the **most recent `EVENT_JOURNAL_CAPACITY` (1,000) events** in state, oldest dropped first. That's several game days of a busy operation: enough for explanations and debugging, and the save stays small.
- The journal is part of state: it's saved, and included in the state hash. It's deterministic, so including it costs nothing and catches divergence early.
- 1,000 is an engine setting, not a gameplay value, so it lives in contracts and not game-data.
- Lab runs that want the full history subscribe to events as they're emitted, instead of reading the bounded journal.

## Consequences

- Systems emit events through the coordinator as part of the same atomic commit as their state change (rejected commands emit nothing, apart from `COMMAND_REJECTED` for queued commands).
- Some event fields name decisions owned by later tasks: production failure and reservation release rules (T02a), "too late" for a deal (T02d, T03), and loss conditions (T05). Their reason enums start minimal. Widening one is a contract change.
- Tests in `events.test.ts` check that every type is classified and that payloads are fully typed.
