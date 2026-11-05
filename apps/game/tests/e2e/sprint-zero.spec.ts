// Sprint Zero in a real browser (S0b, issue #16): the S0a path through the
// worker gateway, driven by the placeholder buttons.
//
//   Create game → Buy ingredients → Produce one case → Dispatch truck →
//   Deliver → Sell → Record profit → Save → Reload → continue
//
// Tick counts for "Advance N ticks" are read from the snapshot on
// `window.__eov`, the same way a player reads the job and trip timings. The
// commands and ticks match tools/economy-lab/src/sprint-zero.ts, so the final
// state hash must equal the headless run's.

import { expect, test, type Page } from "@playwright/test";
import type { EovTestHook } from "../../src/app/test-hook.ts";

/**
 * The headless Sprint Zero run's hash once the truck is home. Must equal the
 * hash pinned in tools/economy-lab/test/sprint-zero.test.ts; update both together.
 */
const HEADLESS_HASH = "fnv1a64:356d462e35305432";

type Snapshot = NonNullable<EovTestHook["snapshot"]>;

async function snapshot(page: Page): Promise<Snapshot> {
  const s = await page.evaluate(() => window.__eov?.snapshot ?? null);
  if (!s) throw new Error("No snapshot on window.__eov");
  return s;
}

const stateHash = (page: Page) => page.evaluate(() => window.__eov?.stateHash ?? null);

/** Clicks a button and waits until the UI is idle again (buttons are disabled while a request runs). */
async function press(page: Page, testId: string): Promise<void> {
  await page.getByTestId(testId).click();
  await expect(page.getByTestId("new-game")).toBeEnabled();
}

async function advanceTo(page: Page, target: number): Promise<void> {
  const ticks = target - (await snapshot(page)).clock.tick;
  expect(ticks).toBeGreaterThan(0);
  await page.getByTestId("ticks").fill(String(ticks));
  await press(page, "advance");
  expect((await snapshot(page)).clock.tick).toBe(target);
}

test("plays the Sprint Zero path through the worker and matches the headless hash after save → reload", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("new-game")).toBeEnabled();
  expect(await page.evaluate(() => window.__eov?.snapshot ?? null)).toBeNull();

  // Create game
  await press(page, "new-game");
  const start = await snapshot(page);
  expect(start.clock.tick).toBe(0);
  await expect(page.getByTestId("cash")).toHaveText("$1,000.00");
  const distillery = start.facilities.find((f) => f.kind === "DISTILLERY")!;
  expect(distillery.recipes[0]!.blockedBy).not.toBeNull();
  await expect(page.getByTestId("produce")).toBeDisabled();

  // Placeholder shapes: the distillery, the supplier, the buyers, and the truck.
  for (const shape of ["facility", "supplier", "buyer", "vehicle"]) {
    await expect(page.locator(`[data-testid=map] [data-shape=${shape}]`).first()).toBeVisible();
  }
  await expect(page.locator("[data-testid=map] [data-shape=buyer]")).toHaveCount(start.market.buyers.length);

  // Buy ingredients
  await press(page, "buy");
  const bought = await snapshot(page);
  expect(bought.facilities[0]!.materials.map((m) => m.quantity)).toEqual(distillery.recipes[0]!.inputsPerCase.map((i) => i.quantity));
  expect(bought.facilities[0]!.recipes[0]!.blockedBy).toBeNull();

  // Produce one case
  await press(page, "produce");
  const producing = await snapshot(page);
  expect(producing.productionJobs).toHaveLength(1);
  await advanceTo(page, producing.productionJobs[0]!.completesAt);
  const produced = await snapshot(page);
  expect(produced.productionJobs).toHaveLength(0);
  expect(produced.facilities[0]!.products[0]!.quantity).toBe(1);

  // Dispatch the truck to the first buyer (the headless run's), at today's quote.
  const buyer = produced.market.buyers[0]!;
  await page.getByTestId("buyer").selectOption(buyer.id);
  await press(page, "dispatch");
  const dispatched = await snapshot(page);
  const outbound = dispatched.vehicles[0]!.trip!;
  expect(outbound.leg).toBe("OUTBOUND");
  expect(outbound.purpose).toEqual({ kind: "SALE", buyerId: buyer.id, agreedUnitPrice: buyer.wants[0]!.unitPrice });
  const parked = await page.evaluate(() => window.__eov!.scene.find((s) => s.kind === "VEHICLE")!.position);

  // Deliver and sell: halfway there, the truck is drawn between home and the buyer.
  await advanceTo(page, outbound.departedAt + Math.floor((outbound.arrivesAt - outbound.departedAt) / 2));
  const moving = await page.evaluate(() => window.__eov!.scene.find((s) => s.kind === "VEHICLE")!.position);
  expect(moving).not.toEqual(parked);
  await advanceTo(page, outbound.arrivesAt);
  const sold = await snapshot(page);
  expect(sold.vehicles[0]!.trip!.leg).toBe("RETURN");
  expect(sold.recentEvents.map((e) => e.type)).toContain("SALE_COMPLETED");

  // Record profit: $14.00 revenue − $11.00 cost of goods = $3.00.
  expect(sold.finance.toDate.profit).toMatchObject({ revenue: 1_400, costOfGoodsSold: 1_100, netProfit: 300 });
  await expect(page.getByTestId("revenue")).toHaveText("$14.00");
  await expect(page.getByTestId("profit")).toHaveText("$3.00");

  // Save, reload the page, and reload the save.
  await press(page, "save");
  const savedHash = await stateHash(page);
  await page.reload();
  await expect(page.getByTestId("new-game")).toBeEnabled();
  expect(await page.evaluate(() => window.__eov?.snapshot ?? null)).toBeNull();
  await press(page, "reload");
  await expect(page.getByTestId("message")).toHaveText("Save reloaded.");
  const reloaded = await snapshot(page);
  expect(reloaded.clock.tick).toBe(sold.clock.tick);
  expect(await stateHash(page)).toBe(savedHash);
  expect(reloaded).toEqual(sold);

  // Continue until the truck is home: the same tick and commands as the headless run.
  await advanceTo(page, reloaded.vehicles[0]!.trip!.arrivesAt);
  const home = await snapshot(page);
  expect(home.vehicles[0]!.trip).toBeNull();
  expect(home.finance.toDate.profit.netProfit).toBe(300);
  await expect(page.getByTestId("profit")).toHaveText("$3.00");
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
