// Orders (ADR 0022 decisions 1 and 2): a command's whole immediate check is a
// function of the issuer's view. Each system defines the validators for its own
// commands; `validators.ts` collects them; each handler judges its command with
// its validator first, and once a command is validated, applying it never
// rejects (orchestrator reading 1 on #200).
//
// Decision 1's gates, in order, inside every validator:
//   1. shape and identity: INVALID_QUANTITY, and every ID resolved through the
//      view (agreements, owned things, geography, known records);
//   2. presence (`presence.ts`): NOT_PRESENT, FOUNDER_BUSY, PLACE_CLOSED, and the
//      dispatch's NO_DRIVER and VEHICLE_NOT_AT;
//   3. communication: always "present in person" before phones (decision 4);
//   4. authority: the founder has all of it (decision 5);
//   5. validity against what the issuer can see: stock, prices, capacity, funds.
// With founder rules off gates 2–4 are empty and the checks keep M001's order.

import type { GameCommandType, GameState, RejectionReason, Tick } from "@eov/contracts";
import type { GameData } from "@eov/game-data";
import type { CommandOfType } from "../kernel/registry.ts";
import type { GameRules } from "../kernel/rules.ts";
import { playerViewOf, type IssuerView } from "./issuer-view.ts";

/** A command's whole immediate check: decision 1's gates in order. null: the order is accepted. */
export type OrderValidator<T extends GameCommandType> = (view: IssuerView, command: CommandOfType<T>) => RejectionReason | null;

/** One validator per command type. */
export type OrderValidators = { readonly [T in GameCommandType]: OrderValidator<T> };

/** Judges a founder command applied at `at` in `state` with its validator, against the founder's view. */
export function judgeOrder<T extends GameCommandType>(
  validate: OrderValidator<T>,
  state: GameState,
  data: GameData,
  rules: GameRules,
  command: CommandOfType<T>,
  at: Tick,
): RejectionReason | null {
  return validate(playerViewOf(state, data, rules, at), command);
}
