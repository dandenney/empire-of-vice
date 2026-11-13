// Timed activities (ADR 0023 decision 4).
//
// - Which commands are timed, and with which ActivityKind: the decision 4 table.
//   A REPEAT_OPERATION takes its underlying command's activity. A dispatch is
//   LOAD_TRUCK only when the founder drives.
// - Busy: an applied timed command makes a PRESENT founder busy until
//   `t + duration`, × TIRED_DURATION_PPM while tired.
//
// The presence gate itself (NOT_PRESENT, FOUNDER_BUSY, PLACE_CLOSED) is part of
// every command's order validator, read from the issuer's view
// (`view/presence.ts`, ADR 0022 decisions 1 and 3). `busyRejection` here is the
// player snapshot's affordance.

import type { ActivityKind, CommandEnvelope, GameCommand, GameState, RejectionReason, Tick } from "@eov/contracts";
import { resolveRepeatSource } from "../commands/repeat.ts";
import { activityTicks } from "./time.ts";

/** The timed activity a command is, or null for an instant command (decision 4's table). */
export function activityOf(state: GameState, command: GameCommand): ActivityKind | null {
  switch (command.type) {
    case "PURCHASE_MATERIALS":
      return "BUY_MATERIALS";
    case "START_PRODUCTION":
      return "START_BATCH";
    case "DISPATCH_DELIVERY":
      return command.driver?.kind === "FOUNDER" ? "LOAD_TRUCK" : null;
    case "AGREE_DEAL":
      return "AGREE_DEAL";
    case "ACCEPT_CONTRACT":
      return "ACCEPT_CONTRACT";
    case "PURCHASE_EQUIPMENT":
      return "BUY_EQUIPMENT";
    case "SELL_EQUIPMENT":
      return "SELL_EQUIPMENT";
    case "SET_WORKFORCE":
      return "SET_WORKFORCE";
    case "REPEAT_OPERATION": {
      const source = resolveRepeatSource(state, command.sourceCommandId);
      return source ? activityOf(state, source) : null;
    }
    default:
      return null;
  }
}

/** The busy gate (decision 2a): busy through `until`, inclusive. */
export function busyRejection(state: GameState, t: Tick): RejectionReason | null {
  const w = state.founder.whereabouts;
  return w.kind === "PRESENT" && w.busy !== null && w.busy.until >= t ? { code: "FOUNDER_BUSY", until: w.busy.until } : null;
}

/**
 * After a timed command applied at `t`: the founder, if PRESENT, is busy with
 * it until `t + duration` (decision 4). `before` is the state the command was
 * judged against; the duration is judged at the apply tick (tiredness included).
 */
export function startActivity(before: GameState, after: GameState, envelope: CommandEnvelope, t: Tick): GameState {
  if (envelope.issuer.kind !== "FOUNDER") return after;
  const activity = activityOf(before, envelope.command);
  const w = after.founder.whereabouts;
  if (activity === null || w.kind !== "PRESENT") return after;
  const until = (t + activityTicks(before.founder, activity, t)) as Tick;
  return { ...after, founder: { ...after.founder, whereabouts: { ...w, busy: { activity, until } } } };
}
