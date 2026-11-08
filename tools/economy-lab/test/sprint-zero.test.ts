import { describe, expect, it } from "vitest";
import { formatReport, runSprintZero } from "../src/sprint-zero.ts";

describe("sprint-zero runner", () => {
  it("runs the whole path, books a profit, and resumes to the same hash", async () => {
    const report = await runSprintZero();
    expect(report.steps.map((s) => s.step)).toEqual([
      "Create game",
      "Buy ingredients",
      "Produce one case",
      "Dispatch truck",
      "Deliver and sell",
      "Save and reload",
      "Truck returns",
    ]);
    expect(report.steps.flatMap((s) => s.events)).toEqual([
      "MATERIALS_PURCHASED",
      "MATERIALS_PURCHASED",
      "PRODUCTION_STARTED",
      "RESERVATION_RELEASED",
      "RESERVATION_RELEASED",
      "PRODUCTION_COMPLETED",
      "DELIVERY_DISPATCHED",
      "SALE_COMPLETED",
      "VEHICLE_RETURNED",
    ]);
    const b = report.balanceSheet;
    expect(b.assets).toBe(b.liabilities + b.equity + b.netIncome);
    expect(b.netIncome).toBeGreaterThan(0);
    expect(b.netWorth).toBe(b.equity + b.netIncome);
    expect(report.resumedStateHash).toBe(report.stateHash);
    expect(formatReport(report)).toContain(report.stateHash);
  });

  it("is reproducible", async () => {
    expect((await runSprintZero()).stateHash).toBe((await runSprintZero()).stateHash);
  });

  // The Sprint Zero replay hash, quoted in PRs (factory.md §4). It changes whenever
  // the path's rules or placeholder game-data change; a PR that changes it says why.
  // History: fnv1a64:ac5215124cd58562 (S0a, issue #4); fnv1a64:356d462e35305432
  // (issue #36: RESERVATION_RELEASED CONSUMED events and the VEHICLE_RETURN transaction);
  // fnv1a64:cc8a53a058022ea5 (T02d, issue #8: decision-1 buyer budgets, demand, and wants; decision-2 market baselines D₀/S₀);
  // fnv1a64:50c5ae9cdf05ff0d (T03, issue #10, ADR 0019: decision 1, three risky routes in `state.routes`;
  // decision 4, the sale's `dealDeadline` set at dispatch; decision 2, transport cost paid in VEHICLE_RETURN);
  // fnv1a64:a9f0aac450165e7d (T05b, issue #101, ADR 0020 decision 12: the scenario's rival ROUTE_CLOSURE
  // on county-road is in `state.scheduledEvents` from tick 0, and `nextScheduleSequence` starts at 2);
  // fnv1a64:89394f5b72fb0418 (T05g, issue #106: tuning that state carries from tick 0, namely the
  // markets' S₀ (`supply`) and standard spot price, and Kessler's and Lakeview's budgets and quotes.
  // The path's own numbers, $14.00 revenue and $11.00 cost of goods, don't move).
  it("has a pinned replay hash", async () => {
    expect((await runSprintZero()).stateHash).toMatchInlineSnapshot(`"fnv1a64:89394f5b72fb0418"`);
  });
});
