// Sprint Zero in a real browser (S0b #16, ported to the React shell in T04a #11):
// the S0a path through the worker gateway.
//
//   Create game → Buy ingredients → Produce one case → Dispatch truck →
//   Deliver → Sell → Record profit → Save → Reload → continue
//
// The game starts paused and stays paused. Commands go through
// `window.__eov.dispatchRaw` and ticks through `window.__eov.advance`, which
// runs exactly the ticks asked for (ADR 0014 decision 7). The commands and
// ticks match tools/economy-lab/src/sprint-zero.ts, so the final state hash
// must equal the headless run's. New game, Save, and Reload save are the
// shell's buttons; the figures are checked in the Dashboard.

import { cents, formatMoney, subtractMoney } from "@eov/contracts";
import { expect, test, type Page } from "@playwright/test";
import { SAVES_COPY } from "../../src/app/saves/copy.ts";
import type { EovTestHook } from "../../src/app/test-hook.ts";

/**
 * The headless Sprint Zero run's hash once the truck is home. Must equal the
 * hash pinned in tools/economy-lab/test/sprint-zero.test.ts; update both together.
 */
const HEADLESS_HASH = "fnv1a64:0080bee2d4b54a0f";

type Snapshot = NonNullable<EovTestHook["snapshot"]>;

async function snapshot(page: Page): Promise<Snapshot> {
  const s = await page.evaluate(() => window.__eov?.snapshot ?? null);
  if (!s) throw new Error("No snapshot on window.__eov");
  return s;
}

const stateHash = (page: Page) => page.evaluate(() => window.__eov?.stateHash ?? null);

/** Clicks a shell button and waits until the shell is idle again (its buttons are disabled while a request runs). */
async function press(page: Page, testId: string): Promise<void> {
  await page.getByTestId(testId).click();
  await expect(page.getByTestId("new-game")).toBeEnabled();
}

async function dispatch(page: Page, request: unknown): Promise<void> {
  const outcome = await page.evaluate((r) => window.__eov!.dispatchRaw(r), request);
  expect(outcome, JSON.stringify(request)).toMatchObject({ kind: "result", result: { status: "applied" } });
}

async function advanceTo(page: Page, target: number): Promise<void> {
  const ticks = target - (await snapshot(page)).clock.tick;
  expect(ticks).toBeGreaterThan(0);
  await page.evaluate((n) => window.__eov!.advance(n), ticks);
  expect((await snapshot(page)).clock.tick).toBe(target);
}

/** The truck's drawn position, once the map has drawn the latest snapshot. */
async function truckPosition(page: Page, tick: number) {
  await expect.poll(() => page.getByTestId("map").getAttribute("data-tick")).toBe(String(tick));
  return page.evaluate(() => window.__eov!.scene.find((s) => s.kind === "VEHICLE")!.position);
}

test("plays the Sprint Zero path through the worker and matches the headless hash after save → reload", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("new-game")).toBeEnabled();
  expect(await page.evaluate(() => window.__eov?.snapshot ?? null)).toBeNull();

  // Create game: paused, at tick 0.
  await press(page, "new-game");
  const start = await snapshot(page);
  expect(start.clock.tick).toBe(0);
  expect(await page.evaluate(() => window.__eov!.scheduler)).toEqual({ speed: 0, autoPaused: false, fastForward: false });
  await expect(page.getByTestId("dashboard-cash")).toHaveText("$1,000.00");
  const distillery = start.facilities.find((f) => f.kind === "DISTILLERY")!;
  const recipe = distillery.recipes[0]!;
  expect(recipe.blockedBy).not.toBeNull();

  // Placeholder shapes in the map slot: the distillery, the supplier, the buyers, and the truck.
  for (const shape of ["facility", "supplier", "buyer", "vehicle"]) {
    await expect(page.locator(`[data-testid=map] [data-shape=${shape}]`).first()).toBeVisible();
  }
  await expect(page.locator("[data-testid=map] [data-shape=buyer]")).toHaveCount(start.market.buyers.length);

  // Buy ingredients: one case's worth of each input, from the supplier that sells it.
  for (const input of recipe.inputsPerCase) {
    const supplier = start.market.suppliers.find((s) => s.materials.some((m) => m.materialId === input.materialId))!;
    await dispatch(page, {
      command: { type: "PURCHASE_MATERIALS", supplierId: supplier.id, materialId: input.materialId, quantity: input.quantity, facilityId: distillery.id },
    });
  }
  const bought = await snapshot(page);
  expect(bought.facilities[0]!.materials.map((m) => m.quantity)).toEqual(recipe.inputsPerCase.map((i) => i.quantity));
  expect(bought.facilities[0]!.recipes[0]!.blockedBy).toBeNull();

  // Produce one case
  await dispatch(page, { command: { type: "START_PRODUCTION", facilityId: distillery.id, recipeId: recipe.recipeId, quantity: 1 } });
  const producing = await snapshot(page);
  expect(producing.productionJobs).toHaveLength(1);
  await advanceTo(page, producing.productionJobs[0]!.completesAt);
  const produced = await snapshot(page);
  expect(produced.productionJobs).toHaveLength(0);
  expect(produced.facilities[0]!.products[0]!.quantity).toBe(1);

  // Agree a deal with the first buyer (the headless run's) at today's quote, then
  // dispatch the truck against it (ADR 0022 decision 6).
  const buyer = produced.market.buyers[0]!;
  const pool = produced.facilities[0]!.products[0]!;
  await dispatch(page, {
    command: { type: "AGREE_DEAL", buyerId: buyer.id, productId: pool.productId, quality: pool.quality, quantity: 1, agreedUnitPrice: buyer.wants[0]!.unitPrice },
  });
  const agreed = (await snapshot(page)).recentEvents.filter((e) => e.type === "DEAL_AGREED").at(-1)!;
  if (agreed.type !== "DEAL_AGREED") throw new Error("No DEAL_AGREED");
  expect(agreed.unitPrice).toBe(buyer.wants[0]!.unitPrice);
  await dispatch(page, {
    command: {
      type: "DISPATCH_DELIVERY",
      vehicleId: produced.vehicles[0]!.id,
      cargo: [{ productId: pool.productId, quality: pool.quality, quantity: 1 }],
      purpose: { kind: "SALE", buyerId: buyer.id, dealId: agreed.dealId },
      routeId: null,
      driver: { kind: "FOUNDER" },
    },
  });
  const dispatched = await snapshot(page);
  const outbound = dispatched.vehicles[0]!.trip!;
  expect(outbound.leg).toBe("OUTBOUND");
  expect(outbound.purpose).toEqual({ kind: "SALE", buyerId: buyer.id, dealId: agreed.dealId });
  const parked = await truckPosition(page, dispatched.clock.tick);

  // Deliver and sell: halfway there, the truck is drawn between home and the buyer.
  const halfway = outbound.departedAt + Math.floor((outbound.arrivesAt - outbound.departedAt) / 2);
  await advanceTo(page, halfway);
  expect(await truckPosition(page, halfway)).not.toEqual(parked);
  await advanceTo(page, outbound.arrivesAt);
  const sold = await snapshot(page);
  expect(sold.vehicles[0]!.trip!.leg).toBe("RETURN");
  expect(sold.recentEvents.map((e) => e.type)).toContain("SALE_COMPLETED");

  // Record profit: the buyer's quote as revenue, less the case's cost of goods. Both
  // are basic-economy tuning levers (ADR 0020 decision 15), so they come from the snapshots.
  const revenue = buyer.wants[0]!.unitPrice;
  const costOfGoods = pool.averageUnitCost;
  const gross = subtractMoney(revenue, costOfGoods);
  expect(sold.finance.toDate.profit).toMatchObject({ revenue, costOfGoodsSold: costOfGoods, netProfit: gross });
  await expect(page.getByTestId("dashboard-revenue-toDate")).toHaveText(formatMoney(revenue));
  await expect(page.getByTestId("dashboard-profit-toDate")).toHaveText(formatMoney(gross));

  // Save, reload the page, and reload the save.
  await press(page, "save");
  const savedHash = await stateHash(page);
  await page.reload();
  await expect(page.getByTestId("new-game")).toBeEnabled();
  expect(await page.evaluate(() => window.__eov?.snapshot ?? null)).toBeNull();
  await press(page, "reload");
  await expect(page.getByTestId("message")).toHaveText(SAVES_COPY.loaded);
  const reloaded = await snapshot(page);
  expect(reloaded.clock.tick).toBe(sold.clock.tick);
  expect(await stateHash(page)).toBe(savedHash);
  expect(reloaded).toEqual(sold);
  expect(await page.evaluate(() => window.__eov!.scheduler.speed)).toBe(0);

  // Continue until the truck is home: the same tick and commands as the headless run.
  await advanceTo(page, reloaded.vehicles[0]!.trip!.arrivesAt);
  const home = await snapshot(page);
  expect(home.vehicles[0]!.trip).toBeNull();
  // The $1.50 transport is paid when the truck gets home (ADR 0019 decision 2).
  const transport = cents(150);
  expect(home.finance.toDate.profit.netProfit).toBe(subtractMoney(gross, transport));
  await expect(page.getByTestId("dashboard-profit-toDate")).toHaveText(formatMoney(subtractMoney(gross, transport)));
  expect(await stateHash(page)).toBe(HEADLESS_HASH);
  await expect(page.getByTestId("state-hash")).toHaveText(HEADLESS_HASH);
});

test("the gateway validates requests with commandRequestSchema before dispatch", async ({ page }) => {
  await page.goto("/");
  await press(page, "new-game");
  const before = await stateHash(page);

  const malformed = [
    { command: { type: "PURCHASE_MATERIALS", supplierId: "millers-feed", materialId: "corn", quantity: 0, facilityId: "distillery-main" } },
    { command: { type: "PURCHASE_MATERIALS", supplierId: "millers-feed", materialId: "corn", quantity: 1.5, facilityId: "distillery-main" } },
    { command: { type: "NOT_A_COMMAND" } },
    { command: { type: "START_PRODUCTION", facilityId: "distillery-main", recipeId: "basic-moonshine", quantity: 1, extra: true } },
    "not an object",
  ];
  for (const request of malformed) {
    const outcome = await page.evaluate((r) => window.__eov!.dispatchRaw(r), request);
    expect(outcome.kind, JSON.stringify(request)).toBe("invalid");
  }
  expect(await stateHash(page)).toBe(before);

  // A well-formed request reaches dispatch and gets the simulation's own result.
  const valid = await page.evaluate(() =>
    window.__eov!.dispatchRaw({
      command: { type: "PURCHASE_MATERIALS", supplierId: "millers-feed", materialId: "corn", quantity: 1, facilityId: "distillery-main" },
    }),
  );
  expect(valid).toMatchObject({ kind: "result", result: { status: "applied" } });
  expect(await stateHash(page)).not.toBe(before);
});
