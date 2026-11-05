// The Production panel (issue #11): recipes with what can start and why not,
// START_PRODUCTION through the panel, typed rejections, and running jobs.
// Screenshot baselines are linux-only (CI); the assertion is skipped elsewhere.

import { expect, test, type Page } from "@playwright/test";

const snapshot = async (page: Page) => (await page.evaluate(() => window.__eov!.snapshot))!;
const stateHash = (page: Page) => page.evaluate(() => window.__eov!.stateHash);

async function newGame(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("new-game").click();
  await expect(page.getByTestId("panel-dashboard")).toBeVisible();
}

/** Buys `cases` cases' worth of the first recipe's inputs, through the test hook. */
async function buyInputs(page: Page, cases: number): Promise<void> {
  const s = await snapshot(page);
  const facility = s.facilities[0]!;
  for (const input of facility.recipes[0]!.inputsPerCase) {
    const supplier = s.market.suppliers.find((sup) => sup.materials.some((m) => m.materialId === input.materialId))!;
    const outcome = await page.evaluate(
      (r) => window.__eov!.dispatchRaw(r),
      { command: { type: "PURCHASE_MATERIALS", supplierId: supplier.id, materialId: input.materialId, quantity: input.quantity * cases, facilityId: facility.id } },
    );
    expect(outcome).toMatchObject({ kind: "result", result: { status: "applied" } });
  }
}

test("starts production from the panel, and the panel updates from the snapshot", async ({ page }) => {
  await newGame(page);
  await page.getByTestId("open-production").click();
  const s = await snapshot(page);
  const facility = s.facilities[0]!;
  const recipe = facility.recipes[0]!;
  const row = page.getByTestId(`recipe-${recipe.recipeId}`);

  // Blocked before any materials: the reason the simulation gives, and no start.
  await expect(row.getByTestId(`recipe-${recipe.recipeId}-blocked`)).toContainText(recipe.blockedBy!.code);
  await expect(row.getByTestId(`recipe-${recipe.recipeId}-max`)).toHaveText("0");
  await expect(row.getByTestId(`recipe-${recipe.recipeId}-start`)).toBeDisabled();

  await buyInputs(page, 2);
  const stocked = (await snapshot(page)).facilities[0]!.recipes[0]!;
  expect(stocked.blockedBy).toBeNull();
  await expect(row.getByTestId(`recipe-${recipe.recipeId}-max`)).toHaveText(String(stocked.maxStartableQuantity));
  await expect(row.getByTestId(`recipe-${recipe.recipeId}-blocked`)).toHaveText("Nothing");

  // More than can start: rejected with its typed reason, and nothing changes.
  const before = await stateHash(page);
  await row.getByTestId(`recipe-${recipe.recipeId}-quantity`).fill(String(stocked.maxStartableQuantity + 5));
  await row.getByTestId(`recipe-${recipe.recipeId}-start`).click();
  await expect(row.getByTestId(`recipe-${recipe.recipeId}-result`)).toContainText("Rejected:");
  await expect(row.getByTestId(`recipe-${recipe.recipeId}-result`)).toContainText(/INSUFFICIENT_MATERIALS|PRODUCTION_CAPACITY_EXCEEDED/);
  expect(await stateHash(page)).toBe(before);
  await expect(page.getByTestId(`facility-${facility.id}-no-jobs`)).toBeVisible();

  // One case: applied, and the running job appears with its progress.
  await row.getByTestId(`recipe-${recipe.recipeId}-quantity`).fill("1");
  await row.getByTestId(`recipe-${recipe.recipeId}-start`).click();
  await expect(row.getByTestId(`recipe-${recipe.recipeId}-result`)).toHaveText("Done.");
  const running = await snapshot(page);
  const job = running.productionJobs[0]!;
  expect(job).toMatchObject({ facilityId: facility.id, recipeId: recipe.recipeId, quantity: 1 });
  const jobItem = page.getByTestId(`job-${job.id}`);
  await expect(jobItem).toContainText(`completes tick ${job.completesAt}`);
  const progress = page.getByTestId(`job-${job.id}-progress`);
  await expect(progress).toHaveAttribute("max", String(job.completesAt - job.startedAt));
  // A command applies on the next tick, so the job may start just after the current tick.
  await expect(progress).toHaveAttribute("value", String(Math.max(0, running.clock.tick - job.startedAt)));

  if (process.platform === "linux") await expect(page.getByTestId("panel-production")).toHaveScreenshot("production.png");

  // Halfway: the progress bar follows the clock.
  const halfway = Math.floor((job.completesAt - job.startedAt) / 2);
  await page.evaluate((n) => window.__eov!.advance(n), job.startedAt + halfway - running.clock.tick);
  await expect(progress).toHaveAttribute("value", String(halfway));

  // Done: the job is gone and the case is in finished goods.
  await page.evaluate((n) => window.__eov!.advance(n), job.completesAt - job.startedAt - halfway);
  await expect(page.getByTestId(`facility-${facility.id}-no-jobs`)).toBeVisible();
  await expect(page.getByTestId(`facility-${facility.id}-products`)).toContainText("1 cases");
});

test("clicking a location on the map opens its panel", async ({ page }) => {
  await newGame(page);
  await page.locator("[data-testid=map] [data-shape=facility]").first().click();
  await expect(page.getByTestId("panel-production")).toBeVisible();
  await expect(page.getByTestId("open-production")).toHaveAttribute("aria-pressed", "true");
  await page.locator("[data-testid=map] [data-shape=buyer]").first().click();
  await expect(page.getByTestId("panel-placeholder")).toBeVisible();
  await expect(page.getByTestId("open-market")).toHaveAttribute("aria-pressed", "true");
});
