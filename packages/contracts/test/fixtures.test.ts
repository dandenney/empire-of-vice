import { describe, expect, it } from "vitest";
import { day0Save, midGameSnapshot, opening, startOfGameSnapshot } from "../fixtures/index.ts";
import { addMoney, gameEventSchema, ledgerTransactionSchema, subtractMoney, sumMoney, type GameSnapshot, type PeriodReport } from "../src/index.ts";

const snapshots = [
  ["start of game", startOfGameSnapshot],
  ["mid game", midGameSnapshot],
] as const;

function checkPeriod(report: PeriodReport) {
  const p = report.profit;
  expect(p.grossProfit).toBe(subtractMoney(p.revenue, p.costOfGoodsSold));
  expect(p.netProfit).toBe(addMoney(subtractMoney(p.grossProfit, sumMoney(p.expenses.map((e) => e.amount))), p.gains));
  const c = report.cashFlow;
  expect(c.netChange).toBe(sumMoney(c.lines.map((l) => l.amount)));
  expect(c.closingCash).toBe(addMoney(c.openingCash, c.netChange));
}

const sortedById = (items: readonly { id: string }[]) => {
  const ids = items.map((i) => i.id);
  expect(ids).toEqual([...ids].sort());
};

describe.each(snapshots)("%s snapshot", (_name, snapshot: GameSnapshot) => {
  const f = snapshot.finance;

  it("balance sheet adds up: assets = liabilities + equity, equity = net worth", () => {
    const b = f.balanceSheet;
    expect(b.totalAssets).toBe(sumMoney(Object.values(b.assets)));
    expect(b.totalLiabilities).toBe(sumMoney(Object.values(b.liabilities)));
    expect(b.totalAssets).toBe(addMoney(b.totalLiabilities, b.equity));
    expect(f.netWorth).toBe(b.equity);
    expect(f.cash).toBe(b.assets.cash);
  });

  it("profit and cash flow add up in every period, and periods chain", () => {
    for (const report of [f.today, f.previousDay, f.toDate]) if (report) checkPeriod(report);
    expect(f.toDate.cashFlow.closingCash).toBe(f.cash);
    expect(f.today.cashFlow.closingCash).toBe(f.cash);
    if (f.previousDay) expect(f.today.cashFlow.openingCash).toBe(f.previousDay.cashFlow.closingCash);
  });

  it("net worth − profit to date = opening equity", () => {
    expect(subtractMoney(f.netWorth, f.toDate.profit.netProfit)).toBe(opening.equity);
  });

  it("recent transactions balance and recent events are valid", () => {
    for (const t of f.recentTransactions) expect(ledgerTransactionSchema.safeParse(t).success).toBe(true);
    for (const e of snapshot.recentEvents) expect(gameEventSchema.safeParse(e).success).toBe(true);
  });

  it("victory progress mirrors finance and family", () => {
    expect(snapshot.progression.victory.netWorth.current).toBe(f.netWorth);
    expect(snapshot.progression.victory.reputation.current).toBe(snapshot.family.reputation);
  });

  it("lists are sorted by ID", () => {
    sortedById(snapshot.locations);
    sortedById(snapshot.routes);
    sortedById(snapshot.facilities);
    sortedById(snapshot.productionJobs);
    sortedById(snapshot.vehicles);
    sortedById(snapshot.market.suppliers);
    sortedById(snapshot.market.buyers);
  });

  it("every location, route endpoint, and facility location exists", () => {
    const locationIds = new Set(snapshot.locations.map((l) => l.id));
    for (const r of snapshot.routes) {
      expect(locationIds.has(r.fromLocationId) && locationIds.has(r.toLocationId)).toBe(true);
    }
    for (const fac of snapshot.facilities) expect(locationIds.has(fac.locationId)).toBe(true);
  });
});

describe("mid-game snapshot matches its story", () => {
  it("inventory values match the balance sheet", () => {
    const distillery = midGameSnapshot.facilities[0]!;
    const b = midGameSnapshot.finance.balanceSheet.assets;
    expect(sumMoney(distillery.products.map((p) => p.totalCost))).toBe(b.finishedGoods);
    expect(sumMoney(distillery.materials.map((m) => m.totalCost))).toBe(b.rawMaterials);
  });

  it("the truck is on the open back roads because the county road is closed", () => {
    const trip = midGameSnapshot.vehicles[0]!.trip!;
    const route = (id: string) => midGameSnapshot.routes.find((r) => r.id === id)!;
    expect(route(trip.routeId).status.open).toBe(true);
    expect(route("county-road").status.open).toBe(false);
  });
});

describe("day-0 save", () => {
  it("ledger cash matches opening cash minus purchases", () => {
    let cash = 0;
    for (const t of day0Save.state.ledger.transactions) {
      for (const e of t.entries) if (e.account === "CASH") cash += e.side === "DEBIT" ? e.amount : -e.amount;
    }
    const materials = sumMoney(day0Save.state.materialPools.map((p) => p.totalCost));
    expect(cash).toBe(subtractMoney(opening.cash, materials));
  });
});
