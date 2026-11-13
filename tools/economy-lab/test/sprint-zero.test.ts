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
      "DEAL_AGREED",
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
  // The path's own numbers, $14.00 revenue and $11.00 cost of goods, don't move);
  // fnv1a64:3169531e5b727cc8 (T07d, issue #126: tuning that state carries from tick 0,
  // namely moonshine's basic and standard base prices, so both markets' spot prices and
  // every buyer's quote, and Kessler's and Lakeview's quote ratios. The path's revenue
  // moves with the basic price; its $11.00 cost of goods doesn't);
  // fnv1a64:a462fc3c3433c143 (T07h, issue #159: the opening building value goes from $800 to $100,
  // so the opening balance transaction; moonshine's basic and standard base prices and both markets'
  // baseline demand rise, so both spot prices and every quote; Lakeview's quote ratio and the
  // roadhouse's daily budget rise. The path itself still costs $11.00 a case);
  // fnv1a64:d3b2228b80705018 (K1, issue #188: state gains `knowledge`, empty in a new game and
  // untouched by any system yet. Hashing the same final state without that field gives
  // a462fc3c3433c143 again, so nothing else moved);
  // fnv1a64:c0347e40711dd8bc (P1, issue #193: state gains `founder`, present at Hollow Creek and
  // never changing with founder rules off; every vehicle gains `parkedAt`; and the new feed-store
  // road, which joins two occupied places, gets a RouteState. Hashing the same final state without
  // those three gives d3b2228b80705018 again, so nothing else moved);
  // fnv1a64:59a882e0fd44576d (O1a, issue #192, ADR 0022 decision 6: the sale is now AGREE_DEAL then a
  // deal dispatch, so the path has one more command envelope, one more entry-free DAILY_SETTLEMENT
  // transaction and one more event (DEAL_AGREED), shifting later command, transaction and event IDs;
  // state gains `heldDeals` (empty again once the deal settles), the `Deal` counter, `tripCount` on
  // the truck (1), `driver` on the delivery, `issuer` on every envelope, and a sale's purpose names
  // its deal. Removing the AGREE_DEAL step and those fields from the final state gives
  // c0347e40711dd8bc again, so nothing else moved: the money is the same);
  // fnv1a64:4c4ec75b6f6f3256 (O1b, issue #197, ADR 0022 decision 7: the $4.00 conversion cost is
  // paid when the job starts. The start transaction is now PRODUCTION_START:job-1 with
  // Dr PRODUCTION_IN_PROGRESS / Cr CASH $4.00 instead of the entry-less RESERVATION:job-1, and the
  // completion credits PRODUCTION_IN_PROGRESS instead of CASH. Rewriting those two transactions
  // back gives 59a882e0fd44576d again, so nothing else moved: same IDs, ticks, events and final cash);
  // fnv1a64:dd5dfccb2e28dad2 (PH1, issue #205, ADR 0024 decision 13 and ADR 0027 decision 15: state
  // gains `arrangements` ([]), each facility `phoneLine` (null), the founder `room` (null) and, while
  // PRESENT, `call` (null), and `knowledge.pendingMessages` ([]). With founder rules off nothing
  // writes any of them. Hashing the same final state without those five fields gives
  // 4c4ec75b6f6f3256 again, so nothing else moved).
  it("has a pinned replay hash", async () => {
    expect((await runSprintZero()).stateHash).toMatchInlineSnapshot(`"fnv1a64:dd5dfccb2e28dad2"`);
  });
});
