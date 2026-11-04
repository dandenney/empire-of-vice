// Scheduled world events (ADR 0008): happenings with no owning entity, kept in
// `state.scheduledEvents` in (tick, sequence) order. Systems schedule them with
// `scheduleWorldEvent`; the kernel takes due ones off the list in SIM-001 step 4
// and passes each to the handler registered for its kind.

import type { GameState, ScheduledWorldEvent } from "@eov/contracts";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A world event as a system schedules it. The kernel assigns `sequence`. */
export type WorldEventInput = DistributiveOmit<ScheduledWorldEvent, "sequence">;

export type WorldEventKind = ScheduledWorldEvent["kind"];

export type WorldEventOfKind<K extends WorldEventKind> = Extract<ScheduledWorldEvent, { kind: K }>;

export function compareWorldEvents(a: ScheduledWorldEvent, b: ScheduledWorldEvent): number {
  return a.tick - b.tick || a.sequence - b.sequence;
}

/**
 * Adds a world event, with a sequence from `counters.nextScheduleSequence` so
 * same-tick events keep a stable order. An event for the tick being processed is
 * still picked up this tick if step 4 hasn't finished.
 */
export function scheduleWorldEvent(state: GameState, input: WorldEventInput): GameState {
  const sequence = state.counters.nextScheduleSequence;
  const event = { ...input, sequence } as ScheduledWorldEvent;
  const scheduledEvents = [...state.scheduledEvents, event].sort(compareWorldEvents);
  return {
    ...state,
    counters: { ...state.counters, nextScheduleSequence: sequence + 1 },
    scheduledEvents,
  };
}
