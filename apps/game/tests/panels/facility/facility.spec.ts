// The Facility panel (#128): storage, owned equipment with book and resale
// value and SELL_EQUIPMENT, equipment options with their blockedBy (LOCKED
// names its unlock and the tier that grants it, from the snapshot) and
// PURCHASE_EQUIPMENT, and the workforce with SET_WORKFORCE, typed rejections
// included. Every expected figure is read from the snapshot. Screenshot
// baselines are linux-only (CI); the assertions are skipped elsewhere.

import { formatMoney } from "@eov/contracts";
import { expect, test, type Page } from "@playwright/test";
import { FACILITY_COPY as C } from "../../../src/panels/facility/copy.ts";

const snapshot = async (page: Page) => (await page.evaluate(() => window.__eov!.snapshot))!;
const stateHash = (page: Page) => page.evaluate(() => window.__eov!.stateHash);

async function newGame(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("new-game").click();
  await expect(page.getByTestId("panel-dashboard")).toBeVisible();
}

async function openFacility(page: Page): Promise<void> {
  await page.getByTestId("open-facility").click();
  await expect(page.getByTestId("panel-facility")).toBeVisible();
}

test("shows storage, equipment, and locked options from the snapshot, and sets the workforce", async ({ page }) => {
  await newGame(page);
  await openFacility(page);
  const start = await snapshot(page);
  const facility = start.facilities[0]!;
  const f = `facility-${facility.id}`;

  await expect(page.getByTestId(`${f}-storage`)).toHaveText(C.storageLine(facility.storage.used, facility.storage.capacity));
  await expect(page.getByTestId(`${f}-capacity`)).toHaveText(C.capacityLine(facility.productionCapacityPerDay));
  await expect(page.getByTestId(`${f}-equipment-slots`)).toHaveText(C.slots(facility.equipmentSlots.used, facility.equipmentSlots.total));

  // Owned equipment: book and resale value.
  for (const item of facility.equipment) {
    await expect(page.getByTestId(`equipment-${facility.id}-${item.id}-book`)).toHaveText(formatMoney(item.bookValue));
    await expect(page.getByTestId(`equipment-${facility.id}-${item.id}-resale`)).toHaveText(formatMoney(item.resaleValue));
  }

  // Options: LOCKED names its unlock, and the tier that grants it with that tier's requirements; Buy is disabled.
  const locked = facility.equipmentOptions.filter((o) => o.blockedBy?.code === "LOCKED");
  expect(locked.length).toBeGreaterThan(0);
  for (const option of locked) {
    if (option.blockedBy?.code !== "LOCKED") continue;
    const unlockId = option.blockedBy.unlockId;
    const tier = start.progression.tiers.find((t) => t.unlocks.includes(unlockId))!;
    const o = `option-${facility.id}-${option.equipmentId}`;
    await expect(page.getByTestId(`${o}-price`)).toHaveText(formatMoney(option.price));
    await expect(page.getByTestId(`${o}-blocked`)).toContainText("LOCKED");
    await expect(page.getByTestId(`${o}-blocked`)).toContainText(unlockId);
    await expect(page.getByTestId(`${o}-blocked`)).toContainText(tier.name);
    if (tier.reputationRequired !== null) await expect(page.getByTestId(`${o}-blocked`)).toContainText(C.requirementReputation(tier.reputationRequired));
    if (tier.netWorthRequired !== null) await expect(page.getByTestId(`${o}-blocked`)).toContainText(C.requirementNetWorth(formatMoney(tier.netWorthRequired)));
    await expect(page.getByTestId(`${o}-buy`)).toBeDisabled();
  }

  if (process.platform === "linux") await expect(page.getByTestId("panel-facility")).toHaveScreenshot("facility.png");

  // SET_WORKFORCE over the maximum: rejected with its typed reason, and nothing changes.
  const w = `${f}-workforce`;
  await expect(page.getByTestId(`${w}-workers`)).toHaveText(C.workersLine(facility.workforce.workers, facility.workforce.maximum));
  const before = await stateHash(page);
  await page.getByTestId(`${w}-input`).fill(String(facility.workforce.maximum + 1));
  await page.getByTestId(`${w}-set`).click();
  await expect(page.getByTestId(`${w}-result`)).toContainText("Rejected:");
  await expect(page.getByTestId(`${w}-result`)).toContainText("WORKFORCE_LIMIT_EXCEEDED");
  expect(await stateHash(page)).toBe(before);

  // Within the maximum: applied, and the panel follows the snapshot.
  const crew = facility.workforce.workers + 1;
  await page.getByTestId(`${w}-input`).fill(String(crew));
  await page.getByTestId(`${w}-set`).click();
  await expect(page.getByTestId(`${w}-result`)).toHaveText("Done.");
  const hired = (await snapshot(page)).facilities[0]!;
  expect(hired.workforce.workers).toBe(crew);
  await expect(page.getByTestId(`${w}-workers`)).toHaveText(C.workersLine(hired.workforce.workers, hired.workforce.maximum));
  await expect(page.getByTestId(`${w}-input`)).toHaveValue(String(hired.workforce.workers));

  // A crew change made elsewhere (here, through the hook) shows in the input, which isn't being edited.
  const outcome = await page.evaluate((r) => window.__eov!.dispatchRaw(r), { command: { type: "SET_WORKFORCE", facilityId: facility.id, workerCount: facility.workforce.workers } });
  expect(outcome).toMatchObject({ kind: "result", result: { status: "applied" } });
  await expect(page.getByTestId(`${w}-input`)).toHaveValue(String(facility.workforce.workers));
});

test("sells equipment at its resale value after a confirmation, then buys it back", async ({ page }) => {
  await newGame(page);
  await openFacility(page);
  const start = await snapshot(page);
  const facility = start.facilities[0]!;
  const item = facility.equipment[0]!;
  const e = `equipment-${facility.id}-${item.id}`;

  // The first click only asks; cancelling changes nothing.
  const before = await stateHash(page);
  await page.getByTestId(`${e}-sell`).click();
  await expect(page.getByTestId(`${e}-confirm`)).toHaveText(C.confirmSell(formatMoney(item.resaleValue)));
  await page.getByTestId(`${e}-cancel`).click();
  await expect(page.getByTestId(`${e}-confirm`)).toHaveCount(0);
  expect(await stateHash(page)).toBe(before);

  // SELL_EQUIPMENT: cash rises by the resale value, and the item leaves the list.
  await page.getByTestId(`${e}-sell`).click();
  await page.getByTestId(`${e}-confirm`).click();
  await expect(page.getByTestId(e)).toHaveCount(0);
  const sold = await snapshot(page);
  expect(sold.finance.cash).toBe(start.finance.cash + item.resaleValue);
  expect(sold.facilities[0]!.equipment.find((x) => x.id === item.id)).toBeUndefined();
  await expect(page.getByTestId(`facility-${facility.id}-equipment-slots`)).toHaveText(C.slots(sold.facilities[0]!.equipmentSlots.used, sold.facilities[0]!.equipmentSlots.total));

  // PURCHASE_EQUIPMENT: it's on offer again, unblocked, at the snapshot's price.
  const option = sold.facilities[0]!.equipmentOptions.find((o) => o.equipmentId === item.id)!;
  expect(option.blockedBy).toBeNull();
  const o = `option-${facility.id}-${item.id}`;
  await expect(page.getByTestId(`${o}-price`)).toHaveText(formatMoney(option.price));
  await expect(page.getByTestId(`${o}-blocked`)).toHaveCount(0);
  await page.getByTestId(`${o}-buy`).click();
  await expect(page.getByTestId(`${e}-book`)).toBeVisible();
  const bought = await snapshot(page);
  const owned = bought.facilities[0]!.equipment.find((x) => x.id === item.id)!;
  await expect(page.getByTestId(`${e}-book`)).toHaveText(formatMoney(owned.bookValue));
  await expect(page.getByTestId(`${e}-resale`)).toHaveText(formatMoney(owned.resaleValue));
  await expect(page.getByTestId(o)).toHaveCount(0);
  expect(bought.finance.cash).toBe(sold.finance.cash - option.price);
});
