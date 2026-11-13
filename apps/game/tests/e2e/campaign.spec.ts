// The M001 vertical slice through the browser (T06c, #137): a scripted
// campaign from a new game to victory, every command entered in the panels a
// player would use, covering the GDD §4 player actions:
//
//   1. Buy raw materials from a supplier (Market).
//   2. Schedule and complete production of basic moonshine (Production).
//   3. View market offers and buyer constraints (Market, Progression).
//   4. Assign inventory and a truck to a delivery (Market, Contracts).
//   5. Receive sale proceeds; inspect cash flow, profit, and net worth (Dashboard, Finance).
//   6. Reinvest in equipment and workers (Facility).
//   7. Unlock and fulfill a recurring contract, across all three installments (Contracts).
//   8. Respond to the rival County Road closure (the route picker): its own test below.
//   9. Reach victory; save, close, and resume (end screen, game menu).
//
// The script is the economy lab's contract taker: it plays a headless new game
// in Node (tests/end-screen/campaign.ts) and records every command with its
// tick. Here each command is typed into its panel and sent with the panel's
// button; only time moves through the test hook (`window.__eov.advance`, exact
// and paused). The browser's state hash must equal the headless run's at the
// mid-campaign save and at victory, so the panels sent exactly the commands
// the plan holds. The game is saved, the page reloaded, and the save loaded
// partway through a contract, and again after victory.

import { formatMoney, subtractMoney, TICKS_PER_DAY, type GameEvent } from "@eov/contracts";
import { COUNTY_ROAD, FIRST_SHIPMENT_SCENARIO, KESSLER_BACK_ROAD } from "@eov/game-data";
import { expect, test, type Page } from "@playwright/test";
import { SAVES_COPY } from "../../src/app/saves/copy.ts";
import { formatQuality } from "../../src/components/format.ts";
import { CONTRACTS_COPY } from "../../src/panels/contracts/copy.ts";
import { FACILITY_COPY } from "../../src/panels/facility/copy.ts";
import { MARKET_COPY } from "../../src/panels/market/copy.ts";
import { PROGRESSION_COPY } from "../../src/panels/progression/copy.ts";
import { closureNote, formatRisk } from "../../src/ui/route-picker/route-options.ts";
import { advanceTo, newGame, planVictory, snapshot, type VictoryPlan } from "../end-screen/campaign.ts";
import { headlessHashAt, openPanel, PlanPlayer, press, sendThroughUi, stateHash } from "./ui-driver.ts";

type EventOf<T extends GameEvent["type"]> = Extract<GameEvent, { type: T }>;

function firstEvent<T extends GameEvent["type"]>(plan: VictoryPlan, type: T, where: (e: EventOf<T>) => boolean = () => true): EventOf<T> {
  const event = plan.events.find((e): e is EventOf<T> => e.type === type && where(e as EventOf<T>));
  if (!event) throw new Error(`The plan has no ${type}`);
  return event;
}

/** Progression: standing and reputation as the panel shows them, equal to the snapshot's. */
async function expectStanding(page: Page, tierName: string): Promise<void> {
  await openPanel(page, "progression");
  const s = await snapshot(page);
  const tier = s.progression.tiers.find((t) => t.id === s.progression.currentTierId)!;
  expect(tier.name).toBe(tierName);
  await expect(page.getByTestId("progression-standing")).toHaveText(tierName);
  await expect(page.getByTestId("progression-reputation")).toHaveText(String(s.family.reputation));
  await expect(page.getByTestId("progression-net-worth")).toHaveText(formatMoney(s.finance.netWorth));
}

/** Dashboard and Finance figures equal the snapshot's. */
async function expectBooks(page: Page): Promise<void> {
  await openPanel(page, "dashboard");
  const s = await snapshot(page);
  await expect(page.getByTestId("dashboard-cash")).toHaveText(formatMoney(s.finance.cash));
  await expect(page.getByTestId("dashboard-net-worth")).toHaveText(formatMoney(s.finance.netWorth));
  for (const period of ["today", "toDate"] as const) {
    const report = s.finance[period];
    await expect(page.getByTestId(`dashboard-revenue-${period}`)).toHaveText(formatMoney(report.profit.revenue));
    await expect(page.getByTestId(`dashboard-profit-${period}`)).toHaveText(formatMoney(report.profit.netProfit));
    await expect(page.getByTestId(`dashboard-cash-flow-${period}`)).toHaveText(formatMoney(report.cashFlow.netChange));
  }
}

/**
 * Saves from the top bar, reloads the page (closing the game), and loads the
 * save with Continue. The first save names its slot for the game date; the
 * next writes over the slot the game was loaded from, under that name (#145).
 */
async function saveCloseResume(page: Page, slotLabel: string): Promise<string> {
  await press(page, "save");
  await expect(page.getByTestId("message")).toHaveText(SAVES_COPY.saved(slotLabel));
  const saved = (await stateHash(page))!;
  const before = await snapshot(page);
  await page.reload();
  await expect(page.getByTestId("reload")).toBeEnabled();
  expect(await page.evaluate(() => window.__eov?.snapshot ?? null)).toBeNull();
  await press(page, "reload");
  await expect(page.getByTestId("message")).toHaveText(SAVES_COPY.loaded);
  expect(await stateHash(page)).toBe(saved);
  expect(await snapshot(page)).toEqual(before);
  expect(await page.evaluate(() => window.__eov!.scheduler.speed)).toBe(0);
  return saved;
}

test("plays a campaign to victory through the panels, saving and resuming mid-contract and after victory", async ({ page }) => {
  test.setTimeout(180_000);
  const plan = planVictory();
  const player = new PlanPlayer(page, plan);
  await newGame(page);
  const start = await snapshot(page);
  const facility = start.facilities[0]!;

  // 3. Market offers and buyer constraints, before anything is sold: each buyer's
  // quotes, and the reputation a gated buyer wants before it will deal.
  await openPanel(page, "market");
  for (const buyer of start.market.buyers) {
    const card = page.getByTestId(`buyer-${buyer.id}`);
    await expect(card).toHaveAttribute("data-will-deal", String(buyer.willDeal));
    await expect(card.getByTestId(`buyer-${buyer.id}-deal`)).toHaveText(
      buyer.willDeal ? MARKET_COPY.willDeal : MARKET_COPY.minimumReputation(buyer.minimumReputation, start.family.reputation),
    );
    await expect(card.getByTestId(`buyer-${buyer.id}-budget`)).toHaveText(formatMoney(buyer.budgetRemaining));
    for (const want of buyer.wants) await expect(card).toContainText(MARKET_COPY.wantLine(want.productName, formatQuality(want.minimumQuality)));
  }
  const gated = start.market.buyers.filter((b) => !b.willDeal);
  expect(gated.length).toBeGreaterThan(0);
  for (const b of gated) await expect(page.getByTestId(`sale-${b.id}-dispatch`)).toBeDisabled();

  // 1. Buy raw materials: the plan's tick-0 purchases, from the Market panel.
  const opening = plan.steps.filter((s) => s.tick === 0);
  const purchases = opening.slice(0, opening.findIndex((s) => s.command.type !== "PURCHASE_MATERIALS"));
  expect(purchases.length).toBeGreaterThan(0);
  await player.next(purchases.length);
  const stocked = await snapshot(page);
  for (const step of purchases) {
    if (step.command.type !== "PURCHASE_MATERIALS") continue;
    const { supplierId, materialId, quantity } = step.command;
    const was = start.market.suppliers.find((s) => s.id === supplierId)!.materials.find((m) => m.materialId === materialId)!.available;
    await expect(page.getByTestId(`material-${supplierId}-${materialId}-available`)).toHaveText(String(was - quantity));
    expect(stocked.facilities[0]!.materials.find((m) => m.materialId === materialId)!.quantity).toBe(quantity);
  }
  expect(stocked.finance.cash).toBeLessThan(start.finance.cash);

  // 2. Schedule production: the first run starts from the Production panel...
  await player.throughUi(0);
  const running = await snapshot(page);
  const job = running.productionJobs[0]!;
  await openPanel(page, "production");
  await expect(page.getByTestId(`job-${job.id}`)).toBeVisible();
  // ...and completes into finished goods.
  expect(job.completesAt).toBeLessThanOrEqual(player.peek()!.tick);
  await advanceTo(page, job.completesAt);
  const made = await snapshot(page);
  const pool = made.facilities[0]!.products.find((p) => p.productId === job.productId && p.quality === job.quality)!;
  expect(pool.quantity).toBe(job.quantity);
  await expect(page.getByTestId(`facility-${facility.id}-no-jobs`)).toBeVisible();
  await expect(page.getByTestId(`facility-${facility.id}-products`)).toContainText(`${pool.quantity} cases`);

  // 4. The first spot sale: cases and the truck, from the Market panel's sale form.
  const firstSale = plan.steps.find((s) => s.command.type === "DISPATCH_DELIVERY" && s.command.purpose.kind === "SALE")!;
  await player.throughUi(firstSale.tick);
  const sent = await snapshot(page);
  const trip = sent.vehicles[0]!.trip!;
  expect(trip.purpose.kind).toBe("SALE");
  await expect(page.getByTestId(`sale-${trip.purpose.kind === "SALE" ? trip.purpose.buyerId : ""}-dispatch`)).toBeDisabled();

  // 5. The proceeds arrive; Dashboard and Finance show cash flow, profit, and net worth.
  expect(trip.arrivesAt).toBeLessThan(player.peek()!.tick);
  await advanceTo(page, trip.arrivesAt);
  const sold = await snapshot(page);
  expect(sold.recentEvents.some((e) => e.type === "SALE_COMPLETED")).toBe(true);
  expect(sold.finance.toDate.profit.revenue).toBeGreaterThan(0);
  await expectBooks(page);
  await openPanel(page, "finance");
  await expect(page.getByTestId("finance-transaction").first()).toHaveAttribute("data-kind", "SALE");
  await expect(page.getByTestId("finance-transaction").first()).toContainText(formatMoney(subtractMoney(sold.finance.cash, sent.finance.cash)));

  // 7. A recurring contract: the offer on the table, accepted from the Contracts panel.
  const accept = plan.steps.find((s) => s.command.type === "ACCEPT_CONTRACT")!;
  await player.throughUi(accept.tick, { exclusive: true });
  const offered = await snapshot(page);
  const offer = offered.contracts.offers.find((o) => accept.command.type === "ACCEPT_CONTRACT" && o.id === accept.command.contractOfferId)!;
  await openPanel(page, "contracts");
  await expect(page.getByTestId(`offer-${offer.id}-count`)).toHaveText(String(offer.installmentCount));
  await expect(page.getByTestId(`offer-${offer.id}-price`)).toHaveText(formatMoney(offer.unitPrice));
  await player.throughUi(accept.tick);
  const contract = (await snapshot(page)).contracts.active.find((c) => c.buyerId === offer.buyerId)!;
  expect(contract.installmentCount).toBeGreaterThanOrEqual(2);
  const box = page.getByTestId(`contract-${contract.id}`);
  await expect(box).toBeVisible();

  // Its first installment, delivered from the contract's form, settles fulfilled.
  const settled = (index: number) => firstEvent(plan, "INSTALLMENT_SETTLED", (e) => e.contractId === contract.id && e.installmentIndex === index);
  const first = settled(0);
  await player.throughUi(first.tick - 1);
  await openPanel(page, "contracts");
  const delivered = (await snapshot(page)).contracts.active.find((c) => c.id === contract.id)!.installments[0]!;
  expect(delivered.delivered).toBe(delivered.required);
  await expect(box.getByTestId(`contract-${contract.id}-installment-0-delivered`)).toHaveText(String(delivered.delivered));
  await expect(box.getByTestId(`contract-${contract.id}-installment-0-outcome`)).toHaveText(CONTRACTS_COPY.pending);
  const repBefore = (await snapshot(page)).family.reputation;
  await player.throughUi(first.tick);
  await expect(box.getByTestId(`contract-${contract.id}-installment-0-outcome`)).toHaveText(CONTRACTS_COPY.outcomes.FULFILLED);
  await expect(box.getByTestId(`contract-${contract.id}-installment-1-outcome`)).toHaveText(CONTRACTS_COPY.pending);
  expect((await snapshot(page)).family.reputation).toBeGreaterThan(repBefore);
  await expectStanding(page, start.progression.tiers[0]!.name);

  // 9 (mid-campaign). Save, close, and resume partway through the contract; the
  // browser's state equals the headless run's at the same tick.
  const slotLabel = await page.getByTestId("game-date").innerText();
  const savedHash = await saveCloseResume(page, slotLabel);
  expect(savedHash).toBe(headlessHashAt(plan, first.tick));
  await openPanel(page, "contracts");
  await expect(box.getByTestId(`contract-${contract.id}-installment-0-outcome`)).toHaveText(CONTRACTS_COPY.outcomes.FULFILLED);
  await expect(box.getByTestId(`contract-${contract.id}-installment-1-outcome`)).toHaveText(CONTRACTS_COPY.pending);

  // The second installment settles after the reload; the promotion comes with it.
  const second = settled(1);
  const promotion = firstEvent(plan, "TIER_REACHED");
  expect(promotion.tick).toBe(second.tick);
  await player.throughUi(second.tick, { exclusive: true });
  await advanceTo(page, second.tick);
  await openPanel(page, "contracts");
  await expect(box.getByTestId(`contract-${contract.id}-installment-1-outcome`)).toHaveText(CONTRACTS_COPY.outcomes.FULFILLED);
  const promoted = await snapshot(page);
  const reached = plan.events.filter((e): e is EventOf<"TIER_REACHED"> => e.type === "TIER_REACHED" && e.tick === second.tick);
  await expectStanding(page, promoted.progression.tiers.find((t) => t.id === reached.at(-1)!.tierId)!.name);
  for (const r of reached.slice(0, -1)) await expect(page.getByTestId(`progression-tier-${r.tierId}-status`)).toHaveText(PROGRESSION_COPY.reached);
  await expect(page.getByTestId(`progression-tier-${reached.at(-1)!.tierId}-status`)).toHaveText(PROGRESSION_COPY.current);

  // 6. Reinvest: the plan's upgrades and crew, from the Facility panel.
  const reinvest = plan.steps.filter((s) => s.tick === second.tick);
  expect(reinvest.map((s) => s.command.type)).toEqual(expect.arrayContaining(["PURCHASE_EQUIPMENT", "SET_WORKFORCE"]));
  await openPanel(page, "facility");
  const capacityBefore = promoted.facilities[0]!.productionCapacityPerDay;
  await player.throughUi(second.tick);
  const upgraded = (await snapshot(page)).facilities[0]!;
  for (const step of reinvest) {
    if (step.command.type === "PURCHASE_EQUIPMENT") {
      const owned = upgraded.equipment.find((e) => step.command.type === "PURCHASE_EQUIPMENT" && e.id === step.command.equipmentId)!;
      await expect(page.getByTestId(`equipment-${facility.id}-${owned.id}-book`)).toHaveText(formatMoney(owned.bookValue));
    }
    if (step.command.type === "SET_WORKFORCE") expect(upgraded.workforce.workers).toBe(step.command.workerCount);
  }
  await openPanel(page, "facility");
  await expect(page.getByTestId(`facility-${facility.id}-workforce-workers`)).toHaveText(FACILITY_COPY.workersLine(upgraded.workforce.workers, upgraded.workforce.maximum));
  await expect(page.getByTestId(`facility-${facility.id}-capacity`)).toHaveText(FACILITY_COPY.capacityLine(upgraded.productionCapacityPerDay));
  expect(upgraded.productionCapacityPerDay).toBeGreaterThan(capacityBefore);

  // 7 (done). The third installment settles and the contract is completed.
  const completed = firstEvent(plan, "CONTRACT_COMPLETED", (e) => e.contractId === contract.id);
  await player.throughUi(completed.tick);
  await openPanel(page, "contracts");
  const fulfilled = CONTRACTS_COPY.outcomes.FULFILLED;
  await expect(page.getByTestId(`closed-${contract.id}`)).toHaveText(
    CONTRACTS_COPY.closedLine(contract.buyerName, CONTRACTS_COPY.outcomeList(completed.outcomes.map(() => fulfilled))),
  );
  expect((await snapshot(page)).progression.victory.completedContracts.current).toBeGreaterThanOrEqual(1);

  // 9. Victory: the rest of the plan through the panels, then the end screen.
  await player.throughUi(plan.victoryTick);
  expect(player.peek()).toBeNull();
  const won = await snapshot(page);
  expect(won.outcome).toEqual({ status: "WON", tick: plan.victoryTick });
  expect(await stateHash(page)).toBe(headlessHashAt(plan, plan.victoryTick));
  const victory = firstEvent(plan, "VICTORY_ACHIEVED");
  const screen = page.getByTestId("end-screen-victory");
  await expect(screen).toBeVisible();
  await expect(page.getByTestId("end-net-worth")).toHaveText(formatMoney(victory.netWorth));
  await expect(page.getByTestId("end-reputation")).toHaveText(String(victory.reputation));
  await expect(page.getByTestId("end-completed-contracts")).toHaveText(String(won.progression.victory.completedContracts.current));
  await page.getByTestId("end-review").click();
  await expect(screen).toBeHidden();

  // Tier, reputation, and victory as Progression shows them.
  const top = won.progression.tiers.at(-1)!;
  await expectStanding(page, top.name);
  await expect(page.getByTestId("progression-top-tier")).toBeVisible();
  const v = won.progression.victory;
  expect(v.reputation.current).toBeGreaterThanOrEqual(v.reputation.target);
  expect(v.netWorth.current).toBeGreaterThanOrEqual(v.netWorth.target);
  for (const kind of ["net-worth", "reputation", "completed-contracts"]) {
    await expect(page.getByTestId(`progression-victory-${kind}-status`)).toHaveText(PROGRESSION_COPY.met);
  }
  await expect(page.getByTestId("progression-victory-reputation-now")).toHaveText(String(v.reputation.current));
  await expect(page.getByTestId("progression-victory-net-worth-now")).toHaveText(formatMoney(v.netWorth.current));

  // Save, close, and resume the won game: still won, and it carries on.
  await saveCloseResume(page, slotLabel);
  expect((await snapshot(page)).outcome).toEqual({ status: "WON", tick: plan.victoryTick });
  await expect(page.getByTestId("end-screen-victory")).toBeVisible();
  await page.getByTestId("end-review").click();
  await advanceTo(page, plan.victoryTick + TICKS_PER_DAY);
  expect((await snapshot(page)).outcome.status).toBe("WON");
  await expectStanding(page, top.name);
});

test("responds to the rival County Road closure: the picker routes around it, and the sale goes by Kessler's back road", async ({ page }) => {
  test.setTimeout(120_000);
  const closure = FIRST_SHIPMENT_SCENARIO.scheduledEvents.find((e) => e.kind === "ROUTE_CLOSURE" && e.routeId === COUNTY_ROAD)!;
  const player = new PlanPlayer(page, planVictory());
  await newGame(page);

  // The campaign, through the hook, to the first day of the closure (Kessler's
  // budget is fresh), once the batch in the still is done: there's stock to sell.
  const morning = (Math.floor(closure.tick / TICKS_PER_DAY) + 1) * TICKS_PER_DAY;
  await player.throughHook(morning);
  const batch = (await snapshot(page)).productionJobs[0]!;
  await player.throughHook(batch.completesAt);
  const s = await snapshot(page);
  const county = s.routes.find((r) => r.id === COUNTY_ROAD)!;
  if (county.status.open || county.status.reopensAt === null) throw new Error(`County Road should be closed with a reopening: ${JSON.stringify(county.status)}`);
  const reopensAt = county.status.reopensAt;
  expect(reopensAt).toBeGreaterThan(s.clock.tick);
  const truck = s.vehicles[0]!;
  expect(truck.trip).toBeNull();
  const kessler = s.market.buyers.find((b) => b.locationId === county.toLocationId)!;
  expect(kessler.willDeal).toBe(true);

  // Kessler's sale form: County Road (the Safe default) is closed and can't be
  // picked, so the picker has already fallen back to the open, Risky back road.
  await openPanel(page, "market");
  const picker = `sale-${kessler.id}-route`;
  await expect(page.getByTestId(`${picker}-${COUNTY_ROAD}`)).toHaveAttribute("data-open", "false");
  await expect(page.getByTestId(`${picker}-${COUNTY_ROAD}-closed`)).toBeVisible();
  await expect(page.getByTestId(`${picker}-${COUNTY_ROAD}-closure`)).toHaveText(closureNote(county, s.clock.tick).join(" "));
  await expect(page.getByTestId(`${picker}-${COUNTY_ROAD}-radio`)).toBeDisabled();
  const backRoad = s.routes.find((r) => r.id === KESSLER_BACK_ROAD)!;
  await expect(page.getByTestId(`${picker}-${backRoad.id}-radio`)).toBeChecked();
  await expect(page.getByTestId(`${picker}-${backRoad.id}-safety`)).toHaveText("Risky");
  await expect(page.getByTestId(`${picker}-${backRoad.id}-risk`)).toHaveText(formatRisk(backRoad.riskPpm));

  // The response: take the risk. The best-paying want there's free stock for, as many cases as Kessler takes.
  const pools = s.facilities[0]!.products.filter((p) => p.quantity - p.reservedQuantity > 0);
  const [want, pool] = kessler.wants
    .flatMap((w) => pools.filter((p) => p.productId === w.productId && p.quality === w.minimumQuality).map((p) => [w, p] as const))
    .sort(([a], [b]) => b.unitPrice - a.unitPrice)[0]!;
  const quantity = Math.min(pool.quantity - pool.reservedQuantity, want.maxAcceptableQuantity, truck.capacity);
  expect(quantity).toBeGreaterThan(0);
  await sendThroughUi(page, {
    type: "DISPATCH_DELIVERY",
    vehicleId: truck.id,
    cargo: [{ productId: pool.productId, quality: pool.quality, quantity }],
    // The sale form agrees the deal at the quote it shows, then dispatches against it (ADR 0022 decision 6).
    purpose: { kind: "SALE", buyerId: kessler.id, dealId: null },
    routeId: backRoad.id,
    driver: { kind: "FOUNDER" },
  });
  const sent = await snapshot(page);
  const dispatched = sent.recentEvents.filter((e) => e.type === "DELIVERY_DISPATCHED").at(-1)!;
  expect(dispatched).toMatchObject({ routeId: backRoad.id, purpose: { kind: "SALE", buyerId: kessler.id } });

  // The run gets through (seeded, so every time): Kessler pays the agreed price,
  // the truck comes home, and the road reopens on schedule.
  await advanceTo(page, reopensAt);
  const after = await snapshot(page);
  expect(after.vehicles[0]!.trip).toBeNull();
  const since = after.recentEvents.filter((e) => e.tick > sent.clock.tick);
  expect(since.find((e) => e.type === "SALE_COMPLETED")).toMatchObject({
    buyerId: kessler.id,
    unitPrice: want.unitPrice,
    cargo: [{ productId: pool.productId, quality: pool.quality, quantity }],
  });
  expect(since.map((e) => e.type)).toEqual(expect.arrayContaining(["VEHICLE_RETURNED", "ROUTE_REOPENED"]));
  expect(after.routes.find((r) => r.id === COUNTY_ROAD)!.status.open).toBe(true);
  await expect(page.getByTestId(`${picker}-${COUNTY_ROAD}`)).toHaveAttribute("data-open", "true");
  await expect(page.getByTestId(`${picker}-${COUNTY_ROAD}-radio`)).toBeEnabled();
});
