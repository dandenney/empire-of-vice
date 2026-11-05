// T02a (#5) locked acceptance tests: inventory pools, reservations, cargo moves,
// and weighted-average costing (GDD §8 FIN-001, §14.8; ADR 0013 release rules).
//
// Written ahead of the implementation by a separate test-writer agent
// (factory.md §2). Every test is `// @locked`: the implementing agent must not
// edit this file.
//
// API this file assumes, exported from `src/inventory/index.ts`. Names the
// issue fixes are marked (issue); the rest are the test-writer's choice.
//
//   Existing (S0), kept:
//     allocateRemovalCost(totalCost, poolQuantity, quantity): Money
//     addProduct(state, facilityId, productId, quality, quantity, cost): GameState
//       Also the "put" half of a cargo move. Throws InventoryError unless
//       quantity is a positive safe integer and cost is a non-negative Money.
//     addMaterial(state, facilityId, materialId, quantity, cost): GameState  (same checks)
//     addReservation(state, reservation): GameState
//       Throws InventoryError unless 0 < quantity <= available (pool quantity
//       minus the other reservations on that pool) and quantity is a safe integer.
//     availableProduct / availableMaterial, findProductPool / findMaterialPool,
//     removeReservations, InventoryError
//     inventoryValue(pools): Money  (issue: signature unchanged)
//
//   New:
//     registerInventory: RegisterSystem  (issue), listed in SYSTEMS as "inventory (T02a)"
//     storageUsed(state, facilityId): number  (issue)
//       Finished-goods cases at the facility, reserved included; materials excluded.
//     checkReservation(state, facilityId, goods: ReservedGoods, quantity): RejectionReason | null
//       null when 0 < quantity <= available; otherwise INVALID_QUANTITY
//       { field: "quantity", value } for a non-positive or non-integer quantity,
//       INSUFFICIENT_STOCK { productId, quality, requested, available } for
//       products, INSUFFICIENT_MATERIALS { materialId, required, available } for materials.
//     takeProduct(state, facilityId, productId, quality, quantity): { state, cost }
//     takeMaterial(state, facilityId, materialId, quantity): { state, cost }
//       The "take" half of a cargo move, and removal for a sale or a transfer:
//       takes UNRESERVED stock only, at allocateRemovalCost of the pool before
//       the removal (the removal that empties a pool takes all its cost, and the
//       emptied pool is removed). Throws InventoryError when quantity isn't a
//       positive safe integer or exceeds the unreserved quantity.
//     consumeReservations(state, reservationIds): { state, cost }
//       Removal for a holder: removes each reservation's goods from its pool at
//       weighted-average cost (in the order given) and removes the reservations.
//       `cost` is the total, e.g. a failed job's `writtenOff`. Throws
//       InventoryError for an unknown reservation ID.
//     takeForContract(state, facilityId, contractId, productId, quality, quantity):
//         { state, cost, consumed: readonly ReservationId[] }
//       Rule 5: draws from that contract's reservations on the pool first (in ID
//       order), then from unreserved stock, never another holder's reservation.
//       One removal from the pool, so `cost` is allocateRemovalCost of the whole
//       quantity. A reservation drawn to 0 is removed and listed in `consumed`; a
//       partly drawn one keeps its ID with a smaller quantity. Throws
//       InventoryError if the contract's reservations plus unreserved stock fall short.
//     releaseContractReservations(state, contractId): { state, released: readonly ReservationId[] }
//       Rule 7: removes every reservation the contract holds (sorted IDs in
//       `released`); the goods stay in their pools.
//
// The RELEASE_RESERVATION tests inject a CONTRACT-held reservation into a real
// game state (contract reservations come with T02e), so the handler must judge
// the reservation alone and not require its contract to exist in `contracts`.
//
// None of the pure helpers writes the ledger, the event journal, or the ID
// counters: callers stage them with `tx.update` and emit/post through the draft.
//
// Expected to fail until T02a lands: every import above that S0 doesn't export
// yet (registerInventory, storageUsed, checkReservation, takeProduct,
// takeMaterial, consumeReservations, takeForContract,
// releaseContractReservations) is undefined, and S0 has no RELEASE_RESERVATION
// handler or input validation in addProduct/addReservation.

import {
  asId,
  cents,
  compareIds,
  idempotencyKey,
  qualityRank,
  type ContractId,
  type FacilityId,
  type GameCommand,
  type GameState,
  type Money,
  type ProductId,
  type QualityTier,
  type ReservationId,
  type ReservationState,
} from "@eov/contracts";
import {
  BASIC_MOONSHINE_RECIPE,
  CORN,
  DISTILLERY_MAIN,
  FIRST_SHIPMENT_SCENARIO,
  GAME_DATA,
  MILLERS_FEED,
  MOONSHINE,
  SUGAR,
} from "@eov/game-data";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createInitialState, newGame, simulationOptions, SYSTEMS } from "../../src/game/index.ts";
import { allocateId, createSimulation, type KernelSimulation } from "../../src/index.ts";
import {
  addMaterial,
  addProduct,
  addReservation,
  allocateRemovalCost,
  availableMaterial,
  availableProduct,
  checkReservation,
  consumeReservations,
  findMaterialPool,
  findProductPool,
  InventoryError,
  inventoryValue,
  registerInventory,
  releaseContractReservations,
  storageUsed,
  takeForContract,
  takeMaterial,
  takeProduct,
} from "../../src/inventory/index.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SEED = { seed: 1920 } as const;
const F: FacilityId = DISTILLERY_MAIN;
const G: FacilityId = asId("Facility", "test-warehouse");
const P: ProductId = MOONSHINE;
const Q: QualityTier = "basic";
const OTHER_PRODUCT: ProductId = asId("Product", "test-gin");
const CONTRACT_A: ContractId = asId("Contract", "contract-1");
const CONTRACT_B: ContractId = asId("Contract", "contract-2");

const recipe = GAME_DATA.recipes.find((r) => r.id === BASIC_MOONSHINE_RECIPE)!;
const qtyOf = (m: typeof CORN): number => recipe.inputsPerCase.find((i) => i.materialId === m)!.quantity;

/** A fresh First Shipment state for pure pool tests (pool helpers don't touch the ledger). */
const blank = (): GameState => createInitialState(FIRST_SHIPMENT_SCENARIO, GAME_DATA);

let reservationSerial = 0;
function reservation(over: Partial<ReservationState> & Pick<ReservationState, "quantity" | "holder">): ReservationState {
  reservationSerial += 1;
  return {
    id: asId("Reservation", `res-${900 + reservationSerial}`),
    facilityId: F,
    goods: { kind: "PRODUCT", productId: P, quality: Q },
    ...over,
  };
}
const contractHolder = (contractId: ContractId) => ({ kind: "CONTRACT", contractId }) as const;
const jobHolder = { kind: "PRODUCTION_JOB", jobId: asId("ProductionJob", "job-99") } as const;

/** The parts of state the pure helpers must never touch. */
const untouchable = (s: GameState) => ({ ledger: s.ledger, eventJournal: s.eventJournal, counters: s.counters });

function poolCost(s: GameState): Money {
  return cents(inventoryValue(s.productPools) + inventoryValue(s.materialPools));
}

// Simulation fixtures: real commands, so the ledger matches inventory.

function expectApplied(result: ReturnType<KernelSimulation["dispatch"]>): void {
  if (result.status !== "applied") throw new Error(`Expected applied, got ${JSON.stringify(result)}`);
}

function buy(materialId: typeof CORN, quantity: number): GameCommand {
  return { type: "PURCHASE_MATERIALS", supplierId: MILLERS_FEED, materialId, quantity, facilityId: F };
}

/** A game holding `cases` finished basic moonshine cases at the distillery. */
function withCases(cases: number): KernelSimulation {
  const sim = newGame();
  expectApplied(sim.dispatch({ command: buy(CORN, qtyOf(CORN) * cases) }));
  expectApplied(sim.dispatch({ command: buy(SUGAR, qtyOf(SUGAR) * cases) }));
  expectApplied(sim.dispatch({ command: { type: "START_PRODUCTION", facilityId: F, recipeId: BASIC_MOONSHINE_RECIPE, quantity: cases } }));
  sim.advance(recipe.ticksPerCase * cases + 1);
  sim.takeEvents();
  expect(findProductPool(sim.state, F, P, Q)?.quantity).toBe(cases);
  return sim;
}

/** `withCases`, plus a CONTRACT-held reservation of `reserved` cases minted from the counters. */
function withContractReservation(cases: number, reserved: number): { sim: KernelSimulation; reservationId: ReservationId } {
  const base = withCases(cases).state;
  const minted = allocateId(base, "Reservation");
  const state = addReservation(minted.state, {
    id: minted.id,
    facilityId: F,
    goods: { kind: "PRODUCT", productId: P, quality: Q },
    quantity: reserved,
    holder: contractHolder(CONTRACT_A),
  });
  return { sim: createSimulation(state, simulationOptions()), reservationId: minted.id };
}

function release(reservationId: ReservationId): GameCommand {
  return { type: "RELEASE_RESERVATION", reservationId };
}

// ---------------------------------------------------------------------------
// FIN-001 cost formula
// ---------------------------------------------------------------------------

describe("FIN-001 weighted-average cost", () => {
  // @locked
  it("passes the worked example exactly: 20 @ $8 + 30 @ $12, remove 15 → $156, 35 left at $364", () => {
    let s = addProduct(blank(), F, P, Q, 20, cents(20 * 800));
    s = addProduct(s, F, P, Q, 30, cents(30 * 1200));
    expect(findProductPool(s, F, P, Q)).toEqual({ facilityId: F, productId: P, quality: Q, quantity: 50, totalCost: 52_000 });

    const taken = takeProduct(s, F, P, Q, 15);
    expect(taken.cost).toBe(15_600);
    expect(findProductPool(taken.state, F, P, Q)).toEqual({ facilityId: F, productId: P, quality: Q, quantity: 35, totalCost: 36_400 });
    expect(allocateRemovalCost(cents(52_000), 50, 15)).toBe(15_600);
  });

  // @locked
  it("stores total cost, rounds a partial removal half up, and gives the final removal the residue", () => {
    // 3 cases for $10.00: one case is $3.333…, rounded to $3.33; two more are $6.67 (residue).
    let s = addProduct(blank(), F, P, Q, 3, cents(1000));
    const first = takeProduct(s, F, P, Q, 1);
    expect(first.cost).toBe(333);
    expect(findProductPool(first.state, F, P, Q)?.totalCost).toBe(667);
    const last = takeProduct(first.state, F, P, Q, 2);
    expect(last.cost).toBe(667);
    expect(findProductPool(last.state, F, P, Q)).toBeUndefined();
    expect(last.state.productPools).toEqual([]);

    // Exactly half a cent rounds up: 2 units for 1 cent, take 1 → 1 cent, 0 left.
    s = addProduct(blank(), F, P, Q, 2, cents(1));
    const half = takeProduct(s, F, P, Q, 1);
    expect(half.cost).toBe(1);
    expect(findProductPool(half.state, F, P, Q)).toEqual({ facilityId: F, productId: P, quality: Q, quantity: 1, totalCost: 0 });
  });

  // @locked
  it("allocates with BigInt precision for large pools", () => {
    const total = cents(Number.MAX_SAFE_INTEGER - 1);
    const quantity = 1_000_003;
    const expected = cents(Number((BigInt(total) * 7n * 2n + BigInt(quantity)) / (2n * BigInt(quantity))));
    expect(allocateRemovalCost(total, quantity, 7)).toBe(expected);
    const s = addProduct(blank(), F, P, Q, quantity, total);
    expect(takeProduct(s, F, P, Q, 7).cost).toBe(expected);
  });

  // @locked
  it("property: for any adds and removals, removed + remaining cost = added cost, and an emptied pool leaves no residue", () => {
    type Op = { kind: "add"; quantity: number; cost: number } | { kind: "remove"; pick: number } | { kind: "empty" };
    const op: fc.Arbitrary<Op> = fc.oneof(
      fc.record({ kind: fc.constant("add" as const), quantity: fc.integer({ min: 1, max: 5_000 }), cost: fc.integer({ min: 0, max: 50_000_000 }) }),
      fc.record({ kind: fc.constant("remove" as const), pick: fc.nat() }),
      fc.record({ kind: fc.constant("empty" as const) }),
    );
    fc.assert(
      fc.property(fc.array(op, { maxLength: 60 }), fc.boolean(), (ops, material) => {
        let s = blank();
        let added = 0;
        let removed = 0;
        const pool = () => (material ? findMaterialPool(s, F, CORN) : findProductPool(s, F, P, Q));
        for (const o of ops) {
          if (o.kind === "add") {
            s = material ? addMaterial(s, F, CORN, o.quantity, cents(o.cost)) : addProduct(s, F, P, Q, o.quantity, cents(o.cost));
            added += o.cost;
            continue;
          }
          const before = pool();
          if (!before) continue;
          const quantity = o.kind === "empty" ? before.quantity : 1 + (o.pick % before.quantity);
          const taken = material ? takeMaterial(s, F, CORN, quantity) : takeProduct(s, F, P, Q, quantity);
          const expected = quantity === before.quantity ? before.totalCost : allocateRemovalCost(before.totalCost, before.quantity, quantity);
          expect(taken.cost).toBe(expected);
          expect(Number.isSafeInteger(taken.cost) && taken.cost >= 0).toBe(true);
          s = taken.state;
          removed += taken.cost;
          const after = pool();
          if (quantity === before.quantity) {
            expect(after).toBeUndefined();
          } else {
            expect(after?.quantity).toBe(before.quantity - quantity);
            expect(after!.totalCost).toBeGreaterThanOrEqual(0);
            expect(Number.isSafeInteger(after!.totalCost)).toBe(true);
          }
        }
        const remaining = pool()?.totalCost ?? 0;
        expect(removed + remaining).toBe(added);
        expect(poolCost(s)).toBe(remaining);
      }),
      SEED,
    );
  });
});

// ---------------------------------------------------------------------------
// No negatives; uniqueness and order
// ---------------------------------------------------------------------------

describe("pool integrity", () => {
  // @locked
  it("rejects non-positive or non-integer quantities and negative costs", () => {
    const s = blank();
    for (const quantity of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => addProduct(s, F, P, Q, quantity, cents(100))).toThrow(InventoryError);
      expect(() => addMaterial(s, F, CORN, quantity, cents(100))).toThrow(InventoryError);
    }
    expect(() => addProduct(s, F, P, Q, 1, cents(-1))).toThrow(InventoryError);
    expect(() => addMaterial(s, F, CORN, 1, cents(-1))).toThrow(InventoryError);

    const stocked = addMaterial(addProduct(s, F, P, Q, 5, cents(500)), F, CORN, 5, cents(500));
    for (const quantity of [0, -1, 2.5, 6]) {
      expect(() => takeProduct(stocked, F, P, Q, quantity)).toThrow(InventoryError);
      expect(() => takeMaterial(stocked, F, CORN, quantity)).toThrow(InventoryError);
    }
    expect(() => takeProduct(s, F, P, Q, 1)).toThrow(InventoryError);
    expect(() => takeMaterial(s, F, CORN, 1)).toThrow(InventoryError);
  });

  // @locked
  it("property: pools stay unique per key and sorted by (facility, product, quality rank) / (facility, material)", () => {
    const facility = fc.constantFrom(F, G);
    const product = fc.constantFrom(P, OTHER_PRODUCT);
    const quality = fc.constantFrom<QualityTier>("basic", "standard", "premium");
    const material = fc.constantFrom(CORN, SUGAR);
    const op = fc.oneof(
      fc.record({ kind: fc.constant("product" as const), facility, product, quality, quantity: fc.integer({ min: 1, max: 50 }), take: fc.nat() }),
      fc.record({ kind: fc.constant("material" as const), facility, material, quantity: fc.integer({ min: 1, max: 50 }), take: fc.nat() }),
    );
    const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    fc.assert(
      fc.property(fc.array(op, { maxLength: 80 }), (ops) => {
        let s = blank();
        for (const o of ops) {
          if (o.kind === "product") {
            s = addProduct(s, o.facility, o.product, o.quality, o.quantity, cents(o.quantity * 100));
            const pool = findProductPool(s, o.facility, o.product, o.quality)!;
            if (o.take % 3 === 0) s = takeProduct(s, o.facility, o.product, o.quality, 1 + (o.take % pool.quantity)).state;
          } else {
            s = addMaterial(s, o.facility, o.material, o.quantity, cents(o.quantity * 7));
            const pool = findMaterialPool(s, o.facility, o.material)!;
            if (o.take % 3 === 0) s = takeMaterial(s, o.facility, o.material, 1 + (o.take % pool.quantity)).state;
          }
        }
        const pk = s.productPools.map((p) => `${p.facilityId}/${p.productId}/${p.quality}`);
        const mk = s.materialPools.map((p) => `${p.facilityId}/${p.materialId}`);
        expect(new Set(pk).size).toBe(pk.length);
        expect(new Set(mk).size).toBe(mk.length);
        const sortedP = [...s.productPools].sort(
          (a, b) => cmp(a.facilityId, b.facilityId) || cmp(a.productId, b.productId) || qualityRank(a.quality) - qualityRank(b.quality),
        );
        const sortedM = [...s.materialPools].sort((a, b) => cmp(a.facilityId, b.facilityId) || cmp(a.materialId, b.materialId));
        expect(s.productPools).toEqual(sortedP);
        expect(s.materialPools).toEqual(sortedM);
        for (const p of [...s.productPools, ...s.materialPools]) {
          expect(Number.isSafeInteger(p.quantity) && p.quantity > 0).toBe(true);
          expect(Number.isSafeInteger(p.totalCost) && p.totalCost >= 0).toBe(true);
        }
      }),
      SEED,
    );
  });

  // @locked
  it("keeps inventoryValue's signature: the sum of pool total costs", () => {
    let s = addProduct(blank(), F, P, Q, 4, cents(1234));
    s = addProduct(s, G, P, Q, 1, cents(1));
    s = addMaterial(s, F, CORN, 9, cents(900));
    expect(inventoryValue(s.productPools)).toBe(1235);
    expect(inventoryValue(s.materialPools)).toBe(900);
    expect(inventoryValue([])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cargo moves and transfers
// ---------------------------------------------------------------------------

describe("cargo moves", () => {
  // @locked
  it("take returns the CargoLineState cost; put adds goods with that cost to a pool", () => {
    const s = addProduct(addProduct(blank(), F, P, Q, 20, cents(16_000)), F, P, Q, 30, cents(36_000));
    const taken = takeProduct(s, F, P, Q, 15);
    const line = { productId: P, quality: Q, quantity: 15, cost: taken.cost };
    expect(line.cost).toBe(15_600);
    const put = addProduct(taken.state, G, line.productId, line.quality, line.quantity, line.cost);
    expect(findProductPool(put, G, P, Q)).toEqual({ facilityId: G, productId: P, quality: Q, quantity: 15, totalCost: 15_600 });
    expect(poolCost(put)).toBe(52_000);
  });

  // @locked
  it("property: take + put between pools, or out to cargo and back, preserves pool cost plus carried cost", () => {
    const step = fc.record({
      from: fc.constantFrom(F, G),
      to: fc.constantFrom<FacilityId | "cargo">(F, G, "cargo"),
      pick: fc.nat(),
      returnCargo: fc.boolean(),
    });
    fc.assert(
      fc.property(
        fc.array(fc.record({ quantity: fc.integer({ min: 1, max: 500 }), cost: fc.integer({ min: 0, max: 10_000_000 }) }), { minLength: 1, maxLength: 5 }),
        fc.array(step, { maxLength: 40 }),
        (adds, steps) => {
          let s = blank();
          let added = 0;
          for (const a of adds) {
            s = addProduct(s, F, P, Q, a.quantity, cents(a.cost));
            added += a.cost;
          }
          const cargo: { quantity: number; cost: Money }[] = [];
          const carried = () => cargo.reduce((sum, c) => sum + c.cost, 0);
          for (const st of steps) {
            if (st.returnCargo && cargo.length > 0) {
              const line = cargo.shift()!;
              s = addProduct(s, st.from, P, Q, line.quantity, line.cost);
            } else {
              const pool = findProductPool(s, st.from, P, Q);
              if (!pool) continue;
              const quantity = 1 + (st.pick % pool.quantity);
              const taken = takeProduct(s, st.from, P, Q, quantity);
              s = taken.state;
              if (st.to === "cargo") cargo.push({ quantity, cost: taken.cost });
              else s = addProduct(s, st.to, P, Q, quantity, taken.cost);
            }
            expect(poolCost(s) + carried()).toBe(added);
          }
        },
      ),
      SEED,
    );
  });

  // @locked
  it("pure helpers stage nothing themselves: no ledger entries, events, or ID counters", () => {
    const s0 = addMaterial(addProduct(blank(), F, P, Q, 10, cents(1000)), F, CORN, 10, cents(500));
    const r = reservation({ quantity: 3, holder: contractHolder(CONTRACT_A) });
    const j = reservation({ quantity: 2, goods: { kind: "MATERIAL", materialId: CORN }, holder: jobHolder });
    const s1 = addReservation(addReservation(s0, r), j);
    const results: GameState[] = [
      s1,
      takeProduct(s1, F, P, Q, 2).state,
      takeMaterial(s1, F, CORN, 2).state,
      consumeReservations(s1, [j.id]).state,
      takeForContract(s1, F, CONTRACT_A, P, Q, 4).state,
      releaseContractReservations(s1, CONTRACT_A).state,
    ];
    for (const s of results) expect(untouchable(s)).toEqual(untouchable(s0));
  });
});

// ---------------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------------

describe("reservations", () => {
  // @locked
  it("needs 0 < quantity ≤ available, else INSUFFICIENT_STOCK / INSUFFICIENT_MATERIALS", () => {
    let s = addMaterial(addProduct(blank(), F, P, Q, 10, cents(1000)), F, CORN, 8, cents(800));
    const product = { kind: "PRODUCT", productId: P, quality: Q } as const;
    const corn = { kind: "MATERIAL", materialId: CORN } as const;
    s = addReservation(s, reservation({ quantity: 6, holder: contractHolder(CONTRACT_B) }));
    s = addReservation(s, reservation({ quantity: 5, goods: corn, holder: jobHolder }));
    expect(availableProduct(s, F, P, Q)).toBe(4);
    expect(availableMaterial(s, F, CORN)).toBe(3);

    expect(checkReservation(s, F, product, 4)).toBeNull();
    expect(checkReservation(s, F, corn, 3)).toBeNull();
    expect(checkReservation(s, F, product, 5)).toEqual({ code: "INSUFFICIENT_STOCK", productId: P, quality: Q, requested: 5, available: 4 });
    expect(checkReservation(s, F, corn, 4)).toEqual({ code: "INSUFFICIENT_MATERIALS", materialId: CORN, required: 4, available: 3 });
    expect(checkReservation(s, F, { kind: "PRODUCT", productId: P, quality: "premium" }, 1)).toEqual({
      code: "INSUFFICIENT_STOCK",
      productId: P,
      quality: "premium",
      requested: 1,
      available: 0,
    });
    for (const quantity of [0, -2, 1.5]) {
      expect(checkReservation(s, F, product, quantity)).toEqual({ code: "INVALID_QUANTITY", field: "quantity", value: quantity });
    }

    expect(() => addReservation(s, reservation({ quantity: 5, holder: contractHolder(CONTRACT_A) }))).toThrow(InventoryError);
    expect(() => addReservation(s, reservation({ quantity: 0, holder: contractHolder(CONTRACT_A) }))).toThrow(InventoryError);
    expect(() => addReservation(s, reservation({ quantity: 4, goods: corn, holder: jobHolder }))).toThrow(InventoryError);
    const ok = addReservation(s, reservation({ quantity: 4, holder: contractHolder(CONTRACT_A) }));
    expect(availableProduct(ok, F, P, Q)).toBe(0);
    expect(ok.reservations.map((r) => r.id)).toEqual([...ok.reservations.map((r) => r.id)].sort(compareIds));
  });

  // @locked
  it("property: sale/transfer removal takes unreserved stock only, so a reservation can't be sold twice", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 200 }), fc.nat(), fc.nat(), (stock, r, t) => {
        const reserved = 1 + (r % stock);
        const r1 = reservation({ quantity: reserved, holder: contractHolder(CONTRACT_A) });
        const s = addReservation(addProduct(blank(), F, P, Q, stock, cents(stock * 250)), r1);
        const free = stock - reserved;
        expect(availableProduct(s, F, P, Q)).toBe(free);
        expect(() => takeProduct(s, F, P, Q, free + 1)).toThrow(InventoryError);
        if (free > 0) {
          const taken = takeProduct(s, F, P, Q, 1 + (t % free));
          expect(taken.state.reservations).toEqual(s.reservations);
          expect(findProductPool(taken.state, F, P, Q)!.quantity).toBeGreaterThanOrEqual(reserved);
        }
      }),
      SEED,
    );
  });

  // @locked
  it("removal for a holder takes that holder's reservation at weighted-average cost (production failure write-off)", () => {
    // Rule 4: a failed job's inputs are consumed and their cost is the `writtenOff` amount.
    const sim = newGame();
    expectApplied(sim.dispatch({ command: buy(CORN, qtyOf(CORN) * 3) }));
    expectApplied(sim.dispatch({ command: buy(SUGAR, qtyOf(SUGAR) * 3) }));
    expectApplied(sim.dispatch({ command: { type: "START_PRODUCTION", facilityId: F, recipeId: BASIC_MOONSHINE_RECIPE, quantity: 2 } }));
    const s = sim.state;
    const job = s.productionJobs[0]!;
    expect(job.reservationIds.length).toBe(recipe.inputsPerCase.length);

    let expected = 0;
    for (const id of job.reservationIds) {
      const r = s.reservations.find((x) => x.id === id)!;
      if (r.goods.kind !== "MATERIAL") throw new Error("job reserves materials");
      const pool = findMaterialPool(s, F, r.goods.materialId)!;
      expected += allocateRemovalCost(pool.totalCost, pool.quantity, r.quantity);
    }
    const consumed = consumeReservations(s, job.reservationIds);
    expect(consumed.cost).toBe(expected);
    expect(consumed.cost).toBeGreaterThan(0);
    expect(consumed.state.reservations.filter((r) => job.reservationIds.includes(r.id))).toEqual([]);
    for (const m of [CORN, SUGAR]) {
      expect(findMaterialPool(consumed.state, F, m)!.quantity).toBe(qtyOf(m));
      expect(availableMaterial(consumed.state, F, m)).toBe(qtyOf(m));
    }
    expect(poolCost(consumed.state) + consumed.cost).toBe(poolCost(s));
    expect(() => consumeReservations(s, [asId("Reservation", "res-404")])).toThrow(InventoryError);
  });

  // @locked
  it("contract cargo draws its own reservations first, then unreserved stock, never another holder's", () => {
    // 20 cases: A holds 5 + 3, B holds 4; 8 unreserved.
    let s = addProduct(blank(), F, P, Q, 20, cents(20 * 917));
    const a1 = reservation({ id: asId("Reservation", "res-1"), quantity: 5, holder: contractHolder(CONTRACT_A) });
    const a2 = reservation({ id: asId("Reservation", "res-2"), quantity: 3, holder: contractHolder(CONTRACT_A) });
    const b1 = reservation({ id: asId("Reservation", "res-3"), quantity: 4, holder: contractHolder(CONTRACT_B) });
    s = addReservation(addReservation(addReservation(s, a1), a2), b1);

    // Partial draw: res-1 is consumed, res-2 keeps its ID with a smaller quantity.
    const partial = takeForContract(s, F, CONTRACT_A, P, Q, 6);
    expect(partial.consumed).toEqual([a1.id]);
    expect(partial.cost).toBe(allocateRemovalCost(cents(20 * 917), 20, 6));
    expect(partial.state.reservations).toEqual([{ ...a2, quantity: 2 }, b1]);
    expect(availableProduct(partial.state, F, P, Q)).toBe(8);

    // Over-delivery: all of A's 8, then 4 unreserved; B's 4 untouched.
    const over = takeForContract(s, F, CONTRACT_A, P, Q, 12);
    expect(over.consumed).toEqual([a1.id, a2.id]);
    expect(over.state.reservations).toEqual([b1]);
    expect(findProductPool(over.state, F, P, Q)!.quantity).toBe(8);
    expect(availableProduct(over.state, F, P, Q)).toBe(4);
    expect(poolCost(over.state) + over.cost).toBe(20 * 917);

    // More than A's reservations plus unreserved stock (8 + 8) would need B's.
    expect(() => takeForContract(s, F, CONTRACT_A, P, Q, 17)).toThrow(InventoryError);
    // A contract with no reservation draws unreserved stock only.
    const none = takeForContract(s, F, asId("Contract", "contract-9"), P, Q, 8);
    expect(none.consumed).toEqual([]);
    expect(none.state.reservations).toEqual(s.reservations);
    expect(() => takeForContract(s, F, asId("Contract", "contract-9"), P, Q, 9)).toThrow(InventoryError);
  });

  // @locked
  it("returned cargo goes back into its pool unreserved (rule 6)", () => {
    let s = addProduct(blank(), F, P, Q, 10, cents(10_000));
    const a1 = reservation({ quantity: 6, holder: contractHolder(CONTRACT_A) });
    s = addReservation(s, a1);
    const out = takeForContract(s, F, CONTRACT_A, P, Q, 6);
    expect(out.consumed).toEqual([a1.id]);
    const back = addProduct(out.state, F, P, Q, 6, out.cost);
    expect(back.reservations).toEqual([]);
    expect(availableProduct(back, F, P, Q)).toBe(10);
    expect(findProductPool(back, F, P, Q)).toEqual({ facilityId: F, productId: P, quality: Q, quantity: 10, totalCost: 10_000 });
  });

  // @locked
  it("a contract ending releases its remaining reservations; the goods stay (rule 7)", () => {
    let s = addProduct(blank(), F, P, Q, 10, cents(10_000));
    const a2 = reservation({ id: asId("Reservation", "res-12"), quantity: 2, holder: contractHolder(CONTRACT_A) });
    const a1 = reservation({ id: asId("Reservation", "res-2"), quantity: 3, holder: contractHolder(CONTRACT_A) });
    const b1 = reservation({ id: asId("Reservation", "res-7"), quantity: 4, holder: contractHolder(CONTRACT_B) });
    s = addReservation(addReservation(addReservation(s, a2), a1), b1);
    const ended = releaseContractReservations(s, CONTRACT_A);
    expect(ended.released).toEqual([a1.id, a2.id]);
    expect(ended.state.reservations).toEqual([b1]);
    expect(ended.state.productPools).toEqual(s.productPools);
    expect(availableProduct(ended.state, F, P, Q)).toBe(6);
    expect(releaseContractReservations(ended.state, CONTRACT_A).released).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

describe("storageUsed", () => {
  // @locked
  it("counts finished-goods cases at the facility, reserved included, materials excluded", () => {
    let s = addProduct(blank(), F, P, Q, 7, cents(700));
    s = addProduct(s, F, P, "premium", 2, cents(900));
    s = addProduct(s, F, OTHER_PRODUCT, Q, 3, cents(300));
    s = addProduct(s, G, P, Q, 50, cents(5000));
    s = addMaterial(s, F, CORN, 400, cents(4000));
    s = addReservation(s, reservation({ quantity: 5, holder: contractHolder(CONTRACT_A) }));
    expect(storageUsed(s, F)).toBe(12);
    expect(storageUsed(s, G)).toBe(50);
    expect(storageUsed(blank(), F)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// RELEASE_RESERVATION through the simulation and the coordinator
// ---------------------------------------------------------------------------

describe("RELEASE_RESERVATION", () => {
  // @locked
  it("is handled by registerInventory, listed in SYSTEMS", () => {
    expect(typeof registerInventory).toBe("function");
    expect(SYSTEMS.filter((s) => s.register === registerInventory).map((s) => s.name)).toEqual(["inventory (T02a)"]);
  });

  // @locked
  it("releases a contract-held reservation as a RESERVATION transaction with no entries, and emits PLAYER", () => {
    const { sim, reservationId } = withContractReservation(4, 3);
    expect(availableProduct(sim.state, F, P, Q)).toBe(1);
    const poolsBefore = sim.state.productPools;
    const txCount = sim.state.ledger.transactions.length;

    expectApplied(sim.dispatch({ command: release(reservationId) }));

    const s = sim.state;
    expect(s.reservations.find((r) => r.id === reservationId)).toBeUndefined();
    expect(s.productPools).toEqual(poolsBefore);
    expect(availableProduct(s, F, P, Q)).toBe(4);
    expect(storageUsed(s, F)).toBe(4);

    expect(s.ledger.transactions.length).toBe(txCount + 1);
    const tx = s.ledger.transactions.at(-1)!;
    expect(tx.kind).toBe("RESERVATION");
    expect(tx.entries).toEqual([]);
    expect(tx.idempotencyKey).toBe(idempotencyKey("RESERVATION", reservationId, "RELEASE"));

    const events = sim.takeEvents().filter((e) => e.type === "RESERVATION_RELEASED");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "RESERVATION_RELEASED", reservationId, reason: "PLAYER" });
    expect(tx.eventIds).toContain(events[0]!.id);
  });

  // @locked
  it("rejects a missing reservation, a job-held one, and a second release with RESERVATION_NOT_ACTIVE, leaving the state hash unchanged", () => {
    const expectNotActive = (sim: KernelSimulation, reservationId: ReservationId): void => {
      sim.takeEvents();
      const hash = sim.stateHash();
      const result = sim.dispatch({ command: release(reservationId) });
      expect(result).toMatchObject({ status: "rejected", reason: { code: "RESERVATION_NOT_ACTIVE", reservationId } });
      expect(sim.stateHash()).toBe(hash);
      expect(sim.takeEvents()).toEqual([]);
    };

    const { sim, reservationId } = withContractReservation(2, 2);
    expectNotActive(sim, asId("Reservation", "res-404"));
    expectApplied(sim.dispatch({ command: release(reservationId) }));
    expectNotActive(sim, reservationId);

    // A production job's inputs are committed: the player can't release them.
    const job = newGame();
    expectApplied(job.dispatch({ command: buy(CORN, qtyOf(CORN)) }));
    expectApplied(job.dispatch({ command: buy(SUGAR, qtyOf(SUGAR)) }));
    expectApplied(job.dispatch({ command: { type: "START_PRODUCTION", facilityId: F, recipeId: BASIC_MOONSHINE_RECIPE, quantity: 1 } }));
    const held = job.state.reservations.find((r) => r.holder.kind === "PRODUCTION_JOB")!;
    expectNotActive(job, held.id);
    expect(job.state.reservations).toContainEqual(held);
  });
});
