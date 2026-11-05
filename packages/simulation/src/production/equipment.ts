// PURCHASE_EQUIPMENT (T02c1, PROD-001; ADR 0017 decision 6).
//
// Checks, in order: UNKNOWN_ENTITY facility, then equipment →
// EQUIPMENT_ALREADY_OWNED (one of each per facility) → LOCKED when the item's
// requiredUnlockId isn't in family.unlocked → NO_EQUIPMENT_SLOT when every slot
// is used → INSUFFICIENT_FUNDS. A purchase converts cash into a book asset
// (FIN-001: Dr EQUIPMENT / Cr CASH, net worth unchanged), adds the item at its
// price as book value, and emits EQUIPMENT_PURCHASED. Throughput and storage
// derive from what's owned, so they change at once; a running job keeps its
// `completesAt` (ADR 0008).

import {
  compareIds,
  idempotencyKey,
  type GameState,
  type PurchaseEquipmentCommand,
  type RejectionReason,
  type TransactionCoordinator,
} from "@eov/contracts";
import type { GameData } from "@eov/game-data";
import { equipmentPurchaseEntries } from "../economy/ledger/postings.ts";
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

export function purchaseEquipmentHandler(data: GameData, coordinator: TransactionCoordinator): CommandHandler<"PURCHASE_EQUIPMENT"> {
  return {
    apply: (state, command, ctx) => {
      // Checked before the transaction begins: a facility's purchase key is one
      // per item, so ownership has to be judged before the key is.
      const rejection = purchaseRejection(state, command, data);
      if (rejection) return { status: "rejected", reason: rejection };
      const { facilityId, equipmentId } = command;
      const item = data.equipment.find((e) => e.id === equipmentId)!;

      const tx = coordinator.begin(state, {
        kind: "EQUIPMENT_PURCHASE",
        idempotencyKey: idempotencyKey("EQUIPMENT_PURCHASE", facilityId, equipmentId),
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
