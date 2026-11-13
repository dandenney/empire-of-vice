// Helpers for the founder-rules specs (SK2b, #234): read the player snapshot
// through the test hook, run exact ticks, and drive the map and the scenes.

import { expect, type Page } from "@playwright/test";

export type Player = NonNullable<NonNullable<Window["__eov"]>["playerSnapshot"]>;

export async function player(page: Page): Promise<Player> {
  const p = await page.evaluate(() => window.__eov!.playerSnapshot);
  if (!p) throw new Error("No player snapshot on window.__eov");
  return p;
}

export const stateHash = (page: Page) => page.evaluate(() => window.__eov!.stateHash);

/** Runs exactly `ticks` ticks (the game stays paused). */
export async function advance(page: Page, ticks: number): Promise<void> {
  if (ticks <= 0) return;
  const before = (await player(page)).clock.tick;
  await page.evaluate((n) => window.__eov!.advance(n), ticks);
  expect((await player(page)).clock.tick).toBe(before + ticks);
}

/** The next tick worth stopping at: an arrival, the end of a busy spell or a rest, a truck's stop; else the next tick. */
function nextStop(p: Player): number {
  const now = p.clock.tick;
  const w = p.founder.whereabouts;
  const ahead = (t: number) => (t > now ? t - now : 1);
  switch (w.kind) {
    case "TRAVELLING":
      return ahead(w.legArrivesAt);
    case "RESTING":
      return ahead(w.until);
    case "PRESENT":
      return w.busy === null ? 1 : ahead(w.busy.until);
    case "ON_DELIVERY": {
      const trip = p.vehicles.find((v) => v.id === w.vehicleId)?.whereabouts?.value.trip ?? null;
      return trip === null ? 1 : ahead(trip.arrivesAt);
    }
  }
}

/** Advances, stop by stop, until `done` holds (at most `limit` ticks). No commands are sent, so it's the same as tick by tick. */
export async function advanceUntil(page: Page, done: (p: Player) => boolean, limit: number): Promise<Player> {
  let p = await player(page);
  const start = p.clock.tick;
  while (!done(p)) {
    if (p.clock.tick - start > limit) throw new Error(`not reached within ${limit} ticks: founder ${JSON.stringify(p.founder.whereabouts)}`);
    await advance(page, nextStop(p));
    p = await player(page);
  }
  return p;
}

export const isFreeAt = (locationId: string) => (p: Player) => {
  const w = p.founder.whereabouts;
  return w.kind === "PRESENT" && w.locationId === locationId && w.busy === null;
};

/** Waits for the map to have drawn the snapshot at the current tick. */
export async function mapDrawn(page: Page): Promise<void> {
  const map = page.getByTestId("founder-map");
  await expect(map).toBeVisible();
  const t = (await player(page)).clock.tick;
  await expect(map).toHaveAttribute("data-tick", String(t));
  await expect(map).toHaveAttribute("data-renderer", /.+/);
}

/** From a scene: back to the map. From the map: picks a place and walks there. */
export async function walkTo(page: Page, locationId: string): Promise<void> {
  if (await page.getByTestId("scene").isVisible()) await page.getByTestId("scene-leave").click();
  await mapDrawn(page);
  await page.getByTestId(`place-${locationId}`).click();
  await expect(page.getByTestId("travel-card")).toHaveAttribute("data-destination", locationId);
  await page.getByTestId("travel-walk").click();
  await expect(page.getByTestId("founder-status")).toHaveAttribute("data-kind", "TRAVELLING");
}

/** Waits for the scene of `locationId` to be open. */
export async function inScene(page: Page, locationId: string): Promise<void> {
  await expect(page.getByTestId("scene")).toHaveAttribute("data-location", locationId);
}

/** Takes a scene action (its card's key) and waits for the gateway to apply it. */
export async function act(page: Page, key: string): Promise<void> {
  const card = page.locator(`[data-testid=scene-action][data-key="${key}"]`);
  await card.getByTestId(`do-${key}`).click();
  await expect(card.getByTestId("scene-result")).toHaveAttribute("data-status", "applied");
}
