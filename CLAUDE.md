# Empire of Vice

Single-player, local-first economic strategy game set in Prohibition-era Chicago. TypeScript monorepo: deterministic simulation engine, React management UI, PixiJS map.

This file is a map. Read the linked doc for the area you're touching before changing it.

## Where things are

- Game design (rules, formulas, tuning defaults): `docs/game-design/gdd-v0.5.md`. Sections have IDs like SIM-001, ECO-001, FIN-001; issues cite them. GDD §11–12 are superseded by the architecture and milestone docs.
- Architecture and hard rules: `docs/architecture/technical-architecture.md`
- Current milestone, task graph, and acceptance criteria: `docs/milestones/001-first-shipment.md`
- How agent work flows (issues, branches, checks, PRs): `docs/factory.md`
- Decision records: `docs/decisions/`

## Non-negotiable rules

1. `packages/simulation` never imports React, PixiJS, DOM/browser storage APIs, or anything from `apps/`. It must run identically in a Web Worker and in Node.
2. Domain types, commands, events, and snapshots come from `packages/contracts`. Don't invent parallel types. If the contract is missing something, stop and say so in the PR rather than changing it. Contract changes need human review.
3. Gameplay numbers (prices, wages, rates, thresholds) live in `packages/game-data`. Never hardcode them in simulation logic or UI.
4. Money is integer cents. No floats for money.
5. The simulation is deterministic: seeded RNG only, no `Date.now()`, no `Math.random()`, no transcendental `Math.*` functions in simulation code (see architecture §10).
6. A command is applied atomically or rejected with a typed reason. It never partially mutates state.
7. UI holds no copies of authoritative game state. It renders read-only snapshots.
8. Stay inside the files your issue says you own. If you need something outside them, note it in the PR instead of doing it.
9. Do not modify tests marked `// @locked` (acceptance tests written ahead of implementation).

## Commands

(Filled in by T00a.)
