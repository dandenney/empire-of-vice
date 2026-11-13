// PLACEHOLDER copy (story decision): the First Hire's placeholder shell and its
// new-game choice (SK2a, #174). SK2b (#234) replaces the shell with the map,
// the place scenes, the ledger and the HUD, and their wording is the human's.

import type { FounderWhereabouts } from "@eov/contracts";

export const FOUNDER_COPY = {
  /** The dock's new-game choice for the First Hire; the top bar's New game starts the First Shipment. */
  newGame: (scenarioName: string) => `New game: ${scenarioName}`,
  placeholder: (scenarioName: string) => `${scenarioName}: the map and scenes are coming in SK2b.`,
  statusLabel: "Founder status",
  time: "Time",
  founder: "Founder",
  cash: "Cash",
  activity: "Activity items",
  fastForward: "Fast-forwarding while the founder sleeps",
  /** Where the founder is and what they're doing; `place` is the location's name. */
  whereabouts: {
    PRESENT: (place: string) => `At ${place}`,
    BUSY: (place: string) => `Busy at ${place}`,
    TRAVELLING: (place: string) => `Travelling to ${place}`,
    ON_DELIVERY: () => "Riding a delivery",
    RESTING: (place: string) => `Asleep at ${place}`,
  } satisfies Readonly<Record<FounderWhereabouts["kind"] | "BUSY", (place: string) => string>>,
} as const;
