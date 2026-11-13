// ADR 0021's knowledge behaviour (SK1b, #199), beyond the locked non-leak
// property: the persist at tick end and on departure, the arrival and waking
// catch-up, pending news and books, cash postings as a channel, the founder's
// command activity, known net worth, and that founder rules off change nothing.

import {
  ACTIVITY_IMPORTANCE,
  cents,
  EMPTY_KNOWLEDGE,
  idempotencyKey,
  TICKS_PER_DAY,
  tick,
  type CommandResult,
  type GameState,
  type LedgerTransaction,
  type LocationId,
  type PlayerSnapshot,
} from "@eov/contracts";
import {
  BASIC_MOONSHINE_RECIPE,
  CORN,
  CROSSROADS,
  CROSSROADS_BACK_ROAD,
  CROSSROADS_ROADHOUSE,
  DISTILLERY_MAIN,
  FIRST_SHIPMENT_SCENARIO,
  GAME_DATA,
  HOLLOW_CREEK,
  KESSLER_PHARMACY,
  KESSLERS_BACK_ROOM,
  MILLERS_FEED,
  MILLERS_FEED_LOCATION,
  MODEL_TT_TRUCK,
  MOONSHINE,
  PLACE_HOURS,
  START_WAKE_TICK,
  SUGAR,
  type ScenarioDefinition,
} from "@eov/game-data";
import { describe, expect, it } from "vitest";
import { isOpenAt } from "../../src/founder/time.ts";
import { classify } from "../../src/knowledge/books.ts";
import { loadGame, newGame, type KernelSimulation } from "../../src/index.ts";

const FOUNDER_SCENARIO: ScenarioDefinition = { ...FIRST_SHIPMENT_SCENARIO, scheduledEvents: [], founderRules: true, realMsPerGameHourAt1x: 20_000 };

const isFree = (s: GameState): boolean => s.founder.whereabouts.kind === "PRESENT" && s.founder.whereabouts.busy === null;
const presentAt = (s: GameState, l: LocationId): boolean => s.founder.whereabouts.kind === "PRESENT" && s.founder.whereabouts.locationId === l;

function until(sim: KernelSimulation, done: (s: GameState) => boolean, max: number, what: string): void {
  for (let i = 0; i < max && !done(sim.state); i++) sim.advance(1);
  if (!done(sim.state)) throw new Error(`not reached: ${what} (tick ${sim.state.tick})`);
}

function applied(result: CommandResult, what: string): void {
  if (result.status !== "applied") throw new Error(`${what}: ${JSON.stringify(result)}`);
}

function walkTo(sim: KernelSimulation, to: LocationId): void {
  until(sim, isFree, 2 * TICKS_PER_DAY, "free to leave");
  if (presentAt(sim.state, to)) return;
  applied(sim.dispatch({ command: { type: "TRAVEL", destinationLocationId: to, transport: { kind: "FOOT" }, via: null } }), `walk to ${to}`);
  until(sim, (s) => presentAt(s, to) && isFree(s), 3 * TICKS_PER_DAY, `arrive at ${to}`);
}

function waitOpen(sim: KernelSimulation, l: LocationId): void {
  until(sim, (s) => isFree(s) && isOpenAt(l, s.tick) && isOpenAt(l, tick(s.tick + 1)), 2 * TICKS_PER_DAY, `${l} opens`);
}

function awake(): KernelSimulation {
  const sim = newGame({ scenario: FOUNDER_SCENARIO });
  until(sim, isFree, START_WAKE_TICK + 2, "the founder wakes");
  return sim;
}

/** Materials bought at the feed store, the founder home again. */
function supplied(cases: number): KernelSimulation {
  const sim = awake();
  walkTo(sim, MILLERS_FEED_LOCATION);
  waitOpen(sim, MILLERS_FEED_LOCATION);
  for (const [materialId, quantity] of [
    [CORN, 2 * cases],
    [SUGAR, cases],
  ] as const) {
    applied(sim.dispatch({ command: { type: "PURCHASE_MATERIALS", supplierId: MILLERS_FEED, materialId, quantity, facilityId: DISTILLERY_MAIN } }), "buy");
    until(sim, isFree, TICKS_PER_DAY, "buying ends");
  }
  walkTo(sim, HOLLOW_CREEK);
  return sim;
}

function stocked(cases: number): KernelSimulation {
  const sim = supplied(cases);
  applied(sim.dispatch({ command: { type: "START_PRODUCTION", facilityId: DISTILLERY_MAIN, recipeId: BASIC_MOONSHINE_RECIPE, quantity: cases } }), "batch");
  until(sim, (s) => isFree(s) && s.productionJobs.length === 0, 4 * TICKS_PER_DAY, "the batch completes");
  return sim;
}

const record = (s: GameState, kind: string, key?: string) =>
  s.knowledge.records.find((r) => r.subject.kind === kind && (key === undefined || Object.values(r.subject).includes(key)));

const facilityOf = (p: PlayerSnapshot, l: LocationId) => {
  const place = p.places.find((x) => x.id === l);
  if (place?.kind !== "FACILITY") throw new Error(`${l} isn't a facility`);
  return place.facility;
};

describe("waking and arriving (ADR 0021 decision 7, ADR 0023 decision 2a)", () => {
  it("a new game knows nothing; the first waking catches up on the founder's place", () => {
    const sim = newGame({ scenario: FOUNDER_SCENARIO });
    expect(sim.state.knowledge).toEqual(EMPTY_KNOWLEDGE);
    sim.takeEvents();
    until(sim, isFree, START_WAKE_TICK + 2, "the founder wakes");
    const k = sim.state.knowledge;
    expect(k.lastCatchUp).toMatchObject({ locationId: HOLLOW_CREEK, tick: START_WAKE_TICK, sinceTick: null, news: [], droppedNews: 0 });
    // Everything at the place is new: every line's `before` is null.
    expect(k.lastCatchUp!.lines.map((l) => l.subject.kind)).toContain("FACILITY_STOCK");
    expect(k.lastCatchUp!.lines.every((l) => l.before === null)).toBe(true);
    expect(k.activity.filter((a) => a.kind === "CATCH_UP")).toEqual([{ kind: "CATCH_UP", tick: START_WAKE_TICK, locationId: HOLLOW_CREEK, sinceTick: null }]);
    const caught = sim.takeEvents().filter((e) => e.type === "KNOWLEDGE_CAUGHT_UP");
    expect(caught).toHaveLength(1);
    expect(caught[0]).toMatchObject({ locationId: HOLLOW_CREEK, sinceTick: null, lines: k.lastCatchUp!.lines });
    // Persisted at the end of every tick while present.
    expect(record(sim.state, "FACILITY_STOCK", DISTILLERY_MAIN)).toMatchObject({ learnedAt: sim.state.tick, source: { kind: "IN_PERSON", locationId: HOLLOW_CREEK } });
    expect(record(sim.state, "STANDING")?.learnedAt).toBe(sim.state.tick);
    // Not the feed store's offer, and not the market (a facility shows no prices).
    expect(record(sim.state, "SUPPLIER_OFFER")).toBeUndefined();
    expect(record(sim.state, "MARKET_PRICES")).toBeUndefined();
  });

  it("departing persists the live view and clears the last catch-up; arriving catches up on what changed", () => {
    const sim = awake();
    const departAt = sim.state.tick + 1;
    applied(sim.dispatch({ command: { type: "TRAVEL", destinationLocationId: MILLERS_FEED_LOCATION, transport: { kind: "FOOT" }, via: null } }), "walk");
    expect(sim.state.knowledge.lastCatchUp).toBeNull();
    expect(record(sim.state, "FACILITY_STOCK", DISTILLERY_MAIN)?.learnedAt).toBe(departAt);
    expect(sim.state.knowledge.activity.at(-1)).toMatchObject({ kind: "COMMAND", tick: departAt, status: "APPLIED", reason: null, command: { type: "TRAVEL" } });
    // While walking, the facility isn't refreshed; the leg's route is.
    sim.advance(5);
    expect(record(sim.state, "FACILITY_STOCK", DISTILLERY_MAIN)?.learnedAt).toBe(departAt);
    until(sim, (s) => presentAt(s, MILLERS_FEED_LOCATION), TICKS_PER_DAY, "arrive");
    const catchUp = sim.state.knowledge.lastCatchUp!;
    expect(catchUp.locationId).toBe(MILLERS_FEED_LOCATION);
    const kinds = catchUp.lines.map((l) => l.subject.kind);
    const openNow = isOpenAt(MILLERS_FEED_LOCATION, sim.state.tick);
    // At a closed place only the road shows (ADR 0023 decision 6).
    expect(kinds.includes("SUPPLIER_OFFER")).toBe(openNow);
    expect(kinds).not.toContain("FACILITY_STOCK");
  });

  it("a closed party shows only what the road shows", () => {
    const sim = awake();
    walkTo(sim, MILLERS_FEED_LOCATION);
    until(sim, (s) => !isOpenAt(MILLERS_FEED_LOCATION, s.tick), 2 * TICKS_PER_DAY, "the feed store closes");
    const p = sim.playerSnapshot();
    const supplier = p.places.find((x) => x.id === MILLERS_FEED_LOCATION)!;
    expect(supplier.kind === "SUPPLIER" && supplier.supplier.offer?.learnedAt).not.toBe(sim.state.tick);
    expect(p.standing?.learnedAt).not.toBe(sim.state.tick);
    expect(p.routes.find((r) => r.fromLocationId === MILLERS_FEED_LOCATION || r.toLocationId === MILLERS_FEED_LOCATION)?.condition?.learnedAt).toBe(sim.state.tick);
    expect(PLACE_HOURS.some((h) => h.locationId === MILLERS_FEED_LOCATION)).toBe(true);
  });
});

describe("the books (ADR 0021 decisions 6 and 7)", () => {
  it("a prepaid batch finishing elsewhere waits in pendingBooks, concerning the facility's stock, until the founder is back", () => {
    const sim = supplied(2);
    applied(sim.dispatch({ command: { type: "START_PRODUCTION", facilityId: DISTILLERY_MAIN, recipeId: BASIC_MOONSHINE_RECIPE, quantity: 2 } }), "batch");
    // Known net worth counts the prepaid conversion cost (PRODUCTION_IN_PROGRESS, O1b follow-up).
    const prepaid = sim.snapshot().finance.balanceSheet.assets.productionInProgress;
    expect(prepaid).toBeGreaterThan(0);
    expect(sim.playerSnapshot().finance.knownNetWorth.amount).toBe(sim.snapshot().finance.netWorth);
    until(sim, isFree, TICKS_PER_DAY, "starting ends");
    walkTo(sim, CROSSROADS);
    until(sim, (s) => s.productionJobs.length === 0, 4 * TICKS_PER_DAY, "the batch completes");
    const completion = sim.state.ledger.transactions.find((t) => t.kind === "PRODUCTION")!;
    expect(sim.state.knowledge.pendingBooks).toEqual([{ transactionId: completion.id, concerns: { kind: "FACILITY_STOCK", facilityId: DISTILLERY_MAIN } }]);
    const away = sim.playerSnapshot();
    expect(away.finance.books.some((b) => b.kind === "PRODUCTION")).toBe(false);
    expect(away.finance.cash).toBe(sim.snapshot().finance.cash);
    // The completion moves PRODUCTION_IN_PROGRESS into FINISHED_GOODS: net worth is unchanged either way.
    expect(away.finance.knownNetWorth.amount).toBe(sim.snapshot().finance.netWorth);
    walkTo(sim, HOLLOW_CREEK);
    expect(sim.state.knowledge.pendingBooks).toEqual([]);
    const lines = sim.state.knowledge.lastCatchUp!.lines.map((l) => l.subject.kind);
    expect(lines).toEqual(expect.arrayContaining(["FACILITY_STOCK", "FACILITY_OPERATIONS"]));
    expect(sim.playerSnapshot().finance.books.some((b) => b.kind === "PRODUCTION")).toBe(true);
  });

  it("rule 4: a transaction with no entries is never in the books, and an old RESERVATION:job-n key is a no-op", () => {
    const sim = awake();
    const legacy: LedgerTransaction = {
      id: "txn-9999" as LedgerTransaction["id"],
      tick: tick(sim.state.tick + 1),
      kind: "RESERVATION",
      idempotencyKey: idempotencyKey("RESERVATION", "job-7"),
      entries: [],
      eventIds: [],
    };
    const observed = { subjects: [], locationId: null, aboard: null };
    expect(classify(sim.state, GAME_DATA, legacy, observed, new Map())).toEqual({ kind: "NO_ENTRIES" });
    const twin = loadGame({ ...sim.serialize(), state: { ...sim.state, ledger: { transactions: [...sim.state.ledger.transactions, legacy] } } }, { scenario: FOUNDER_SCENARIO });
    expect(() => twin.advance(2)).not.toThrow();
    expect(twin.state.knowledge.pendingBooks).toEqual([]);
    expect(twin.playerSnapshot().finance.books).toHaveLength(sim.playerSnapshot().finance.books.length);
  });

  it("a cash posting away from the founder is known at once and reveals its cause (an installment penalty)", () => {
    const sim = stocked(2);
    walkTo(sim, KESSLER_PHARMACY);
    waitOpen(sim, KESSLER_PHARMACY);
    const offer = sim.state.contractOffers.filter((o) => o.buyerId === KESSLERS_BACK_ROOM).at(-1)!;
    applied(sim.dispatch({ command: { type: "ACCEPT_CONTRACT", contractOfferId: offer.id } }), "accept");
    walkTo(sim, HOLLOW_CREEK);
    const contract = sim.state.contracts[0]!;
    const deadline = contract.installments[0]!.deadline;
    until(sim, (s) => s.tick > deadline, 4 * TICKS_PER_DAY, "the first deadline passes");
    const settlement = sim.state.ledger.transactions.find((t) => t.idempotencyKey === idempotencyKey("INSTALLMENT_SETTLEMENT", contract.id, 0))!;
    expect(settlement.entries.some((e) => e.account === "CASH")).toBe(true);
    const posting = sim.state.knowledge.activity.find((a) => a.kind === "CASH_POSTING");
    expect(posting).toMatchObject({
      kind: "CASH_POSTING",
      tick: deadline,
      producer: "INSTALLMENT_SETTLEMENT",
      revealed: [{ kind: "CONTRACT_PROGRESS", contractId: contract.id }],
      news: [],
    });
    expect(posting!.kind === "CASH_POSTING" && posting!.cashChange).toBeLessThan(0);
    expect(ACTIVITY_IMPORTANCE[posting!.kind]).toBe("notify");
    expect(record(sim.state, "CONTRACT_PROGRESS", contract.id)).toMatchObject({ learnedAt: deadline, source: { kind: "CASH_POSTING", transactionId: settlement.id } });
    const progress = sim.playerSnapshot().contracts[0]!.progress!;
    expect(progress.value.installments[0]!.outcome).toBe("MISSED");
    expect(sim.playerSnapshot().finance.books.some((b) => b.kind === "INSTALLMENT_SETTLEMENT")).toBe(true);
  });
});

describe("news and deals on the road (ADR 0021 decision 7, ADR 0022 decision 6)", () => {
  /** A ridden deal on the risky back road, with a game seed (the trip's draws, ADR 0022 decision 8) that delays it. */
  function delayedRide(): KernelSimulation {
    const sim = stocked(2);
    walkTo(sim, CROSSROADS);
    waitOpen(sim, CROSSROADS);
    const quote = sim.state.buyers.find((b) => b.id === CROSSROADS_ROADHOUSE)!.wants.find((w) => w.productId === MOONSHINE)!.unitPrice;
    applied(sim.dispatch({ command: { type: "AGREE_DEAL", buyerId: CROSSROADS_ROADHOUSE, productId: MOONSHINE, quality: "basic", quantity: 1, agreedUnitPrice: cents(quote) } }), "agree");
    walkTo(sim, HOLLOW_CREEK);
    const deal = sim.state.heldDeals.at(-1)!;
    applied(
      sim.dispatch({
        command: {
          type: "DISPATCH_DELIVERY",
          vehicleId: MODEL_TT_TRUCK,
          cargo: [{ productId: MOONSHINE, quality: "basic", quantity: 1 }],
          purpose: { kind: "SALE", buyerId: CROSSROADS_ROADHOUSE, dealId: deal.id },
          routeId: CROSSROADS_BACK_ROAD,
          driver: { kind: "FOUNDER" },
        },
      }),
      "dispatch",
    );
    until(sim, (s) => s.founder.whereabouts.kind === "ON_DELIVERY", TICKS_PER_DAY, "the truck sets out");
    const trip = sim.state.vehicles[0]!.trip!;
    for (let seed = 1; seed <= 2_000; seed++) {
      const candidate = loadGame({ ...sim.serialize(), state: { ...sim.state, seed } }, { scenario: FOUNDER_SCENARIO });
      candidate.advance(trip.arrivesAt - candidate.state.tick);
      if (candidate.state.vehicles[0]!.trip?.delayed) return candidate;
    }
    throw new Error("no delaying game seed");
  }

  it("a delay while riding is known at once in person, never news at the origin (#222); the deal stays listed until the stop", () => {
    const sim = delayedRide();
    const trip = sim.state.vehicles[0]!.trip!;
    expect(sim.state.knowledge.pendingNews, "a road event on the founder's own run isn't news").toEqual([]);
    expect(record(sim.state, "VEHICLE_WHEREABOUTS", MODEL_TT_TRUCK)).toMatchObject({
      learnedAt: sim.state.tick,
      source: { kind: "IN_PERSON" },
      value: { trip: { leg: "OUTBOUND", delayed: true, arrivesAt: trip.arrivesAt } },
    });
    expect(sim.state.knowledge.activity.some((a) => a.kind === "CATCH_UP" && a.tick === sim.state.tick)).toBe(false);
    expect(sim.playerSnapshot().deals.map((d) => d.status)).toEqual(["DISPATCHED"]);
    until(sim, (s) => s.founder.whereabouts.kind === "ON_DELIVERY" && s.founder.whereabouts.atStop?.tick === s.tick, TICKS_PER_DAY, "the stop");
    // Observing the hand-over: the deal's outcome is known, so it leaves the list.
    expect(sim.playerSnapshot().deals).toEqual([]);
    until(sim, (s) => presentAt(s, HOLLOW_CREEK), TICKS_PER_DAY, "home");
    expect(sim.state.knowledge.pendingNews).toEqual([]);
    expect(sim.state.knowledge.lastCatchUp).toMatchObject({ locationId: HOLLOW_CREEK, news: [] });
  });

  it("an event at the stop is seen at the stop: a buyer taking nothing on spec leaves the truck's record IN_PERSON at the buyer (#222)", () => {
    const sim0 = stocked(1);
    // The roadhouse wants nothing more today, in the world; the founder doesn't need to know.
    const sim = loadGame(
      {
        ...sim0.serialize(),
        state: {
          ...sim0.state,
          buyers: sim0.state.buyers.map((b) => (b.id === CROSSROADS_ROADHOUSE ? { ...b, wants: b.wants.map((w) => ({ ...w, demandRemaining: 0 })) } : b)),
        },
      },
      { scenario: FOUNDER_SCENARIO },
    );
    applied(
      sim.dispatch({
        command: {
          type: "DISPATCH_DELIVERY",
          vehicleId: MODEL_TT_TRUCK,
          cargo: [{ productId: MOONSHINE, quality: "basic", quantity: 1 }],
          purpose: { kind: "SALE", buyerId: CROSSROADS_ROADHOUSE, dealId: null },
          routeId: null,
          driver: { kind: "FOUNDER" },
        },
      }),
      "dispatch on spec",
    );
    const deliveryId = sim.state.deliveries.at(-1)!.id;
    sim.takeEvents();
    until(sim, (s) => s.founder.whereabouts.kind === "ON_DELIVERY" && s.founder.whereabouts.atStop?.tick === s.tick, TICKS_PER_DAY, "the stop");
    const events = sim.takeEvents();
    expect(events.find((e) => e.type === "SPEC_SALE_SETTLED"), "construction: nothing taken").toMatchObject({ deliveryId, accepted: 0 });
    expect(events.find((e) => e.type === "DEAL_FELL_THROUGH"), "construction: it fell through at the stop").toMatchObject({ deliveryId, reason: "NOT_WANTED" });
    const stop = GAME_DATA.buyers.find((b) => b.id === CROSSROADS_ROADHOUSE)!.locationId;
    expect(record(sim.state, "VEHICLE_WHEREABOUTS", MODEL_TT_TRUCK)).toMatchObject({
      learnedAt: sim.state.tick,
      source: { kind: "IN_PERSON", locationId: stop },
      value: { trip: { deliveryId, leg: "RETURN" } },
    });
    expect(sim.state.knowledge.pendingNews, "seen at the stop, not news").toEqual([]);
  });
});

describe("the founder's commands in the activity feed (ADR 0021 decision 8)", () => {
  it("records applied, queued and apply-time rejected commands; a rejected dispatch changes nothing", () => {
    const sim = awake();
    const before = sim.stateHash();
    const rejected = sim.dispatch({ command: { type: "WAKE" } });
    expect(rejected.status).toBe("rejected");
    expect(sim.stateHash()).toBe(before);
    const at = tick(sim.state.tick + 5);
    expect(sim.dispatch({ command: { type: "WAKE" }, scheduledTick: at }).status).toBe("queued");
    expect(sim.state.knowledge.activity.at(-1)).toMatchObject({ kind: "COMMAND", status: "QUEUED", command: { type: "WAKE" }, reason: null });
    sim.advance(5);
    expect(sim.state.knowledge.activity.find((a) => a.kind === "COMMAND" && a.status === "REJECTED")).toMatchObject({
      tick: at,
      reason: { code: "NOT_RESTING" },
    });
  });
});

describe("founder rules off (M001, the lab)", () => {
  it("never writes knowledge, and the player snapshot is the whole world, live", () => {
    const sim = newGame();
    sim.advance(TICKS_PER_DAY + 10);
    expect(sim.state.knowledge).toEqual(EMPTY_KNOWLEDGE);
    const p = sim.playerSnapshot();
    const world = sim.snapshot();
    expect(p.here).toBe(HOLLOW_CREEK);
    expect(p.market?.value.products).toEqual(world.market.products);
    expect(p.market?.learnedAt).toBe(sim.state.tick);
    for (const buyer of world.market.buyers) {
      const place = p.places.find((x) => x.kind === "BUYER" && x.buyer.id === buyer.id);
      expect(place?.kind === "BUYER" && place.buyer.wants?.value.wants).toEqual(buyer.wants);
      expect(place?.kind === "BUYER" && place.buyer.budget?.value.budgetRemaining).toBe(buyer.budgetRemaining);
    }
    expect(facilityOf(p, HOLLOW_CREEK).recipes).toEqual(world.facilities.find((f) => f.id === DISTILLERY_MAIN)!.recipes);
    expect(p.finance.books).toHaveLength(sim.state.ledger.transactions.filter((t) => t.entries.length > 0).length);
    expect(p.finance.knownNetWorth.amount).toBe(world.finance.netWorth);
    expect(p.activity).toEqual([]);
  });
});
