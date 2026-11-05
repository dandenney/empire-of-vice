// PLACEHOLDER copy (story decision): every player-facing string in the shell
// and shared components. The real wording, names, and tone are the human's
// call (#48). Panels keep their own strings in their own copy.ts.

import type { RejectionCode } from "@eov/contracts";
import type { SpeedMultiplier } from "@eov/game-data";

export const SHELL_COPY = {
  title: "Empire of Vice",
  placeholderNotice: "Placeholder UI: visual direction pending",
  noGame: "No game is running. Start a new game, or reload a save.",
  newGame: "New game",
  save: "Save",
  reloadSave: "Reload save",
  newGameStarted: "New game started.",
  saved: "Saved.",
  saveReloaded: "Save reloaded.",
  reloadFailed: (code: string) => `Reload failed: ${code}`,
  error: (message: string) => `Error: ${message}`,
  fault: (message: string) => `The game paused itself after an error: ${message}`,
  panelNav: "Panels",
  mapLabel: "Placeholder map",
} as const;

export const SPEED_COPY = {
  groupLabel: "Game speed",
  pause: "Pause",
  speed: (multiplier: SpeedMultiplier) => `${multiplier}×`,
  paused: "Paused",
  running: (multiplier: SpeedMultiplier) => `Running at ${multiplier}×`,
  autoPaused: "Auto-paused while the tab was hidden. Pick a speed to resume.",
} as const;

export const COMMON_COPY = {
  none: "—",
  pending: "Working…",
  applied: "Done.",
  queued: (tick: number) => `Queued for tick ${tick}.`,
  rejected: (reason: string) => `Rejected: ${reason}`,
  invalid: (issues: string) => `Invalid request: ${issues}`,
  comingSoon: (title: string) => `${title}: coming in T04c.`,
  tick: (tick: number) => `tick ${tick}`,
} as const;

/** One line per rejection code. The reason's fields are listed after it. */
export const REJECTION_COPY: Readonly<Record<RejectionCode, string>> = {
  INVALID_QUANTITY: "Invalid quantity",
  SCHEDULED_IN_PAST: "Scheduled in the past",
  UNKNOWN_ENTITY: "Unknown",
  LOCKED: "Not unlocked yet",
  REPUTATION_TOO_LOW: "Reputation too low",
  INSUFFICIENT_FUNDS: "Not enough cash",
  SUPPLIER_STOCK_LOW: "Supplier doesn't have enough",
  MATERIAL_NOT_SOLD: "Supplier doesn't sell that",
  INSUFFICIENT_MATERIALS: "Not enough materials",
  RECIPE_NOT_SUPPORTED: "This facility can't make that",
  PRODUCTION_CAPACITY_EXCEEDED: "Not enough production capacity",
  STORAGE_CAPACITY_EXCEEDED: "Not enough storage",
  WORKFORCE_LIMIT_EXCEEDED: "Too many workers",
  NO_EQUIPMENT_SLOT: "No free equipment slot",
  EQUIPMENT_ALREADY_OWNED: "Already owned",
  INSUFFICIENT_STOCK: "Not enough stock",
  RESERVATION_NOT_ACTIVE: "Reservation isn't active",
  VEHICLE_UNAVAILABLE: "Truck unavailable",
  VEHICLE_CAPACITY_EXCEEDED: "Too much for the truck",
  NO_ROUTE: "No route",
  ROUTE_CLOSED: "Route closed",
  QUOTE_CHANGED: "The price changed",
  BUYER_WILL_TAKE_LESS: "Buyer will take less",
  PRODUCT_NOT_WANTED: "Buyer doesn't want that",
  OFFER_UNAVAILABLE: "Offer no longer available",
  CONTRACT_NOT_ACTIVE: "Contract isn't active",
  CARGO_DOES_NOT_MATCH_CONTRACT: "Cargo doesn't match the contract",
  NOT_REPEATABLE: "Can't repeat that",
};
