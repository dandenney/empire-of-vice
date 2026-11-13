// Branded string identifiers. See docs/decisions/0003-identifiers-time-and-coordinates.md.
//
// Every entity kind gets its own ID type, so a BuyerId can't be passed where a
// FacilityId is expected. IDs are plain strings at runtime (JSON-safe for saves
// and snapshots). Static IDs come from game-data ("distillery-main"); IDs for
// things created during play are assigned by the simulation from a counter in
// state ("job-17"), so they're deterministic and replay identically.

declare const idBrand: unique symbol;

export type IdKind =
  // Static: defined in game-data and scenario files.
  | "Location"
  | "Facility"
  | "Supplier"
  | "Buyer"
  | "Vehicle"
  | "Route"
  | "Material"
  | "Product"
  | "Recipe"
  | "Equipment"
  | "Character"
  | "Family"
  | "Unlock"
  | "Tier"
  | "Scenario"
  // Dynamic: assigned by the simulation during play.
  | "Command"
  | "Event"
  | "Transaction"
  | "ProductionJob"
  | "Delivery"
  | "ContractOffer"
  | "Contract"
  | "Reservation"
  | "Deal";

/** Kinds whose IDs the simulation assigns from counters in state (ADR 0003). */
export const DYNAMIC_ID_KINDS = [
  "Command",
  "Event",
  "Transaction",
  "ProductionJob",
  "Delivery",
  "ContractOffer",
  "Contract",
  "Reservation",
  "Deal",
] as const satisfies readonly IdKind[];
export type DynamicIdKind = (typeof DYNAMIC_ID_KINDS)[number];

/**
 * The prefix of each dynamic kind's IDs: `<prefix>-<n>` (ADR 0003). The simulation
 * mints IDs with these prefixes, and `compareIds` uses them to recognize
 * simulation-created IDs. Static IDs must not take the form `<prefix>-<n>` for any
 * of these prefixes.
 */
export const DYNAMIC_ID_PREFIXES = {
  Command: "cmd",
  Event: "evt",
  Transaction: "txn",
  ProductionJob: "job",
  Delivery: "delivery",
  ContractOffer: "offer",
  Contract: "contract",
  Reservation: "res",
  /** A held deal (ADR 0022 decision 6). */
  Deal: "deal",
} as const satisfies Readonly<Record<DynamicIdKind, string>>;

export type Id<K extends IdKind> = string & { readonly [idBrand]: K };

export type LocationId = Id<"Location">;
export type FacilityId = Id<"Facility">;
export type SupplierId = Id<"Supplier">;
export type BuyerId = Id<"Buyer">;
export type VehicleId = Id<"Vehicle">;
export type RouteId = Id<"Route">;
export type MaterialId = Id<"Material">;
export type ProductId = Id<"Product">;
export type RecipeId = Id<"Recipe">;
export type EquipmentId = Id<"Equipment">;
export type CharacterId = Id<"Character">;
export type FamilyId = Id<"Family">;
export type UnlockId = Id<"Unlock">;
export type TierId = Id<"Tier">;
export type ScenarioId = Id<"Scenario">;
export type CommandId = Id<"Command">;
export type EventId = Id<"Event">;
export type TransactionId = Id<"Transaction">;
export type ProductionJobId = Id<"ProductionJob">;
export type DeliveryId = Id<"Delivery">;
export type ContractOfferId = Id<"ContractOffer">;
export type ContractId = Id<"Contract">;
export type ReservationId = Id<"Reservation">;
export type DealId = Id<"Deal">;

/** Lowercase letters and digits, separated by single hyphens: "distillery-main", "job-17". */
export const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const ID_MAX_LENGTH = 64;

export class InvalidIdError extends TypeError {
  override readonly name = "InvalidIdError";
}

export function isValidId(value: unknown): value is string {
  return typeof value === "string" && value.length <= ID_MAX_LENGTH && ID_PATTERN.test(value);
}

/** Brands a string as an ID of the given kind. Throws if it doesn't match ID_PATTERN. */
export function asId<K extends IdKind>(kind: K, value: string): Id<K> {
  if (!isValidId(value)) {
    throw new InvalidIdError(`Invalid ${kind} ID: ${JSON.stringify(value)}`);
  }
  return value as Id<K>;
}

// ---------------------------------------------------------------------------
// Ordering (ADR 0007 and ADR 0008, amended for issue #34)
// ---------------------------------------------------------------------------

const DYNAMIC_PREFIX_SET: ReadonlySet<string> = new Set(Object.values(DYNAMIC_ID_PREFIXES));

/** UTF-16 code-unit order. Never `localeCompare`, which depends on the runtime's locale. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Splits a simulation-created ID into its head (`"job-"`) and canonical digit
 * suffix (`"17"`), or returns null for anything else: static IDs, and suffixes
 * with leading zeros, which the simulation never mints.
 */
function splitDynamicId(id: string): { readonly head: string; readonly digits: string } | null {
  const dash = id.indexOf("-");
  if (dash <= 0 || dash !== id.lastIndexOf("-")) return null;
  const digits = id.slice(dash + 1);
  if (!DYNAMIC_PREFIX_SET.has(id.slice(0, dash)) || digits.length === 0) return null;
  for (let i = 0; i < digits.length; i++) {
    const c = digits.charCodeAt(i);
    if (c < 48 || c > 57) return null; // not 0-9
  }
  if (digits.length > 1 && digits.charCodeAt(0) === 48) return null; // leading zero
  return { head: id.slice(0, dash + 1), digits };
}

/**
 * The one ID order for state and snapshot lists (ADR 0007, ADR 0008). A total order:
 *
 * - Static (fixed-data) IDs sort as text, by UTF-16 code unit.
 * - Simulation-created IDs (`<prefix>-<n>`, see `DYNAMIC_ID_PREFIXES`) sort by
 *   prefix, then by numeric suffix: `job-9` before `job-10`. That's creation order.
 *
 * Each ID's sort key is (head, number). A dynamic ID's head is `"<prefix>-"`; a
 * static ID's head is the whole ID, with no number. A valid ID never ends in a
 * hyphen, so a static and a dynamic ID never share a head, and comparing keys
 * lexicographically is total and transitive. Suffixes compare as digit strings
 * (length, then text), so there's no overflow at any length. Pure string logic,
 * deterministic in every runtime.
 */
export function compareIds(a: string, b: string): number {
  const da = splitDynamicId(a);
  const db = splitDynamicId(b);
  const byHead = compareText(da ? da.head : a, db ? db.head : b);
  if (byHead !== 0 || !da || !db) return byHead;
  return da.digits.length - db.digits.length || compareText(da.digits, db.digits);
}

/** Orders records by `id` with `compareIds`, for `Array.prototype.sort`. */
export function compareById<T extends { readonly id: string }>(a: T, b: T): number {
  return compareIds(a.id, b.id);
}
