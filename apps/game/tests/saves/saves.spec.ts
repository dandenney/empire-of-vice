// Saves in a real browser (T06a, #135): IndexedDB storage, hash parity across
// a page reload, the saves dialog, and the load-error screen. Commands go
// through `window.__eov.dispatchRaw` and ticks through `window.__eov.advance`
// (exact, paused). Screenshot baselines are linux-only (CI).

import { SAVE_SCHEMA_VERSION } from "@eov/contracts";
import { SAVE_DATABASE } from "@eov/persistence/indexed-db";
import { expect, test, type Page } from "@playwright/test";
import { LOAD_ERROR_COPY, SAVES_COPY } from "../../src/app/saves/copy.ts";
import { playToLoss } from "../end-screen/campaign.ts";

// Fixed wall clock, zone, and locale, so "Saved …" times are the same on every run.
const NOW = new Date("2026-11-08T17:30:00.000Z");
test.use({ timezoneId: "UTC", locale: "en-US" });

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(NOW);
});

const stateHash = (page: Page) => page.evaluate(() => window.__eov?.stateHash ?? null);
const tickOf = (page: Page) => page.evaluate(() => window.__eov!.snapshot!.clock.tick);

/** Clicks a game-menu button and waits until the shell is idle again. */
async function press(page: Page, testId: string): Promise<void> {
  await page.getByTestId(testId).click();
  await expect(page.getByTestId("new-game")).toBeEnabled();
}

async function newGame(page: Page): Promise<void> {
  await page.goto("/");
  await press(page, "new-game");
  await expect(page.getByTestId("panel-dashboard")).toBeVisible();
}

async function dispatch(page: Page, request: unknown, status = "applied"): Promise<void> {
  const outcome = await page.evaluate((r) => window.__eov!.dispatchRaw(r), request);
  expect(outcome, JSON.stringify(request)).toMatchObject({ kind: "result", result: { status } });
}

async function advance(page: Page, ticks: number): Promise<void> {
  await page.evaluate((n) => window.__eov!.advance(n), ticks);
}

const buyCorn = (quantity: number) => ({
  command: { type: "PURCHASE_MATERIALS", supplierId: "millers-feed", materialId: "corn", quantity, facilityId: "distillery-main" },
});

/** Every slot in the game's IndexedDB store, read straight from the browser. */
function storedSlots(page: Page): Promise<string[]> {
  return page.evaluate(
    ({ name, version, store }) =>
      new Promise<string[]>((resolve, reject) => {
        const open = indexedDB.open(name, version);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const request = open.result.transaction(store).objectStore(store).getAllKeys();
          request.onsuccess = () => {
            open.result.close();
            resolve((request.result as string[]).sort());
          };
        };
      }),
    SAVE_DATABASE,
  );
}

/** Puts raw text in a slot, as a damaged or foreign save would be. */
function writeRaw(page: Page, slot: string, text: string): Promise<void> {
  return page.evaluate(
    ({ db: { name, version, store }, slot, text }) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open(name, version);
        open.onupgradeneeded = () => open.result.createObjectStore(store);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction(store, "readwrite");
          tx.objectStore(store).put(text, slot);
          tx.oncomplete = () => {
            open.result.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    { db: SAVE_DATABASE, slot, text },
  );
}

function readRaw(page: Page, slot: string): Promise<string> {
  return page.evaluate(
    ({ db: { name, version, store }, slot }) =>
      new Promise<string>((resolve, reject) => {
        const open = indexedDB.open(name, version);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const request = open.result.transaction(store).objectStore(store).get(slot);
          request.onsuccess = () => {
            open.result.close();
            resolve(request.result as string);
          };
        };
      }),
    { db: SAVE_DATABASE, slot },
  );
}

test("save → reload the page → load → continue gives the same state hash as an uninterrupted run", async ({ page }) => {
  await newGame(page);
  // With a game running, the menu offers Save; Continue is for a fresh page.
  await expect(page.getByTestId("save")).toBeVisible();
  await expect(page.getByTestId("reload")).toHaveCount(0);
  await dispatch(page, buyCorn(4));
  await advance(page, 300);
  // A purchase queued for later, so the save carries a pending command.
  const queuedAt = (await tickOf(page)) + 700;
  await dispatch(page, { ...buyCorn(2), scheduledTick: queuedAt }, "queued");

  await press(page, "save");
  await expect(page.getByTestId("message")).toHaveText(SAVES_COPY.saved(await page.getByTestId("game-date").innerText()));
  const savedTick = await tickOf(page);
  const savedHash = await stateHash(page);

  // The uninterrupted run, past the queued purchase.
  await advance(page, 2_000);
  const uninterrupted = await stateHash(page);
  expect(uninterrupted).not.toBe(savedHash);

  // The save is in IndexedDB, not localStorage.
  expect(await storedSlots(page)).toEqual(["slot-1"]);
  expect(await page.evaluate(() => localStorage.length)).toBe(0);

  // Close (reload the page), load, continue.
  await page.reload();
  await expect(page.getByTestId("reload")).toBeEnabled();
  expect(await page.evaluate(() => window.__eov?.snapshot ?? null)).toBeNull();
  await expect(page.getByTestId("save")).toHaveCount(0);
  await press(page, "reload");
  await expect(page.getByTestId("message")).toHaveText(SAVES_COPY.loaded);
  expect(await tickOf(page)).toBe(savedTick);
  expect(await stateHash(page)).toBe(savedHash);
  expect(await page.evaluate(() => window.__eov!.scheduler.speed)).toBe(0);

  await advance(page, 2_000);
  expect(await stateHash(page)).toBe(uninterrupted);
});

test("the saves dialog saves named slots, loads one, and deletes one", async ({ page }) => {
  await newGame(page);
  await advance(page, 120);
  const morningHash = await stateHash(page);

  await page.getByTestId("open-saves").click();
  const dialog = page.getByTestId("saves-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("saves-empty")).toHaveText(SAVES_COPY.empty);
  // The suggested name is the game date.
  await expect(dialog.getByTestId("save-new-label")).toHaveValue(await page.getByTestId("game-date").innerText());
  await dialog.getByTestId("save-new-label").fill("Before the first batch");
  await dialog.getByTestId("save-new").click();
  await expect(dialog.getByTestId("save-slot-1")).toContainText("Before the first batch");
  await expect(dialog.getByTestId("save-slot-1")).toContainText(SAVES_COPY.current);
  await dialog.getByTestId("saves-close").click();
  await expect(dialog).toBeHidden();

  await dispatch(page, buyCorn(4));
  await advance(page, 240);
  await page.getByTestId("open-saves").click();
  await dialog.getByTestId("save-new-label").fill("Corn bought");
  await dialog.getByTestId("save-new").click();
  await expect(dialog.getByTestId("save-list").locator("li")).toHaveCount(2);
  // Newest first: the two saves share a wall-clock time here, so by slot.
  await expect(dialog.getByTestId("save-list").locator("li").first()).toContainText("Before the first batch");
  await expect(dialog.getByTestId("save-slot-2")).toContainText(SAVES_COPY.savedAt("Nov 8, 2026, 5:30 PM"));
  await expect(dialog.getByTestId("save-slot-2")).toContainText(SAVES_COPY.current);

  if (process.platform === "linux") await expect(dialog).toHaveScreenshot("saves-dialog.png");

  // Load the earlier one: the game goes back to it, and the dialog closes.
  await dialog.getByTestId("save-slot-1-load").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("message")).toHaveText(SAVES_COPY.loaded);
  expect(await stateHash(page)).toBe(morningHash);

  // Delete the later one, with a confirmation step.
  await page.getByTestId("open-saves").click();
  await dialog.getByTestId("save-slot-2-remove").click();
  await dialog.getByTestId("save-slot-2-keep").click();
  await expect(dialog.getByTestId("save-slot-2")).toBeVisible();
  await dialog.getByTestId("save-slot-2-remove").click();
  await dialog.getByTestId("save-slot-2-confirm-remove").click();
  await expect(dialog.getByTestId("save-slot-2")).toHaveCount(0);
  expect(await storedSlots(page)).toEqual(["slot-1"]);

  // Escape closes the dialog.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // Save (top bar) now writes over the slot the game was loaded from.
  await press(page, "save");
  expect(await storedSlots(page)).toEqual(["slot-1"]);
});

test("a bad save shows the load-error screen and loads nothing", async ({ page }) => {
  await newGame(page);
  await advance(page, 60);
  await press(page, "save");
  const good = await readRaw(page, "slot-1");

  // Tampered after saving: valid by the schema, but not what was hashed.
  const tampered = JSON.parse(good) as { save: { state: { family: { reputation: number } } }; meta: { slot: string; label: string } };
  tampered.save.state.family.reputation += 7;
  tampered.meta = { ...tampered.meta, slot: "slot-2", label: "Doctored ledger" };
  await writeRaw(page, "slot-2", JSON.stringify(tampered));
  // From a newer build.
  const newer = JSON.parse(good) as { save: { schemaVersion: number }; meta: { slot: string; label: string } };
  newer.save.schemaVersion = SAVE_SCHEMA_VERSION + 1;
  newer.meta = { ...newer.meta, slot: "slot-3", label: "From the future" };
  await writeRaw(page, "slot-3", JSON.stringify(newer));
  // Not a save at all.
  await writeRaw(page, "slot-4", "{ half a file");

  await advance(page, 100);
  const before = await stateHash(page);

  await page.getByTestId("open-saves").click();
  const dialog = page.getByTestId("saves-dialog");
  await expect(dialog.getByTestId("save-slot-2-problem")).toHaveText(LOAD_ERROR_COPY.HASH_MISMATCH({ code: "HASH_MISMATCH", expected: "", actual: "" }));
  await expect(dialog.getByTestId("save-slot-3-problem")).toHaveText(
    LOAD_ERROR_COPY.NEWER_VERSION({ code: "NEWER_VERSION", saveVersion: SAVE_SCHEMA_VERSION + 1, supportedVersion: SAVE_SCHEMA_VERSION }),
  );
  await expect(dialog.getByTestId("save-slot-4")).toContainText(SAVES_COPY.untitled);
  await expect(dialog.getByTestId("save-slot-4-problem")).toHaveText(LOAD_ERROR_COPY.NOT_A_SAVE({ code: "NOT_A_SAVE" }));

  // Loading the tampered save: the error screen, and the game carries on unchanged.
  await dialog.getByTestId("save-slot-2-load").click();
  const screen = page.getByTestId("load-error");
  await expect(screen).toBeVisible();
  await expect(screen).toContainText(SAVES_COPY.errorTitle);
  await expect(screen).toContainText(SAVES_COPY.errorSave("Doctored ledger"));
  await expect(screen.getByTestId("load-error-reason")).toHaveText(LOAD_ERROR_COPY.HASH_MISMATCH({ code: "HASH_MISMATCH", expected: "", actual: "" }));
  await screen.locator("summary").click();
  await expect(screen.getByTestId("load-error-details")).toHaveText("HASH_MISMATCH");
  expect(await stateHash(page)).toBe(before);

  if (process.platform === "linux") await expect(screen).toHaveScreenshot("load-error.png");

  // Back to the dialog; then delete the newer-build save from its error screen.
  await screen.getByTestId("load-error-back").click();
  await expect(screen).toBeHidden();
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("save-slot-3-load").click();
  await expect(screen.getByTestId("load-error-reason")).toContainText(String(SAVE_SCHEMA_VERSION + 1));
  await screen.getByTestId("load-error-remove").click();
  await expect(screen).toBeHidden();
  await expect(dialog.getByTestId("save-slot-3")).toHaveCount(0);
  expect(await storedSlots(page)).toEqual(["slot-1", "slot-2", "slot-4"]);
  expect(await stateHash(page)).toBe(before);
});

test("with no game running, a bad save still can't half-load", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("reload")).toBeDisabled();
  await writeRaw(page, "slot-9", JSON.stringify({ save: { format: "empire-of-vice/save", schemaVersion: SAVE_SCHEMA_VERSION }, meta: { label: "Empty shell" } }));
  await page.reload();

  // Continue offers the only save, which won't load.
  await page.getByTestId("reload").click();
  const screen = page.getByTestId("load-error");
  await expect(screen.getByTestId("load-error-reason")).toHaveText(LOAD_ERROR_COPY.INVALID({ code: "INVALID", issues: [] }));
  await screen.locator("summary").click();
  await expect(screen.getByTestId("load-error-details").locator("li").first()).toHaveText("INVALID");
  await expect(screen.getByTestId("load-error-details").locator("li")).not.toHaveCount(1);
  await screen.getByTestId("load-error-back").click();
  expect(await page.evaluate(() => window.__eov?.snapshot ?? null)).toBeNull();
  await expect(page.getByTestId("new-game")).toBeEnabled();
});

test("Start again after a loss starts a fresh slot: the next Save leaves the previous game's save alone", async ({ page }) => {
  await newGame(page);
  await advance(page, 120);
  await press(page, "save");
  expect(await storedSlots(page)).toEqual(["slot-1"]);
  const before = await readRaw(page, "slot-1");

  // Lose the game this slot belongs to, then start again from the end screen.
  await playToLoss(page);
  await expect(page.getByTestId("end-screen-loss")).toBeVisible();
  await page.getByTestId("end-start-again").click();
  await expect(page.getByTestId("end-screen-loss")).toBeHidden();
  expect(await tickOf(page)).toBe(0);

  // Save writes the new game to a new slot; the old save is untouched.
  await press(page, "save");
  expect(await storedSlots(page)).toEqual(["slot-1", "slot-2"]);
  expect(await readRaw(page, "slot-1")).toBe(before);
});
