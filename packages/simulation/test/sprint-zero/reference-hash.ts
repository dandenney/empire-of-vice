/**
 * The canonical Sprint Zero replay hash, shared by locked tests so they can
 * check that their task did not move it.
 *
 * Not locked. The task that moves the hash updates this constant together with
 * the other pins (the economy-lab inline snapshot and the e2e `HEADLESS_HASH`)
 * and explains the move in its PR.
 */
export const SPRINT_ZERO_HASH = "fnv1a64:0080bee2d4b54a0f";
