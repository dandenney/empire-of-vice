// SK2a (#174): a First Hire game in a real browser, under founder rules.
//
// The placeholder new-game choice starts it; the worker publishes only the
// player snapshot, so the M001 panels and map aren't shown and the dock shows
// the placeholder founder shell (SK2b, #234, builds the visible layer). The
// rest fast-forward runs while the founder sleeps; the founder commands go
// through the gateway; no world event becomes a toast; and a save loads back
// with founder rules on.

import { MIN_REST_TICKS, THE_FIRST_HIRE_SCENARIO } from "@eov/game-data";
import { expect, test, type Page } from "@playwright/test";
import { SAVES_COPY } from "../../src/app/saves/copy.ts";
import { prShot } from "../end-screen/pr-shots.ts";

const DIR = import.meta.dirname;

/** Clicks a shell button and waits until the shell is idle again (its buttons are disabled while a request runs). */
async function press(page: Page, testId: string): Promise<void> {
  await page.getByTestId(testId).click();
  await expect(page.getByTestId("new-game")).toBeEnabled();
}

const hook = (page: Page) =>
  page.evaluate(() => ({
    world: window.__eov!.snapshot !== null,
    player: window.__eov!.playerSnapshot,
    scheduler: window.__eov!.scheduler,
    stateHash: window.__eov!.stateHash,
  }));

async function command(page: Page, command: unknown): Promise<void> {
  const outcome = await page.evaluate((c) => window.__eov!.dispatchRaw({ command: c }), command);
  expect(outcome, JSON.stringify(command)).toMatchObject({ kind: "player-result", result: { status: "applied" } });
  expect(outcome.kind === "player-result" && outcome.result).not.toHaveProperty("eventIds");
}

test("starts a First Hire game under founder rules, runs the night fast, and saves and loads it", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("new-game")).toBeEnabled();
  await prShot(page, DIR, "no-game-dock");
  await press(page, "new-game-first-hire");

  // The view holds the player snapshot only: no world snapshot, no M001 panels or rail.
  const start = await hook(page);
  expect(start.world).toBe(false);
  expect(start.player).not.toBeNull();
  expect(start.player!.founder.whereabouts.kind).toBe("RESTING");
  const shell = page.getByTestId("founder-shell");
  await expect(shell).toBeVisible();
  await expect(page.getByTestId("founder-status")).toHaveAttribute("data-kind", "RESTING");
  await expect(page.getByTestId("game-date")).toBeVisible();
  await expect(page.locator("[data-testid^=panel-]")).toHaveCount(0);
  await expect(page.locator("[data-testid^=open-]:not([data-testid=open-saves])")).toHaveCount(0);
  await expect(page.getByTestId("map")).toHaveCount(0);
  await prShot(page, DIR, "first-hire-asleep");

  // 1×: the founder sleeps, so the fast-forward runs until they wake at the rest's end.
  await page.getByTestId("speed-1x").click();
  await expect(page.getByTestId("fast-forward")).toBeVisible();
  expect((await hook(page)).scheduler).toEqual({ speed: 1, autoPaused: false, fastForward: true });
  await prShot(page, DIR, "first-hire-fast-forward");
  await expect(page.getByTestId("founder-status")).toHaveAttribute("data-kind", "PRESENT", { timeout: 30_000 });
  await expect(page.getByTestId("fast-forward")).toHaveCount(0);
  expect((await hook(page)).scheduler).toMatchObject({ speed: 1, fastForward: false });
  await page.getByTestId("speed-pause").click();
  await expect(page.getByTestId("speed-status")).toHaveAttribute("data-speed", "0");

  // The founder commands round-trip through the gateway as player results.
  const now = (await hook(page)).player!.clock.tick;
  await command(page, { type: "REST", untilTick: now + 1 + MIN_REST_TICKS });
  await expect(page.getByTestId("founder-status")).toHaveAttribute("data-kind", "RESTING");
  await command(page, { type: "WAKE" });
  await expect(page.getByTestId("founder-status")).toHaveAttribute("data-kind", "PRESENT");
  const supplier = start.player!.places.find((p) => p.kind === "SUPPLIER")!.id;
  await command(page, { type: "TRAVEL", destinationLocationId: supplier, transport: { kind: "FOOT" }, via: null });
  await expect(page.getByTestId("founder-status")).toHaveAttribute("data-kind", "TRAVELLING");
  await prShot(page, DIR, "first-hire-travelling");

  // A day and a half: midnight's world events (a contract offer is a toast under world rules) reach no toast.
  await page.evaluate(() => window.__eov!.advance(2 * 1_440));
  await expect(page.getByTestId("toast")).toHaveCount(0);

  // Save, play a First Shipment game, and load the save back: founder rules again.
  await press(page, "save");
  const saved = await hook(page);
  await press(page, "new-game");
  expect((await hook(page)).world).toBe(true);
  await expect(page.getByTestId("founder-shell")).toHaveCount(0);
  await press(page, "open-saves");
  await page.getByTestId("saves-dialog").getByTestId("save-slot-1-load").click();
  await expect(page.getByTestId("message")).toHaveText(SAVES_COPY.loaded);
  const loaded = await hook(page);
  expect(loaded.world).toBe(false);
  expect(loaded.stateHash).toBe(saved.stateHash);
  expect(loaded.player!.clock.tick).toBe(saved.player!.clock.tick);
  await expect(page.getByTestId("founder-shell")).toBeVisible();
  await expect(page.getByTestId("founder-shell")).toContainText(THE_FIRST_HIRE_SCENARIO.name);
});
