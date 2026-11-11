// The Progression panel (#136): current tier, reputation, the next tier's
// requirements and unlocks, the victory conditions, the ladder, and the
// reputation-gated buyers, all read from the snapshot. Lakeview's minimum is
// whatever the snapshot says.

import { cents, formatMoney, type GameSnapshot } from "@eov/contracts";
import { ids, midGameSnapshot, startOfGameSnapshot } from "@eov/contracts/fixtures";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PROGRESSION_COPY as C } from "../../../../src/panels/progression/copy.ts";
import { ProgressionPanel } from "../../../../src/panels/progression/progression-panel.tsx";
import {
  currentTier,
  describeNeeds,
  nextTier,
  reputationGatedBuyers,
  requirements,
  tierStatus,
  unlockLabel,
  victoryConditions,
} from "../../../../src/panels/progression/progression-view.ts";

const render = (snapshot: GameSnapshot) => renderToStaticMarkup(<ProgressionPanel snapshot={snapshot} />);

describe("current and next tier", () => {
  it("reads the current tier by id and the next one from the ladder's order", () => {
    expect(currentTier(midGameSnapshot)?.id).toBe(ids.tierTrusted);
    expect(nextTier(midGameSnapshot)?.id).toBe(midGameSnapshot.progression.tiers[2]!.id);
    expect(currentTier(startOfGameSnapshot)?.id).toBe(ids.tierStart);
  });

  it("has no next tier at the top", () => {
    const tiers = midGameSnapshot.progression.tiers;
    const top: GameSnapshot = { ...midGameSnapshot, progression: { ...midGameSnapshot.progression, currentTierId: tiers[tiers.length - 1]!.id } };
    expect(nextTier(top)).toBeNull();
    expect(render(top)).toContain(C.topTier);
  });
});

describe("requirements", () => {
  it("compares the snapshot's figures with the tier's thresholds", () => {
    const next = nextTier(midGameSnapshot)!;
    const [netWorth, reputation] = requirements(next, midGameSnapshot);
    expect(netWorth).toEqual({ kind: "net-worth", required: next.netWorthRequired, current: midGameSnapshot.finance.netWorth, met: midGameSnapshot.finance.netWorth >= next.netWorthRequired! });
    expect(reputation).toEqual({ kind: "reputation", required: next.reputationRequired, current: 13, met: 13 >= next.reputationRequired! });
  });

  it("treats a null threshold as met", () => {
    const tier = { ...nextTier(midGameSnapshot)!, netWorthRequired: null, reputationRequired: null };
    expect(requirements(tier, midGameSnapshot).every((r) => r.met)).toBe(true);
    expect(describeNeeds(tier)).toBe(C.needsNothing);
  });

  it("follows the snapshot when a threshold changes", () => {
    const tier = { ...nextTier(midGameSnapshot)!, netWorthRequired: cents(123_456), reputationRequired: 42 };
    expect(describeNeeds(tier)).toBe(`net worth ${formatMoney(cents(123_456))}, reputation 42`);
  });
});

describe("ladder status", () => {
  it("marks the current tier, the reached ones, and the rest", () => {
    const [start, trusted, established] = midGameSnapshot.progression.tiers;
    expect(tierStatus(start!, midGameSnapshot)).toBe("reached");
    expect(tierStatus(trusted!, midGameSnapshot)).toBe("current");
    expect(tierStatus(established!, midGameSnapshot)).toBe("not-reached");
  });
});

describe("victory conditions", () => {
  it("lists all three, current against target, from progression.victory", () => {
    const v = midGameSnapshot.progression.victory;
    expect(victoryConditions(midGameSnapshot)).toEqual([
      { kind: "net-worth", current: v.netWorth.current, target: v.netWorth.target, met: false },
      { kind: "reputation", current: 13, target: v.reputation.target, met: false },
      { kind: "completed-contracts", current: 0, target: v.completedContracts.target, met: false },
    ]);
  });
});

describe("reputation-gated buyers", () => {
  it("lists buyers with a minimum, and shows the snapshot's minimum, whatever it is", () => {
    const gated = reputationGatedBuyers(midGameSnapshot);
    expect(gated.map((b) => b.id)).toEqual(midGameSnapshot.market.buyers.filter((b) => b.minimumReputation > 0).map((b) => b.id));
    const moved: GameSnapshot = {
      ...midGameSnapshot,
      market: { ...midGameSnapshot.market, buyers: midGameSnapshot.market.buyers.map((b) => (b.id === ids.hotel ? { ...b, minimumReputation: 77 } : b)) },
    };
    expect(render(moved)).toMatch(/data-testid="progression-buyer-lakeview-hotel-minimum"><span class="money">77</);
  });
});

describe("the panel", () => {
  it("shows the standing, reputation, next tier, and unlocks from the snapshot", () => {
    const html = render(midGameSnapshot);
    const next = nextTier(midGameSnapshot)!;
    expect(html).toContain(currentTier(midGameSnapshot)!.name);
    expect(html).toContain(C.nextTitle(next.name));
    expect(html).toContain(C.nextUnlocks(next.unlocks.map(unlockLabel).join(", ")));
    expect(html).toContain(formatMoney(next.netWorthRequired!));
    for (const id of midGameSnapshot.progression.unlocked) expect(html).toContain(unlockLabel(id));
  });

  it("names an unknown unlock by its id", () => {
    expect(unlockLabel("some-new-unlock" as never)).toBe("some-new-unlock");
  });
});
