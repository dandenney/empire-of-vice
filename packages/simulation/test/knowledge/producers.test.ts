// The producer table at run time (K1 review follow-up 1, folded into SK1b #199):
// every transaction a played game posts names a registered producer, with a
// leg (CASH, NON_CASH or NO_ENTRIES) its row allows and the trigger its row
// claims. The contracts' coverage test checks the table against the
// `idempotencyKey(...)` call sites; this checks it against what the systems
// actually post, over reference plays with founder rules off (the M001 First
// Shipment with its scheduled setbacks) and on.
//
// Triggers are checked by the unit of work that posted the transaction: a
// dispatch (an eager command) may post only FOUNDER_COMMAND producers, a tick
// (with no queued commands in these plays) only WORLD and AGREED_CHARGE ones,
// and game creation only GAME_CREATION ones.

import {
  cents,
  TICKS_PER_DAY,
  tick,
  TRANSACTION_PRODUCERS,
  transactionProducerOf,
  type BookLeg,
  type CommandRequest,
  type CommandResult,
  type GameState,
  type LedgerTransaction,
  type LocationId,
  type ProducerTrigger,
} from "@eov/contracts";
import {
  BASIC_MOONSHINE_RECIPE,
  CORN,
  CROSSROADS,
  CROSSROADS_ROADHOUSE,
  DISTILLERY_MAIN,
  FIRST_SHIPMENT_SCENARIO,
  HOLLOW_CREEK,
  KESSLER_PHARMACY,
  KESSLERS_BACK_ROOM,
  MILLERS_FEED,
  MILLERS_FEED_LOCATION,
  MODEL_TT_TRUCK,
  MOONSHINE,
  START_WAKE_TICK,
  SUGAR,
  type ScenarioDefinition,
  type ScenarioScheduledEvent,
} from "@eov/game-data";
import { describe, expect, it } from "vitest";
import { isOpenAt } from "../../src/founder/time.ts";
import { newGame, type KernelSimulation } from "../../src/index.ts";

/** A setback on the second day, so the plays reach the shakedown's producer too. */
const SHAKEDOWN: ScenarioScheduledEvent = { kind: "SHAKEDOWN", tick: tick(TICKS_PER_DAY + 600), reason: "RIVAL", netWorthSharePpm: 50_000 };

type Unit = "CREATION" | "COMMAND" | "TICK";

const ALLOWED: Readonly<Record<Unit, readonly ProducerTrigger[]>> = {
  CREATION: ["GAME_CREATION"],
  COMMAND: ["FOUNDER_COMMAND"],
  TICK: ["WORLD", "AGREED_CHARGE"],
};

function legOf(t: LedgerTransaction): BookLeg {
  if (t.entries.length === 0) return "NO_ENTRIES";
  return t.entries.some((e) => e.account === "CASH") ? "CASH" : "NON_CASH";
}

/** Wraps a simulation so every transaction is checked against its producer row, by the unit that posted it. */
class Checked {
  readonly seen = new Map<string, Set<BookLeg>>();
  constructor(readonly sim: KernelSimulation) {
    this.#check(0, "CREATION");
  }

  #check(from: number, unit: Unit): void {
    for (const t of this.sim.state.ledger.transactions.slice(from)) {
      const producer = transactionProducerOf(t.idempotencyKey);
      expect(producer, `${t.id}: ${t.idempotencyKey} has no registered producer`).not.toBeNull();
      const row = TRANSACTION_PRODUCERS[producer!];
      const leg = legOf(t);
      expect(row.legs as readonly BookLeg[], `${t.idempotencyKey}: leg ${leg}`).toContain(leg);
      expect(ALLOWED[unit], `${t.idempotencyKey}: trigger ${row.trigger}, posted by a ${unit}`).toContain(row.trigger);
      const legs = this.seen.get(producer!) ?? new Set<BookLeg>();
      legs.add(leg);
      this.seen.set(producer!, legs);
    }
  }

  get state(): GameState {
    return this.sim.state;
  }

  dispatch(request: CommandRequest): CommandResult {
    const from = this.sim.state.ledger.transactions.length;
    const result = this.sim.dispatch(request);
    this.#check(from, "COMMAND");
    return result;
  }

  advance(ticks: number): void {
    for (let i = 0; i < ticks; i++) {
      const from = this.sim.state.ledger.transactions.length;
      this.sim.advance(1);
      this.#check(from, "TICK");
    }
  }
}

const buy = (materialId: typeof CORN, quantity: number): CommandRequest => ({
  command: { type: "PURCHASE_MATERIALS", supplierId: MILLERS_FEED, materialId, quantity, facilityId: DISTILLERY_MAIN },
});
const produce = (quantity: number): CommandRequest => ({
  command: { type: "START_PRODUCTION", facilityId: DISTILLERY_MAIN, recipeId: BASIC_MOONSHINE_RECIPE, quantity },
});

function quote(state: GameState): number {
  return state.buyers.find((b) => b.id === CROSSROADS_ROADHOUSE)!.wants.find((w) => w.productId === MOONSHINE)!.unitPrice;
}

function stock(state: GameState): number {
  const pool = state.productPools.find((p) => p.facilityId === DISTILLERY_MAIN && p.productId === MOONSHINE && p.quality === "basic");
  const reserved = state.reservations.filter((r) => r.facilityId === DISTILLERY_MAIN && r.goods.kind === "PRODUCT").reduce((n, r) => n + r.quantity, 0);
  return (pool?.quantity ?? 0) - reserved;
}

function dispatchSale(c: Checked, quantity: number, riding: boolean): CommandResult {
  const deal = c.state.heldDeals.at(-1);
  if (!deal) throw new Error("no deal");
  return c.dispatch({
    command: {
      type: "DISPATCH_DELIVERY",
      vehicleId: MODEL_TT_TRUCK,
      cargo: [{ productId: MOONSHINE, quality: "basic", quantity }],
      purpose: { kind: "SALE", buyerId: CROSSROADS_ROADHOUSE, dealId: deal.id },
      routeId: null,
      driver: riding ? { kind: "FOUNDER" } : null,
    },
  });
}

describe("transaction producers at run time (ADR 0021 decisions 6 and 7)", () => {
  it("the M001 First Shipment, with its scheduled setbacks: every posting matches its producer row", () => {
    const c = new Checked(newGame({ scenario: { ...FIRST_SHIPMENT_SCENARIO, scheduledEvents: [...FIRST_SHIPMENT_SCENARIO.scheduledEvents, SHAKEDOWN] } }));
    for (let day = 0; day < 16; day++) {
      c.dispatch(buy(CORN, 6));
      c.dispatch(buy(SUGAR, 3));
      c.dispatch(produce(3));
      const offer = c.state.contractOffers.at(-1);
      if (offer && c.state.contracts.every((k) => k.status !== "ACTIVE")) c.dispatch({ command: { type: "ACCEPT_CONTRACT", contractOfferId: offer.id } });
      c.advance(TICKS_PER_DAY / 2);
      const active = c.state.contracts.find((k) => k.status === "ACTIVE");
      if (active && c.state.vehicles[0]!.trip === null) {
        c.dispatch({
          command: {
            type: "DISPATCH_DELIVERY",
            vehicleId: MODEL_TT_TRUCK,
            cargo: [{ productId: active.productId, quality: "basic", quantity: active.quantityPerInstallment }],
            purpose: { kind: "CONTRACT_INSTALLMENT", contractId: active.id },
            routeId: null,
            driver: null,
          },
        });
      }
      if (stock(c.state) > 0 && c.state.vehicles[0]!.trip === null) {
        c.dispatch({ command: { type: "AGREE_DEAL", buyerId: CROSSROADS_ROADHOUSE, productId: MOONSHINE, quality: "basic", quantity: 1, agreedUnitPrice: cents(quote(c.state)) } });
        dispatchSale(c, 1, false);
      }
      c.advance(TICKS_PER_DAY / 2);
    }
    // The play reached the world's producers with money lines, not only the founder's.
    for (const producer of ["SALE", "VEHICLE_RETURN", "PRODUCTION", "INSTALLMENT_SETTLEMENT", "DAILY_SETTLEMENT:WAGES", "LOSS:SHAKEDOWN"]) {
      expect([...c.seen.keys()], producer).toContain(producer);
    }
  });

  it("the First Shipment under founder rules: every posting matches its producer row", () => {
    const scenario: ScenarioDefinition = { ...FIRST_SHIPMENT_SCENARIO, scheduledEvents: [...FIRST_SHIPMENT_SCENARIO.scheduledEvents, SHAKEDOWN], founderRules: true, realMsPerGameHourAt1x: 20_000 };
    const c = new Checked(newGame({ scenario }));
    const free = (): boolean => c.state.founder.whereabouts.kind === "PRESENT" && c.state.founder.whereabouts.busy === null;
    const at = (l: LocationId): boolean => c.state.founder.whereabouts.kind === "PRESENT" && c.state.founder.whereabouts.locationId === l;
    const waitFor = (done: () => boolean, max: number): void => {
      for (let i = 0; i < max && !done(); i++) c.advance(1);
    };
    const walk = (to: LocationId): void => {
      waitFor(free, 2 * TICKS_PER_DAY);
      if (at(to)) return;
      c.dispatch({ command: { type: "TRAVEL", destinationLocationId: to, transport: { kind: "FOOT" }, via: null } });
      waitFor(() => at(to) && free(), 3 * TICKS_PER_DAY);
    };
    const open = (l: LocationId): void => waitFor(() => free() && isOpenAt(l, c.state.tick) && isOpenAt(l, tick(c.state.tick + 1)), 2 * TICKS_PER_DAY);
    waitFor(free, START_WAKE_TICK + 2);
    for (let round = 0; round < 3; round++) {
      walk(MILLERS_FEED_LOCATION);
      open(MILLERS_FEED_LOCATION);
      c.dispatch(buy(CORN, 8));
      waitFor(free, TICKS_PER_DAY);
      c.dispatch(buy(SUGAR, 4));
      walk(HOLLOW_CREEK);
      c.dispatch(produce(4));
      waitFor(() => free() && c.state.productionJobs.length === 0, 4 * TICKS_PER_DAY);
      if (round === 0) {
        walk(KESSLER_PHARMACY);
        open(KESSLER_PHARMACY);
        const offer = c.state.contractOffers.filter((o) => o.buyerId === KESSLERS_BACK_ROOM).at(-1);
        if (offer) c.dispatch({ command: { type: "ACCEPT_CONTRACT", contractOfferId: offer.id } });
      }
      walk(CROSSROADS);
      open(CROSSROADS);
      c.dispatch({ command: { type: "AGREE_DEAL", buyerId: CROSSROADS_ROADHOUSE, productId: MOONSHINE, quality: "basic", quantity: 1, agreedUnitPrice: cents(quote(c.state)) } });
      walk(HOLLOW_CREEK);
      dispatchSale(c, 1, true);
      waitFor(() => at(HOLLOW_CREEK) && free() && c.state.vehicles[0]!.trip === null, 2 * TICKS_PER_DAY);
      c.dispatch({ command: { type: "REST", untilTick: tick(c.state.tick + 1 + 8 * 60) } });
      waitFor(free, TICKS_PER_DAY);
    }
    for (const producer of ["SALE", "VEHICLE_RETURN", "PRODUCTION", "INSTALLMENT_SETTLEMENT", "PRODUCTION_START", "DAILY_SETTLEMENT:DEAL_AGREED", "LOSS:SHAKEDOWN"]) {
      expect([...c.seen.keys()], producer).toContain(producer);
    }
    // The prepaid batches settle without cash (ADR 0022 decision 7).
    expect([...c.seen.get("PRODUCTION")!]).toEqual(["NON_CASH"]);
  });
});
