// SET_WORKFORCE (T02c2, PROD-001; ADR 0017 decision 8).
//
// Checks, in order:
//   1. INVALID_QUANTITY { field: "workerCount" } for a count that isn't a
//      non-negative safe integer (even at an unknown facility);
//   2. UNKNOWN_ENTITY facility;
//   3. WORKFORCE_LIMIT_EXCEEDED above the facility's game-data maximum;
//   4. while a job runs there, INVALID_QUANTITY { field: "workerCount" } below
//      min(workerCount, crew), so a running job never loses the hands it started
//      with. This stands in for a dedicated "workforce in use" code until a
//      contract task adds one.
//
// A changed count commits an entry-free DAILY_SETTLEMENT transaction keyed
// `DAILY_SETTLEMENT:WORKFORCE:<commandId>` (the stand-in for a workforce kind)
// and emits WORKFORCE_CHANGED. The current count is an applied no-op: no
// transaction, no event, no state change. A running job keeps its `completesAt`
// (ADR 0008); the next job is timed with the new workforce.

import {
  idempotencyKey,
  type FacilityId,
  type GameState,
  type RejectionReason,
  type SetWorkforceCommand,
  type TransactionCoordinator,
} from "@eov/contracts";
import type { GameData } from "@eov/game-data";
import { founderCommandId, type CommandHandler } from "../kernel/registry.ts";
import { M001_RULES, type GameRules } from "../kernel/rules.ts";
import { judgeOrder, type OrderValidator } from "../view/order.ts";
import { presenceRejection } from "../view/presence.ts";
import type { WorldSlice } from "../view/world.ts";
import { crewTerms, facilitySpec } from "./capacity.ts";

/** The first rule SET_WORKFORCE breaks, or null. Never throws. */
function workforceRejection(state: WorldSlice, command: SetWorkforceCommand, data: GameData): RejectionReason | null {
  const { facilityId, workerCount } = command;
  if (!Number.isSafeInteger(workerCount) || workerCount < 0) return { code: "INVALID_QUANTITY", field: "workerCount", value: workerCount };
  const facility = state.facilities.find((f) => f.id === facilityId);
  if (!facility) return { code: "UNKNOWN_ENTITY", kind: "Facility", id: facilityId };
  const maximum = facilitySpec(data, facilityId).maximumWorkers;
  if (workerCount > maximum) return { code: "WORKFORCE_LIMIT_EXCEEDED", facilityId, requested: workerCount, maximum };
  if (state.productionJobs.some((j) => j.facilityId === facilityId)) {
    const floor = Math.min(facility.workerCount, crewTerms(state, data, facilityId).crew);
    if (workerCount < floor) return { code: "INVALID_QUANTITY", field: "workerCount", value: workerCount };
  }
  return null;
}

function withWorkers(state: GameState, facilityId: FacilityId, workerCount: number): GameState {
  return { ...state, facilities: state.facilities.map((f) => (f.id === facilityId ? { ...f, workerCount } : f)) };
}

function countRejection(workerCount: number): RejectionReason | null {
  return Number.isSafeInteger(workerCount) && workerCount >= 0 ? null : { code: "INVALID_QUANTITY", field: "workerCount", value: workerCount };
}

/**
 * SET_WORKFORCE (ADR 0022 decision 3): gate 1 is the count's shape and the
 * facility (owned); the founder must be at the facility and free; then the
 * maximum and the running batch's crew against the facility as seen. A count
 * below the running batch's crew is a check of what's seen there, not of the
 * command's shape, so FOUNDER_BUSY comes first (orchestrator reading 7 on #200).
 */
export function setWorkforceValidator(data: GameData): OrderValidator<"SET_WORKFORCE"> {
  return (view, command) => {
    if (view.founderRules) {
      const { facilityId, workerCount } = command;
      const invalid = countRejection(workerCount);
      if (invalid) return invalid;
      const def = data.facilities.find((f) => f.id === facilityId);
      if (!def || !view.world.facilities.some((f) => f.id === facilityId)) return { code: "UNKNOWN_ENTITY", kind: "Facility", id: facilityId };
      const absent = presenceRejection(view, { locationId: def.locationId, activity: "SET_WORKFORCE", party: false });
      if (absent) return absent;
    }
    return workforceRejection(view.world, command, data);
  };
}

export function setWorkforceHandler(data: GameData, coordinator: TransactionCoordinator, rules: GameRules = M001_RULES): CommandHandler<"SET_WORKFORCE"> {
  const validateOrder = setWorkforceValidator(data);
  return {
    // Dispatch time, for a command queued for a later tick: only the count's shape.
    validate: (_state, command) => countRejection(command.workerCount),
    apply: (state, command, ctx) => {
      const rejection = judgeOrder(validateOrder, state, data, rules, command, ctx.tick);
      if (rejection) return { status: "rejected", reason: rejection };
      const { facilityId } = command;
      const from = state.facilities.find((f) => f.id === facilityId)!.workerCount;
      // `+ 0` turns a -0 into 0, so state only ever holds plain counts.
      const to = command.workerCount + 0;
      if (to === from) return { status: "applied", state };

      const commandId = founderCommandId(ctx);
      const tx = coordinator.begin(state, {
        kind: "DAILY_SETTLEMENT",
        idempotencyKey: idempotencyKey("DAILY_SETTLEMENT", "WORKFORCE", commandId),
        tick: ctx.tick,
        causedBy: ctx.envelope?.id ?? null,
      });
      if (tx.status === "duplicate") return { status: "applied", state };
      tx.update((s) => withWorkers(s, facilityId, to));
      tx.emit({ type: "WORKFORCE_CHANGED", facilityId, from, to });
      const result = tx.commit();
      return result.status === "committed" ? { status: "applied", state: result.state } : { status: "rejected", reason: result.reason };
    },
  };
}
