// The end screen's view (#136): keyed off snapshot.outcome and the outcome
// events, never the scheduler; the #99 strings verbatim.

import { asId, cents, tick, type GameSnapshot } from "@eov/contracts";
import { midGameSnapshot } from "@eov/contracts/fixtures";
import { describe, expect, it } from "vitest";
import { END_SCREEN_COPY as C } from "../../../src/app/end-screen/copy.ts";
import { endScreenFor } from "../../../src/app/end-screen/end-screen-view.ts";

const won: GameSnapshot = {
  ...midGameSnapshot,
  outcome: { status: "WON", tick: tick(20_000) },
  recentEvents: [
    ...midGameSnapshot.recentEvents,
    { id: asId("Event", "evt-v"), tick: tick(20_000), causedBy: null, type: "VICTORY_ACHIEVED", netWorth: cents(512_345), reputation: 31, completedContractId: asId("Contract", "c-1") },
  ],
};
const lost: GameSnapshot = { ...midGameSnapshot, outcome: { status: "LOST", tick: tick(1_440), reason: "INSOLVENT" } };

describe("endScreenFor", () => {
  it("shows nothing while playing, or with no game", () => {
    expect(endScreenFor(midGameSnapshot)).toBeNull();
    expect(endScreenFor(null)).toBeNull();
  });

  it("a victory takes its figures from VICTORY_ACHIEVED", () => {
    expect(endScreenFor(won)).toEqual({ kind: "victory", key: "WON:20000", tick: 20_000, netWorth: 512_345, reputation: 31, completedContracts: 0 });
  });

  it("a victory whose event has left the recent events falls back to the snapshot's figures", () => {
    const old = { ...won, recentEvents: [] };
    expect(endScreenFor(old)).toMatchObject({ kind: "victory", netWorth: midGameSnapshot.progression.victory.netWorth.current, reputation: 13 });
  });

  it("a loss keys on its tick and shows the cash left", () => {
    expect(endScreenFor(lost)).toEqual({ kind: "loss", key: "LOST:1440", tick: 1_440, cash: midGameSnapshot.finance.cash });
  });
});

describe("the #99 wording", () => {
  it("victory", () => {
    expect(C.victory).toEqual({
      title: "The Road to Chicago",
      lead: "Chicago doesn't know your name yet. It will.",
      support: "You've built a working trade, earned the trust of your buyers, and proved the Kerrigans can do more than make a good batch. The city is next.",
    });
    expect(C.review).toBe("Review the operation");
  });

  it("loss, with the alternate lead", () => {
    expect(C.loss).toEqual({
      title: "The Still Goes Cold",
      lead: "Nothing left to sell. No way to start again.",
      support: "The Kerrigans' first operation is finished. The family story doesn't have to be.",
    });
    expect(C.startAgain).toBe("Start again");
  });
});
