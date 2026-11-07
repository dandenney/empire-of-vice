import { describe, expect, expectTypeOf, it } from "vitest";
import {
  GAME_COMMAND_TYPES,
  type CommandResult,
  type GameCommandType,
  type RejectionReason,
  type RepeatableCommand,
} from "../src/index.ts";

describe("commands", () => {
  it("GAME_COMMAND_TYPES lists every command type exactly once", () => {
    expectTypeOf<(typeof GAME_COMMAND_TYPES)[number]>().toEqualTypeOf<GameCommandType>();
    expect(new Set(GAME_COMMAND_TYPES).size).toBe(GAME_COMMAND_TYPES.length);
  });

  it("SELL_EQUIPMENT is a command but not repeatable (ADR 0020 decision 14)", () => {
    expectTypeOf<"SELL_EQUIPMENT">().toExtend<GameCommandType>();
    expect(GAME_COMMAND_TYPES.at(-1)).toBe("SELL_EQUIPMENT");
    expectTypeOf<Extract<RepeatableCommand, { type: "SELL_EQUIPMENT" }>>().toBeNever();
    expectTypeOf<"EQUIPMENT_NOT_OWNED">().toExtend<RejectionReason["code"]>();
  });

  it("results and rejection reasons are closed discriminated unions", () => {
    expectTypeOf<CommandResult["status"]>().toEqualTypeOf<"applied" | "queued" | "rejected">();
    // Every reason has a string-literal code, so switch statements can be exhaustive.
    expectTypeOf<RejectionReason["code"]>().not.toEqualTypeOf<string>();
  });
});
