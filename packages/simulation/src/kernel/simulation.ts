// The deterministic simulation kernel (SIM-001, architecture §4, ADRs 0004/0006/0008).
//
// The kernel owns the state reference and nothing else that matters: every fact
// needed to continue lives in GameState, so serialize → create → continue is
// exactly an uninterrupted run. Work happens in units (one dispatch, one tick)
// that are computed on a local copy and committed at the end. If anything throws
// partway, the simulation's state is unchanged.

import {
  dayIndex,
  isMidnight,
  SAVE_FORMAT,
  SAVE_SCHEMA_VERSION,
  tick,
  type CommandEnvelope,
  type CommandRequest,
  type CommandResult,
  type EventId,
  type GameEvent,
  type GameSnapshot,
  type GameState,
  type PlayerSnapshot,
  type RejectionReason,
  type SaveGame,
  type Simulation,
  type Tick,
} from "@eov/contracts";
import { assertValidCalendarDay, clockAt, type CalendarDay } from "../clock/calendar.ts";
import { assignCommandIdentity, enqueue, shiftDue } from "../commands/queue.ts";
import { emitEvent, eventsEmittedBetween, trimJournal } from "../events/journal.ts";
import { compareWorldEvents } from "../events/world-events.ts";
import { hashState } from "./hash.ts";
import { formatId, idNumber } from "./ids.ts";
import {
  type CommandContext,
  type CommandFate,
  type CommandHandler,
  type Phase,
  type SystemRegistry,
  type TickContext,
} from "./registry.ts";

export interface SimulationOptions {
  /** The systems to run. Sealed on creation. */
  readonly registry: SystemRegistry;
  /** The scenario's start date: tick 0 is 00:00 on this day (from the scenario definition). */
  readonly startDate: CalendarDay;
  /** The game-data version in use, recorded in saves (ADR 0009). */
  readonly gameDataVersion: string;
}

/**
 * `replay` result: a CommandResult; a no-op because the envelope is already in
 * the log or the queue; or `rejected-on-apply`, when an envelope due on the next
 * tick fails as it applies. That last case is an apply-time rejection, as in the
 * original run: the envelope is logged and a COMMAND_REJECTED event (listed in
 * `eventIds`) carries the reason. Unlike a `rejected` result, state did change.
 */
export type ReplayResult =
  | CommandResult
  | { readonly status: "duplicate"; readonly commandId: CommandEnvelope["id"] }
  | {
      readonly status: "rejected-on-apply";
      readonly commandId: CommandEnvelope["id"];
      readonly tick: Tick;
      readonly reason: RejectionReason;
      readonly eventIds: readonly EventId[];
    };

export class KernelError extends Error {
  override readonly name = "KernelError";
}

type Limit = Pick<CommandEnvelope, "scheduledTick" | "sequence">;

/** Gate 1's reasons (ADR 0022 decision 1): a command's own rejection for these wins over any command gate. */
const SHAPE_AND_IDENTITY: ReadonlySet<RejectionReason["code"]> = new Set(["INVALID_QUANTITY", "SCHEDULED_IN_PAST", "UNKNOWN_ENTITY"]);

export class KernelSimulation implements Simulation {
  #state: GameState;
  #outbox: GameEvent[] = [];
  readonly #registry: SystemRegistry;
  readonly #startDate: CalendarDay;
  readonly #gameDataVersion: string;

  constructor(state: GameState, options: SimulationOptions) {
    assertValidCalendarDay(options.startDate);
    tick(state.tick);
    options.registry.seal();
    this.#registry = options.registry;
    this.#startDate = { year: options.startDate.year, month: options.startDate.month, day: options.startDate.day };
    this.#gameDataVersion = options.gameDataVersion;
    this.#state = trimJournal(state);
  }

  get state(): GameState {
    return this.#state;
  }

  get startDate(): CalendarDay {
    return this.#startDate;
  }

  // -------------------------------------------------------------------------
  // Commands (ADR 0004)
  // -------------------------------------------------------------------------

  dispatch(request: CommandRequest): CommandResult {
    const handler = this.#registry.commandHandler(request.command.type);
    const before = this.#state;
    const identity = assignCommandIdentity(before);
    const target = request.scheduledTick ?? before.tick + 1;
    const envelope = {
      id: identity.id,
      scheduledTick: target as Tick,
      sequence: identity.sequence,
      // Player commands are the founder's (ADR 0022 decision 5); employees issue theirs from ADR 0025's policy step.
      issuer: { kind: "FOUNDER" } as const,
      command: request.command,
    };
    // "dispatch" mode never returns `duplicate` or `rejected-on-apply`.
    return this.#place(before, identity.state, envelope, handler, "dispatch") as CommandResult;
  }

  /**
   * Re-submits an envelope from a command log (ADR 0004 replay). An envelope
   * whose sequence or ID is already in the log or the queue is a no-op.
   * Otherwise it's placed with its original identity, and the counters move past
   * it so later dispatches can't collide.
   *
   * Every logged envelope was accepted at dispatch (ADR 0004 amendment, T01b), so
   * replay doesn't judge it again at placement time:
   * - a future envelope is queued without the handler's dispatch-time `validate`,
   *   which would otherwise run against the replaying state instead of the state
   *   the original dispatch saw;
   * - an envelope due on the next tick applies now, and if it fails that's an
   *   apply-time rejection (`rejected-on-apply`), logged with a COMMAND_REJECTED
   *   event, exactly as when the original run reached its tick.
   * Whether it applies or fails is derived again, deterministically, by the same
   * handlers. Only a tick that's already past is still rejected outright.
   */
  replay(envelope: CommandEnvelope): ReplayResult {
    const before = this.#state;
    const seen = (e: CommandEnvelope): boolean => e.sequence === envelope.sequence || e.id === envelope.id;
    if (before.commandLog.some(seen) || before.queuedCommands.some(seen)) {
      return { status: "duplicate", commandId: envelope.id };
    }
    const handler = this.#registry.commandHandler(envelope.command.type);
    const idN = idNumber("Command", envelope.id);
    if (idN === null) throw new KernelError(`Not a kernel-assigned command ID: ${envelope.id}`);
    const counters = before.counters;
    const advanced: GameState = {
      ...before,
      counters: {
        ...counters,
        nextCommandSequence: Math.max(counters.nextCommandSequence, envelope.sequence + 1),
        nextId: { ...counters.nextId, Command: Math.max(counters.nextId.Command, idN + 1) },
      },
    };
    return this.#place(before, advanced, envelope, handler, "replay");
  }

  /**
   * Applies now, queues, or rejects an envelope. `s` is `before` with the
   * envelope's identity reserved in the counters; it's only committed if the
   * command is accepted.
   *
   * A rejection commits nothing: no counter moves, no event is emitted, and
   * `stateHash()` is unchanged ("Nothing changed", CommandResult). The rejected
   * result's `commandId` is therefore PROVISIONAL: it's the ID the next accepted
   * command will get, computed from the counters without writing them. The UI
   * uses it only to match a response to its request; it never identifies a
   * journaled command, and consecutive rejections return the same ID.
   *
   * In "replay" mode the envelope was already accepted once; see `replay` for
   * how handler rejections are treated then. Only "replay" mode can return
   * `rejected-on-apply`.
   */
  #place(
    before: GameState,
    s: GameState,
    envelope: CommandEnvelope,
    handler: CommandHandler,
    mode: "dispatch" | "replay",
  ): ReplayResult {
    const current = before.tick;
    const target: number = envelope.scheduledTick;
    const reject = (reason: RejectionReason): CommandResult => ({ status: "rejected", commandId: envelope.id, reason });

    if (!Number.isSafeInteger(target)) {
      return reject({ code: "INVALID_QUANTITY", field: "scheduledTick", value: target });
    }
    if (target <= current) {
      return reject({ code: "SCHEDULED_IN_PAST", scheduledTick: target as Tick, currentTick: before.tick });
    }

    if (target > current + 1) {
      const reason = mode === "dispatch" ? (handler.validate?.(s, envelope.command as never) ?? null) : null;
      if (reason) return reject(reason);
      this.#commit(before, this.#recordCommand(enqueue(s, envelope), envelope, { status: "QUEUED" }, tick(current + 1)));
      return { status: "queued", commandId: envelope.id, scheduledTick: envelope.scheduledTick };
    }

    // Eager apply: the command takes effect as the first thing of the next tick.
    // Nothing happens between now and then, so applying it now is equivalent, as
    // long as queued commands ordered before it on that tick go first.
    const ctx = this.#tickContext(tick(target));
    const drained = this.#applyDue(s, envelope, ctx);
    const applied = this.#applyEnvelope(drained, envelope, ctx);
    // On rejection the drained commands are discarded too. They're still queued,
    // so they apply at step 1 of the same tick (or before the next eager command)
    // with the same IDs and the same result.
    if (applied.status === "rejected") {
      if (mode === "dispatch") return reject(applied.reason);
      const logged = this.#logRejection(drained, envelope, applied.reason, ctx);
      this.#commit(before, logged.state);
      return { status: "rejected-on-apply", commandId: envelope.id, tick: ctx.tick, reason: applied.reason, eventIds: [logged.eventId] };
    }
    this.#commit(before, applied.state);
    return { status: "applied", commandId: envelope.id, tick: ctx.tick, eventIds: applied.eventIds };
  }

  /**
   * Applies queued envelopes ordered before `limit`. Every one ends up in the
   * command log; failures as apply-time rejections (`#logRejection`).
   */
  #applyDue(state: GameState, limit: Limit, ctx: TickContext): GameState {
    let s = state;
    for (let due = shiftDue(s, limit); due; due = shiftDue(s, limit)) {
      const result = this.#applyEnvelope(due.state, due.envelope, ctx);
      s = result.status === "applied" ? result.state : this.#logRejection(result.state, due.envelope, result.reason, ctx).state;
    }
    return s;
  }

  /**
   * An apply-time rejection of a command that was accepted at dispatch: a
   * COMMAND_REJECTED event carries the reason, and the envelope goes into the
   * command log anyway. It used up an ID and a sequence when it was accepted, so
   * a replay needs it to reproduce the run (ADR 0004 amendment, T01b). The
   * outcome isn't stored; replay derives it again.
   */
  #logRejection(
    state: GameState,
    envelope: CommandEnvelope,
    reason: RejectionReason,
    ctx: TickContext,
  ): { readonly state: GameState; readonly eventId: EventId } {
    const emitted = emitEvent(
      state,
      { type: "COMMAND_REJECTED", commandId: envelope.id, commandType: envelope.command.type, reason },
      { tick: ctx.tick, causedBy: envelope.id },
    );
    const recorded = this.#recordCommand(emitted.state, envelope, { status: "REJECTED", reason }, ctx.tick);
    return { state: { ...recorded, commandLog: [...recorded.commandLog, envelope] }, eventId: emitted.eventId };
  }

  /** The knowledge model's record of a founder command's fate (ADR 0021 decision 8); unchanged without knowledge steps. */
  #recordCommand(state: GameState, envelope: CommandEnvelope, fate: CommandFate, at: Tick): GameState {
    const knowledge = this.#registry.knowledge();
    if (!knowledge) return state;
    const next = knowledge.commandRecorded(state, envelope, fate, at);
    this.#assertKernelFieldsUntouched(state, next, "knowledge step commandRecorded");
    return next;
  }

  /**
   * Runs one command's handler. Applied: the handler's state plus the envelope in
   * the command log. Rejected: `state` untouched, so nothing partially applies.
   */
  #applyEnvelope(
    state: GameState,
    envelope: CommandEnvelope,
    ctx: TickContext,
  ):
    | { readonly status: "applied"; readonly state: GameState; readonly eventIds: readonly EventId[] }
    | { readonly status: "rejected"; readonly state: GameState; readonly reason: RejectionReason } {
    const handler = this.#registry.commandHandler(envelope.command.type);
    const commandCtx: CommandContext = { ...ctx, envelope };
    const gates = this.#registry.commandGates();
    for (const { gate } of gates) {
      const reason = gate.check(state, envelope, commandCtx);
      if (reason === null) continue;
      // Gate 1 (shape and identity) comes before any gate (ADR 0022 decision 1).
      const own = handler.apply(state, envelope.command as never, commandCtx);
      const first = own.status === "rejected" && SHAPE_AND_IDENTITY.has(own.reason.code) ? own.reason : reason;
      return { status: "rejected", state, reason: first };
    }
    const outcome = handler.apply(state, envelope.command as never, commandCtx);
    if (outcome.status === "rejected") return { status: "rejected", state, reason: outcome.reason };
    this.#assertKernelFieldsUntouched(state, outcome.state, `command ${envelope.command.type}`);
    let after = outcome.state;
    for (const { name, gate } of gates) {
      const next = gate.after(state, after, envelope, commandCtx);
      this.#assertKernelFieldsUntouched(after, next, `command gate ${name}`);
      after = next;
    }
    after = this.#recordCommand(after, envelope, { status: "APPLIED" }, ctx.tick);
    const eventIds: EventId[] = [];
    for (let n = state.counters.nextId.Event; n < after.counters.nextId.Event; n++) {
      eventIds.push(formatId("Event", n));
    }
    return {
      status: "applied",
      state: { ...after, commandLog: [...after.commandLog, envelope] },
      eventIds,
    };
  }

  // -------------------------------------------------------------------------
  // Ticks (SIM-001)
  // -------------------------------------------------------------------------

  advance(ticks: number): void {
    if (!Number.isSafeInteger(ticks) || ticks < 0) {
      throw new RangeError(`advance() takes a non-negative whole number of ticks, got ${ticks}`);
    }
    for (let i = 0; i < ticks; i++) this.#processTick();
  }

  #processTick(): void {
    const before = this.#state;
    const ctx = this.#tickContext(tick(before.tick + 1));
    // 1. Due commands, in (scheduledTick, sequence) order.
    let s = this.#applyDue(before, { scheduledTick: ctx.tick, sequence: Number.POSITIVE_INFINITY }, ctx);
    // 2–3. Production, then vehicles and arrivals.
    s = this.#runPhase("production", s, ctx);
    s = this.#runPhase("vehicles", s, ctx);
    // 4. World events due now, then fulfillment and payments, then the
    //    founder's transitions (ADR 0023 decision 2a), then penalties.
    s = this.#resolveWorldEvents(s, ctx);
    s = this.#runPhase("resolution", s, ctx);
    s = this.#runPhase("founder", s, ctx);
    s = this.#runPhase("deadlines", s, ctx);
    // 5. Midnight settlement.
    if (ctx.isMidnight) s = this.#runPhase("midnight", s, ctx);
    // 6. Persist the live view (ADR 0021 decision 5), then emit: the tick is complete.
    const knowledge = this.#registry.knowledge();
    if (knowledge) {
      const next = knowledge.tickEnd(s, ctx);
      this.#assertKernelFieldsUntouched(s, next, "knowledge step tickEnd");
      s = next;
    }
    this.#commit(before, { ...s, tick: ctx.tick });
  }

  #runPhase(phase: Phase, state: GameState, ctx: TickContext): GameState {
    let s = state;
    for (const { name, hook } of this.#registry.hooks(phase)) {
      const next = hook(s, ctx);
      this.#assertKernelFieldsUntouched(s, next, `${phase} hook ${name}`);
      s = next;
    }
    return s;
  }

  /** Takes due world events off the schedule one at a time, so a handler can schedule follow-ups. */
  #resolveWorldEvents(state: GameState, ctx: TickContext): GameState {
    let s = state;
    for (let first = s.scheduledEvents[0]; first && first.tick <= ctx.tick; first = s.scheduledEvents[0]) {
      const handler = this.#registry.worldEventHandler(first.kind);
      const without: GameState = { ...s, scheduledEvents: s.scheduledEvents.slice(1) };
      const next = handler(without, first as never, ctx);
      this.#assertKernelFieldsUntouched(without, next, `world event handler ${first.kind}`);
      const sorted = next.scheduledEvents.every((e, i, all) => i === 0 || compareWorldEvents(all[i - 1]!, e) <= 0);
      if (!sorted) throw new KernelError(`World event handler ${first.kind} left scheduledEvents unsorted`);
      s = next;
    }
    return s;
  }

  #tickContext(t: Tick): TickContext {
    return { tick: t, dayIndex: dayIndex(t), isMidnight: isMidnight(t), clock: clockAt(this.#startDate, t) };
  }

  /** Systems may change any domain state, but the clock and command bookkeeping are the kernel's. */
  #assertKernelFieldsUntouched(before: GameState, after: GameState, who: string): void {
    if (after.tick !== before.tick) throw new KernelError(`${who} changed state.tick`);
    if (after.commandLog !== before.commandLog) throw new KernelError(`${who} changed state.commandLog`);
    if (after.queuedCommands !== before.queuedCommands) throw new KernelError(`${who} changed state.queuedCommands`);
    if (after.seed !== before.seed) throw new KernelError(`${who} changed state.seed`);
  }

  /** Ends a unit of work: publishes the events it emitted and trims the journal. */
  #commit(before: GameState, after: GameState): void {
    const emitted = eventsEmittedBetween(before, after);
    this.#state = trimJournal(after);
    for (const event of emitted) this.#outbox.push(event);
  }

  // -------------------------------------------------------------------------
  // Output
  // -------------------------------------------------------------------------

  takeEvents(): readonly GameEvent[] {
    const events = this.#outbox;
    this.#outbox = [];
    return events;
  }

  snapshot(): GameSnapshot {
    const projection = this.#registry.projection();
    return projection(this.#state, { clock: clockAt(this.#startDate, this.#state.tick), startDate: this.#startDate });
  }

  /**
   * The player snapshot (ADR 0021 decision 8): built only from knowledge, the
   * always-known state and the live view, which is read from the world now.
   * Building it changes no state.
   */
  playerSnapshot(): PlayerSnapshot {
    const projection = this.#registry.playerProjection();
    return projection(this.#state, { clock: clockAt(this.#startDate, this.#state.tick), startDate: this.#startDate });
  }

  serialize(): SaveGame {
    return {
      format: SAVE_FORMAT,
      schemaVersion: SAVE_SCHEMA_VERSION,
      scenarioId: this.#state.scenarioId,
      gameDataVersion: this.#gameDataVersion,
      state: this.#state,
    };
  }

  stateHash(): string {
    return hashState(this.#state);
  }
}

/** Creates a simulation that continues from `state` (a new game's, or a loaded save's). */
export function createSimulation(state: GameState, options: SimulationOptions): KernelSimulation {
  return new KernelSimulation(state, options);
}

/** Creates a simulation from a save. Validating and migrating the save is persistence's job (T06). */
export function loadSimulation(save: SaveGame, options: SimulationOptions): KernelSimulation {
  if (save.format !== SAVE_FORMAT || save.schemaVersion !== SAVE_SCHEMA_VERSION) {
    throw new KernelError(`Unsupported save ${String(save.format)} v${String(save.schemaVersion)}`);
  }
  return new KernelSimulation(save.state, options);
}
