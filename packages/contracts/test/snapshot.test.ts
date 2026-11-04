import { describe, expect, expectTypeOf, it } from "vitest";
import { LEDGER_ACCOUNTS, type GameSnapshot, type LedgerAccount } from "../src/index.ts";
import type { IsPlainData } from "./plain-data.ts";


describe("GameSnapshot", () => {
  it("is plain JSON-safe data with no optional fields", () => {
    // Optional fields are disallowed too: snapshots use explicit nulls, so every key is always present.
    expectTypeOf<IsPlainData<GameSnapshot>>().toEqualTypeOf<true>();
  });

  it("the plain-data check rejects what it should", () => {
    expectTypeOf<IsPlainData<{ a: { b: () => void } }>>().toEqualTypeOf<false>();
    expectTypeOf<IsPlainData<{ a?: number }>>().toEqualTypeOf<false>();
    expectTypeOf<IsPlainData<{ a: number | undefined }>>().toEqualTypeOf<false>();
    expectTypeOf<IsPlainData<{ a: readonly bigint[] }>>().toEqualTypeOf<false>();
    expectTypeOf<IsPlainData<{ a: Map<string, number> }>>().toEqualTypeOf<false>();
  });
});

describe("ledger accounts", () => {
  it("classifies every account", () => {
    const types = new Set(Object.values(LEDGER_ACCOUNTS));
    expect([...types].sort()).toEqual(["asset", "equity", "expense", "liability", "revenue"]);
    expectTypeOf<"CASH">().toExtend<LedgerAccount>();
  });
});
