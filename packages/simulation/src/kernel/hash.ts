// State hashing (SIM-001, ADR 0008). The algorithm, fixed here for replay checks
// and for SaveFile.stateHash:
//
//   stateHash = "fnv1a64:" + hex16( FNV-1a-64( UTF-8( canonicalJson(state) ) ) )
//
// canonicalJson is JSON with object keys sorted by UTF-16 code unit order (the
// default JS string sort), no whitespace, -0 written as 0, and strings and numbers
// formatted exactly as JSON.stringify does (both fully specified by ECMAScript).
// Arrays keep their order: state arrays are already sorted by ID or by
// (tick, sequence) (ADR 0008). `undefined`, functions, symbols, bigints,
// non-finite numbers, and non-plain objects are rejected: GameState never holds
// them, so meeting one is a bug.
//
// FNV-1a-64 is computed with four 16-bit limbs, so it uses only exact integer
// arithmetic (no BigInt, no floats beyond 2^26). It's not cryptographic; it
// detects divergence and accidental corruption, which is all replay and save
// checks need.

import type { GameState } from "@eov/contracts";

export const STATE_HASH_ALGORITHM = "fnv1a64";

export class CanonicalJsonError extends TypeError {
  override readonly name = "CanonicalJsonError";
}

export function canonicalJson(value: unknown): string {
  return write(value, "$");
}

function write(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalJsonError(`Non-finite number at ${path}`);
      return Object.is(value, -0) ? "0" : JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        const parts: string[] = [];
        for (let i = 0; i < value.length; i++) parts.push(write(value[i], `${path}[${i}]`));
        return `[${parts.join(",")}]`;
      }
      const proto: unknown = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new CanonicalJsonError(`Non-plain object at ${path}`);
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      const parts = keys.map((key) => `${JSON.stringify(key)}:${write(record[key], `${path}.${key}`)}`);
      return `{${parts.join(",")}}`;
    }
    default:
      throw new CanonicalJsonError(`Unsupported ${typeof value} at ${path}`);
  }
}

/** FNV-1a 64-bit over the UTF-8 encoding of `text`, as 16 lowercase hex digits. */
export function fnv1a64Hex(text: string): string {
  // Offset basis 0xcbf29ce484222325, limbs low to high.
  let h0 = 0x2325;
  let h1 = 0x8422;
  let h2 = 0x9ce4;
  let h3 = 0xcbf2;

  const feed = (byte: number): void => {
    h0 ^= byte;
    // Multiply by the prime 2^40 + 0x1b3, keeping the low 64 bits.
    const t0 = h0 * 0x1b3;
    const t1 = h1 * 0x1b3 + (t0 >>> 16);
    const t2 = h2 * 0x1b3 + (t1 >>> 16) + (h0 << 8);
    const t3 = h3 * 0x1b3 + (t2 >>> 16) + (h1 << 8);
    h0 = t0 & 0xffff;
    h1 = t1 & 0xffff;
    h2 = t2 & 0xffff;
    h3 = t3 & 0xffff;
  };

  for (let i = 0; i < text.length; i++) {
    let cp = text.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00);
        i++;
      }
    }
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd; // lone surrogate (JSON.stringify escapes these anyway)
    if (cp < 0x80) {
      feed(cp);
    } else if (cp < 0x800) {
      feed(0xc0 | (cp >>> 6));
      feed(0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      feed(0xe0 | (cp >>> 12));
      feed(0x80 | ((cp >>> 6) & 0x3f));
      feed(0x80 | (cp & 0x3f));
    } else {
      feed(0xf0 | (cp >>> 18));
      feed(0x80 | ((cp >>> 12) & 0x3f));
      feed(0x80 | ((cp >>> 6) & 0x3f));
      feed(0x80 | (cp & 0x3f));
    }
  }

  const hex = (limb: number): string => limb.toString(16).padStart(4, "0");
  return hex(h3) + hex(h2) + hex(h1) + hex(h0);
}

/** The state hash used for replay checks and SaveFile.stateHash. */
export function hashState(state: GameState): string {
  return `${STATE_HASH_ALGORITHM}:${fnv1a64Hex(canonicalJson(state))}`;
}
