// The system registry: how systems plug into the kernel without editing it.
//
// - Phase hooks run every tick in SIM-001 order (see PHASES). Hooks in the same
//   phase run in registration order, which is fixed by the composition code, so
//   it's deterministic.
// - Each command type has exactly one handler.
// - Each scheduled world event kind has exactly one handler.
// - One projection builds the UI snapshot (S0 provides the real one).
//
// Every hook and handler is a pure function from state to state. It must not
// mutate its input or read anything but its arguments (no wall clock, no
// Math.random; randomness comes from `state.rng` via the rng module). Events are
// emitted with `emitEvents`/`emitEvent`, which appends them to the journal.

import type {
  ClockSnapshot,
  CommandEnvelope,
  GameCommand,
  GameCommandType,
  GameSnapshot,
  GameState,
  RejectionReason,
  Tick,
} from "@eov/contracts";
import type { CalendarDay } from "../clock/calendar.ts";
import type { WorldEventKind, WorldEventOfKind } from "../events/world-events.ts";

/**
 * Per-tick phases after commands, in SIM-001 order:
 *   1. commands (the kernel)
 *   2. production
 *   3. vehicles (movement and arrivals)
 *   4. due world events (the kernel, via world event handlers), then
 *      `resolution` (contract fulfillment, due payments), then
 *      `founder` (ADR 0023 decision 2a: busy ends, travel legs, delivery stops,
 *      waking; after this tick's arrivals and closures), then
 *      `deadlines` (missed-installment penalties). Splitting step 4 this way is
 *      what makes everything due on a tick resolve before that tick's penalties,
 *      so an exact-deadline delivery counts as on time.
 *   5. midnight (only on ticks where isMidnight(tick))
 *   6. emit (the kernel: journal trim and takeEvents)
 *
 * The `founder` phase's hooks are registered only with `founderRules: true`;
 * with the flag off it does nothing (ADR 0023 decision 9).
 */
export const PHASES = ["production", "vehicles", "resolution", "founder", "deadlines", "midnight"] as const;
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
  /** The envelope being applied, with its kernel-assigned ID and sequence. */
  readonly envelope: CommandEnvelope;
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
}

export function createRegistry(): SystemRegistry {
  return new SystemRegistry();
}
