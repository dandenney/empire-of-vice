// The knowledge behaviour (ADR 0021 decisions 5–8; ADR 0023 decisions 2, 2a, 6).
// Runs only with founder rules on; with them off nothing here is registered and
// `GameState.knowledge` never changes (the world is the live view instead).
//
// - Persisting the live view: at the end of every tick (SIM-001 step 6), and on
//   every end of presence (`departing`: TRAVEL, REST, the truck setting out).
// - The arrival catch-up (`arrived`, `woke`): diffs of the place's live view
//   against what was known, its pending news, one KNOWLEDGE_CAUGHT_UP event, and
//   `lastCatchUp`. A departure clears `lastCatchUp`.
// - At the end of every tick, in order: news (place-tagged events the founder
//   didn't see), the books (decision 6 rules 1–4 per transaction of the tick,
//   with cash postings as a channel), then the persist.
// - The founder's own commands go into the activity feed as they apply, queue,
//   or fail when their tick arrives.

import {
  CASH_POSTING_REVEALS,
  EVENT_CONCERNS_PLACE,
  type ActivityItem,
  type CatchUp,
  type CatchUpLine,
  type CommandEnvelope,
  type GameEvent,
  type GameState,
  type KnowledgeSubject,
  type LocationId,
  type NewsItem,
  type PlaceTaggedEventType,
  type RouteId,
  type Tick,
} from "@eov/contracts";
import { KNOWLEDGE_VISIBILITY, type GameData } from "@eov/game-data";
import { emitEvent } from "../events/journal.ts";
import type { Arrival, Departure } from "../founder/hooks.ts";
import { canonicalJson } from "../kernel/hash.ts";
import type { CommandFate } from "../kernel/registry.ts";
import { cashMovement } from "../projection/finance.ts";
import { cashPostingCause, classify } from "./books.ts";
import { addActivity, addNews, addPendingBook, findRecord, learn, takeNews, withKnowledge } from "./records.ts";
import { facilityLocation, liveEntries, liveSubjects, liveView, observation, worldValue } from "./view.ts";

/** Persists the live view at `t` into the records (decision 5). */
export function persistLiveView(state: GameState, data: GameData, t: Tick): GameState {
  const entries = liveView(state, data, t, false);
  return withKnowledge(state, (k) => learn(k, entries, t));
}

/** The founder is about to leave (still present): persist what they see now, and clear the last catch-up. */
export function departing(state: GameState, data: GameData, _locationId: LocationId, _why: Departure, t: Tick): GameState {
  const s = persistLiveView(state, data, t);
  return withKnowledge(s, (k) => ({ ...k, lastCatchUp: null }));
}

/**
 * The arrival catch-up (decision 7) at the place the founder now observes:
 * structured lines for every live subject whose value changed since it was
 * known, the place's pending news, one KNOWLEDGE_CAUGHT_UP event, and
 * `lastCatchUp`. Then the live view is persisted, which also clears the books
 * waiting on it.
 */
export function catchUp(state: GameState, data: GameData, locationId: LocationId, t: Tick): GameState {
  const obs = observation(state, t);
  const subjects = liveSubjects(state, data, obs, t);
  const lines: CatchUpLine[] = [];
  let sinceTick: Tick | null = null;
  for (const subject of subjects) {
    const known = findRecord(state.knowledge, subject);
    if (known && (sinceTick === null || known.learnedAt < sinceTick)) sinceTick = known.learnedAt;
    const after = worldValue(state, data, subject);
    if (known === null || canonicalJson(known.value) !== canonicalJson(after)) lines.push({ subject, before: known?.value ?? null, after });
  }
  const taken = takeNews(state.knowledge, locationId);
  const summary: CatchUp = {
    locationId,
    tick: t,
    sinceTick,
    lines,
    news: taken.news?.items ?? [],
    droppedNews: taken.news?.dropped ?? 0,
  };
  let s: GameState = { ...state, knowledge: taken.knowledge };
  s = emitEvent(
    s,
    { type: "KNOWLEDGE_CAUGHT_UP", locationId, sinceTick, lines: summary.lines, news: summary.news, droppedNews: summary.droppedNews },
    { tick: t, causedBy: null },
  ).state;
  s = withKnowledge(s, (k) => addActivity({ ...k, lastCatchUp: summary }, { kind: "CATCH_UP", tick: t, locationId, sinceTick }));
  return persistLiveView(s, data, t);
}

/** Every arrival (ADR 0023 decision 2a). A halt also records the closed route as seen there (decision 3). */
export function arrived(state: GameState, data: GameData, locationId: LocationId, how: Arrival, t: Tick): GameState {
  const s = catchUp(state, data, locationId, t);
  return how.kind === "HALTED" ? sawRoute(s, data, locationId, how.routeId, t) : s;
}

/**
 * The founder, standing at `locationId`, sees a route's condition whatever
 * LIVE_VIEW_ROUTES says: a halt at a closure (ADR 0023 decision 3), or a truck
 * that can't set out at departure (ADR 0023 decision 2a). Recorded IN_PERSON.
 */
export function sawRoute(state: GameState, data: GameData, locationId: LocationId, routeId: RouteId, t: Tick): GameState {
  const subject: KnowledgeSubject = { kind: "ROUTE_CONDITION", routeId };
  return withKnowledge(state, (k) => learn(k, [{ subject, value: worldValue(state, data, subject), source: { kind: "IN_PERSON", locationId } }], t));
}

/** Waking counts as an arrival (ADR 0023 decision 2). */
export function woke(state: GameState, data: GameData, locationId: LocationId, _early: boolean, t: Tick): GameState {
  return catchUp(state, data, locationId, t);
}

// ---------------------------------------------------------------------------
// The end of a tick
// ---------------------------------------------------------------------------

/** The place a tagged event concerns (EVENT_CONCERNS_PLACE), and the delivery it's about, if any. */
function newsPlace(state: GameState, data: GameData, event: GameEvent): { readonly locationId: LocationId; readonly deliveryId: string | null } | null {
  const tag = EVENT_CONCERNS_PLACE[event.type];
  if (tag === null) return null;
  if (tag === "FACILITY") {
    if (!("facilityId" in event)) throw new RangeError(`${event.type} is tagged FACILITY but has no facilityId`);
    return { locationId: facilityLocation(data, event.facilityId), deliveryId: null };
  }
  if (!("deliveryId" in event)) throw new RangeError(`${event.type} is tagged DELIVERY_ORIGIN but has no deliveryId`);
  const delivery = state.deliveries.find((d) => d.id === event.deliveryId);
  if (!delivery) throw new RangeError(`${event.type} names unknown delivery ${event.deliveryId}`);
  return { locationId: facilityLocation(data, delivery.fromFacilityId), deliveryId: delivery.id };
}

function newsItem(event: GameEvent): NewsItem {
  const tagged = event as Extract<GameEvent, { type: PlaceTaggedEventType }>;
  const payload: Record<string, unknown> = { ...tagged };
  delete payload["id"];
  delete payload["tick"];
  delete payload["causedBy"];
  return { tick: tagged.tick, event: payload as unknown as NewsItem["event"] };
}

/** The entries of a tick-ordered list that fall on tick `t`, in order. */
function tail<T extends { readonly tick: Tick }>(list: readonly T[], t: Tick): readonly T[] {
  let start = list.length;
  while (start > 0 && list[start - 1]!.tick >= t) start--;
  return list.slice(start).filter((x) => x.tick === t);
}

/**
 * SIM-001 step 6 (decision 5): this tick's news and books, then the persist.
 * `state.tick` is still the previous tick; `t` is the tick being completed.
 */
export function tickEnd(state: GameState, data: GameData, t: Tick): GameState {
  const obs = observation(state, t);
  const observed = { subjects: liveSubjects(state, data, obs, t), locationId: obs.locationId };
  // The journal and the ledger are in tick order, so this tick's are at their ends.
  const events = tail(state.eventJournal, t);
  const transactions = tail(state.ledger.transactions, t);
  const byId = new Map<string, GameEvent>(events.map((e) => [e.id, e]));
  let s = state;

  // News (decision 7): a place-tagged event the founder didn't see waits at its place.
  for (const event of events) {
    const place = newsPlace(s, data, event);
    if (place === null) continue;
    const seen = place.locationId === obs.locationId || (place.deliveryId !== null && obs.stop?.id === place.deliveryId);
    if (!seen) s = withKnowledge(s, (k) => addNews(k, place.locationId, newsItem(event)));
  }

  // The books (decision 6), in ledger order.
  for (const transaction of transactions) {
    const verdict = classify(s, data, transaction, observed, byId);
    if (verdict.kind === "PENDING") {
      s = withKnowledge(s, (k) => addPendingBook(k, transaction.id, verdict.concerns));
    } else if (verdict.kind === "CASH_POSTING") {
      s = cashPosting(s, data, transaction, verdict.producer as keyof typeof CASH_POSTING_REVEALS, byId, t);
    }
  }

  return withKnowledge(s, (k) => learn(k, liveEntries(s, data, obs, observed.subjects), t));
}

/** A cash posting away from the founder: known, and a channel for its cause (decision 6). */
function cashPosting(
  state: GameState,
  data: GameData,
  transaction: GameState["ledger"]["transactions"][number],
  producer: keyof typeof CASH_POSTING_REVEALS,
  events: ReadonlyMap<string, GameEvent>,
  t: Tick,
): GameState {
  const reveal = CASH_POSTING_REVEALS[producer];
  const cause = cashPostingCause(state, data, transaction, producer, events);
  const allowed = new Set<string>(reveal.subjects);
  const visible = new Set<string>(cause.party === null ? [] : KNOWLEDGE_VISIBILITY.CASH_POSTING[cause.party]);
  const subjects = cause.subjects.filter((s) => allowed.has(s.kind) && visible.has(s.kind));
  const source = { kind: "CASH_POSTING" as const, transactionId: transaction.id };
  let knowledge = learn(
    state.knowledge,
    subjects.map((subject) => ({ subject, value: worldValue(state, data, subject), source })),
    t,
  );
  let news: readonly NewsItem[] = [];
  if (reveal.news === "PENDING_AT_PLACE" && cause.newsAt !== null) {
    const taken = takeNews(knowledge, cause.newsAt);
    knowledge = taken.knowledge;
    news = taken.news?.items ?? [];
  }
  const item: ActivityItem = { kind: "CASH_POSTING", tick: t, producer, cashChange: cashMovement(transaction), revealed: subjects, news };
  return { ...state, knowledge: addActivity(knowledge, item) };
}

// ---------------------------------------------------------------------------
// The founder's commands (decision 8: activity)
// ---------------------------------------------------------------------------

/** One of the founder's own commands applied, queued, or failed when its tick arrived. Employees' aren't the founder's (ADR 0025). */
export function commandRecorded(state: GameState, envelope: CommandEnvelope, fate: CommandFate, t: Tick): GameState {
  if (envelope.issuer.kind !== "FOUNDER") return state;
  const item: ActivityItem = {
    kind: "COMMAND",
    tick: t,
    command: envelope.command,
    status: fate.status,
    reason: fate.status === "REJECTED" ? fate.reason : null,
  };
  return withKnowledge(state, (k) => addActivity(k, item));
}
