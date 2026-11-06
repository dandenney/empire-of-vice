// Player-facing copy for buyers, suppliers, and shortages (issue #81, decided in #60).
import { describe, expect, it } from "vitest";
import { GAME_DATA } from "../src/index.ts";

const MAX_FLAVOR_LENGTH = 110;

function expectOneLine(text: string): void {
  expect(text.trim()).not.toBe("");
  expect(text).toBe(text.trim());
  expect(text).not.toMatch(/[\r\n]/);
}

describe("buyer, supplier, and shortage copy", () => {
  it("gives every buyer and supplier a short, single-line flavor with no numbers", () => {
    const entries = [...GAME_DATA.buyers, ...GAME_DATA.suppliers];
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expectOneLine(e.flavor);
      expect(e.flavor.length).toBeLessThanOrEqual(MAX_FLAVOR_LENGTH);
      expect(e.flavor).not.toMatch(/\d/);
    }
  });

  it("names every configured shortage", () => {
    const shortages = GAME_DATA.suppliers.flatMap((s) => s.stock.flatMap((st) => (st.shortage ? [st.shortage] : [])));
    expect(shortages.length).toBeGreaterThan(0);
    for (const s of shortages) expectOneLine(s.name);
  });
});
