import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalJson, CanonicalJsonError, fnv1a64Hex, hashState } from "../../src/index.ts";
import { day0State } from "./fakes.ts";

/** BigInt reference FNV-1a 64 over UTF-8 bytes. */
function referenceFnv(text: string): string {
  let h = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) {
    h ^= BigInt(byte);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

describe("FNV-1a 64", () => {
  it("matches published test vectors", () => {
    expect(fnv1a64Hex("")).toBe("cbf29ce484222325");
    expect(fnv1a64Hex("a")).toBe("af63dc4c8601ec8c");
    expect(fnv1a64Hex("foobar")).toBe("85944171f73967e8");
  });

  it("matches a BigInt reference over UTF-8 for any string", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 200 }), (text) => {
        expect(fnv1a64Hex(text)).toBe(referenceFnv(text));
      }),
      { seed: 1920 },
    );
  });
});

describe("canonical JSON", () => {
  it("sorts keys at every level and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: null } })).toBe('{"a":{"c":null,"d":[3,1]},"b":1}');
  });

  it("doesn't depend on key insertion order", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (record) => {
        const reversed = Object.fromEntries(Object.entries(record).reverse());
        expect(canonicalJson(reversed)).toBe(canonicalJson(record));
      }),
      { seed: 1920 },
    );
  });

  it("parses back to the same value", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(JSON.parse(canonicalJson(value))).toEqual(JSON.parse(JSON.stringify(value)));
      }),
      { seed: 1920 },
    );
  });

  it("writes -0 as 0 and rejects what GameState can't contain", () => {
    expect(canonicalJson(-0)).toBe("0");
    expect(() => canonicalJson({ a: undefined })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(Number.NaN)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(new Map())).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(1n)).toThrow(CanonicalJsonError);
  });
});

describe("hashState", () => {
  it("is stable across a JSON round trip and key reordering", () => {
    const roundTripped = JSON.parse(JSON.stringify(day0State)) as typeof day0State;
    const reordered = Object.fromEntries(Object.entries(day0State).reverse()) as unknown as typeof day0State;
    expect(hashState(roundTripped)).toBe(hashState(day0State));
    expect(hashState(reordered)).toBe(hashState(day0State));
    expect(hashState(day0State)).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
  });

  it("changes when any value changes", () => {
    expect(hashState({ ...day0State, seed: day0State.seed + 1 })).not.toBe(hashState(day0State));
  });
});
