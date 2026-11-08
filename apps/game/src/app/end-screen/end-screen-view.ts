// The end screen's view model (#136): whether the game is over, which way,
// and the figures to show. Keyed off `snapshot.outcome` (sticky once WON or
// LOST, ADR 0020 decision 8) and the VICTORY_ACHIEVED / GAME_LOST event in the
// snapshot's recent events, never the scheduler: after the automatic pause the
// scheduler looks the same as a manual pause (#117).

import type { EventOfType, GameSnapshot, Money, Tick } from "@eov/contracts";

export type EndScreenView =
  | {
      readonly kind: "victory";
      /** Changes only when a new outcome is recorded: a dismissal holds until then. */
      readonly key: string;
      readonly tick: Tick;
      /** From VICTORY_ACHIEVED when it's still in the recent events, else the snapshot's current figures. */
      readonly netWorth: Money;
      readonly reputation: number;
      readonly completedContracts: number;
    }
  | { readonly kind: "loss"; readonly key: string; readonly tick: Tick; readonly cash: Money };

function lastEvent<T extends "VICTORY_ACHIEVED" | "GAME_LOST">(snapshot: GameSnapshot, type: T): EventOfType<T> | null {
  for (let i = snapshot.recentEvents.length - 1; i >= 0; i--) {
    const e = snapshot.recentEvents[i]!;
    if (e.type === type) return e as EventOfType<T>;
  }
  return null;
}

/** The end screen for this snapshot, or null while the game is still being played. */
export function endScreenFor(snapshot: GameSnapshot | null): EndScreenView | null {
  if (!snapshot) return null;
  const { outcome } = snapshot;
  switch (outcome.status) {
    case "PLAYING":
      return null;
    case "WON": {
      const event = lastEvent(snapshot, "VICTORY_ACHIEVED");
      const v = snapshot.progression.victory;
      return {
        kind: "victory",
        key: `WON:${outcome.tick}`,
        tick: outcome.tick,
        netWorth: event?.netWorth ?? v.netWorth.current,
        reputation: event?.reputation ?? v.reputation.current,
        completedContracts: v.completedContracts.current,
      };
    }
    case "LOST":
      return { kind: "loss", key: `LOST:${outcome.tick}`, tick: outcome.tick, cash: snapshot.finance.cash };
  }
}
