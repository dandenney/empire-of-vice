// The simulation gateway's logic (architecture §2, §4), separate from the
// worker global so Vitest can drive it with a fake clock and fake timers.
//
// - Every command request is validated with `commandRequestSchema` before it
//   reaches `dispatch`. A malformed request never touches the simulation.
// - The speed scheduler (scheduler.ts) runs on a timer here, inside the worker
//   (ADR 0014 decision 1). The UI only sends speed and visibility.
// - Snapshot throttling (ADR 0014 decision 6): while running, at most one
//   snapshot per SNAPSHOT_INTERVAL_MS; one at once after every request that
//   changes the game or the scheduler. `notify` events go out as soon as the
//   ticks that emitted them have run, ahead of the snapshot; `log` events wait
//   and travel after the next snapshot.
// - The UI never sees GameState, only snapshots. The one exception is
//   SERIALIZE, whose SaveGame goes straight to persistence.
//
// Two sets of rules, chosen by the game's scenario (`founderRules`, ADR 0023
// decision 9):
// - World rules (M001): the world snapshot (SNAPSHOT), world events (EVENTS)
//   and full command results (COMMAND_RESULT), as before.
// - Founder rules (M002): only the player snapshot (PLAYER_SNAPSHOT) and the
//   player's command results (PLAYER_COMMAND_RESULT) leave the worker (ADR 0021
//   decision 2). No world event is forwarded to the UI, so none becomes a toast
//   (ADR 0028 decision 8); the activity comes from the player snapshot's feed.
//   The world events are still taken, so they don't pile up, and the end of the
//   game still pauses: the outcome is always known (ADR 0021 decision 3).
//   The rest fast-forward follows the founder from each player snapshot
//   (`followFounder`, ADR 0023 decision 9).

import {
  ACTIVITY_IMPORTANCE,
  commandRequestSchema,
  EVENT_IMPORTANCE,
  formatIssues,
  type CommandResult,
  type GameEvent,
  type PlayerCommandResult,
  type PlayerSnapshot,
  type Simulation,
} from "@eov/contracts";
import type { ScenarioDefinition } from "@eov/game-data";
import { loadGame, newGame } from "@eov/simulation";
import { WORKER_COPY } from "./copy.ts";
import type { WorkerMessage, WorkerRequest, WorkerResponse } from "./protocol.ts";
import { PLAYABLE_SCENARIOS, playableScenario } from "./scenarios.ts";
import { isSpeed, SpeedScheduler, type FounderPacing, type SchedulerClock } from "./scheduler.ts";

/** How often the scheduler's timer steps while running. Engineering constant: 4× is one tick per ~21 ms. */
export const TIMER_INTERVAL_MS = 50;

/** Fewest real milliseconds between two throttled snapshots while running (ADR 0014 decision 6). */
export const SNAPSHOT_INTERVAL_MS = 200;

export interface HostEnvironment extends SchedulerClock {
  post(message: WorkerMessage): void;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export class SimulationHost {
  readonly #env: HostEnvironment;
  readonly #scheduler: SpeedScheduler;
  #sim: Simulation | null = null;
  /** The running game's scenario has founder rules on (ADR 0023 decision 9). */
  #founderRules = false;
  #timer: unknown = null;
  /** Ticks have run since the last snapshot. */
  #dirty = false;
  #lastSnapshotAt = Number.NEGATIVE_INFINITY;
  /** Log events waiting for the next snapshot. World rules only. */
  #pendingLog: GameEvent[] = [];

  constructor(env: HostEnvironment) {
    this.#env = env;
    this.#scheduler = new SpeedScheduler(env);
  }

  /** Handles one request. Never throws: failures come back as ERROR. */
  receive(request: WorkerRequest): void {
    let response: WorkerResponse;
    try {
      response = this.#handle(request);
    } catch (error) {
      response = { type: "ERROR", requestId: request.requestId, message: messageOf(error) };
    }
    this.#env.post(response);
  }

  /** One timer step: run what the scheduler owes, then a snapshot if one is due. */
  step(): void {
    const sim = this.#sim;
    if (!sim) return;
    try {
      const ticks = this.#scheduler.step();
      let player: PlayerSnapshot | null = null;
      if (ticks > 0) {
        sim.advance(ticks);
        const events = this.#collectEvents(sim);
        this.#dirty = true;
        // The end of the game pauses (ADR 0020 decision 16): the batch has run, so
        // the clock may be past the deciding tick by up to one batch. Resuming
        // isn't refused.
        if (events.some((e) => e.type === "VICTORY_ACHIEVED" || e.type === "GAME_LOST")) {
          this.#scheduler.setSpeed(0);
          this.#syncTimer();
          this.#publish(sim);
          return;
        }
        // The fast-forward follows the founder after every batch, not only when a snapshot is due.
        if (this.#founderRules) player = this.#followFounder(sim.playerSnapshot());
      }
      if (this.#dirty && this.#env.now() - this.#lastSnapshotAt >= SNAPSHOT_INTERVAL_MS) this.#publish(sim, player);
    } catch (error) {
      this.#scheduler.setSpeed(0);
      this.#syncTimer();
      this.#env.post({ type: "FAULT", message: messageOf(error) });
      this.#publish(sim);
    }
  }

  #handle(request: WorkerRequest): WorkerResponse {
    const { requestId } = request;
    switch (request.type) {
      case "NEW_GAME": {
        // The opening balance is booked while building the state, before the
        // simulation exists, so a new game starts with no pending events.
        const scenario = this.#scenario(request.scenarioId ?? PLAYABLE_SCENARIOS[0]!.id);
        return this.#start(newGame({ scenario }), scenario, requestId);
      }
      case "LOAD_GAME": {
        // The save's own scenario: `loadGame` takes the rules from it (SK1a review).
        const scenario = this.#scenario(request.save.scenarioId);
        return this.#start(loadGame(request.save, { scenario }), scenario, requestId);
      }
      case "DISPATCH": {
        const sim = this.#running();
        const parsed = commandRequestSchema.safeParse(request.request);
        if (!parsed.success) return { type: "INVALID_REQUEST", requestId, issues: formatIssues(parsed.error) };
        const result = sim.dispatch(parsed.data);
        this.#publish(sim);
        return this.#founderRules
          ? { type: "PLAYER_COMMAND_RESULT", requestId, result: playerResult(result) }
          : { type: "COMMAND_RESULT", requestId, result };
      }
      case "SET_SPEED": {
        const sim = this.#running();
        if (!isSpeed(request.speed)) throw new RangeError(WORKER_COPY.notASpeed(String(request.speed)));
        if (!this.#scheduler.setSpeed(request.speed)) throw new Error(WORKER_COPY.tabHidden);
        this.#syncTimer();
        this.#publish(sim);
        return { type: "READY", requestId };
      }
      case "SET_VISIBILITY": {
        this.#scheduler.setVisible(request.visible);
        this.#syncTimer();
        if (this.#sim) this.#publish(this.#sim);
        return { type: "READY", requestId };
      }
      case "ADVANCE": {
        const sim = this.#running();
        this.#scheduler.setSpeed(0);
        this.#syncTimer();
        // advance() throws RangeError on anything but a non-negative whole number; reported as ERROR.
        sim.advance(request.ticks);
        this.#publish(sim);
        return { type: "READY", requestId };
      }
      case "SERIALIZE":
        return { type: "SAVE_GAME", requestId, save: this.#running().serialize() };
    }
  }

  #scenario(id: string): ScenarioDefinition {
    const scenario = playableScenario(id);
    if (!scenario) throw new Error(WORKER_COPY.unknownScenario(id));
    return scenario;
  }

  #start(sim: Simulation, scenario: ScenarioDefinition, requestId: number): WorkerResponse {
    this.#sim = sim;
    this.#founderRules = scenario.founderRules;
    // The scenario's pacing (ADR 0023 decision 9), with no fast-forward until the founder is followed.
    this.#scheduler.reset(scenario.realMsPerGameHourAt1x);
    this.#syncTimer();
    this.#pendingLog = [];
    this.#publish(sim);
    return { type: "READY", requestId };
  }

  #running(): Simulation {
    if (!this.#sim) throw new Error(WORKER_COPY.noGame);
    return this.#sim;
  }

  /** The timer runs only while the scheduler does. */
  #syncTimer(): void {
    const running = this.#scheduler.speed !== 0;
    if (running && this.#timer === null) {
      this.#timer = this.#env.setInterval(() => this.step(), TIMER_INTERVAL_MS);
    } else if (!running && this.#timer !== null) {
      this.#env.clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * Takes the world events. Under world rules, posts notify events at once and
   * keeps log events for the next snapshot; under founder rules, posts none
   * (ADR 0021 decision 2). Returns the events taken.
   */
  #collectEvents(sim: Simulation): readonly GameEvent[] {
    const events = sim.takeEvents();
    if (this.#founderRules) return events;
    const notify: GameEvent[] = events.filter((e) => EVENT_IMPORTANCE[e.type] === "notify");
    if (notify.length > 0) this.#env.post({ type: "EVENTS", importance: "notify", events: notify });
    for (const e of events) if (EVENT_IMPORTANCE[e.type] === "log") this.#pendingLog.push(e);
    return events;
  }

  /** Feeds the rest fast-forward from a player snapshot (ADR 0023 decision 9), and returns it. */
  #followFounder(player: PlayerSnapshot): PlayerSnapshot {
    this.#scheduler.followFounder(founderPacing(player));
    return player;
  }

  /**
   * World rules: events first (notify immediately), then the snapshot, then the
   * waiting log batch. Founder rules: the player snapshot alone, after the
   * fast-forward has followed it, so its scheduler status is current. `player`
   * is one already built for the current tick.
   */
  #publish(sim: Simulation, player: PlayerSnapshot | null = null): void {
    this.#collectEvents(sim);
    const stateHash = sim.stateHash();
    if (this.#founderRules) {
      const snapshot = this.#followFounder(player ?? sim.playerSnapshot());
      this.#env.post({ type: "PLAYER_SNAPSHOT", snapshot, stateHash, scheduler: this.#scheduler.status });
    } else {
      this.#env.post({ type: "SNAPSHOT", snapshot: sim.snapshot(), stateHash, scheduler: this.#scheduler.status });
      if (this.#pendingLog.length > 0) this.#env.post({ type: "EVENTS", importance: "log", events: this.#pendingLog });
    }
    this.#pendingLog = [];
    this.#dirty = false;
    this.#lastSnapshotAt = this.#env.now();
  }
}

/**
 * What the fast-forward follows, from the player snapshot only: the founder's
 * rest (always known), and whether a `notify` activity item (ACTIVITY_IMPORTANCE)
 * landed after the rest began. Items at the rest's start tick don't count, so
 * the REST command's own item doesn't end it.
 */
export function founderPacing(player: PlayerSnapshot): FounderPacing {
  const w = player.founder.whereabouts;
  if (w.kind !== "RESTING") return { restStartedAt: null, notifyLanded: false };
  const notifyLanded = player.activity.some((item) => item.tick > w.startedAt && ACTIVITY_IMPORTANCE[item.kind] === "notify");
  return { restStartedAt: w.startedAt, notifyLanded };
}

/** The player's command result (ADR 0021 decision 2): the world result without its `eventIds`. */
export function playerResult(result: CommandResult): PlayerCommandResult {
  switch (result.status) {
    case "applied":
      return { status: "applied", commandId: result.commandId, tick: result.tick };
    case "queued":
      return result;
    case "rejected":
      return result;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
