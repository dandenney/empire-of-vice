// The Contracts panel (#128): an offer with its terms and ACCEPT_CONTRACT,
// the active contract's installments, the reservation it holds with
// RELEASE_RESERVATION, a delivery (DISPATCH_DELIVERY, purpose
// CONTRACT_INSTALLMENT) through the shared route picker, typed rejections,
// and the installment settling. Every expected figure is read from the
// snapshot or game-data, not written here. Screenshot baselines are
// linux-only (CI); the assertions are skipped elsewhere.

import { formatMoney, TICKS_PER_DAY } from "@eov/contracts";
import { CONTRACTS } from "@eov/game-data";
import { expect, test, type Page } from "@playwright/test";
import { formatQuality } from "../../../src/components/format.ts";
import { CONTRACTS_COPY as C } from "../../../src/panels/contracts/copy.ts";
import { formatDayTime, formatPpmPercent, formatSpan } from "../../../src/panels/contracts/contracts-view.ts";

const snapshot = async (page: Page) => (await page.evaluate(() => window.__eov!.snapshot))!;
const stateHash = (page: Page) => page.evaluate(() => window.__eov!.stateHash);
const advance = (page: Page, ticks: number) => page.evaluate((n) => window.__eov!.advance(n), ticks);

const KESSLER = "kesslers-back-room";

async function newGame(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("new-game").click();
  await expect(page.getByTestId("panel-dashboard")).toBeVisible();
}

async function openContracts(page: Page): Promise<void> {
  await page.getByTestId("open-contracts").click();
  await expect(page.getByTestId("panel-contracts")).toBeVisible();
}

async function dispatch(page: Page, command: unknown): Promise<void> {
  const outcome = await page.evaluate((r) => window.__eov!.dispatchRaw(r), { command });
  expect(outcome, JSON.stringify(command)).toMatchObject({ kind: "result", result: { status: "applied" } });
}

/** Buys the inputs for `cases` cases of the first recipe and makes them, through the test hook. */
async function makeCases(page: Page, cases: number): Promise<void> {
  const start = await snapshot(page);
  const facility = start.facilities[0]!;
  const recipe = facility.recipes[0]!;
  for (const input of recipe.inputsPerCase) {
    const supplier = start.market.suppliers.find((s) => s.materials.some((m) => m.materialId === input.materialId))!;
    await dispatch(page, { type: "PURCHASE_MATERIALS", supplierId: supplier.id, materialId: input.materialId, quantity: input.quantity * cases, facilityId: facility.id });
  }
  let made = 0;
  while (made < cases) {
    const s = await snapshot(page);
    const max = s.facilities[0]!.recipes.find((r) => r.recipeId === recipe.recipeId)!.maxStartableQuantity;
    if (max === 0) {
      await advance(page, TICKS_PER_DAY - (s.clock.tick % TICKS_PER_DAY));
      continue;
    }
    const quantity = Math.min(max, cases - made);
    await dispatch(page, { type: "START_PRODUCTION", facilityId: facility.id, recipeId: recipe.recipeId, quantity });
    const job = (await snapshot(page)).productionJobs.at(-1)!;
    await advance(page, job.completesAt - (await snapshot(page)).clock.tick);
    made += quantity;
  }
}

/** Runs to the next midnight until a contract offer is on the table. */
async function waitForOffer(page: Page) {
  for (let day = 0; day < 7; day++) {
    const s = await snapshot(page);
    const offer = s.contracts.offers.find((o) => o.buyerId === KESSLER);
    if (offer) return offer;
    await advance(page, TICKS_PER_DAY - (s.clock.tick % TICKS_PER_DAY) + 1);
  }
  throw new Error("No contract offer within a week");
}

test("accepts an offer, releases what it holds, and delivers an installment through the route picker", async ({ page }) => {
  await newGame(page);
  await openContracts(page);
  await expect(page.getByTestId("contracts-no-offers")).toBeVisible();
  await expect(page.getByTestId("contracts-no-active")).toBeVisible();

  const terms = CONTRACTS.buyers.find((b) => b.buyerId === KESSLER)!;
  await makeCases(page, terms.quantityPerInstallment);
  const offer = await waitForOffer(page);

  // The offer's terms, from the snapshot.
  const card = page.getByTestId(`offer-${offer.id}`);
  await expect(card).toContainText(offer.buyerName);
  await expect(card.getByTestId(`offer-${offer.id}-quantity`)).toHaveText(String(offer.quantityPerInstallment));
  await expect(card.getByTestId(`offer-${offer.id}-count`)).toHaveText(String(offer.installmentCount));
  await expect(card.getByTestId(`offer-${offer.id}-interval`)).toHaveText(formatSpan(offer.intervalTicks));
  await expect(card.getByTestId(`offer-${offer.id}-price`)).toHaveText(formatMoney(offer.unitPrice));
  await expect(card.getByTestId(`offer-${offer.id}-penalty`)).toHaveText(C.penaltyLine(formatPpmPercent(offer.penaltyRatePpm)));
  await expect(card.getByTestId(`offer-${offer.id}-first-deadline`)).toHaveText(formatDayTime(offer.firstDeadline));
  await expect(card.getByTestId(`offer-${offer.id}-expires`)).toHaveText(formatDayTime(offer.expiresAt));
  expect(offer.blockedBy).toBeNull();
  await expect(card.getByTestId(`offer-${offer.id}-accept`)).toBeEnabled();

  // ACCEPT_CONTRACT: the offer becomes an active contract holding stock.
  await card.getByTestId(`offer-${offer.id}-accept`).click();
  await expect(page.getByTestId("contracts-no-active")).toHaveCount(0);
  const accepted = await snapshot(page);
  expect(accepted.contracts.offers.find((o) => o.id === offer.id)).toBeUndefined();
  const contract = accepted.contracts.active.find((c) => c.buyerId === KESSLER)!;
  expect(contract.reservationIds.length).toBeGreaterThan(0);
  const box = page.getByTestId(`contract-${contract.id}`);
  await expect(box).toBeVisible();
  await expect(page.getByTestId(`offer-${offer.id}`)).toHaveCount(0);

  const rows = box.getByTestId(`contract-${contract.id}-installments`).locator("tbody tr");
  await expect(rows).toHaveCount(contract.installmentCount);
  for (const i of contract.installments) {
    const row = `contract-${contract.id}-installment-${i.index}`;
    await expect(box.getByTestId(`${row}-deadline`)).toHaveText(formatDayTime(i.deadline));
    await expect(box.getByTestId(`${row}-required`)).toHaveText(String(i.required));
    await expect(box.getByTestId(`${row}-delivered`)).toHaveText(String(i.delivered));
    await expect(box.getByTestId(`${row}-outcome`)).toHaveText(C.pending);
  }
  await expect(box.getByTestId(`contract-${contract.id}-reserved`)).toHaveText(C.heldCases(contract.reservedQuantity));
  const pool = accepted.facilities[0]!.products.find((p) => p.productId === contract.productId)!;
  await expect(page.getByTestId("reserved-lines")).toContainText(C.productReserved(pool.productName, formatQuality(pool.quality), pool.reservedQuantity, pool.quantity));

  // RELEASE_RESERVATION on the contract's hold: the cases are free again.
  const reservationId = contract.reservationIds[0]!;
  await box.getByTestId(`release-${reservationId}`).click();
  await expect(box.getByTestId(`release-${reservationId}`)).toHaveCount(0);
  const released = (await snapshot(page)).contracts.active.find((c) => c.id === contract.id)!;
  expect(released.reservationIds).not.toContain(reservationId);
  await expect(box.getByTestId(`contract-${contract.id}-reserved`)).toHaveText(C.heldCases(released.reservedQuantity));
  await expect(page.getByTestId("reserved-none")).toBeVisible();

  // More than the truck carries: rejected with its typed reason, and nothing changes.
  const form = box.getByTestId(`deliver-${contract.id}`);
  const truck = accepted.vehicles[0]!;
  const before = await stateHash(page);
  await form.getByTestId(`deliver-${contract.id}-quantity`).fill(String(truck.capacity + 1));
  await form.getByTestId(`deliver-${contract.id}-dispatch`).click();
  await expect(form.getByTestId(`deliver-${contract.id}-result`)).toContainText("Rejected:");
  await expect(form.getByTestId(`deliver-${contract.id}-result`)).toContainText("VEHICLE_CAPACITY_EXCEEDED");
  expect(await stateHash(page)).toBe(before);

  // DISPATCH_DELIVERY for the installment, on the picker's default (Safe) route.
  const picker = `deliver-${contract.id}-route`;
  await expect(form.getByTestId(picker)).toBeVisible();
  const checked = form.locator(`label[data-testid^="${picker}-"][data-checked="true"]`);
  await expect(checked).toHaveCount(1);
  await expect(checked.locator(".route-badge[data-safety]")).toHaveText("Safe");
  await form.getByTestId(`deliver-${contract.id}-quantity`).fill(String(contract.quantityPerInstallment));
  await form.getByTestId(`deliver-${contract.id}-dispatch`).click();
  await expect(form.getByTestId(`deliver-${contract.id}-result`)).toHaveText("Done.");

  const sent = await snapshot(page);
  const dispatched = sent.recentEvents.filter((e) => e.type === "DELIVERY_DISPATCHED").at(-1)!;
  expect(dispatched).toMatchObject({
    purpose: { kind: "CONTRACT_INSTALLMENT", contractId: contract.id },
    cargo: [{ productId: contract.productId, quality: contract.minimumQuality, quantity: contract.quantityPerInstallment }],
  });
  const onRoad = sent.contracts.active.find((c) => c.id === contract.id)!.installments[0]!;
  await expect(box.getByTestId(`contract-${contract.id}-installment-0-in-transit`)).toHaveText(String(onRoad.inTransit));
  expect(onRoad.inTransit).toBe(contract.quantityPerInstallment);
  // The truck is out, so another delivery can't go.
  await expect(form.getByTestId(`deliver-${contract.id}-dispatch`)).toBeDisabled();

  if (process.platform === "linux") await expect(page.getByTestId("panel-contracts")).toHaveScreenshot("contracts.png");

  // The cases arrive, then the deadline settles the installment.
  const trip = sent.vehicles[0]!.trip!;
  await advance(page, trip.arrivesAt - sent.clock.tick);
  const arrived = (await snapshot(page)).contracts.active.find((c) => c.id === contract.id)!.installments[0]!;
  expect(arrived.delivered).toBe(contract.quantityPerInstallment);
  await expect(box.getByTestId(`contract-${contract.id}-installment-0-delivered`)).toHaveText(String(arrived.delivered));

  await advance(page, arrived.deadline - (await snapshot(page)).clock.tick + 1);
  const settled = (await snapshot(page)).contracts.active.find((c) => c.id === contract.id)!.installments[0]!;
  expect(settled.outcome).toBe("FULFILLED");
  await expect(box.getByTestId(`contract-${contract.id}-installment-0-outcome`)).toHaveText(C.outcomes.FULFILLED);
  await expect(box.getByTestId(`contract-${contract.id}-installment-0-penalty`)).toHaveText(formatMoney(settled.penalty!));
});
