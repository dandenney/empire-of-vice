// The ledger's view model (SK2b, #234; GDD §17 "The ledger view"): one entry
// per knowledge record in the player snapshot, with its value, its age ("last
// updated …") and its source. Built from the player snapshot alone (ADR 0021
// decision 8): a record the founder doesn't have isn't listed. Names come from
// the snapshot or static game-data; raw simulation IDs are never shown.
//
// Road records read "seen on <road>" (decided on #174): a travelled road's
// record is stamped at the road's start whatever the direction, so naming the
// place would mislead.

import type { KnowledgeSource, Known, LocationId, PlayerSnapshot, SubjectKind, Tick } from "@eov/contracts";
import { CHARACTERS, PROGRESSION } from "@eov/game-data";
import { formatQuality } from "../components/format.ts";
import { formatDayTime, formatSpan } from "../ui/format/time-format.ts";
import { LEDGER_COPY as C } from "./copy.ts";

export type LedgerLine = readonly [label: string, value: string] | string;

export interface LedgerEntryView {
  /** Stable key: the subject kind and its key. */
  readonly key: string;
  readonly subject: SubjectKind;
  /** The subject's heading ("On hand", "Condition"…). */
  readonly title: string;
  readonly lines: readonly LedgerLine[];
  readonly learnedAt: Tick;
  /** "last updated day 0, 09:01". */
  readonly updated: string;
  /** "4 h 12 min ago", or "just now". */
  readonly age: string;
  /** "in person at Miller's Feed & Seed", "seen on State Highway"… */
  readonly source: string;
}

export interface LedgerGroupView {
  readonly key: string;
  /** A place's, road's or the truck's name, or a group heading. */
  readonly title: string;
  readonly entries: readonly LedgerEntryView[];
}

/** "last updated …" and the age, from the record's tick and now. */
export function formatAge(learnedAt: Tick, now: Tick): { readonly updated: string; readonly age: string } {
  const span = now - learnedAt;
  return { updated: C.lastUpdated(formatDayTime(learnedAt)), age: span <= 0 ? C.justNow : C.ago(formatSpan(span)) };
}

/** How a record was learned, in words. `roadName` is set for road records, which read "seen on <road>". */
export function formatSource(player: PlayerSnapshot, source: KnowledgeSource, roadName: string | null): string {
  const placeName = (id: LocationId) => player.places.find((p) => p.id === id)?.name ?? C.value.unknownPlace;
  const characterName = (id: string) => CHARACTERS.find((c) => c.id === id)?.name ?? C.value.unknownPlace;
  switch (source.kind) {
    case "IN_PERSON":
      return roadName !== null ? C.source.seenOn(roadName) : C.source.inPerson(placeName(source.locationId));
    case "CASH_POSTING":
      return C.source.books;
    case "PHONE":
      return C.source.phone(placeName(source.partyLocationId));
    case "MESSAGE":
      return C.source.message(placeName(source.takenAtLocationId), source.takenBy === null ? null : characterName(source.takenBy));
    case "REPORT":
      return C.source.report(characterName(source.characterId));
  }
}

function entry<T>(
  player: PlayerSnapshot,
  subject: SubjectKind,
  key: string,
  known: Known<T>,
  lines: (value: T) => readonly LedgerLine[],
  roadName: string | null = null,
): LedgerEntryView | null {
  if (known === null) return null;
  return {
    key: `${subject}:${key}`,
    subject,
    title: C.subjects[subject],
    lines: lines(known.value),
    learnedAt: known.learnedAt,
    ...formatAge(known.learnedAt, player.clock.tick),
    source: formatSource(player, known.source, roadName),
  };
}

const present = <T>(xs: readonly (T | null)[]): T[] => xs.filter((x): x is T => x !== null);

/** Every knowledge record, grouped: each place's, then roads, the truck, contracts, the market and standing. */
export function ledgerGroups(player: PlayerSnapshot): readonly LedgerGroupView[] {
  const placeName = (id: LocationId | null) => (id === null ? C.value.unknownPlace : (player.places.find((p) => p.id === id)?.name ?? C.value.unknownPlace));
  const roadName = (id: string) => player.routes.find((r) => r.id === id)?.name ?? C.value.unknownPlace;
  const groups: LedgerGroupView[] = [];

  for (const place of player.places) {
    let entries: (LedgerEntryView | null)[] = [];
    if (place.kind === "FACILITY") {
      const f = place.facility;
      entries = [
        entry(player, "FACILITY_STOCK", f.id, f.stock, (v) => {
          const lines: LedgerLine[] = [
            ...v.materials.filter((m) => m.quantity > 0).map((m) => C.value.material(m.materialName, m.quantity)),
            ...v.products.filter((p) => p.quantity > 0).map((p) => C.value.product(p.productName, formatQuality(p.quality), p.quantity, p.reservedQuantity)),
          ];
          return [...(lines.length === 0 ? [C.value.nothingOnHand] : lines), C.value.storage(v.storageUsed, f.storageCapacity)];
        }),
        entry(player, "FACILITY_OPERATIONS", f.id, f.operations, (v) => [
          ...(v.jobs.length === 0
            ? [C.value.noBatch]
            : v.jobs.map((j) => C.value.batch(j.quantity, f.recipes.find((r) => r.recipeId === j.recipeId)?.name ?? j.productId, formatDayTime(j.completesAt)))),
          C.value.workers(v.workersPresent),
        ]),
      ];
    } else if (place.kind === "SUPPLIER") {
      entries = [
        entry(player, "SUPPLIER_OFFER", place.supplier.id, place.supplier.offer, (v) =>
          v.materials.map((m) => C.value.forSale(m.materialName, m.unitPrice, m.available, m.shortage)),
        ),
      ];
    } else if (place.kind === "BUYER") {
      const b = place.buyer;
      entries = [
        entry(player, "BUYER_WANTS", b.id, b.wants, (v) =>
          !v.willDeal
            ? [C.value.wontDeal]
            : v.wants.length === 0
              ? [C.value.wantsNothing]
              : v.wants.map((w) => C.value.want(w.productName, formatQuality(w.minimumQuality), w.unitPrice, w.demandRemaining)),
        ),
        entry(player, "BUYER_BUDGET", b.id, b.budget, (v) => [C.value.budget(v.budgetRemaining)]),
        entry(player, "CONTRACT_OFFERS", b.id, b.offers, (v) => [C.value.offers(v.offers.length)]),
      ];
    }
    const known = present(entries);
    if (known.length > 0) groups.push({ key: `place:${place.id}`, title: place.name, entries: known });
  }

  // Roads: one group, each entry headed by the road's name.
  const roads = present(
    player.routes.map((r) => {
      const e = entry(player, "ROUTE_CONDITION", r.id, r.condition, (v) => [
        v.status.open ? C.value.roadOpen : C.value.roadClosed(C.value.closedBecause[v.status.reason], v.status.reopensAt === null ? null : formatDayTime(v.status.reopensAt)),
      ], r.name);
      return e && { ...e, title: r.name };
    }),
  );
  if (roads.length > 0) groups.push({ key: "roads", title: C.groups.roads, entries: roads });

  const vehicles = present(player.vehicles.map((v) => entry(player, "VEHICLE_WHEREABOUTS", v.id, v.whereabouts, (w) => [
    w.parkedAt !== null
      ? C.value.parkedAt(placeName(w.parkedAt))
      : w.trip !== null
        ? C.value.onTheRoad(roadName(w.trip.routeId), w.trip.leg, formatDayTime(w.trip.arrivesAt))
        : C.value.unknownPlace,
  ])));
  if (vehicles.length > 0) groups.push({ key: "vehicles", title: C.groups.vehicles, entries: vehicles });

  const contracts = present(player.contracts.map((c) => entry(player, "CONTRACT_PROGRESS", c.id, c.progress, (v) => [C.value.contractStatus(v.status)])));
  if (contracts.length > 0) groups.push({ key: "contracts", title: C.groups.contracts, entries: contracts });

  // Employees (EM1): each one's known work, headed by their name.
  const people = present(
    player.employees.map((emp) => {
      const e = entry(player, "EMPLOYEE_PERFORMANCE", emp.characterId, emp.performance, (v) => [C.value.batchesRun(v.batchesRun), C.value.competence(v.competence)]);
      return e && { ...e, title: emp.name };
    }),
  );
  if (people.length > 0) groups.push({ key: "employees", title: C.groups.employees, entries: people });

  const market = entry(player, "MARKET_PRICES", "", player.market, (v) => v.products.map((p) => C.value.price(p.productName, formatQuality(p.quality), p.spotPrice)));
  if (market) groups.push({ key: "market", title: C.groups.market, entries: [market] });

  const standing = entry(player, "STANDING", "", player.standing, (v) => [
    C.value.reputation(v.reputation),
    C.value.tier(PROGRESSION.tiers.find((t) => t.id === v.tierId)?.name ?? v.tierId),
  ]);
  if (standing) groups.push({ key: "standing", title: C.groups.standing, entries: [standing] });

  return groups;
}

/** How many records the founder has: one ledger entry each. */
export function ledgerEntryCount(groups: readonly LedgerGroupView[]): number {
  return groups.reduce((n, g) => n + g.entries.length, 0);
}
