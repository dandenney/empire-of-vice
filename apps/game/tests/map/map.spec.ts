// The PixiJS map in a real browser (issue #17): drawn from the snapshot,
// clicking a location selects it and opens its panel, and a truck on the road
// moves as ticks advance. The map's queries come through the test hook as
// `window.__eov.map` (points are CSS pixels from the map's top-left).
//
// Screenshot baselines are linux-only (CI); the assertion is skipped elsewhere.

import { expect, test, type Page } from "@playwright/test";
import type { MapEntityInfo } from "../../src/app/map-slot.tsx";

type Snapshot = NonNullable<NonNullable<Window["__eov"]>["snapshot"]>;

const snapshot = async (page: Page): Promise<Snapshot> => (await page.evaluate(() => window.__eov!.snapshot))!;

/** Calls one of the map's registered queries in the page. */
function query<T>(page: Page, name: "entities" | "selected"): Promise<T>;
function query<T>(page: Page, name: "entitiesAt", x: number, y: number): Promise<T>;
function query<T>(page: Page, name: string, ...args: number[]): Promise<T> {
  return page.evaluate(
    ([n, a]) => (window.__eov!.map![n] as (...xs: number[]) => unknown)(...a),
    [name, args] as const,
  ) as Promise<T>;
}

const entities = (page: Page) => query<MapEntityInfo[]>(page, "entities");
const selected = (page: Page) => query<MapEntityInfo | null>(page, "selected");
const entitiesAt = (page: Page, x: number, y: number) => query<MapEntityInfo[]>(page, "entitiesAt", x, y);

/** Waits until the map has drawn the snapshot at `tick`. */
async function drawn(page: Page, tick: number): Promise<void> {
  await expect(page.getByTestId("map")).toHaveAttribute("data-tick", String(tick));
}

async function newGame(page: Page): Promise<Snapshot> {
  await page.goto("/");
  await page.getByTestId("new-game").click();
  await expect(page.getByTestId("panel-dashboard")).toBeVisible();
  await drawn(page, 0);
  return snapshot(page);
}

/** Waits two frames, so a reflow's resize has reached the map's layout. */
async function settled(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

/** Clicks the map at a point in its own CSS pixels. */
async function clickMap(page: Page, x: number, y: number): Promise<void> {
  const map = page.getByTestId("map");
  await map.scrollIntoViewIfNeeded();
  const box = (await map.boundingBox())!;
  await page.mouse.click(box.x + x, box.y + y);
}

async function dispatch(page: Page, request: unknown): Promise<void> {
  const outcome = await page.evaluate((r) => window.__eov!.dispatchRaw(r), request);
  expect(outcome, JSON.stringify(request)).toMatchObject({ kind: "result", result: { status: "applied" } });
}

async function advance(page: Page, ticks: number): Promise<number> {
  await page.evaluate((n) => window.__eov!.advance(n), ticks);
  const tick = (await snapshot(page)).clock.tick;
  await drawn(page, tick);
  return tick;
}

test("draws every location, route, and truck in the snapshot with PixiJS", async ({ page }) => {
  const s = await newGame(page);
  const map = page.getByTestId("map");
  await expect(map.locator("canvas")).toHaveCount(1);
  expect(["webgl", "canvas"]).toContain(await map.getAttribute("data-renderer"));

  const drawnEntities = await entities(page);
  const ids = (kind: MapEntityInfo["kind"]) => drawnEntities.filter((e) => e.kind === kind).map((e) => e.id);
  expect(ids("ROUTE")).toEqual(s.routes.map((r) => r.id));
  expect(ids("VEHICLE")).toEqual(s.vehicles.map((v) => v.id));
  expect(drawnEntities.filter((e) => e.locationId !== null).map((e) => e.locationId)).toEqual(s.locations.map((l) => l.id));
  expect(ids("BUYER")).toHaveLength(s.market.buyers.length);

  // Everything sits inside the map.
  const box = (await map.boundingBox())!;
  for (const e of drawnEntities) {
    expect(e.x, e.id).toBeGreaterThan(0);
    expect(e.x, e.id).toBeLessThan(box.width);
    expect(e.y, e.id).toBeGreaterThan(0);
    expect(e.y, e.id).toBeLessThan(box.height);
  }

  // Each location has an accessible hit target, named for it.
  for (const location of s.locations) {
    await expect(map.getByRole("button", { name: location.name })).toBeVisible();
  }

  if (process.platform === "linux") await expect(map).toHaveScreenshot("map.png");
});

test("clicking a location selects it and opens its panel", async ({ page }) => {
  await newGame(page);
  expect(await selected(page)).toBeNull();
  // Opening a panel can reflow the shell and resize the map, so positions are read fresh before each click.
  const find = async (kind: MapEntityInfo["kind"]) => {
    await settled(page);
    return (await entities(page)).find((e) => e.kind === kind)!;
  };
  const selectedId = async () => (await selected(page))?.id ?? null;

  const distillery = await find("FACILITY");
  const under = await entitiesAt(page, distillery.x, distillery.y);
  expect(under.map((e) => e.id)).toContain(distillery.id);
  await clickMap(page, distillery.x, distillery.y);
  await expect(page.getByTestId("panel-production")).toBeVisible();
  await expect(page.getByTestId("open-production")).toHaveAttribute("aria-pressed", "true");
  expect(await selected(page)).toMatchObject({ kind: "FACILITY", id: distillery.id, locationId: distillery.locationId });

  const buyer = await find("BUYER");
  await clickMap(page, buyer.x, buyer.y);
  await expect(page.getByTestId("open-market")).toHaveAttribute("aria-pressed", "true");
  expect(await selectedId()).toBe(buyer.id);

  // Empty ground holds nothing, and a click there changes nothing.
  expect(await entitiesAt(page, 2, 2)).toEqual([]);
  await clickMap(page, 2, 2);
  expect(await selectedId()).toBe(buyer.id);

  // The keyboard reaches the same targets.
  const supplier = await find("SUPPLIER");
  await page.getByTestId("map").getByRole("button", { name: supplier.label }).focus();
  await page.keyboard.press("Enter");
  expect(await selectedId()).toBe(supplier.id);
});

test("a truck on the road moves along its route as ticks advance", async ({ page }) => {
  const start = await newGame(page);
  const distillery = start.facilities.find((f) => f.kind === "DISTILLERY")!;
  const recipe = distillery.recipes[0]!;
  for (const input of recipe.inputsPerCase) {
    const supplier = start.market.suppliers.find((s) => s.materials.some((m) => m.materialId === input.materialId))!;
    await dispatch(page, {
      command: { type: "PURCHASE_MATERIALS", supplierId: supplier.id, materialId: input.materialId, quantity: input.quantity, facilityId: distillery.id },
    });
  }
  await dispatch(page, { command: { type: "START_PRODUCTION", facilityId: distillery.id, recipeId: recipe.recipeId, quantity: 1 } });
  const producing = await snapshot(page);
  await advance(page, producing.productionJobs[0]!.completesAt - producing.clock.tick);

  const produced = await snapshot(page);
  const pool = produced.facilities.find((f) => f.id === distillery.id)!.products[0]!;
  const buyer = produced.market.buyers[0]!;
  const truckId = produced.vehicles[0]!.id;
  const truck = async () => (await entities(page)).find((e) => e.kind === "VEHICLE" && e.id === truckId)!;
  const marker = page.locator(`[data-testid=map] [data-shape=vehicle][data-id="${truckId}"]`);
  const parked = await truck();

  // ADR 0022 decision 6: agree the deal at today's quote, then dispatch the truck against it.
  await dispatch(page, {
    command: { type: "AGREE_DEAL", buyerId: buyer.id, productId: pool.productId, quality: pool.quality, quantity: 1, agreedUnitPrice: buyer.wants[0]!.unitPrice },
  });
  const agreed = (await snapshot(page)).recentEvents.filter((e) => e.type === "DEAL_AGREED").at(-1)!;
  if (agreed.type !== "DEAL_AGREED") throw new Error("No DEAL_AGREED");
  await dispatch(page, {
    command: {
      type: "DISPATCH_DELIVERY",
      vehicleId: truckId,
      cargo: [{ productId: pool.productId, quality: pool.quality, quantity: 1 }],
      purpose: { kind: "SALE", buyerId: buyer.id, dealId: agreed.dealId },
      routeId: null,
      driver: { kind: "FOUNDER" },
    },
  });
  const trip = (await snapshot(page)).vehicles[0]!.trip!;
  expect(trip.leg).toBe("OUTBOUND");
  const span = trip.arrivesAt - trip.departedAt;
  expect(span).toBeGreaterThan(4);

  // A quarter of the way, then halfway: the truck has moved, on screen and in the DOM marker.
  await advance(page, Math.max(1, trip.departedAt + Math.floor(span / 4) - (await snapshot(page)).clock.tick));
  const quarter = await truck();
  const quarterBox = (await marker.boundingBox())!;
  await advance(page, Math.floor(span / 4));
  const half = await truck();
  const halfBox = (await marker.boundingBox())!;

  expect({ x: quarter.x, y: quarter.y }).not.toEqual({ x: parked.x, y: parked.y });
  expect({ x: half.x, y: half.y }).not.toEqual({ x: quarter.x, y: quarter.y });
  expect({ x: halfBox.x, y: halfBox.y }).not.toEqual({ x: quarterBox.x, y: quarterBox.y });
  // And the hit test finds it where it's drawn.
  expect((await entitiesAt(page, half.x, half.y)).map((e) => e.id)).toContain(truckId);
});
