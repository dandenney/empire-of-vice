// PLACEHOLDER copy (story decision): the save/load UI's strings (T06a, #135):
// the top bar's game menu, the saves dialog, and the load-error screen.
//
// Exception: every string in this file is approved on #145 (plain, practical
// system wording, not in-world dialogue). Keep them verbatim. The marker above
// stays only because tests/unit/copy/no-literals.test.ts requires it in every
// copy.ts.

import type { SaveLoadError } from "@eov/contracts";

export const SAVES_COPY = {
  menuLabel: "Game",
  newGame: "New game",
  newGameStarted: "New game started.",
  save: "Save",
  /** Loads the newest save. */
  continue: "Continue",
  loaded: "Game loaded.",
  loadedOtherData: (version: string) => `Game loaded. This save used game data ${version}; current game rules and prices apply.`,
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
  otherGameDataNote: (version: string) => `Saved with game data ${version}. Loading uses this version's rules and prices.`,
  wontLoad: "Won't load",
  untitled: "Untitled save",
  load: "Load",
  remove: "Delete",
  confirmRemove: "Confirm delete",
  cancel: "Keep",
  removed: (label: string) => `Deleted “${label}”.`,
  /** A new slot's default name: the in-game date and time it was made at (not the real-world time). */
  defaultLabel: (date: string) => date,

  errorTitle: "This save won't load",
  errorSave: (label: string) => `“${label}”`,
  errorUnchanged: "Nothing was loaded. Your current game is unchanged.",
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
  INVALID: () => "Some of this save's data is missing or invalid.",
  /** The checksums themselves are under Details (saves-view.ts). */
  HASH_MISMATCH: () => "This save appears to have been changed or damaged. Its integrity check failed.",
};
