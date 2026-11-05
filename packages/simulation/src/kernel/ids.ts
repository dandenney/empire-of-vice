// Dynamic ID assignment (ADR 0003): `<prefix>-<n>` from `state.counters.nextId`.
// This is the single place IDs are minted. The kernel uses it for commands and
// events, and the transaction coordinator (T02b) should reuse it for transactions
// and events rather than writing its own.

import { asId, DYNAMIC_ID_PREFIXES, type DynamicIdKind, type GameState, type Id } from "@eov/contracts";

/**
 * The contracts' prefixes ("cmd-1", "evt-1", "txn-1", "job-17", "res-4", ...),
 * re-exported so minting and `compareIds` can't drift apart.
 */
export const ID_PREFIXES: Readonly<Record<DynamicIdKind, string>> = DYNAMIC_ID_PREFIXES;

/** Formats the ID a counter value would produce, without consuming it. */
export function formatId<K extends DynamicIdKind>(kind: K, n: number): Id<K> {
  return asId(kind, `${ID_PREFIXES[kind]}-${n}`);
}

/** Mints the next ID of `kind` and returns it with the state whose counter has advanced. */
export function allocateId<K extends DynamicIdKind>(
  state: GameState,
  kind: K,
): { readonly id: Id<K>; readonly state: GameState } {
  const n = state.counters.nextId[kind];
  return {
    id: formatId(kind, n),
    state: {
      ...state,
      counters: { ...state.counters, nextId: { ...state.counters.nextId, [kind]: n + 1 } },
    },
  };
}

/** The numeric suffix of a dynamic ID, or null if it wasn't minted with this kind's prefix. */
export function idNumber(kind: DynamicIdKind, id: string): number | null {
  const prefix = `${ID_PREFIXES[kind]}-`;
  if (!id.startsWith(prefix)) return null;
  const digits = id.slice(prefix.length);
  if (!/^(0|[1-9][0-9]*)$/.test(digits)) return null;
  const n = Number(digits);
  return Number.isSafeInteger(n) ? n : null;
}
