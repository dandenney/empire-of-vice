// Every command's order validator (ADR 0022 decision 9), built for one set of
// game-data and rules. Each system defines its own; this collects them. The
// handlers judge their commands with the same functions, so a command is
// rejected exactly when its validator says so.

import { GAME_COMMAND_TYPES, type GameCommand, type GameCommandType } from "@eov/contracts";
import type { GameData } from "@eov/game-data";
import { repeatOperationValidator } from "../commands/repeat-order.ts";
import { acceptContractValidator } from "../contracts/contracts.ts";
import { agreeDealValidator, purchaseMaterialsValidator } from "../economy/market/market.ts";
import { restValidator, travelValidator, wakeValidator } from "../founder/founder.ts";
import { releaseReservationValidator } from "../inventory/release.ts";
import type { GameRules } from "../kernel/rules.ts";
import { dispatchDeliveryValidator } from "../logistics/logistics.ts";
import { acceptEveryView } from "../personnel/personnel.ts";
import { purchaseEquipmentValidator, sellEquipmentValidator } from "../production/equipment.ts";
import { startProductionValidator } from "../production/jobs.ts";
import { setWorkforceValidator } from "../production/workforce.ts";
import type { IssuerView } from "./issuer-view.ts";
import type { OrderValidator, OrderValidators } from "./order.ts";

/** A command every view accepts. */
const acceptedNoOp = (): null => null;

/**
 * One validator per command type, for these game-data and rules. Each validator
 * reads the founder-rules flag from the view it judges (`IssuerView.founderRules`,
 * set by `playerViewOf`), so there is one source for it. A view built under other
 * rules than these validators is a programming error, and throws.
 */
export function orderValidators(data: GameData, rules: GameRules): OrderValidators {
  const repeatable = {
    PURCHASE_MATERIALS: purchaseMaterialsValidator(data),
    START_PRODUCTION: startProductionValidator(data),
    DISPATCH_DELIVERY: dispatchDeliveryValidator(data),
  };
  const validators: OrderValidators = {
    ...repeatable,
    AGREE_DEAL: agreeDealValidator(data),
    ACCEPT_CONTRACT: acceptContractValidator(data),
    PURCHASE_EQUIPMENT: purchaseEquipmentValidator(data),
    SELL_EQUIPMENT: sellEquipmentValidator(data),
    SET_WORKFORCE: setWorkforceValidator(data),
    RELEASE_RESERVATION: releaseReservationValidator(data),
    REPEAT_OPERATION: repeatOperationValidator(data, repeatable),
    TRAVEL: travelValidator(data),
    REST: restValidator(),
    WAKE: wakeValidator(),
    // PH1's accepted no-ops (ADR 0024 decision 12, ADR 0027 decision 14): nothing
    // to check until C1 (#179) gives them behaviour and their validators.
    PLACE_CALL: acceptedNoOp,
    INSTALL_PHONE: acceptedNoOp,
    RENT_ROOM: acceptedNoOp,
    // EM1's accepted no-ops (ADR 0025 decision 13, and with the flag on until
    // E1, #180): their validators live with the handlers.
    HIRE_EMPLOYEE: acceptEveryView,
    SET_STANDING_ORDER: acceptEveryView,
    DISMISS_EMPLOYEE: acceptEveryView,
  };
  const checked = (type: GameCommandType) => {
    const validate = validators[type] as OrderValidator<GameCommandType>;
    return (view: IssuerView, command: GameCommand) => {
      if (view.founderRules !== rules.founderRules) throw new RangeError(`A ${type} validator for founderRules ${rules.founderRules} got a view for ${view.founderRules}`);
      return validate(view, command as never);
    };
  };
  return Object.fromEntries(GAME_COMMAND_TYPES.map((type) => [type, checked(type)])) as unknown as OrderValidators;
}
