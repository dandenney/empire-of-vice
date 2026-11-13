// PLACEHOLDER copy (story decision): the First Hire's founder-rules layout
// (SK2a #174, SK2b #234): the new-game choice and the map's travel card. The
// HUD, scenes and ledger have their own copy files. The wording is the human's.

export const FOUNDER_COPY = {
  /** The dock's new-game choice for the First Hire; the top bar's New game starts the First Shipment. */
  newGame: (scenarioName: string) => `New game: ${scenarioName}`,
  placeholderArt: "Placeholder map",
  travel: {
    hint: "Pick a place to go there.",
    title: (place: string) => `Go to ${place}`,
    goIn: (place: string) => `Go into ${place}`,
    walk: "Walk there",
    drive: (truck: string) => `Drive the ${truck}`,
    cancel: "Not now",
    busy: "You're busy. Finish first.",
    travelling: "You're already on the road.",
    riding: "You're riding with the truck.",
    resting: "You're asleep.",
  },
} as const;
