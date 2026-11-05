// compareIds: the shared ID order for state and snapshot lists (issue #34, ADR 0007/0008 amendments).

import { describe, expect, it } from "vitest";
import { compareById, compareIds, DYNAMIC_ID_KINDS, DYNAMIC_ID_PREFIXES, isValidId } from "../src/index.ts";

const sign = (n: number) => (n < 0 ? -1 : n > 0 ? 1 : 0);
const sorted = (ids: readonly string[]) => [...ids].sort(compareIds);

describe("compareIds", () => {
  it("puts job-9 before job-10", () => {
    expect(compareIds("job-9", "job-10")).toBeLessThan(0);
    expect(compareIds("job-10", "job-9")).toBeGreaterThan(0);
    expect(sorted(["job-10", "job-9", "job-1", "job-100", "job-2"])).toEqual(["job-1", "job-2", "job-9", "job-10", "job-100"]);
  });

  it("sorts simulation-created IDs by prefix, then numerically", () => {
    expect(sorted(["txn-2", "res-10", "evt-3", "res-9", "cmd-11", "evt-20", "delivery-10", "cmd-2", "delivery-9"])).toEqual([
      "cmd-2",
      "cmd-11",
      "delivery-9",
      "delivery-10",
      "evt-3",
      "evt-20",
      "res-9",
      "res-10",
      "txn-2",
    ]);
  });

  it("compares suffixes of any length without overflow", () => {
    const huge = `job-${"9".repeat(40)}`;
    const huger = `job-1${"0".repeat(40)}`;
    expect(isValidId(huger)).toBe(true);
    expect(compareIds(huge, huger)).toBeLessThan(0);
    expect(compareIds("job-9007199254740993", "job-9007199254740992")).toBeGreaterThan(0);
  });

  it("sorts fixed-data IDs as text, even when they contain digits", () => {
    const fixed = ["route-10", "route-2", "distillery-main", "crossroads-roadhouse", "a1-b10", "a1-b9", "barn"];
    expect(sorted(fixed)).toEqual([...fixed].sort());
    expect(compareIds("route-10", "route-2")).toBeLessThan(0);
    // A dynamic prefix with a non-canonical suffix isn't simulation-created: text order.
    expect(compareIds("job-010", "job-09")).toBeLessThan(0);
    expect(compareIds("job-9a", "job-10a")).toBeGreaterThan(0);
  });

  it("returns 0 only for identical IDs", () => {
    expect(compareIds("job-7", "job-7")).toBe(0);
    expect(compareIds("barn", "barn")).toBe(0);
    expect(compareIds("job-7", "job-07")).not.toBe(0);
  });

  it("is a total order: antisymmetric and transitive over a mixed sample", () => {
    const sample = [
      "job", "job-0", "job-1", "job-9", "job-10", "job-09", "job-9a", "job-1a", "job-a", "jobber", "jo",
      "res-1", "res-2", "res-10", "res-x", "cmd-1", "cmd-12", "delivery-3", "delivery-van", "contract-1",
      "offer-2", "evt-31", "txn-14", "barn", "distillery-main", "a", "z9", "route-2", "route-10",
    ];
    for (const a of sample) {
      expect(compareIds(a, a)).toBe(0);
      for (const b of sample) {
        expect(sign(compareIds(a, b)) + sign(compareIds(b, a))).toBe(0);
        if (a !== b) expect(compareIds(a, b)).not.toBe(0);
        for (const c of sample) {
          if (compareIds(a, b) < 0 && compareIds(b, c) < 0) expect(compareIds(a, c)).toBeLessThan(0);
        }
      }
    }
  });

  it("is stable: the result doesn't depend on the input order", () => {
    const ids = ["job-10", "barn", "res-2", "job-9", "job-a", "res-10", "jobber", "job"];
    const expected = sorted(ids);
    expect(sorted([...ids].reverse())).toEqual(expected);
    expect(sorted([...ids.slice(3), ...ids.slice(0, 3)])).toEqual(expected);
    expect(expected).toEqual(["barn", "job", "job-9", "job-10", "job-a", "jobber", "res-2", "res-10"]);
  });

  it("matches creation order for every dynamic kind", () => {
    for (const kind of DYNAMIC_ID_KINDS) {
      const prefix = DYNAMIC_ID_PREFIXES[kind];
      const created = Array.from({ length: 120 }, (_, i) => `${prefix}-${i + 1}`);
      expect(sorted([...created].reverse())).toEqual(created);
    }
  });

  it("compareById orders records by id", () => {
    const records = [{ id: "job-10" }, { id: "job-9" }, { id: "job-1" }];
    expect([...records].sort(compareById).map((r) => r.id)).toEqual(["job-1", "job-9", "job-10"]);
  });
});
