// The system registry: how systems plug into the kernel without editing it.
//
// - Phase hooks run every tick in SIM-001 order (see PHASES). Hooks in the same
//   phase run in registration order, which is fixed by the composition code, so
//   it's deterministic.
// - Each command type has exactly one handler.
// - Each scheduled world event kind has exactly one handler.
// - One projection builds the world snapshot (S0 provides the real one), and
//   one builds the player snapshot (SK1b, ADR 0021 decision 8).
// - At most one set of knowledge steps (SK1b, ADR 0021 decisions 5 and 8): the
//   tick-end persist (SIM-001 step 6) and the founder's command activity.
//   Registered only with founder rules on.
//
// Every hook and handler is a pure function from state to state. It must not
// mutate its input or read anything but its arguments (no wall clock, no
// Math.random; randomness comes from `state.rng` via the rng module). Events are
// emitted with `emitEvents`/`emitEvent`, which appends them to the journal.

import type {
  ClockSnapshot,
  CommandEnvelope,
  CommandId,
  CommandIssuer,
  GameCommand,
  GameCommandType,
  GameSnapshot,
  GameState,
  PlayerSnapshot,
  RejectionReason,
  Tick,
} from "@eov/contracts";
import type { CalendarDay } from "../clock/calendar.ts";
import type { WorldEventKind, WorldEventOfKind } from "../events/world-events.ts";

/**
 * Per-tick phases after commands, in SIM-001 order:
 *   1. commands (the kernel)
 *   2. production, then
 *      `employees` (ADR 0025 decision 10: each employee's standing-order step,
 *      then report deliveries; right after production, so a still whose batch
 *      finished this tick restarts on the same tick)
 *   3. vehicles (movement and arrivals)
 *   4. due world events (the kernel, via world event handlers), then
 *      `resolution` (contract fulfillment, due payments), then
 *      `founder` (ADR 0023 decision 2a: busy ends, travel legs, delivery stops,
 *      waking; after this tick's arrivals and closures), then
 *      `phones` (ADR 0024 decision 8, ADR 0027 decision 13: message delivery
 *      where the founder is, then calls in on a window tick; after this tick's
 *      arrivals, wakings and call endings), then
 *      `deadlines` (missed-installment penalties). Splitting step 4 this way is
 *      what makes everything due on a tick resolve before that tick's penalties,
 *      so an exact-deadline delivery counts as on time.
 *   5. midnight (only on ticks where isMidnight(tick))
 *   6. emit (the kernel: journal trim and takeEvents)
 *
 * The `founder` phase's hooks are registered only with `founderRules: true`;
 * with the flag off it does nothing (ADR 0023 decision 9). The `phones` phase has
 * no hooks yet (PH1); C1 (#179) registers them, and with the flag off it stays
 * idle (ADR 0024 decision 12). Likewise the `employees` phase has no hooks yet
 * (EM1); E1 (#180) registers them, and with the flag off it stays idle (ADR 0025
 * decision 13).
 */
export const PHASES = ["production", "employees", "vehicles", "resolution", "founder", "phones", "deadlines", "midnight"] as const;
export type Phase = (typeof PHASES)[number];

/** What a hook knows about the tick being processed. `state.tick` is still the previous tick. */
export interface TickContext {
  readonly tick: Tick;
  readonly dayIndex: number;
  readonly isMidnight: boolean;
  readonly clock: ClockSnapshot;
}

export type PhaseHook = (state: GameState, ctx: TickContext) => GameState;

export interface CommandContext extends TickContext {
  /**
   * Who issued the command (ADR 0022 decision 5, ADR 0025 decision 6). Handlers
   * read the issuer here, never from an envelope.
   */
  readonly issuer: CommandIssuer;
  /**
   * The envelope being applied, with its kernel-assigned ID and sequence. null
   * for an employee command issued under a standing order (ADR 0025 decision 6):
   * it has no envelope and no command identity, so its transactions and events
   * have `causedBy: null`. E1 (#180) adds that path (`applyIssued`); until then
   * every command the kernel applies is the founder's, with an envelope.
   */
  readonly envelope: CommandEnvelope | null;
}

/**
 * The ID of the envelope a founder-only command is applied from. Throws for a
 * context without one: only a standing order's employee command (E1) has none,
 * and no standing order authorises these commands (ADR 0025 decision 5).
 */
export function founderCommandId(ctx: CommandContext): CommandId {
  if (ctx.envelope === null) throw new RegistryError(`An employee (${ctx.issuer.kind}) can't issue this command: it needs the founder's envelope`);
  return ctx.envelope.id;
}

export type CommandOutcome =
  | { readonly status: "applied"; readonly state: GameState }
  | { readonly status: "rejected"; readonly reason: RejectionReason };

export type CommandOfType<T extends GameCommandType> = Extract<GameCommand, { type: T }>;

export interface CommandHandler<T extends GameCommandType = GameCommandType> {
  /**
   * Optional checks run at dispatch time for commands queued for a later tick
   * (shape, unknown IDs). Return a reason to reject immediately. The full
   * validation happens in `apply` when the command's tick arrives (ADR 0004).
   */
  readonly validate?: (state: GameState, command: CommandOfType<T>) => RejectionReason | null;
  /**
   * Validates and applies the command against `state`. On rejection the kernel
   * discards everything the handler did, so it never partially applies.
   */
  readonly apply: (state: GameState, command: CommandOfType<T>, ctx: CommandContext) => CommandOutcome;
}

/**
 * A check every command passes before its handler, and a step after it applies
 * (ADR 0023 decision 4: the busy gate and the time a command takes). Gates run in
 * registration order, for queued and eager commands alike.
 */
export interface CommandGate {
  /**
   * A reason rejects the command, unless its own handler rejects it at gate 1
   * (shape and identity: INVALID_QUANTITY, SCHEDULED_IN_PAST, UNKNOWN_ENTITY),
   * which comes first (ADR 0022 decision 1).
   */
  readonly check: (state: GameState, envelope: CommandEnvelope, ctx: CommandContext) => RejectionReason | null;
  /** After the handler applied: `before` is the state it was judged against, `after` its result. */
  readonly after: (before: GameState, after: GameState, envelope: CommandEnvelope, ctx: CommandContext) => GameState;
}

export type WorldEventHandler<K extends WorldEventKind = WorldEventKind> = (
  state: GameState,
  event: WorldEventOfKind<K>,
  ctx: TickContext,
) => GameState;

export interface ProjectionContext {
  readonly clock: ClockSnapshot;
  readonly startDate: CalendarDay;
}

export type Projection = (state: GameState, ctx: ProjectionContext) => GameSnapshot;

/** Builds the player snapshot (ADR 0021 decision 8). Like `Projection`, a pure function of state. */
export type PlayerProjection = (state: GameState, ctx: ProjectionContext) => PlayerSnapshot;

/** What became of one of the founder's commands, for the activity feed (ADR 0021 decision 8). */
export type CommandFate =
  | { readonly status: "APPLIED" }
  | { readonly status: "QUEUED" }
  | { readonly status: "REJECTED"; readonly reason: RejectionReason };

/**
 * The knowledge model's steps the kernel runs (ADR 0021 decisions 5 and 8):
 * - `commandRecorded`: after a command is applied, queued, or rejected when its
 *   tick arrives, in the same unit of work;
 * - `tickEnd`: SIM-001 step 6, after the midnight phase and before the tick
 *   commits: this tick's news and books, then persist the live view.
 *   `state.tick` is still the previous tick.
 */
export interface KnowledgeSteps {
  readonly commandRecorded: (state: GameState, envelope: CommandEnvelope, fate: CommandFate, tick: Tick) => GameState;
  readonly tickEnd: PhaseHook;
}

export class RegistryError extends Error {
  override readonly name = "RegistryError";
}

interface NamedHook {
  readonly name: string;
  readonly hook: PhaseHook;
}

export class SystemRegistry {
  readonly #hooks = new Map<Phase, NamedHook[]>(PHASES.map((phase) => [phase, []]));
  readonly #hookNames = new Set<string>();
  readonly #commands = new Map<GameCommandType, CommandHandler>();
  readonly #gates: { readonly name: string; readonly gate: CommandGate }[] = [];
  readonly #worldEvents = new Map<WorldEventKind, WorldEventHandler>();
  #projection: Projection | null = null;
  #playerProjection: PlayerProjection | null = null;
  #knowledge: KnowledgeSteps | null = null;
  #sealed = false;

  /** Called by createSimulation. Registering systems mid-run would change the rules, so it's an error. */
  seal(): void {
    this.#sealed = true;
  }

  #assertOpen(): void {
    if (this.#sealed) throw new RegistryError("The registry is sealed: register systems before creating the simulation");
  }

  /** Adds a hook to a phase. `name` identifies it in errors and must be unique. */
  onPhase(phase: Phase, name: string, hook: PhaseHook): this {
    this.#assertOpen();
    if (!PHASES.includes(phase)) throw new RegistryError(`Unknown phase ${String(phase)}`);
    if (this.#hookNames.has(name)) throw new RegistryError(`A hook named ${name} is already registered`);
    this.#hookNames.add(name);
    this.#hooks.get(phase)!.push({ name, hook });
    return this;
  }

  onCommand<T extends GameCommandType>(type: T, handler: CommandHandler<T>): this {
    this.#assertOpen();
    if (this.#commands.has(type)) throw new RegistryError(`A handler for ${type} is already registered`);
    this.#commands.set(type, handler as unknown as CommandHandler);
    return this;
  }

  /** Adds a command gate. `name` identifies it in errors and must be unique among hooks and gates. */
  onCommandGate(name: string, gate: CommandGate): this {
    this.#assertOpen();
    if (this.#hookNames.has(name)) throw new RegistryError(`A hook named ${name} is already registered`);
    this.#hookNames.add(name);
    this.#gates.push({ name, gate });
    return this;
  }

  commandGates(): readonly { readonly name: string; readonly gate: CommandGate }[] {
    return this.#gates;
  }

  onWorldEvent<K extends WorldEventKind>(kind: K, handler: WorldEventHandler<K>): this {
    this.#assertOpen();
    if (this.#worldEvents.has(kind)) throw new RegistryError(`A handler for world event ${kind} is already registered`);
    this.#worldEvents.set(kind, handler as unknown as WorldEventHandler);
    return this;
  }

  setProjection(projection: Projection): this {
    this.#assertOpen();
    if (this.#projection) throw new RegistryError("A projection is already registered");
    this.#projection = projection;
    return this;
  }

  setPlayerProjection(projection: PlayerProjection): this {
    this.#assertOpen();
    if (this.#playerProjection) throw new RegistryError("A player projection is already registered");
    this.#playerProjection = projection;
    return this;
  }

  setKnowledge(steps: KnowledgeSteps): this {
    this.#assertOpen();
    if (this.#knowledge) throw new RegistryError("Knowledge steps are already registered");
    this.#knowledge = steps;
    return this;
  }

  hooks(phase: Phase): readonly NamedHook[] {
    return this.#hooks.get(phase)!;
  }

  /** Unregistered command types are a programming error, not a player rejection. */
  commandHandler(type: GameCommandType): CommandHandler {
    const handler = this.#commands.get(type);
    if (!handler) throw new RegistryError(`No handler registered for command ${type}`);
    return handler;
  }

  worldEventHandler(kind: WorldEventKind): WorldEventHandler {
    const handler = this.#worldEvents.get(kind);
    if (!handler) throw new RegistryError(`No handler registered for world event ${kind}`);
    return handler;
  }

  projection(): Projection {
    if (!this.#projection) throw new RegistryError("No snapshot projection registered (S0 provides it)");
    return this.#projection;
  }

  playerProjection(): PlayerProjection {
    if (!this.#playerProjection) throw new RegistryError("No player snapshot projection registered (SK1b provides it)");
    return this.#playerProjection;
  }

  /** The knowledge steps, or null when none are registered (founder rules off). */
  knowledge(): KnowledgeSteps | null {
    return this.#knowledge;
  }
}

export function createRegistry(): SystemRegistry {
  return new SystemRegistry();
}
