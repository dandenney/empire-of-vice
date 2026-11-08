// PLACEHOLDER copy (story decision): Progression panel strings (#136).
// Tier names, buyer names, thresholds, and the victory targets come from the
// snapshot, never from here (Lakeview's reputation requirement included).
//
// Exception: "Standing" and "Reputation" are the category names approved on
// #99 (routed to this task on #14). Keep them verbatim.

export const PROGRESSION_COPY = {
  title: "Progression",

  // Where the family stands now. Approved on #99: "Standing", "Reputation".
  standing: "Standing",
  reputation: "Reputation",
  netWorth: "Net worth",

  // The next tier's requirements
  nextTitle: (tier: string) => `Next standing: ${tier}`,
  nextTitleNone: "Next standing",
  topTier: "You hold the highest standing.",
  requirementsCaption: "What it takes",
  requirement: "Requirement",
  required: "Needed",
  now: "Now",
  status: "Status",
  met: "Met",
  notMet: "Not yet",
  noRequirement: "—",
  nextUnlocks: (list: string) => `It unlocks: ${list}.`,
  nextUnlocksNone: "It unlocks nothing new.",

  // Victory (GDD §4)
  victoryTitle: "Victory",
  victoryCaption: "All three at once",
  condition: "Condition",
  completedContracts: "Completed contracts",

  // The ladder
  ladderTitle: "Standings",
  tier: "Standing",
  needs: "Needs",
  unlocks: "Unlocks",
  current: "Current",
  reached: "Reached",
  notReached: "Not yet",
  needsNetWorth: (amount: string) => `net worth ${amount}`,
  needsReputation: (reputation: number) => `reputation ${reputation}`,
  needsNothing: "Nothing",
  needsList: (parts: readonly string[]) => parts.join(", "),

  // Unlocks held
  unlockedTitle: "Unlocked",
  noUnlocks: "Nothing unlocked yet.",
  list: (parts: readonly string[]) => parts.join(", "),

  // Buyers gated by reputation (each minimum is read from the snapshot)
  buyersTitle: "Buyers who want a reputation",
  noGatedBuyers: "Every buyer deals with you.",
  buyer: "Buyer",
  minimum: "Minimum",
  willDeal: "Deals",
  willDealYes: "Will deal",
  willDealNo: "Won't deal yet",
} as const;

/**
 * Unlock labels. The snapshot names unlocks by id only (#124 would add display
 * names); an id missing here is shown as the id.
 */
export const UNLOCK_COPY: Readonly<Record<string, string>> = {
  "spot-sales": "Spot sales",
  "capacity-equipment": "Capacity equipment",
  "quality-equipment": "Quality equipment",
  "next-region": "The next region",
};
