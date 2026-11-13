// SK2a (#174): the worker under founder rules, with a fake clock and timer.
// A First Hire game publishes only the player snapshot (ADR 0021 decision 2),
// forwards no world events (ADR 0028 decision 8), resumes from a save with
// founder rules on, takes the founder commands through the gateway, and runs
// the rest fast-forward while the founder sleeps (ADR 0023 decision 9).

import { EVENT_IMPORTANCE, type ActivityItem, type PlayerSnapshot, type SaveGame } from "@eov/contracts";
import { FIRST_SHIPMENT_SCENARIO, MIN_REST_TICKS, REST_SPEED_MULTIPLIER, THE_FIRST_HIRE_SCENARIO } from "@eov/game-data";
import { newGame } from "@eov/simulation";
import { describe, expect, it } from "vitest";
import { toastsFor } from "../../src/ui/toasts/toast-view.ts";
import type { WorkerMessage, WorkerRequest } from "../../src/workers/protocol.ts";
import { founderPacing, SimulationHost, TIMER_INTERVAL_MS, type HostEnvironment } from "../../src/workers/simulation-host.ts";

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

function setup() {
  const env = new FakeEnv();
  const host = new SimulationHost(env);
  let requestId = 1;
  const send = (body: Body): WorkerMessage[] => {
    env.take();
    host.receive({ ...body, requestId: requestId++ } as WorkerRequest);
    return env.take();
  };
  return { env, host, send };
}

const HIRE = THE_FIRST_HIRE_SCENARIO.id;
const players = (messages: readonly WorkerMessage[]) => messages.filter((m) => m.type === "PLAYER_SNAPSHOT");
const lastPlayer = (messages: readonly WorkerMessage[]): PlayerSnapshot => {
  const last = players(messages).at(-1);
  if (!last) throw new Error("no player snapshot");
  return last.snapshot;
};
/** World snapshots and world events: what must never reach the UI under founder rules. */
const worldMessages = (messages: readonly WorkerMessage[]) => messages.filter((m) => m.type === "SNAPSHOT" || m.type === "EVENTS");

describe("SimulationHost under founder rules (the First Hire)", () => {
  it("starts a First Hire game and publishes the player snapshot, never the world snapshot", () => {
    const { send } = setup();
    const started = send({ type: "NEW_GAME", scenarioId: HIRE });
    expect(started.at(-1)).toMatchObject({ type: "READY" });
    expect(worldMessages(started)).toEqual([]);
    const player = lastPlayer(started);
    // The player snapshot's shape, not the world snapshot's.
    expect(player).toHaveProperty("founder");
    expect(player).toHaveProperty("activity");
    expect(player).not.toHaveProperty("recentEvents");
    expect(player.founder.whereabouts).toMatchObject({ kind: "RESTING", locationId: THE_FIRST_HIRE_SCENARIO.founderStartLocationId });
    expect(player.finance.cash).toBe(THE_FIRST_HIRE_SCENARIO.openingBalance.cash);
  });

  it("keeps world rules for the First Shipment, by name or by default (M001 unchanged)", () => {
    const { send } = setup();
    for (const body of [{ type: "NEW_GAME" }, { type: "NEW_GAME", scenarioId: FIRST_SHIPMENT_SCENARIO.id }] as const) {
      const started = send(body);
      expect(players(started)).toEqual([]);
      expect(started.filter((m) => m.type === "SNAPSHOT")).toHaveLength(1);
      expect(started.at(-1)).toMatchObject({ type: "READY" });
    }
  });

  it("refuses a scenario this build doesn't play", () => {
    const { send } = setup();
    expect(send({ type: "NEW_GAME", scenarioId: "no-such-scenario" as typeof HIRE }).at(-1)).toMatchObject({ type: "ERROR" });
  });

  it("forwards no world event to the UI, so nothing becomes a toast (ADR 0028 decision 8)", () => {
    // Midnight's CONTRACT_OFFERED is a notify event with a toast: the world rules would toast it.
    const ticks = 2 * 1_440;
    const world = newGame({ scenario: THE_FIRST_HIRE_SCENARIO });
    world.advance(ticks);
    const emitted = world.takeEvents();
    expect(emitted.some((e) => EVENT_IMPORTANCE[e.type] === "notify")).toBe(true);
    expect(toastsFor(emitted, world.snapshot()).length).toBeGreaterThan(0);

    // The same days in the host, by ADVANCE and by the running timer: no EVENTS, no world snapshot.
    const { env, send } = setup();
    const messages = [...send({ type: "NEW_GAME", scenarioId: HIRE }), ...send({ type: "ADVANCE", ticks: 1_440 })];
    send({ type: "SET_SPEED", speed: 4 });
    while (lastTickOf(messages) < ticks) {
      env.elapse(1_000);
      messages.push(...env.take());
    }
    expect(lastTickOf(messages)).toBeGreaterThanOrEqual(ticks);
    expect(worldMessages(messages)).toEqual([]);
    expect(players(messages).length).toBeGreaterThan(1);
  });

  it("saves and loads a First Hire game with founder rules still on", () => {
    const { send } = setup();
    send({ type: "NEW_GAME", scenarioId: HIRE });
    send({ type: "ADVANCE", ticks: 500 });
    const saved = send({ type: "SERIALIZE" }).at(-1);
    if (saved?.type !== "SAVE_GAME") throw new Error("no save");
    expect(saved.save.scenarioId).toBe(HIRE);
    const hashBefore = players(send({ type: "SET_VISIBILITY", visible: true })).at(-1)!.stateHash;

    // A fresh worker, from the save as it comes back out of storage (JSON).
    const other = setup();
    const save = JSON.parse(JSON.stringify(saved.save)) as SaveGame;
    const loaded = other.send({ type: "LOAD_GAME", save });
    expect(loaded.at(-1)).toMatchObject({ type: "READY" });
    expect(worldMessages(loaded)).toEqual([]);
    expect(players(loaded).at(-1)!.stateHash).toBe(hashBefore);
    // Founder rules on: the founder commands do something (under world rules REST is a no-op).
    const rest = other.send({ type: "DISPATCH", request: { command: { type: "REST", untilTick: 500 + 1 + MIN_REST_TICKS } } });
    expect(rest.at(-1)).toMatchObject({ type: "PLAYER_COMMAND_RESULT", result: { status: "applied" } });
    expect(lastPlayer(rest).founder.whereabouts).toMatchObject({ kind: "RESTING", until: 500 + 1 + MIN_REST_TICKS });
    // And the M002 pacing: 3 ticks per real second at 1× once the founder is awake again.
    other.send({ type: "DISPATCH", request: { command: { type: "WAKE" } } });
    other.send({ type: "SET_SPEED", speed: 1 });
    const tick = lastTickOf(other.send({ type: "SET_VISIBILITY", visible: true }));
    other.env.elapse(1_000);
    expect(lastTickOf(other.env.take()) - tick).toBe((1_000 * 60) / THE_FIRST_HIRE_SCENARIO.realMsPerGameHourAt1x);
  });

  it("refuses to load a save of a scenario this build doesn't play", () => {
    const save = newGame({ scenario: THE_FIRST_HIRE_SCENARIO }).serialize();
    const { send } = setup();
    const refused = send({ type: "LOAD_GAME", save: { ...save, scenarioId: "elsewhere" as typeof save.scenarioId } });
    expect(refused.at(-1)).toMatchObject({ type: "ERROR" });
  });

  it("round-trips TRAVEL, REST and WAKE through the gateway, as player results without event ids", () => {
    const { send } = setup();
    const start = lastPlayer(send({ type: "NEW_GAME", scenarioId: HIRE }));
    const home = THE_FIRST_HIRE_SCENARIO.founderStartLocationId;
    expect(start.founder.whereabouts.kind).toBe("RESTING");

    const woke = send({ type: "DISPATCH", request: { command: { type: "WAKE" } } });
    const wokeResult = woke.at(-1);
    expect(wokeResult).toMatchObject({ type: "PLAYER_COMMAND_RESULT", result: { status: "applied" } });
    if (wokeResult?.type !== "PLAYER_COMMAND_RESULT") throw new Error("no result");
    expect(wokeResult.result).not.toHaveProperty("eventIds");
    expect(lastPlayer(woke).founder.whereabouts).toMatchObject({ kind: "PRESENT", locationId: home });

    const now = lastPlayer(woke).clock.tick;
    const rested = send({ type: "DISPATCH", request: { command: { type: "REST", untilTick: now + 1 + MIN_REST_TICKS } } });
    expect(rested.at(-1)).toMatchObject({ type: "PLAYER_COMMAND_RESULT", result: { status: "applied" } });
    expect(lastPlayer(rested).founder.whereabouts).toMatchObject({ kind: "RESTING", locationId: home });

    send({ type: "DISPATCH", request: { command: { type: "WAKE" } } });
    const destination = start.places.find((p) => p.kind === "SUPPLIER")!.id;
    const travelled = send({
      type: "DISPATCH",
      request: { command: { type: "TRAVEL", destinationLocationId: destination, transport: { kind: "FOOT" }, via: null } },
    });
    expect(travelled.at(-1)).toMatchObject({ type: "PLAYER_COMMAND_RESULT", result: { status: "applied" } });
    expect(lastPlayer(travelled).founder.whereabouts).toMatchObject({ kind: "TRAVELLING", destinationLocationId: destination });
    expect(lastPlayer(travelled).here).toBeNull();

    // A refusal comes back with its reason: WAKE while travelling isn't resting.
    const refused = send({ type: "DISPATCH", request: { command: { type: "WAKE" } } });
    expect(refused.at(-1)).toMatchObject({ type: "PLAYER_COMMAND_RESULT", result: { status: "rejected", reason: { code: "NOT_RESTING" } } });
    // A malformed request still never reaches the simulation.
    expect(send({ type: "DISPATCH", request: { command: { type: "WAKE", early: true } } }).at(-1)).toMatchObject({ type: "INVALID_REQUEST" });
    expect(worldMessages([...woke, ...rested, ...travelled, ...refused])).toEqual([]);
  });

  it("fast-forwards while the founder sleeps and drops back to the player's speed when they wake", () => {
    const { env, send } = setup();
    const start = lastPlayer(send({ type: "NEW_GAME", scenarioId: HIRE }));
    const w = start.founder.whereabouts;
    if (w.kind !== "RESTING") throw new Error("the First Hire starts asleep");
    const perSecondAt1x = (1_000 * 60) / THE_FIRST_HIRE_SCENARIO.realMsPerGameHourAt1x;

    // Paused: the founder sleeps, but nothing runs, so no fast-forward.
    expect(players(send({ type: "SET_VISIBILITY", visible: true })).at(-1)!.scheduler).toEqual({ speed: 0, autoPaused: false, fastForward: false });

    const running = players(send({ type: "SET_SPEED", speed: 1 })).at(-1)!;
    expect(running.scheduler).toEqual({ speed: 1, autoPaused: false, fastForward: true });
    env.elapse(1_000);
    const asleep = env.take();
    expect(lastTickOf(asleep)).toBe(REST_SPEED_MULTIPLIER * perSecondAt1x);
    expect(players(asleep).every((m) => m.scheduler.fastForward)).toBe(true);

    // Run until the founder wakes at the rest's end.
    const messages: WorkerMessage[] = [];
    while (lastPlayerOr(messages)?.founder.whereabouts.kind !== "PRESENT") {
      env.elapse(TIMER_INTERVAL_MS);
      messages.push(...env.take());
      if (env.ms > 600_000) throw new Error("the founder never woke");
    }
    const awake = players(messages).at(-1)!;
    expect(awake.snapshot.clock.tick).toBeGreaterThanOrEqual(w.until);
    expect(awake.scheduler).toEqual({ speed: 1, autoPaused: false, fastForward: false });

    // Back at the player's 1×.
    const tick = lastTickOf(send({ type: "SET_VISIBILITY", visible: true }));
    env.elapse(10_000);
    expect(lastTickOf(env.take()) - tick).toBe(10 * perSecondAt1x);

    // Sleeping again by command turns it back on at once.
    const now = lastTickOf(send({ type: "SET_VISIBILITY", visible: true }));
    const rest = send({ type: "DISPATCH", request: { command: { type: "REST", untilTick: now + 1 + MIN_REST_TICKS } } });
    expect(players(rest).at(-1)!.scheduler.fastForward).toBe(true);
    // Paused, the flag is off; WAKE turns it off too.
    expect(players(send({ type: "SET_SPEED", speed: 0 })).at(-1)!.scheduler.fastForward).toBe(false);
    send({ type: "SET_SPEED", speed: 2 });
    expect(players(send({ type: "DISPATCH", request: { command: { type: "WAKE" } } })).at(-1)!.scheduler).toEqual({
      speed: 2,
      autoPaused: false,
      fastForward: false,
    });
  });

  it("never fast-forwards under world rules", () => {
    const { env, send } = setup();
    send({ type: "NEW_GAME" });
    send({ type: "SET_SPEED", speed: 1 });
    env.elapse(5_000);
    const messages = env.take();
    expect(messages.filter((m) => m.type === "SNAPSHOT").every((m) => !m.scheduler.fastForward)).toBe(true);
  });
});

describe("founderPacing", () => {
  const base = newGame({ scenario: THE_FIRST_HIRE_SCENARIO }).playerSnapshot();
  const resting = { ...base.founder, whereabouts: { kind: "RESTING", locationId: "hollow-creek", startedAt: 100, until: 500 } } as PlayerSnapshot["founder"];
  const item = (kind: ActivityItem["kind"], tick: number) => ({ kind, tick }) as unknown as ActivityItem;

  it("follows the rest from the player snapshot: its start, and notify items after it only", () => {
    expect(founderPacing(base)).toEqual({ restStartedAt: 0, notifyLanded: false });
    expect(founderPacing({ ...base, founder: resting, activity: [item("COMMAND", 100)] })).toEqual({ restStartedAt: 100, notifyLanded: false });
    expect(founderPacing({ ...base, founder: resting, activity: [item("CATCH_UP", 200)] })).toEqual({ restStartedAt: 100, notifyLanded: false });
    expect(founderPacing({ ...base, founder: resting, activity: [item("CASH_POSTING", 200)] })).toEqual({ restStartedAt: 100, notifyLanded: true });
  });

  it("is off while the founder isn't resting", () => {
    const present = { ...base.founder, whereabouts: { kind: "PRESENT", locationId: "hollow-creek", busy: null, call: null } } as PlayerSnapshot["founder"];
    expect(founderPacing({ ...base, founder: present, activity: [item("CASH_POSTING", 200)] })).toEqual({ restStartedAt: null, notifyLanded: false });
  });
});

function lastPlayerOr(messages: readonly WorkerMessage[]): PlayerSnapshot | null {
  return players(messages).at(-1)?.snapshot ?? null;
}

function lastTickOf(messages: readonly WorkerMessage[]): number {
  return lastPlayerOr(messages)?.clock.tick ?? -1;
}
