import {
  applyRatios,
  cents,
  gameEventSchema,
  ledgerTransactionSchema,
  rejectionReasonSchema,
  SNAPSHOT_RECENT_EVENTS,
  type GameSnapshot,
} from "@eov/contracts";
import { midGameSnapshot, startOfGameSnapshot } from "@eov/contracts/fixtures";
import {
  BASIC_MOONSHINE_RECIPE,
  COPPER_STILL,
  CROSSROADS_ROADHOUSE,
  DISTILLERY_MAIN,
  FIRST_SHIPMENT_SCENARIO,
  GAME_DATA,
  HOLLOW_CREEK,
  MODEL_TT_TRUCK,
} from "@eov/game-data";
import { describe, expect, it } from "vitest";
import { loadGame, newGame, SYSTEMS, type KernelSimulation } from "../../src/index.ts";
import { newGame as newGameWithoutProjection } from "../../src/game/index.ts";
import { SNAPSHOT_RECENT_TRANSACTIONS, UNDEFINED_IN_GAME_DATA } from "../../src/projection/index.ts";
import { advanceTo, buyCorn, buySugar, expectApplied, produce, sell } from "../sprint-zero/helpers.ts";
import { shapeDifferences, undefinedPaths } from "./shape.ts";

const distillery = (s: GameSnapshot) => s.facilities.find((f) => f.id === DISTILLERY_MAIN)!;
const basicRecipe = (s: GameSnapshot) => distillery(s).recipes.find((r) => r.recipeId === BASIC_MOONSHINE_RECIPE)!;
const roadhouseWant = (s: GameSnapshot) => s.market.buyers.find((b) => b.id === CROSSROADS_ROADHOUSE)!.wants[0]!;

/** Plays the Sprint Zero path through snapshots, the way the UI does: every input comes from the last snapshot. */
function playPath(): { sim: KernelSimulation; snapshots: Record<string, GameSnapshot> } {
  const sim = newGame();
  const snapshots: Record<string, GameSnapshot> = { start: sim.snapshot() };
  for (const input of basicRecipe(snapshots.start!).inputsPerCase) {
    expectApplied(sim.dispatch({ command: input.materialId === "corn" ? buyCorn(input.quantity) : buySugar(input.quantity) }));
  }
  snapshots.bought = sim.snapshot();
  expectApplied(sim.dispatch({ command: produce(1) }));
  snapshots.producing = sim.snapshot();
  advanceTo(sim, snapshots.producing.productionJobs[0]!.completesAt);
  snapshots.produced = sim.snapshot();
  expectApplied(sim.dispatch({ command: sell(1, roadhouseWant(snapshots.produced).unitPrice) }));
  snapshots.dispatched = sim.snapshot();
  advanceTo(sim, snapshots.dispatched.vehicles[0]!.trip!.arrivesAt);
  snapshots.sold = sim.snapshot();
  advanceTo(sim, snapshots.sold.vehicles[0]!.trip!.arrivesAt);
  snapshots.home = sim.snapshot();
  return { sim, snapshots };
}

describe("snapshot projection", () => {
  it("is registered for every game created through the package", () => {
    expect(SYSTEMS.map((s) => s.name)).toContain("snapshot projection (S0b)");
    expect(() => newGame().snapshot()).not.toThrow();
    expect(() => newGameWithoutProjection({ systems: SYSTEMS.filter((s) => s.name !== "snapshot projection (S0b)") }).snapshot()).toThrow(/projection/);
  });

  it("has the contract fixtures' shape at every step of the path", () => {
    const { snapshots } = playPath();
    for (const [step, snapshot] of Object.entries(snapshots)) {
      expect(shapeDifferences(snapshot, startOfGameSnapshot), step).toEqual([]);
      expect(shapeDifferences(snapshot, midGameSnapshot), step).toEqual([]);
      expect(undefinedPaths(snapshot), step).toEqual([]);
      // Plain data: survives JSON and structured clone unchanged (postMessage).
      expect(JSON.parse(JSON.stringify(snapshot)), step).toEqual(snapshot);
      expect(structuredClone(snapshot), step).toEqual(snapshot);
      for (const event of snapshot.recentEvents) expect(gameEventSchema.safeParse(event).success, `${step} ${event.type}`).toBe(true);
      for (const t of snapshot.finance.recentTransactions) expect(ledgerTransactionSchema.safeParse(t).success, `${step} ${t.id}`).toBe(true);
    }
    // The steps with something in flight fill the shapes the start fixture leaves empty.
    expect(snapshots.producing!.productionJobs).toHaveLength(1);
    expect(snapshots.dispatched!.vehicles[0]!.trip).not.toBeNull();
    expect(snapshots.produced!.facilities[0]!.products).toHaveLength(1);
  });

  it("shape check catches missing, extra, and mistyped fields", () => {
    const s = newGame().snapshot();
    const withoutClock: Partial<Record<keyof GameSnapshot, unknown>> = { ...s };
    delete withoutClock.clock;
    expect(shapeDifferences(withoutClock, startOfGameSnapshot)).toEqual(["snapshot.clock: missing"]);
    expect(shapeDifferences({ ...s, extra: 1 }, startOfGameSnapshot)).toEqual(["snapshot.extra: not in the contract fixture"]);
    const mistyped = { ...s, finance: { ...s.finance, cash: "100000" } };
    expect(shapeDifferences(mistyped, startOfGameSnapshot)).toEqual(["snapshot.finance.cash: string vs number"]);
  });

  it("starts from the scenario: clock, cash, opening balance sheet, and display names", () => {
    const s = newGame().snapshot();
    expect(s.clock).toEqual({ tick: 0, dayIndex: 0, date: { year: 1920, month: 1, day: 17, hour: 0, minute: 0 } });
    expect(s.outcome).toEqual({ status: "PLAYING" });
    expect(s.finance.cash).toBe(cents(100_000));
    expect(s.finance.balanceSheet.assets).toEqual({
      cash: cents(100_000),
      rawMaterials: 0,
      finishedGoods: 0,
      goodsInTransit: 0,
      receivables: 0,
      equipment: cents(30_000),
      vehicles: cents(40_000),
      facilities: cents(80_000),
    });
    expect(s.finance.netWorth).toBe(cents(250_000));
    expect(s.finance.previousDay).toBeNull();
    expect(s.finance.toDate.cashFlow.openingCash).toBe(cents(100_000));
    expect(s.finance.recentTransactions.map((t) => t.kind)).toEqual(["OPENING_BALANCE"]);
    expect(distillery(s)).toMatchObject({ name: "Hollow Creek distillery", locationId: HOLLOW_CREEK, kind: "DISTILLERY", productionCapacityPerDay: 10 });
    expect(distillery(s).equipment).toEqual([
      { id: COPPER_STILL, name: "Copper still", bookValue: cents(30_000), resaleValue: UNDEFINED_IN_GAME_DATA.equipmentResaleValue },
    ]);
    expect(s.vehicles).toEqual([{ id: MODEL_TT_TRUCK, name: "Model TT truck", capacity: 20, homeLocationId: HOLLOW_CREEK, trip: null }]);
    expect(s.market.suppliers[0]!.materials.map((m) => [m.materialName, m.unitPrice, m.available, m.shortage])).toEqual([
      ["Corn", cents(250), 160, false],
      ["Sugar", cents(200), 100, false],
    ]);
    // Opening quotes are spot (= base price) × the want's price ratio. A buyer deals
    // only at or above its minimum reputation, and then takes at most
    // min(daily demand, budget / quote) (GDD §7, ADR 0016).
    const reputation = FIRST_SHIPMENT_SCENARIO.family.reputation;
    expect(s.market.buyers.map((b) => [b.name, b.minimumReputation, b.willDeal, b.wants[0]!.unitPrice, b.wants[0]!.maxAcceptableQuantity])).toEqual(
      GAME_DATA.buyers.map((def) => {
        const want = def.wants[0]!;
        const quote = applyRatios(GAME_DATA.products.find((p) => p.id === want.productId)!.basePrice[want.minimumQuality], [want.priceRatio]);
        const willDeal = reputation >= def.minimumReputation;
        return [def.name, def.minimumReputation, willDeal, quote, willDeal ? Math.min(want.dailyDemand, Math.floor(def.dailyBudget / quote)) : 0];
      }),
    );
    expect(s.market.products.map((p) => [p.quality, p.basePrice, p.spotPrice, p.demandRatioPpm, p.supplyRatioPpm, p.previousSpotPrice])).toEqual([
      ["basic", cents(1_400), cents(1_400), 1_000_000, 1_000_000, null],
      ["standard", cents(2_000), cents(2_000), 1_000_000, 1_000_000, null],
    ]);
    expect(s.locations.map((l) => [l.id, l.occupant.kind])).toEqual([
      ["crossroads", "BUYER"],
      ["hollow-creek", "FACILITY"],
      ["kessler-pharmacy", "BUYER"],
      ["lakeview", "BUYER"],
      ["millers-feed", "SUPPLIER"],
    ]);
    // A safe default and a risky alternative per buyer (ADR 0019 decision 1), by ID.
    expect(s.routes.map((r) => [r.id, r.status])).toEqual([
      ["county-road", { open: true }],
      ["crossroads-back-road", { open: true }],
      ["kessler-back-road", { open: true }],
      ["lake-shore-drive", { open: true }],
      ["lakeview-back-road", { open: true }],
      ["state-highway", { open: true }],
    ]);
  });

  it("reports sections with no system yet as empty lists and the scenario's values, never invented numbers", () => {
    const s = newGame().snapshot();
    expect(s.contracts).toEqual({ offers: [], active: [], closed: [] });
    // Leaders are game-data's characters since T02c2 (#63), by ID.
    expect(s.family).toEqual({
      id: "kerrigan",
      name: "kerrigan",
      reputation: 0,
      leaders: [...GAME_DATA.characters]
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((c) => ({ id: c.id, name: c.name, role: c.role, skill: c.skill, loyalty: c.loyalty, dailyWage: c.dailyWage })),
    });
    expect(s.progression).toEqual({
      currentTierId: "starting-operation",
      tiers: [{ id: "starting-operation", name: "starting-operation", netWorthRequired: null, reputationRequired: null, unlocks: ["spot-sales"], reached: true }],
      unlocked: ["spot-sales"],
      victory: {
        netWorth: { current: cents(250_000), target: UNDEFINED_IN_GAME_DATA.victoryNetWorth },
        reputation: { current: 0, target: 0 },
        completedContracts: { current: 0, target: 0 },
      },
    });
    // Equipment options and slots come from game-data since T02c1 (#7): every unowned item, by ID.
    const owned: readonly string[] = [COPPER_STILL];
    expect(distillery(s).equipmentOptions.map((o) => o.equipmentId)).toEqual(
      GAME_DATA.equipment.map((e) => e.id).filter((id) => !owned.includes(id)).sort(),
    );
    const spec = GAME_DATA.facilityProduction.find((f) => f.facilityId === DISTILLERY_MAIN)!;
    expect(distillery(s).equipmentSlots).toEqual({ used: 1, total: spec.equipmentSlots });
    expect(distillery(s).storage).toEqual({ used: 0, capacity: spec.baseStorage });
    expect(distillery(s).workforce).toEqual({ workers: 3, maximum: spec.maximumWorkers, dailyWagePerWorker: GAME_DATA.workforce.workerDailyWage });
  });

  it("takes blockedBy from the handler's real rejection, and never changes state", () => {
    const sim = newGame();
    const before = sim.stateHash();
    const blocked = basicRecipe(sim.snapshot());
    expect(sim.stateHash()).toBe(before);
    expect(blocked.maxStartableQuantity).toBe(0);
    expect(rejectionReasonSchema.safeParse(blocked.blockedBy).success).toBe(true);
    const dispatched = sim.dispatch({ command: produce(1) });
    expect(dispatched.status === "rejected" && dispatched.reason).toEqual(blocked.blockedBy);
    expect(blocked.blockedBy).toEqual({ code: "INSUFFICIENT_MATERIALS", materialId: "corn", required: 2, available: 0 });

    // Enough corn and sugar for 7 cases: the largest startable quantity is what the handler accepts.
    expectApplied(sim.dispatch({ command: buyCorn(14) }));
    expectApplied(sim.dispatch({ command: buySugar(9) }));
    const ready = basicRecipe(sim.snapshot());
    expect(ready).toMatchObject({ blockedBy: null, maxStartableQuantity: 7 });
    expect(sim.dispatch({ command: produce(8) }).status).toBe("rejected");
    expectApplied(sim.dispatch({ command: produce(7) }));

    // One job per facility in the S0 stub: the next start is blocked by capacity.
    const busy = basicRecipe(sim.snapshot());
    expect(busy.blockedBy).toEqual({ code: "PRODUCTION_CAPACITY_EXCEEDED", facilityId: DISTILLERY_MAIN, requested: 1, available: 0 });
    expect(busy.maxStartableQuantity).toBe(0);
  });

  it("tracks inventory, reservations, the job, and the truck along the path", () => {
    const { snapshots } = playPath();
    expect(distillery(snapshots.bought!).materials.map((m) => [m.materialName, m.quantity, m.reservedQuantity, m.totalCost])).toEqual([
      ["Corn", 2, 0, cents(500)],
      ["Sugar", 1, 0, cents(200)],
    ]);
    expect(distillery(snapshots.producing!).materials.map((m) => m.reservedQuantity)).toEqual([2, 1]);
    expect(snapshots.producing!.productionJobs[0]).toMatchObject({ facilityId: DISTILLERY_MAIN, productId: "moonshine", quality: "basic", quantity: 1, startedAt: 1, completesAt: 145 });
    expect(distillery(snapshots.produced!).products).toEqual([
      { productId: "moonshine", productName: "Moonshine", quality: "basic", quantity: 1, reservedQuantity: 0, totalCost: cents(1_100), averageUnitCost: cents(1_100) },
    ]);
    expect(distillery(snapshots.produced!).storage.used).toBe(1);
    const trip = snapshots.dispatched!.vehicles[0]!.trip!;
    expect(trip).toMatchObject({ routeId: "state-highway", leg: "OUTBOUND", cargo: [{ productId: "moonshine", quality: "basic", quantity: 1 }] });
    expect(trip.purpose).toEqual({ kind: "SALE", buyerId: CROSSROADS_ROADHOUSE, agreedUnitPrice: cents(1_400) });
    // One case committed: demand and budget each drop by one case (GDD §7 liquidity).
    const roadhouse = GAME_DATA.buyers.find((b) => b.id === CROSSROADS_ROADHOUSE)!;
    const daily = roadhouse.wants[0]!.dailyDemand;
    const afterOne = Math.min(daily - 1, Math.floor((roadhouse.dailyBudget - cents(1_400)) / cents(1_400)));
    expect(roadhouseWant(snapshots.dispatched!)).toMatchObject({ demandRemaining: daily - 1, maxAcceptableQuantity: afterOne });
    expect(snapshots.sold!.vehicles[0]!.trip!.leg).toBe("RETURN");
    expect(snapshots.home!.vehicles[0]!.trip).toBeNull();
  });

  it("records the profit: $14.00 revenue, $11.00 cost of goods, $1.50 transport, $1.50 net", () => {
    const { snapshots } = playPath();
    const profit = snapshots.home!.finance.toDate.profit;
    // The state highway's $1.50 transport is paid when the truck gets home (ADR 0019 decision 2).
    expect(profit).toMatchObject({ revenue: cents(1_400), costOfGoodsSold: cents(1_100), grossProfit: cents(300), gains: 0, netProfit: cents(150) });
    expect(profit.expenses.map((e) => e.category)).toEqual(["WAGES", "OVERHEAD", "TRANSPORT", "PENALTIES", "LOSSES"]);
    // Profit and cash flow differ: cash paid for materials and labor before the sale.
    expect(snapshots.produced!.finance.toDate.profit.netProfit).toBe(0);
    expect(snapshots.produced!.finance.toDate.cashFlow.netChange).toBe(cents(-1_100));
    const flow = snapshots.home!.finance.toDate.cashFlow;
    expect(Object.fromEntries(flow.lines.map((l) => [l.category, l.amount]))).toMatchObject({
      SALES: cents(1_400),
      MATERIALS: cents(-700),
      WAGES: cents(-400),
      TRANSPORT: cents(-150),
    });
    expect(flow.closingCash).toBe(snapshots.home!.finance.cash);
    expect(snapshots.home!.finance.netWorth).toBe(cents(250_150));
  });

  it("reports a vehicle return as the transaction that pays the trip's transport cost", () => {
    const { snapshots } = playPath();
    const sold = snapshots.sold!.finance;
    const home = snapshots.home!.finance;
    const returned = home.recentTransactions.at(-1)!;
    // ADR 0019 decision 2: the driver is paid on return, in cash while there is cash.
    expect(returned).toMatchObject({
      kind: "VEHICLE_RETURN",
      entries: [
        { account: "TRANSPORT_EXPENSE", side: "DEBIT", amount: cents(150) },
        { account: "CASH", side: "CREDIT", amount: cents(150) },
      ],
    });
    expect(sold.recentTransactions.map((t) => t.kind)).not.toContain("VEHICLE_RETURN");
    // Cash flow files it under TRANSPORT. Cash and profit drop by the charge; nothing else moves.
    expect(home.toDate.cashFlow.netChange).toBe(sold.toDate.cashFlow.netChange - cents(150));
    expect(Object.fromEntries(home.toDate.cashFlow.lines.map((l) => [l.category, l.amount]))).toMatchObject({ TRANSPORT: cents(-150) });
    expect(home.toDate.profit.netProfit).toBe(sold.toDate.profit.netProfit - cents(150));
    expect(home.balanceSheet.assets).toEqual({ ...sold.balanceSheet.assets, cash: sold.balanceSheet.assets.cash - cents(150) });
    expect(home.balanceSheet.liabilities).toEqual(sold.balanceSheet.liabilities);
  });

  it("reconciles: equity = net worth = assets − liabilities, and net worth − profit = opening equity", () => {
    const { snapshots } = playPath();
    for (const [step, s] of Object.entries(snapshots)) {
      const sheet = s.finance.balanceSheet;
      expect(sheet.totalAssets, step).toBe(Object.values(sheet.assets).reduce((a, b) => a + b, 0));
      expect(sheet.equity, step).toBe(sheet.totalAssets - sheet.totalLiabilities);
      expect(s.finance.netWorth, step).toBe(sheet.equity);
      expect(s.finance.netWorth - s.finance.toDate.profit.netProfit, step).toBe(cents(250_000));
      expect(s.finance.toDate.cashFlow.closingCash, step).toBe(s.finance.cash);
      expect(s.progression.victory.netWorth.current, step).toBe(s.finance.netWorth);
    }
  });

  it("splits finance into today and the previous day at midnight", () => {
    const { sim } = playPath();
    const sameDay = sim.snapshot();
    // $3.00 gross profit less the $1.50 transport paid at the truck's return (ADR 0019 decision 2).
    expect(sameDay.finance.today.profit.netProfit).toBe(cents(150));
    // The midnight settlement (T02c2, #63) expenses tonight's wages and overhead into the day that ended.
    const wages =
      GAME_DATA.characters.reduce((n, c) => n + c.dailyWage, 0) +
      sim.state.facilities.reduce((n, f) => n + f.workerCount * GAME_DATA.workforce.workerDailyWage, 0);
    const overhead = GAME_DATA.facilityProduction.reduce((n, f) => n + f.dailyOverhead, 0);
    sim.advance(1_440 - sim.state.tick);
    const nextDay = sim.snapshot();
    expect(nextDay.clock.dayIndex).toBe(1);
    expect(nextDay.finance.today).toMatchObject({ fromTick: 1_440, toTick: 1_440 });
    expect(nextDay.finance.today.profit.netProfit).toBe(0);
    expect(nextDay.finance.previousDay).toMatchObject({ fromTick: 0, toTick: 1_440 });
    expect(nextDay.finance.previousDay!.profit.netProfit).toBe(cents(150) - wages - overhead);
    expect(nextDay.finance.today.cashFlow.openingCash).toBe(nextDay.finance.previousDay!.cashFlow.closingCash);
  });

  it("sorts fixed-data lists by ID and keeps the most recent events and transactions", () => {
    const { snapshots } = playPath();
    const s = snapshots.home!;
    for (const list of [s.locations, s.routes, s.facilities, s.vehicles, s.market.suppliers, s.market.buyers]) {
      const ids = list.map((x) => x.id);
      expect(ids).toEqual([...ids].sort());
    }
    expect(s.recentEvents.map((e) => e.type)).toEqual([
      "MATERIALS_PURCHASED",
      "MATERIALS_PURCHASED",
      "PRODUCTION_STARTED",
      // One per consumed reservation (corn, sugar), before the completion (ADR 0010).
      "RESERVATION_RELEASED",
      "RESERVATION_RELEASED",
      "PRODUCTION_COMPLETED",
      "DELIVERY_DISPATCHED",
      "SALE_COMPLETED",
      "VEHICLE_RETURNED",
    ]);
    expect(s.recentEvents.length).toBeLessThanOrEqual(SNAPSHOT_RECENT_EVENTS);
    expect(s.finance.recentTransactions.length).toBeLessThanOrEqual(SNAPSHOT_RECENT_TRANSACTIONS);
  });

  it("is the same after save → load, and taking it doesn't change the state hash", () => {
    const { sim } = playPath();
    const hash = sim.stateHash();
    const snapshot = sim.snapshot();
    expect(sim.stateHash()).toBe(hash);
    const loaded = loadGame(JSON.parse(JSON.stringify(sim.serialize())));
    expect(loaded.snapshot()).toEqual(snapshot);
  });
});
