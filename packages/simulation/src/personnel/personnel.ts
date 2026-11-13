// Employees, hiring and standing orders (ADR 0025, as amended by ADR 0028):
// HIRE_EMPLOYEE, SET_STANDING_ORDER and DISMISS_EMPLOYEE, and the `employees`
// phase.
//
// EM1 (#210) is the contract task: it registers only the three handlers, as
// accepted no-ops (ADR 0025 decision 13): accepted, no domain state changed, no
// transaction, no event. Like any applied command, the kernel still appends the
// envelope to `commandLog`, so `stateHash` moves. Their order validators accept
// every view, so a command is never rejected. The `employees` phase has no hooks,
// so `employees`, `formerEmployees` and the StandingOrder counter never change.
//
// That's the rule with `founderRules: false` (M001, the lab), and it's where
// things stand with the flag on too (the orchestrator's decision on #210) until
// E1 (#180) replaces the flag-on handlers and validators with hiring, orders and
// dismissal, and adds the phase's hooks. None of EM1's rejection codes
// (CANDIDATE_UNAVAILABLE, CANDIDATE_TERMS_CHANGED, STATION_UNSUITABLE,
// POSITION_FILLED, OUTSIDE_AUTHORITY) is returned before E1.

import type { GameState } from "@eov/contracts";
import type { CommandOutcome, SystemRegistry } from "../kernel/registry.ts";

/** The employee commands (ADR 0025 decisions 4 and 5), in GAME_COMMAND_TYPES order. */
export const PERSONNEL_COMMAND_TYPES = ["HIRE_EMPLOYEE", "SET_STANDING_ORDER", "DISMISS_EMPLOYEE"] as const;

/** Accepted, and nothing changes. */
function acceptedNoOp(state: GameState): CommandOutcome {
  return { status: "applied", state };
}

/** The order validator of each employee command until E1: every view accepts it. */
export const acceptEveryView = (): null => null;

export function registerPersonnel(registry: SystemRegistry): void {
  for (const type of PERSONNEL_COMMAND_TYPES) registry.onCommand(type, { apply: acceptedNoOp });
}
