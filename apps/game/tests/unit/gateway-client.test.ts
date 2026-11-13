// GatewayView.game (#147): which game the view shows. It moves on with each new
// game or load the worker accepts, including a reload of the same slot, and not
// on anything else, so UI state that belongs to one game can be keyed to it.

import { midGameSnapshot } from "@eov/contracts/fixtures";
import { THE_FIRST_HIRE_SCENARIO } from "@eov/game-data";
import { MemoryStorageAdapter, writeSave } from "@eov/persistence";
import { newGame } from "@eov/simulation";
import { describe, expect, it } from "vitest";
import { GatewayClient, type GatewayView } from "../../src/state/gateway-client.ts";
import type { WorkerMessage, WorkerRequest } from "../../src/workers/protocol.ts";
import { PAUSED_STATUS } from "../../src/workers/scheduler.ts";

/** A worker that answers like the simulation host: a snapshot, then READY (or an ERROR when told to fail). */
class FakeWorker {
  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null = null;
  fail: string | null = null;

  postMessage(request: WorkerRequest): void {
    queueMicrotask(() => {
      if (this.fail) return this.push({ type: "ERROR", requestId: request.requestId, message: this.fail });
      if (request.type === "SERIALIZE") return this.push({ type: "SAVE_GAME", requestId: request.requestId, save: newGame().serialize() });
      this.snapshot();
      this.push({ type: "READY", requestId: request.requestId });
    });
  }

  snapshot(): void {
    this.push({ type: "SNAPSHOT", snapshot: midGameSnapshot, stateHash: "hash", scheduler: PAUSED_STATUS });
  }

  push(message: WorkerMessage): void {
    this.onmessage?.({ data: message } as MessageEvent<WorkerMessage>);
  }
}

async function setup() {
  const worker = new FakeWorker();
  const storage = new MemoryStorageAdapter();
  await writeSave(storage, newGame(), { slot: "slot-1", label: "Saved", savedAt: "2026-11-08T12:00:00.000Z", appVersion: "test" });
  const gateway = new GatewayClient(worker as unknown as Worker, storage);
  const seen: GatewayView[] = [];
  gateway.onSnapshot((view) => seen.push(view));
  return { worker, gateway, seen };
}

describe("GatewayView.game", () => {
  it("is 0 before any game, and moves on with each new game", async () => {
    const { gateway } = await setup();
    expect(gateway.view.game).toBe(0);
    await gateway.newGame();
    expect(gateway.view.game).toBe(1);
    await gateway.newGame();
    expect(gateway.view.game).toBe(2);
  });

  it("moves on with every load, including a reload of the same slot", async () => {
    const { gateway } = await setup();
    await gateway.newGame();
    expect(await gateway.load("slot-1")).toEqual({ ok: true });
    expect(gateway.view.game).toBe(2);
    expect(await gateway.load("slot-1")).toEqual({ ok: true });
    expect(gateway.view.game).toBe(3);
  });

  it("stays put for snapshots, commands, speed changes, and saves", async () => {
    const { worker, gateway } = await setup();
    await gateway.newGame();
    worker.snapshot();
    await gateway.setSpeed(1);
    await gateway.advance(10);
    await gateway.save("slot-2", "Another");
    expect(gateway.view.game).toBe(1);
  });

  it("stays put when a load fails, in persistence or in the worker", async () => {
    const { worker, gateway } = await setup();
    await gateway.newGame();
    expect((await gateway.load("slot-9")).ok).toBe(false);
    worker.fail = "worker gone";
    await expect(gateway.load("slot-1")).rejects.toThrow("worker gone");
    expect(gateway.view.game).toBe(1);
  });

  it("changes after the new game's snapshot, never on the previous game's", async () => {
    const { gateway, seen } = await setup();
    await gateway.newGame();
    const games = seen.map((v) => v.game);
    // The new game's snapshot arrives first (still marked 0), then READY moves the view on.
    expect(games).toEqual([0, 1]);
  });
});

// SK2a (#174): under founder rules the view holds only the player snapshot,
// and no world event reaches a listener (ADR 0021 decision 2).
describe("GatewayClient under founder rules", () => {
  const player = newGame({ scenario: THE_FIRST_HIRE_SCENARIO }).playerSnapshot();

  /** A worker for a First Hire game: player snapshots and player results only. */
  class FounderWorker extends FakeWorker {
    requests: WorkerRequest[] = [];
    override postMessage(request: WorkerRequest): void {
      this.requests.push(request);
      queueMicrotask(() => {
        this.push({ type: "PLAYER_SNAPSHOT", snapshot: player, stateHash: "hash", scheduler: { speed: 1, autoPaused: false, fastForward: true } });
        if (request.type === "DISPATCH") {
          this.push({ type: "PLAYER_COMMAND_RESULT", requestId: request.requestId, result: { status: "applied", commandId: "cmd-1" as never, tick: player.clock.tick } });
        } else {
          this.push({ type: "READY", requestId: request.requestId });
        }
      });
    }
  }

  const client = (worker: FounderWorker) => new GatewayClient(worker as unknown as Worker, new MemoryStorageAdapter());

  it("asks for the scenario, and holds a PlayerSnapshot with no world snapshot", async () => {
    const worker = new FounderWorker();
    const gateway = client(worker);
    worker.snapshot(); // a world snapshot from an earlier First Shipment game
    expect(gateway.view.snapshot).not.toBeNull();
    await gateway.newGame(THE_FIRST_HIRE_SCENARIO.id);
    expect(worker.requests[0]).toMatchObject({ type: "NEW_GAME", scenarioId: THE_FIRST_HIRE_SCENARIO.id });
    expect(gateway.view.playerSnapshot).toBe(player);
    expect(gateway.view.snapshot).toBeNull();
    expect(gateway.view.scheduler.fastForward).toBe(true);
  });

  it("returns the player's command result", async () => {
    const gateway = client(new FounderWorker());
    await gateway.newGame(THE_FIRST_HIRE_SCENARIO.id);
    expect(await gateway.dispatch({ command: { type: "WAKE" } })).toEqual({
      kind: "player-result",
      result: { status: "applied", commandId: "cmd-1", tick: player.clock.tick },
    });
  });

  it("passes no world event to a listener, even one the worker shouldn't have sent", async () => {
    const worker = new FounderWorker();
    const gateway = client(worker);
    const heard: unknown[] = [];
    gateway.onEvents((events) => heard.push(...events));
    await gateway.newGame(THE_FIRST_HIRE_SCENARIO.id);
    const world = newGame({ scenario: THE_FIRST_HIRE_SCENARIO });
    world.advance(1_440);
    const events = world.takeEvents();
    expect(events.length).toBeGreaterThan(0);
    worker.push({ type: "EVENTS", importance: "notify", events });
    expect(heard).toEqual([]);

    // World rules again (a First Shipment game): events are passed on as before.
    worker.snapshot();
    worker.push({ type: "EVENTS", importance: "notify", events });
    expect(heard).toHaveLength(events.length);
  });
});
