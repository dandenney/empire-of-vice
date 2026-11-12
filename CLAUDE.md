# Empire of Vice

Single-player, local-first economic strategy game set in Prohibition-era Chicago. TypeScript monorepo: deterministic simulation engine, React management UI, PixiJS map.

This file is a map. Read the linked doc for the area you're touching before changing it.

## Where things are

- Game design (rules, formulas, tuning defaults): `docs/game-design/gdd-v0.5.md`. Sections have IDs like SIM-001, ECO-001, FIN-001; issues cite them. GDD §11–12 are superseded by the architecture and milestone docs.
- Architecture and hard rules: `docs/architecture/technical-architecture.md`
- Current milestone, task graph, and acceptance criteria: `docs/milestones/002-the-first-hire.md` (M002 design: GDD Part II, §16–§21). M001: `docs/milestones/001-first-shipment.md`
- How agent work flows (issues, branches, checks, PRs): `docs/factory.md`
- Decision records: `docs/decisions/`

## Non-negotiable rules

1. `packages/simulation` never imports React, PixiJS, DOM/browser storage APIs, or anything from `apps/`. It must run identically in a Web Worker and in Node.
2. Domain types, commands, events, and snapshots come from `packages/contracts`. Don't invent parallel types. If the contract is missing something, stop and say so in the PR rather than changing it. Contract changes need review-agent approval (`docs/factory.md` §5). Exception: `packages/game-data` defines the types for its own static definitions (recipes, buyers, routes, scenario), built from contract primitives (ADR 0012).
3. Gameplay numbers (prices, wages, rates, thresholds) live in `packages/game-data`. Never hardcode them in simulation logic or UI.
4. Money is integer cents. No floats for money.
5. The simulation is deterministic: seeded RNG only, no `Date.now()`, no `Math.random()`, no transcendental `Math.*` functions in simulation code (see architecture §8).
6. A command is applied atomically or rejected with a typed reason. It never partially mutates state.
7. UI holds no copies of authoritative game state. It renders read-only snapshots.
8. Stay inside the files your issue says you own. If you need something outside them, note it in the PR instead of doing it.
9. Do not modify tests marked `// @locked` (acceptance tests written ahead of implementation).

## Commands

Node 24+ and pnpm (version pinned in root `package.json` `packageManager`; `corepack enable` picks it up). Tooling choices: `docs/decisions/0001-workspace-tooling.md`.

Root (run from the repo root):

- `pnpm install`: install all workspace packages
- `pnpm typecheck`: `tsc` in every package
- `pnpm lint`: ESLint over the whole repo, including the package-boundary rules in `eslint.config.js`
- `pnpm test`: every package's `test` script (currently Vitest in `@eov/simulation`)
- `pnpm check`: typecheck → lint → test, the same sequence CI runs on every PR

Per package (`pnpm --filter <name> <script>`):

| Package | Path | Scripts |
|---|---|---|
| `@eov/simulation` | `packages/simulation` | `typecheck`, `test` (Vitest + fast-check), `test:watch` |
| `@eov/contracts` | `packages/contracts` | `typecheck` |
| `@eov/game-data` | `packages/game-data` | `typecheck` |
| `@eov/persistence` | `packages/persistence` | `typecheck` |
| `@eov/game` | `apps/game` | `dev`, `build`, `preview` (Vite), `typecheck`, `test:e2e` (Playwright) |
| `@eov/economy-lab` | `tools/economy-lab` | `typecheck` |

Examples: `pnpm --filter @eov/simulation test`, `pnpm --filter @eov/game dev`, `pnpm exec eslint packages/simulation`. Playwright browsers aren't installed by `pnpm install`; run `pnpm --filter @eov/game exec playwright install` before the first `test:e2e`.
