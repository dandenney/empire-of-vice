// Notify events → toast view models (issue #61). A toast is built once, when
// its event arrives from GatewayClient.onEvents, from that event plus the
// current snapshot (for display names only). The view model is display text
// and a tone; it holds no game state (CLAUDE.md rule 7).

import { EVENT_IMPORTANCE, formatMoney, type EventOfType, type GameEvent, type GameEventType, type GameSnapshot } from "@eov/contracts";
import { formatQuality, describeReason } from "../../components/format.ts";
import { COMMAND_COPY, INSTALLMENT_OUTCOME_COPY, TOAST_COPY, type ToastText } from "./copy.ts";

/**
 * Event types the worker posts immediately: the `notify` ones in EVENT_IMPORTANCE
 * (ADR 0006). Listed by hand because EVENT_IMPORTANCE is typed as a plain Record;
 * tests/unit/ui/toast-view.test.ts checks this list against it.
 */
export type NotifyEventType = Extract<
  GameEventType,
  | "COMMAND_REJECTED"
  | "PRODUCTION_COMPLETED"
  | "PRODUCTION_FAILED"
  | "DELIVERY_DELAYED"
  | "SALE_COMPLETED"
  | "DEAL_FELL_THROUGH"
  | "CARGO_LOST"
  | "SHORTAGE_STARTED"
  | "SHORTAGE_ENDED"
  | "ROUTE_CLOSED"
  | "ROUTE_REOPENED"
  | "CONTRACT_OFFERED"
  | "INSTALLMENT_SETTLED"
  | "CONTRACT_COMPLETED"
  | "TIER_REACHED"
  | "UNLOCK_GRANTED"
  | "VICTORY_ACHIEVED"
  | "GAME_LOST"
>;

/** How a toast is accented. Colour is never the only signal: the title says what happened. */
export type ToastTone = "good" | "bad" | "neutral";

export interface ToastView extends ToastText {
  /** The event's id: unique, and the React key. */
  readonly id: string;
  readonly tone: ToastTone;
  readonly eventType: NotifyEventType;
}

/** The rival closure the #99 strings are written for. */
const RIVAL_ROAD = "county-road";

/** Display names from the snapshot. Falls back to the id if the snapshot doesn't (yet) have the entity. */
class Names {
  constructor(private readonly snapshot: GameSnapshot | null) {}

  facility(id: string): string {
    return this.snapshot?.facilities.find((f) => f.id === id)?.name ?? id;
  }
  route(id: string): string {
    return this.snapshot?.routes.find((r) => r.id === id)?.name ?? id;
  }
  buyer(id: string): string {
    return this.snapshot?.market.buyers.find((b) => b.id === id)?.name ?? id;
  }
  supplier(id: string): string {
    return this.snapshot?.market.suppliers.find((s) => s.id === id)?.name ?? id;
  }
  material(supplierId: string, materialId: string): string {
    const s = this.snapshot;
    const fromSupplier = s?.market.suppliers.find((x) => x.id === supplierId)?.materials.find((m) => m.materialId === materialId)?.materialName;
    return fromSupplier ?? s?.facilities.flatMap((f) => f.materials).find((m) => m.materialId === materialId)?.materialName ?? materialId;
  }
  product(id: string): string {
    const s = this.snapshot;
    return (
      s?.market.products.find((p) => p.productId === id)?.productName ??
      s?.facilities.flatMap((f) => f.products).find((p) => p.productId === id)?.productName ??
      id
    );
  }
  vehicle(id: string): string {
    return this.snapshot?.vehicles.find((v) => v.id === id)?.name ?? id;
  }
  tier(id: string): string {
    return this.snapshot?.progression.tiers.find((t) => t.id === id)?.name ?? id;
  }
  contractBuyer(contractId: string): string {
    const c = this.snapshot?.contracts;
    return [...(c?.active ?? []), ...(c?.closed ?? [])].find((x) => x.id === contractId)?.buyerName ?? contractId;
  }
  offerBuyer(offerId: string, buyerId: string): string {
    return this.snapshot?.contracts.offers.find((o) => o.id === offerId)?.buyerName ?? this.buyer(buyerId);
  }
}

/** Context for one event: the snapshot's names, and the events before it (for the reopening after a rival closure). */
interface Context {
  readonly names: Names;
  /** The most recent ROUTE_CLOSED for a route before this event, from this batch or the snapshot's recent events. */
  lastClosure(routeId: string, before: GameEvent): EventOfType<"ROUTE_CLOSED"> | null;
}

type Mapper<T extends NotifyEventType> = (event: EventOfType<T>, ctx: Context) => { readonly text: ToastText; readonly tone: ToastTone };

const isRivalRoadblock = (e: EventOfType<"ROUTE_CLOSED">) => e.routeId === RIVAL_ROAD && e.reason === "RIVAL";

/** One mapper per notify event type. A Record, so a new notify event without a toast won't compile. */
const MAPPERS: { readonly [T in NotifyEventType]: Mapper<T> } = {
  COMMAND_REJECTED: (e) => ({ tone: "bad", text: TOAST_COPY.commandRejected(COMMAND_COPY[e.commandType], describeReason(e.reason)) }),
  PRODUCTION_COMPLETED: (e, { names }) => ({
    tone: "good",
    text: TOAST_COPY.productionCompleted(e.quantity, names.product(e.productId), formatQuality(e.quality), names.facility(e.facilityId)),
  }),
  PRODUCTION_FAILED: (e, { names }) => ({ tone: "bad", text: TOAST_COPY.productionFailed(names.facility(e.facilityId), formatMoney(e.writtenOff)) }),
  DELIVERY_DELAYED: (e, { names }) => ({ tone: "bad", text: TOAST_COPY.deliveryDelayed(names.route(e.routeId)) }),
  SALE_COMPLETED: (e, { names }) => ({ tone: "good", text: TOAST_COPY.saleCompleted(names.buyer(e.buyerId), formatMoney(e.revenue)) }),
  DEAL_FELL_THROUGH: (e, { names }) => ({ tone: "bad", text: TOAST_COPY.dealFellThrough(names.buyer(e.buyerId)) }),
  CARGO_LOST: (e, { names }) => ({ tone: "bad", text: TOAST_COPY.cargoLost(names.vehicle(e.vehicleId), formatMoney(e.bookValue)) }),
  SHORTAGE_STARTED: (e, { names }) => ({
    tone: "bad",
    text: TOAST_COPY.shortageStarted(names.supplier(e.supplierId), names.material(e.supplierId, e.materialId)),
  }),
  SHORTAGE_ENDED: (e, { names }) => ({
    tone: "good",
    text: TOAST_COPY.shortageEnded(names.supplier(e.supplierId), names.material(e.supplierId, e.materialId)),
  }),
  ROUTE_CLOSED: (e, { names }) => ({ tone: "bad", text: isRivalRoadblock(e) ? TOAST_COPY.rivalRoadblock : TOAST_COPY.routeClosed(names.route(e.routeId)) }),
  ROUTE_REOPENED: (e, ctx) => {
    const closure = ctx.lastClosure(e.routeId, e);
    return { tone: "good", text: closure && isRivalRoadblock(closure) ? TOAST_COPY.rivalRoadblockLifted : TOAST_COPY.routeReopened(ctx.names.route(e.routeId)) };
  },
  CONTRACT_OFFERED: (e, { names }) => ({ tone: "neutral", text: TOAST_COPY.contractOffered(names.offerBuyer(e.contractOfferId, e.buyerId)) }),
  INSTALLMENT_SETTLED: (e, { names }) => ({
    tone: e.outcome === "FULFILLED" ? "good" : "bad",
    text: TOAST_COPY.installmentSettled(names.contractBuyer(e.contractId), e.installmentIndex + 1, INSTALLMENT_OUTCOME_COPY[e.outcome]),
  }),
  CONTRACT_COMPLETED: (e, { names }) => ({ tone: "good", text: TOAST_COPY.contractCompleted(names.contractBuyer(e.contractId)) }),
  TIER_REACHED: (e, { names }) => ({ tone: "good", text: TOAST_COPY.tierReached(names.tier(e.tierId)) }),
  UNLOCK_GRANTED: () => ({ tone: "good", text: TOAST_COPY.unlockGranted }),
  VICTORY_ACHIEVED: () => ({ tone: "good", text: TOAST_COPY.victoryAchieved }),
  GAME_LOST: () => ({ tone: "bad", text: TOAST_COPY.gameLost }),
};

export const NOTIFY_EVENT_TYPES = Object.keys(MAPPERS) as readonly NotifyEventType[];

export function isNotifyEvent(event: GameEvent): event is EventOfType<NotifyEventType> {
  return EVENT_IMPORTANCE[event.type] === "notify" && event.type in MAPPERS;
}

/**
 * The toasts for one delivered batch of events, in order. Log events get none.
 * `snapshot` is the latest one the UI has; it's read for names, never kept.
 */
export function toastsFor(events: readonly GameEvent[], snapshot: GameSnapshot | null): ToastView[] {
  const inBatch = new Set(events.map((e) => e.id));
  // Events cross postMessage as copies, so batch members are matched by id, not identity.
  const recent = (snapshot?.recentEvents ?? []).filter((e) => !inBatch.has(e.id));
  const ctx: Context = {
    names: new Names(snapshot),
    lastClosure: (routeId, before) => {
      const index = events.indexOf(before);
      const earlier = [...recent.filter((e) => e.tick <= before.tick), ...events.slice(0, Math.max(index, 0))];
      for (let i = earlier.length - 1; i >= 0; i--) {
        const e = earlier[i]!;
        if (e.type === "ROUTE_CLOSED" && e.routeId === routeId) return e;
      }
      return null;
    },
  };
  return events.filter(isNotifyEvent).map((event) => {
    const map = MAPPERS[event.type] as Mapper<NotifyEventType>;
    const { text, tone } = map(event as never, ctx);
    return { id: event.id, eventType: event.type, tone, title: text.title, body: text.body };
  });
}
