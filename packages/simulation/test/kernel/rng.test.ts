import { RNG_STREAMS, type RngState } from "@eov/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { nextInt, nextIntBetween, nextUint32, seedRng, seedRngStreams } from "../../src/index.ts";

const state = (words: readonly [number, number, number, number]): RngState => ({ algorithm: "xoshiro128**", words });

/** Independent BigInt reference of xoshiro128** (Blackman & Vigna, xoshiro128starstar.c). */
function referenceOutputs(seedWords: readonly number[], count: number): number[] {
  const M = 0xffffffffn;
  const s = seedWords.map((w) => BigInt(w));
  const rotl = (x: bigint, k: bigint): bigint => ((x << k) | (x >> (32n - k))) & M;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(Number((rotl((s[1]! * 5n) & M, 7n) * 9n) & M));
    const t = (s[1]! << 9n) & M;
    s[2]! ^= s[0]!;
    s[3]! ^= s[1]!;
    s[1]! ^= s[2]!;
    s[0]! ^= s[3]!;
    s[2]! ^= t;
    s[3] = rotl(s[3]!, 11n);
  }
  return out;
}

function draws(rng: RngState, count: number): { values: number[]; rng: RngState } {
  const values: number[] = [];
  let current = rng;
  for (let i = 0; i < count; i++) {
    const d = nextUint32(current);
    values.push(d.value);
    current = d.rng;
  }
  return { values, rng: current };
}

describe("xoshiro128**", () => {
  it("matches the published algorithm's first outputs for state [1, 2, 3, 4]", () => {
    expect(draws(state([1, 2, 3, 4]), 4).values).toEqual([11520, 0, 5927040, 70819200]);
  });

  it("matches an independent BigInt reference for arbitrary states", () => {
    const word = fc.integer({ min: 0, max: 0xffffffff });
    fc.assert(
      fc.property(fc.tuple(word, word, word, word), (words) => {
        fc.pre(words.some((w) => w !== 0));
        expect(draws(state(words), 200).values).toEqual(referenceOutputs(words, 200));
      }),
      { seed: 1920, numRuns: 100 },
    );
  });

  it("serializes: resuming from saved words (even through JSON) continues the same sequence", () => {
    const start = seedRng(1920, "market");
    const uninterrupted = draws(start, 100).values;
    const firstHalf = draws(start, 37);
    const saved = JSON.parse(JSON.stringify(firstHalf.rng)) as RngState;
    expect(saved.algorithm).toBe("xoshiro128**");
    expect([...firstHalf.values, ...draws(saved, 63).values]).toEqual(uninterrupted);
  });

  it("is pure: drawing doesn't change the input state", () => {
    const rng = seedRng(7, "routes");
    const copy = JSON.stringify(rng);
    nextUint32(rng);
    nextInt(rng, 6);
    expect(JSON.stringify(rng)).toBe(copy);
  });
});

describe("seeding", () => {
  it("is deterministic and gives every stream a different sequence", () => {
    expect(seedRngStreams(1920)).toEqual(seedRngStreams(1920));
    const firsts = RNG_STREAMS.map((stream) => draws(seedRng(1920, stream), 4).values.join(","));
    expect(new Set(firsts).size).toBe(RNG_STREAMS.length);
  });

  it("produces valid unsigned 32-bit words for any safe-integer seed", () => {
    fc.assert(
      fc.property(fc.maxSafeInteger().map((n) => n * (n % 2 === 0 ? 1 : -1)), (seed) => {
        for (const stream of RNG_STREAMS) {
          const rng = seedRng(seed, stream);
          expect(rng.words.every((w) => Number.isInteger(w) && w >= 0 && w <= 0xffffffff)).toBe(true);
          expect(rng.words.some((w) => w !== 0)).toBe(true);
        }
      }),
      { seed: 1920 },
    );
  });

  it("distinguishes seeds that differ only in the high 32 bits", () => {
    expect(seedRng(5, "market")).not.toEqual(seedRng(5 + 0x1_0000_0000, "market"));
  });

  it("rejects non-integer seeds", () => {
    expect(() => seedRng(1.5, "market")).toThrow(RangeError);
  });

  it("pins the seed-1920 market stream so a seeding change is visible", () => {
    expect(draws(seedRng(1920, "market"), 3).values).toMatchInlineSnapshot(`
      [
        3668184268,
        3711326009,
        1217069080,
      ]
    `);
  });
});

describe("bounded draws", () => {
  it("nextInt stays in [0, bound) and nextIntBetween in [min, max]", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 0x1_0000_0000 }), fc.integer({ min: -1000, max: 1000 }), (bound, min) => {
        let rng = seedRng(bound, "production");
        for (let i = 0; i < 20; i++) {
          const a = nextInt(rng, bound);
          expect(a.value).toBeGreaterThanOrEqual(0);
          expect(a.value).toBeLessThan(bound);
          const b = nextIntBetween(a.rng, min, min + 5);
          expect(b.value).toBeGreaterThanOrEqual(min);
          expect(b.value).toBeLessThanOrEqual(min + 5);
          rng = b.rng;
        }
      }),
      { seed: 1920 },
    );
  });

  it("is roughly uniform for a small bound", () => {
    const counts = [0, 0, 0, 0, 0, 0];
    let rng = seedRng(1920, "production");
    for (let i = 0; i < 60_000; i++) {
      const d = nextInt(rng, 6);
      counts[d.value]!++;
      rng = d.rng;
    }
    for (const c of counts) expect(Math.abs(c - 10_000)).toBeLessThan(500);
  });

  it("rejects invalid bounds", () => {
    const rng = seedRng(1, "market");
    expect(() => nextInt(rng, 0)).toThrow(RangeError);
    expect(() => nextInt(rng, 2.5)).toThrow(RangeError);
    expect(() => nextInt(rng, 0x1_0000_0001)).toThrow(RangeError);
    expect(() => nextIntBetween(rng, 3, 2)).toThrow(RangeError);
  });
});
