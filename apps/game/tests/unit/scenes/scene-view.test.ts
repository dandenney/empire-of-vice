// SK2b (#234): a place scene's view model. Its layers show known state, and
// the actions it offers (and why one can't be taken now) come from known and
// always-known state only.

import { minuteOfDay, tick, TICKS_PER_HOUR, type LocationId, type PlayerSnapshot } from "@eov/contracts";
import { MAX_REST_TICKS, MIN_REST_TICKS } from "@eov/game-data";
import { describe, expect, it } from "vitest";
import { hoursAt } from "../../../src/scenes/hours.ts";
import { restUntilMorning } from "../../../src/scenes/rest.ts";
import { sceneView, type SceneAction, type SceneView } from "../../../src/scenes/scene-view.ts";
import { CROSSROADS, FEED_STORE, HOME, playTo, RECIPE } from "../founder/fixture.ts";

const scene = (p: PlayerSnapshot, id: LocationId): SceneView => sceneView(p, id)!;
const actions = (v: SceneView, kind: SceneAction["kind"]) => v.actions.filter((a) => a.kind === kind);
const layer = (v: SceneView, kind: string) => v.layers.find((l) => l.kind === kind);

/** The snapshot with its clock moved to `t` (hours and the one-click rest read only the clock). */
const at = (p: PlayerSnapshot, t: number): PlayerSnapshot => ({ ...p, clock: { ...p.clock, tick: tick(t) } });

describe("scene view", () => {
  it("offers to buy each material at an open supplier the founder stands in", () => {
    const { player } = playTo("at the feed store");
    const v = scene(player, FEED_STORE);
    expect(v.kind).toBe("SUPPLIER");
    expect(v.present).toBe(true);
    expect(v.hours).toMatchObject({ kind: "HOURS", open: true });
    const buys = actions(v, "BUY");
    expect(buys.map((b) => b.kind === "BUY" && b.materialId).sort()).toEqual(RECIPE.inputsPerCase.map((i) => i.materialId).sort());
    expect(buys.every((b) => b.blocked === null)).toBe(true);
    expect(layer(v, "SHELVES")).toMatchObject({ seen: { learnedAt: player.clock.tick, source: { kind: "IN_PERSON", locationId: FEED_STORE } } });
    // Resting is always on offer, and the feed store isn't a bed.
    expect(actions(v, "REST")).toMatchObject([{ blocked: null, restPlace: false }]);
  });

  it("blocks timed actions while the founder is busy, until the activity ends", () => {
    const { player } = playTo("buying");
    const w = player.founder.whereabouts;
    if (w.kind !== "PRESENT" || w.busy === null) throw new Error("expected busy");
    const v = scene(player, FEED_STORE);
    expect(v.busyUntil).toBe(w.busy.until);
    for (const a of v.actions) expect(a.blocked).toEqual({ code: "BUSY", until: w.busy.until });
  });

  it("blocks dealings while the place is closed, and says when it opens", () => {
    const { player } = playTo("at the feed store");
    // 19:00 the same day: Miller's closes at 18:00 and opens at 07:00.
    const evening = at(player, 19 * TICKS_PER_HOUR);
    const v = scene(evening, FEED_STORE);
    const opensAt = 24 * TICKS_PER_HOUR + 7 * TICKS_PER_HOUR;
    expect(v.hours).toMatchObject({ kind: "HOURS", open: false, opensAt });
    for (const b of actions(v, "BUY")) expect(b.blocked).toEqual({ code: "CLOSED", opensAt });
    expect(actions(v, "REST")[0]!.blocked).toBeNull();
  });

  it("offers nothing but travel elsewhere: a place the founder isn't at is NOT_HERE", () => {
    const { player } = playTo("at the feed store");
    const v = scene(player, HOME);
    expect(v.present).toBe(false);
    for (const a of v.actions) expect(a.blocked).toEqual({ code: "NOT_HERE" });
  });

  it("at home with materials: start a batch, the truck in the yard, nothing to load yet", () => {
    const { player } = playTo("home with materials");
    const v = scene(player, HOME);
    expect(v.hours).toEqual({ kind: "ALWAYS" });
    expect(actions(v, "START_BATCH")).toMatchObject([{ recipeId: RECIPE.id, blocked: null }]);
    expect((actions(v, "START_BATCH")[0] as { maxQuantity: number }).maxQuantity).toBeGreaterThanOrEqual(1);
    expect(actions(v, "DISPATCH")).toMatchObject([{ blocked: { code: "NOTHING_TO_LOAD" } }]);
    expect(layer(v, "TRUCK")).toMatchObject({ here: true });
    expect(layer(v, "CRATES")).toMatchObject({ cases: 0 });
    expect(actions(v, "REST")).toMatchObject([{ restPlace: true, blocked: null }]);
  });

  it("with the batch done: load the truck for a buyer, safe roads first", () => {
    const { player } = playTo("batch done");
    const v = scene(player, HOME);
    expect(layer(v, "CRATES")).toMatchObject({ cases: 1 });
    expect(layer(v, "STILL")).toMatchObject({ batches: 0 });
    const [dispatch] = actions(v, "DISPATCH");
    if (dispatch?.kind !== "DISPATCH") throw new Error("no dispatch");
    expect(dispatch.blocked).toBeNull();
    expect(dispatch.cargo).toMatchObject([{ productId: RECIPE.productId, quality: RECIPE.quality, available: 1 }]);
    const crossroads = dispatch.buyers.find((b) => b.locationId === CROSSROADS)!;
    expect(crossroads.routes.map((r) => r.id)).toEqual(["state-highway", "crossroads-back-road"]);
    expect(crossroads.routes[0]).toMatchObject({ riskPpm: 0, knownClosed: false });
    expect(dispatch.deals).toEqual([]);
  });

  it("at a buyer whose wants aren't known, offers no deal", () => {
    const { player } = playTo("awake");
    const v = scene(player, CROSSROADS);
    expect(v.kind).toBe("BUYER");
    expect(actions(v, "AGREE_DEAL")).toEqual([]);
    expect(layer(v, "WANTS")).toMatchObject({ seen: null });
    // The Crossroads opens at 11:00; at 06:00 it's closed.
    expect(v.hours).toMatchObject({ kind: "HOURS", open: false, opensAt: 11 * TICKS_PER_HOUR });
  });

  it("at a buyer with known wants, offers a deal per want, blocked by what's known", () => {
    const { player } = playTo("awake");
    const want = { productId: RECIPE.productId, productName: "Moonshine", minimumQuality: RECIPE.quality, unitPrice: 1800, demandRemaining: 5, maxAcceptableQuantity: 5 };
    const known = (willDeal: boolean): PlayerSnapshot => ({
      ...at(player, 12 * TICKS_PER_HOUR),
      founder: { ...player.founder, whereabouts: { kind: "PRESENT", locationId: CROSSROADS, busy: null, call: null } },
      places: player.places.map((p) =>
        p.id === CROSSROADS && p.kind === "BUYER"
          ? { ...p, buyer: { ...p.buyer, wants: { value: { kind: "BUYER_WANTS", buyerId: p.buyer.id, willDeal, wants: [want] }, learnedAt: tick(700), source: { kind: "IN_PERSON", locationId: CROSSROADS } } } }
          : p,
      ) as never,
    });
    expect(actions(scene(known(true), CROSSROADS), "AGREE_DEAL")).toMatchObject([{ productId: RECIPE.productId, maxQuantity: 5, unitPrice: 1800, blocked: null }]);
    expect(actions(scene(known(false), CROSSROADS), "AGREE_DEAL")).toMatchObject([{ blocked: { code: "WONT_DEAL" } }]);
  });
});

describe("hours", () => {
  it("knows hours that cross midnight", () => {
    const lakeview = "lakeview" as LocationId;
    expect(hoursAt(lakeview, tick(23 * TICKS_PER_HOUR))).toMatchObject({ open: true });
    expect(hoursAt(lakeview, tick(24 * TICKS_PER_HOUR + 60))).toMatchObject({ open: true });
    expect(hoursAt(lakeview, tick(24 * TICKS_PER_HOUR + 3 * TICKS_PER_HOUR))).toMatchObject({ open: false, opensAt: 24 * TICKS_PER_HOUR + 20 * TICKS_PER_HOUR });
  });
});

describe("rest until morning", () => {
  it("aims for the next morning, within the one-click margins", () => {
    // Home at 01:18 on day 1 (the SK1d path): 06:00 that morning.
    expect(restUntilMorning(tick(1_518))).toBe(1_800);
    for (let now = 0; now < 3 * 1_440; now += 7) {
      const until = restUntilMorning(tick(now));
      expect(until).toBeGreaterThanOrEqual(now + MIN_REST_TICKS + 61);
      expect(until).toBeLessThanOrEqual(now + MAX_REST_TICKS - 60);
    }
    // At 20:00, a full night: 06:00 the next day.
    expect(minuteOfDay(restUntilMorning(tick(20 * TICKS_PER_HOUR)))).toBe(6 * TICKS_PER_HOUR);
  });
});
