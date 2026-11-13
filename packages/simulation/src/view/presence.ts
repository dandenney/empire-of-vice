// Gate 2, presence (ADR 0022 decisions 1 and 3; ADR 0023 decisions 2, 4 and 6),
// read from the view. The founder's whereabouts, place hours and the founder's
// own place are always known, so these rejections reveal nothing.
//
// In order:
// - NOT_PRESENT: not PRESENT at the place the command acts on. Travelling and
//   riding report `issuerLocationId: null`; resting reports the place of the rest
//   (orchestrator decision on #200); PRESENT elsewhere reports that place.
// - FOUNDER_BUSY: a timed activity is still running (`busy.until ≥ at`). Instant
//   commands at the same place pass.
// - PLACE_CLOSED: an activity with a party (buying, negotiating, accepting) must
//   start during its hours. `opensAt` is the first open tick at or after `at`.
//   Your own facilities never close.
//
// With founder rules off there's no presence gate (ADR 0023 decision 9).

import type { ActivityKind, LocationId, RejectionReason } from "@eov/contracts";
import { isOpenAt, opensAt } from "../founder/time.ts";
import type { IssuerView } from "./issuer-view.ts";

export interface PresenceNeed {
  /** The place the command acts on. */
  readonly locationId: LocationId;
  /** The timed activity it is, or null for an instant command (ADR 0023 decision 4). */
  readonly activity: ActivityKind | null;
  /** Whether it deals with the party there, so the party's hours apply (ADR 0023 decision 6). */
  readonly party: boolean;
}

/** The founder must be PRESENT at `need.locationId`, free for a timed activity, during the party's hours. */
export function presenceRejection(view: IssuerView, need: PresenceNeed): RejectionReason | null {
  if (!view.founderRules) return null;
  const w = view.world.founder.whereabouts;
  if (w.kind !== "PRESENT" || w.locationId !== need.locationId) {
    const issuerLocationId = w.kind === "PRESENT" || w.kind === "RESTING" ? w.locationId : null;
    return { code: "NOT_PRESENT", requiredLocationId: need.locationId, issuerLocationId };
  }
  if (need.activity !== null) {
    const busy = busyRejection(view);
    if (busy) return busy;
  }
  if (need.party && !isOpenAt(need.locationId, view.at)) {
    return { code: "PLACE_CLOSED", locationId: need.locationId, opensAt: opensAt(need.locationId, view.at) };
  }
  return null;
}

/** The busy gate (ADR 0023 decision 2a): busy through `until`, inclusive. */
export function busyRejection(view: IssuerView): RejectionReason | null {
  if (!view.founderRules) return null;
  const w = view.world.founder.whereabouts;
  return w.kind === "PRESENT" && w.busy !== null && w.busy.until >= view.at ? { code: "FOUNDER_BUSY", until: w.busy.until } : null;
}
