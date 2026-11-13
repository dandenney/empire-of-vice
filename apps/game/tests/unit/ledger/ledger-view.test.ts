// SK2b (#234): the ledger's view model. One entry per knowledge record in the
// player snapshot, each with its value, its age and its source; road records
// read "seen on <road>" (decided on #174).

import { tick, type KnowledgeSource, type LocationId, type PlayerSnapshot } from "@eov/contracts";
import { describe, expect, it } from "vitest";
import { LEDGER_COPY } from "../../../src/ledger/copy.ts";
import { formatAge, formatSource, ledgerEntryCount, ledgerGroups } from "../../../src/ledger/ledger-view.ts";
import { playTo } from "../founder/fixture.ts";

/** Every Known<…> in the snapshot that isn't null: what the ledger must list. */
function knownCount(p: PlayerSnapshot): number {
  let n = 0;
  const count = (k: unknown) => {
    if (k !== null) n++;
  };
  for (const place of p.places) {
    if (place.kind === "FACILITY") [place.facility.stock, place.facility.operations].forEach(count);
    if (place.kind === "SUPPLIER") count(place.supplier.offer);
    if (place.kind === "BUYER") [place.buyer.wants, place.buyer.budget, place.buyer.offers].forEach(count);
  }
  p.routes.forEach((r) => count(r.condition));
  p.vehicles.forEach((v) => count(v.whereabouts));
  p.contracts.forEach((c) => count(c.progress));
  count(p.market);
  count(p.standing);
  return n;
}

const entries = (p: PlayerSnapshot) => ledgerGroups(p).flatMap((g) => g.entries.map((e) => ({ group: g.title, ...e })));

describe("ledger view", () => {
  it("is empty before the founder has seen anything", () => {
    const { player } = playTo("asleep");
    expect(knownCount(player)).toBe(0);
    expect(ledgerGroups(player)).toEqual([]);
  });

  it("lists one entry per knowledge record, at every stop on the path", () => {
    for (const stop of ["awake", "at the feed store", "buying", "home with materials", "batch done"] as const) {
      const { player } = playTo(stop);
      expect(ledgerEntryCount(ledgerGroups(player)), stop).toBe(knownCount(player));
      expect(knownCount(player), stop).toBeGreaterThan(0);
    }
  });

  it("dates each entry and names its source; roads read 'seen on <road>'", () => {
    const { player } = playTo("at the feed store");
    const all = entries(player);
    const offer = all.find((e) => e.subject === "SUPPLIER_OFFER")!;
    expect(offer.group).toBe("Miller's Feed & Seed");
    expect(offer.source).toBe(LEDGER_COPY.source.inPerson("Miller's Feed & Seed"));
    expect(offer.age).toBe(LEDGER_COPY.justNow);
    expect(offer.lines.length).toBeGreaterThan(0);

    // Home's stock was seen when the founder set out, three hours' walk ago.
    const stock = all.find((e) => e.subject === "FACILITY_STOCK")!;
    expect(stock.group).toBe("Hollow Creek");
    expect(stock.source).toBe(LEDGER_COPY.source.inPerson("Hollow Creek"));
    expect(stock.updated).toBe(LEDGER_COPY.lastUpdated("day 0, 06:01"));
    expect(stock.age).toBe(LEDGER_COPY.ago("3 h"));

    const roads = all.filter((e) => e.subject === "ROUTE_CONDITION");
    expect(roads.length).toBe(player.routes.filter((r) => r.condition !== null).length);
    for (const road of roads) {
      const route = player.routes.find((r) => r.name === road.title)!;
      expect(road.group).toBe(LEDGER_COPY.groups.roads);
      expect(road.source).toBe(LEDGER_COPY.source.seenOn(route.name));
    }
    // The truck, last seen at home.
    const truck = all.find((e) => e.subject === "VEHICLE_WHEREABOUTS")!;
    expect(truck.lines).toEqual([LEDGER_COPY.value.parkedAt("Hollow Creek")]);
  });

  it("shows what's on hand and running", () => {
    const { player } = playTo("batch done");
    const stock = entries(player).find((e) => e.subject === "FACILITY_STOCK")!;
    expect(stock.lines.some((l) => typeof l !== "string" && l[1] === "1 case")).toBe(true);
    const ops = entries(player).find((e) => e.subject === "FACILITY_OPERATIONS")!;
    expect(ops.lines[0]).toBe(LEDGER_COPY.value.noBatch);
  });

  it("formats ages and sources", () => {
    expect(formatAge(tick(100), tick(100))).toEqual({ updated: LEDGER_COPY.lastUpdated("day 0, 01:40"), age: LEDGER_COPY.justNow });
    expect(formatAge(tick(360), tick(612)).age).toBe(LEDGER_COPY.ago("4 h 12 min"));
    expect(formatAge(tick(360), tick(360 + 1_440 + 30)).age).toBe(LEDGER_COPY.ago("1 day 30 min"));

    const { player } = playTo("awake");
    const at = (id: string) => id as LocationId;
    const sources: readonly [KnowledgeSource, string | null, string][] = [
      [{ kind: "IN_PERSON", locationId: at("hollow-creek") }, null, LEDGER_COPY.source.inPerson("Hollow Creek")],
      [{ kind: "IN_PERSON", locationId: at("hollow-creek") }, "State Highway", LEDGER_COPY.source.seenOn("State Highway")],
      [{ kind: "CASH_POSTING", transactionId: "txn-1" as never }, null, LEDGER_COPY.source.books],
      [{ kind: "PHONE", partyLocationId: at("kessler-pharmacy") }, null, LEDGER_COPY.source.phone("Kessler's Pharmacy")],
      [{ kind: "MESSAGE", takenAtLocationId: at("crossroads"), takenBy: null }, null, LEDGER_COPY.source.message("The Crossroads", null)],
    ];
    for (const [source, road, text] of sources) expect(formatSource(player, source, road)).toBe(text);
  });
});
