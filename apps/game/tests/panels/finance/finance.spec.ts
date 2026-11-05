// The Finance panel (issue #11): balance sheet, income statement and cash
// flow by category, and recent transactions with their kind and amounts, all
// from the snapshot. Screenshot baselines are linux-only (CI); the assertion is
// skipped elsewhere.

import { formatMoney } from "@eov/contracts";
import { expect, test, type Page } from "@playwright/test";

const snapshot = async (page: Page) => (await page.evaluate(() => window.__eov!.snapshot))!;

async function newGameWithPurchase(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("new-game").click();
  await page.getByTestId("open-finance").click();
  await expect(page.getByTestId("panel-finance")).toBeVisible();
  const outcome = await page.evaluate(() =>
    window.__eov!.dispatchRaw({
      command: { type: "PURCHASE_MATERIALS", supplierId: "millers-feed", materialId: "corn", quantity: 4, facilityId: "distillery-main" },
    }),
  );
  expect(outcome).toMatchObject({ kind: "result", result: { status: "applied" } });
}

test("shows the balance sheet from the snapshot", async ({ page }) => {
  await newGameWithPurchase(page);
  const { balanceSheet } = (await snapshot(page)).finance;
  for (const [key, amount] of Object.entries(balanceSheet.assets)) {
    await expect(page.getByTestId(`finance-asset-${key}`)).toHaveText(formatMoney(amount));
  }
  for (const [key, amount] of Object.entries(balanceSheet.liabilities)) {
    await expect(page.getByTestId(`finance-liability-${key}`)).toHaveText(formatMoney(amount));
  }
  await expect(page.getByTestId("finance-total-assets")).toHaveText(formatMoney(balanceSheet.totalAssets));
  await expect(page.getByTestId("finance-total-liabilities")).toHaveText(formatMoney(balanceSheet.totalLiabilities));
  await expect(page.getByTestId("finance-equity")).toHaveText(formatMoney(balanceSheet.equity));
  expect(balanceSheet.assets.rawMaterials).toBeGreaterThan(0);

  if (process.platform === "linux") await expect(page.getByTestId("panel-finance")).toHaveScreenshot("finance.png");
});

test("shows the income statement and cash flow by category for each period", async ({ page }) => {
  await newGameWithPurchase(page);
  const s = await snapshot(page);
  const today = s.finance.today;
  await expect(page.getByTestId("finance-revenue")).toHaveText(formatMoney(today.profit.revenue));
  await expect(page.getByTestId("finance-net-profit")).toHaveText(formatMoney(today.profit.netProfit));
  for (const e of today.profit.expenses) await expect(page.getByTestId(`finance-expense-${e.category}`)).toHaveText(formatMoney(e.amount));
  for (const l of today.cashFlow.lines) await expect(page.getByTestId(`finance-cash-${l.category}`)).toHaveText(formatMoney(l.amount));
  await expect(page.getByTestId("finance-cash-MATERIALS")).not.toHaveText("$0.00");
  await expect(page.getByTestId("finance-closing-cash")).toHaveText(formatMoney(today.cashFlow.closingCash));

  // No previous day on day 0; to date covers the opening balance onward.
  await page.getByTestId("finance-period-previousDay").check();
  await expect(page.getByTestId("finance-no-period")).toBeVisible();
  await page.getByTestId("finance-period-toDate").check();
  await expect(page.getByTestId("finance-opening-cash")).toHaveText(formatMoney(s.finance.toDate.cashFlow.openingCash));
  await expect(page.getByTestId("finance-net-change")).toHaveText(formatMoney(s.finance.toDate.cashFlow.netChange));
});

test("lists recent transactions with their kind and entries, newest first", async ({ page }) => {
  await newGameWithPurchase(page);
  const transactions = (await snapshot(page)).finance.recentTransactions;
  const rows = page.getByTestId("finance-transaction");
  await expect(rows).toHaveCount(transactions.length);
  const newest = transactions.at(-1)!;
  expect(newest.kind).toBe("MATERIAL_PURCHASE");
  await expect(rows.first()).toHaveAttribute("data-kind", "MATERIAL_PURCHASE");
  await expect(rows.first()).toContainText("Material purchase");
  for (const entry of newest.entries) await expect(rows.first()).toContainText(formatMoney(entry.amount));
  await expect(rows.first()).toContainText("Dr Raw materials");
  await expect(rows.first()).toContainText("Cr Cash");
});
