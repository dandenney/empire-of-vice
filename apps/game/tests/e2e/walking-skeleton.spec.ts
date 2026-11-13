// SK2b (#234): the M002 walking skeleton in the browser, played through the UI.
//
// The SK1d path (packages/simulation/test/walking-skeleton/path.locked.test.ts)
// as a player plays it: wake at Hollow Creek → pick the feed store on the map
// and walk → buy the batch's materials in its scene → walk back → start a
// batch → wait → load the truck and drive a sale on spec to the Crossroads,
// riding along → home → rest until morning → wake. Every command is a click
// on the map or in a scene; ticks run through `window.__eov.advance`, paused,
// so each command applies on the same tick as the headless path's, and the
// final state hash must equal the headless one.

import { RECIPES, BASIC_MOONSHINE_RECIPE, START_WAKE_TICK, THE_FIRST_HIRE_SCENARIO } from "@eov/game-data";
import { expect, test } from "@playwright/test";
// The headless path's final hash. Moves only with SK1d's reference (R1's retune, a contract change).
import { WALKING_SKELETON_HASH } from "../../../../packages/simulation/test/walking-skeleton/reference-hash.ts";
import { prShot } from "../end-screen/pr-shots.ts";
import { act, advance, advanceUntil, inScene, isFreeAt, mapDrawn, player, stateHash, walkTo } from "./founder-ui.ts";

const DIR = import.meta.dirname;
const HOME = THE_FIRST_HIRE_SCENARIO.founderStartLocationId;
const SUPPLIER = THE_FIRST_HIRE_SCENARIO.supplierIds[0]!;
const FEED_STORE = "millers-feed";
const FACILITY = THE_FIRST_HIRE_SCENARIO.facilities[0]!.id;
const TRUCK = THE_FIRST_HIRE_SCENARIO.vehicleIds[0]!;
const RECIPE = RECIPES.find((r) => r.id === BASIC_MOONSHINE_RECIPE)!;
/** The path's sale: one case, on spec, to the Crossroads by the State Highway (its direct risk-free road). */
const BUYER = "crossroads-roadhouse";
const BUYER_PLACE = "crossroads";
const ROAD = "state-highway";

test("plays the SK1d walking skeleton through the map and the scenes, and matches the headless hash", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await page.getByTestId("new-game-first-hire").click();
  await expect(page.getByTestId("founder-status")).toHaveAttribute("data-kind", "RESTING");
  await mapDrawn(page);
  await prShot(page, DIR, "sk2b-map-asleep");

  // Wake at Hollow Creek: arriving (waking) there opens its scene.
  await advance(page, START_WAKE_TICK);
  await inScene(page, HOME);
  await expect(page.getByTestId("founder-status")).toHaveAttribute("data-kind", "PRESENT");
  await prShot(page, DIR, "sk2b-scene-hollow-creek-morning");

  // Pick the feed store on the map and walk.
  await page.getByTestId("scene-leave").click();
  await mapDrawn(page);
  await page.getByTestId(`place-${FEED_STORE}`).click();
  await prShot(page, DIR, "sk2b-map-travel-card");
  await page.getByTestId("travel-walk").click();
  await expect(page.getByTestId("founder-status")).toHaveAttribute("data-kind", "TRAVELLING");
  // Part of the way: the token is on the road and the HUD shows how far.
  const leg = (await player(page)).founder.whereabouts;
  if (leg.kind !== "TRAVELLING") throw new Error("expected travelling");
  await advance(page, Math.floor((leg.legArrivesAt - leg.legDepartedAt) / 2));
  await expect(page.getByTestId("founder-progress")).toBeVisible();
  await mapDrawn(page);
  await prShot(page, DIR, "sk2b-map-travelling");

  // Arrive: the feed store's scene opens, open for business.
  await advanceUntil(page, isFreeAt(FEED_STORE), 3 * 1_440);
  await inScene(page, FEED_STORE);
  await expect(page.getByTestId("scene-hours")).toHaveAttribute("data-open", "true");
  await prShot(page, DIR, "sk2b-scene-feed-store");

  // Buy each input for one case, waiting out each purchase.
  for (const input of RECIPE.inputsPerCase) {
    const key = `buy:${SUPPLIER}:${input.materialId}`;
    await page.getByTestId(`quantity-${key}`).fill(String(input.quantity));
    await act(page, key);
    await advanceUntil(page, isFreeAt(FEED_STORE), 1_440);
  }

  // Walk back to the still and start a batch.
  await walkTo(page, HOME);
  await advanceUntil(page, isFreeAt(HOME), 3 * 1_440);
  await inScene(page, HOME);
  await act(page, `start:${FACILITY}:${RECIPE.id}`);
  await advanceUntil(page, isFreeAt(HOME), 1_440);
  await prShot(page, DIR, "sk2b-scene-hollow-creek-batch");

  // Wait for the batch, as the still's known operations say.
  const home = (await player(page)).places.find((p) => p.id === HOME)!;
  if (home.kind !== "FACILITY") throw new Error("home isn't a facility");
  const doneAt = Math.max(...home.facility.operations!.value.jobs.map((j) => j.completesAt));
  await advance(page, doneAt - (await player(page)).clock.tick);
  await expect(page.locator("[data-testid=scene-layer][data-kind=CRATES]")).toHaveAttribute("data-state", "1");

  // Load the truck: one case on spec to the Crossroads by the State Highway, the founder driving.
  await page.getByTestId("dispatch-purpose").selectOption("spec");
  await page.getByTestId("dispatch-cargo").selectOption(`${RECIPE.productId}:${RECIPE.quality}`);
  await page.getByTestId("dispatch-quantity").fill("1");
  await page.getByTestId("dispatch-buyer").selectOption(BUYER);
  await page.getByTestId("dispatch-route").selectOption(ROAD);
  await prShot(page, DIR, "sk2b-scene-hollow-creek-load");
  await act(page, `dispatch:${FACILITY}`);

  // Ride out, stop at the buyer, ride home.
  await advanceUntil(page, (p) => p.founder.whereabouts.kind === "ON_DELIVERY", 1_440);
  await mapDrawn(page);
  await expect(page.getByTestId("founder-status")).toHaveAttribute("data-kind", "ON_DELIVERY");
  await advanceUntil(page, (p) => p.founder.whereabouts.kind === "ON_DELIVERY" && p.founder.whereabouts.atStop?.locationId === BUYER_PLACE, 1_440);
  await mapDrawn(page);
  await prShot(page, DIR, "sk2b-map-at-the-stop");
  await advanceUntil(page, isFreeAt(HOME), 1_440);
  await inScene(page, HOME);
  const back = await player(page);
  expect(back.vehicles.find((v) => v.id === TRUCK)!.whereabouts!.value.parkedAt).toBe(HOME);
  await prShot(page.getByTestId("ledger"), DIR, "sk2b-ledger");
  await prShot(page.getByTestId("hud"), DIR, "sk2b-hud-tired");

  // Rest until morning, and wake.
  await page.locator(`[data-testid=scene-action][data-key="rest:${HOME}"]`).getByTestId(`do-rest:${HOME}`).click();
  await expect(page.getByTestId("founder-status")).toHaveAttribute("data-kind", "RESTING");
  await mapDrawn(page);
  await prShot(page, DIR, "sk2b-map-asleep-night");
  await advanceUntil(page, isFreeAt(HOME), 1_440);
  await inScene(page, HOME);

  expect(await stateHash(page)).toBe(WALKING_SKELETON_HASH);
});
