# 0009: Save migration policy

Status: proposed (T00b, issue #2). Settles GDD §14.10.

## Context

GDD §14.10 leaves save versioning and compatibility open. Architecture §8 calls for versioned saves with explicit migrations. Playtests (the M001 release gate needs at least three) produce saves we'd rather not throw away every time the schema changes.

## Decision

### Chained migrations from version 1

- `SAVE_SCHEMA_VERSION` starts at **1** and increases by one for any change to `SaveGame` or `GameState` that an existing save might not pass or might be read differently under: removing or renaming a field, an ID or a union member, adding a required field, narrowing a type or a bound, or changing what a value means.
- A purely additive change that every existing save already satisfies doesn't bump it. Examples are a new member of an event, scheduled-event or enum union, and a new optional field. ADR 0020 and T07f's `SHAKEDOWN` and `LOSS_BOOKED` follow this. The test is whether every committed fixture save still validates against the new schema, unchanged. If any wouldn't, it's a bump with a migration. (Reconciled with practice in #159, from the #156 review note N4. The original text bumped for additions too.)
- Every bump ships a `SaveMigration` from `n` to `n + 1`. Migrations work on raw JSON (`Record<string, unknown>`), because the old TypeScript types no longer exist.
- On load, persistence (T06) applies the migrations in order from the save's version up to the current one, then **validates the result against the current Zod schema** before handing it to the simulation.
- Migrations are pure and deterministic, and they never read game-data, so a migrated save loads the same way every time.

### What gets rejected

Loading either succeeds completely or fails with a typed `SaveLoadError`. Nothing loads halfway.

| Situation | Error |
|---|---|
| Not a save (wrong `format` tag, not JSON) | `NOT_A_SAVE` |
| Saved by a newer build | `NEWER_VERSION` (no downgrades) |
| A migration step is missing | `MISSING_MIGRATION` |
| A migration throws | `MIGRATION_FAILED` |
| The migrated result fails validation | `INVALID`, with the schema issues |
| The state hash doesn't match | `HASH_MISMATCH` |

### Every migration has a test

Each bump adds a **fixture save at the old version**, committed under `packages/persistence/fixtures/`. A test migrates it, validates it, loads it, and advances it. The fixtures make it impossible to break old saves without noticing.

### Game-data changes don't block loading

`gameDataVersion` is recorded for diagnostics, but a save loads with whatever game-data the current build has. Tuning changes (prices, rates) apply to games in progress, the way a balance patch would. State holds only dynamic values (ADR 0008), so this works without migrations. Removing or renaming an ID that saves reference **is** a schema change and needs a migration.

## Consequences

- Each schema change costs a migration and a fixture. Early on, while the schema churns most, that's cheap. It's also what keeps playtest saves usable.
- T06 implements the runner, the fixture tests, and the UI for load errors. T00b defines the types (`SaveMigration`, `SaveLoadError`) and the Zod schema.
- A replay from the start (seed + command log) is a separate debugging tool and doesn't depend on migrations.
