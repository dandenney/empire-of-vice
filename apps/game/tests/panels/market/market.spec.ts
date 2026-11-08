// The Market panel and the dispatch route picker (#50): PURCHASE_MATERIALS,
// REPEAT_OPERATION, a spot sale on a Risky route, typed rejections with their
// numbers, a closed route that can't be picked, and map clicks. Everything the
// panel shows is checked against the snapshot. Screenshot baselines are
// linux-only (CI); the assertions are skipped elsewhere.

import { BUYERS, FIRST_SHIPMENT_SCENARIO, ROUTES, SUPPLIERS } from "@eov/game-data";
import { expect, test, type Page } from "@playwright/test";

const snapshot = async (page: Page) => (await page.evaluate(() => window.__eov!.snapshot))!;
const stateHash = (page: Page) => page.evaluate(() => window.__eov!.stateHash);
const advance = (page: Page, ticks: number) => page.evaluate((n) => window.__eov!.advance(n), ticks);

const SUPPLIER = "millers-feed";
const ROADHOUSE = "crossroads-roadhouse";
const KESSLER = "kesslers-back-room";
const FACILITY = "distillery-main";
const BASIC = "basic-moonshine";
const TICKS_PER_DAY = 1_440;

async function newGame(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("new-game").click();
  await expect(page.getByTestId("panel-dashboard")).toBeVisible();
}

async function openMarket(page: Page): Promise<void> {
  await page.getByTestId("open-market").click();
  await expect(page.getByTestId("panel-market")).toBeVisible();
}

async function dispatch(page: Page, command: unknown): Promise<void> {
  const outcome = await page.evaluate((r) => window.__eov!.dispatchRaw(r), { command });
  expect(outcome, JSON.stringify(command)).toMatchObject({ kind: "result", result: { status: "applied" } });
}

/** Buys the inputs for `cases` basic cases and makes them, through the test hook. */
async function makeBasicCases(page: Page, cases: number): Promise<void> {
  const recipe = (await snapshot(page)).facilities[0]!.recipes.find((r) => r.recipeId === BASIC)!;
  for (const input of recipe.inputsPerCase) {
    await dispatch(page, { type: "PURCHASE_MATERIALS", supplierId: SUPPLIER, materialId: input.materialId, quantity: input.quantity * cases, facilityId: FACILITY });
  }
  let made = 0;
  while (made < cases) {
    const s = await snapshot(page);
    const max = s.facilities[0]!.recipes.find((r) => r.recipeId === BASIC)!.maxStartableQuantity;
    if (max === 0) {
      // Today's capacity is used: wait for midnight.
      await advance(page, TICKS_PER_DAY - (s.clock.tick % TICKS_PER_DAY));
      continue;
    }
    const quantity = Math.min(max, cases - made);
    await dispatch(page, { type: "START_PRODUCTION", facilityId: FACILITY, recipeId: BASIC, quantity });
    const job = (await snapshot(page)).productionJobs.at(-1)!;
    await advance(page, job.completesAt - (await snapshot(page)).clock.tick);
    made += quantity;
  }
}

test("buys, repeats a purchase, and sells on a Risky route from the panel, which updates from the snapshot", async ({ page }) => {
  await newGame(page);
  await openMarket(page);
  const start = await snapshot(page);

  // Flavor lines come from game-data.
  await expect(page.getByTestId(`supplier-${SUPPLIER}-flavor`)).toHaveText(SUPPLIERS.find((s) => s.id === SUPPLIER)!.flavor!);
  await expect(page.getByTestId(`buyer-${ROADHOUSE}-flavor`)).toHaveText(BUYERS.find((b) => b.id === ROADHOUSE)!.flavor!);

  // The market report: today's spot price, explained.
  const basic = start.market.products.find((p) => p.quality === "basic")!;
  await expect(page.getByTestId("price-moonshine-basic-spot")).toHaveText(`$${(basic.spotPrice / 100).toFixed(2)}`);
  await expect(page.getByTestId("price-moonshine-basic-why")).toContainText("Base $14.00 × demand 1.00 × supply 1.00 × events 1.00");

  // PURCHASE_MATERIALS, twice, then REPEAT_OPERATION on the last one.
  const corn = page.getByTestId(`material-${SUPPLIER}-corn`);
  await corn.getByTestId(`material-${SUPPLIER}-corn-quantity`).fill("4");
  await corn.getByTestId(`material-${SUPPLIER}-corn-buy`).click();
  await expect(corn.getByTestId(`material-${SUPPLIER}-corn-result`)).toHaveText("Done.");
  const afterCorn = (await snapshot(page)).market.suppliers[0]!.materials.find((m) => m.materialId === "corn")!;
  expect(afterCorn.available).toBe(156);
  await expect(corn.getByTestId(`material-${SUPPLIER}-corn-available`)).toHaveText(String(afterCorn.available));

  const sugar = page.getByTestId(`material-${SUPPLIER}-sugar`);
  await sugar.getByTestId(`material-${SUPPLIER}-sugar-quantity`).fill("2");
  await sugar.getByTestId(`material-${SUPPLIER}-sugar-buy`).click();
  await expect(sugar.getByTestId(`material-${SUPPLIER}-sugar-result`)).toHaveText("Done.");
  await expect(page.getByTestId("repeat-purchase-line")).toHaveText("2 × Sugar from Miller's Feed & Seed");

  await page.getByTestId("repeat-purchase-button").click();
  await expect(page.getByTestId("repeat-purchase-result")).toHaveText("Done.");
  await expect(sugar.getByTestId(`material-${SUPPLIER}-sugar-available`)).toHaveText("96");
  const repeated = (await snapshot(page)).recentEvents.filter((e) => e.type === "MATERIALS_PURCHASED");
  expect(repeated.at(-1)).toMatchObject({ materialId: "sugar", quantity: 2 });

  // Two basic cases to sell.
  await makeBasicCases(page, 2);

  // The route picker: the Safe default is picked; the Risky alternative shows its terms.
  const sale = page.getByTestId(`sale-${ROADHOUSE}`);
  const picker = `sale-${ROADHOUSE}-route`;
  const highway = ROUTES.find((r) => r.id === "state-highway")!;
  const cutoff = ROUTES.find((r) => r.id === "crossroads-back-road")!;
  await expect(sale.getByTestId(`${picker}-${highway.id}-radio`)).toBeChecked();
  await expect(sale.getByTestId(`${picker}-${highway.id}-safety`)).toHaveText("Safe");
  await expect(sale.getByTestId(`${picker}-${cutoff.id}-safety`)).toHaveText("Risky");
  await expect(sale.getByTestId(`${picker}-${cutoff.id}`)).toContainText(cutoff.name);
  await expect(sale.getByTestId(`${picker}-${cutoff.id}-description`)).toHaveText(cutoff.description!);
  await expect(sale.getByTestId(`${picker}-${cutoff.id}-risk`)).toHaveText("15% disruption chance");
  await expect(sale.getByTestId(`${picker}-${cutoff.id}-time`)).toHaveText("1 h 20 min");
  await expect(sale.getByTestId(`${picker}-${cutoff.id}-cost`)).toHaveText("$1.00");

  // A spot sale on the Risky route, at the price the panel shows.
  const want = (await snapshot(page)).market.buyers.find((b) => b.id === ROADHOUSE)!.wants[0]!;
  await expect(sale.getByTestId(`sale-${ROADHOUSE}-price`)).toHaveText(`$${(want.unitPrice / 100).toFixed(2)}`);
  await sale.getByTestId(`${picker}-${cutoff.id}`).click();
  await expect(sale.getByTestId(`${picker}-${cutoff.id}-radio`)).toBeChecked();
  await sale.getByTestId(`sale-${ROADHOUSE}-quantity`).fill("1");
  await sale.getByTestId(`sale-${ROADHOUSE}-dispatch`).click();
  await expect(sale.getByTestId(`sale-${ROADHOUSE}-result`)).toHaveText("Done.");

  const sent = await snapshot(page);
  const dispatched = sent.recentEvents.filter((e) => e.type === "DELIVERY_DISPATCHED").at(-1)!;
  expect(dispatched).toMatchObject({ routeId: cutoff.id, purpose: { kind: "SALE", buyerId: ROADHOUSE, agreedUnitPrice: want.unitPrice }, cargo: [{ quality: "basic", quantity: 1 }] });
  expect(sent.vehicles[0]!.trip).not.toBeNull();

  // The panel follows: the truck is out, so the sale can't go, and the sale can be repeated.
  await expect(sale.getByTestId(`sale-${ROADHOUSE}-dispatch`)).toBeDisabled();
  await expect(page.getByTestId("repeat-sale-line")).toHaveText("1 × Moonshine (basic) to The Crossroads Roadhouse");

  if (process.platform === "linux") await expect(page.getByTestId("panel-market")).toHaveScreenshot("market.png");

  // Repeating the sale while the truck is out: rejected with its typed reason, and nothing changes.
  const before = await stateHash(page);
  await page.getByTestId("repeat-sale-button").click();
  await expect(page.getByTestId("repeat-sale-result")).toContainText("Rejected:");
  await expect(page.getByTestId("repeat-sale-result")).toContainText("VEHICLE_UNAVAILABLE");
  expect(await stateHash(page)).toBe(before);
});

test("a sale at a price the buyer doesn't pay for those cases shows QUOTE_CHANGED with both prices", async ({ page }) => {
  await newGame(page);
  await makeBasicCases(page, 1);
  await openMarket(page);

  // Kessler's wants basic and standard; picking the standard want for basic cases agrees the wrong price.
  const kessler = (await snapshot(page)).market.buyers.find((b) => b.id === KESSLER)!;
  const basicWant = kessler.wants.find((w) => w.minimumQuality === "basic")!;
  const standardWant = kessler.wants.find((w) => w.minimumQuality === "standard")!;
  const sale = page.getByTestId(`sale-${KESSLER}`);
  await sale.getByTestId(`sale-${KESSLER}-want`).selectOption("moonshine:standard");
  await expect(sale.getByTestId(`sale-${KESSLER}-quality`)).toHaveValue("basic");
  await sale.getByTestId(`sale-${KESSLER}-quantity`).fill("1");

  const before = await stateHash(page);
  await sale.getByTestId(`sale-${KESSLER}-dispatch`).click();
  const result = sale.getByTestId(`sale-${KESSLER}-result`);
  await expect(result).toContainText("QUOTE_CHANGED");
  await expect(result).toContainText(`you agreed to $${(standardWant.unitPrice / 100).toFixed(2)} a case, and the buyer now pays $${(basicWant.unitPrice / 100).toFixed(2)}`);
  expect(await stateHash(page)).toBe(before);
});

test("a closed route is shown closed, with its reopening, and can't be picked", async ({ page }) => {
  const closure = FIRST_SHIPMENT_SCENARIO.scheduledEvents.find((e) => e.kind === "ROUTE_CLOSURE" && e.routeId === "county-road")!;
  await newGame(page);
  await advance(page, closure.tick + 1);
  await openMarket(page);

  const s = await snapshot(page);
  const county = s.routes.find((r) => r.id === "county-road")!;
  expect(county.status.open).toBe(false);

  const picker = `sale-${KESSLER}-route`;
  const closed = page.getByTestId(`${picker}-county-road`);
  await expect(closed).toHaveAttribute("data-open", "false");
  await expect(page.getByTestId(`${picker}-county-road-safety`)).toHaveText("Safe");
  await expect(page.getByTestId(`${picker}-county-road-closed`)).toHaveText("Closed");
  await expect(page.getByTestId(`${picker}-county-road-closure`)).toContainText("Closed by a rival crew.");
  if (!county.status.open && county.status.reopensAt !== null) {
    await expect(page.getByTestId(`${picker}-county-road-closure`)).toContainText(`(tick ${county.status.reopensAt})`);
  }
  await expect(page.getByTestId(`${picker}-county-road-radio`)).toBeDisabled();
  await expect(page.getByTestId(`${picker}-kessler-back-road-radio`)).toBeChecked();

  // Clicking the closed route changes nothing.
  await closed.click({ force: true });
  await expect(page.getByTestId(`${picker}-county-road-radio`)).not.toBeChecked();
  await expect(page.getByTestId(`${picker}-kessler-back-road-radio`)).toBeChecked();

  if (process.platform === "linux") await expect(page.getByTestId(picker)).toHaveScreenshot("route-picker.png");
});

test("clicking a supplier or a buyer on the map opens Market at its card", async ({ page }) => {
  await newGame(page);
  await page.locator("[data-testid=map] [data-shape=supplier]").first().click();
  await expect(page.getByTestId("panel-market")).toBeVisible();
  await expect(page.getByTestId("open-market")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId(`supplier-${SUPPLIER}`)).toHaveAttribute("data-selected", "true");

  await page.getByTestId("open-dashboard").click();
  await page.locator("[data-testid=map] [data-shape=buyer]").first().click();
  await expect(page.getByTestId("panel-market")).toBeVisible();
  await expect(page.locator("[data-testid^=buyer-][data-selected=true]")).toHaveCount(1);
});
