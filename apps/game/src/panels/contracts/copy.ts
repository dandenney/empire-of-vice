// PLACEHOLDER copy (story decision): Contracts panel strings (#48, #128).
// Buyer and product names come from the snapshot, not from here.

import type { InstallmentOutcome } from "@eov/contracts";

export const CONTRACTS_COPY = {
  title: "Contracts",
  intro: "A contract fixes the price for every installment. Miss a deadline and the buyer charges a penalty on the missing cases.",

  // Rates (times and spans are ui/format's, #142)
  /** "20%". */
  percent: (value: string) => `${value}%`,

  // Offers (GDD §7, ADR 0018)
  offersTitle: "Offers",
  noOffers: "No offers on the table.",
  offerName: (buyer: string) => `Offer from ${buyer}`,
  wants: (product: string, minimumQuality: string) => `${product}, ${minimumQuality} or better`,
  perInstallment: "Cases per delivery",
  installments: "Deliveries",
  every: "Every",
  unitPrice: "Per case",
  penalty: "Penalty",
  penaltyLine: (percent: string) => `${percent} of missing cases' value`,
  firstDeadline: "First due",
  expires: "Offer ends",
  blockedBy: "Can't accept",
  accept: "Accept contract",
  acceptLabel: (buyer: string) => `Accept the contract from ${buyer}`,

  // Active contracts
  activeTitle: "Active contracts",
  noActive: "No active contracts.",
  installmentsCaption: "Deliveries",
  installment: "#",
  installmentNumber: (index: number) => `${index + 1}`,
  deadline: "Due",
  required: "Cases",
  delivered: "In",
  inTransit: "En route",
  outcome: "Result",
  penaltyCharged: "Penalty",
  pending: "Open",
  outcomes: {
    FULFILLED: "Fulfilled",
    PARTIAL: "Short",
    MISSED: "Missed",
  } satisfies Record<InstallmentOutcome, string>,

  // Reservations (GDD §7, ADR 0013)
  held: "Held for this contract",
  heldCases: (quantity: number) => `${quantity} ${quantity === 1 ? "case" : "cases"}`,
  releaseNote: "Released cases can be sold or shipped elsewhere, but the next delivery may fall short.",
  release: "Release",
  releaseNumbered: (n: number) => `Release hold ${n}`,
  releaseLabel: (buyer: string, n: number) => `Release held cases for ${buyer} (hold ${n})`,
  nothingHeld: "Nothing held.",

  // Delivery form (DISPATCH_DELIVERY, purpose CONTRACT_INSTALLMENT)
  deliverTitle: (buyer: string) => `Deliver to ${buyer}`,
  quality: "Quality",
  qualityLabel: (buyer: string) => `Quality of the cases for ${buyer}`,
  qualityOption: (quality: string, quantity: number, reserved: number) => `${quality}: ${quantity} in stock, ${reserved} reserved`,
  qualityNoStock: (quality: string) => `${quality}: none in stock`,
  cases: "Cases",
  casesLabel: (buyer: string) => `Cases to deliver to ${buyer}`,
  truck: "Truck",
  truckLabel: (buyer: string) => `Truck for ${buyer}'s delivery`,
  truckOption: (name: string, capacity: number) => `${name} (${capacity} cases)`,
  truckBusy: (name: string) => `${name} (on the road)`,
  noTruck: "No truck to send.",
  noDestination: "This buyer isn't on the map.",
  dispatch: "Dispatch delivery",

  // Reserved stock
  reservedTitle: "Reserved stock",
  reservedIntro: "Cases held for contracts can be released from the contract above. Materials held by running production can't be released.",
  noReserved: "Nothing reserved.",
  productReserved: (product: string, quality: string, reserved: number, quantity: number) => `${product} (${quality}): ${reserved} of ${quantity} cases reserved`,
  materialReserved: (material: string, reserved: number, quantity: number) => `${material}: ${reserved} of ${quantity} held by running production`,

  // Closed contracts
  closedTitle: "Closed contracts",
  closedLine: (buyer: string, outcomes: string) => `${buyer}: ${outcomes}`,
  outcomeList: (outcomes: readonly string[]) => outcomes.join(", "),
} as const;
