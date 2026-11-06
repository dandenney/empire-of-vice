// Display formatting only. Nothing here computes a game value (issue #11):
// amounts are formatted with the contract's formatMoney, and reasons are
// listed as the simulation gave them.

import type { GameDate, QualityTier, RejectionReason, SaveLoadError } from "@eov/contracts";
import type { DispatchOutcome } from "../state/gateway-client.ts";
import { COMMON_COPY, QUALITY_COPY, REJECTION_COPY, REJECTION_FIELD_COPY, SAVE_LOAD_ERROR_COPY, type RejectionField } from "./copy.ts";

export function formatQuality(quality: QualityTier): string {
  return QUALITY_COPY[quality];
}

export function describeLoadError(error: SaveLoadError): string {
  return SAVE_LOAD_ERROR_COPY[error.code];
}

export function formatGameDate(date: GameDate): string {
  return COMMON_COPY.gameDate(date);
}

/** "Not enough materials (INSUFFICIENT_MATERIALS, materialId: corn, required: 4, available: 0)". */
export function describeReason(reason: RejectionReason): string {
  const { code, ...details } = reason;
  const fields = Object.entries(details).map(([k, v]) =>
    COMMON_COPY.reasonField(REJECTION_FIELD_COPY[k as RejectionField] ?? k, fieldValue(k, v)),
  );
  return COMMON_COPY.reason(REJECTION_COPY[code], code, fields);
}

/** A reason field's value: quality tiers through their labels, everything else as given. */
function fieldValue(key: string, value: unknown): string {
  if (key === "quality") return QUALITY_COPY[value as QualityTier];
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export function describeOutcome(outcome: DispatchOutcome): string {
  if (outcome.kind === "invalid") return COMMON_COPY.invalid(outcome.issues.join("; "));
  const { result } = outcome;
  switch (result.status) {
    case "applied":
      return COMMON_COPY.applied;
    case "queued":
      return COMMON_COPY.queued(result.scheduledTick);
    case "rejected":
      return COMMON_COPY.rejected(describeReason(result.reason));
  }
}
