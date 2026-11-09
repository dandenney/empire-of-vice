// PLACEHOLDER copy (story decision): the save/load UI's strings (T06a, #135):
// the top bar's game menu, the saves dialog, and the load-error screen.

import type { SaveLoadError } from "@eov/contracts";

export const SAVES_COPY = {
  menuLabel: "Game",
  newGame: "New game",
  newGameStarted: "New game started.",
  save: "Save",
  /** Loads the newest save. */
  continue: "Continue",
  /** Kept as "Save reloaded." for the Sprint Zero spec (tests/e2e). */
  loaded: "Save reloaded.",
  loadedOtherData: (version: string) => `Save reloaded. It was made with game data ${version}; today's prices and rates apply.`,
  saved: (label: string) => `Saved as “${label}”.`,
  openSaves: "Saves…",
  error: (message: string) => `Error: ${message}`,

  dialogTitle: "Saves",
  close: "Close",
  saveAsNew: "Save as a new slot",
  saveNew: "Save",
  noGameToSave: "Start or load a game to save it.",
  listTitle: "Saved games",
  empty: "No saved games yet.",
  savedAt: (when: string) => `Saved ${when}`,
  current: "Current game",
  otherGameData: "Older game data",
  otherGameDataNote: (version: string) => `Made with game data ${version}. It loads with today's prices and rates.`,
  wontLoad: "Won't load",
  untitled: "Untitled save",
  load: "Load",
  remove: "Delete",
  confirmRemove: "Confirm delete",
  cancel: "Keep",
  removed: (label: string) => `Deleted “${label}”.`,
  /** The default name for a save: the game date it was made at. */
  defaultLabel: (date: string) => date,

  errorTitle: "This save won't load",
  errorSave: (label: string) => `“${label}”`,
  errorUnchanged: "Nothing was loaded. The game in progress, if any, carries on as it was.",
  errorBack: "Back",
  errorRemove: "Delete this save",
  errorDetails: "Details",
  startFailed: (message: string) => `The game couldn't start from this save: ${message}`,
} as const;

/** One line per SaveLoadError, for the load-error screen and the saves list. */
export const LOAD_ERROR_COPY: { readonly [C in SaveLoadError["code"]]: (error: Extract<SaveLoadError, { code: C }>) => string } = {
  NOT_A_SAVE: () => "This isn't a saved game, or it's too damaged to read.",
  NEWER_VERSION: (e) => `It was saved by a newer version of the game (save format ${e.saveVersion}; this version reads up to ${e.supportedVersion}).`,
  MISSING_MIGRATION: (e) => `It was saved in an old format (${e.fromVersion}) that this version can't update.`,
  MIGRATION_FAILED: (e) => `Updating it from format ${e.fromVersion} to ${e.toVersion} failed: ${e.message}`,
  INVALID: () => "Its contents don't add up: some of the saved game is missing or wrong.",
  HASH_MISMATCH: () => "It was changed or damaged after it was saved: its checksum doesn't match.",
};
