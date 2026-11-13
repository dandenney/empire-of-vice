// REPEAT_OPERATION (GDD §9 earned automation, level 2; ADR 0004; ADR 0020 decision 11).
//
// A repeat re-issues a previously applied purchase, production, or delivery
// command. It resolves its source in the command log (following repeat chains
// back to the underlying command), copies it, and applies the copy through that
// command's own handler with the repeat's context. So the copy's transactions
// are keyed and caused by the repeat, and its rejections are its own.
//
// "Applied" (decision 11, as amended for T05c):
//   - PURCHASE_MATERIALS: exact, from its key MATERIAL_PURCHASE:<commandId>.
//   - START_PRODUCTION, DISPATCH_DELIVERY: in the command log (queued commands
//     never are). Nothing in state ties a job or delivery to its command, and the
//     copy is fully validated by its own handler anyway.
// Every link of a chain is checked the same way, judged by the underlying
// command's type.
//
// A SALE dispatch (ADR 0022 decision 6, founder rules off; issue #192): a deal is
// single-use, so the copy re-agrees with the same buyer at its current quote,
// inside the dispatch's own DISPATCH transaction (DEAL_AGREED, then
// DELIVERY_DISPATCHED), and dispatches against that new deal. It can't lock in a
// stale price. The on-spec repeat (founder rules on) is SK1c's.
//
// No dispatch-time `validate`: everything is judged when the repeat applies.

import {
  idempotencyKey,
  type CommandId,
  type GameState,
  type RejectionReason,
  type RepeatableCommand,
  type TransactionCoordinator,
} from "@eov/contracts";
import type { GameData } from "@eov/game-data";
import type { SystemRegistry } from "../kernel/registry.ts";
import { dispatchRequotedSale } from "../logistics/logistics.ts";

const notRepeatable = (sourceCommandId: CommandId): RejectionReason => ({ code: "NOT_REPEATABLE", sourceCommandId });

function isRepeatable(command: { readonly type: string }): command is RepeatableCommand {
  return command.type === "PURCHASE_MATERIALS" || command.type === "START_PRODUCTION" || command.type === "DISPATCH_DELIVERY";
}

/**
 * The underlying command a repeat of `sourceCommandId` would copy, or null when
 * the source (or any link of its chain) is unknown, of a type outside
 * RepeatableCommand, or wasn't applied.
 */
export function resolveRepeatSource(state: GameState, sourceCommandId: CommandId): RepeatableCommand | null {
  const log = state.commandLog;
  const links: CommandId[] = [];
  let id = sourceCommandId;
  // Each link points to a strictly earlier log entry, so a chain is never longer
  // than the log; the bound only guards against a malformed state.
  for (let step = 0; step <= log.length; step++) {
    const entry = log.find((e) => e.id === id);
    if (!entry) return null;
    links.push(entry.id);
    const command = entry.command;
    if (command.type === "REPEAT_OPERATION") {
      id = command.sourceCommandId;
      continue;
    }
    if (!isRepeatable(command)) return null;
    if (command.type === "PURCHASE_MATERIALS") {
      const keys = new Set(state.ledger.transactions.map((t) => t.idempotencyKey));
      if (!links.every((link) => keys.has(idempotencyKey("MATERIAL_PURCHASE", link)))) return null;
    }
    return command;
  }
  return null;
}

/** A RegisterSystem (game/systems.ts). It posts nothing itself: the copy goes through its own command's handler. */
export function registerRepeat(registry: SystemRegistry, data: GameData, coordinator: TransactionCoordinator): void {
  registry.onCommand("REPEAT_OPERATION", {
    apply: (state, command, ctx) => {
      const source = resolveRepeatSource(state, command.sourceCommandId);
      if (!source) return { status: "rejected", reason: notRepeatable(command.sourceCommandId) };
      // A deal is single-use, so a repeated sale never reuses its source's deal. With
      // founder rules off it re-agrees at the buyer's current quote, in the dispatch's
      // own transaction (ADR 0022 decision 6; issue #192). The on-spec repeat is SK1c's.
      if (source.type === "DISPATCH_DELIVERY" && source.purpose.kind === "SALE") {
        return dispatchRequotedSale(state, source, ctx, data, coordinator);
      }
      const handler = registry.commandHandler(source.type);
      return handler.apply(state, source as never, ctx);
    },
  });
}
