// Two-stage production (ADR 0029): SET_MASH and START_DISTILLATION.
//
// TS1 (#243) is the contract task: it registers only the two handlers, as
// accepted no-ops (ADR 0029 decision 16, after ADR 0025 decision 13's
// precedent): accepted, no domain state changed, no transaction, no event. Like
// any applied command, the kernel still appends the envelope to `commandLog`, so
// `stateHash` moves. Their order validators accept every view, so neither
// command is ever rejected, and `activityOf` doesn't map them yet, so they take
// no time. `washes` stays [].
//
// That's the rule with `founderRules: false` (M001, the lab; ADR 0029 checklist
// §6), and it's where things stand with the flag on too until TS2 (#244)
// replaces the flag-on handlers and validators with the mash and the run, and
// posts the `PRODUCTION_START:MASH` and `:RUN` producers. Neither of TS1's
// rejection codes (TWO_STAGE_RECIPE, NO_READY_WASH) is returned before TS2, and
// START_PRODUCTION keeps its current behaviour until then.

import type { GameState } from "@eov/contracts";
import type { CommandOutcome, SystemRegistry } from "../kernel/registry.ts";

/** The two-stage commands (ADR 0029 decision 4), in GAME_COMMAND_TYPES order. */
export const TWO_STAGE_COMMAND_TYPES = ["SET_MASH", "START_DISTILLATION"] as const;

/** Accepted, and nothing changes. */
function acceptedNoOp(state: GameState): CommandOutcome {
  return { status: "applied", state };
}

/** The order validator of each two-stage command until TS2: every view accepts it. */
export const acceptEveryTwoStageView = (): null => null;

export function registerTwoStage(registry: SystemRegistry): void {
  for (const type of TWO_STAGE_COMMAND_TYPES) registry.onCommand(type, { apply: acceptedNoOp });
}
