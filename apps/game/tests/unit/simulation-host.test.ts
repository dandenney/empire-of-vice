// The worker's host logic with a fake clock and a fake timer: the scheduler
// drives the simulation, snapshots are throttled, and notify events go out at
// once (issue #11, ADR 0014).

import type { GameSnapshot } from "@eov/contracts";
import { describe, expect, it } from "vitest";
import type { WorkerMessage, WorkerRequest } from "../../src/workers/protocol.ts";
import { SimulationHost, SNAPSHOT_INTERVAL_MS, TIMER_INTERVAL_MS, type HostEnvironment } from "../../src/workers/simulation-host.ts";

type Body = WorkerRequest extends infer R ? (R extends unknown ? Omit<R, "requestId"> : never) : never;

class FakeEnv implements HostEnvironment {
  ms = 0;
  messages: WorkerMessage[] = [];
  timers = new Map<number, () => void>();
  #nextTimer = 1;

  now = (): number => this.ms;
  post = (message: WorkerMessage): void => {
    this.messages.push(message);
  };
  setInterval = (callback: () => void): unknown => {
    const id = this.#nextTimer++;
    this.timers.set(id, callback);
    return id;
  };
  clearInterval = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  /** Moves the clock in timer-interval steps, firing the timer each time. */
  elapse(ms: number): void {
    const end = this.ms + ms;
    while (this.ms < end) {
      this.ms = Math.min(this.ms + TIMER_INTERVAL_MS, end);
      for (const callback of [...this.timers.values()]) callback();
    }
  }

  take(): WorkerMessage[] {
    const taken = this.messages;
    this.messages = [];
    return taken;
  }
}

function setup(): { env: FakeEnv; host: SimulationHost; send: (body: Body) => WorkerMessage[] } {
  const env = new FakeEnv();
  const host = new SimulationHost(env);
  let requestId = 1;
  /** Sends one request and returns only what it posted. */
  const send = (body: Body): WorkerMessage[] => {
    env.take();
    host.receive({ ...body, requestId: requestId++ } as WorkerRequest);
    return env.take();
  };
  return { env, host, send };
}

const snapshots = (messages: readonly WorkerMessage[]) => messages.filter((m) => m.type === "SNAPSHOT");
const lastTick = (messages: readonly WorkerMessage[]): number => {
  const last = snapshots(messages).at(-1);
  if (!last) throw new Error("no snapshot");
  return (last.snapshot as GameSnapshot).clock.tick;
};

describe("SimulationHost", () => {
  it("starts a new game paused, with no timer running", () => {
    const { env, send } = setup();
    const messages = send({ type: "NEW_GAME" });
    expect(snapshots(messages)).toHaveLength(1);
    expect(snapshots(messages)[0]!.scheduler).toEqual({ speed: 0, autoPaused: false });
    expect(env.timers.size).toBe(0);
    env.elapse(60_000);
    expect(env.take()).toEqual([]);
  });

  it("runs 12 ticks per real second at 1× through its own timer", () => {
    const { env, send } = setup();
    send({ type: "NEW_GAME" });
    send({ type: "SET_SPEED", speed: 1 });
    env.elapse(10_000);
    expect(lastTick(env.take())).toBe(120);
    send({ type: "SET_SPEED", speed: 4 });
    env.elapse(10_000);
    expect(lastTick(env.take())).toBe(120 + 480);
  });

  it("posts at most one snapshot per 200 ms while running", () => {
    const { env, send } = setup();
    send({ type: "NEW_GAME" });
    send({ type: "SET_SPEED", speed: 4 });
    env.elapse(10_000);
    const count = snapshots(env.take()).length;
    expect(count).toBeLessThanOrEqual(10_000 / SNAPSHOT_INTERVAL_MS);
    expect(count).toBeGreaterThanOrEqual(10_000 / SNAPSHOT_INTERVAL_MS - 1);
  });

  it("posts a snapshot at once after a command, a speed change, and a pause", () => {
    const { env, send } = setup();
    send({ type: "NEW_GAME" });
    send({ type: "SET_SPEED", speed: 1 });
    env.elapse(1_000);
    env.take();

    const command = send({
      type: "DISPATCH",
      request: { command: { type: "PURCHASE_MATERIALS", supplierId: "millers-feed", materialId: "corn", quantity: 1, facilityId: "distillery-main" } },
    });
    expect(snapshots(command)).toHaveLength(1);
    expect(command.at(-1)).toMatchObject({ type: "COMMAND_RESULT", result: { status: "applied" } });

    const faster = send({ type: "SET_SPEED", speed: 2 });
    expect(snapshots(faster)).toHaveLength(1);
    expect(snapshots(faster)[0]!.scheduler.speed).toBe(2);

    const paused = send({ type: "SET_SPEED", speed: 0 });
    expect(snapshots(paused)).toHaveLength(1);
    expect(snapshots(paused)[0]!.scheduler.speed).toBe(0);
  });

  it("holds the tick while paused", () => {
    const { env, send } = setup();
    send({ type: "NEW_GAME" });
    send({ type: "SET_SPEED", speed: 4 });
    env.elapse(1_000);
    const tick = lastTick(send({ type: "SET_SPEED", speed: 0 }));
    expect(env.timers.size).toBe(0);
    env.elapse(60_000);
    expect(env.take()).toEqual([]);
    expect(lastTick(send({ type: "SET_VISIBILITY", visible: true }))).toBe(tick);
  });

  it("auto-pauses on a hidden tab, stays paused when visible, and refuses speed while hidden", () => {
    const { env, send } = setup();
    send({ type: "NEW_GAME" });
    send({ type: "SET_SPEED", speed: 1 });
    env.elapse(1_000);
    const hidden = send({ type: "SET_VISIBILITY", visible: false });
    const tick = lastTick(hidden);
    expect(snapshots(hidden)[0]!.scheduler).toEqual({ speed: 0, autoPaused: true });

    expect(send({ type: "SET_SPEED", speed: 1 }).at(-1)).toMatchObject({ type: "ERROR" });
    env.elapse(60_000);
    const visible = send({ type: "SET_VISIBILITY", visible: true });
    expect(snapshots(visible)[0]!.scheduler).toEqual({ speed: 0, autoPaused: true });
    expect(lastTick(visible)).toBe(tick);
    env.elapse(5_000);
    expect(env.take()).toEqual([]);
  });

  it("ADVANCE pauses, then runs exactly that many ticks", () => {
    const { env, send } = setup();
    send({ type: "NEW_GAME" });
    send({ type: "SET_SPEED", speed: 4 });
    env.elapse(1_000); // exactly 48 ticks at 4×
    env.take();
    const advanced = send({ type: "ADVANCE", ticks: 100 });
    expect(lastTick(advanced)).toBe(48 + 100);
    expect(snapshots(advanced)[0]!.scheduler.speed).toBe(0);
    expect(env.timers.size).toBe(0);
  });

  it("posts notify events ahead of the throttled snapshot, and log events after it", () => {
    const { env, send } = setup();
    send({ type: "NEW_GAME" });
    for (const request of [
      { command: { type: "PURCHASE_MATERIALS", supplierId: "millers-feed", materialId: "corn", quantity: 4, facilityId: "distillery-main" } },
      { command: { type: "PURCHASE_MATERIALS", supplierId: "millers-feed", materialId: "sugar", quantity: 2, facilityId: "distillery-main" } },
    ]) {
      send({ type: "DISPATCH", request });
    }
    const started = send({ type: "DISPATCH", request: { command: { type: "START_PRODUCTION", facilityId: "distillery-main", recipeId: "basic-moonshine", quantity: 1 } } });
    const job = snapshots(started).at(-1)!.snapshot.productionJobs[0];
    if (!job) throw new Error("production didn't start; check the S0 recipe inputs");

    send({ type: "SET_SPEED", speed: 4 });
    // Run until the job completes; PRODUCTION_COMPLETED is a notify event.
    const messages: WorkerMessage[] = [];
    while (!messages.some((m) => m.type === "EVENTS" && m.events.some((e) => e.type === "PRODUCTION_COMPLETED"))) {
      env.elapse(TIMER_INTERVAL_MS);
      messages.push(...env.take());
      if (env.ms > 3_600_000) throw new Error("job never completed");
    }
    const notifyAt = messages.findIndex((m) => m.type === "EVENTS" && m.importance === "notify");
    const notify = messages[notifyAt]!;
    expect(notify).toMatchObject({ type: "EVENTS", importance: "notify" });
    // No snapshot showing the completed job was posted before the event.
    for (const m of messages.slice(0, notifyAt)) {
      if (m.type === "SNAPSHOT") expect(m.snapshot.productionJobs).toHaveLength(1);
    }
    // Log events only ever directly follow a snapshot.
    messages.forEach((m, i) => {
      if (m.type === "EVENTS" && m.importance === "log") expect(messages[i - 1]?.type).toBe("SNAPSHOT");
    });
  });

  it("validates commands before dispatch and reports requests with no game as ERROR", () => {
    const { send } = setup();
    expect(send({ type: "SET_SPEED", speed: 1 }).at(-1)).toMatchObject({ type: "ERROR" });
    send({ type: "NEW_GAME" });
    expect(send({ type: "DISPATCH", request: { command: { type: "NOT_A_COMMAND" } } }).at(-1)).toMatchObject({ type: "INVALID_REQUEST" });
    expect(send({ type: "SET_SPEED", speed: 3 as 1 }).at(-1)).toMatchObject({ type: "ERROR" });
  });

  it("gives the same state hash at 1× and 4× for the same timed commands (SIM-001)", () => {
    const hashAt = (speed: 1 | 4): string => {
      const { env, send } = setup();
      send({ type: "NEW_GAME" });
      send({ type: "DISPATCH", request: { command: { type: "PURCHASE_MATERIALS", supplierId: "millers-feed", materialId: "corn", quantity: 4, facilityId: "distillery-main" } } });
      send({ type: "SET_SPEED", speed });
      // Run past a game day, then stop at exactly tick 2,000.
      env.elapse(Math.ceil((2_000 * 5_000) / 60 / speed));
      send({ type: "SET_SPEED", speed: 0 });
      const tick = lastTick(send({ type: "SET_VISIBILITY", visible: true }));
      expect(tick).toBeGreaterThanOrEqual(2_000);
      expect(tick).toBeLessThan(2_000 + 60);
      return snapshots(send({ type: "ADVANCE", ticks: 2_100 - tick }))[0]!.stateHash;
    };
    expect(hashAt(1)).toBe(hashAt(4));
  });
});
