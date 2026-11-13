// REPEAT_OPERATION's order validator (ADR 0022 decisions 1 and 3; ADR 0020
// decision 11). Gate 1 resolves the source through the founder's own commands
// and books (always known): a source that isn't a FOUNDER command the founder
// applied, or isn't repeatable, is NOT_REPEATABLE wherever the founder is. Then
// the repeated command's own validator: whatever it needs, presence included.
//
// The handler (`repeat.ts`) applies the copy through the copied command's own
// handler, which judges it with that same validator, so the two agree.

import { idempotencyKey, type CommandId, type RepeatableCommand } from "@eov/contracts";
import type { GameData } from "@eov/game-data";
import type { GameRules } from "../kernel/rules.ts";
import { requotedSaleRejection } from "../logistics/logistics.ts";
import type { OrderValidator } from "../view/order.ts";
import type { WorldSlice } from "../view/world.ts";

function isRepeatable(command: { readonly type: string }): command is RepeatableCommand {
  return command.type === "PURCHASE_MATERIALS" || command.type === "START_PRODUCTION" || command.type === "DISPATCH_DELIVERY";
}

/**
 * The underlying command a repeat of `sourceCommandId` would copy, or null: the
 * same rule as `repeat.ts`'s `resolveRepeatSource`, read from the view's command
 * log and books. Every link must be the founder's (ADR 0022 decision 3: "The
 * source must be a command issued by the FOUNDER").
 */
export function repeatSourceIn(world: Pick<WorldSlice, "commandLog" | "ledger">, sourceCommandId: CommandId): RepeatableCommand | null {
  const log = world.commandLog;
  const links: CommandId[] = [];
  let id = sourceCommandId;
  for (let step = 0; step <= log.length; step++) {
    const entry = log.find((e) => e.id === id);
    if (!entry || entry.issuer.kind !== "FOUNDER") return null;
    links.push(entry.id);
    const command = entry.command;
    if (command.type === "REPEAT_OPERATION") {
      id = command.sourceCommandId;
      continue;
    }
    if (!isRepeatable(command)) return null;
    if (command.type === "PURCHASE_MATERIALS") {
      const keys = new Set(world.ledger.transactions.map((t) => t.idempotencyKey));
      if (!links.every((linkId) => keys.has(idempotencyKey("MATERIAL_PURCHASE", linkId)))) return null;
    }
    return command;
  }
  return null;
}

/** The validators REPEAT_OPERATION delegates to: the repeatable commands'. */
export type RepeatableValidators = { readonly [T in RepeatableCommand["type"]]: OrderValidator<T> };

/**
 * REPEAT_OPERATION: NOT_REPEATABLE at gate 1, then the copy's own validator. A
 * repeated SALE re-agrees at the buyer's current quote (founder rules off; on
 * spec with them on is SK1c-2's, #226).
 */
export function repeatOperationValidator(data: GameData, _rules: GameRules, validators: RepeatableValidators): OrderValidator<"REPEAT_OPERATION"> {
  return (view, command) => {
    const source = repeatSourceIn(view.world, command.sourceCommandId);
    if (!source) return { code: "NOT_REPEATABLE", sourceCommandId: command.sourceCommandId };
    switch (source.type) {
      case "PURCHASE_MATERIALS":
        return validators.PURCHASE_MATERIALS(view, source);
      case "START_PRODUCTION":
        return validators.START_PRODUCTION(view, source);
      case "DISPATCH_DELIVERY":
        return source.purpose.kind === "SALE" ? requotedSaleRejection(view, source, data) : validators.DISPATCH_DELIVERY(view, source);
    }
  };
}
