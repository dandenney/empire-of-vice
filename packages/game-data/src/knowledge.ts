// The knowledge model's tuning tables (ADR 0021 decisions 5–7). Definition types
// per ADR 0012, built from contract primitives. PLACEHOLDER values: the playtests
// (PT1) and the phone and report tasks (ADR 0024, 0025) tune them.
//
// Validated when this module loads, like the scenario file: a bad table throws
// KnowledgeDataError before any game starts.

import {
  compareIds,
  PARTY_KINDS,
  SOURCE_KINDS,
  SUBJECT_KINDS,
  type LocationId,
  type PartyKind,
  type RouteId,
  type SourceKind,
  type SubjectKind,
} from "@eov/contracts";
import { LOCATIONS, type LocationDefinition } from "./map.ts";
import { ROUTES, type RouteDefinition } from "./routes.ts";

export class KnowledgeDataError extends Error {
  override readonly name = "KnowledgeDataError";
}

/**
 * Which subject kinds each source can reveal about a party of each kind
 * (ADR 0021 decision 6). A source never reveals more than its row allows.
 */
export type KnowledgeVisibility = Readonly<Record<SourceKind, Readonly<Record<PartyKind, readonly SubjectKind[]>>>>;

/** The routes whose condition is in a place's live view (ADR 0021 decision 5). */
export interface LiveViewRoutesDefinition {
  readonly locationId: LocationId;
  readonly routeIds: readonly RouteId[];
}

/**
 * Checks the visibility table: every source and party has a row, rows hold known
 * subject kinds without repeats, and every row that reveals BUYER_WANTS also
 * reveals STANDING, because `BUYER_WANTS.willDeal` compares against the
 * world's reputation (ADR 0021 decision 4). Returns the table unchanged.
 */
export function validateKnowledgeVisibility(table: KnowledgeVisibility): KnowledgeVisibility {
  for (const source of SOURCE_KINDS) {
    const rows = table[source] as KnowledgeVisibility[SourceKind] | undefined;
    if (!rows) throw new KnowledgeDataError(`KNOWLEDGE_VISIBILITY has no ${source} row`);
    for (const party of PARTY_KINDS) {
      const subjects = rows[party] as readonly SubjectKind[] | undefined;
      if (!subjects) throw new KnowledgeDataError(`KNOWLEDGE_VISIBILITY.${source} has no ${party} row`);
      for (const subject of subjects) {
        if (!SUBJECT_KINDS.includes(subject)) throw new KnowledgeDataError(`KNOWLEDGE_VISIBILITY.${source}.${party}: unknown subject kind ${subject}`);
      }
      if (new Set(subjects).size !== subjects.length) throw new KnowledgeDataError(`KNOWLEDGE_VISIBILITY.${source}.${party} repeats a subject kind`);
      if (subjects.includes("BUYER_WANTS") && !subjects.includes("STANDING")) {
        throw new KnowledgeDataError(`KNOWLEDGE_VISIBILITY.${source}.${party} reveals BUYER_WANTS without STANDING`);
      }
    }
  }
  return table;
}

/**
 * Checks the live-view routes: one entry per location, in location ID order,
 * listing routes that exist, sorted with `compareIds`, without repeats.
 */
export function validateLiveViewRoutes(
  table: readonly LiveViewRoutesDefinition[],
  locations: readonly LocationDefinition[] = LOCATIONS,
  routes: readonly RouteDefinition[] = ROUTES,
): readonly LiveViewRoutesDefinition[] {
  const expected = locations.map((l) => l.id).sort(compareIds);
  const actual = table.map((e) => e.locationId);
  if (actual.length !== expected.length || actual.some((id, i) => id !== expected[i])) {
    throw new KnowledgeDataError("LIVE_VIEW_ROUTES needs exactly one entry per location, sorted by location ID");
  }
  const routeIds = new Set<string>(routes.map((r) => r.id));
  for (const entry of table) {
    for (const id of entry.routeIds) {
      if (!routeIds.has(id)) throw new KnowledgeDataError(`LIVE_VIEW_ROUTES.${entry.locationId}: unknown route ${id}`);
    }
    const sorted = [...entry.routeIds].sort(compareIds);
    if (new Set(entry.routeIds).size !== entry.routeIds.length || sorted.some((id, i) => id !== entry.routeIds[i])) {
      throw new KnowledgeDataError(`LIVE_VIEW_ROUTES.${entry.locationId}: routes must be unique and sorted by ID`);
    }
  }
  return table;
}

export const KNOWLEDGE_VISIBILITY: KnowledgeVisibility = validateKnowledgeVisibility({
  // Being there: the live view (decision 5). MARKET_PRICES at any buyer or supplier; STANDING anywhere.
  IN_PERSON: {
    FACILITY: ["FACILITY_STOCK", "FACILITY_OPERATIONS", "ROUTE_CONDITION", "VEHICLE_WHEREABOUTS", "STANDING"],
    SUPPLIER: ["SUPPLIER_OFFER", "MARKET_PRICES", "ROUTE_CONDITION", "VEHICLE_WHEREABOUTS", "STANDING"],
    BUYER: [
      "BUYER_WANTS",
      "BUYER_BUDGET",
      "CONTRACT_OFFERS",
      "CONTRACT_PROGRESS",
      "MARKET_PRICES",
      "ROUTE_CONDITION",
      "VEHICLE_WHEREABOUTS",
      "STANDING",
    ],
  },
  // The most any cash posting concerning a party of that kind reveals; the
  // contracts' CASH_POSTING_REVEALS says which, per producer (decision 6).
  CASH_POSTING: {
    FACILITY: ["FACILITY_STOCK", "FACILITY_OPERATIONS", "VEHICLE_WHEREABOUTS"],
    SUPPLIER: [],
    BUYER: ["CONTRACT_PROGRESS", "VEHICLE_WHEREABOUTS"],
  },
  // Decision 6. Not BUYER_BUDGET: Kessler tells you his price, not what's in his safe.
  // Your own facility tells you only what someone there tells you (ADR 0025).
  PHONE: {
    FACILITY: [], // PLACEHOLDER until ADR 0025
    SUPPLIER: ["SUPPLIER_OFFER", "STANDING"], // PLACEHOLDER (ADR 0024 tunes)
    BUYER: ["BUYER_WANTS", "CONTRACT_OFFERS", "CONTRACT_PROGRESS", "STANDING"], // PLACEHOLDER (ADR 0024 tunes)
  },
  // Defined by ADR 0024 (messages) and ADR 0025 (reports). Nothing until then.
  MESSAGE: { FACILITY: [], SUPPLIER: [], BUYER: [] },
  REPORT: { FACILITY: [], SUPPLIER: [], BUYER: [] },
});

/** Default: every route that starts or ends at the place ("people talk" about the roads in and out). PLACEHOLDER. */
export const LIVE_VIEW_ROUTES: readonly LiveViewRoutesDefinition[] = validateLiveViewRoutes(
  [...LOCATIONS]
    .sort((a, b) => compareIds(a.id, b.id))
    .map((location) => ({
      locationId: location.id,
      routeIds: ROUTES.filter((r) => r.fromLocationId === location.id || r.toLocationId === location.id)
        .map((r) => r.id)
        .sort(compareIds),
    })),
);

/** News items kept per place while the founder is away; older ones are dropped and counted (decision 7). PLACEHOLDER. */
export const PENDING_NEWS_LIMIT = 10;

/** Activity items kept in `knowledge.activity`, newest last (decision 7). Not a balance number. PLACEHOLDER. */
export const ACTIVITY_LIMIT = 200;
