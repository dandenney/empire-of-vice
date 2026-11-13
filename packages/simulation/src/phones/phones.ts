// Telephones and rooms (ADR 0024, ADR 0027): PLACE_CALL, INSTALL_PHONE and
// RENT_ROOM, and the `phones` phase.
//
// PH1 (#205) is the contract task: it registers only the three handlers, as
// accepted no-ops (ADR 0024 decision 12, ADR 0027 decision 14): accepted, no
// domain state changed, no transaction, no event. Like any applied command, the
// kernel still appends the envelope to `commandLog`, so `stateHash` moves. The
// `phones` phase has no hooks, so `pendingMessages`, `call`, `phoneLine`, `room`
// and `arrangements` never change.
//
// That's the rule with `founderRules: false` (M001, the lab), and it's where
// things stand with the flag on too until C1 (#179) replaces the flag-on
// handlers with the phone behaviour and adds the phase's hooks.

import type { GameState } from "@eov/contracts";
import type { CommandOutcome, SystemRegistry } from "../kernel/registry.ts";

/** The phone and room commands (ADR 0024 decisions 2 and 3, ADR 0027 decision 4), in GAME_COMMAND_TYPES order. */
export const PHONE_COMMAND_TYPES = ["PLACE_CALL", "INSTALL_PHONE", "RENT_ROOM"] as const;

/** Accepted, and nothing changes. */
function acceptedNoOp(state: GameState): CommandOutcome {
  return { status: "applied", state };
}

export function registerPhones(registry: SystemRegistry): void {
  for (const type of PHONE_COMMAND_TYPES) registry.onCommand(type, { apply: acceptedNoOp });
}
