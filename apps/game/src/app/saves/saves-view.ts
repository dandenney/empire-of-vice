// Display helpers for the save/load UI. Formatting only: no game values.

import type { SaveLoadError } from "@eov/contracts";
import type { SaveSummary } from "@eov/persistence";
import { LOAD_ERROR_COPY, SAVES_COPY } from "./copy.ts";
import type { LoadFailure } from "./save-library.ts";

/** The player's one-line reason for a SaveLoadError. */
export function describeLoadError(error: SaveLoadError): string {
  const describe = LOAD_ERROR_COPY[error.code] as (e: SaveLoadError) => string;
  return describe(error);
}

/** The load-error screen's reason, and the technical details under it (the code, then any schema issues or checksums). */
export function describeLoadFailure(failure: LoadFailure): { readonly reason: string; readonly details: readonly string[] } {
  if (failure.kind === "start") return { reason: SAVES_COPY.startFailed(failure.message), details: [] };
  const { error } = failure;
  return { reason: describeLoadError(error), details: [error.code, ...technicalDetails(error)] };
}

/** The raw facts behind an error, for Details: the schema issues, or the two checksums. */
function technicalDetails(error: SaveLoadError): readonly string[] {
  if (error.code === "INVALID") return error.issues;
  if (error.code === "HASH_MISMATCH") return [`expected ${error.expected}`, `actual ${error.actual}`];
  return [];
}

/** A save's name in the list, or a stand-in for a damaged save without one. */
export function saveLabel(summary: Pick<SaveSummary, "meta">): string {
  return summary.meta.label || SAVES_COPY.untitled;
}

const SAVED_AT_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** When a save was made, in the player's locale and time zone (real-world time, not game time). */
export function formatSavedAt(iso: string | undefined, format: Intl.DateTimeFormat = SAVED_AT_FORMAT): string | null {
  if (iso === undefined) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : format.format(date);
}
