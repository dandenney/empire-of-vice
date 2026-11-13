// RELEASE_RESERVATION: the player releases a contract's reservation (ADR 0013
// rule 2). The goods stay in the pool and become available at once. Only
// CONTRACT-held reservations can be released: a job's inputs are committed to
// the still (no job cancellation in M001), so a job-held or missing reservation
// is rejected with RESERVATION_NOT_ACTIVE. The handler judges the reservation
// alone; it doesn't look the contract up. The command names the facility it acts
// at (ADR 0022 decision 3): a reservation held anywhere else is also
// RESERVATION_NOT_ACTIVE.
//
// With founder rules on (ADR 0022 decision 3) the founder must be at that
// facility. Releasing is instant, so it's allowed while busy. The reservation
// must be active in that facility's live view.
//
// Applied as a RESERVATION transaction with no ledger entries (no money moves),
// keyed by the reservation, emitting RESERVATION_RELEASED { reason: "PLAYER" }.

import {
  idempotencyKey,
  type FacilityId,
  type RejectionReason,
  type ReservationId,
  type TransactionCoordinator,
} from "@eov/contracts";
import type { GameData } from "@eov/game-data";
import type { SystemRegistry } from "../kernel/registry.ts";
import { M001_RULES, type GameRules } from "../kernel/rules.ts";
import { judgeOrder, type OrderValidator } from "../view/order.ts";
import { presenceRejection } from "../view/presence.ts";
import type { WorldSlice } from "../view/world.ts";
import { removeReservations } from "./pools.ts";

/** Why the player can't release this reservation at `facilityId`, or null if they can. */
export function releaseRejection(state: Pick<WorldSlice, "reservations">, reservationId: ReservationId, facilityId: FacilityId): RejectionReason | null {
  const reservation = state.reservations.find((r) => r.id === reservationId);
  return reservation?.holder.kind === "CONTRACT" && reservation.facilityId === facilityId ? null : { code: "RESERVATION_NOT_ACTIVE", reservationId };
}

/** Gate 1 with founder rules on: the facility the command names must be one the founder owns. */
function facilityRejection(world: Pick<WorldSlice, "facilities">, facilityId: FacilityId): RejectionReason | null {
  return world.facilities.some((f) => f.id === facilityId) ? null : { code: "UNKNOWN_ENTITY", kind: "Facility", id: facilityId };
}

/**
 * RELEASE_RESERVATION (ADR 0022 decision 3), with founder rules on: the facility
 * (owned), the founder present there (instant, so busy is fine), then the
 * reservation active in that facility's live view.
 */
export function releaseReservationValidator(data: GameData): OrderValidator<"RELEASE_RESERVATION"> {
  return (view, command) => {
    const { reservationId, facilityId } = command;
    if (view.founderRules) {
      const def = data.facilities.find((f) => f.id === facilityId);
      if (!def) return { code: "UNKNOWN_ENTITY", kind: "Facility", id: facilityId };
      const unknown = facilityRejection(view.world, facilityId);
      if (unknown) return unknown;
      const absent = presenceRejection(view, { locationId: def.locationId, activity: null, party: false });
      if (absent) return absent;
    }
    return releaseRejection(view.world, reservationId, facilityId);
  };
}

export function registerInventory(registry: SystemRegistry, data: GameData, coordinator: TransactionCoordinator, rules: GameRules = M001_RULES): void {
  const validateRelease = releaseReservationValidator(data);
  registry.onCommand("RELEASE_RESERVATION", {
    // `validate` runs at dispatch time only, for commands queued for a later
    // tick (ADR 0004); the reservation may be released or consumed before then,
    // so `apply` judges it again against the state of the tick it runs in. With
    // founder rules on, only the facility: a reservation is known only where
    // it's held (ADR 0022 decision 2).
    validate: (state, command) =>
      rules.founderRules ? facilityRejection(state, command.facilityId) : releaseRejection(state, command.reservationId, command.facilityId),
    apply: (state, command, ctx) => {
      const { reservationId } = command;
      // Judged before `begin`: a reservation already released has used this
      // transaction's idempotency key, and releasing it again must be rejected
      // (it isn't active), not treated as a duplicate success.
      const rejection = judgeOrder(validateRelease, state, data, rules, command, ctx.tick);
      if (rejection) return { status: "rejected", reason: rejection };

      const tx = coordinator.begin(state, {
        kind: "RESERVATION",
        idempotencyKey: idempotencyKey("RESERVATION", reservationId, "RELEASE"),
        tick: ctx.tick,
        causedBy: ctx.envelope.id,
      });
      if (tx.status === "duplicate") return { status: "applied", state };

      tx.update((s) => removeReservations(s, [reservationId]));
      tx.emit({ type: "RESERVATION_RELEASED", reservationId, reason: "PLAYER" });

      const result = tx.commit();
      return result.status === "committed" ? { status: "applied", state: result.state } : { status: "rejected", reason: result.reason };
    },
  });
}
