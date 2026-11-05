// PLACEHOLDER copy (story decision): Dashboard panel strings (#48).

export const DASHBOARD_COPY = {
  title: "Dashboard",
  date: "Date",
  day: (dayIndex: number) => `day ${dayIndex}`,
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
