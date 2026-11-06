// PLACEHOLDER copy (story decision): Dashboard panel strings (#48).

export const DASHBOARD_COPY = {
  title: "Dashboard",
  date: "Date",
  day: (dayIndex: number) => `day ${dayIndex}`,
  /** "1920-01-17 00:00 (day 0, tick 0)". Separate parts, so each renders as its own text node, as before #58. */
  dateLine: (date: string, day: string, tick: string): readonly string[] => [date, " (", day, ", ", tick, ")"],
  cash: "Cash",
  netWorth: "Net worth",
  netWorthNote: "Assets minus liabilities, right now",
  periodsCaption: "Profit and cash flow are different: buying materials uses cash but isn't an expense until the goods sell.",
  metric: "Figure",
  today: "Today",
  previousDay: "Previous day",
  toDate: "To date",
  revenue: "Revenue",
  netProfit: "Net profit",
  netCashFlow: "Net cash flow",
} as const;
