# 0012: game-data owns its definition types

Status: accepted (decided while refreshing S0a, issue #4)

## Context

`CLAUDE.md` rule 2 says domain types come from `@eov/contracts`. T00b defined runtime state, commands, events, snapshots, and saves. It didn't define the shapes of **static game definitions**: recipes, products, equipment, buyers' baselines, suppliers, routes and their geometry, vehicles, and the scenario. Without a decision, S0a would either invent them (breaking rule 2) or wait on a contract follow-up.

## Decision

- **`@eov/game-data` defines the types for its own data** (`RecipeDefinition`, `BuyerDefinition`, `RouteDefinition`, `ScenarioDefinition`, and so on), next to the data they describe.
- They're built from contract primitives: branded IDs, `Money`, `Ratio`, `Tick`, `WorldPoint`, `QualityTier`. They never redefine anything contracts already has.
- The simulation imports them from `@eov/game-data`. The package boundary allows this: game-data is part of the simulation's dependency set.
- **The scenario definition includes the start date.** That closes T01's contract gap, where `createSimulation`/`loadSimulation` take a `startDate` option.
- `CLAUDE.md` rule 2 notes this exception.

## Why not contracts

These types describe tuning data, not shared domain state. They change whenever balancing needs a new knob: a buyer preference, a route risk field. Putting them in contracts would make each of those changes a CODEOWNER contract review, which is the wrong cost for tuning. Runtime state that systems share (`GameState`), and anything crossing a trust boundary, stays in contracts.

## Consequences

- Each data file's owner (T02c, T02d, T03, T05) owns the definition types in its file, the same way it owns the data.
- If a definition type starts to be needed outside the simulation and game-data, for example by the UI, revisit whether it belongs in contracts. Normally the UI reads definitions through the snapshot instead.
