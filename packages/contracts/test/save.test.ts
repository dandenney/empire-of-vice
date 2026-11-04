import { describe, expect, expectTypeOf, it } from "vitest";
import {
  DYNAMIC_ID_KINDS,
  RNG_STREAMS,
  SAVE_SCHEMA_VERSION,
  type GameState,
  type SaveFile,
  type SaveGame,
} from "../src/index.ts";
import type { IsPlainData } from "./plain-data.ts";

describe("save format", () => {
  it("state, saves, and save files are plain JSON-safe data with no optional fields", () => {
    expectTypeOf<IsPlainData<GameState>>().toEqualTypeOf<true>();
    expectTypeOf<IsPlainData<SaveGame>>().toEqualTypeOf<true>();
    expectTypeOf<IsPlainData<SaveFile>>().toEqualTypeOf<true>();
  });

  it("starts at schema version 1", () => {
    expect(SAVE_SCHEMA_VERSION).toBe(1);
  });

  it("has a counter for every dynamic ID kind and an RNG state for every stream", () => {
    expectTypeOf<keyof GameState["counters"]["nextId"]>().toEqualTypeOf<(typeof DYNAMIC_ID_KINDS)[number]>();
    expectTypeOf<keyof GameState["rng"]>().toEqualTypeOf<(typeof RNG_STREAMS)[number]>();
  });
});
