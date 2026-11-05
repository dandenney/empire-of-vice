# 0014: The speed scheduler

Status: accepted (decided while refreshing T04a, issue #11; implemented in T04a)

## Context

GDD §5 (SIM-001) sets the pacing: pause, 1×, 2×, 4× at one game hour (60 ticks) per 5 s, 2.5 s, and 1.25 s of real time. The browser auto-pauses when hidden, with no catch-up. A wall-clock scheduler decides only *how many* ticks run, never what they do. If processing falls behind, the backlog is kept and caught up in bounded batches, and ticks are never dropped. Architecture §4 says speed controls set how often the browser calls `advance()`, and that the worker publishes snapshots periodically and important events immediately. Architecture §8 asks for a fixed-timestep accumulator with bounded batches.

The orchestrator settled the open questions on #11 (decisions 1–12). This record keeps the ones that shape code.

## Decision

1. **The scheduler runs inside the worker.** The UI sends `SET_SPEED` and `SET_VISIBILITY` messages (`apps/game/src/workers/protocol.ts`). Timing has one owner, sitting next to the simulation, with no round-trip per batch, and the snapshot throttle is applied where snapshots are made. Architecture §4's "speed controls set how often the browser calls `advance()`" still holds: it's the browser's worker that calls it.
2. **A pure accumulator with integer arithmetic** (`apps/game/src/workers/scheduler.ts`). It reads an injected clock, floored to whole milliseconds. Successive floored readings telescope, so flooring loses no time. Elapsed time accrues in *tick units*, `ms × speed × TICKS_PER_HOUR`, and one tick costs `REAL_MS_PER_GAME_HOUR_AT_1X` units at every speed. Whole ticks move into a backlog, and the sub-tick remainder carries over, including across speed changes and pauses. No floats, so "1× = exactly 12 ticks per second" can be tested exactly.
3. **Bounded batches.** Each timer step hands out at most `MAX_TICKS_PER_STEP = 60` ticks (one game hour). The rest stays in the backlog for later steps and is never dropped. This is an engineering constant in `scheduler.ts`, not a gameplay number. The worker's timer fires every `TIMER_INTERVAL_MS = 50` while the game runs and is stopped while paused.
4. **Pause** accrues nothing and hands out nothing. The backlog and remainder are kept, so pausing and resuming loses nothing.
5. **Hidden tab.** Time accrues up to the moment the tab hides. Then the game auto-pauses (`autoPaused: true`) and the sub-tick remainder resets, so hidden time is never caught up. **It stays paused when the tab is visible again.** GDD §5 says "auto-pause", and resuming on its own could run a crisis the player isn't watching. The UI says it auto-paused until the player picks a speed. A running speed requested while hidden is refused. Hiding an already-paused game doesn't mark it auto-paused.
6. **Starting state.** A new or loaded game starts paused, with nothing owed, so nothing runs before the player picks a speed and tests stay deterministic. The backlog isn't saved: it's wall-clock state, not game state.
7. **Snapshot throttle.** While running, the worker posts at most one snapshot per `SNAPSHOT_INTERVAL_MS = 200`. It posts one at once after every command, speed change, pause, visibility change, new game, load, and test-hook advance. `notify` events (`EVENT_IMPORTANCE`) are posted as soon as the ticks that emitted them have run, ahead of any snapshot. `log` events wait and travel in one batch right after the next snapshot. The scheduler's status (`speed`, `autoPaused`) rides on every `SNAPSHOT` message.
8. **Deterministic test driving.** Test builds expose `window.__eov.advance(ticks)`, which pauses the scheduler and then runs exactly `ticks` ticks (the `ADVANCE` message). Playwright fake clocks don't reliably reach a worker's timers. The exact rates and the 60 s pause are proven in Vitest with a fake clock. Playwright checks the real timer with tolerances, and the Sprint Zero hash-parity run stays exact.
9. **Pacing constants live in `packages/game-data/src/pacing.ts`** (`REAL_MS_PER_GAME_HOUR_AT_1X = 5_000`, `SPEED_MULTIPLIERS = [1, 2, 4]`). They're gameplay rates (CLAUDE.md rule 3). Contracts' `time.ts` keeps only the calendar rules (`TICKS_PER_HOUR`, `TICKS_PER_DAY`).
10. **The snapshot reaches React from `GatewayClient`** via `useSyncExternalStore`, not through Zustand. Zustand holds only UI state: the open panel, the selected location, and pending-request flags (CLAUDE.md rule 7).

## Consequences

- The same seed and the same timed commands give the same state hash at 1× and 4×, because the scheduler only chooses batch sizes (tested in `apps/game/tests/unit/simulation-host.test.ts`).
- A command sent while running applies at the next tick the worker processes, like any untimed `CommandRequest` (ADR 0004). The scheduler doesn't change that.
- A scheduler step that throws pauses the game and posts a `FAULT` message, which the shell shows.
- Retuning pacing (say, a 6× speed) is a game-data change. `isSpeed` and the speed buttons read `SPEED_MULTIPLIERS`.
