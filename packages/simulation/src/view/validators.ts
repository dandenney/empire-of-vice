// Every command's order validator (ADR 0022 decision 9), built for one set of
// game-data and rules. Each system defines its own; this collects them. The
// handlers judge their commands with the same functions, so a command is
// rejected exactly when its validator says so.

import type { GameData } from "@eov/game-data";
import { repeatOperationValidator } from "../commands/repeat-order.ts";
import { acceptContractValidator } from "../contracts/contracts.ts";
import { agreeDealValidator, purchaseMaterialsValidator } from "../economy/market/market.ts";
import { restValidator, travelValidator, wakeValidator } from "../founder/founder.ts";
import { releaseReservationValidator } from "../inventory/release.ts";
import type { GameRules } from "../kernel/rules.ts";
import { dispatchDeliveryValidator } from "../logistics/logistics.ts";
import { purchaseEquipmentValidator, sellEquipmentValidator } from "../production/equipment.ts";
import { startProductionValidator } from "../production/jobs.ts";
import { setWorkforceValidator } from "../production/workforce.ts";
import type { OrderValidators } from "./order.ts";

/** One validator per command type, for these game-data and rules. */
export function orderValidators(data: GameData, rules: GameRules): OrderValidators {
  const repeatable = {
    PURCHASE_MATERIALS: purchaseMaterialsValidator(data, rules),
    START_PRODUCTION: startProductionValidator(data, rules),
    DISPATCH_DELIVERY: dispatchDeliveryValidator(data),
  };
  return {
    ...repeatable,
    AGREE_DEAL: agreeDealValidator(data, rules),
    ACCEPT_CONTRACT: acceptContractValidator(data, rules),
    PURCHASE_EQUIPMENT: purchaseEquipmentValidator(data, rules),
    SELL_EQUIPMENT: sellEquipmentValidator(data, rules),
    SET_WORKFORCE: setWorkforceValidator(data, rules),
    RELEASE_RESERVATION: releaseReservationValidator(data, rules),
    REPEAT_OPERATION: repeatOperationValidator(data, rules, repeatable),
    TRAVEL: travelValidator(data, rules),
    REST: restValidator(rules),
    WAKE: wakeValidator(rules),
  };
}
