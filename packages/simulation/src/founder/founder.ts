// The founder's own commands: TRAVEL, REST and WAKE (ADR 0023 decisions 3 and 7).
//
// P1 (#193) registers the flag-off rule only (decision 9): with
// `founderRules: false` the three commands apply as no-ops. They're accepted,
// change no domain state, post no transaction and emit no event. Like any
// applied command, the kernel still appends the envelope to `commandLog`, so
// `stateHash` moves. `LOCKED` doesn't fit, because it carries an `unlockId`, and
// a no-op needs no new reason.
//
// Every scenario that exists today has `founderRules: false`. The flag-on
// behaviour (validation by decision 3a's reasons, travel, rest, waking, and the
// founder phase's hooks) is SK1a (#198), which replaces these handlers.

import type { GameState } from "@eov/contracts";
import type { CommandOutcome, SystemRegistry } from "../kernel/registry.ts";

/** The founder's commands (ADR 0023), in GAME_COMMAND_TYPES order. */
export const FOUNDER_COMMAND_TYPES = ["TRAVEL", "REST", "WAKE"] as const;

/** Accepted, and nothing changes (ADR 0023 decision 9, `founderRules: false`). */
function acceptedNoOp(state: GameState): CommandOutcome {
  return { status: "applied", state };
}

export function registerFounder(registry: SystemRegistry): void {
  registry
    .onCommand("TRAVEL", { apply: acceptedNoOp })
    .onCommand("REST", { apply: acceptedNoOp })
    .onCommand("WAKE", { apply: acceptedNoOp });
}
