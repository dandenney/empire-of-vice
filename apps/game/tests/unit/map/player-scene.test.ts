// SK2b (#234): the founder-rules map scene, from the player snapshot alone.
// Every place and road is drawn; the truck only where it was last seen; the
// founder's token beside their place, or along the leg while travelling.

import { tick } from "@eov/contracts";
import { describe, expect, it } from "vitest";
import { fitPlayerView, sceneOfPlayer } from "../../../src/map/player-scene.ts";
import { place } from "../../../src/map/scene.ts";
import { FEED_STORE, freshGame, HOME, playTo, send } from "../founder/fixture.ts";

const founder = (s: ReturnType<typeof sceneOfPlayer>) => s.find((e) => e.kind === "FOUNDER");

describe("founder-rules map scene", () => {
  it("draws every place and road, the founder asleep at home, and no truck before it's been seen", () => {
    const { player } = playTo("asleep");
    const scene = sceneOfPlayer(player);
    expect(scene.filter((e) => e.kind === "ROUTE")).toHaveLength(player.routes.length);
    expect(scene.filter((e) => e.locationId !== null).map((e) => e.locationId)).toEqual(player.places.map((p) => p.id));
    expect(scene.filter((e) => e.kind === "VEHICLE")).toEqual([]);
    const home = player.places.find((p) => p.id === HOME)!;
    expect(founder(scene)).toMatchObject({ position: home.position, parked: true });
  });

  it("draws the truck where it was seen, once the founder has looked", () => {
    const { player } = playTo("awake");
    const home = player.places.find((p) => p.id === HOME)!;
    expect(sceneOfPlayer(player).find((e) => e.kind === "VEHICLE")).toMatchObject({ position: home.position, parked: true });
  });

  it("moves the founder's token along the leg while travelling", () => {
    const sim = freshGame();
    sim.advance(360);
    send(sim, { type: "TRAVEL", destinationLocationId: FEED_STORE, transport: { kind: "FOOT" }, via: null });
    const w = sim.state.founder.whereabouts;
    if (w.kind !== "TRAVELLING") throw new Error("expected travelling");
    sim.advance((w.legArrivesAt - w.legDepartedAt) / 2);
    const player = sim.playerSnapshot();
    const leg = player.founder.currentLeg!;
    expect(leg.progressPpm).toBeGreaterThan(400_000);
    expect(leg.progressPpm).toBeLessThan(600_000);
    const token = founder(sceneOfPlayer(player))!;
    expect(token.parked).toBe(false);
    const [a, b] = [leg.waypoints[0]!, leg.waypoints.at(-1)!];
    expect(token.position.x).toBeGreaterThan(Math.min(a.x, b.x));
    expect(token.position.x).toBeLessThan(Math.max(a.x, b.x));
    // On screen, a token on the road isn't offset from its point.
    const view = fitPlayerView(player, 800, 500);
    const placed = place(sceneOfPlayer(player), view).find((p) => p.entity.kind === "FOUNDER")!;
    expect(placed.screen.x).toBeCloseTo(view.offsetX + token.position.x * view.scale);
    expect(player.clock.tick).toBe(tick(360 + (w.legArrivesAt - w.legDepartedAt) / 2));
  });
});
