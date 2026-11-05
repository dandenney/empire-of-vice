// Display formatting only. Nothing here computes a game value (issue #11):
// amounts are formatted with the contract's formatMoney, and reasons are
// listed as the simulation gave them.

import type { GameDate, RejectionReason } from "@eov/contracts";
import type { DispatchOutcome } from "../state/gateway-client.ts";
import { COMMON_COPY, REJECTION_COPY } from "./copy.ts";

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** YYYY-MM-DD HH:MM. */
export function formatGameDate(date: GameDate): string {
  return `${date.year}-${pad2(date.month)}-${pad2(date.day)} ${pad2(date.hour)}:${pad2(date.minute)}`;
}

/** "Not enough materials (INSUFFICIENT_MATERIALS, materialId: corn, required: 4, available: 0)". */
export function describeReason(reason: RejectionReason): string {
  const { code, ...details } = reason;
  const fields = Object.entries(details).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  return `${REJECTION_COPY[code]} (${[code, ...fields].join(", ")})`;
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
