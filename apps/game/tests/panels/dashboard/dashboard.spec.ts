// The Dashboard panel (issue #11): profit, cash flow, and net worth as distinct
// figures, plus cash and the game date, all from the snapshot. Screenshot
// baselines are linux-only (CI); the assertion is skipped elsewhere.

import { formatMoney } from "@eov/contracts";
import { expect, test, type Page } from "@playwright/test";

const snapshot = async (page: Page) => (await page.evaluate(() => window.__eov!.snapshot))!;

async function newGame(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("new-game").click();
  await expect(page.getByTestId("panel-dashboard")).toBeVisible();
}

async function buyCorn(page: Page, quantity: number): Promise<void> {
  const outcome = await page.evaluate(
    (q) =>
      window.__eov!.dispatchRaw({
        command: { type: "PURCHASE_MATERIALS", supplierId: "millers-feed", materialId: "corn", quantity: q, facilityId: "distillery-main" },
      }),
    quantity,
  );
  expect(outcome).toMatchObject({ kind: "result", result: { status: "applied" } });
}

/** Every figure on the dashboard equals the snapshot's, formatted. */
async function expectFiguresMatch(page: Page): Promise<void> {
  const s = await snapshot(page);
  await expect(page.getByTestId("dashboard-cash")).toHaveText(formatMoney(s.finance.cash));
  await expect(page.getByTestId("dashboard-net-worth")).toHaveText(formatMoney(s.finance.netWorth));
  await expect(page.getByTestId("dashboard-date")).toContainText(`tick ${s.clock.tick}`);
  for (const period of ["today", "previousDay", "toDate"] as const) {
    const report = s.finance[period];
    const cell = (row: string) => page.getByTestId(`dashboard-${row}-${period}`);
    await expect(cell("revenue")).toHaveText(report ? formatMoney(report.profit.revenue) : "—");
    await expect(cell("profit")).toHaveText(report ? formatMoney(report.profit.netProfit) : "—");
    await expect(cell("cash-flow")).toHaveText(report ? formatMoney(report.cashFlow.netChange) : "—");
  }
}

test("shows cash, net worth, the date, and profit and cash flow per period", async ({ page }) => {
  await newGame(page);
  await expect(page.getByTestId("dashboard-cash")).toHaveText("$1,000.00");
  await expect(page.getByTestId("dashboard-date")).toContainText("1920-01-17 00:00");
  // Day 0 has no previous day.
  await expect(page.getByTestId("dashboard-profit-previousDay")).toHaveText("—");
  await expectFiguresMatch(page);

  // Buying materials uses cash but isn't an expense: cash flow and profit differ.
  await buyCorn(page, 4);
  const s = await snapshot(page);
  expect(s.finance.today.cashFlow.netChange).toBeLessThan(0);
  expect(s.finance.today.profit.netProfit).toBe(0);
  await expectFiguresMatch(page);
  await expect(page.getByTestId("dashboard-cash-flow-today")).not.toHaveText(await page.getByTestId("dashboard-profit-today").innerText());

  if (process.platform === "linux") await expect(page.getByTestId("panel-dashboard")).toHaveScreenshot("dashboard.png");
});

test("fills in the previous day after midnight", async ({ page }) => {
  await newGame(page);
  await buyCorn(page, 4);
  await page.evaluate(() => window.__eov!.advance(1_440 + 60));
  const s = await snapshot(page);
  expect(s.finance.previousDay).not.toBeNull();
  await expect(page.getByTestId("dashboard-date")).toContainText("1920-01-18 01:00");
  await expectFiguresMatch(page);
});
