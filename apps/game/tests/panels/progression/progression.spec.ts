// The Progression panel (#136): the current standing, reputation, the next
// standing's requirements and unlocks, the victory conditions, the ladder,
// the unlocks held, and the buyers who want a reputation. Every expected
// figure and name is read from the snapshot; Lakeview's minimum included.
// Screenshot baselines are linux-only (CI).

import { formatMoney } from "@eov/contracts";
import { expect, test } from "@playwright/test";
import { PROGRESSION_COPY as C } from "../../../src/panels/progression/copy.ts";
import { describeNeeds, unlockLabel } from "../../../src/panels/progression/progression-view.ts";
import { newGame, planVictory, replay, snapshot } from "../../end-screen/campaign.ts";
import { prShot } from "../../end-screen/pr-shots.ts";

const HERE = import.meta.dirname;

test("shows the standing, the next standing's requirements, victory, and gated buyers from the snapshot", async ({ page }) => {
  await newGame(page);
  await page.getByTestId("open-progression").click();
  await expect(page.getByTestId("panel-progression")).toBeVisible();
  const s = await snapshot(page);
  const { tiers, currentTierId } = s.progression;
  const index = tiers.findIndex((t) => t.id === currentTierId);
  const current = tiers[index]!;
  const next = tiers[index + 1]!;

  await expect(page.getByTestId("progression-standing")).toHaveText(current.name);
  await expect(page.getByTestId("progression-reputation")).toHaveText(String(s.family.reputation));
  await expect(page.getByTestId("progression-net-worth")).toHaveText(formatMoney(s.finance.netWorth));

  // The next standing: its thresholds beside the family's figures, and what it unlocks.
  await expect(page.getByTestId("progression-next")).toContainText(C.nextTitle(next.name));
  await expect(page.getByTestId("progression-next-net-worth-required")).toHaveText(formatMoney(next.netWorthRequired!));
  await expect(page.getByTestId("progression-next-reputation-required")).toHaveText(String(next.reputationRequired));
  await expect(page.getByTestId("progression-next-reputation-now")).toHaveText(String(s.family.reputation));
  await expect(page.getByTestId("progression-next-unlocks")).toHaveText(C.nextUnlocks(next.unlocks.map(unlockLabel).join(", ")));

  // Victory: target and current from progression.victory.
  const v = s.progression.victory;
  await expect(page.getByTestId("progression-victory-net-worth-target")).toHaveText(formatMoney(v.netWorth.target));
  await expect(page.getByTestId("progression-victory-reputation-target")).toHaveText(String(v.reputation.target));
  await expect(page.getByTestId("progression-victory-completed-contracts-target")).toHaveText(String(v.completedContracts.target));

  // The ladder and the unlocks held.
  for (const tier of tiers) await expect(page.getByTestId(`progression-tier-${tier.id}-needs`)).toHaveText(describeNeeds(tier));
  await expect(page.getByTestId(`progression-tier-${current.id}-status`)).toHaveText(C.current);
  await expect(page.getByTestId("progression-unlocked")).toHaveText(s.progression.unlocked.map(unlockLabel).join(", "));

  // Reputation-gated buyers: the minimum as the snapshot gives it.
  const gated = s.market.buyers.filter((b) => b.minimumReputation > 0);
  expect(gated.length).toBeGreaterThan(0);
  for (const b of gated) {
    await expect(page.getByTestId(`progression-buyer-${b.id}-minimum`)).toHaveText(String(b.minimumReputation));
    await expect(page.getByTestId(`progression-buyer-${b.id}-deals`)).toHaveText(b.willDeal ? C.willDealYes : C.willDealNo);
  }

  if (process.platform === "linux") await expect(page.getByTestId("panel-progression")).toHaveScreenshot("progression.png");
  await prShot(page, HERE, "progression");
});

test("follows a promotion: the new standing, the one after it, and its unlocks", async ({ page }) => {
  test.setTimeout(90_000);
  const plan = planVictory();
  const promotion = plan.events.find((e) => e.type === "TIER_REACHED")!;
  await newGame(page);
  await replay(page, plan, promotion.tick);
  await page.getByTestId("open-progression").click();
  const s = await snapshot(page);
  const { tiers, currentTierId } = s.progression;
  expect(promotion.type === "TIER_REACHED" && currentTierId).toBe(promotion.type === "TIER_REACHED" ? promotion.tierId : null);
  const index = tiers.findIndex((t) => t.id === currentTierId);
  await expect(page.getByTestId("progression-standing")).toHaveText(tiers[index]!.name);
  await expect(page.getByTestId(`progression-tier-${tiers[index - 1]!.id}-status`)).toHaveText(C.reached);
  await expect(page.getByTestId("progression-next")).toContainText(C.nextTitle(tiers[index + 1]!.name));
  await expect(page.getByTestId("progression-unlocked")).toHaveText(s.progression.unlocked.map(unlockLabel).join(", "));
  await prShot(page.getByTestId("panel-progression"), HERE, "progression-promoted");
});
