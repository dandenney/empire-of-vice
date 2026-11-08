// PLACEHOLDER copy (story decision): Facility panel strings (#48, #128).
// Facility, equipment, and tier names and equipment descriptions come from the
// snapshot, not from here.

import type { FacilitySnapshot } from "@eov/contracts";

export const FACILITY_COPY = {
  title: "Facility",
  noFacilities: "No facilities.",
  kinds: {
    DISTILLERY: "Distillery",
    WAREHOUSE: "Warehouse",
  } satisfies Record<FacilitySnapshot["kind"], string>,

  // Storage and capacity
  storage: "Storage",
  storageLine: (used: number, capacity: number) => `${used} of ${capacity} cases`,
  storageMeterLabel: (facility: string) => `Storage used at ${facility}`,
  capacity: "Production",
  capacityLine: (casesPerDay: number) => `${casesPerDay} cases a day`,

  // Workforce (SET_WORKFORCE)
  workforceTitle: "Workforce",
  workers: "Workers",
  workersLine: (workers: number, maximum: number) => `${workers} of ${maximum}`,
  wagePerWorker: "Daily wage each",
  workersInput: "New crew",
  workersLabel: (facility: string) => `Workers at ${facility}`,
  setWorkforce: "Set crew",

  // Owned equipment (SELL_EQUIPMENT, ADR 0020 decision 9)
  equipmentTitle: "Equipment",
  slots: (used: number, total: number) => `${used} of ${total} slots used`,
  noEquipment: "No equipment.",
  equipment: "Item",
  bookValue: "Book value",
  resaleValue: "Sells for",
  sell: "Sell",
  sellLabel: (name: string) => `Sell the ${name}`,
  confirmSell: (price: string) => `Sell for ${price}`,
  confirmSellLabel: (name: string, price: string) => `Confirm: sell the ${name} for ${price}`,
  cancel: "Keep it",
  sellNote: "Selling raises cash now. The item is gone, and so is what it did.",

  // Buying equipment (PURCHASE_EQUIPMENT)
  optionsTitle: "Buy equipment",
  noOptions: "Nothing to buy here.",
  price: "Price",
  blockedBy: "Can't buy",
  /** After a LOCKED reason (which names the unlock by id until #124 adds a display name): the tier that grants it. */
  unlockedAt: (tier: string, requirements: string) => `${tier} grants it: ${requirements}.`,
  requirementNetWorth: (amount: string) => `net worth ${amount}`,
  requirementReputation: (reputation: number) => `reputation ${reputation}`,
  requirementNone: "no requirements",
  requirementList: (parts: readonly string[]) => parts.join(" and "),
  buy: "Buy",
  buyLabel: (name: string) => `Buy the ${name}`,
} as const;
