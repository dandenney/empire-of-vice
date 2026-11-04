// Smoke test: Vitest and fast-check are wired up for the simulation package.
import fc from "fast-check";
import { describe, it } from "vitest";

describe("test tooling", () => {
  it("runs fast-check properties with a fixed seed", () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => a + b === b + a),
      { seed: 1920 },
    );
  });
});
