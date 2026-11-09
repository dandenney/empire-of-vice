// The #48 shell in a real browser (issue #61): the layout (map full-bleed,
// panel docked right, icon rail with a name per panel and keyboard
// switching), ledger figures, event toasts from GatewayClient.onEvents, and
// self-hosted fonts. Screenshot baselines are linux-only (CI); the assertion
// is skipped elsewhere.

import { FIRST_SHIPMENT_SCENARIO, type ScenarioRouteClosure } from "@eov/game-data";
import { expect, test, type Page } from "@playwright/test";
import { SHELL_COPY } from "../../src/components/copy.ts";
import { CONTRACTS_COPY } from "../../src/panels/contracts/copy.ts";
import { DASHBOARD_COPY } from "../../src/panels/dashboard/copy.ts";
import { FACILITY_COPY } from "../../src/panels/facility/copy.ts";
import { FINANCE_COPY } from "../../src/panels/finance/copy.ts";
import { MARKET_COPY } from "../../src/panels/market/copy.ts";
import { PRODUCTION_COPY } from "../../src/panels/production/copy.ts";
import { TOAST_HOST_COPY } from "../../src/ui/toasts/copy.ts";
import { COLOR, LAYOUT } from "../../src/ui/tokens.ts";

const PANELS = [
  { id: "dashboard", title: DASHBOARD_COPY.title },
  { id: "production", title: PRODUCTION_COPY.title },
  { id: "finance", title: FINANCE_COPY.title },
  { id: "market", title: MARKET_COPY.title },
  { id: "contracts", title: CONTRACTS_COPY.title },
  { id: "facility", title: FACILITY_COPY.title },
] as const;

/** "#rrggbb" → the "rgb(r, g, b)" getComputedStyle reports. */
const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;

async function newGame(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("new-game").click();
  await expect(page.getByTestId("panel-dashboard")).toBeVisible();
  await expect(page.getByTestId("map")).toHaveAttribute("data-tick", "0");
}

async function dispatch(page: Page, request: unknown): Promise<void> {
  const outcome = await page.evaluate((r) => window.__eov!.dispatchRaw(r), request);
  expect(outcome, JSON.stringify(request)).toMatchObject({ kind: "result", result: { status: "applied" } });
}

async function advance(page: Page, ticks: number): Promise<void> {
  await page.evaluate((n) => window.__eov!.advance(n), ticks);
}

test("the map fills the screen beside a docked panel and the icon rail", async ({ page }) => {
  await newGame(page);
  const viewport = page.viewportSize()!;
  const map = (await page.getByTestId("map").boundingBox())!;
  const dock = (await page.locator(".dock").boundingBox())!;
  const rail = (await page.getByRole("navigation", { name: SHELL_COPY.panelNav }).boundingBox())!;

  // Rail on the left edge, panel on the right edge, the map edge to edge between them, top bar to bottom.
  expect(rail.x).toBe(0);
  expect(rail.width).toBe(LAYOUT.railWidth);
  expect(dock.x + dock.width).toBe(viewport.width);
  expect(map.x).toBe(rail.x + rail.width);
  expect(map.x + map.width).toBeLessThanOrEqual(dock.x);
  expect(dock.x - (map.x + map.width)).toBeLessThanOrEqual(1);
  expect(map.y).toBe(LAYOUT.topbarHeight);
  expect(map.y + map.height).toBe(viewport.height);
});

test("each panel has a named rail button, and the keyboard switches panels", async ({ page }) => {
  await newGame(page);
  const rail = page.getByRole("navigation", { name: SHELL_COPY.panelNav });
  for (const p of PANELS) await expect(rail.getByRole("button", { name: p.title, exact: true })).toHaveAttribute("data-testid", `open-${p.id}`);

  // Every panel is a real panel now: no placeholder left (#128).
  for (const p of PANELS) {
    await page.getByTestId(`open-${p.id}`).click();
    await expect(page.getByTestId(`panel-${p.id}`)).toBeVisible();
  }
  await page.getByTestId("open-dashboard").click();

  await page.getByTestId("open-dashboard").focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("open-production")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("panel-production")).toBeVisible();
  await expect(page.getByTestId("open-production")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("open-dashboard")).toHaveAttribute("aria-pressed", "false");

  const last = PANELS.at(-1)!.id;
  await page.keyboard.press("End");
  await expect(page.getByTestId(`open-${last}`)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("open-dashboard")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(page.getByTestId(`open-${last}`)).toBeFocused();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press(" ");
  await expect(page.getByTestId("panel-finance")).toBeVisible();

  // Tab also reaches every rail button.
  await page.getByTestId("open-dashboard").focus();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("open-production")).toBeFocused();
});

test("ledger figures: typewriter tabular figures, losses signed and in the loss colour, totals double-ruled", async ({ page }) => {
  await newGame(page);
  await dispatch(page, {
    command: { type: "PURCHASE_MATERIALS", supplierId: "millers-feed", materialId: "corn", quantity: 4, facilityId: "distillery-main" },
  });

  const loss = page.getByTestId("dashboard-cash-flow-today").locator(".money");
  await expect(loss).toHaveText(/^-\$/);
  await expect(loss).toHaveAttribute("data-sign", "loss");
  await expect(loss).toHaveCSS("color", rgb(COLOR.loss));
  await expect(loss).toHaveCSS("font-variant-numeric", "tabular-nums");
  expect(await loss.evaluate((el) => getComputedStyle(el).fontFamily)).toContain("Courier Prime");

  const gain = page.getByTestId("dashboard-cash").locator(".money");
  await expect(gain).toHaveAttribute("data-sign", "gain");
  await expect(gain).not.toHaveCSS("color", rgb(COLOR.loss));

  await page.getByTestId("open-finance").click();
  const total = page.getByTestId("finance-total-assets").locator(".money");
  await expect(total).toHaveCSS("border-bottom-style", "double");
  await expect(page.getByTestId("finance-asset-cash").locator(".money")).toHaveCSS("border-bottom-style", "none");
  await expect(page.getByTestId("finance-cash-MATERIALS").locator(".money")).toHaveCSS("color", rgb(COLOR.loss));
});

test("a notify event shows a toast, announced politely and dismissable, with the #99 wording", async ({ page }) => {
  const closure = FIRST_SHIPMENT_SCENARIO.scheduledEvents.find((e): e is ScenarioRouteClosure => e.kind === "ROUTE_CLOSURE" && e.reason === "RIVAL" && e.routeId === "county-road")!;
  expect(closure).toBeDefined();
  await newGame(page);

  const host = page.getByRole("region", { name: TOAST_HOST_COPY.region });
  await expect(host.locator("[aria-live=polite]")).toHaveCount(1);
  await expect(page.getByTestId("toast")).toHaveCount(0);

  // The rival roadblock.
  await advance(page, closure.tick + 1);
  const roadblock = host.locator("[data-testid=toast][data-event=ROUTE_CLOSED]");
  await expect(roadblock).toHaveCount(1);
  await expect(roadblock).toContainText("Dwyer's Roadblock");
  await expect(roadblock).toContainText("Word from Kessler's: Dwyer's boys have blocked the County Road. Find another way in, or wait them out.");
  await expect(roadblock).toHaveAttribute("data-tone", "bad");
  // Bounded: never more than a handful at once.
  expect(await page.getByTestId("toast").count()).toBeLessThanOrEqual(4);

  if (process.platform === "linux") await expect(roadblock).toHaveScreenshot("toast-roadblock.png");

  await roadblock.getByRole("button", { name: TOAST_HOST_COPY.dismiss("Dwyer's Roadblock") }).click();
  await expect(roadblock).toHaveCount(0);

  // And the reopening that follows it.
  await advance(page, closure.durationTicks);
  const reopened = host.locator("[data-testid=toast][data-event=ROUTE_REOPENED]");
  await expect(reopened).toContainText("The County Road is clear again. Dwyer's boys have moved on.");
});

test("fonts are bundled: every request stays on the game's own origin", async ({ page, baseURL }) => {
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await newGame(page);
  await page.evaluate(() => document.fonts.ready);

  const origin = new URL(baseURL!).origin;
  const foreign = requests.filter((url) => !url.startsWith("data:") && !url.startsWith("blob:") && new URL(url).origin !== origin);
  expect(foreign).toEqual([]);

  const fontFiles = requests.filter((url) => /\.woff2?(\?|$)/.test(url));
  expect(fontFiles.length).toBeGreaterThan(0);
  const loaded = await page.evaluate(() => [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family.replace(/["']/g, "")));
  for (const family of ["Limelight", "IBM Plex Sans", "Courier Prime"]) expect(loaded).toContain(family);
});
