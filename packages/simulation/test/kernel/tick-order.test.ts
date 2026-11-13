// SIM-001 tick order, midnight, exact-deadline resolution, world events, and
// tick atomicity.

import { asId, cents, tick, type ContractState, type GameState, type Tick } from "@eov/contracts";
import { ids } from "@eov/contracts/fixtures";
import { describe, expect, it } from "vitest";
import { KernelError, loadSimulation, RegistryError, scheduleWorldEvent, type SystemRegistry } from "../../src/index.ts";
import { day0State, fakeRegistry, fakeSimulation, GAME_DATA_VERSION, setWorkforce, START_DATE } from "./fakes.ts";

describe("tick order", () => {
  it("runs commands → production → vehicles → world events → resolution → deadlines → midnight", () => {
    const log: string[] = [];
    const record = (label: string) => (state: GameState, ctx: { tick: Tick }) => {
      log.push(`${ctx.tick}:${label}`);
      return state;
    };
    const sim = fakeSimulation(
      // A ROUTE_REOPENING at midnight so step 4's world events show up in the log.
      scheduleWorldEvent(day0State, { tick: tick(1_440), kind: "ROUTE_REOPENING", routeId: ids.routeBarn }),
      (registry) => {
        registry.onCommand("RELEASE_RESERVATION", {
          apply: (state, _command, ctx) => {
            log.push(`${ctx.tick}:command`);
            return { status: "applied", state };
          },
        });
        // Registered in reverse SIM-001 order: the kernel's order wins, not registration order.
        registry.onPhase("midnight", "rec-midnight", record("midnight"));
        registry.onPhase("deadlines", "rec-deadlines", record("deadlines"));
        registry.onPhase("resolution", "rec-resolution", record("resolution"));
        registry.onPhase("vehicles", "rec-vehicles", record("vehicles"));
        registry.onPhase("production", "rec-production-a", record("production-a"));
        registry.onPhase("production", "rec-production-b", record("production-b"));
      },
    );
    sim.dispatch({ command: { type: "RELEASE_RESERVATION", reservationId: asId("Reservation", "res-1") }, scheduledTick: tick(1_440) });
    sim.advance(1_438 - 600);
    log.length = 0;
    sim.advance(2); // ticks 1439 and 1440 (midnight)

    const reopenedAt = sim.takeEvents().filter((e) => e.type === "ROUTE_REOPENED");
    expect(reopenedAt.map((e) => e.tick)).toEqual([1_440]);
    expect(log).toEqual([
      "1439:production-a",
      "1439:production-b",
      "1439:vehicles",
      "1439:resolution",
      "1439:deadlines",
      "1440:command",
      "1440:production-a",
      "1440:production-b",
      "1440:vehicles",
      "1440:resolution",
      "1440:deadlines",
      "1440:midnight",
    ]);
  });

  it("1,440 ticks advance exactly one game day, with exactly one midnight", () => {
    const midnights: number[] = [];
    const sim = fakeSimulation(day0State, (r) =>
      r.onPhase("midnight", "count", (state, ctx) => {
        midnights.push(ctx.dayIndex);
        return state;
      }),
    );
    sim.advance(1_440);
    expect(sim.state.tick).toBe(2_040);
    expect(midnights).toEqual([1]); // tick 1440 starts day 1
    sim.advance(1_440);
    expect(midnights).toEqual([1, 2]);
  });

  it("gives hooks the tick being processed while state.tick is still the previous one", () => {
    const seen: [number, number, string][] = [];
    const sim = fakeSimulation(day0State, (r) =>
      r.onPhase("vehicles", "peek", (state, ctx) => {
        const d = ctx.clock.date;
        seen.push([state.tick, ctx.tick, `${d.year}-${d.month}-${d.day} ${d.hour}:${d.minute}`]);
        return state;
      }),
    );
    sim.advance(1);
    expect(seen).toEqual([[600, 601, "1920-1-17 10:1"]]);
    expect(sim.state.tick).toBe(601);
  });

  it("advance(0) does nothing and invalid tick counts throw", () => {
    const sim = fakeSimulation();
    const hash = sim.stateHash();
    sim.advance(0);
    expect(sim.stateHash()).toBe(hash);
    expect(() => sim.advance(-1)).toThrow(RangeError);
    expect(() => sim.advance(1.5)).toThrow(RangeError);
  });
});

describe("exact deadlines (SIM-001)", () => {
  const DEADLINE = tick(1_000);
  const contractId = asId("Contract", "contract-1");

  function withTripAndContract(arrivesAt: Tick): GameState {
    const contract: ContractState = {
      id: contractId,
      offerId: asId("ContractOffer", "offer-1"),
      buyerId: ids.hotel,
      productId: ids.moonshine,
      minimumQuality: "basic",
      quantityPerInstallment: 10,
      unitPrice: cents(1_500),
      installmentCount: 1,
      intervalTicks: 1_440,
      penaltyRatePpm: 200_000,
      status: "ACTIVE",
      installments: [{ deadline: DEADLINE, required: 10, delivered: 0, outcome: null, penalty: null }],
      reservationIds: [],
    };
    return {
      ...day0State,
      contracts: [contract],
      vehicles: [
        {
          id: ids.truck,
          parkedAt: null,
          trip: { deliveryId: asId("Delivery", "delivery-1"), routeId: ids.routeHotel, leg: "OUTBOUND", departedAt: tick(600), arrivesAt, delayed: false },
        },
      ],
    };
  }

  /** Fake logistics (arrivals in step 3) and contracts (penalties in step 4's deadlines phase). */
  function contractSystems(registry: SystemRegistry): void {
    registry.onPhase("vehicles", "fake-arrivals", (state, ctx) => {
      const truck = state.vehicles[0]!;
      if (!truck.trip || truck.trip.arrivesAt !== ctx.tick) return state;
      return {
        ...state,
        vehicles: [{ ...truck, trip: null }],
        contracts: state.contracts.map((c) => ({
          ...c,
          installments: c.installments.map((i) => (i.outcome === null ? { ...i, delivered: i.delivered + 10 } : i)),
        })),
      };
    });
    registry.onPhase("deadlines", "fake-penalties", (state, ctx) => ({
      ...state,
      contracts: state.contracts.map((c) => ({
        ...c,
        installments: c.installments.map((i) =>
          i.deadline === ctx.tick && i.outcome === null
            ? { ...i, outcome: i.delivered >= i.required ? "FULFILLED" : "MISSED", penalty: cents(i.delivered >= i.required ? 0 : 3_000) }
            : i,
        ),
      })),
    }));
  }

  const outcome = (state: GameState) => state.contracts[0]!.installments[0]!.outcome;

  it("a delivery arriving on the deadline tick counts as on time", () => {
    const sim = fakeSimulation(withTripAndContract(DEADLINE), contractSystems);
    sim.advance(1_000);
    expect(outcome(sim.state)).toBe("FULFILLED");
  });

  it("one tick late is missed", () => {
    const sim = fakeSimulation(withTripAndContract(tick(DEADLINE + 1)), contractSystems);
    sim.advance(1_000);
    expect(outcome(sim.state)).toBe("MISSED");
  });

  it("holds when the deadline tick is its own batch, and across a save just before it", () => {
    const sim = fakeSimulation(withTripAndContract(DEADLINE), contractSystems);
    sim.advance(DEADLINE - 1 - 600);
    const resumed = loadSimulation(sim.serialize(), { registry: fakeRegistry(contractSystems), startDate: START_DATE, gameDataVersion: GAME_DATA_VERSION });
    resumed.advance(1);
    expect(outcome(resumed.state)).toBe("FULFILLED");
  });
});

describe("scheduled world events", () => {
  it("resolve in (tick, sequence) order, and a handler's follow-up for the same tick runs that tick", () => {
    let s = day0State;
    s = scheduleWorldEvent(s, { tick: tick(700), kind: "ROUTE_CLOSURE", routeId: ids.routeHotel, reason: "RIVAL", durationTicks: 0 });
    s = scheduleWorldEvent(s, { tick: tick(650), kind: "ROUTE_CLOSURE", routeId: ids.routeBarn, reason: "POLICE", durationTicks: 50 });
    const sim = fakeSimulation(s);
    sim.advance(100);
    const routeEvents = sim
      .takeEvents()
      .filter((e) => e.type === "ROUTE_CLOSED" || e.type === "ROUTE_REOPENED")
      .map((e) => `${e.tick}:${e.type}:${e.routeId}`);
    expect(routeEvents).toEqual([
      `650:ROUTE_CLOSED:${ids.routeBarn}`,
      `700:ROUTE_CLOSED:${ids.routeHotel}`, // sequence 2
      `700:ROUTE_REOPENED:${ids.routeBarn}`, // sequence 4, scheduled at tick 650
      `700:ROUTE_REOPENED:${ids.routeHotel}`, // sequence 5: zero duration, scheduled for the current tick
    ]);
    expect(sim.state.scheduledEvents.map((e) => e.kind)).toEqual(["SHORTAGE_START"]);
  });

  it("a due event with no registered handler is a programming error", () => {
    const registry = fakeRegistry();
    expect(() => registry.worldEventHandler("CONTRACT_OFFER")).toThrow(RegistryError);
  });
});

describe("atomic ticks", () => {
  it("a hook that throws leaves the state exactly as it was before the tick", () => {
    let explode = false;
    const sim = fakeSimulation(day0State, (r) =>
      r.onPhase("deadlines", "bomb", (state) => {
        if (explode) throw new Error("boom");
        return state;
      }),
    );
    sim.dispatch({ command: setWorkforce(ids.barn, 4), scheduledTick: tick(605) });
    sim.advance(4);
    sim.takeEvents();
    const before = sim.state;
    explode = true;
    expect(() => sim.advance(1)).toThrow("boom");
    expect(sim.state).toBe(before);
    expect(sim.takeEvents()).toEqual([]);
  });

  it("systems may not touch the clock or command bookkeeping", () => {
    const sim = fakeSimulation(day0State, (r) => r.onPhase("production", "time-traveller", (state) => ({ ...state, tick: tick(0) })));
    expect(() => sim.advance(1)).toThrow(KernelError);
  });
});
