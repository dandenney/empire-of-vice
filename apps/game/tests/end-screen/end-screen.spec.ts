// The end screens (#136, ADR 0020 decision 16): victory and loss in the #99
// wording, keyed off snapshot.outcome and the outcome events, not the
// scheduler. Victory comes from replaying a recorded headless win through the
// test hook; the loss from selling and rebuying the still until a midnight
// finds the family insolvent. The loss run also checks the EQUIPMENT_SOLD
// notification. Screenshot baselines are linux-only (CI).

import { formatMoney } from "@eov/contracts";
import { expect, test } from "@playwright/test";
import { END_SCREEN_COPY as C } from "../../src/app/end-screen/copy.ts";
import { formatDayTime } from "../../src/ui/format/time-format.ts";
import { advance, newGame, planVictory, playToLoss, replay, snapshot } from "./campaign.ts";
import { prShot } from "./pr-shots.ts";

const HERE = import.meta.dirname;

test("a loss shows The Still Goes Cold, after the EQUIPMENT_SOLD notification", async ({ page }) => {
  await newGame(page);
  await expect(page.getByTestId("end-screen-loss")).toHaveCount(0);
  const start = await snapshot(page);
  const facility = start.facilities[0]!;
  const still = facility.equipment[0]!;

  // Sell the still from the Facility panel: the #99 notification, from the event.
  await page.getByTestId("open-facility").click();
  await page.getByTestId(`equipment-${facility.id}-${still.id}-sell`).click();
  await page.getByTestId(`equipment-${facility.id}-${still.id}-confirm`).click();
  const toast = page.locator('[data-testid="toast"][data-event="EQUIPMENT_SOLD"]');
  await expect(toast).toHaveCount(1);
  await expect(toast).toContainText(`Sold ${still.name} for ${formatMoney(still.resaleValue)}.`);
  await prShot(page, HERE, "equipment-sold-toast");

  await playToLoss(page);
  const lost = await snapshot(page);
  if (lost.outcome.status !== "LOST") throw new Error(`Expected a loss, got ${JSON.stringify(lost.outcome)}`);
  expect(lost.outcome.reason).toBe("INSOLVENT");
  expect(lost.recentEvents.some((e) => e.type === "GAME_LOST")).toBe(true);

  const screen = page.getByTestId("end-screen-loss");
  await expect(screen).toBeVisible();
  await expect(page.getByTestId("end-title")).toHaveText("The Still Goes Cold");
  await expect(page.getByTestId("end-lead")).toHaveText("Nothing left to sell. No way to start again.");
  await expect(page.getByTestId("end-support")).toHaveText("The Kerrigans' first operation is finished. The family story doesn't have to be.");
  await expect(page.getByTestId("end-when")).toHaveText(formatDayTime(lost.outcome.tick));
  await expect(page.getByTestId("end-cash")).toHaveText(formatMoney(lost.finance.cash));
  await expect(page.getByTestId("end-start-again")).toHaveText("Start again");
  if (process.platform === "linux") await expect(screen).toHaveScreenshot("loss.png");
  await prShot(page, HERE, "loss");

  // Escape reviews the operation: the screen closes, the outcome stays, and the game still runs.
  await page.keyboard.press("Escape");
  await expect(screen).toBeHidden();
  await advance(page, 60);
  expect((await snapshot(page)).outcome.status).toBe("LOST");
  await expect(screen).toBeHidden();
});

test("Start again on the loss screen starts a new game", async ({ page }) => {
  await newGame(page);
  await playToLoss(page);
  await expect(page.getByTestId("end-screen-loss")).toBeVisible();
  await page.getByTestId("end-start-again").click();
  await expect(page.getByTestId("end-screen-loss")).toBeHidden();
  const fresh = await snapshot(page);
  expect(fresh.outcome.status).toBe("PLAYING");
  expect(fresh.clock.tick).toBe(0);
});

test("a victory shows The Road to Chicago, with the figures from VICTORY_ACHIEVED", async ({ page }) => {
  test.setTimeout(120_000);
  const plan = planVictory();
  await newGame(page);
  await expect(page.getByTestId("end-screen-victory")).toHaveCount(0);

  await replay(page, plan, plan.victoryTick);
  const won = await snapshot(page);
  expect(won.outcome).toEqual({ status: "WON", tick: plan.victoryTick });
  const event = won.recentEvents.find((e) => e.type === "VICTORY_ACHIEVED");
  if (event?.type !== "VICTORY_ACHIEVED") throw new Error("VICTORY_ACHIEVED is missing from the recent events");
  // After the automatic pause the scheduler looks like a manual pause; the screen keys off the outcome.
  expect(await page.evaluate(() => window.__eov!.scheduler)).toMatchObject({ speed: 0 });

  const screen = page.getByTestId("end-screen-victory");
  await expect(screen).toBeVisible();
  await expect(page.getByTestId("end-title")).toHaveText("The Road to Chicago");
  await expect(page.getByTestId("end-lead")).toHaveText("Chicago doesn't know your name yet. It will.");
  await expect(page.getByTestId("end-support")).toHaveText(
    "You've built a working trade, earned the trust of your buyers, and proved the Kerrigans can do more than make a good batch. The city is next.",
  );
  await expect(page.getByTestId("end-net-worth")).toHaveText(formatMoney(event.netWorth));
  await expect(page.getByTestId("end-reputation")).toHaveText(String(event.reputation));
  await expect(page.getByTestId("end-completed-contracts")).toHaveText(String(won.progression.victory.completedContracts.current));
  await expect(page.getByTestId("end-review")).toHaveText(C.review);
  await expect(page.getByTestId("end-start-again")).toHaveCount(0);
  if (process.platform === "linux") await expect(screen).toHaveScreenshot("victory.png");
  await prShot(page, HERE, "victory");

  // Review the operation: the panels are there to look over, victory met in Progression.
  await page.getByTestId("end-review").click();
  await expect(screen).toBeHidden();
  await page.getByTestId("open-progression").click();
  for (const kind of ["net-worth", "reputation", "completed-contracts"]) {
    await expect(page.getByTestId(`progression-victory-${kind}-status`)).toHaveText("Met");
  }
  await prShot(page, HERE, "progression-after-victory");
});
