// PLACEHOLDER copy (story decision): the place scenes (SK2b, #234; GDD §18).
// The wording, like the art, is the human's call. Place, product and material
// names come from the snapshot or game-data.

import { formatMoney, type Money } from "@eov/contracts";

export const SCENES_COPY = {
  placeholderArt: "Placeholder art",
  placeholderNote: "A stand-in for the scene's illustration: each block is a layer drawn from what you know.",
  leave: "Back to the map",
  kind: {
    FACILITY: "Your still",
    SUPPLIER: "Supplier",
    BUYER: "Buyer",
    NONE: "Nobody here",
  },
  hours: {
    always: "Always open",
    open: (hours: string) => `Open now · hours ${hours}`,
    closed: (hours: string, opens: string | null) => (opens === null ? `Closed · hours ${hours}` : `Closed · opens ${opens} · hours ${hours}`),
    interval: (from: string, to: string) => `${from}–${to}`,
    separator: ", ",
  },
  /** Layers in the picture. */
  layer: {
    crates: (cases: number) => (cases === 0 ? "No crates stacked" : `${cases} ${cases === 1 ? "case" : "cases"} stacked by the still`),
    materials: "Sacks and jugs",
    noMaterials: "No materials",
    material: (name: string, quantity: number) => `${name} ${quantity}`,
    still: (batches: number, done: string | null) => (batches === 0 || done === null ? "The still is cold" : `The still is running, done ${done}`),
    truckHere: "The truck is in the yard",
    truckGone: "No truck in the yard",
    truckUnknown: "Where the truck is: not known",
    shelves: "On the shelves",
    shelf: (name: string, available: number, price: Money) => `${name}: ${available} at ${formatMoney(price)}`,
    shelvesUnknown: "You can't see their stock",
    wants: "What they're after",
    want: (name: string, quality: string, price: Money, demand: number) => `${name} (${quality} or better): ${demand} at ${formatMoney(price)}`,
    wantsNothing: "They want nothing today",
    wontDeal: "They won't deal with you yet",
    wantsUnknown: "You don't know what they want",
    budget: (amount: Money) => `Cash on hand for buying: ${formatMoney(amount)}`,
    budgetUnknown: "Their budget: not known",
    empty: "Nobody here to deal with",
    seen: (age: string) => `as of ${age}`,
  },
  actionsTitle: "What you can do here",
  /** Actions. */
  action: {
    buy: (material: string, price: Money) => `Buy ${material} at ${formatMoney(price)} each`,
    buyButton: "Buy",
    deliverTo: "Deliver to",
    quantity: "Quantity",
    startBatch: (recipe: string, max: number) => `Start a batch of ${recipe}${max > 0 ? ` (up to ${max})` : ""}`,
    startButton: "Start the batch",
    dispatch: (truck: string) => `Load ${truck} and drive it`,
    dispatchButton: "Load and drive",
    onSpec: "On spec (they take what they want at today's price)",
    againstDeal: (deal: string) => `For the deal: ${deal}`,
    deal: (quantity: number, product: string, quality: string, buyer: string, price: Money, expires: string) =>
      `${quantity} ${product} (${quality}) to ${buyer} at ${formatMoney(price)}, until ${expires}`,
    purpose: "Sale",
    cargo: "Cargo",
    cargoOption: (product: string, quality: string, available: number) => `${product} (${quality}), ${available} on hand`,
    buyer: "Buyer",
    route: "Road",
    routeOption: (name: string, span: string, risky: boolean, closed: boolean) =>
      `${name}, ${span}${risky ? ", risky" : ""}${closed ? " (known closed)" : ""}`,
    agree: (product: string, quality: string, price: Money, max: number) => `Agree a deal: ${product}, ${quality} or better, at ${formatMoney(price)}${max > 0 ? ` (up to ${max})` : ""}`,
    agreeButton: "Shake on it",
    quality: "Quality",
    rest: (until: string, rough: boolean) => (rough ? `Sleep rough until ${until}` : `Sleep until ${until}`),
    restButton: "Rest",
  },
  /** Why an action can't be taken now. */
  blocked: {
    NOT_HERE: "You're not here",
    BUSY: (until: string) => `Busy until ${until}`,
    CLOSED: (opens: string | null) => (opens === null ? "Closed" : `Closed until ${opens}`),
    NOT_KNOWN: "You don't know enough yet",
    WONT_DEAL: "They won't deal with you yet",
    NONE_LEFT: "None to be had",
    NO_TRUCK: "The truck isn't here",
    NOTHING_TO_LOAD: "Nothing to load",
    NO_BUYER: "No road to a buyer",
  },
  noActions: "Nothing to do here but rest.",
  result: {
    pending: "Sending…",
  },
  catchUp: (since: string, changes: number) => (changes === 0 ? `Nothing has changed since ${since}.` : `Since ${since}: ${changes} ${changes === 1 ? "thing has" : "things have"} changed. See the ledger.`),
  catchUpFirst: (changes: number) => `First look: ${changes} ${changes === 1 ? "thing" : "things"} noted in the ledger.`,
} as const;
