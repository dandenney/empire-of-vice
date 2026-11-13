// Seeded randomness: xoshiro128** (Blackman & Vigna), one stream per RngStream
// (ADR 0008). Integer-only: Math.imul, shifts, and `>>> 0`, so every JS engine
// produces the same sequence. This is the simulation's only source of randomness.
//
// The functions are pure: they take an RngState and return the drawn value with
// the next RngState. Nothing is hidden in closures, so RNG state lives in
// GameState, is saved, and is included in the state hash.

import { RNG_STREAMS, type GameState, type RngState, type RngStream, type VehicleId } from "@eov/contracts";

const TWO_POW_32 = 0x1_0000_0000;

export class InvalidSeedError extends RangeError {
  override readonly name = "InvalidSeedError";
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/** Draws one uniformly distributed unsigned 32-bit integer. */
export function nextUint32(rng: RngState): { readonly value: number; readonly rng: RngState } {
  let [s0, s1, s2, s3] = rng.words;
  const value = Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
  const t = (s1 << 9) >>> 0;
  s2 = (s2 ^ s0) >>> 0;
  s3 = (s3 ^ s1) >>> 0;
  s1 = (s1 ^ s2) >>> 0;
  s0 = (s0 ^ s3) >>> 0;
  s2 = (s2 ^ t) >>> 0;
  s3 = rotl(s3, 11);
  return { value, rng: { algorithm: "xoshiro128**", words: [s0, s1, s2, s3] } };
}

/**
 * Draws a uniform integer in [0, bound). Unbiased: rejection sampling discards the
 * low values that would make some results more likely than others.
 * `bound` must be a whole number in 1..2^32.
 */
export function nextInt(rng: RngState, bound: number): { readonly value: number; readonly rng: RngState } {
  if (!Number.isSafeInteger(bound) || bound < 1 || bound > TWO_POW_32) {
    throw new RangeError(`nextInt bound must be an integer in 1..2^32, got ${bound}`);
  }
  // 2^32 mod bound is exact in a double, since both operands are below 2^53.
  const threshold = TWO_POW_32 % bound;
  let current = rng;
  for (;;) {
    const draw = nextUint32(current);
    current = draw.rng;
    if (draw.value >= threshold) return { value: draw.value % bound, rng: current };
  }
}

/** Draws a uniform integer in [min, max], both inclusive. */
export function nextIntBetween(
  rng: RngState,
  min: number,
  max: number,
): { readonly value: number; readonly rng: RngState } {
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max) {
    throw new RangeError(`nextIntBetween needs integers min <= max, got ${min}..${max}`);
  }
  const draw = nextInt(rng, max - min + 1);
  return { value: min + draw.value, rng: draw.rng };
}

/**
 * Convenience for systems: draws from one of the state's streams and returns the
 * state with that stream advanced. Other streams are untouched.
 */
export function drawInt(
  state: GameState,
  stream: RngStream,
  bound: number,
): { readonly value: number; readonly state: GameState } {
  const draw = nextInt(state.rng[stream], bound);
  return { value: draw.value, state: { ...state, rng: { ...state.rng, [stream]: draw.rng } } };
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/** splitmix32 step: a well-mixed 32-bit output from a 32-bit counter. */
function splitmix32(x: number): number {
  let z = x >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x85eb_ca6b) >>> 0;
  z = Math.imul(z ^ (z >>> 13), 0xc2b2_ae35) >>> 0;
  return (z ^ (z >>> 16)) >>> 0;
}

/** FNV-1a 32-bit over a string's UTF-16 code units. Only used to salt stream names. */
function fnv1a32(text: string): number {
  let h = 0x811c_9dc5;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 0x0100_0193) >>> 0;
  }
  return h;
}

const GOLDEN_GAMMA = 0x9e37_79b9;

/**
 * Seeds one stream from the scenario seed. The seed (any safe integer, negative
 * allowed) is split into two 32-bit halves, mixed with the stream name, and
 * expanded into four words with splitmix32, the seeding method xoshiro's authors
 * recommend. Different streams get unrelated sequences from the same seed.
 */
export function seedRng(seed: number, stream: RngStream): RngState {
  if (!Number.isSafeInteger(seed)) throw new InvalidSeedError(`Seed must be a safe integer, got ${seed}`);
  const lo = seed >>> 0;
  const hi = Math.floor(seed / TWO_POW_32) >>> 0;
  let x = (splitmix32(lo ^ fnv1a32(stream)) ^ Math.imul(hi, GOLDEN_GAMMA)) >>> 0;
  const words: number[] = [];
  for (let i = 0; i < 4; i++) {
    x = (x + GOLDEN_GAMMA) >>> 0;
    words.push(splitmix32(x));
  }
  // xoshiro's all-zero state is a fixed point. splitmix32 is a bijection on
  // distinct inputs, so four consecutive outputs can't all be zero, but guard anyway.
  if (!words.some((w) => w !== 0)) words[0] = 1;
  return { algorithm: "xoshiro128**", words: [words[0]!, words[1]!, words[2]!, words[3]!] };
}

/**
 * A fresh stream for one keyed draw (ADR 0024 decision 7): the seed's two 32-bit
 * halves, fnv1a32(key) and the ordinal, mixed with splitmix32 and expanded into
 * four words as `seedRng` does. Integer-only; no transcendental math. Pure, so
 * nothing is stored, and a draw that never happens advances nothing.
 */
export function keyedRng(seed: number, key: string, ordinal: number): RngState {
  if (!Number.isSafeInteger(seed)) throw new InvalidSeedError(`Seed must be a safe integer, got ${seed}`);
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new RangeError(`keyedRng ordinal must be a non-negative safe integer, got ${ordinal}`);
  const lo = seed >>> 0;
  const hi = Math.floor(seed / TWO_POW_32) >>> 0;
  const ordinalLo = ordinal >>> 0;
  const ordinalHi = Math.floor(ordinal / TWO_POW_32) >>> 0;
  let x = splitmix32(lo ^ fnv1a32(key));
  x = splitmix32((x ^ Math.imul(hi, GOLDEN_GAMMA)) >>> 0);
  x = splitmix32((x ^ ordinalLo) >>> 0);
  x = (x ^ Math.imul(ordinalHi, GOLDEN_GAMMA)) >>> 0;
  const words: number[] = [];
  for (let i = 0; i < 4; i++) {
    x = (x + GOLDEN_GAMMA) >>> 0;
    words.push(splitmix32(x));
  }
  if (!words.some((w) => w !== 0)) words[0] = 1;
  return { algorithm: "xoshiro128**", words: [words[0]!, words[1]!, words[2]!, words[3]!] };
}

/**
 * The stream a trip's route draws come from (ADR 0022 decision 8): the game
 * seed, the vehicle ID and the vehicle's trip ordinal (`VehicleState.tripCount`,
 * counted at dispatch). Hidden activity can't change any of them for the
 * founder's truck, and the master `routes` stream is never drawn for a trip.
 */
export function tripRng(seed: number, vehicleId: VehicleId, tripCount: number): RngState {
  return keyedRng(seed, `trip:${vehicleId}`, tripCount);
}

/** Seeds every RngStream from the scenario seed. For building a new game's GameState. */
export function seedRngStreams(seed: number): Readonly<Record<RngStream, RngState>> {
  const entries = RNG_STREAMS.map((stream) => [stream, seedRng(seed, stream)] as const);
  return Object.fromEntries(entries) as Record<RngStream, RngState>;
}
