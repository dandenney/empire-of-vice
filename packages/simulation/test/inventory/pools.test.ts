// T02a (#5): guards beyond the locked FIN-001 tests.

import { asId, cents, type GameState, type ReservationState } from "@eov/contracts";
import { CORN, DISTILLERY_MAIN, FIRST_SHIPMENT_SCENARIO, GAME_DATA, MOONSHINE } from "@eov/game-data";
import { describe, expect, it } from "vitest";
import { createInitialState } from "../../src/game/index.ts";
import {
  addMaterial,
  addProduct,
  addReservation,
  consumeReservations,
  findMaterialPool,
  findProductPool,
  InventoryError,
  releaseRejection,
  removeMaterial,
  removeProduct,
  takeMaterial,
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

  it("refuses an add that would overflow a pool's quantity or cost", () => {
    const max = Number.MAX_SAFE_INTEGER;
    const products = addProduct(blank(), F, MOONSHINE, "basic", max, cents(1));
    expect(() => addProduct(products, F, MOONSHINE, "basic", 1, cents(0))).toThrow(InventoryError);
    const pricey = addProduct(blank(), F, MOONSHINE, "basic", 1, cents(max));
    expect(() => addProduct(pricey, F, MOONSHINE, "basic", 1, cents(1))).toThrow();

    const materials = addMaterial(blank(), F, CORN, max, cents(1));
    expect(() => addMaterial(materials, F, CORN, 1, cents(0))).toThrow(InventoryError);
    const priceyCorn = addMaterial(blank(), F, CORN, 1, cents(max));
    expect(() => addMaterial(priceyCorn, F, CORN, 1, cents(1))).toThrow();
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

  it("takes only unreserved materials, leaving a job's reservation intact", () => {
    const jobRes: ReservationState = {
      id: asId("Reservation", "res-job"),
      facilityId: F,
      goods: { kind: "MATERIAL", materialId: CORN },
      quantity: 3,
      holder: { kind: "PRODUCTION_JOB", jobId: asId("ProductionJob", "job-1") },
    };
    const s = addReservation(addMaterial(blank(), F, CORN, 5, cents(500)), jobRes);
    expect(() => takeMaterial(s, F, CORN, 3)).toThrow(InventoryError);
    const taken = takeMaterial(s, F, CORN, 2);
    expect(taken.cost).toBe(200);
    expect(findMaterialPool(taken.state, F, CORN)).toEqual({ facilityId: F, materialId: CORN, quantity: 3, totalCost: 300 });
    expect(taken.state.reservations).toEqual([jobRes]);
  });

  it("lets the player release contract-held reservations only", () => {
    const s = addReservation(addProduct(blank(), F, MOONSHINE, "basic", 5, cents(500)), contractRes(1, 2));
    expect(releaseRejection(s, contractRes(1, 2).id)).toBeNull();
    const missing = asId("Reservation", "res-2");
    expect(releaseRejection(s, missing)).toEqual({ code: "RESERVATION_NOT_ACTIVE", reservationId: missing });
  });
});
