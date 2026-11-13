// SK2b (#234): the founder-rules views, one of each, for screenshot baselines
// and the PR: the map, every place's scene the First Hire has (open and
// closed), the HUD and the ledger. A day's round: home → the feed store → the
// Crossroads (agree a deal there, through the scene) → Kessler's → Lakeview.
// Travel goes through the hook here; walking-skeleton.spec.ts drives it on
// the map. Baselines are linux-only (CI); the assertions are skipped elsewhere.

import { START_WAKE_TICK, THE_FIRST_HIRE_SCENARIO } from "@eov/game-data";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { prShot } from "../end-screen/pr-shots.ts";
import { act, advance, advanceUntil, inScene, isFreeAt, mapDrawn, player } from "./founder-ui.ts";

const DIR = import.meta.dirname;
const HOME = THE_FIRST_HIRE_SCENARIO.founderStartLocationId;

async function shot(target: Locator, name: string): Promise<void> {
  await prShot(target, DIR, `sk2b-${name}`);
  if (process.platform === "linux") await expect(target).toHaveScreenshot(`${name}.png`);
}

async function travel(page: Page, destination: string): Promise<void> {
  const outcome = await page.evaluate(
    (d) => window.__eov!.dispatchRaw({ command: { type: "TRAVEL", destinationLocationId: d, transport: { kind: "FOOT" }, via: null } }),
    destination,
  );
  expect(outcome, destination).toMatchObject({ kind: "player-result", result: { status: "applied" } });
  await advanceUntil(page, isFreeAt(destination), 3 * 1_440);
  await inScene(page, destination);
}

test("the map, every scene, the HUD and the ledger", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await page.getByTestId("new-game-first-hire").click();
  await expect(page.getByTestId("founder-status")).toHaveAttribute("data-kind", "RESTING");
  await mapDrawn(page);
  await shot(page.getByTestId("founder-map"), "founder-map");

  // Morning at Hollow Creek.
  await advance(page, START_WAKE_TICK);
  await inScene(page, HOME);
  await shot(page.getByTestId("scene"), "scene-hollow-creek");
  await shot(page.getByTestId("hud"), "hud");

  // The feed store, open.
  await travel(page, "millers-feed");
  await expect(page.getByTestId("scene-hours")).toHaveAttribute("data-open", "true");
  await shot(page.getByTestId("scene"), "scene-feed-store");

  // The Crossroads, open: what they want, and a deal agreed in the scene.
  await travel(page, "crossroads");
  await expect(page.getByTestId("scene-hours")).toHaveAttribute("data-open", "true");
  await expect(page.locator("[data-testid=scene-layer][data-kind=WANTS]")).toBeVisible();
  await shot(page.getByTestId("scene"), "scene-crossroads");
  const key = await page.locator("[data-testid=scene-action][data-kind=AGREE_DEAL][data-blocked='']").first().getAttribute("data-key");
  await act(page, key!);
  expect((await player(page)).deals).toHaveLength(1);
  await advanceUntil(page, isFreeAt("crossroads"), 1_440);

  // Kessler's and Lakeview, as they are when the founder gets there.
  await travel(page, "kessler-pharmacy");
  await shot(page.getByTestId("scene"), "scene-kesslers");
  await travel(page, "lakeview");
  await shot(page.getByTestId("scene"), "scene-lakeview");

  // Back on the map, and the ledger after a day of looking around.
  await page.getByTestId("scene-leave").click();
  await mapDrawn(page);
  await shot(page.getByTestId("founder-map"), "founder-map-day");
  await shot(page.getByTestId("ledger"), "ledger");
});
