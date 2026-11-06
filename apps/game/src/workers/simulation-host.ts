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

import { commandRequestSchema, EVENT_IMPORTANCE, formatIssues, type GameEvent, type Simulation } from "@eov/contracts";
import { loadGame, newGame } from "@eov/simulation";
import { WORKER_COPY } from "./copy.ts";
import type { WorkerMessage, WorkerRequest, WorkerResponse } from "./protocol.ts";
import { isSpeed, SpeedScheduler, type SchedulerClock } from "./scheduler.ts";

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
  #timer: unknown = null;
  /** Ticks have run since the last snapshot. */
  #dirty = false;
  #lastSnapshotAt = Number.NEGATIVE_INFINITY;
  /** Log events waiting for the next snapshot. */
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
      if (ticks > 0) {
        sim.advance(ticks);
        this.#collectEvents(sim);
        this.#dirty = true;
      }
      if (this.#dirty && this.#env.now() - this.#lastSnapshotAt >= SNAPSHOT_INTERVAL_MS) this.#publish(sim);
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
      case "NEW_GAME":
        // The opening balance is booked while building the state, before the
        // simulation exists, so a new game starts with no pending events.
        return this.#start(newGame(), requestId);
      case "LOAD_GAME":
        return this.#start(loadGame(request.save), requestId);
      case "DISPATCH": {
        const sim = this.#running();
        const parsed = commandRequestSchema.safeParse(request.request);
        if (!parsed.success) return { type: "INVALID_REQUEST", requestId, issues: formatIssues(parsed.error) };
        const result = sim.dispatch(parsed.data);
        this.#publish(sim);
        return { type: "COMMAND_RESULT", requestId, result };
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

  #start(sim: Simulation, requestId: number): WorkerResponse {
    this.#sim = sim;
    this.#scheduler.reset();
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

  /** Posts notify events at once; keeps log events for the next snapshot. */
  #collectEvents(sim: Simulation): void {
    const events = sim.takeEvents();
    const notify: GameEvent[] = events.filter((e) => EVENT_IMPORTANCE[e.type] === "notify");
    if (notify.length > 0) this.#env.post({ type: "EVENTS", importance: "notify", events: notify });
    for (const e of events) if (EVENT_IMPORTANCE[e.type] === "log") this.#pendingLog.push(e);
  }

  /** Events first (notify immediately), then the snapshot, then the waiting log batch. */
  #publish(sim: Simulation): void {
    this.#collectEvents(sim);
    this.#env.post({ type: "SNAPSHOT", snapshot: sim.snapshot(), stateHash: sim.stateHash(), scheduler: this.#scheduler.status });
    if (this.#pendingLog.length > 0) this.#env.post({ type: "EVENTS", importance: "log", events: this.#pendingLog });
    this.#pendingLog = [];
    this.#dirty = false;
    this.#lastSnapshotAt = this.#env.now();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
