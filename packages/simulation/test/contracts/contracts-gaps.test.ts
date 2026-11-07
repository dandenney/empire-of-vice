// T05h (issue #107): the ECO-001 contract test gaps the T02e review (#79) found.
// Each test below is aimed at one mutant that survived the T02e suite:
//
// 1. The reservation top-up target subtracts cases already delivered to the
//    current installment (ADR 0018 decision 4; `src/contracts/rules.ts`).
// 2. Closed contracts that end on the same deadline fall back to ID, latest
//    first (`src/contracts/projection.ts`, the closed-list sort).
// 3. `inTransit` attributes outbound cases in `arrivesAt` order, then delivery
//    ID (decision 6; `src/contracts/projection.ts`, the arrivals sort).
//    This mutant is equivalent: `creditCases` fills the lowest open installment
//    whose deadline is still >= the arrival tick, and those sets are suffixes of
//    the installment list, so the per-installment totals come out the same in
//    any processing order. Test 3 pins the attribution for loads that arrive
//    out of ID order across a deadline, but no test can kill the sort mutant.
//
// Everything is played through the Simulation (commands, ticks, snapshots).
// Stock is booked through a fixture coordinator transaction so the ledger
// matches inventory. Gameplay numbers come from game-data and state.

import {
  asId,
  cents,
  compareIds,
  idempotencyKey,
  TICKS_PER_DAY,
  type BuyerId,
  type CommandResult,
  type ContractId,
  type GameCommand,
  type GameState,
  type QualityTier,
  type RouteId,
  type VehicleId,
} from "@eov/contracts";
import {
  COUNTY_ROAD,
  DISTILLERY_MAIN,
  FIRST_SHIPMENT_SCENARIO,
  GAME_DATA,
  KESSLER_BACK_ROAD,
  KESSLERS_BACK_ROOM,
  LAKEVIEW_HOTEL,
  MODEL_TT_TRUCK,
  MOONSHINE,
  type GameData,
} from "@eov/game-data";
import { describe, expect, it } from "vitest";
import { createCoordinator, createSimulation, newGame, simulationOptions, type GameSetup, type KernelSimulation } from "../../src/index.ts";
import { addProduct } from "../../src/inventory/index.ts";

const DAY = TICKS_PER_DAY;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expectApplied(result: CommandResult): void {
  if (result.status !== "applied") throw new Error(`Expected applied, got ${JSON.stringify(result)}`);
}

function advanceTo(sim: KernelSimulation, target: number): void {
  if (target < sim.state.tick) throw new Error(`Can't go back from ${sim.state.tick} to ${target}`);
  sim.advance(target - sim.state.tick);
}

/** `quantity` finished moonshine at the distillery, booked against owner equity. */
function withStock(state: GameState, quality: QualityTier, quantity: number): GameState {
  const cost = cents(700 * quantity);
  const tx = createCoordinator().begin(state, {
    kind: "OPENING_BALANCE",
    idempotencyKey: idempotencyKey("OPENING_BALANCE", "fixture", state.ledger.transactions.length),
    tick: state.tick,
    causedBy: null,
  });
  if (tx.status === "duplicate") throw new Error("Fixture key collision");
  tx.update((s) => addProduct(s, DISTILLERY_MAIN, MOONSHINE, quality, quantity, cost));
  tx.post([
    { account: "FINISHED_GOODS", side: "DEBIT", amount: cost },
    { account: "OWNER_EQUITY", side: "CREDIT", amount: cost },
  ]);
  const result = tx.commit();
  if (result.status !== "committed") throw new Error(`Fixture rejected: ${JSON.stringify(result.reason)}`);
  return result.state;
}

/** A new game, optionally with `basic` cases of stock booked before the first tick. */
function start(setup: GameSetup, basic = 0): KernelSimulation {
  const sim = newGame(setup);
  return basic > 0 ? createSimulation(withStock(sim.state, "basic", basic), simulationOptions(setup)) : sim;
}

/** Accepts `buyerId`'s open offer and returns the new contract's ID. */
function accept(sim: KernelSimulation, buyerId: BuyerId): ContractId {
  const offer = sim.state.contractOffers.find((o) => o.buyerId === buyerId);
  if (!offer) throw new Error(`No open offer for ${buyerId} at tick ${sim.state.tick}`);
  expectApplied(sim.dispatch({ command: { type: "ACCEPT_CONTRACT", contractOfferId: offer.id } }));
  const contract = sim.state.contracts.find((c) => c.offerId === offer.id);
  if (!contract) throw new Error("Accepting didn't create a contract");
  return contract.id;
}

function deliver(contractId: ContractId, quantity: number, routeId: RouteId | null, vehicleId: VehicleId = MODEL_TT_TRUCK): GameCommand {
  return {
    type: "DISPATCH_DELIVERY",
    vehicleId,
    cargo: [{ productId: MOONSHINE, quality: "basic", quantity }],
    purpose: { kind: "CONTRACT_INSTALLMENT", contractId },
    routeId,
  };
}

const routeDuration = (routeId: RouteId) => GAME_DATA.routes.find((r) => r.id === routeId)!.durationTicks;

/** Dispatches so the outbound leg arrives exactly at `arrival` (the command applies at arrival − duration). */
function dispatchArrivingAt(sim: KernelSimulation, contractId: ContractId, quantity: number, routeId: RouteId, arrival: number, vehicleId?: VehicleId) {
  advanceTo(sim, arrival - routeDuration(routeId) - 1);
  expectApplied(sim.dispatch({ command: deliver(contractId, quantity, routeId, vehicleId) }));
  const delivery = sim.state.deliveries.at(-1)!;
  expect(sim.state.vehicles.find((v) => v.trip?.deliveryId === delivery.id)!.trip!.arrivesAt).toBe(arrival);
  return delivery;
}

const contractOf = (sim: KernelSimulation, id: ContractId) => sim.state.contracts.find((c) => c.id === id)!;

const reservedFor = (state: GameState, contractId: ContractId) =>
  state.reservations.filter((r) => r.holder.kind === "CONTRACT" && r.holder.contractId === contractId).reduce((n, r) => n + r.quantity, 0);

const SECOND_TRUCK = asId("Vehicle", "fixture-second-truck");

/** Game-data and scenario with a second truck (same definition as the first). */
function twoTruckSetup(): GameSetup {
  const truck = GAME_DATA.vehicles.find((v) => v.id === MODEL_TT_TRUCK)!;
  const data: GameData = { ...GAME_DATA, vehicles: [...GAME_DATA.vehicles, { ...truck, id: SECOND_TRUCK }] };
  return { data, scenario: { ...FIRST_SHIPMENT_SCENARIO, vehicleIds: [...FIRST_SHIPMENT_SCENARIO.vehicleIds, SECOND_TRUCK] } };
}

// ---------------------------------------------------------------------------
// 1. Top-up target subtracts delivered cases (decision 4)
// ---------------------------------------------------------------------------

describe("ECO-001 contracts: reservation top-up after settlement", () => {
  it("reserves required − delivered − reserved for the next installment when cases already reached it", () => {
    const sim = start({}, 40);
    advanceTo(sim, DAY);
    const contractId = accept(sim, KESSLERS_BACK_ROOM);
    const [first, second] = contractOf(sim, contractId).installments;
    const required = first!.required;
    const early = Math.floor(required / 2) + 1; // cases that spill into the second installment, short of filling it
    expect(early).toBeLessThan(second!.required);

    // One load arrives before the first deadline: it fills the first installment and spills `early` into the second.
    dispatchArrivingAt(sim, contractId, required + early, COUNTY_ROAD, first!.deadline - 100);
    advanceTo(sim, first!.deadline - 1);
    expect(contractOf(sim, contractId).installments.map((i) => i.delivered)).toEqual([required, early, 0]);
    expect(reservedFor(sim.state, contractId)).toBe(0);

    // Settling the first installment tops up toward the second: only what it still lacks.
    advanceTo(sim, first!.deadline);
    const contract = contractOf(sim, contractId);
    expect(contract.installments.map((i) => i.outcome)).toEqual(["FULFILLED", null, null]);
    expect(reservedFor(sim.state, contractId)).toBe(second!.required - early);
    expect(sim.snapshot().contracts.active[0]!.reservedQuantity).toBe(second!.required - early);
  });
});

// ---------------------------------------------------------------------------
// 2. Closed contracts: same last deadline falls back to ID, latest first
// ---------------------------------------------------------------------------

describe("ECO-001 contracts: closed-list order", () => {
  it("lists contracts that end on the same deadline by ID, latest first", () => {
    const lakeview = GAME_DATA.buyers.find((b) => b.id === LAKEVIEW_HOTEL)!;
    const scenario = { ...FIRST_SHIPMENT_SCENARIO, family: { ...FIRST_SHIPMENT_SCENARIO.family, reputation: lakeview.minimumReputation } };
    const sim = start({ scenario });
    advanceTo(sim, DAY);
    // Both offers are made at the same midnight, so both contracts share every deadline.
    const kesslers = accept(sim, KESSLERS_BACK_ROOM);
    const lakeviewContract = accept(sim, LAKEVIEW_HOTEL);
    const last = contractOf(sim, kesslers).installments.at(-1)!.deadline;
    expect(contractOf(sim, lakeviewContract).installments.at(-1)!.deadline).toBe(last);
    expect(sim.state.contracts.map((c) => c.id)).toEqual([kesslers, lakeviewContract]); // state holds them in ID order

    advanceTo(sim, last);
    const { active, closed } = sim.snapshot().contracts;
    expect(active).toEqual([]);
    expect(closed.map((c) => c.id)).toEqual([lakeviewContract, kesslers]);
  });
});

// ---------------------------------------------------------------------------
// 3. inTransit: arrivals in arrivesAt order, then delivery ID (decision 6)
// ---------------------------------------------------------------------------

describe("ECO-001 contracts: in-transit attribution", () => {
  it("attributes two loads whose arrival order differs from their ID order as if each arrived at its arrivesAt", () => {
    const sim = start(twoTruckSetup(), 40);
    advanceTo(sim, DAY);
    const contractId = accept(sim, KESSLERS_BACK_ROOM);
    const [first, second] = contractOf(sim, contractId).installments;
    const late = first!.required + 2; // arrives after the first deadline: fills the second installment, spills 2 into the third
    const early = first!.required - 2; // arrives before it: part of the first installment

    // The slow safe road is dispatched first (lower delivery ID) but arrives after the first deadline;
    // the faster back road is dispatched later (higher ID) and arrives before it.
    const slow = dispatchArrivingAt(sim, contractId, late, COUNTY_ROAD, first!.deadline + 10);
    const fast = dispatchArrivingAt(sim, contractId, early, KESSLER_BACK_ROAD, first!.deadline - 10, SECOND_TRUCK);
    expect(compareIds(slow.id, fast.id)).toBeLessThan(0);
    expect(sim.state.deliveries.filter((d) => d.status === "OUTBOUND").map((d) => d.id)).toEqual([slow.id, fast.id]);

    const installments = sim.snapshot().contracts.active[0]!.installments;
    expect(installments.map((i) => i.inTransit)).toEqual([early, second!.required, late - second!.required]);
    expect(installments.map((i) => i.delivered)).toEqual([0, 0, 0]);
  });
});
