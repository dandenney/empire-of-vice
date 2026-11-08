// PLACEHOLDER copy (story decision): the dispatch route picker (#50).
// "Safe", "Risky" and "disruption chance" are the approved wording from #77,
// used verbatim. Risk is never worded as the odds of losing the cargo: a
// disruption can mean a delay or a seizure (#77). Route names and descriptions
// come from the snapshot and game-data, not from here.

export const ROUTE_PICKER_COPY = {
  legend: "Route",
  // Approved on #77.
  safe: "Safe",
  // Approved on #77.
  risky: "Risky",
  closed: "Closed",
  /** Approved on #77: "15% disruption chance". */
  disruption: (percent: string) => `${percent}% disruption chance`,
  travelTime: "Travel time",
  transportCost: "Transport cost",
  risk: "Risk",
  /** "2 h 30 min", "2 h", "40 min". */
  duration: (hours: number, minutes: number) => (hours === 0 ? `${minutes} min` : minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`),
  closedReason: {
    RIVAL: "Closed by a rival crew.",
    POLICE: "Closed by the police.",
  },
  /** "Reopens in 2 h (day 3, 18:00)." The day and time match the contract deadlines (#132). */
  reopensIn: (duration: string, at: string) => `Reopens in ${duration} (${at}).`,
  reopensUnknown: "No word on when it reopens.",
  noRoutes: "No road goes there from this truck's yard.",
  noOpenRoute: "Every road there is closed.",
} as const;
