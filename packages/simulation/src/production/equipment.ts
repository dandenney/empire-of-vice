// PURCHASE_EQUIPMENT (T02c1, PROD-001; ADR 0017 decision 6) and SELL_EQUIPMENT
// (T05d, ADR 0020 decision 9).
//
// PURCHASE_EQUIPMENT checks, in order: UNKNOWN_ENTITY facility, then equipment →
// EQUIPMENT_ALREADY_OWNED (one of each per facility) → LOCKED when the item's
// requiredUnlockId isn't in family.unlocked → NO_EQUIPMENT_SLOT when every slot
// is used → INSUFFICIENT_FUNDS. A purchase converts cash into a book asset
// (FIN-001: Dr EQUIPMENT / Cr CASH, net worth unchanged), adds the item at its
// price as book value, and emits EQUIPMENT_PURCHASED. Throughput and storage
// derive from what's owned, so they change at once; a running job keeps its
// `completesAt` (ADR 0008).
//
// SELL_EQUIPMENT checks, in order: UNKNOWN_ENTITY facility, then equipment →
// EQUIPMENT_NOT_OWNED. A sale pays the item's resale value (its book value at
// `progression.recovery.equipmentResaleRatio`), writes the rest off to LOSSES,
// removes the item, and emits EQUIPMENT_SOLD. A running job keeps its
// `completesAt`, and a facility may be left over its storage capacity (ADR 0019
// decision 4): starts are blocked until there's room, and nothing is lost.

import {
  applyRatios,
  compareIds,
  idempotencyKey,
  RATIO_SCALE,
  type GameState,
  type Money,
  type PurchaseEquipmentCommand,
  type RejectionReason,
  type SellEquipmentCommand,
  type TransactionCoordinator,
} from "@eov/contracts";
import type { GameData } from "@eov/game-data";
import { assetSaleEntries, equipmentPurchaseEntries } from "../economy/ledger/postings.ts";
import { cashBalance } from "../economy/ledger/ledger.ts";
import type { CommandHandler } from "../kernel/registry.ts";
import { facilitySpec } from "./capacity.ts";

/** The first rule PURCHASE_EQUIPMENT breaks, or null. Never throws. */
function purchaseRejection(state: GameState, command: PurchaseEquipmentCommand, data: GameData): RejectionReason | null {
  const { facilityId, equipmentId } = command;
  const facility = state.facilities.find((f) => f.id === facilityId);
  if (!facility) return { code: "UNKNOWN_ENTITY", kind: "Facility", id: facilityId };
  const item = data.equipment.find((e) => e.id === equipmentId);
  if (!item) return { code: "UNKNOWN_ENTITY", kind: "Equipment", id: equipmentId };
  if (facility.equipment.some((e) => e.equipmentId === equipmentId)) return { code: "EQUIPMENT_ALREADY_OWNED", facilityId, equipmentId };
  if (item.requiredUnlockId !== null && !state.family.unlocked.includes(item.requiredUnlockId)) return { code: "LOCKED", unlockId: item.requiredUnlockId };
  if (facility.equipment.length >= facilitySpec(data, facilityId).equipmentSlots) return { code: "NO_EQUIPMENT_SLOT", facilityId, equipmentId };
  const cash = cashBalance(state);
  if (cash < item.price) return { code: "INSUFFICIENT_FUNDS", required: item.price, available: cash };
  return null;
}

/**
 * The purchase key. The first purchase of an item at a facility keeps
 * `EQUIPMENT_PURCHASE:<facility>:<equipment>` (the PROD-001 locked test asserts
 * it). Once that key is in the ledger the item was sold and is being bought
 * back, so the key adds the command ID; otherwise the buy-back would be
 * swallowed as a duplicate (ADR 0020 decision 9).
 */
function purchaseKey(state: GameState, command: PurchaseEquipmentCommand, commandId: string): string {
  const base = idempotencyKey("EQUIPMENT_PURCHASE", command.facilityId, command.equipmentId);
  return state.ledger.transactions.some((t) => t.idempotencyKey === base)
    ? idempotencyKey("EQUIPMENT_PURCHASE", command.facilityId, command.equipmentId, commandId)
    : base;
}

export function purchaseEquipmentHandler(data: GameData, coordinator: TransactionCoordinator): CommandHandler<"PURCHASE_EQUIPMENT"> {
  return {
    apply: (state, command, ctx) => {
      // Checked before the transaction begins: ownership has to be judged
      // before the key is.
      const rejection = purchaseRejection(state, command, data);
      if (rejection) return { status: "rejected", reason: rejection };
      const { facilityId, equipmentId } = command;
      const item = data.equipment.find((e) => e.id === equipmentId)!;

      const tx = coordinator.begin(state, {
        kind: "EQUIPMENT_PURCHASE",
        idempotencyKey: purchaseKey(state, command, ctx.envelope.id),
        tick: ctx.tick,
        causedBy: ctx.envelope.id,
      });
      if (tx.status === "duplicate") return { status: "applied", state };
      tx.update((s) => ({
        ...s,
        facilities: s.facilities.map((f) =>
          f.id === facilityId
            ? { ...f, equipment: [...f.equipment, { equipmentId, bookValue: item.price }].sort((a, b) => compareIds(a.equipmentId, b.equipmentId)) }
            : f,
        ),
      }));
      tx.post(equipmentPurchaseEntries(item.price));
      tx.emit({ type: "EQUIPMENT_PURCHASED", facilityId, equipmentId, price: item.price, transactionId: tx.transactionId });
      const result = tx.commit();
      return result.status === "committed" ? { status: "applied", state: result.state } : { status: "rejected", reason: result.reason };
    },
  };
}

/** What SELL_EQUIPMENT pays for an item at `bookValue`: one rounding at the resale ratio (ADR 0020 decision 9). */
export function resaleValue(bookValue: Money, data: GameData): Money {
  return applyRatios(bookValue, [data.progression.recovery.equipmentResaleRatio]);
}

/** Throws RangeError unless the resale ratio is an integer in (0, RATIO_SCALE). Run when the systems are built. */
export function validateResaleRatio(data: GameData): void {
  const r = data.progression.recovery.equipmentResaleRatio;
  if (!Number.isSafeInteger(r) || r <= 0 || r >= RATIO_SCALE) {
    throw new RangeError(`progression.recovery.equipmentResaleRatio must be an integer in (0, ${RATIO_SCALE}), got ${r}`);
  }
}

/** The first rule SELL_EQUIPMENT breaks, or null. Never throws. */
function saleRejection(state: GameState, command: SellEquipmentCommand, data: GameData): RejectionReason | null {
  const { facilityId, equipmentId } = command;
  const facility = state.facilities.find((f) => f.id === facilityId);
  if (!facility) return { code: "UNKNOWN_ENTITY", kind: "Facility", id: facilityId };
  if (!data.equipment.some((e) => e.id === equipmentId)) return { code: "UNKNOWN_ENTITY", kind: "Equipment", id: equipmentId };
  if (!facility.equipment.some((e) => e.equipmentId === equipmentId)) return { code: "EQUIPMENT_NOT_OWNED", facilityId, equipmentId };
  return null;
}

export function sellEquipmentHandler(data: GameData, coordinator: TransactionCoordinator): CommandHandler<"SELL_EQUIPMENT"> {
  validateResaleRatio(data);
  return {
    apply: (state, command, ctx) => {
      const rejection = saleRejection(state, command, data);
      if (rejection) return { status: "rejected", reason: rejection };
      const { facilityId, equipmentId } = command;
      const { bookValue } = state.facilities.find((f) => f.id === facilityId)!.equipment.find((e) => e.equipmentId === equipmentId)!;
      const proceeds = resaleValue(bookValue, data);

      const tx = coordinator.begin(state, {
        kind: "ASSET_SALE",
        idempotencyKey: idempotencyKey("ASSET_SALE", ctx.envelope.id),
        tick: ctx.tick,
        causedBy: ctx.envelope.id,
      });
      if (tx.status === "duplicate") return { status: "applied", state };
      tx.update((s) => ({
        ...s,
        facilities: s.facilities.map((f) => (f.id === facilityId ? { ...f, equipment: f.equipment.filter((e) => e.equipmentId !== equipmentId) } : f)),
      }));
      tx.post(assetSaleEntries({ bookValue, proceeds }));
      tx.emit({ type: "EQUIPMENT_SOLD", facilityId, equipmentId, bookValue, proceeds, transactionId: tx.transactionId });
      const result = tx.commit();
      return result.status === "committed" ? { status: "applied", state: result.state } : { status: "rejected", reason: result.reason };
    },
  };
}
