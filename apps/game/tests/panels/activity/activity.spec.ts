// The Activity feed (#136): cash lines from the money ledger, with
// Reputation rows (REPUTATION_CHANGED) and Standing rows (TIER_REACHED) in the
// #99 wording set between them, styled apart and carrying no figure. A
// promotion is one toast (#61) and one feed row, not two notifications.
// Unlocks get no row. Screenshot baselines are linux-only (CI).

import { formatMoney } from "@eov/contracts";
import { expect, test } from "@playwright/test";
import { ACTIVITY_COPY as C } from "../../../src/panels/activity/copy.ts";
import { activityRows } from "../../../src/panels/activity/activity-view.ts";
import { newGame, planVictory, replay, snapshot } from "../../end-screen/campaign.ts";
import { prShot } from "../../end-screen/pr-shots.ts";

const HERE = import.meta.dirname;

test("lists cash lines, then Reputation and Standing rows as the game earns them", async ({ page }) => {
  test.setTimeout(90_000);
  const plan = planVictory();
  const promotion = plan.events.find((e) => e.type === "TIER_REACHED")!;
  await newGame(page);
  await page.getByTestId("open-activity").click();
  await expect(page.getByTestId("panel-activity")).toBeVisible();

  // Play up to the first promotion, through the test hook.
  await replay(page, plan, promotion.tick);
  const s = await snapshot(page);
  const reputation = s.recentEvents.filter((e) => e.type === "REPUTATION_CHANGED");
  const tiers = s.recentEvents.filter((e) => e.type === "TIER_REACHED");
  expect(reputation.length).toBeGreaterThan(0);
  expect(tiers).toHaveLength(1);

  // The feed is the snapshot's, newest first.
  const expected = activityRows(s);
  const rows = page.getByTestId("activity-row");
  await expect(rows).toHaveCount(expected.length);
  await expect(rows.getByTestId("activity-text")).toHaveText(expected.map((r) => (r.kind === "cash" ? r.label : r.text)));

  // Reputation rows: the #99 line with the event's delta, the category, and no money figure.
  const repRows = page.locator('[data-testid="activity-row"][data-kind="reputation"]');
  await expect(repRows).toHaveCount(reputation.filter((e) => e.type === "REPUTATION_CHANGED" && e.to !== e.from).length);
  const repTexts = await repRows.getByTestId("activity-text").allTextContents();
  for (const e of reputation) {
    if (e.type !== "REPUTATION_CHANGED" || e.to === e.from) continue;
    const delta = e.to - e.from;
    expect(repTexts).toContain(delta > 0 ? C.reputationUp(delta) : C.reputationDown(-delta));
  }
  await expect(repRows.getByTestId("activity-category")).toHaveText(repTexts.map(() => "Reputation"));
  await expect(repRows.locator(".money")).toHaveCount(0);

  // The Standing row, named from the snapshot.
  const tierEvent = tiers[0]!;
  const tierName = tierEvent.type === "TIER_REACHED" ? s.progression.tiers.find((t) => t.id === tierEvent.tierId)!.name : "";
  const standing = page.locator('[data-testid="activity-row"][data-kind="standing"]');
  await expect(standing).toHaveCount(1);
  await expect(standing.getByTestId("activity-category")).toHaveText("Standing");
  await expect(standing.getByTestId("activity-text")).toHaveText(`New standing: ${tierName}.`);
  await expect(standing.locator(".money")).toHaveCount(0);

  // One notification for the promotion: its toast. The feed row is the record, not a second toast.
  await expect(page.locator('[data-testid="toast"][data-event="TIER_REACHED"]')).toHaveCount(1);

  // Cash lines carry their cash figure; PROGRESSION transactions never show.
  const sale = expected.find((r) => r.kind === "cash" && r.transactionKind === "SALE");
  expect(sale).toBeDefined();
  if (sale?.kind === "cash" && sale.cash !== null) {
    await expect(page.locator(`[data-testid="activity-row"][data-transaction-kind="SALE"]`).first().getByTestId("activity-cash")).toHaveText(formatMoney(sale.cash));
  }
  await expect(page.locator('[data-transaction-kind="PROGRESSION"]')).toHaveCount(0);
  // Unlocks are granted with the promotion, but get no row.
  expect(s.recentEvents.some((e) => e.type === "UNLOCK_GRANTED")).toBe(true);
  await expect(page.locator('[data-testid="activity-row"]:not([data-kind="cash"]):not([data-kind="reputation"]):not([data-kind="standing"])')).toHaveCount(0);

  if (process.platform === "linux") await expect(page.getByTestId("panel-activity")).toHaveScreenshot("activity.png");
  await prShot(page, HERE, "activity");
  await prShot(page.getByTestId("panel-activity"), HERE, "activity-panel");
});
