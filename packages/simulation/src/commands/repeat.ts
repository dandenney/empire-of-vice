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
// No dispatch-time `validate`: everything is judged when the repeat applies.

import {
  idempotencyKey,
  type CommandId,
  type GameState,
  type RejectionReason,
  type RepeatableCommand,
} from "@eov/contracts";
import type { GameData } from "@eov/game-data";
import { quoteDeal } from "../economy/market/market.ts";
import type { SystemRegistry } from "../kernel/registry.ts";

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

/**
 * The copy to apply: the source as it was, except that a SALE dispatch's
 * `agreedUnitPrice` becomes the buyer's current quote for the cargo (the value
 * the dispatch's QUOTE_CHANGED check compares against). If the buyer won't quote,
 * the original price is kept and the dispatch's own rejection explains why.
 */
function copyOf(state: GameState, data: GameData, source: RepeatableCommand): RepeatableCommand {
  if (source.type !== "DISPATCH_DELIVERY" || source.purpose.kind !== "SALE") return source;
  const line = source.cargo[0];
  if (!line) return source;
  const { buyerId, agreedUnitPrice } = source.purpose;
  const quote = quoteDeal(state, data, buyerId, agreedUnitPrice, line);
  if (!("code" in quote) || quote.code !== "QUOTE_CHANGED") return source;
  return { ...source, purpose: { ...source.purpose, agreedUnitPrice: quote.current } };
}

/** A RegisterSystem (game/systems.ts); it commits nothing itself, so it takes no coordinator. */
export function registerRepeat(registry: SystemRegistry, data: GameData): void {
  registry.onCommand("REPEAT_OPERATION", {
    apply: (state, command, ctx) => {
      const source = resolveRepeatSource(state, command.sourceCommandId);
      if (!source) return { status: "rejected", reason: notRepeatable(command.sourceCommandId) };
      const copy = copyOf(state, data, source);
      const handler = registry.commandHandler(copy.type);
      return handler.apply(state, copy as never, ctx);
    },
  });
}
