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
  // Dynamic: assigned by the simulation during play.
  | "Command"
  | "Event"
  | "Transaction"
  | "ProductionJob"
  | "Delivery"
  | "ContractOffer"
  | "Contract"
  | "Reservation";

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
export type CommandId = Id<"Command">;
export type EventId = Id<"Event">;
export type TransactionId = Id<"Transaction">;
export type ProductionJobId = Id<"ProductionJob">;
export type DeliveryId = Id<"Delivery">;
export type ContractOfferId = Id<"ContractOffer">;
export type ContractId = Id<"Contract">;
export type ReservationId = Id<"Reservation">;

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
