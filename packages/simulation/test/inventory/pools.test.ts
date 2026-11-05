// T02a (#5): guards beyond the locked FIN-001 tests.

import { asId, cents, type GameState, type ReservationState } from "@eov/contracts";
import { CORN, DISTILLERY_MAIN, FIRST_SHIPMENT_SCENARIO, GAME_DATA, MOONSHINE } from "@eov/game-data";
import { describe, expect, it } from "vitest";
import { createInitialState } from "../../src/game/index.ts";
import {
  addProduct,
  addReservation,
  consumeReservations,
  findProductPool,
  InventoryError,
  releaseRejection,
  removeMaterial,
  removeProduct,
} from "../../src/inventory/index.ts";

const F = DISTILLERY_MAIN;
const blank = (): GameState => createInitialState(FIRST_SHIPMENT_SCENARIO, GAME_DATA);
const contractRes = (n: number, quantity: number): ReservationState => ({
  id: asId("Reservation", `res-${n}`),
  facilityId: F,
  goods: { kind: "PRODUCT", productId: MOONSHINE, quality: "basic" },
  quantity,
  holder: { kind: "CONTRACT", contractId: asId("Contract", "contract-1") },
});

describe("low-level removal", () => {
  it("refuses to empty a pool without taking all its cost, or to take more than it holds", () => {
    const s = addProduct(blank(), F, MOONSHINE, "basic", 3, cents(1000));
    expect(() => removeProduct(s, F, MOONSHINE, "basic", 3, cents(999))).toThrow(InventoryError);
    expect(() => removeProduct(s, F, MOONSHINE, "basic", 4, cents(1000))).toThrow(InventoryError);
    expect(() => removeProduct(s, F, MOONSHINE, "basic", 1, cents(1001))).toThrow(InventoryError);
    expect(() => removeMaterial(s, F, CORN, 1, cents(0))).toThrow(InventoryError);
    expect(findProductPool(removeProduct(s, F, MOONSHINE, "basic", 3, cents(1000)), F, MOONSHINE, "basic")).toBeUndefined();
  });
});

describe("reservations", () => {
  it("rejects a reservation ID that's already active", () => {
    const s = addReservation(addProduct(blank(), F, MOONSHINE, "basic", 5, cents(500)), contractRes(1, 2));
    expect(() => addReservation(s, contractRes(1, 1))).toThrow(InventoryError);
  });

  it("consumes product reservations at weighted-average cost and rejects a repeated ID", () => {
    let s = addProduct(blank(), F, MOONSHINE, "basic", 3, cents(1000));
    s = addReservation(addReservation(s, contractRes(1, 1)), contractRes(2, 2));
    const consumed = consumeReservations(s, [contractRes(1, 1).id, contractRes(2, 2).id]);
    expect(consumed.cost).toBe(1000);
    expect(consumed.state.productPools).toEqual([]);
    expect(consumed.state.reservations).toEqual([]);
    expect(() => consumeReservations(s, [contractRes(1, 1).id, contractRes(1, 1).id])).toThrow(InventoryError);
  });

  it("lets the player release contract-held reservations only", () => {
    const s = addReservation(addProduct(blank(), F, MOONSHINE, "basic", 5, cents(500)), contractRes(1, 2));
    expect(releaseRejection(s, contractRes(1, 2).id)).toBeNull();
    const missing = asId("Reservation", "res-2");
    expect(releaseRejection(s, missing)).toEqual({ code: "RESERVATION_NOT_ACTIVE", reservationId: missing });
  });
});
