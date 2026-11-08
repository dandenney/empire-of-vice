// PLACEHOLDER copy (story decision): Market panel strings (#48, #50). Supplier
// and buyer flavor lines, shortage names, and route names and descriptions are
// game-data's (#81, #77), not here.

export const MARKET_COPY = {
  /** The rail and shell read this title too; it matches the old placeholder's. */
  title: "Market",
  intro: "Today's prices hold until midnight, when the market report is redrawn.",

  // Repeat orders (ADR 0020 decision 11)
  repeatTitle: "Repeat orders",
  lastPurchase: "Last purchase",
  lastSale: "Last sale",
  purchaseLine: (quantity: number, material: string, supplier: string) => `${quantity} × ${material} from ${supplier}`,
  saleLine: (quantity: number, product: string, quality: string, buyer: string) => `${quantity} × ${product} (${quality}) to ${buyer}`,
  repeatSaleNote: "A repeated sale goes at the buyer's price on the day.",
  repeat: "Repeat",
  repeatLabel: (what: string) => `Repeat: ${what}`,

  // Market report (ECO-001, ADR 0016)
  pricesTitle: "Market report",
  pricesCaption: (day: number) => `Spot prices, day ${day}`,
  product: "Product",
  yesterday: "Yesterday",
  today: "Today",
  productQuality: (product: string, quality: string) => `${product} (${quality})`,
  /** "Base $10.00 × demand 1.05 × supply 0.95 × events 1.10". */
  explanation: (base: string, demand: string, supply: string, events: string) => `Base ${base} × demand ${demand} × supply ${supply} × events ${events}`,
  eventCause: (names: readonly string[]) => `Events: ${names.join(", ")}.`,
  noPrices: "No market report yet.",

  // Suppliers
  suppliersTitle: "Suppliers",
  noSuppliers: "No suppliers.",
  material: "Material",
  price: "Price",
  available: "Available",
  shortage: "Shortage",
  shortageNamed: (name: string) => `Shortage: ${name}`,
  buyQuantityLabel: (material: string) => `Units of ${material} to buy`,
  buy: "Buy",
  deliverTo: "Deliver to",
  deliverToLabel: (supplier: string) => `Facility for ${supplier}'s goods`,
  noFacility: "You have no facility to take deliveries.",

  // Buyers
  buyersTitle: "Buyers",
  noBuyers: "No buyers.",
  budgetRemaining: "Budget left today",
  minimumReputation: (required: number, current: number) => `Deals from reputation ${required}. Yours is ${current}.`,
  willDeal: "Will deal with you.",
  wantsCaption: "Wants today",
  want: "Wants",
  wantLine: (product: string, minimumQuality: string) => `${product}, ${minimumQuality} or better`,
  unitPrice: "Per case",
  demandRemaining: "Still wanted",
  willTake: "Will take",
  noWants: "Wants nothing today.",

  // Sale form (ADR 0005)
  sellTitle: (buyer: string) => `Sell to ${buyer}`,
  wantChoice: "Want",
  wantChoiceLabel: (buyer: string) => `Which of ${buyer}'s wants to fill`,
  wantOption: (line: string, price: string) => `${line} at ${price}`,
  quality: "Quality",
  qualityLabel: (buyer: string) => `Quality of the cases for ${buyer}`,
  qualityOption: (quality: string, quantity: number, reserved: number) => `${quality}: ${quantity} in stock, ${reserved} reserved`,
  qualityNoStock: (quality: string) => `${quality}: none in stock`,
  cases: "Cases",
  casesLabel: (buyer: string) => `Cases to sell to ${buyer}`,
  truck: "Truck",
  truckLabel: (buyer: string) => `Truck for ${buyer}`,
  truckOption: (name: string, capacity: number) => `${name} (${capacity} cases)`,
  truckBusy: (name: string) => `${name} (on the road)`,
  noTruck: "No truck to send.",
  agreedPrice: "Agreed price per case",
  dispatch: "Dispatch sale",

  // Rejections with their numbers (ADR 0005)
  quoteChanged: (agreed: string, current: string) => `The price changed: you agreed to ${agreed} a case, and the buyer now pays ${current}.`,
  buyerWillTakeLess: (requested: number, acceptable: number) => `The buyer will take only ${acceptable} of those ${requested} cases.`,
  rejectedWithCode: (text: string, code: string) => `${text} (${code})`,
} as const;
