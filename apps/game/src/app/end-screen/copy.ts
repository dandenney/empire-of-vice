// PLACEHOLDER copy (story decision): end-screen strings (#136).
//
// Exception: the titles, leads, supports, and calls to action marked
// "Approved on #99" are the user's signed-off wording (#99, routed to this
// task on #14). Keep them verbatim. The loss lead is the alternate line: the
// insolvency rule can fire with cash in hand (ADR 0020 decision 10), so "No
// stock, no cash, and no road back." would mislead.

export const END_SCREEN_COPY = {
  victory: {
    // Approved on #99.
    title: "The Road to Chicago",
    lead: "Chicago doesn't know your name yet. It will.",
    support: "You've built a working trade, earned the trust of your buyers, and proved the Kerrigans can do more than make a good batch. The city is next.",
  },
  loss: {
    // Approved on #99 (the alternate lead).
    title: "The Still Goes Cold",
    lead: "Nothing left to sell. No way to start again.",
    support: "The Kerrigans' first operation is finished. The family story doesn't have to be.",
  },
  // Approved on #99: the calls to action.
  review: "Review the operation",
  startAgain: "Start again",

  // Everything below is PLACEHOLDER copy (story decision).
  /** The outcome's eyebrow, above the title. */
  victoryEyebrow: "Victory",
  lossEyebrow: "Game over",
  /** When it happened, as "day 9, 05:02". */
  when: "When",
  netWorth: "Net worth",
  reputation: "Reputation",
  completedContracts: "Completed contracts",
  cash: "Cash left",
  starting: "Starting…",
  error: (message: string) => `Couldn't start a new game: ${message}`,
} as const;
