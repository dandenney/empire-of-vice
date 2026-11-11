// The shared time formatters (#142, moved from the Contracts panel's view
// helpers, #128): deadlines and spans from ticks.

import { tick, TICKS_PER_DAY, TICKS_PER_HOUR } from "@eov/contracts";
import { describe, expect, it } from "vitest";
import { formatDayTime, formatSpan } from "../../../../src/ui/format/time-format.ts";

describe("times", () => {
  it("shows a tick as the game day and time of day", () => {
    expect(formatDayTime(tick(0))).toBe("day 0, 00:00");
    expect(formatDayTime(tick(3 * TICKS_PER_DAY + 18 * TICKS_PER_HOUR))).toBe("day 3, 18:00");
    expect(formatDayTime(tick(TICKS_PER_DAY + 9 * TICKS_PER_HOUR + 5))).toBe("day 1, 09:05");
  });

  it("shows a span in days, hours, and minutes", () => {
    expect(formatSpan(2 * TICKS_PER_DAY)).toBe("2 days");
    expect(formatSpan(TICKS_PER_DAY + 6 * TICKS_PER_HOUR)).toBe("1 day 6 h");
    expect(formatSpan(45)).toBe("45 min");
    expect(formatSpan(0)).toBe("0 min");
  });
});
