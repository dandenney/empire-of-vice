// PLACEHOLDER copy (story decision): Activity panel strings (#136).
//
// Exception: the strings marked "Approved on #99" are the user's signed-off
// wording (#99, routed to this task on #14). Keep them verbatim. Names and
// amounts are interpolated from the events, never written here.

export const ACTIVITY_COPY = {
  title: "Activity",
  intro: "Newest first. Reputation and standing carry no money figure.",
  empty: "Nothing has happened yet.",
  caption: "Recent activity",
  when: "When",
  what: "What",
  cash: "Cash",

  // Approved on #99: the activity categories.
  reputationCategory: "Reputation",
  standingCategory: "Standing",
  // Approved on #99: REPUTATION_CHANGED (the decrease uses U+2212, the minus sign).
  reputationUp: (delta: number) => `Word gets around. Reputation +${delta}.`,
  reputationDown: (delta: number) => `Word gets around. Reputation −${delta}.`,
  // Approved on #99: TIER_REACHED.
  tierReached: (tierName: string) => `New standing: ${tierName}.`,
} as const;
