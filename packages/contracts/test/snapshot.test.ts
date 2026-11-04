import { describe, expect, expectTypeOf, it } from "vitest";
import { LEDGER_ACCOUNTS, type GameSnapshot, type LedgerAccount } from "../src/index.ts";

/**
 * True only if T is plain data that survives JSON and structured clone unchanged:
 * no functions, bigint, symbols, undefined, Maps, Sets, or Dates.
 */
type IsPlainData<T> = T extends string | number | boolean | null
  ? true
  : T extends bigint | symbol | undefined | ((...args: never[]) => unknown) | Date | Map<unknown, unknown> | Set<unknown>
    ? false
    : T extends readonly (infer E)[]
      ? IsPlainData<E>
      : T extends object
        ? false extends { [K in keyof T]-?: undefined extends T[K] ? false : IsPlainData<T[K]> }[keyof T]
          ? false
          : true
        : false;

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
