// Event emission and the bounded journal (ADR 0006).
//
// Emitting an event means appending it to `state.eventJournal` with an ID minted
// from `counters.nextId.Event`. That keeps emission a pure state change, so it
// commits or rolls back together with whatever caused it. The kernel then:
//   - finds the events a step emitted from how far the Event counter moved,
//   - hands them to `takeEvents()`, and
//   - trims the journal to EVENT_JOURNAL_CAPACITY.
// Anything that emits events (the kernel, the coordinator in T02b) goes through
// `emitEvents`, so every minted event ID lands in the journal exactly once.

import {
  EVENT_JOURNAL_CAPACITY,
  type CommandId,
  type EventId,
  type GameEvent,
  type GameEventInput,
  type GameState,
  type Tick,
} from "@eov/contracts";
import { allocateId, formatId } from "../kernel/ids.ts";

export interface EmitMeta {
  readonly tick: Tick;
  readonly causedBy: CommandId | null;
}

/** Stamps events with IDs, tick, and cause, and appends them to the journal. */
export function emitEvents(
  state: GameState,
  inputs: readonly GameEventInput[],
  meta: EmitMeta,
): { readonly state: GameState; readonly eventIds: readonly EventId[] } {
  if (inputs.length === 0) return { state, eventIds: [] };
  let next = state;
  const events: GameEvent[] = [];
  for (const input of inputs) {
    const minted = allocateId(next, "Event");
    next = minted.state;
    events.push({ ...input, id: minted.id, tick: meta.tick, causedBy: meta.causedBy } as GameEvent);
  }
  return {
    state: { ...next, eventJournal: [...next.eventJournal, ...events] },
    eventIds: events.map((e) => e.id),
  };
}

export function emitEvent(
  state: GameState,
  input: GameEventInput,
  meta: EmitMeta,
): { readonly state: GameState; readonly eventId: EventId } {
  const result = emitEvents(state, [input], meta);
  return { state: result.state, eventId: result.eventIds[0]! };
}

/** Keeps the most recent EVENT_JOURNAL_CAPACITY events, dropping the oldest. */
export function trimJournal(state: GameState, capacity: number = EVENT_JOURNAL_CAPACITY): GameState {
  if (state.eventJournal.length <= capacity) return state;
  return { ...state, eventJournal: state.eventJournal.slice(state.eventJournal.length - capacity) };
}

export class EventEmissionError extends Error {
  override readonly name = "EventEmissionError";
}

/**
 * The events emitted between `before` and `after`: the last (Δ Event counter)
 * entries of the untrimmed journal. Throws if they aren't exactly the IDs the
 * counter handed out, which means something minted event IDs or edited the
 * journal without going through `emitEvents`.
 */
export function eventsEmittedBetween(before: GameState, after: GameState): readonly GameEvent[] {
  const from = before.counters.nextId.Event;
  const to = after.counters.nextId.Event;
  const count = to - from;
  if (count === 0) {
    if (after.eventJournal.length !== before.eventJournal.length) {
      throw new EventEmissionError("The event journal changed without minting event IDs; use emitEvents");
    }
    return [];
  }
  if (count < 0 || after.eventJournal.length !== before.eventJournal.length + count) {
    throw new EventEmissionError(
      `Expected ${count} new journal entries, found ${after.eventJournal.length - before.eventJournal.length}; use emitEvents`,
    );
  }
  const emitted = after.eventJournal.slice(after.eventJournal.length - count);
  emitted.forEach((event, i) => {
    const expected = formatId("Event", from + i);
    if (event.id !== expected) {
      throw new EventEmissionError(`Journal entry ${event.id} where ${expected} was expected; use emitEvents`);
    }
  });
  return emitted;
}
