// The speed scheduler in a real browser, on the worker's real timer (issue #11,
// ADR 0014). Exact rates and the 60 s pause are proven in Vitest with a fake
// clock (tests/unit/scheduler.test.ts); here the rates get a tolerance, since
// snapshots arrive at most every 200 ms and CI timers jitter.

import { expect, test, type Page } from "@playwright/test";

/** 12 ticks per real second at 1× (SIM-001). */
const TICKS_PER_SECOND_AT_1X = 12;

const tick = (page: Page) => page.evaluate(() => window.__eov!.snapshot!.clock.tick);
const scheduler = (page: Page) => page.evaluate(() => window.__eov!.scheduler);

async function newGame(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("new-game").click();
  await expect(page.getByTestId("dashboard-cash")).toBeVisible();
}

/** Ticks per real second over `ms`, measured in the page. */
async function measureRate(page: Page, ms: number): Promise<number> {
  return page.evaluate(async (windowMs) => {
    const read = () => ({ tick: window.__eov!.snapshot!.clock.tick, at: performance.now() });
    const start = read();
    await new Promise((r) => setTimeout(r, windowMs));
    const end = read();
    return ((end.tick - start.tick) * 1_000) / (end.at - start.at);
  }, ms);
}

/** Overrides document.visibilityState and fires visibilitychange, as the browser does when the tab hides. */
async function setTabVisibility(page: Page, state: "visible" | "hidden"): Promise<void> {
  await page.evaluate((s) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => s });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => s === "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

async function expectTickHolds(page: Page, ms: number): Promise<number> {
  const before = await tick(page);
  await page.waitForTimeout(ms);
  expect(await tick(page)).toBe(before);
  return before;
}

test("a new game starts paused and holds its tick", async ({ page }) => {
  await newGame(page);
  expect(await scheduler(page)).toEqual({ speed: 0, autoPaused: false, fastForward: false });
  await expect(page.getByTestId("speed-pause")).toHaveAttribute("aria-pressed", "true");
  expect(await expectTickHolds(page, 1_500)).toBe(0);
});

test("1×, 2×, and 4× advance the clock at 12, 24, and 48 ticks per second (with tolerance)", async ({ page }) => {
  await newGame(page);
  for (const multiplier of [1, 2, 4] as const) {
    await page.getByTestId(`speed-${multiplier}x`).click();
    await expect(page.getByTestId(`speed-${multiplier}x`)).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("speed-status")).toHaveAttribute("data-speed", String(multiplier));
    const rate = await measureRate(page, 2_000);
    const expected = TICKS_PER_SECOND_AT_1X * multiplier;
    expect(rate, `${multiplier}×`).toBeGreaterThan(expected * 0.6);
    expect(rate, `${multiplier}×`).toBeLessThan(expected * 1.4);
  }
  // The game date in the shell follows the clock.
  await expect(page.getByTestId("game-date")).not.toHaveText("1920-01-17 00:00");
});

test("pause holds the tick", async ({ page }) => {
  await newGame(page);
  await page.getByTestId("speed-4x").click();
  await expect.poll(() => tick(page)).toBeGreaterThan(20);
  await page.getByTestId("speed-pause").click();
  await expect(page.getByTestId("speed-status")).toHaveAttribute("data-speed", "0");
  expect(await scheduler(page)).toEqual({ speed: 0, autoPaused: false, fastForward: false });
  await expectTickHolds(page, 2_000);
});

test("a hidden tab auto-pauses, stays paused when visible again, and says so", async ({ page }) => {
  await newGame(page);
  await page.getByTestId("speed-4x").click();
  await expect.poll(() => tick(page)).toBeGreaterThan(20);

  await setTabVisibility(page, "hidden");
  await expect(page.getByTestId("auto-paused")).toBeVisible();
  expect(await scheduler(page)).toEqual({ speed: 0, autoPaused: true, fastForward: false });
  const hiddenAt = await expectTickHolds(page, 1_500);

  // Visible again: still paused, and the shell still says it auto-paused.
  await setTabVisibility(page, "visible");
  await expect(page.getByTestId("auto-paused")).toBeVisible();
  expect(await expectTickHolds(page, 1_500)).toBe(hiddenAt);
  expect(await scheduler(page)).toEqual({ speed: 0, autoPaused: true, fastForward: false });

  // The player resumes; no catch-up for the hidden time.
  await page.getByTestId("speed-1x").click();
  await expect(page.getByTestId("auto-paused")).toHaveCount(0);
  const rate = await measureRate(page, 1_500);
  expect(rate).toBeLessThan(TICKS_PER_SECOND_AT_1X * 1.4);
});

test("__eov.advance pauses, then advances exactly", async ({ page }) => {
  await newGame(page);
  await page.getByTestId("speed-4x").click();
  await expect.poll(() => tick(page)).toBeGreaterThan(0);
  const before = await page.evaluate(async () => {
    await window.__eov!.advance(0);
    return window.__eov!.snapshot!.clock.tick;
  });
  await page.evaluate(() => window.__eov!.advance(500));
  expect(await tick(page)).toBe(before + 500);
  expect(await scheduler(page)).toEqual({ speed: 0, autoPaused: false, fastForward: false });
  await expectTickHolds(page, 1_000);
});
