import { describe, expect, expectTypeOf, it } from "vitest";
import { GAME_COMMAND_TYPES, type CommandResult, type GameCommandType, type RejectionReason } from "../src/index.ts";

describe("commands", () => {
  it("GAME_COMMAND_TYPES lists every command type exactly once", () => {
    expectTypeOf<(typeof GAME_COMMAND_TYPES)[number]>().toEqualTypeOf<GameCommandType>();
    expect(new Set(GAME_COMMAND_TYPES).size).toBe(GAME_COMMAND_TYPES.length);
  });

  it("results and rejection reasons are closed discriminated unions", () => {
    expectTypeOf<CommandResult["status"]>().toEqualTypeOf<"applied" | "queued" | "rejected">();
    // Every reason has a string-literal code, so switch statements can be exhaustive.
    expectTypeOf<RejectionReason["code"]>().not.toEqualTypeOf<string>();
  });
});
