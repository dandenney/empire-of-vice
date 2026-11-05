// Structural comparison of a snapshot against a contract fixture.
//
// Two values have the same shape when objects have exactly the same keys and
// each key's values have the same shape, arrays' elements have the same shape
// (compared when both arrays are non-empty), and primitives have the same
// typeof. `null` matches anything, because nullable fields (`blockedBy`,
// `trip`, `previousDay`) hold null in one snapshot and a value in another.
// Union members with different discriminants (`kind`, `type`, `code`,
// `status`, `open`) aren't compared field by field.

const DISCRIMINANTS = ["kind", "type", "code", "status", "open"] as const;

export function shapeDifferences(actual: unknown, expected: unknown, path = "snapshot"): string[] {
  if (actual === null || expected === null) return [];
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) return [`${path}: array vs non-array`];
    if (actual.length === 0 || expected.length === 0) return [];
    return actual.flatMap((item, i) => shapeDifferences(item, expected[Math.min(i, expected.length - 1)], `${path}[${i}]`));
  }
  if (typeof actual !== typeof expected) return [`${path}: ${typeof actual} vs ${typeof expected}`];
  if (typeof actual !== "object") return [];
  const a = actual as Record<string, unknown>;
  const e = expected as Record<string, unknown>;
  for (const d of DISCRIMINANTS) {
    if (d in a && d in e && a[d] !== e[d]) return [];
  }
  const aKeys = Object.keys(a).sort();
  const eKeys = Object.keys(e).sort();
  const missing = eKeys.filter((k) => !aKeys.includes(k)).map((k) => `${path}.${k}: missing`);
  const extra = aKeys.filter((k) => !eKeys.includes(k)).map((k) => `${path}.${k}: not in the contract fixture`);
  const nested = aKeys.filter((k) => eKeys.includes(k)).flatMap((k) => shapeDifferences(a[k], e[k], `${path}.${k}`));
  return [...missing, ...extra, ...nested];
}

/** Every `undefined` anywhere in a value (ADR 0007: explicit nulls, no optional fields). */
export function undefinedPaths(value: unknown, path = "snapshot"): string[] {
  if (value === undefined) return [path];
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((v, i) => undefinedPaths(v, `${path}[${i}]`));
  return Object.entries(value).flatMap(([k, v]) => undefinedPaths(v, `${path}.${k}`));
}
