// T05f (#105): the insolvency rule's "no goods" over transfers (ADR 0020
// decision 10; #114 follow-up). A transfer that couldn't unload everything is
// FAILED with its leftovers riding home; like a fallen-through sale, that cargo
// blocks LOST. No transfer can happen in M001 (the warehouse isn't owned,
// decision 13), so the fixture owns it through a scenario that lists it.

import { cents, idempotencyKey, type FacilityId, type GameCommand, type GameState, type LedgerEntry } from "@eov/contracts";
import { DISTILLERY_MAIN, FIRST_SHIPMENT_SCENARIO, GAME_DATA, MODEL_TT_TRUCK, MOONSHINE, RIVERSIDE_WAREHOUSE, type ScenarioDefinition } from "@eov/game-data";
import { describe, expect, it } from "vitest";
import { accountBalances, createCoordinator, createSimulation, newGame, simulationOptions, type GameSetup } from "../../src/index.ts";
import { addProduct } from "../../src/inventory/index.ts";
import { hasNoGoods, isInsolvent } from "../../src/progression/insolvency.ts";

const OWNS_WAREHOUSE: ScenarioDefinition = {
  ...FIRST_SHIPMENT_SCENARIO,
  facilities: [...FIRST_SHIPMENT_SCENARIO.facilities, { id: RIVERSIDE_WAREHOUSE, equipmentIds: [], workerCount: 0 }],
};
const SETUP: GameSetup = { scenario: OWNS_WAREHOUSE };

function fixture(state: GameState, entries: readonly LedgerEntry[], change: (s: GameState) => GameState = (s) => s): GameState {
  const tx = createCoordinator().begin(state, {
    kind: "OPENING_BALANCE",
    idempotencyKey: idempotencyKey("OPENING_BALANCE", "fixture", state.ledger.transactions.length),
    tick: state.tick,
    causedBy: null,
  });
  if (tx.status === "duplicate") throw new Error("Fixture key collision");
  tx.update(change);
  if (entries.length > 0) tx.post(entries);
  const result = tx.commit();
  if (result.status !== "committed") throw new Error(`Fixture rejected: ${JSON.stringify(result.reason)}`);
  return result.state;
}

function withStock(state: GameState, facilityId: FacilityId, quantity: number): GameState {
  const cost = cents(700 * quantity);
  return fixture(
    state,
    [
      { account: "FINISHED_GOODS", side: "DEBIT", amount: cost },
      { account: "OWNER_EQUITY", side: "CREDIT", amount: cost },
    ],
    (s) => addProduct(s, facilityId, MOONSHINE, "basic", quantity, cost),
  );
}

function withoutCash(state: GameState): GameState {
  const cash = cents(accountBalances(state.ledger.transactions).CASH);
  if (cash === 0) return state;
  return fixture(state, [
    { account: "OWNER_EQUITY", side: "DEBIT", amount: cash },
    { account: "CASH", side: "CREDIT", amount: cash },
  ]);
}

const transfer = (quantity: number): GameCommand => ({
  type: "DISPATCH_DELIVERY",
  vehicleId: MODEL_TT_TRUCK,
  cargo: [{ productId: MOONSHINE, quality: "basic", quantity }],
  purpose: { kind: "TRANSFER", destinationFacilityId: RIVERSIDE_WAREHOUSE },
  routeId: null,
  driver: { kind: "FOUNDER" },
});

/** Empties every product pool (the pure rule reads only state, so no ledger is needed here). */
const withoutPools = (state: GameState): GameState => ({ ...state, productPools: state.productPools.map((p) => ({ ...p, quantity: 0 })) });

describe("T05f insolvency: no goods, with transfers (decision 10)", () => {
  it("a FAILED transfer still carrying its leftovers home blocks it, like a fallen-through sale; once the cargo is off the truck it doesn't", () => {
    // The warehouse is full, so nothing unloads and all three cases ride home.
    const spec = GAME_DATA.facilityProduction.find((f) => f.facilityId === RIVERSIDE_WAREHOUSE)!;
    let state = withStock(withStock(newGame(SETUP).state, DISTILLERY_MAIN, 3), RIVERSIDE_WAREHOUSE, spec.baseStorage);
    const sim = createSimulation(state, simulationOptions(SETUP));
    const sent = sim.dispatch({ command: transfer(3) });
    expect(sent.status).toBe("applied");
    sim.advance(sim.state.vehicles[0]!.trip!.arrivesAt - sim.state.tick);
    state = sim.state;
    expect(state.deliveries[0]).toMatchObject({ status: "FAILED", cargo: [{ quantity: 3 }] });
    expect(state.vehicles[0]!.trip).toMatchObject({ leg: "RETURN" });

    const broke = withoutPools(withoutCash(state));
    expect(hasNoGoods(broke)).toBe(false);
    expect(isInsolvent(broke, GAME_DATA)).toBe(false);

    // Control: the same state with the leftovers gone is insolvent.
    const unloaded: GameState = { ...broke, deliveries: broke.deliveries.map((d) => ({ ...d, cargo: [] })) };
    expect(hasNoGoods(unloaded)).toBe(true);
    expect(isInsolvent(unloaded, GAME_DATA)).toBe(true);
  });

  it("a DELIVERED transfer keeps its cargo but doesn't count as goods", () => {
    const state = withStock(newGame(SETUP).state, DISTILLERY_MAIN, 2);
    const sim = createSimulation(state, simulationOptions(SETUP));
    expect(sim.dispatch({ command: transfer(2) }).status).toBe("applied");
    sim.advance(sim.state.vehicles[0]!.trip!.arrivesAt - sim.state.tick);
    const delivered = sim.state.deliveries[0]!;
    expect(delivered.status).toBe("DELIVERED");
    expect(delivered.cargo.reduce((n, l) => n + l.quantity, 0)).toBe(2);

    const broke = withoutPools(withoutCash(sim.state));
    expect(hasNoGoods(broke)).toBe(true);
    expect(isInsolvent(broke, GAME_DATA)).toBe(true);
  });
});
