// PLACEHOLDER copy (story decision): toast wording for every `notify` event
// (EVENT_IMPORTANCE, ADR 0006), and the toast host's labels.
//
// Exception: the strings marked "Approved on #99" are the user's signed-off
// wording (#99, routed to this task on #14). Keep them verbatim.

import type { GameCommandType, InstallmentOutcome } from "@eov/contracts";

export const TOAST_HOST_COPY = {
  /** The toast region's accessible name. */
  region: "Notifications",
  dismiss: (title: string) => `Dismiss: ${title}`,
} as const;

/** A toast's text: a short title and one line of detail. */
export interface ToastText {
  readonly title: string;
  readonly body: string;
}

export const TOAST_COPY = {
  // Approved on #99: TIER_REACHED.
  tierReached: (tierName: string): ToastText => ({ title: "Standing", body: `New standing: ${tierName}.` }),
  // Approved on #99: the rival closure of the County Road, title and notification.
  rivalRoadblock: {
    title: "Dwyer's Roadblock",
    body: "Word from Kessler's: Dwyer's boys have blocked the County Road. Find another way in, or wait them out.",
  } satisfies ToastText,
  // Approved on #99: the reopening that follows the rival closure (body). The title is a placeholder.
  rivalRoadblockLifted: {
    title: "Road clear",
    body: "The County Road is clear again. Dwyer's boys have moved on.",
  } satisfies ToastText,

  // Approved on #99: the EQUIPMENT_SOLD notification (body). The title is a placeholder.
  equipmentSold: (equipmentName: string, amount: string): ToastText => ({ title: "Equipment sold", body: `Sold ${equipmentName} for ${amount}.` }),

  // Everything below is PLACEHOLDER copy (story decision).
  commandRejected: (command: string, reason: string): ToastText => ({ title: "Order refused", body: `${command}: ${reason}` }),
  productionCompleted: (quantity: number, product: string, quality: string, facility: string): ToastText => ({
    title: "Production done",
    body: `${quantity} × ${product} (${quality}) ready at ${facility}.`,
  }),
  productionFailed: (facility: string, writtenOff: string): ToastText => ({
    title: "Production failed",
    body: `A job at ${facility} failed. Written off: ${writtenOff}.`,
  }),
  deliveryDelayed: (route: string): ToastText => ({ title: "Delivery late", body: `A delivery on ${route} is running late.` }),
  saleCompleted: (buyer: string, revenue: string): ToastText => ({ title: "Sale", body: `${buyer} paid ${revenue}.` }),
  dealFellThrough: (buyer: string): ToastText => ({ title: "Deal fell through", body: `The deal with ${buyer} fell through.` }),
  cargoLost: (vehicle: string, bookValue: string): ToastText => ({ title: "Cargo lost", body: `${vehicle} lost its cargo (${bookValue}).` }),
  shortageStarted: (supplier: string, material: string): ToastText => ({ title: "Shortage", body: `${supplier} is short of ${material}.` }),
  shortageEnded: (supplier: string, material: string): ToastText => ({ title: "Shortage over", body: `${supplier} has ${material} again.` }),
  routeClosed: (route: string): ToastText => ({ title: "Road closed", body: `${route} is closed.` }),
  routeReopened: (route: string): ToastText => ({ title: "Road open", body: `${route} is open again.` }),
  contractOffered: (buyer: string): ToastText => ({ title: "Contract offer", body: `${buyer} is offering a contract.` }),
  installmentSettled: (buyer: string, number: number, outcome: string): ToastText => ({
    title: "Installment settled",
    body: `${buyer}, installment ${number}: ${outcome}.`,
  }),
  contractCompleted: (buyer: string): ToastText => ({ title: "Contract complete", body: `The contract with ${buyer} is complete.` }),
  unlockGranted: { title: "Unlocked", body: "Something new is open to you." } satisfies ToastText,
  /** A plain toast; the end screen is T06's (#14). */
  victoryAchieved: { title: "Victory", body: "You've won." } satisfies ToastText,
  /** A plain toast; the end screen is T06's (#14). */
  gameLost: { title: "Game over", body: "The operation is finished." } satisfies ToastText,
} as const;

/** Installment outcomes, for INSTALLMENT_SETTLED toasts. */
export const INSTALLMENT_OUTCOME_COPY: Readonly<Record<InstallmentOutcome, string>> = {
  FULFILLED: "fulfilled",
  PARTIAL: "partly delivered",
  MISSED: "missed",
};

/** Command names, for COMMAND_REJECTED toasts. */
export const COMMAND_COPY: Readonly<Record<GameCommandType, string>> = {
  PURCHASE_MATERIALS: "Buy materials",
  START_PRODUCTION: "Start production",
  DISPATCH_DELIVERY: "Dispatch a truck",
  ACCEPT_CONTRACT: "Accept a contract",
  PURCHASE_EQUIPMENT: "Buy equipment",
  SET_WORKFORCE: "Set workers",
  RELEASE_RESERVATION: "Release a reservation",
  REPEAT_OPERATION: "Repeat",
  SELL_EQUIPMENT: "Sell equipment",
};
