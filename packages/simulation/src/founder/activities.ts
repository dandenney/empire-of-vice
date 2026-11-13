// Timed activities (ADR 0023 decision 4) and the part of ADR 0022's presence
// gate (gate 2) that SK1a owns: the busy gate and place hours.
//
// - Which commands are timed, and with which ActivityKind: the decision 4 table.
//   A REPEAT_OPERATION takes its underlying command's activity. A dispatch is
//   LOAD_TRUCK only when the founder drives.
// - The busy gate: a timed command applied at `t` is rejected with
//   FOUNDER_BUSY while `busy.until ≥ t` (decision 2a). Instant commands at the
//   same place are still allowed. TRAVEL and REST check it themselves, in their
//   own check order (decision 3a).
// - Place hours: an activity with a party (buying, negotiating, accepting) must
//   start while the party's place is open (decision 6), else PLACE_CLOSED.
// - Busy: an applied timed command makes a PRESENT founder busy until
//   `t + duration`, × TIRED_DURATION_PPM while tired.
//
// Whether the founder must be at the command's place (NOT_PRESENT, the rest of
// ADR 0022 decision 3's table) is SK1c's (#200). Until then a timed command
// from a founder who isn't PRESENT applies without taking the founder's time,
// as in M001, except a dispatch the founder drives (NO_DRIVER, logistics).

import type { ActivityKind, CommandEnvelope, GameCommand, GameState, LocationId, RejectionReason, Tick } from "@eov/contracts";
import type { GameData } from "@eov/game-data";
import { resolveRepeatSource } from "../commands/repeat.ts";
import { activityTicks, isOpenAt, opensAt } from "./time.ts";

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

/**
 * The party an activity deals with, whose hours apply (decision 6): the
 * supplier for a purchase, the buyer for a deal or a contract. Null for work at
 * your own facilities (never hours-gated) and for an ID that doesn't resolve,
 * which the command's handler rejects at gate 1.
 */
export function partyLocationOf(state: GameState, data: GameData, command: GameCommand): LocationId | null {
  switch (command.type) {
    case "PURCHASE_MATERIALS":
      return data.suppliers.find((s) => s.id === command.supplierId)?.locationId ?? null;
    case "AGREE_DEAL":
      return data.buyers.find((b) => b.id === command.buyerId)?.locationId ?? null;
    case "ACCEPT_CONTRACT": {
      const offer = state.contractOffers.find((o) => o.id === command.contractOfferId);
      return offer ? (data.buyers.find((b) => b.id === offer.buyerId)?.locationId ?? null) : null;
    }
    case "REPEAT_OPERATION": {
      const source = resolveRepeatSource(state, command.sourceCommandId);
      return source ? partyLocationOf(state, data, source) : null;
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

/** Gate 2 for a timed command applied at `t`: busy, then the party's hours. */
export function activityRejection(state: GameState, data: GameData, envelope: CommandEnvelope, t: Tick): RejectionReason | null {
  if (envelope.issuer.kind !== "FOUNDER") return null;
  if (activityOf(state, envelope.command) === null) return null;
  const busy = busyRejection(state, t);
  if (busy) return busy;
  const party = partyLocationOf(state, data, envelope.command);
  if (party !== null && !isOpenAt(party, t)) return { code: "PLACE_CLOSED", locationId: party, opensAt: opensAt(party, t) };
  return null;
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
