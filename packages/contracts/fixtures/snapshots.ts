// Fixture snapshots for UI work (T04a/T04b) before the simulation is real.
// PLACEHOLDER content (see world.ts). Internally consistent: totals add up,
// equity = net worth = assets − liabilities, and net worth − profit to date =
// opening equity. test/fixtures.test.ts checks all of that.
//
// - startOfGameSnapshot: tick 0, January 17, 1920. Nothing has happened yet.
// - midGameSnapshot: day 3, 14:00. A truck is on the back roads to Kessler's with
//   8 cases (the county road is closed by police), a production job is running,
//   sugar is short, and a contract with the Crossroads has one installment done.

import {
  addMoney,
  asId,
  cents,
  multiplyMoney,
  RATIO_ONE,
  subtractMoney,
  sumMoney,
  tick,
  ZERO_MONEY,
  type BalanceSheet,
  type CashFlowCategory,
  type CashFlowStatement,
  type ExpenseCategory,
  type FacilitySnapshot,
  type GameSnapshot,
  type IncomeStatement,
  type Money,
  type PeriodReport,
} from "../src/index.ts";
import { ids, locations, opening, routes } from "./world.ts";

// ---------------------------------------------------------------------------
// Report builders: compute totals so the fixtures can't be internally wrong.
// ---------------------------------------------------------------------------

function balanceSheet(
  assets: BalanceSheet["assets"],
  liabilities: BalanceSheet["liabilities"],
): BalanceSheet {
  const totalAssets = sumMoney(Object.values(assets));
  const totalLiabilities = sumMoney(Object.values(liabilities));
  return { assets, liabilities, totalAssets, totalLiabilities, equity: subtractMoney(totalAssets, totalLiabilities) };
}

const EXPENSE_ORDER: readonly ExpenseCategory[] = ["WAGES", "OVERHEAD", "TRANSPORT", "PENALTIES", "LOSSES"];
const CASH_ORDER: readonly CashFlowCategory[] = [
  "SALES",
  "ASSET_SALES",
  "MATERIALS",
  "EQUIPMENT",
  "WAGES",
  "OVERHEAD",
  "TRANSPORT",
  "PENALTIES",
  "LOSSES",
];

function incomeStatement(revenue: Money, cogs: Money, expenses: Partial<Record<ExpenseCategory, Money>>): IncomeStatement {
  const lines = EXPENSE_ORDER.map((category) => ({ category, amount: expenses[category] ?? ZERO_MONEY }));
  const grossProfit = subtractMoney(revenue, cogs);
  const gains = ZERO_MONEY;
  const netProfit = addMoney(subtractMoney(grossProfit, sumMoney(lines.map((l) => l.amount))), gains);
  return { revenue, costOfGoodsSold: cogs, grossProfit, expenses: lines, gains, netProfit };
}

function cashFlow(openingCash: Money, flows: Partial<Record<CashFlowCategory, Money>>): CashFlowStatement {
  const lines = CASH_ORDER.map((category) => ({ category, amount: flows[category] ?? ZERO_MONEY }));
  const netChange = sumMoney(lines.map((l) => l.amount));
  return { openingCash, lines, netChange, closingCash: addMoney(openingCash, netChange) };
}

function period(fromTick: number, toTick: number, profit: IncomeStatement, flow: CashFlowStatement): PeriodReport {
  return { fromTick: tick(fromTick), toTick: tick(toTick), profit, cashFlow: flow };
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

const leaders = [
  { id: ids.founder, name: "Thomas Kerrigan", role: "FOUNDER", skill: 3, loyalty: 10, dailyWage: cents(0) },
  { id: ids.foreman, name: "Walt Hagen", role: "FOREMAN", skill: 4, loyalty: 7, dailyWage: cents(300) },
] as const satisfies GameSnapshot["family"]["leaders"];

function tiers(reachedCount: number): GameSnapshot["progression"]["tiers"] {
  const all = [
    { id: ids.tierStart, name: "Starting Operation", netWorthRequired: null, reputationRequired: null, unlocks: [ids.unlockSpot] },
    { id: ids.tierTrusted, name: "Trusted Supplier", netWorthRequired: cents(150_000), reputationRequired: 10, unlocks: [ids.unlockContracts] },
    { id: ids.tierEstablished, name: "Established Producer", netWorthRequired: cents(250_000), reputationRequired: 20, unlocks: [ids.unlockQuality] },
    { id: ids.tierRegional, name: "Regional Distributor", netWorthRequired: cents(500_000), reputationRequired: 30, unlocks: [ids.unlockRegion] },
  ];
  return all.map((t, i) => ({ ...t, reached: i < reachedCount }));
}

const recipes = (maxBasic: number): FacilitySnapshot["recipes"] => [
  {
    recipeId: ids.basicRecipe,
    name: "Basic moonshine",
    productId: ids.moonshine,
    quality: "basic",
    inputsPerCase: [
      { materialId: ids.corn, quantity: 2 },
      { materialId: ids.sugar, quantity: 1 },
    ],
    ticksPerCase: 1_440,
    maxStartableQuantity: maxBasic,
    blockedBy: maxBasic > 0 ? null : { code: "INSUFFICIENT_MATERIALS", materialId: ids.sugar, required: 1, available: 0 },
  },
  {
    recipeId: ids.standardRecipe,
    name: "Standard moonshine",
    productId: ids.moonshine,
    quality: "standard",
    inputsPerCase: [
      { materialId: ids.corn, quantity: 3 },
      { materialId: ids.sugar, quantity: 2 },
    ],
    ticksPerCase: 1_440,
    maxStartableQuantity: 0,
    blockedBy: { code: "LOCKED", unlockId: ids.unlockQuality },
  },
];

const equipmentOptions: FacilitySnapshot["equipmentOptions"] = [
  {
    equipmentId: ids.condenser,
    name: "Improved condenser",
    description: "+40% throughput",
    price: cents(45_000),
    blockedBy: null,
  },
  {
    equipmentId: ids.qcStation,
    name: "Quality control station",
    description: "Unlocks standard moonshine, at higher production cost",
    price: cents(65_000),
    blockedBy: { code: "LOCKED", unlockId: ids.unlockQuality },
  },
  {
    equipmentId: ids.storageExpansion,
    name: "Storage expansion",
    description: "+100 cases of storage",
    price: cents(35_000),
    blockedBy: null,
  },
];

const barn: FacilitySnapshot = {
  id: ids.barn,
  name: "Old Barn",
  locationId: ids.locBarn,
  kind: "WAREHOUSE",
  equipment: [],
  equipmentSlots: { used: 0, total: 1 },
  equipmentOptions: [equipmentOptions[2]!],
  workforce: { workers: 0, maximum: 0, dailyWagePerWorker: cents(0) },
  storage: { used: 0, capacity: 60 },
  productionCapacityPerDay: 0,
  recipes: [],
  products: [],
  materials: [],
};

const victoryTargets = { netWorth: cents(500_000), reputation: 30, contracts: 1 };

// ---------------------------------------------------------------------------
// Start of game: tick 0
// ---------------------------------------------------------------------------

const startFinance = (() => {
  const sheet = balanceSheet(
    {
      cash: opening.cash,
      rawMaterials: ZERO_MONEY,
      finishedGoods: ZERO_MONEY,
      goodsInTransit: ZERO_MONEY,
      receivables: ZERO_MONEY,
      equipment: opening.copperStill,
      vehicles: opening.truck,
      facilities: opening.buildings,
    },
    { wagesPayable: ZERO_MONEY, penaltiesPayable: ZERO_MONEY },
  );
  const nothing = period(0, 0, incomeStatement(ZERO_MONEY, ZERO_MONEY, {}), cashFlow(opening.cash, {}));
  return {
    cash: opening.cash,
    netWorth: sheet.equity,
    balanceSheet: sheet,
    today: nothing,
    previousDay: null,
    toDate: nothing,
    recentTransactions: [
      {
        id: asId("Transaction", "txn-1"),
        tick: tick(0),
        kind: "OPENING_BALANCE",
        idempotencyKey: "OPENING_BALANCE:first-shipment",
        entries: [
          { account: "CASH", side: "DEBIT", amount: opening.cash },
          { account: "EQUIPMENT", side: "DEBIT", amount: opening.copperStill },
          { account: "VEHICLES", side: "DEBIT", amount: opening.truck },
          { account: "FACILITIES", side: "DEBIT", amount: opening.buildings },
          { account: "OWNER_EQUITY", side: "CREDIT", amount: opening.equity },
        ],
        eventIds: [],
      },
    ],
  } satisfies GameSnapshot["finance"];
})();

export const startOfGameSnapshot: GameSnapshot = {
  clock: { tick: tick(0), dayIndex: 0, date: { year: 1920, month: 1, day: 17, hour: 0, minute: 0 } },
  outcome: { status: "PLAYING" },
  family: { id: ids.family, name: "The Kerrigans", reputation: 0, leaders },
  finance: startFinance,
  progression: {
    currentTierId: ids.tierStart,
    tiers: tiers(1),
    unlocked: [ids.unlockSpot],
    victory: {
      netWorth: { current: startFinance.netWorth, target: victoryTargets.netWorth },
      reputation: { current: 0, target: victoryTargets.reputation },
      completedContracts: { current: 0, target: victoryTargets.contracts },
    },
  },
  locations,
  routes: routes(null),
  facilities: [
    {
      id: ids.distillery,
      name: "Hollow Creek Distillery",
      locationId: ids.locDistillery,
      kind: "DISTILLERY",
      equipment: [{ id: ids.copperStill, name: "Copper still", bookValue: opening.copperStill, resaleValue: cents(15_000) }],
      equipmentSlots: { used: 1, total: 3 },
      equipmentOptions,
      workforce: { workers: 3, maximum: 6, dailyWagePerWorker: cents(150) },
      storage: { used: 0, capacity: 50 },
      productionCapacityPerDay: 10,
      recipes: recipes(0),
      products: [],
      materials: [],
    },
    barn,
  ],
  productionJobs: [],
  vehicles: [{ id: ids.truck, name: "Model TT truck", capacity: 12, homeLocationId: ids.locDistillery, trip: null }],
  market: {
    dayIndex: 0,
    products: [
      {
        productId: ids.moonshine,
        productName: "Moonshine",
        quality: "basic",
        basePrice: cents(1_400),
        spotPrice: cents(1_400),
        demandRatioPpm: RATIO_ONE,
        supplyRatioPpm: RATIO_ONE,
        eventRatioPpm: RATIO_ONE,
        previousSpotPrice: null,
      },
      {
        productId: ids.moonshine,
        productName: "Moonshine",
        quality: "standard",
        basePrice: cents(2_000),
        spotPrice: cents(2_000),
        demandRatioPpm: RATIO_ONE,
        supplyRatioPpm: RATIO_ONE,
        eventRatioPpm: RATIO_ONE,
        previousSpotPrice: null,
      },
    ],
    suppliers: [
      {
        id: ids.supplier,
        name: "Miller's Feed & Seed",
        locationId: ids.locSupplier,
        materials: [
          { materialId: ids.corn, materialName: "Corn", unitPrice: cents(250), available: 200, shortage: false },
          { materialId: ids.sugar, materialName: "Sugar", unitPrice: cents(200), available: 100, shortage: false },
        ],
      },
    ],
    buyers: [
      {
        id: ids.roadhouse,
        name: "The Crossroads Roadhouse",
        locationId: ids.locRoadhouse,
        minimumReputation: 0,
        willDeal: true,
        budgetRemaining: cents(30_000),
        wants: [
          { productId: ids.moonshine, productName: "Moonshine", minimumQuality: "basic", unitPrice: cents(1_400), demandRemaining: 15, maxAcceptableQuantity: 15 },
        ],
      },
      {
        id: ids.speakeasy,
        name: "Kessler's back room",
        locationId: ids.locSpeakeasy,
        minimumReputation: 0,
        willDeal: true,
        budgetRemaining: cents(45_000),
        wants: [
          { productId: ids.moonshine, productName: "Moonshine", minimumQuality: "basic", unitPrice: cents(1_520), demandRemaining: 20, maxAcceptableQuantity: 20 },
        ],
      },
      {
        id: ids.hotel,
        name: "Lakeview Hotel",
        locationId: ids.locHotel,
        minimumReputation: 20,
        willDeal: false,
        budgetRemaining: cents(60_000),
        wants: [
          { productId: ids.moonshine, productName: "Moonshine", minimumQuality: "standard", unitPrice: cents(2_300), demandRemaining: 12, maxAcceptableQuantity: 12 },
        ],
      },
    ],
  },
  contracts: { offers: [], active: [], closed: [] },
  recentEvents: [],
};

// ---------------------------------------------------------------------------
// Mid game: day 3, 14:00 (tick 5160)
// ---------------------------------------------------------------------------
//
// Story so far: 30 basic cases produced at $12.00 each ($7.00 materials + $5.00 labor,
// capitalized). 8 delivered for contract installment 1 at $13.30, 6 sold to the
// Crossroads at $14.00, 8 on the truck now, 8 in stock reserved for installment 2.

const CASE_COST = cents(1_200);
const NOW = 5_160;
const DAY3 = 4_320;
const DAY2 = 2_880;

const midFinance = (() => {
  const finishedGoods = multiplyMoney(CASE_COST, 8);
  const goodsInTransit = multiplyMoney(CASE_COST, 8);
  // 24 corn at $2.50 and 12 sugar at $2.00, reserved by the running job.
  const rawMaterials = addMoney(multiplyMoney(cents(250), 24), multiplyMoney(cents(200), 12));

  const toDate = period(
    0,
    NOW,
    incomeStatement(
      addMoney(multiplyMoney(cents(1_330), 8), multiplyMoney(cents(1_400), 6)),
      multiplyMoney(CASE_COST, 14),
      { OVERHEAD: cents(600), TRANSPORT: cents(900) },
    ),
    cashFlow(opening.cash, {
      SALES: cents(19_040),
      MATERIALS: cents(-29_400),
      WAGES: cents(-15_000),
      OVERHEAD: cents(-600),
      TRANSPORT: cents(-900),
    }),
  );
  const previousDay = period(
    DAY2,
    DAY3,
    incomeStatement(multiplyMoney(cents(1_330), 8), multiplyMoney(CASE_COST, 8), { TRANSPORT: cents(300) }),
    cashFlow(cents(68_100), { SALES: cents(10_640), WAGES: cents(-5_000), TRANSPORT: cents(-300) }),
  );
  const today = period(
    DAY3,
    NOW,
    incomeStatement(ZERO_MONEY, ZERO_MONEY, { TRANSPORT: cents(300) }),
    cashFlow(previousDay.cashFlow.closingCash, { TRANSPORT: cents(-300) }),
  );
  const cash = toDate.cashFlow.closingCash;
  const sheet = balanceSheet(
    {
      cash,
      rawMaterials,
      finishedGoods,
      goodsInTransit,
      receivables: ZERO_MONEY,
      equipment: opening.copperStill,
      vehicles: opening.truck,
      facilities: opening.buildings,
    },
    { wagesPayable: ZERO_MONEY, penaltiesPayable: ZERO_MONEY },
  );
  return {
    cash,
    netWorth: sheet.equity,
    balanceSheet: sheet,
    today,
    previousDay,
    toDate,
    recentTransactions: [
      {
        id: asId("Transaction", "txn-14"),
        tick: tick(5_100),
        kind: "DISPATCH",
        idempotencyKey: "DISPATCH:delivery-3",
        entries: [
          { account: "GOODS_IN_TRANSIT", side: "DEBIT", amount: goodsInTransit },
          { account: "TRANSPORT_EXPENSE", side: "DEBIT", amount: cents(300) },
          { account: "FINISHED_GOODS", side: "CREDIT", amount: goodsInTransit },
          { account: "CASH", side: "CREDIT", amount: cents(300) },
        ],
        eventIds: [asId("Event", "evt-31")],
      },
    ],
  } satisfies GameSnapshot["finance"];
})();

const midDistillery: FacilitySnapshot = {
  ...startOfGameSnapshot.facilities[0]!,
  storage: { used: 8, capacity: 50 },
  recipes: recipes(0),
  products: [
    {
      productId: ids.moonshine,
      productName: "Moonshine",
      quality: "basic",
      quantity: 8,
      reservedQuantity: 8,
      totalCost: midFinance.balanceSheet.assets.finishedGoods,
      averageUnitCost: CASE_COST,
    },
  ],
  materials: [
    { materialId: ids.corn, materialName: "Corn", quantity: 24, reservedQuantity: 20, totalCost: cents(6_000) },
    { materialId: ids.sugar, materialName: "Sugar", quantity: 12, reservedQuantity: 10, totalCost: cents(2_400) },
  ],
};

const saleToKessler = { kind: "SALE", buyerId: ids.speakeasy, agreedUnitPrice: cents(1_520) } as const;
const truckCargo = [{ productId: ids.moonshine, quality: "basic", quantity: 8 }] as const;

export const midGameSnapshot: GameSnapshot = {
  clock: { tick: tick(NOW), dayIndex: 3, date: { year: 1920, month: 1, day: 20, hour: 14, minute: 0 } },
  outcome: { status: "PLAYING" },
  family: { id: ids.family, name: "The Kerrigans", reputation: 13, leaders },
  finance: midFinance,
  progression: {
    currentTierId: ids.tierTrusted,
    tiers: tiers(2),
    unlocked: [ids.unlockSpot, ids.unlockContracts],
    victory: {
      netWorth: { current: midFinance.netWorth, target: victoryTargets.netWorth },
      reputation: { current: 13, target: victoryTargets.reputation },
      completedContracts: { current: 0, target: victoryTargets.contracts },
    },
  },
  locations,
  routes: routes(6_600),
  facilities: [midDistillery, barn],
  productionJobs: [
    {
      id: asId("ProductionJob", "job-3"),
      facilityId: ids.distillery,
      recipeId: ids.basicRecipe,
      productId: ids.moonshine,
      quality: "basic",
      quantity: 10,
      startedAt: tick(4_800),
      completesAt: tick(6_240),
    },
  ],
  vehicles: [
    {
      id: ids.truck,
      name: "Model TT truck",
      capacity: 12,
      homeLocationId: ids.locDistillery,
      trip: {
        deliveryId: asId("Delivery", "delivery-3"),
        routeId: ids.routeSpeakeasyBack,
        leg: "OUTBOUND",
        departedAt: tick(5_100),
        arrivesAt: tick(5_340),
        cargo: truckCargo,
        purpose: saleToKessler,
        delayed: false,
      },
    },
  ],
  market: {
    ...startOfGameSnapshot.market,
    dayIndex: 3,
    products: [
      {
        ...startOfGameSnapshot.market.products[0]!,
        spotPrice: cents(1_470),
        demandRatioPpm: 1_050_000,
        previousSpotPrice: cents(1_400),
      },
      { ...startOfGameSnapshot.market.products[1]!, previousSpotPrice: cents(2_000) },
    ],
    suppliers: [
      {
        ...startOfGameSnapshot.market.suppliers[0]!,
        materials: [
          { materialId: ids.corn, materialName: "Corn", unitPrice: cents(250), available: 116, shortage: false },
          { materialId: ids.sugar, materialName: "Sugar", unitPrice: cents(260), available: 16, shortage: true },
        ],
      },
    ],
    buyers: [
      {
        ...startOfGameSnapshot.market.buyers[0]!,
        budgetRemaining: cents(21_600),
        wants: [
          { productId: ids.moonshine, productName: "Moonshine", minimumQuality: "basic", unitPrice: cents(1_470), demandRemaining: 9, maxAcceptableQuantity: 9 },
        ],
      },
      {
        ...startOfGameSnapshot.market.buyers[1]!,
        // The deal on the truck already took 8 cases ($121.60) of demand and budget (ADR 0005).
        budgetRemaining: cents(32_840),
        wants: [
          { productId: ids.moonshine, productName: "Moonshine", minimumQuality: "basic", unitPrice: cents(1_520), demandRemaining: 12, maxAcceptableQuantity: 12 },
        ],
      },
      startOfGameSnapshot.market.buyers[2]!,
    ],
  },
  contracts: {
    offers: [
      {
        id: asId("ContractOffer", "offer-2"),
        buyerId: ids.speakeasy,
        buyerName: "Kessler's back room",
        productId: ids.moonshine,
        productName: "Moonshine",
        minimumQuality: "basic",
        quantityPerInstallment: 10,
        unitPrice: cents(1_444),
        installmentCount: 3,
        intervalTicks: 2_880,
        penaltyRatePpm: 200_000,
        firstDeadline: tick(8_280),
        expiresAt: tick(5_760),
        blockedBy: null,
      },
    ],
    active: [
      {
        id: asId("Contract", "contract-1"),
        buyerId: ids.roadhouse,
        buyerName: "The Crossroads Roadhouse",
        productId: ids.moonshine,
        productName: "Moonshine",
        minimumQuality: "basic",
        quantityPerInstallment: 8,
        unitPrice: cents(1_330),
        installmentCount: 3,
        intervalTicks: 2_880,
        penaltyRatePpm: 200_000,
        status: "ACTIVE",
        installments: [
          { index: 0, deadline: tick(3_960), required: 8, delivered: 8, inTransit: 0, outcome: "FULFILLED", penalty: ZERO_MONEY },
          { index: 1, deadline: tick(6_840), required: 8, delivered: 0, inTransit: 0, outcome: null, penalty: null },
          { index: 2, deadline: tick(9_720), required: 8, delivered: 0, inTransit: 0, outcome: null, penalty: null },
        ],
        reservationIds: [asId("Reservation", "res-4")],
        reservedQuantity: 8,
      },
    ],
    closed: [],
  },
  recentEvents: [
    {
      id: asId("Event", "evt-28"),
      tick: tick(DAY3),
      causedBy: null,
      type: "SHORTAGE_STARTED",
      supplierId: ids.supplier,
      materialId: ids.sugar,
      supplyRatioPpm: 400_000,
      endsAt: tick(7_200),
    },
    {
      id: asId("Event", "evt-29"),
      tick: tick(4_500),
      causedBy: null,
      type: "ROUTE_CLOSED",
      routeId: ids.routeSpeakeasyMain,
      reason: "POLICE",
      reopensAt: tick(6_600),
    },
    {
      id: asId("Event", "evt-30"),
      tick: tick(4_800),
      causedBy: asId("Command", "cmd-9"),
      type: "PRODUCTION_STARTED",
      jobId: asId("ProductionJob", "job-3"),
      facilityId: ids.distillery,
      recipeId: ids.basicRecipe,
      quantity: 10,
      completesAt: tick(6_240),
    },
    {
      id: asId("Event", "evt-31"),
      tick: tick(5_100),
      causedBy: asId("Command", "cmd-10"),
      type: "DELIVERY_DISPATCHED",
      deliveryId: asId("Delivery", "delivery-3"),
      vehicleId: ids.truck,
      routeId: ids.routeSpeakeasyBack,
      cargo: truckCargo,
      purpose: saleToKessler,
      arrivesAt: tick(5_340),
    },
  ],
};
