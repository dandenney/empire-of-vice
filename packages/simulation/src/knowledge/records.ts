// Writing `GameState.knowledge` (ADR 0021 decisions 4 and 7): records, pending
// books, pending news and the activity feed. Pure functions; every list keeps
// the order the contract states, so the state hash is stable.

import {
  compareIds,
  compareKnowledgeSubjects,
  type ActivityItem,
  type BooksConcern,
  type GameState,
  type KnowledgeRecord,
  type KnowledgeSource,
  type KnowledgeState,
  type KnowledgeSubject,
  type KnowledgeValue,
  type LocationId,
  type NewsItem,
  type PendingNews,
  type Tick,
} from "@eov/contracts";
import { ACTIVITY_LIMIT, PENDING_NEWS_LIMIT } from "@eov/game-data";
import { sameSubject } from "./view.ts";

export function withKnowledge(state: GameState, change: (k: KnowledgeState) => KnowledgeState): GameState {
  return { ...state, knowledge: change(state.knowledge) };
}

export function findRecord(knowledge: KnowledgeState, subject: KnowledgeSubject): KnowledgeRecord | null {
  return knowledge.records.find((r) => sameSubject(r.subject, subject)) ?? null;
}

/** Whether a pending book's concern is one of `subjects`. */
function concernIn(concern: BooksConcern, subjects: readonly KnowledgeSubject[]): boolean {
  return concern.kind !== "NEWS" && subjects.some((s) => sameSubject(s, concern));
}

/**
 * Learns values (decision 4: one record per subject, the newest wins). The
 * books waiting on any of these subjects become known (decision 7).
 */
export function learn(
  knowledge: KnowledgeState,
  entries: readonly { readonly subject: KnowledgeSubject; readonly value: KnowledgeValue; readonly source: KnowledgeSource }[],
  learnedAt: Tick,
): KnowledgeState {
  if (entries.length === 0) return knowledge;
  const subjects = entries.map((e) => e.subject);
  const kept = knowledge.records.filter((r) => !subjects.some((s) => sameSubject(s, r.subject)));
  const records = [...kept, ...entries.map((e) => ({ subject: e.subject, value: e.value, learnedAt, source: e.source }))].sort((a, b) =>
    compareKnowledgeSubjects(a.subject, b.subject),
  );
  return { ...knowledge, records, pendingBooks: knowledge.pendingBooks.filter((b) => !concernIn(b.concerns, subjects)) };
}

/** Delivers a place's pending news: it leaves `pendingNews`, and the books waiting on that news become known. */
export function takeNews(knowledge: KnowledgeState, locationId: LocationId): { readonly knowledge: KnowledgeState; readonly news: PendingNews | null } {
  const news = knowledge.pendingNews.find((n) => n.locationId === locationId) ?? null;
  return {
    news,
    knowledge: {
      ...knowledge,
      pendingNews: knowledge.pendingNews.filter((n) => n.locationId !== locationId),
      pendingBooks: knowledge.pendingBooks.filter((b) => !(b.concerns.kind === "NEWS" && b.concerns.locationId === locationId)),
    },
  };
}

/** Files a news item at a place, keeping at most PENDING_NEWS_LIMIT (older ones are dropped and counted). */
export function addNews(knowledge: KnowledgeState, locationId: LocationId, item: NewsItem): KnowledgeState {
  const existing = knowledge.pendingNews.find((n) => n.locationId === locationId);
  let items = [...(existing?.items ?? []), item];
  let dropped = existing?.dropped ?? 0;
  if (items.length > PENDING_NEWS_LIMIT) {
    dropped += items.length - PENDING_NEWS_LIMIT;
    items = items.slice(items.length - PENDING_NEWS_LIMIT);
  }
  const pendingNews = [...knowledge.pendingNews.filter((n) => n.locationId !== locationId), { locationId, items, dropped }].sort((a, b) =>
    compareIds(a.locationId, b.locationId),
  );
  return { ...knowledge, pendingNews };
}

/** Adds a book the founder doesn't know about yet (decision 6 rule 3). */
export function addPendingBook(knowledge: KnowledgeState, transactionId: GameState["ledger"]["transactions"][number]["id"], concerns: BooksConcern): KnowledgeState {
  if (knowledge.pendingBooks.some((b) => b.transactionId === transactionId)) return knowledge;
  const pendingBooks = [...knowledge.pendingBooks, { transactionId, concerns }].sort((a, b) => compareIds(a.transactionId, b.transactionId));
  return { ...knowledge, pendingBooks };
}

/** Appends to the activity feed, newest last, keeping the newest ACTIVITY_LIMIT items. */
export function addActivity(knowledge: KnowledgeState, item: ActivityItem): KnowledgeState {
  const activity = [...knowledge.activity, item];
  return { ...knowledge, activity: activity.length > ACTIVITY_LIMIT ? activity.slice(activity.length - ACTIVITY_LIMIT) : activity };
}
