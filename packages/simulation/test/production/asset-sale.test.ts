// SELL_EQUIPMENT and resale values (T05d #103; ADR 0020 decision 9; GDD §9
// recovery, §14.9; FIN-001).
//
// A sale is one ASSET_SALE transaction keyed ASSET_SALE:<commandId>: Dr CASH the
// proceeds, Dr LOSSES the shortfall, Cr EQUIPMENT the book value, with zero
// lines omitted. Buying a sold item back gets a per-command purchase key.
//
// Fixture data clears every equipment item's requiredUnlockId, so tests don't
// depend on which tier gates which item. Its resale ratio is set unchecked, so
// out-of-range values reach the validation.

import {
  applyRatios,
  asId,
  cents,
  idempotencyKey,
  RATIO_SCALE,
  ratio,
  ZERO_MONEY,
  type CommandResult,
  type EquipmentId,
  type FacilityId,
  type GameCommand,
  type GameState,
  type LedgerAccount,
  type LedgerEntry,
  type LedgerTransaction,
  type Money,
  type Ratio,
  type RejectionReason,
} from "@eov/contracts";
import {
  BASIC_MOONSHINE_RECIPE,
  COPPER_STILL,
  DISTILLERY_MAIN,
  FIRST_SHIPMENT_SCENARIO,
  GAME_DATA,
  IMPROVED_CONDENSER,
  MOONSHINE,
  QC_STATION,
  STORAGE_EXPANSION,
  type GameData,
  type ScenarioDefinition,
} from "@eov/game-data";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addMaterial, addProduct } from "../../src/inventory/index.ts";
import { resaleValue, storageCapacity, validateResaleRatio } from "../../src/production/index.ts";
import {
  balanceSheet,
  cashBalance,
  cashFlowStatement,
  createSimulation,
  ledgerBalances,
  newGame,
  simulationOptions,
  type GameSetup,
  type KernelSimulation,
} from "../../src/index.ts";

const UNKNOWN_FACILITY: FacilityId = asId("Facility", "fixture-nowhere");
const UNKNOWN_EQUIPMENT: EquipmentId = asId("Equipment", "fixture-no-such-equipment");
const ITEMS: readonly EquipmentId[] = [COPPER_STILL, IMPROVED_CONDENSER, QC_STATION, STORAGE_EXPANSION];

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The shipped data with no equipment locks, no job failures, and room for every item. */
function fixtureData(patch: { readonly ratio?: number; readonly prices?: Partial<Record<EquipmentId, number>> } = {}): GameData {
  return {
    ...GAME_DATA,
    equipment: GAME_DATA.equipment.map((e) => ({ ...e, requiredUnlockId: null, price: patch.prices?.[e.id] !== undefined ? cents(patch.prices[e.id]!) : e.price })),
    recipes: GAME_DATA.recipes.map((r) => ({ ...r, failureChance: ratio(0) })),
    facilityProduction: GAME_DATA.facilityProduction.map((f) => (f.facilityId === DISTILLERY_MAIN ? { ...f, equipmentSlots: GAME_DATA.equipment.length } : f)),
    progression: {
      ...GAME_DATA.progression,
      recovery: { ...GAME_DATA.progression.recovery, equipmentResaleRatio: (patch.ratio ?? GAME_DATA.progression.recovery.equipmentResaleRatio) as Ratio },
    },
  };
}

interface Game {
  sim: KernelSimulation;
  readonly setup: GameSetup;
}

function game(o: { readonly data?: GameData; readonly cash?: Money; readonly equipment?: readonly EquipmentId[] } = {}): Game {
  const s = FIRST_SHIPMENT_SCENARIO;
  const scenario: ScenarioDefinition = {
    ...s,
    openingBalance: { ...s.openingBalance, cash: o.cash ?? s.openingBalance.cash },
    facilities: s.facilities.map((f) => (f.id === DISTILLERY_MAIN ? { ...f, equipmentIds: o.equipment ?? f.equipmentIds } : f)),
  };
  const setup: GameSetup = { scenario, data: o.data ?? fixtureData() };
  return { sim: newGame(setup), setup };
}

function edit(g: Game, fn: (s: GameState) => GameState): void {
  g.sim = createSimulation(fn(g.sim.state), simulationOptions(g.setup));
}

const sell = (equipmentId: EquipmentId, facilityId: FacilityId = DISTILLERY_MAIN): GameCommand => ({ type: "SELL_EQUIPMENT", facilityId, equipmentId });
const buy = (equipmentId: EquipmentId, facilityId: FacilityId = DISTILLERY_MAIN): GameCommand => ({ type: "PURCHASE_EQUIPMENT", facilityId, equipmentId });

function applied(result: CommandResult): Extract<CommandResult, { status: "applied" }> {
  if (result.status !== "applied") throw new Error(`Expected applied, got ${JSON.stringify(result)}`);
  return result;
}

/** Rejected with exactly `reason`; rule 6: no state change and no events. */
function expectRejected(sim: KernelSimulation, command: GameCommand, reason: RejectionReason): void {
  sim.takeEvents();
  const before = sim.stateHash();
  const result = sim.dispatch({ command });
  if (result.status !== "rejected") throw new Error(`Expected rejected ${reason.code}, got ${JSON.stringify(result)}`);
  expect(result.reason).toEqual(reason);
  expect(sim.stateHash()).toBe(before);
  expect(sim.takeEvents()).toEqual([]);
}

function owned(state: GameState, facilityId: FacilityId = DISTILLERY_MAIN): readonly { readonly equipmentId: EquipmentId; readonly bookValue: Money }[] {
  return state.facilities.find((f) => f.id === facilityId)!.equipment;
}

function onlyTransaction(state: GameState, key: string): LedgerTransaction {
  const found = state.ledger.transactions.filter((t) => t.idempotencyKey === key);
  if (found.length !== 1) throw new Error(`Expected one transaction keyed ${key}, found ${found.length}`);
  return found[0]!;
}

/** The command behind a transaction, from its first event (transactions don't record it). */
function causeOf(state: GameState, t: LedgerTransaction): string | null | undefined {
  return state.eventJournal.find((e) => e.id === t.eventIds[0])?.causedBy;
}

const dr = (account: LedgerAccount, amount: number): LedgerEntry => ({ account, side: "DEBIT", amount: cents(amount) });
const cr = (account: LedgerAccount, amount: number): LedgerEntry => ({ account, side: "CREDIT", amount: cents(amount) });

function sorted(entries: readonly LedgerEntry[]): LedgerEntry[] {
  const key = (e: LedgerEntry) => `${e.side}/${e.account}/${String(e.amount).padStart(20, "0")}`;
  return [...entries].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

const netWorth = (state: GameState): number => {
  const sheet = balanceSheet(state);
  return sheet.assets - sheet.liabilities;
};

/** The transaction's cash flow lines, without the zero ones. */
function cashFlowOf(t: LedgerTransaction): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of cashFlowStatement(ZERO_MONEY, [t]).lines) if (line.amount !== 0) out[line.category] = line.amount;
  return out;
}

/** The FIN-001 checks this file cares about, independent of the coordinator's. */
function expectBooksBalance(state: GameState): void {
  const balances = ledgerBalances(state.ledger.transactions);
  const sheet = balanceSheet(state);
  expect(sheet.assets).toBe(sheet.liabilities + sheet.equity + sheet.netIncome);
  expect(balances.CASH).toBeGreaterThanOrEqual(0);
  const books = state.facilities.reduce((n, f) => n + f.equipment.reduce((m, e) => m + e.bookValue, 0), 0);
  expect(balances.EQUIPMENT).toBe(books);
  for (const t of state.ledger.transactions) for (const e of t.entries) expect(e.amount).toBeGreaterThan(0);
}

// ===========================================================================

describe("SELL_EQUIPMENT rejections (ADR 0020 decision 9)", () => {
  it("checks the facility, then the equipment definition, then ownership, and changes nothing on a rejection", () => {
    const { sim } = game();
    expectRejected(sim, sell(UNKNOWN_EQUIPMENT, UNKNOWN_FACILITY), { code: "UNKNOWN_ENTITY", kind: "Facility", id: UNKNOWN_FACILITY });
    expectRejected(sim, sell(COPPER_STILL, UNKNOWN_FACILITY), { code: "UNKNOWN_ENTITY", kind: "Facility", id: UNKNOWN_FACILITY });
    expectRejected(sim, sell(UNKNOWN_EQUIPMENT), { code: "UNKNOWN_ENTITY", kind: "Equipment", id: UNKNOWN_EQUIPMENT });
    expectRejected(sim, sell(IMPROVED_CONDENSER), { code: "EQUIPMENT_NOT_OWNED", facilityId: DISTILLERY_MAIN, equipmentId: IMPROVED_CONDENSER });
  });

  it("rejects selling an item twice", () => {
    const { sim } = game();
    applied(sim.dispatch({ command: sell(COPPER_STILL) }));
    expectRejected(sim, sell(COPPER_STILL), { code: "EQUIPMENT_NOT_OWNED", facilityId: DISTILLERY_MAIN, equipmentId: COPPER_STILL });
  });
});

describe("a sale", () => {
  it("is one ASSET_SALE transaction keyed ASSET_SALE:<commandId>: Dr CASH proceeds, Dr LOSSES the rest, Cr EQUIPMENT the book value", () => {
    const g = game();
    const { sim } = g;
    const bookValue = owned(sim.state).find((e) => e.equipmentId === COPPER_STILL)!.bookValue;
    const proceeds = applyRatios(bookValue, [GAME_DATA.progression.recovery.equipmentResaleRatio]);
    expect(proceeds).toBe(cents(15_000));
    const worthBefore = netWorth(sim.state);
    const cashBefore = cashBalance(sim.state);
    sim.takeEvents();

    const result = applied(sim.dispatch({ command: sell(COPPER_STILL) }));
    const s = sim.state;
    const t = onlyTransaction(s, idempotencyKey("ASSET_SALE", result.commandId));
    expect(t.kind).toBe("ASSET_SALE");
    expect(causeOf(s, t)).toBe(result.commandId);
    expect(sorted(t.entries)).toEqual(sorted([dr("CASH", proceeds), dr("LOSSES", bookValue - proceeds), cr("EQUIPMENT", bookValue)]));
    expect(owned(s).map((e) => e.equipmentId)).not.toContain(COPPER_STILL);
    expect(cashBalance(s)).toBe(cashBefore + proceeds);
    expect(netWorth(s)).toBe(worthBefore - (bookValue - proceeds));
    expect(cashFlowOf(t)).toEqual({ ASSET_SALES: proceeds });
    expectBooksBalance(s);

    const events = sim.takeEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "EQUIPMENT_SOLD", facilityId: DISTILLERY_MAIN, equipmentId: COPPER_STILL, bookValue, proceeds, transactionId: t.id });
    expect(t.eventIds).toEqual([events[0]!.id]);
  });

  it("files under ASSET_SALES in the snapshot's cash flow", () => {
    const { sim } = game();
    applied(sim.dispatch({ command: sell(COPPER_STILL) }));
    const lines = sim.snapshot().finance.toDate.cashFlow.lines;
    expect(lines.find((l) => l.category === "ASSET_SALES")!.amount).toBe(cents(15_000));
  });

  it("omits a 0¢ loss line: a 1¢ item sells for 1¢, Dr CASH / Cr EQUIPMENT, and files under EQUIPMENT", () => {
    const { sim } = game({ data: fixtureData({ prices: { [IMPROVED_CONDENSER]: 1 } }) });
    applied(sim.dispatch({ command: buy(IMPROVED_CONDENSER) }));
    const worthBefore = netWorth(sim.state);
    const result = applied(sim.dispatch({ command: sell(IMPROVED_CONDENSER) }));
    const t = onlyTransaction(sim.state, idempotencyKey("ASSET_SALE", result.commandId));
    expect(sorted(t.entries)).toEqual(sorted([dr("CASH", 1), cr("EQUIPMENT", 1)]));
    expect(cashFlowOf(t)).toEqual({ EQUIPMENT: 1 });
    expect(netWorth(sim.state)).toBe(worthBefore);
    expect(sim.state.eventJournal.at(-1)).toMatchObject({ type: "EQUIPMENT_SOLD", bookValue: 1, proceeds: 1 });
    expectBooksBalance(sim.state);
  });

  it("omits a 0¢ cash line: at a 1 ppm ratio a 1¢ item sells for nothing, Dr LOSSES / Cr EQUIPMENT", () => {
    const { sim } = game({ data: fixtureData({ ratio: 1, prices: { [IMPROVED_CONDENSER]: 1 } }) });
    applied(sim.dispatch({ command: buy(IMPROVED_CONDENSER) }));
    const worthBefore = netWorth(sim.state);
    const result = applied(sim.dispatch({ command: sell(IMPROVED_CONDENSER) }));
    const t = onlyTransaction(sim.state, idempotencyKey("ASSET_SALE", result.commandId));
    expect(sorted(t.entries)).toEqual(sorted([dr("LOSSES", 1), cr("EQUIPMENT", 1)]));
    expect(cashFlowOf(t)).toEqual({});
    expect(netWorth(sim.state)).toBe(worthBefore - 1);
    expectBooksBalance(sim.state);
  });
});

describe("buying a sold item back", () => {
  it("keeps the base key for the first purchase and keys the buy-back by its command ID", () => {
    const { sim } = game();
    const first = applied(sim.dispatch({ command: buy(IMPROVED_CONDENSER) }));
    const baseKey = idempotencyKey("EQUIPMENT_PURCHASE", DISTILLERY_MAIN, IMPROVED_CONDENSER);
    expect(causeOf(sim.state, onlyTransaction(sim.state, baseKey))).toBe(first.commandId);
    applied(sim.dispatch({ command: sell(IMPROVED_CONDENSER) }));

    const again = applied(sim.dispatch({ command: buy(IMPROVED_CONDENSER) }));
    expect(again.eventIds.length).toBeGreaterThan(0);
    const t = onlyTransaction(sim.state, idempotencyKey("EQUIPMENT_PURCHASE", DISTILLERY_MAIN, IMPROVED_CONDENSER, again.commandId));
    expect(t.kind).toBe("EQUIPMENT_PURCHASE");
    expect(owned(sim.state).find((e) => e.equipmentId === IMPROVED_CONDENSER)!.bookValue).toBe(GAME_DATA.equipment.find((e) => e.id === IMPROVED_CONDENSER)!.price);
    expect(sim.state.eventJournal.at(-1)).toMatchObject({ type: "EQUIPMENT_PURCHASED", equipmentId: IMPROVED_CONDENSER, transactionId: t.id });
    expectBooksBalance(sim.state);
  });

  it("a scenario item has no purchase transaction, so its first buy-back takes the base key", () => {
    const { sim } = game();
    applied(sim.dispatch({ command: sell(COPPER_STILL) }));
    const result = applied(sim.dispatch({ command: buy(COPPER_STILL) }));
    expect(causeOf(sim.state, onlyTransaction(sim.state, idempotencyKey("EQUIPMENT_PURCHASE", DISTILLERY_MAIN, COPPER_STILL)))).toBe(result.commandId);
  });

  it("random buy, sell, and buy-back sequences keep the books balanced and lose exactly book − proceeds per sale", () => {
    const step = fc.record({ sell: fc.boolean(), item: fc.constantFrom(...ITEMS) });
    fc.assert(
      fc.property(fc.array(step, { maxLength: 24 }), fc.integer({ min: 1, max: RATIO_SCALE - 1 }), (steps, resale) => {
        const data = fixtureData({ ratio: resale });
        const { sim } = game({ data, cash: cents(10_000_000) });
        for (const { sell: selling, item } of steps) {
          const before = sim.state;
          const hashBefore = sim.stateHash();
          const book = owned(before).find((e) => e.equipmentId === item)?.bookValue;
          const result = sim.dispatch({ command: selling ? sell(item) : buy(item) });
          const after = sim.state;
          if (selling && book !== undefined) {
            expect(result.status).toBe("applied");
            const proceeds = resaleValue(book, data);
            expect(netWorth(after)).toBe(netWorth(before) - (book - proceeds));
            expect(cashBalance(after)).toBe(cashBalance(before) + proceeds);
          } else if (!selling && book === undefined) {
            expect(result.status).toBe("applied");
            expect(netWorth(after)).toBe(netWorth(before));
          } else {
            expect(result.status).toBe("rejected");
            expect(sim.stateHash()).toBe(hashBefore);
          }
          expectBooksBalance(after);
        }
        const keys = sim.state.ledger.transactions.map((t) => t.idempotencyKey);
        expect(new Set(keys).size).toBe(keys.length);
      }),
      { numRuns: 60 },
    );
  });
});

describe("what a sale doesn't change", () => {
  it("a running job keeps its completesAt and completes after the still it uses is sold", () => {
    const g = game({ equipment: [COPPER_STILL, IMPROVED_CONDENSER] });
    const recipe = GAME_DATA.recipes.find((r) => r.id === BASIC_MOONSHINE_RECIPE)!;
    edit(g, (s) => recipe.inputsPerCase.reduce((acc, i) => addMaterial(acc, DISTILLERY_MAIN, i.materialId, i.quantity * 5, ZERO_MONEY), s));
    applied(g.sim.dispatch({ command: { type: "START_PRODUCTION", facilityId: DISTILLERY_MAIN, recipeId: BASIC_MOONSHINE_RECIPE, quantity: 5 } }));
    const job = g.sim.state.productionJobs[0]!;
    applied(g.sim.dispatch({ command: sell(IMPROVED_CONDENSER) }));
    applied(g.sim.dispatch({ command: sell(COPPER_STILL) }));
    expect(g.sim.state.productionJobs).toEqual([job]);
    g.sim.advance(job.completesAt - g.sim.state.tick);
    expect(g.sim.state.productionJobs).toEqual([]);
    expect(g.sim.state.eventJournal.some((e) => e.type === "PRODUCTION_COMPLETED" && e.jobId === job.id)).toBe(true);
    expect(g.sim.state.productPools.find((p) => p.facilityId === DISTILLERY_MAIN && p.productId === MOONSHINE)!.quantity).toBe(5);
  });

  it("selling the storage expansion can leave the facility over capacity: starts are blocked and no cases are lost", () => {
    const data = fixtureData();
    const g = game({ data, equipment: [COPPER_STILL, STORAGE_EXPANSION] });
    const bonus = data.equipment.find((e) => e.id === STORAGE_EXPANSION)!.storageBonus;
    expect(bonus).toBeGreaterThan(0);
    const base = storageCapacity(g.sim.state, data, DISTILLERY_MAIN) - bonus;
    const held = base + 20;
    edit(g, (s) => addProduct(s, DISTILLERY_MAIN, MOONSHINE, "basic", held, ZERO_MONEY));
    applied(g.sim.dispatch({ command: sell(STORAGE_EXPANSION) }));
    expect(storageCapacity(g.sim.state, data, DISTILLERY_MAIN)).toBe(base);
    expect(g.sim.state.productPools.find((p) => p.facilityId === DISTILLERY_MAIN && p.productId === MOONSHINE)!.quantity).toBe(held);
    expectRejected(g.sim, { type: "START_PRODUCTION", facilityId: DISTILLERY_MAIN, recipeId: BASIC_MOONSHINE_RECIPE, quantity: 1 }, {
      code: "STORAGE_CAPACITY_EXCEEDED",
      facilityId: DISTILLERY_MAIN,
      requested: 1,
      available: 0,
    });
    const facility = g.sim.snapshot().facilities.find((f) => f.id === DISTILLERY_MAIN)!;
    expect(facility.storage).toEqual({ used: held, capacity: base });
  });
});

describe("resale values", () => {
  it("resaleValue applies the ratio once, rounding half up", () => {
    expect(resaleValue(cents(30_000), GAME_DATA)).toBe(cents(15_000));
    expect(resaleValue(cents(1), GAME_DATA)).toBe(cents(1));
    expect(resaleValue(cents(3), GAME_DATA)).toBe(cents(2));
    expect(resaleValue(cents(3), fixtureData({ ratio: 1 }))).toBe(cents(0));
  });

  it("the snapshot shows each owned item's resaleValue", () => {
    const { sim } = game({ equipment: ITEMS });
    const equipment = sim.snapshot().facilities.find((f) => f.id === DISTILLERY_MAIN)!.equipment;
    expect(equipment.map((e) => e.id)).toEqual([...ITEMS].sort());
    for (const e of equipment) expect(e.resaleValue).toBe(applyRatios(e.bookValue, [GAME_DATA.progression.recovery.equipmentResaleRatio]));
  });

  it("validates the ratio in (0, RATIO_SCALE) when the systems are built", () => {
    for (const bad of [0, RATIO_SCALE, RATIO_SCALE + 1, -1]) {
      const data = fixtureData({ ratio: bad });
      expect(() => validateResaleRatio(data), `${bad}`).toThrow(RangeError);
      expect(() => game({ data }), `${bad}`).toThrow(RangeError);
    }
    expect(() => validateResaleRatio(fixtureData({ ratio: 1.5 }))).toThrow(RangeError);
    for (const ok of [1, RATIO_SCALE - 1]) expect(() => game({ data: fixtureData({ ratio: ok }) })).not.toThrow();
  });
});
