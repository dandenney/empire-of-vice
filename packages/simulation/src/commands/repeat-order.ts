// REPEAT_OPERATION's order validator (ADR 0022 decisions 1 and 3; ADR 0020
// decision 11). Gate 1 resolves the source through the founder's own commands
// and books (always known): a source that isn't a FOUNDER command the founder
// applied, or isn't repeatable, is NOT_REPEATABLE wherever the founder is. Then
// the repeated command's own validator: whatever it needs, presence included.
//
// The handler (`repeat.ts`) applies the copy through the copied command's own
// handler, which judges it with that same validator, and both resolve the
// source with the one lookup, `resolveRepeatSource`, so the two agree.

import type { RepeatableCommand } from "@eov/contracts";
import type { GameData } from "@eov/game-data";
import { requotedSaleRejection } from "../logistics/logistics.ts";
import type { OrderValidator } from "../view/order.ts";
import { onSpecCopy, resolveRepeatSource } from "./repeat.ts";

/** The validators REPEAT_OPERATION delegates to: the repeatable commands'. */
export type RepeatableValidators = { readonly [T in RepeatableCommand["type"]]: OrderValidator<T> };

/**
 * REPEAT_OPERATION: NOT_REPEATABLE at gate 1, then the copy's own validator. A
 * repeated SALE goes on spec with founder rules on (DISPATCH_DELIVERY's
 * validator, on the copy: nothing of the buyer is read), and re-agrees at the
 * buyer's current quote with them off (ADR 0022 decision 6).
 */
export function repeatOperationValidator(data: GameData, validators: RepeatableValidators): OrderValidator<"REPEAT_OPERATION"> {
  return (view, command) => {
    const source = resolveRepeatSource(view.world, command.sourceCommandId);
    if (!source) return { code: "NOT_REPEATABLE", sourceCommandId: command.sourceCommandId };
    switch (source.type) {
      case "PURCHASE_MATERIALS":
        return validators.PURCHASE_MATERIALS(view, source);
      case "START_PRODUCTION":
        return validators.START_PRODUCTION(view, source);
      case "DISPATCH_DELIVERY":
        if (source.purpose.kind !== "SALE") return validators.DISPATCH_DELIVERY(view, source);
        return view.founderRules ? validators.DISPATCH_DELIVERY(view, onSpecCopy(source)) : requotedSaleRejection(view, source, data);
    }
  };
}
