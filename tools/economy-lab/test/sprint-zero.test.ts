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
  // fnv1a64:cc8a53a058022ea5 (T02d, issue #8: decision-1 buyer budgets, demand, and wants; decision-2 market baselines D₀/S₀).
  it("has a pinned replay hash", async () => {
    expect((await runSprintZero()).stateHash).toMatchInlineSnapshot(`"fnv1a64:cc8a53a058022ea5"`);
  });
});
