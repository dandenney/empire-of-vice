// The Facility panel's view helpers (#128): a LOCKED equipment option names
// its unlock and the tier that grants it, with that tier's requirements, all
// read from the snapshot's progression; other reasons read as elsewhere.

import { asId, cents, formatMoney, type GameSnapshot } from "@eov/contracts";
import { midGameSnapshot } from "@eov/contracts/fixtures";
import { describe, expect, it } from "vitest";
import { describeReason } from "../../../../src/components/format.ts";
import { describeBlocker, tierGranting, tierRequirements } from "../../../../src/panels/facility/facility-view.ts";

const locked = midGameSnapshot.facilities[0]!.equipmentOptions.find((o) => o.blockedBy?.code === "LOCKED")!;
const unlockId = locked.blockedBy!.code === "LOCKED" ? locked.blockedBy!.unlockId : asId("Unlock", "never");

describe("tierGranting", () => {
  it("finds the tier whose unlocks include the id, from the snapshot", () => {
    const tier = tierGranting(midGameSnapshot, unlockId)!;
    expect(tier.unlocks).toContain(unlockId);
    expect(tierGranting(midGameSnapshot, asId("Unlock", "nothing-grants-this"))).toBeNull();
  });
});

describe("tierRequirements", () => {
  it("states the tier's net worth and reputation requirements as the snapshot gives them", () => {
    const tier = tierGranting(midGameSnapshot, unlockId)!;
    expect(tierRequirements(tier)).toBe(`net worth ${formatMoney(tier.netWorthRequired!)} and reputation ${tier.reputationRequired}`);
    expect(tierRequirements({ ...tier, netWorthRequired: null })).toBe(`reputation ${tier.reputationRequired}`);
    expect(tierRequirements({ ...tier, netWorthRequired: null, reputationRequired: null })).toBe("no requirements");
  });

  it("follows the snapshot when the numbers change", () => {
    const tier = tierGranting(midGameSnapshot, unlockId)!;
    expect(tierRequirements({ ...tier, netWorthRequired: cents(123_456), reputationRequired: 42 })).toBe("net worth $1,234.56 and reputation 42");
  });
});

describe("describeBlocker", () => {
  it("gives a LOCKED option's typed reason, then the tier that grants the unlock", () => {
    const tier = tierGranting(midGameSnapshot, unlockId)!;
    const lines = describeBlocker(midGameSnapshot, locked.blockedBy!);
    expect(lines[0]).toBe(describeReason(locked.blockedBy!));
    expect(lines[0]).toContain("LOCKED");
    expect(lines[0]).toContain(unlockId);
    expect(lines[1]).toBe(`${tier.name} grants it: ${tierRequirements(tier)}.`);
  });

  it("gives only the typed reason when no tier grants the unlock, or for any other reason", () => {
    const noTiers: GameSnapshot = { ...midGameSnapshot, progression: { ...midGameSnapshot.progression, tiers: [] } };
    expect(describeBlocker(noTiers, locked.blockedBy!)).toEqual([describeReason(locked.blockedBy!)]);
    const funds = { code: "INSUFFICIENT_FUNDS", required: cents(40_000), available: cents(100) } as const;
    expect(describeBlocker(midGameSnapshot, funds)).toEqual([describeReason(funds)]);
  });
});
