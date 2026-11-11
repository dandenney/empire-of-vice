// PLACEHOLDER copy (story decision): how the UI writes game times and spans
// (#128, moved here by #142 so ui/ and every panel share one wording).

export const TIME_FORMAT_COPY = {
  /** "day 3, 18:00". */
  dayTime: (day: number, hour: string, minute: string) => `day ${day}, ${hour}:${minute}`,
  /** "2 days", "1 day 6 h", "45 min". */
  span: (days: number, hours: number, minutes: number) =>
    [days > 0 ? `${days} ${days === 1 ? "day" : "days"}` : "", hours > 0 ? `${hours} h` : "", minutes > 0 || (days === 0 && hours === 0) ? `${minutes} min` : ""].filter((p) => p !== "").join(" "),
} as const;
