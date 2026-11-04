# 0011: Validation schemas and fixtures

Status: proposed (T00b, issue #2)

## Context

Architecture §4: commands are validated at the gateway with Zod. ADR 0009: saves are validated after migration. T00b's acceptance criteria require Zod schemas for commands and saves with round-trip tests, and fixture snapshots in `packages/contracts/fixtures/` for UI work.

The risk with any schema library is two sources of truth: the TypeScript types and the schemas drift apart, and one of them silently stops describing reality.

## Decision

### Types are the contract, schemas mirror them, and the compiler checks the mirror

- The hand-written TypeScript types stay the contract. They're what reviewers read, and they carry the doc comments.
- `schemas.ts` defines Zod 4 schemas for everything that crosses a trust boundary:
  - commands, command requests, and envelopes
  - rejection reasons and events
  - ledger transactions
  - game state, `SaveGame`, `SaveFile`
  - a loose save header for picking a migration path
- **A compile-time test asserts that `z.infer<schema>` exactly equals each contract type** (with `readonly` stripped). Adding, removing, or retyping a field on either side fails typecheck. A second set of assertions proves that check isn't vacuous: a schema missing a field, or with an extra one, does *not* compare equal.
- Branded types survive validation: `moneySchema`, `tickSchema`, `ratioSchema`, and `idSchema(kind)` are `z.custom` guards that output `Money`, `Tick`, `Ratio`, and `Id<K>`, not plain `number`/`string`.

### What schemas check

- **Shape:** every object is strict (unknown keys rejected), and absent values must be explicit `null` (ADR 0007/0008).
- **Simple ranges:** integer cents and ticks, non-negative counts, command quantities ≥ 1, valid ID format, reputation in 0–100, an ISO timestamp on `SaveFile.meta.savedAt`.
- **Ledger transactions balance**, with zero entries or at least two. That's cheap to check per transaction, and it catches corrupted saves early.
- **Not checked by schemas:** cross-entity invariants (ledger matches inventory, references point at real entities). Those belong to the coordinator (ADR 0010) and the simulation's load path.

`formatIssues()` turns Zod errors into one-line strings for `SaveLoadError.INVALID` and for gateway rejections in development.

### Fixtures (`packages/contracts/fixtures/`)

- **They're TypeScript, not JSON,** so the compiler checks them against the contract. Exported from `@eov/contracts/fixtures`.
- **One small fictional world** (`world.ts`): a distillery, a storage barn, a supplier, three buyers, and six routes, including two to the speakeasy for route-choice UI. **All of it is placeholder content.** The real scenario is T05's decision, and nothing should treat these names or numbers as tuning.
- `startOfGameSnapshot` (tick 0) and `midGameSnapshot` (day 3, 14:00: a truck on the back roads with a sale, the county road closed by police, a sugar shortage, a running job, a part-fulfilled contract, an open offer). Together they exercise every panel and map layer.
- `day0Save` / `day0SaveFile`: a valid save touching every top-level part of `GameState`, used for the round-trip tests.
- **Totals are computed, not typed in.** The fixture builders compute balance-sheet totals, gross and net profit, and closing cash, so the fixtures can't contradict themselves. `fixtures.test.ts` also checks:
  - assets = liabilities + equity, and equity = net worth
  - each period's profit and cash flow add up, and today opens where yesterday closed
  - net worth − profit to date = opening equity
  - inventory values match the balance sheet
  - lists are sorted, and references resolve

## Consequences

- `zod` (^4) is a runtime dependency of `@eov/contracts`. The simulation imports types from contracts, but only the gateway (S0b/T06) and persistence (T06) need the schemas at runtime.
- A contract change now touches the type, the schema, and possibly a fixture, and typecheck says which ones are missing.
- The `GameSnapshot` has no schema: it's produced by trusted code and only crosses the worker boundary. If a test needs to validate snapshots, add one then.
