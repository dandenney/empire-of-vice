# 0001: Workspace tooling and package-boundary enforcement

Status: proposed (T00a, issue #1)

## Context

Milestone 001 is built mostly by agents, so the workspace has to catch mistakes cheaply and mechanically (`docs/factory.md` §3). The architecture (§2, §3) fixes the stack at pnpm workspaces, Vite, TypeScript, Vitest, fast-check, and Playwright. It also requires that the rule "`packages/simulation` runs identically in a Web Worker and in Node, deterministically across JS engines" be **enforced by lint in CI, not by convention** (§3, §8).

Remaining choices: exact tool versions, how packages are wired together, how strict TypeScript is, and how the boundary rule is implemented and proven.

## Decision

### Versions and runtime

| Tool | Version | Notes |
|---|---|---|
| Node | 24 (LTS) | `engines.node >= 24`. Vitest 5 requires Node 22.12+; ESLint 10 and Vite 8 require 20.19+. |
| pnpm | 12.16.1 | Pinned via `packageManager`; CI reads it through `pnpm/action-setup`. |
| TypeScript | 6.0.x (`~6.0.3`) | **Not** 7.x: typescript-eslint 8 supports `typescript >=4.8.4 <6.1.0`. Move to TS 7 when typescript-eslint supports it. |
| ESLint | 10, flat config (`eslint.config.js`) | With `@eslint/js` recommended and `typescript-eslint` recommended (not type-checked, to keep lint fast). |
| Vitest | 5 | In `@eov/simulation`. Other packages add it when they get tests. |
| fast-check | 4 | In `@eov/simulation`. |
| Vite | 8 | `apps/game` is a blank page until the UI tasks. React, PixiJS, and Zustand aren't installed yet. |
| Playwright | `@playwright/test` 1.64 | In `apps/game`, no tests yet. `test:e2e` passes with no tests. Browsers aren't installed in CI until T04. |

Dependencies use `^`/`~` ranges, and `pnpm-lock.yaml` pins the exact versions. CI installs with `--frozen-lockfile`.

### Workspace layout

- `pnpm-workspace.yaml` covers `apps/*`, `packages/*`, `tools/*`. All packages are private and scoped `@eov/*`: `@eov/game`, `@eov/simulation`, `@eov/contracts`, `@eov/game-data`, `@eov/persistence`, `@eov/economy-lab`.
- **No build step between packages.** Each package's `exports` points at `./src/index.ts`. Vite, Vitest, and `tsc` (with `moduleResolution: "Bundler"`) consume TypeScript source directly. If something later needs compiled output (for example, a Node CLI run without a TS loader), that task adds it.
- Root scripts fan out with `pnpm -r`: `typecheck` and `test` run each package's script. `lint` is a single ESLint run from the root, so there's one config and one place for boundary rules.

### TypeScript

`tsconfig.base.json` enables `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`, and `isolatedModules`, with `noEmit` everywhere. `exactOptionalPropertyTypes` is off for now. T00b may turn it on when writing contracts, since that's where it matters.

The base `lib` is `ES2022` with `types: []`, so **no DOM and no Node globals by default**. Each package opts in to what it needs:

- `packages/simulation/tsconfig.json`: ES2022 only. A stray `window` or `process` is a type error as well as a lint error. Tests use a separate `tsconfig.test.json` that adds Node types.
- `apps/game`: adds DOM and `vite/client`.
- `packages/persistence`: adds DOM (IndexedDB).
- `tools/economy-lab`: adds Node types.

### Package-boundary lint rules

These are built-in ESLint rules (`no-restricted-imports`, `no-restricted-globals`, `no-restricted-properties`, `no-restricted-syntax`), scoped by `files` globs in `eslint.config.js`. No custom plugin.

**Simulation and the packages it imports** (`packages/simulation`, `packages/contracts`, `packages/game-data`):

- Imports: `react`, `react-dom`, `pixi.js`, `@pixi/*`, `dexie`, `zustand`, `@eov/game` (and subpaths), and any relative path into `apps/`.
- Globals: `window`, `document`, `indexedDB`, `localStorage`, `sessionStorage`, including `globalThis.<name>` access.

Contracts and game-data are included because the simulation imports them, so a UI or storage import there would reach the simulation transitively.

**Simulation only** (determinism, CLAUDE.md rule 5, architecture §8):

- `Math.random`, `Date.now`, `performance.now`, `new Date()` with no arguments, and `Date()` called as a function.
- Engine-dependent math: `Math.exp`, `expm1`, `pow`, `log`, `log1p`, `log2`, `log10`, all trig and hyperbolic functions, `cbrt`, and `hypot`. The ECMAScript spec doesn't require these to be correctly rounded. `Math.sqrt` is allowed because IEEE 754 requires correct rounding.
- The `**` and `**=` operators, which are `Math.pow`.

**Proof the rules fire:** `packages/simulation/test/boundary-lint.test.ts` runs ESLint programmatically with the real root config. It lints `test/fixtures/boundary-violations.ts` at virtual paths and checks that every line marked `// expect: <rule>` is reported, and that nothing else is. It also checks that:

- the same text in `packages/contracts` and `packages/game-data` reports only the import and global violations,
- the text in `apps/game` reports none,
- `test/fixtures/boundary-clean.ts` passes.

Fixture files are excluded from `pnpm lint` and from `tsc`.

### CI

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`: install (frozen lockfile), then typecheck → lint → test, on Node 24 with the pnpm store cached.

## Consequences

- One root ESLint config owns every boundary rule. A later task that needs a new boundary edits `eslint.config.js` and extends the fixture test.
- `no-restricted-*` rules are syntactic. They don't catch aliasing tricks (`const M = Math; M.random()`), dynamic access (`Math["random"]`), or violations inside a third-party dependency. The TS `lib` restriction backs up the browser-global check. Reviewers remain the backstop for the rest.
- Without a build step, packages can't be published or run under plain `node` without a TS loader. That's acceptable for a local-first app. `tools/economy-lab` will need a runner (for example `tsx` or Node's type stripping) when it gets one.
- TypeScript stays on 6.0.x until typescript-eslint supports 7.x. That upgrade is a single follow-up change.
- `typescript-eslint` runs without type information. Type-aware rules (for example `no-floating-promises`) can be enabled later if lint time allows.
