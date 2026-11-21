/**
 * The M002 walking skeleton's final state hash: `path.locked.test.ts`'s path,
 * uninterrupted, on THE_FIRST_HIRE_SCENARIO.
 *
 * Not locked. The task that moves it (R1's retune, a contract change)
 * regenerates it and explains the move in its PR, as
 * `sprint-zero/reference-hash.ts` works for M001.
 */
// fnv1a64:757dca16bf0b5cad (TS1, #243, ADR 0029 decision 13): state's `washes` ([]) and
// `washes` ([]) on every FACILITY_OPERATIONS value. The path never sets a mash (SET_MASH is
// a no-op until TS2). Hashing without those empty arrays gives 6c39c6a1f363b044 again.
export const WALKING_SKELETON_HASH = "fnv1a64:757dca16bf0b5cad";
