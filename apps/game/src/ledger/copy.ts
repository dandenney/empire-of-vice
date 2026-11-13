// PLACEHOLDER copy (story decision): the founder's ledger (SK2b, #234; GDD §17
// "The ledger view"). The wording, like the look, is the human's call. Place,
// road, product and material names come from the snapshot or game-data.

import { formatMoney, type Money } from "@eov/contracts";

export const LEDGER_COPY = {
  title: "The ledger",
  placeholder: "Placeholder layout",
  intro: "What you know, when you learned it, and who said so.",
  empty: "Nothing known yet. Go and look.",
  /** Groups. */
  groups: {
    roads: "Roads",
    vehicles: "The truck",
    contracts: "Contracts",
    market: "The market",
    standing: "Your standing",
    employees: "Your people",
  },
  /** One record's heading, per subject kind. */
  subjects: {
    FACILITY_STOCK: "On hand",
    FACILITY_OPERATIONS: "At work",
    SUPPLIER_OFFER: "For sale",
    BUYER_WANTS: "Wants",
    BUYER_BUDGET: "Budget",
    CONTRACT_OFFERS: "Contract offers",
    CONTRACT_PROGRESS: "Contract",
    MARKET_PRICES: "Today's prices",
    ROUTE_CONDITION: "Condition",
    VEHICLE_WHEREABOUTS: "Whereabouts",
    STANDING: "Standing",
    EMPLOYEE_PERFORMANCE: "Their work",
  },
  /** Age and when. */
  lastUpdated: (when: string) => `last updated ${when}`,
  ago: (span: string) => `${span} ago`,
  justNow: "just now",
  inParens: (source: string) => `(${source})`,
  /** Sources. */
  source: {
    inPerson: (place: string) => `in person at ${place}`,
    /** Road records: seen travelling the road (decided on #174). */
    seenOn: (road: string) => `seen on ${road}`,
    books: "from the books",
    phone: (place: string) => `by phone from ${place}`,
    message: (place: string, by: string | null) => (by === null ? `message left at ${place}` : `message left at ${place} by ${by}`),
    report: (who: string) => `report from ${who}`,
  },
  /** Values. */
  value: {
    nothingOnHand: "Nothing on hand",
    material: (name: string, quantity: number) => [name, `${quantity}`] as const,
    product: (name: string, quality: string, quantity: number, reserved: number) =>
      [`${name} (${quality})`, reserved > 0 ? `${quantity} cases, ${reserved} reserved` : `${quantity} ${quantity === 1 ? "case" : "cases"}`] as const,
    storage: (used: number, capacity: number) => ["Storage", `${used} of ${capacity} used`] as const,
    noBatch: "No batch running",
    batch: (cases: number, product: string, done: string) => ["Batch", `${cases} ${cases === 1 ? "case" : "cases"} ${product}, done ${done}`] as const,
    workers: (n: number) => ["Hands at work", `${n}`] as const,
    forSale: (name: string, price: Money, available: number, shortage: boolean) =>
      [name, `${formatMoney(price)} each, ${available} on hand${shortage ? " (short)" : ""}`] as const,
    wontDeal: "Won't deal with you yet",
    wantsNothing: "Wants nothing today",
    want: (product: string, minQuality: string, price: Money, demand: number) =>
      [`${product}, ${minQuality} or better`, `${formatMoney(price)} a case, wants ${demand}`] as const,
    budget: (amount: Money) => ["Can spend", formatMoney(amount)] as const,
    offers: (n: number) => (n === 0 ? "No offers" : `${n} ${n === 1 ? "offer" : "offers"} on the table`),
    contractStatus: (status: "ACTIVE" | "COMPLETED") => ["Status", status === "ACTIVE" ? "Running" : "Completed"] as const,
    price: (product: string, quality: string, price: Money) => [`${product} (${quality})`, formatMoney(price)] as const,
    roadOpen: "Open",
    roadClosed: (why: string, reopens: string | null) => (reopens === null ? `Closed (${why})` : `Closed (${why}), reopens ${reopens}`),
    closedBecause: { RIVAL: "rivals", POLICE: "police" } as const,
    parkedAt: (place: string) => `Parked at ${place}`,
    onTheRoad: (road: string, leg: "OUTBOUND" | "RETURN", due: string) => `${leg === "OUTBOUND" ? "Heading out" : "Coming home"} on ${road}, due ${due}`,
    unknownPlace: "somewhere",
    reputation: (n: number) => ["Reputation", `${n}`] as const,
    tier: (name: string) => ["Tier", name] as const,
    batchesRun: (n: number) => ["Batches run", `${n}`] as const,
    competence: (c: number | null) => ["How good", c === null ? "Too soon to tell" : `${c}`] as const,
  },
} as const;
