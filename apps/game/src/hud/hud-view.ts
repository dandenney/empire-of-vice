// The HUD's view model (SK2b, #234): the founder's status in words, from
// always-known state only (ADR 0021 decision 3, ADR 0023 decision 1).

import type { PlayerSnapshot } from "@eov/contracts";
import { formatDayTime } from "../ui/format/time-format.ts";
import { HUD_COPY as C } from "./copy.ts";

export interface FounderStatusView {
  /** PRESENT, BUSY, TRAVELLING, ON_DELIVERY or RESTING. */
  readonly kind: PlayerSnapshot["founder"]["whereabouts"]["kind"] | "BUSY";
  /** "At Hollow Creek", "Travelling to Miller's Feed & Seed"… */
  readonly headline: string;
  /** "Free to act", "Buying until day 0, 09:32"… */
  readonly detail: string;
  /** Travelling: how far along the current leg, 0–100; null otherwise. */
  readonly progressPercent: number | null;
  readonly tired: boolean;
}

export function founderStatus(player: PlayerSnapshot): FounderStatusView {
  const placeName = (id: string): string => player.places.find((p) => p.id === id)?.name ?? C.unknownPlace;
  const roadName = (id: string): string => player.routes.find((r) => r.id === id)?.name ?? C.unknownPlace;
  const w = player.founder.whereabouts;
  const tired = player.founder.tired;
  switch (w.kind) {
    case "PRESENT":
      return w.busy === null
        ? { kind: "PRESENT", headline: C.whereabouts.PRESENT(placeName(w.locationId)), detail: C.detail.free, progressPercent: null, tired }
        : {
            kind: "BUSY",
            headline: C.whereabouts.BUSY(placeName(w.locationId)),
            detail: C.detail.busy(C.activity[w.busy.activity], formatDayTime(w.busy.until)),
            progressPercent: null,
            tired,
          };
    case "TRAVELLING": {
      const leg = w.path[w.legIndex];
      return {
        kind: "TRAVELLING",
        headline: C.whereabouts.TRAVELLING(placeName(w.destinationLocationId)),
        detail: C.detail.travelling(w.transport.kind === "FOOT", leg ? roadName(leg.routeId) : C.unknownPlace, w.legIndex + 1, w.path.length, formatDayTime(w.legArrivesAt)),
        progressPercent: player.founder.currentLeg ? Math.floor(player.founder.currentLeg.progressPpm / 10_000) : null,
        tired,
      };
    }
    case "ON_DELIVERY":
      return {
        kind: "ON_DELIVERY",
        headline: C.whereabouts.ON_DELIVERY(),
        detail: w.atStop === null ? C.detail.riding : C.detail.atStop(placeName(w.atStop.locationId)),
        progressPercent: null,
        tired,
      };
    case "RESTING":
      return { kind: "RESTING", headline: C.whereabouts.RESTING(placeName(w.locationId)), detail: C.detail.resting(formatDayTime(w.until)), progressPercent: null, tired };
  }
}
