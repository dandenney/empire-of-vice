// A small seeded PRNG for headless strategies' own choices (T07b, issue #119).
//
// Strategy decisions follow the simulation's determinism rules (architecture §8):
// no Math.random, no Date.now, no transcendental Math functions. Each strategy
// gets its own stream, derived from the run seed and the strategy's name, so a
// strategy's choices never touch the simulation's RNG streams and two strategies
// on the same seed don't share draws.
//
// The generator is splitmix32: 32-bit integer arithmetic only (Math.imul, shifts).

const GOLDEN_GAMMA = 0x9e3779b9;

/** FNV-1a over a string's UTF-16 code units, 32-bit. */
function fnv1a32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function mix32(x: number): number {
  let z = x >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
  return (z ^ (z >>> 16)) >>> 0;
}

export class StrategyRng {
  #state: number;

  /** A stream for one strategy on one run seed. `seed` must be a safe integer. */
  constructor(seed: number, stream: string) {
    if (!Number.isSafeInteger(seed)) throw new RangeError(`Strategy seed must be a safe integer, got ${seed}`);
    const lo = seed >>> 0;
    const hi = Math.floor(seed / 0x1_0000_0000) >>> 0;
    this.#state = (mix32(lo ^ fnv1a32(stream)) ^ Math.imul(hi, GOLDEN_GAMMA)) >>> 0;
  }

  nextUint32(): number {
    this.#state = (this.#state + GOLDEN_GAMMA) >>> 0;
    return mix32(this.#state);
  }

  /** Uniform integer in [0, bound). Rejection sampling, so there's no modulo bias. */
  int(bound: number): number {
    if (!Number.isSafeInteger(bound) || bound < 1 || bound > 0x1_0000_0000) throw new RangeError(`bound must be an integer in 1..2^32, got ${bound}`);
    const threshold = 0x1_0000_0000 % bound;
    for (;;) {
      const x = this.nextUint32();
      if (x >= threshold) return x % bound;
    }
  }

  /** Uniform integer in [min, max]. */
  between(min: number, max: number): number {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max) throw new RangeError(`between needs integers min <= max, got ${min}..${max}`);
    return min + this.int(max - min + 1);
  }

  /** One element, uniformly. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError("pick needs at least one item");
    return items[this.int(items.length)]!;
  }
}
