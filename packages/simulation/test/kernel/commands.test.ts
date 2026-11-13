// Command identity, timing, atomicity, and replay (ADR 0004).

import { tick, type CommandEnvelope, type GameState } from "@eov/contracts";
import { ids } from "@eov/contracts/fixtures";
import { describe, expect, it } from "vitest";
import { emitEvent, RegistryError } from "../../src/index.ts";
import { buyCorn, day0State, fakeSimulation, setWorkforce, unknownFacility } from "./fakes.ts";

const distilleryWorkers = (s: GameState) => s.facilities.find((f) => f.id === ids.distillery)!.workerCount;

describe("immediate commands", () => {
  it("apply at once, even while paused, as the first thing of the next tick", () => {
    const sim = fakeSimulation();
    const result = sim.dispatch({ command: setWorkforce(ids.distillery, 7) });
    // day0 counters: next command is cmd-3 / sequence 3, next event evt-2.
    expect(result).toEqual({ status: "applied", commandId: "cmd-3", tick: 601, eventIds: ["evt-2"] });
    expect(sim.state.tick).toBe(600); // no tick advanced
    expect(distilleryWorkers(sim.state)).toBe(7);
    expect(sim.state.commandLog.at(-1)).toEqual({ id: "cmd-3", scheduledTick: 601, sequence: 3, issuer: { kind: "FOUNDER" }, command: setWorkforce(ids.distillery, 7) });
    expect(sim.takeEvents()).toEqual([
      { id: "evt-2", tick: 601, causedBy: "cmd-3", type: "WORKFORCE_CHANGED", facilityId: ids.distillery, from: 3, to: 7 },
    ]);
  });

  it("an explicit scheduledTick of state.tick + 1 is the same as omitting it", () => {
    const a = fakeSimulation();
    const b = fakeSimulation();
    a.dispatch({ command: setWorkforce(ids.barn, 2) });
    expect(b.dispatch({ command: setWorkforce(ids.barn, 2), scheduledTick: tick(601) }).status).toBe("applied");
    expect(b.stateHash()).toBe(a.stateHash());
  });

  it("land after already-queued commands due on the same tick (ADR 0004 eager-apply rule)", () => {
    const sim = fakeSimulation();
    const queued = sim.dispatch({ command: setWorkforce(ids.distillery, 5), scheduledTick: tick(602) });
    expect(queued).toEqual({ status: "queued", commandId: "cmd-3", scheduledTick: 602 });
    sim.advance(1); // tick 601; the queued command isn't due yet
    expect(distilleryWorkers(sim.state)).toBe(3);

    const immediate = sim.dispatch({ command: setWorkforce(ids.distillery, 9) });
    expect(immediate).toMatchObject({ status: "applied", commandId: "cmd-4", tick: 602 });
    expect(sim.state.commandLog.slice(-2).map((e) => e.id)).toEqual(["cmd-3", "cmd-4"]);
    expect(sim.state.queuedCommands.map((e) => e.id)).toEqual(["cmd-2"]); // only day0's sugar order remains
    expect(distilleryWorkers(sim.state)).toBe(9);
    const changes = sim.takeEvents().filter((e) => e.type === "WORKFORCE_CHANGED");
    expect(changes.map((e) => [e.causedBy, e.tick])).toEqual([
      ["cmd-3", 602],
      ["cmd-4", 602],
    ]);
  });

  it("are rejected atomically: nothing changes, not even the counters", () => {
    const sim = fakeSimulation(day0State, (registry) =>
      registry.onCommand("PURCHASE_EQUIPMENT", {
        apply: (state, command, ctx) => {
          // Change state and emit an event, then reject: none of it may stick.
          const dirty = emitEvent(
            { ...state, facilities: [] },
            { type: "WORKFORCE_CHANGED", facilityId: command.facilityId, from: 0, to: 1 },
            { tick: ctx.tick, causedBy: ctx.envelope.id },
          ).state;
          void dirty;
          return { status: "rejected", reason: { code: "NO_EQUIPMENT_SLOT", facilityId: command.facilityId, equipmentId: command.equipmentId } };
        },
      }),
    );
    const before = sim.state;
    const hash = sim.stateHash();
    const result = sim.dispatch({ command: { type: "PURCHASE_EQUIPMENT", facilityId: ids.distillery, equipmentId: ids.copperStill } });
    expect(result).toEqual({
      status: "rejected",
      commandId: "cmd-3",
      reason: { code: "NO_EQUIPMENT_SLOT", facilityId: ids.distillery, equipmentId: ids.copperStill },
    });
    expect(sim.state).toBe(before);
    expect(sim.stateHash()).toBe(hash);
    expect(sim.takeEvents()).toEqual([]);
  });

  it("leave stateHash unchanged for every kind of dispatch-time rejection", () => {
    const sim = fakeSimulation();
    sim.advance(10);
    sim.dispatch({ command: setWorkforce(ids.barn, 1), scheduledTick: tick(700) }); // queued, due later
    const hash = sim.stateHash();
    const rejected = [
      sim.dispatch({ command: setWorkforce(unknownFacility, 1) }), // handler rejects (eager path)
      sim.dispatch({ command: buyCorn(1_000) }), // handler rejects (eager path)
      sim.dispatch({ command: buyCorn(0), scheduledTick: tick(900) }), // validate rejects (queued path)
      sim.dispatch({ command: buyCorn(1), scheduledTick: tick(5) }), // SCHEDULED_IN_PAST
      sim.dispatch({ command: buyCorn(1), scheduledTick: 650.5 as never }), // non-integer tick
    ];
    expect(rejected.map((r) => r.status)).toEqual(Array(5).fill("rejected"));
    expect(sim.stateHash()).toBe(hash);
    expect(sim.takeEvents()).toEqual([]);
  });

  it("an eager rejection also discards the queued commands it drained; they still apply on time", () => {
    const sim = fakeSimulation();
    sim.dispatch({ command: setWorkforce(ids.barn, 6), scheduledTick: tick(602) });
    sim.advance(1); // tick 601
    sim.takeEvents();
    const hash = sim.stateHash();
    expect(sim.dispatch({ command: setWorkforce(unknownFacility, 1) }).status).toBe("rejected");
    expect(sim.stateHash()).toBe(hash);
    sim.advance(1); // tick 602: the queued command applies at step 1
    expect(sim.state.facilities.find((f) => f.id === ids.barn)!.workerCount).toBe(6);
    expect(sim.takeEvents().map((e) => [e.tick, e.causedBy])).toEqual([[602, "cmd-3"]]);
  });

  it("return a provisional ID: the one the next accepted command will get", () => {
    const sim = fakeSimulation();
    const results = [
      sim.dispatch({ command: setWorkforce(unknownFacility, 1) }),
      sim.dispatch({ command: buyCorn(1_000) }),
      sim.dispatch({ command: buyCorn(1) }),
      sim.dispatch({ command: buyCorn(1) }),
    ];
    expect(results.map((r) => [r.status, r.commandId])).toEqual([
      ["rejected", "cmd-3"],
      ["rejected", "cmd-3"],
      ["applied", "cmd-3"],
      ["applied", "cmd-4"],
    ]);
    expect(results[1]).toMatchObject({ reason: { code: "SUPPLIER_STOCK_LOW", requested: 1_000, available: 160 } });
    expect(sim.state.commandLog.slice(-2).map((e) => [e.id, e.sequence])).toEqual([
      ["cmd-3", 3],
      ["cmd-4", 4],
    ]);
  });
});

describe("scheduled commands", () => {
  it("reject a past tick with SCHEDULED_IN_PAST", () => {
    const sim = fakeSimulation();
    for (const scheduledTick of [0, 599, 600]) {
      const result = sim.dispatch({ command: buyCorn(1), scheduledTick: tick(scheduledTick) });
      expect(result).toMatchObject({ status: "rejected", reason: { code: "SCHEDULED_IN_PAST", scheduledTick, currentTick: 600 } });
    }
    expect(sim.state.queuedCommands).toEqual(day0State.queuedCommands);
  });

  it("reject a non-integer tick", () => {
    const sim = fakeSimulation();
    const result = sim.dispatch({ command: buyCorn(1), scheduledTick: 700.5 as never });
    expect(result).toMatchObject({ status: "rejected", reason: { code: "INVALID_QUANTITY", field: "scheduledTick", value: 700.5 } });
  });

  it("queue in (scheduledTick, sequence) order and apply at step 1 of their tick", () => {
    const sim = fakeSimulation();
    sim.dispatch({ command: setWorkforce(ids.barn, 1), scheduledTick: tick(700) });
    sim.dispatch({ command: setWorkforce(ids.barn, 2), scheduledTick: tick(650) });
    sim.dispatch({ command: setWorkforce(ids.barn, 3), scheduledTick: tick(700) });
    expect(sim.state.queuedCommands.map((e) => [e.scheduledTick, e.sequence])).toEqual([
      [650, 4],
      [700, 3],
      [700, 5],
      [1_920, 2],
    ]);
    sim.advance(100); // through tick 700
    const changes = sim.takeEvents().filter((e) => e.type === "WORKFORCE_CHANGED");
    expect(changes.map((e) => [e.tick, e.causedBy])).toEqual([
      [650, "cmd-4"],
      [700, "cmd-3"],
      [700, "cmd-5"],
    ]);
    expect(sim.state.facilities.find((f) => f.id === ids.barn)!.workerCount).toBe(3);
  });

  it("are checked again when they apply; failure emits COMMAND_REJECTED and is logged, but changes nothing else", () => {
    const sim = fakeSimulation();
    expect(sim.dispatch({ command: buyCorn(150), scheduledTick: tick(800) }).status).toBe("queued");
    sim.dispatch({ command: buyCorn(100) }); // leaves 60, so the queued order will fail
    sim.takeEvents();
    sim.advance(200);
    const events = sim.takeEvents();
    expect(events).toEqual([
      {
        id: expect.any(String),
        tick: 800,
        causedBy: "cmd-3",
        type: "COMMAND_REJECTED",
        commandId: "cmd-3",
        commandType: "PURCHASE_MATERIALS",
        reason: { code: "SUPPLIER_STOCK_LOW", materialId: ids.corn, requested: 150, available: 60 },
      },
    ]);
    // It was accepted at dispatch, so it's in the log (T01b), as the original envelope, after cmd-4.
    expect(sim.state.commandLog.map((e) => e.id)).toEqual(["cmd-1", "cmd-4", "cmd-3"]);
    expect(sim.state.commandLog.at(-1)).toEqual({ id: "cmd-3", scheduledTick: 800, sequence: 3, issuer: { kind: "FOUNDER" }, command: buyCorn(150) });
    expect(sim.state.queuedCommands.map((e) => e.id)).not.toContain("cmd-3");
    const cornStock = sim.state.suppliers.flatMap((s) => s.stock).find((st) => st.materialId === ids.corn)!;
    expect(cornStock.available).toBe(60); // only cmd-4's purchase happened
  });

  it("are logged in (scheduledTick, sequence) order, whether they applied or were rejected", () => {
    const sim = fakeSimulation();
    sim.dispatch({ command: setWorkforce(unknownFacility, 1), scheduledTick: tick(700) }); // cmd-3: fails at 700
    sim.dispatch({ command: setWorkforce(ids.barn, 4), scheduledTick: tick(650) }); // cmd-4
    sim.dispatch({ command: buyCorn(1_000), scheduledTick: tick(700) }); // cmd-5: fails at 700
    sim.dispatch({ command: buyCorn(1), scheduledTick: tick(700) }); // cmd-6
    sim.dispatch({ command: setWorkforce(unknownFacility, 1) }); // rejected at dispatch: never logged
    sim.advance(99); // through tick 699: cmd-3, cmd-5, cmd-6 not processed yet
    expect(sim.state.commandLog.map((e) => e.id)).toEqual(["cmd-1", "cmd-4"]);
    sim.advance(1); // tick 700
    const log = sim.state.commandLog;
    expect(log.map((e) => e.id)).toEqual(["cmd-1", "cmd-4", "cmd-3", "cmd-5", "cmd-6"]);
    expect(log.slice(1).map((e) => [e.scheduledTick, e.sequence])).toEqual([
      [650, 4],
      [700, 3],
      [700, 5],
      [700, 6],
    ]);
    const rejected = sim.takeEvents().filter((e) => e.type === "COMMAND_REJECTED");
    expect(rejected.map((e) => e.causedBy)).toEqual(["cmd-3", "cmd-5"]);
  });

  it("run the handler's dispatch-time validation for queued commands", () => {
    const sim = fakeSimulation();
    const result = sim.dispatch({ command: buyCorn(0), scheduledTick: tick(900) });
    expect(result).toMatchObject({ status: "rejected", reason: { code: "INVALID_QUANTITY", field: "quantity", value: 0 } });
  });

  it("from a loaded save keep their place in the queue", () => {
    const sim = fakeSimulation();
    sim.advance(1_920 - 600);
    expect(sim.state.queuedCommands).toEqual([]);
    expect(sim.state.commandLog.map((e) => e.id)).toEqual(["cmd-1", "cmd-2"]);
    expect(sim.takeEvents().find((e) => e.type === "MATERIALS_PURCHASED")).toMatchObject({ tick: 1_920, causedBy: "cmd-2", materialId: ids.sugar });
  });
});

describe("unregistered command types", () => {
  it("are a programming error, thrown before anything changes", () => {
    const sim = fakeSimulation();
    const before = sim.state;
    expect(() => sim.dispatch({ command: { type: "ACCEPT_CONTRACT", contractOfferId: "offer-1" as never } })).toThrow(RegistryError);
    expect(sim.state).toBe(before);
  });
});

describe("replay (ADR 0004)", () => {
  it("an already-applied or already-queued envelope is a no-op", () => {
    const sim = fakeSimulation();
    sim.dispatch({ command: buyCorn(5) });
    const hash = sim.stateHash();
    for (const envelope of [...sim.state.commandLog, ...sim.state.queuedCommands]) {
      expect(sim.replay(envelope)).toEqual({ status: "duplicate", commandId: envelope.id });
    }
    expect(sim.stateHash()).toBe(hash);
    expect(sim.takeEvents()).toHaveLength(1); // only the original purchase
  });

  it("replaying a command log from the same starting state reproduces the run", () => {
    const original = fakeSimulation();
    original.dispatch({ command: setWorkforce(ids.distillery, 6) });
    original.dispatch({ command: buyCorn(10), scheduledTick: tick(900) });
    original.advance(400);
    original.dispatch({ command: setWorkforce(ids.barn, 2) });
    original.dispatch({ command: buyCorn(4), scheduledTick: tick(1_500) });
    original.advance(2_000);

    // Immediate commands were journaled with scheduledTick = the tick they took
    // effect, so replaying every envelope up front queues them for that tick.
    const replayed = fakeSimulation();
    const log = original.state.commandLog;
    expect(log.map((e) => e.id)).toEqual(["cmd-1", "cmd-3", "cmd-4", "cmd-5", "cmd-6", "cmd-2"]);
    const results = log.map((envelope) => replayed.replay(envelope).status);
    expect(results).toEqual(["duplicate", "applied", "queued", "queued", "queued", "duplicate"]);
    replayed.advance(2_400);
    expect(replayed.stateHash()).toBe(original.stateHash());
  });

  it("replaying the command log reproduces the hash even when the run had dispatch-time rejections", () => {
    const original = fakeSimulation();
    original.dispatch({ command: setWorkforce(unknownFacility, 1) }); // rejected
    original.dispatch({ command: setWorkforce(ids.distillery, 6) });
    original.dispatch({ command: buyCorn(0), scheduledTick: tick(900) }); // rejected by validate
    original.dispatch({ command: buyCorn(10), scheduledTick: tick(900) });
    original.dispatch({ command: buyCorn(1), scheduledTick: tick(1) }); // rejected: past
    original.advance(400);
    original.dispatch({ command: buyCorn(10_000) }); // rejected
    original.dispatch({ command: setWorkforce(ids.barn, 2) });
    original.dispatch({ command: setWorkforce(ids.barn, -1), scheduledTick: tick(1_500) }); // rejected by validate
    original.advance(2_000);

    const replayed = fakeSimulation();
    for (const envelope of original.state.commandLog) replayed.replay(envelope);
    replayed.advance(2_400);
    expect(replayed.stateHash()).toBe(original.stateHash());
  });

  it("replaying the command log reproduces the hash and the COMMAND_REJECTED events when the run had apply-time rejections", () => {
    const original = fakeSimulation();
    original.dispatch({ command: buyCorn(150), scheduledTick: tick(800) }); // cmd-3: fails at 800
    original.dispatch({ command: buyCorn(100) }); // cmd-4
    original.dispatch({ command: setWorkforce(unknownFacility, 1), scheduledTick: tick(900) }); // cmd-5: fails at 900
    original.advance(400);
    original.dispatch({ command: setWorkforce(ids.barn, 2) }); // cmd-6
    original.advance(2_000);
    const originalEvents = original.takeEvents();
    expect(originalEvents.filter((e) => e.type === "COMMAND_REJECTED").map((e) => e.causedBy)).toEqual(["cmd-3", "cmd-5"]);
    expect(original.state.commandLog.map((e) => e.id)).toEqual(["cmd-1", "cmd-4", "cmd-3", "cmd-5", "cmd-6", "cmd-2"]);

    const replayed = fakeSimulation();
    const results = original.state.commandLog.map((envelope) => replayed.replay(envelope).status);
    expect(results).toEqual(["duplicate", "applied", "queued", "queued", "queued", "duplicate"]);
    replayed.advance(2_400);
    expect(replayed.stateHash()).toBe(original.stateHash());
    expect(replayed.takeEvents()).toEqual(originalEvents);
  });

  it("an envelope from the log that fails as it applies on the next tick is an apply-time rejection, not a dispatch-time one", () => {
    const original = fakeSimulation();
    original.dispatch({ command: buyCorn(150), scheduledTick: tick(800) }); // cmd-3
    original.dispatch({ command: buyCorn(100) }); // cmd-4, leaves 60
    original.advance(200);
    const failed = original.state.commandLog.find((e) => e.id === "cmd-3")!;
    const rejection = original.takeEvents().find((e) => e.type === "COMMAND_REJECTED");
    if (rejection?.type !== "COMMAND_REJECTED") throw new Error("expected cmd-3 to fail when it applied");

    // Replay the log tick by tick, so cmd-3 is due on the very next tick when it's replayed.
    const replayed = fakeSimulation();
    expect(replayed.replay(original.state.commandLog[1]!).status).toBe("applied"); // cmd-4 at 601
    replayed.advance(800 - 1 - 600);
    replayed.takeEvents();
    const result = replayed.replay(failed);
    expect(result).toEqual({ status: "rejected-on-apply", commandId: "cmd-3", tick: 800, reason: rejection.reason, eventIds: [rejection.id] });
    expect(replayed.takeEvents()).toEqual([rejection]);
    expect(replayed.state.commandLog.at(-1)).toEqual(failed);
    expect(replayed.replay(failed)).toEqual({ status: "duplicate", commandId: "cmd-3" });
    replayed.advance(1);
    expect(replayed.stateHash()).toBe(original.stateHash());
  });

  it("queues a future envelope from the log without re-running dispatch-time validation against the replaying state", () => {
    // A validate that depends on state: only allowed once the barn has workers.
    const strict = (registry: Parameters<NonNullable<Parameters<typeof fakeSimulation>[1]>>[0]) =>
      registry.onCommand("PURCHASE_EQUIPMENT", {
        validate: (state, command) =>
          state.facilities.find((f) => f.id === ids.barn)!.workerCount > 0
            ? null
            : { code: "NO_EQUIPMENT_SLOT", facilityId: command.facilityId, equipmentId: command.equipmentId },
        apply: (state) => ({ status: "applied", state }),
      });
    const buyStill = { type: "PURCHASE_EQUIPMENT", facilityId: ids.distillery, equipmentId: ids.copperStill } as const;

    const original = fakeSimulation(day0State, strict);
    original.dispatch({ command: setWorkforce(ids.barn, 0) }); // cmd-3
    expect(original.dispatch({ command: buyStill, scheduledTick: tick(700) }).status).toBe("rejected");
    original.advance(10);
    original.dispatch({ command: setWorkforce(ids.barn, 1) }); // cmd-4
    expect(original.dispatch({ command: buyStill, scheduledTick: tick(700) }).status).toBe("queued"); // cmd-5
    original.dispatch({ command: setWorkforce(ids.barn, 0) }); // cmd-6
    original.advance(200);
    expect(original.state.commandLog.map((e) => e.id)).toEqual(["cmd-1", "cmd-3", "cmd-4", "cmd-6", "cmd-5"]);

    // Replayed up front, cmd-5 is placed while the barn has no workers. It must still be queued.
    const replayed = fakeSimulation(day0State, strict);
    const results = original.state.commandLog.map((envelope) => replayed.replay(envelope).status);
    expect(results).toEqual(["duplicate", "applied", "queued", "queued", "queued"]);
    replayed.advance(210);
    expect(replayed.stateHash()).toBe(original.stateHash());
  });

  it("moves the counters past replayed identities so new dispatches can't collide", () => {
    const sim = fakeSimulation();
    const foreign: CommandEnvelope = { id: "cmd-40" as never, scheduledTick: tick(5_000), sequence: 40, issuer: { kind: "FOUNDER" }, command: buyCorn(1) };
    expect(sim.replay(foreign)).toEqual({ status: "queued", commandId: "cmd-40", scheduledTick: 5_000 });
    expect(sim.dispatch({ command: buyCorn(1) })).toMatchObject({ commandId: "cmd-41" });
    expect(sim.state.commandLog.at(-1)!.sequence).toBe(41);
  });
});
