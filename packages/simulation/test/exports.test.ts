// #56: the FIN-001 posting builders and `ledgerBalances` are importable from
// the package entry point (`@eov/simulation`), not only from `src/economy/ledger`.
import { describe, expect, it } from "vitest";
import * as ledger from "../src/economy/ledger/index.ts";
import * as game from "../src/game/index.ts";
import * as simulation from "../src/index.ts";

const LEDGER_EXPORTS = [
  "cargoLossEntries",
  "dispatchEntries",
  "equipmentPurchaseEntries",
  "impairmentEntries",
  "ledgerBalances",
  "materialPurchaseEntries",
  "payDownEntries",
  "payOrAccrueEntries",
  "productionEntries",
  "productionWriteOffEntries",
  "returnFromTransitEntries",
  "saleEntries",
] as const;

describe("ledger re-exports", () => {
  it.each(LEDGER_EXPORTS)("the package entry exports %s as a function", (name) => {
    expect(typeof simulation[name]).toBe("function");
    expect(simulation[name]).toBe(ledger[name]);
  });

  it.each(LEDGER_EXPORTS)("src/game exports %s as the same function", (name) => {
    expect(game[name]).toBe(ledger[name]);
  });
});
