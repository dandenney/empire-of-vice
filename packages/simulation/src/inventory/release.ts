// RELEASE_RESERVATION: the player releases a contract's reservation (ADR 0013
// rule 2). The goods stay in the pool and become available at once. Only
// CONTRACT-held reservations can be released: a job's inputs are committed to
// the still (no job cancellation in M001), so a job-held or missing reservation
// is rejected with RESERVATION_NOT_ACTIVE. The handler judges the reservation
// alone; it doesn't look the contract up. The command names the facility it acts
// at (ADR 0022 decision 3): a reservation held anywhere else is also
// RESERVATION_NOT_ACTIVE.
//
// Applied as a RESERVATION transaction with no ledger entries (no money moves),
// keyed by the reservation, emitting RESERVATION_RELEASED { reason: "PLAYER" }.

import {
  idempotencyKey,
  type FacilityId,
  type GameState,
  type RejectionReason,
  type ReservationId,
  type TransactionCoordinator,
} from "@eov/contracts";
import type { GameData } from "@eov/game-data";
import type { SystemRegistry } from "../kernel/registry.ts";
import { removeReservations } from "./pools.ts";

/** Why the player can't release this reservation (at `facilityId`, when given), or null if they can. */
export function releaseRejection(state: GameState, reservationId: ReservationId, facilityId: FacilityId | null = null): RejectionReason | null {
  const reservation = state.reservations.find((r) => r.id === reservationId);
  const here = facilityId === null || reservation?.facilityId === facilityId;
  return reservation?.holder.kind === "CONTRACT" && here ? null : { code: "RESERVATION_NOT_ACTIVE", reservationId };
}

export function registerInventory(registry: SystemRegistry, _data: GameData, coordinator: TransactionCoordinator): void {
  registry.onCommand("RELEASE_RESERVATION", {
    // `validate` runs at dispatch time only, for commands queued for a later
    // tick (ADR 0004); the reservation may be released or consumed before then,
    // so `apply` judges it again against the state of the tick it runs in.
    validate: (state, command) => releaseRejection(state, command.reservationId, command.facilityId),
    apply: (state, command, ctx) => {
      const { reservationId, facilityId } = command;
      // Judged before `begin`: a reservation already released has used this
      // transaction's idempotency key, and releasing it again must be rejected
      // (it isn't active), not treated as a duplicate success.
      const rejection = releaseRejection(state, reservationId, facilityId);
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
