// ADR 0023 decision 11's game-data: the presence tables and the route graph.
import { ACTIVITY_KINDS, TICKS_PER_HOUR } from "@eov/contracts";
import { describe, expect, it } from "vitest";
import {
  ACTIVITY_DURATIONS,
  FEED_STORE_ROAD,
  GAME_DATA,
  HOLLOW_CREEK,
  LIVE_VIEW_ROUTES,
  LOCATIONS,
  MAX_REST_TICKS,
  MILLERS_FEED_LOCATION,
  MIN_REST_TICKS,
  PLACE_HOURS,
  PRESENCE,
  PresenceDataError,
  REST_RANGE_MIN_SPAN_TICKS,
  RouteDataError,
  ROUTES,
  START_WAKE_TICK,
  validatePlaceHours,
  validatePresence,
  validateRouteGraph,
} from "../src/index.ts";

describe("presence tables (PLACEHOLDER values)", () => {
  it("gives every activity the decision 4 duration", () => {
    expect(Object.keys(ACTIVITY_DURATIONS).sort()).toEqual([...ACTIVITY_KINDS].sort());
    expect(ACTIVITY_DURATIONS).toEqual({
      BUY_MATERIALS: 30,
      START_BATCH: 30,
      LOAD_TRUCK: 30,
      AGREE_DEAL: 30,
      ACCEPT_CONTRACT: 60,
      BUY_EQUIPMENT: 60,
      SELL_EQUIPMENT: 60,
      SET_WORKFORCE: 30,
    });
  });

  it("has decision 3 and 7's starting values", () => {
    expect(PRESENCE).toMatchObject({
      footTravelPpm: 3_000_000,
      restPlaces: [HOLLOW_CREEK],
      minRestTicks: 2 * TICKS_PER_HOUR,
      maxRestTicks: 14 * TICKS_PER_HOUR,
      fullRestTicks: 8 * TICKS_PER_HOUR,
      roughRestTicks: 12 * TICKS_PER_HOUR,
      tiredAfterTicks: 18 * TICKS_PER_HOUR,
      tiredDurationPpm: 1_500_000,
      wakeHour: 6,
      startWakeTick: 6 * TICKS_PER_HOUR,
      restSpeedMultiplier: 16,
    });
    expect(START_WAKE_TICK).toBe(360);
  });

  it("keeps decision 6's hours, with the Lakeview back room across midnight and your own places always open", () => {
    const at = (id: string) => PLACE_HOURS.find((e) => e.locationId === id)?.intervals;
    expect(at("millers-feed")).toEqual([{ opensAtMinute: 420, closesAtMinute: 1_080 }]);
    expect(at("kessler-pharmacy")).toEqual([{ opensAtMinute: 540, closesAtMinute: 1_140 }]);
    expect(at("crossroads")).toEqual([{ opensAtMinute: 660, closesAtMinute: 1_380 }]);
    expect(at("lakeview")).toEqual([{ opensAtMinute: 1_200, closesAtMinute: 120 }]);
    expect(at("hollow-creek")).toBeUndefined();
    expect(at("riverside-depot")).toBeUndefined();
  });
});

describe("presence validation", () => {
  it("requires MAX_REST_TICKS − MIN_REST_TICKS ≥ 121, so the one-click rest's margins leave a valid tick", () => {
    expect(REST_RANGE_MIN_SPAN_TICKS).toBe(121);
    expect(MAX_REST_TICKS - MIN_REST_TICKS).toBeGreaterThanOrEqual(121);
    expect(validatePresence({ ...PRESENCE, minRestTicks: 120, maxRestTicks: 241 }).maxRestTicks).toBe(241);
    expect(() => validatePresence({ ...PRESENCE, minRestTicks: 120, maxRestTicks: 240 })).toThrow(PresenceDataError);
    expect(() => validatePresence({ ...PRESENCE, minRestTicks: 600, maxRestTicks: 500 })).toThrow(PresenceDataError);
  });

  it.each([
    ["a negative activity duration", { activityDurations: { ...ACTIVITY_DURATIONS, LOAD_TRUCK: -1 } }],
    ["a fractional activity duration", { activityDurations: { ...ACTIVITY_DURATIONS, LOAD_TRUCK: 0.5 } }],
    ["walking faster than driving", { footTravelPpm: 999_999 }],
    ["tiredness that speeds things up", { tiredDurationPpm: 900_000 }],
    ["an unknown rest place", { restPlaces: ["nowhere" as never] }],
    ["a repeated rest place", { restPlaces: [HOLLOW_CREEK, HOLLOW_CREEK] }],
    ["a zero minimum rest", { minRestTicks: 0 }],
    ["a zero full rest", { fullRestTicks: 0 }],
    ["WAKE_HOUR 24", { wakeHour: 24 }],
    ["a start wake past the first day", { startWakeTick: 1_440 }],
    ["a rest speed of zero", { restSpeedMultiplier: 0 }],
  ])("rejects %s", (_label, patch) => {
    expect(() => validatePresence({ ...PRESENCE, ...patch })).toThrow(PresenceDataError);
  });

  it("rejects place hours for unknown places, out of order, empty, or outside the day", () => {
    const open = [{ opensAtMinute: 60, closesAtMinute: 120 }];
    expect(() => validatePlaceHours([{ locationId: "nowhere" as never, intervals: open }])).toThrow(PresenceDataError);
    expect(() => validatePlaceHours([...PLACE_HOURS].reverse())).toThrow(PresenceDataError);
    expect(() => validatePlaceHours([{ locationId: HOLLOW_CREEK, intervals: [] }])).toThrow(PresenceDataError);
    expect(() => validatePlaceHours([{ locationId: HOLLOW_CREEK, intervals: [{ opensAtMinute: 0, closesAtMinute: 1_440 }] }])).toThrow(PresenceDataError);
    expect(() => validatePlaceHours([{ locationId: HOLLOW_CREEK, intervals: [{ opensAtMinute: 60, closesAtMinute: 60 }] }])).toThrow(PresenceDataError);
  });
});

describe("the route graph (decision 3)", () => {
  it("adds a route from Hollow Creek to the feed store", () => {
    const road = ROUTES.find((r) => r.id === FEED_STORE_ROAD);
    expect(road).toMatchObject({ fromLocationId: HOLLOW_CREEK, toLocationId: MILLERS_FEED_LOCATION, riskPpm: 0 });
    expect(GAME_DATA.routes).toBe(ROUTES);
    expect(LIVE_VIEW_ROUTES.find((e) => e.locationId === MILLERS_FEED_LOCATION)?.routeIds).toEqual([FEED_STORE_ROAD]);
  });

  it("connects every location", () => {
    expect(validateRouteGraph(ROUTES, LOCATIONS)).toBe(ROUTES);
  });

  it("rejects a graph that leaves a location out, or a route to nowhere or to itself", () => {
    const withoutFeedStore = ROUTES.filter((r) => r.id !== FEED_STORE_ROAD);
    expect(() => validateRouteGraph(withoutFeedStore)).toThrow(RouteDataError);
    expect(() => validateRouteGraph(withoutFeedStore)).toThrow(/millers-feed/);
    expect(() => validateRouteGraph([...ROUTES, { ...ROUTES[0]!, toLocationId: "nowhere" as never }])).toThrow(RouteDataError);
    expect(() => validateRouteGraph([...ROUTES, { ...ROUTES[0]!, toLocationId: HOLLOW_CREEK }])).toThrow(RouteDataError);
  });

  it("counts a route in either direction: routes listed only outward still connect", () => {
    const outward = ROUTES.filter((r) => r.fromLocationId === HOLLOW_CREEK);
    expect(validateRouteGraph(outward)).toBe(outward);
  });
});
