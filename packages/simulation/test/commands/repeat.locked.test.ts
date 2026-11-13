// @locked
// T05c acceptance tests (issue #102): repeat orders, REPEAT_OPERATION (GDD §9
// earned automation, level 2). Covers repeating an applied PURCHASE_MATERIALS,
// START_PRODUCTION, SALE dispatch, and CONTRACT_INSTALLMENT dispatch through the
// command's own handler (keys and causedBy from the repeat), a repeated SALE
// re-quoted at the buyer's current price, inner rejections passed through
// unchanged with rule 6, every NOT_REPEATABLE source, repeat chains, queued
// repeats (validated only when they apply, COMMAND_REJECTED when they fail),
// command-log replay, and the Sprint Zero hash. Rules come from ADR 0020
// decision 11 and ADR 0004.
//
// Re-locked for ADR 0022 decision 6 (issue #192): a sale is AGREE_DEAL at the quote,
// then a DISPATCH_DELIVERY against that deal, and the quote check (QUOTE_CHANGED)
// runs at AGREE_DEAL. With founder rules off, a repeated SALE re-agrees at the
// buyer's current quote and dispatches against that new deal (issue #192).
//
// Re-locked for ADR 0022 decision 7 (issue #197): START_PRODUCTION's transaction is
// now `PRODUCTION_START:<jobId>` (kind PRODUCTION_START), replacing the entry-less
// `RESERVATION:<jobId>`, and it pays the job's conversion cost from cash. A repeated
// production run is keyed and caused the same way, and prepays like the original.
//
// Written ahead of the implementation by a separate test-writer agent
// (factory.md §2, §7.3). Do not edit (CLAUDE.md rule 9).
//
// Imports are limited to the public package entry `src/index.ts`, the inventory
// module `src/inventory/index.ts` (`addProduct`, for fixtures), and
// `@eov/contracts` and `@eov/game-data`. Repeats are driven only through the
// Simulation (commands, ticks, world events). No new simulation export is assumed.
//
// "Caused by". A LedgerTransaction has no `causedBy` field: the coordinator
// stamps the request's `causedBy` on the events the transaction emits. So "the
// copy's transactions have causedBy set to the repeat's command ID" is checked
// as: every event listed in the transaction's `eventIds` has that `causedBy`.
//
// Keys checked (from the handlers on main): MATERIAL_PURCHASE:<commandId>,
// PRODUCTION_START:<jobId> (ADR 0022 decision 7), DISPATCH:<deliveryId>.
//
// Settled-only. Not pinned here:
//   - how the handler decides a source was applied (ADR 0020 decision 11 says
//     "a transaction with causedBy"; the mechanism is the implementer's);
//   - the kernel reference hash: its scenario runs on the kernel's fake systems
//     (test/kernel/fakes.ts), which never include the repeat system, and it's
//     pinned by test/kernel/reference-scenario.test.ts, which `pnpm check` runs.
//
// Expected to fail on main until T05c lands: REPEAT_OPERATION has no handler,
// so dispatching one throws RegistryError ("No handler registered for command
// REPEAT_OPERATION"). The Sprint Zero hash test passes on main.

import {
  asId,
  cents,
  compareIds,
  idempotencyKey,
  tick,
  TICKS_PER_DAY,
  type BuyerId,
  type CargoLine,
  type CommandEnvelope,
  type CommandId,
  type CommandResult,
  type ContractId,
  type DealId,
  type DispatchDeliveryCommand,
  type GameCommand,
  type GameEvent,
  type GameState,
  type LedgerEntry,
  type LedgerTransaction,
  type Money,
  type QualityTier,
  type RejectionReason,
} from "@eov/contracts";
import {
  BASIC_MOONSHINE_RECIPE,
  CROSSROADS_ROADHOUSE,
  DISTILLERY_MAIN,
  GAME_DATA,
  KESSLERS_BACK_ROOM,
  MILLERS_FEED,
  MODEL_TT_TRUCK,
  MOONSHINE,
  STATE_HIGHWAY,
} from "@eov/game-data";
import { describe, expect, it } from "vitest";
import { addProduct } from "../../src/inventory/index.ts";
import {
  accountBalances,
  createCoordinator,
  createSimulation,
  loadGame,
  newGame,
  scheduleWorldEvent,
  simulationOptions,
  type GameSetup,
  type KernelSimulation,
} from "../../src/index.ts";
import { SPRINT_ZERO_HASH } from "../sprint-zero/reference-hash.ts";

const DAY = TICKS_PER_DAY;

const recipe = GAME_DATA.recipes.find((r) => r.id === BASIC_MOONSHINE_RECIPE)!;

// ---------------------------------------------------------------------------
// A game with an event log
// ---------------------------------------------------------------------------

interface Game {
  sim: KernelSimulation;
  readonly setup: GameSetup;
  readonly events: GameEvent[];
}

function start(setup: GameSetup = {}): Game {
  return { sim: newGame(setup), setup, events: [] };
}

function flush(g: Game): void {
  g.events.push(...g.sim.takeEvents());
}

/** Continues from an edited copy of the state, with the same systems and data. */
function edit(g: Game, change: (s: GameState) => GameState): void {
  flush(g);
  g.sim = createSimulation(change(g.sim.state), simulationOptions(g.setup));
}

function to(g: Game, target: number): void {
  if (target < g.sim.state.tick) throw new Error(`Can't go back from ${g.sim.state.tick} to ${target}`);
  g.sim.advance(target - g.sim.state.tick);
  flush(g);
}

function run(g: Game, command: GameCommand, scheduledTick?: number): CommandResult {
  const result = g.sim.dispatch(scheduledTick === undefined ? { command } : { command, scheduledTick: tick(scheduledTick) });
  flush(g);
  return result;
}

/** Dispatches now and expects it applied. Returns the command's ID. */
function applied(g: Game, command: GameCommand): CommandId {
  const result = run(g, command);
  if (result.status !== "applied") throw new Error(`Expected applied ${command.type}, got ${JSON.stringify(result)}`);
  return result.commandId;
}

/** Dispatches for a later tick and expects it queued. Returns the command's ID. */
function queued(g: Game, command: GameCommand, scheduledTick: number): CommandId {
  const result = run(g, command, scheduledTick);
  if (result.status !== "queued") throw new Error(`Expected queued ${command.type}, got ${JSON.stringify(result)}`);
  return result.commandId;
}

/** Rejected now with `code`; nothing changed and nothing was emitted (rule 6). Returns the reason. */
function expectRejected(g: Game, command: GameCommand, code: string): RejectionReason {
  flush(g);
  const before = g.sim.stateHash();
  const state = g.sim.state;
  const result = g.sim.dispatch({ command });
  if (result.status !== "rejected") throw new Error(`Expected rejected ${code}, got ${JSON.stringify(result)}`);
  expect(result.reason.code).toBe(code);
  expect(g.sim.stateHash()).toBe(before);
  expect(g.sim.state).toBe(state);
  expect(g.sim.state.counters).toEqual(state.counters);
  expect(g.sim.state.commandLog).toEqual(state.commandLog);
  expect(g.sim.state.ledger.transactions).toHaveLength(state.ledger.transactions.length);
  expect(g.sim.takeEvents()).toEqual([]);
  return result.reason;
}

const repeat = (sourceCommandId: CommandId): GameCommand => ({ type: "REPEAT_OPERATION", sourceCommandId });

const notRepeatable = (sourceCommandId: CommandId): RejectionReason => ({ code: "NOT_REPEATABLE", sourceCommandId });

function eventsOfType<T extends GameEvent["type"]>(events: readonly GameEvent[], type: T): Extract<GameEvent, { type: T }>[] {
  return events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === type);
}

// ---------------------------------------------------------------------------
// Ledger helpers
// ---------------------------------------------------------------------------

function keyed(state: GameState, key: string): readonly LedgerTransaction[] {
  return state.ledger.transactions.filter((t) => t.idempotencyKey === key);
}

function oneTx(state: GameState, key: string): LedgerTransaction {
  const found = keyed(state, key);
  if (found.length !== 1) throw new Error(`Expected one transaction keyed ${key}, found ${found.length}`);
  return found[0]!;
}

/** The events a transaction emitted, from the game's event log. */
function eventsOf(g: Game, tx: LedgerTransaction): GameEvent[] {
  flush(g);
  return tx.eventIds.map((id) => {
    const e = g.events.find((x) => x.id === id);
    if (!e) throw new Error(`Event ${id} of ${tx.idempotencyKey} wasn't seen`);
    return e;
  });
}

/** The transaction emitted at least one event, and every one of them is caused by `commandId`. */
function expectCausedBy(g: Game, tx: LedgerTransaction, commandId: CommandId): void {
  const events = eventsOf(g, tx);
  expect(events.length).toBeGreaterThan(0);
  for (const e of events) expect(e.causedBy, `${e.type} of ${tx.idempotencyKey}`).toBe(commandId);
}

const cashOf = (state: GameState) => accountBalances(state.ledger.transactions).CASH;

const keys = {
  purchase: (commandId: CommandId) => idempotencyKey("MATERIAL_PURCHASE", commandId),
  productionStart: (jobId: string) => idempotencyKey("PRODUCTION_START", jobId),
  dispatch: (deliveryId: string) => idempotencyKey("DISPATCH", deliveryId),
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Books `entries` (and an optional state change) as a fixture coordinator transaction. */
function fixtureTx(state: GameState, entries: readonly LedgerEntry[], change?: (s: GameState) => GameState): GameState {
  const tx = createCoordinator().begin(state, {
    kind: "OPENING_BALANCE",
    idempotencyKey: idempotencyKey("OPENING_BALANCE", "fixture", state.ledger.transactions.length),
    tick: state.tick,
    causedBy: null,
  });
  if (tx.status === "duplicate") throw new Error("Fixture key collision");
  if (change) tx.update(change);
  if (entries.length > 0) tx.post(entries);
  const result = tx.commit();
  if (result.status !== "committed") throw new Error(`Fixture rejected: ${JSON.stringify(result.reason)}`);
  return result.state;
}

/** Finished moonshine at the distillery, booked against owner equity. */
function withStock(state: GameState, quality: QualityTier, quantity: number, unitCost = 700): GameState {
  const cost = cents(unitCost * quantity);
  return fixtureTx(
    state,
    [
      { account: "FINISHED_GOODS", side: "DEBIT", amount: cost },
      { account: "OWNER_EQUITY", side: "CREDIT", amount: cost },
    ],
    (s) => addProduct(s, DISTILLERY_MAIN, MOONSHINE, quality, quantity, cost),
  );
}

/** Moves cash to or from owner equity so the cash balance is `target`. */
function withCash(state: GameState, target: number): GameState {
  const cash = cashOf(state);
  if (cash === target) return state;
  const amount = cents(Math.abs(cash - target));
  return cash > target
    ? fixtureTx(state, [
        { account: "OWNER_EQUITY", side: "DEBIT", amount },
        { account: "CASH", side: "CREDIT", amount },
      ])
    : fixtureTx(state, [
        { account: "CASH", side: "DEBIT", amount },
        { account: "OWNER_EQUITY", side: "CREDIT", amount },
      ]);
}

// ---------------------------------------------------------------------------
// Commands and lookups
// ---------------------------------------------------------------------------

/** Buys `cases` cases' worth of every basic-recipe input, one PURCHASE_MATERIALS each. Returns the command IDs. */
function buyInputs(g: Game, cases: number): CommandId[] {
  return recipe.inputsPerCase.map((input) => applied(g, buy(input.materialId, input.quantity * cases)));
}

function buy(materialId: (typeof recipe.inputsPerCase)[number]["materialId"], quantity: number, facilityId = DISTILLERY_MAIN): GameCommand {
  return { type: "PURCHASE_MATERIALS", supplierId: MILLERS_FEED, materialId, quantity, facilityId };
}

const firstInput = recipe.inputsPerCase[0]!;

const produce = (quantity: number): GameCommand => ({ type: "START_PRODUCTION", facilityId: DISTILLERY_MAIN, recipeId: BASIC_MOONSHINE_RECIPE, quantity });

/** The buyer's current quote for the cargo line: the price AGREE_DEAL's QUOTE_CHANGED check compares against (ADR 0022 decision 6). */
function quoteOf(state: GameState, buyerId: BuyerId, quality: QualityTier = "basic"): Money {
  const want = state.buyers.find((b) => b.id === buyerId)?.wants.find((w) => w.productId === MOONSHINE && w.minimumQuality === quality);
  if (!want) throw new Error(`${buyerId} has no quote for ${quality} moonshine`);
  return want.unitPrice;
}

function agreement(buyerId: BuyerId, quantity: number, agreedUnitPrice: Money, quality: QualityTier = "basic"): GameCommand {
  return { type: "AGREE_DEAL", buyerId, productId: MOONSHINE, quality, quantity, agreedUnitPrice };
}

function sale(buyerId: BuyerId, quantity: number, dealId: DealId): DispatchDeliveryCommand {
  return {
    type: "DISPATCH_DELIVERY",
    vehicleId: MODEL_TT_TRUCK,
    cargo: [{ productId: MOONSHINE, quality: "basic", quantity }],
    purpose: { kind: "SALE", buyerId, dealId },
    routeId: null,
    driver: { kind: "FOUNDER" },
  };
}

/** The newest held deal (IDs sort with compareIds, so the last one is the latest minted). */
function lastDealId(state: GameState): DealId {
  const d = state.heldDeals.at(-1);
  if (!d) throw new Error("No held deal");
  return d.id;
}

/** The deal a delivery was dispatched against (still held while the delivery is outbound). */
function dealOf(state: GameState, deliveryId: string) {
  const d = state.heldDeals.find((x) => x.deliveryId === deliveryId);
  if (!d) throw new Error(`No held deal for ${deliveryId}`);
  return d;
}

/** A roadhouse sale as ADR 0022 decision 6 splits it: the AGREE_DEAL (already applied), its price, and the deal dispatch to send. */
interface Sale {
  readonly agree: GameCommand;
  readonly agreed: Money;
  readonly command: DispatchDeliveryCommand;
}

function roadhouseSale(g: Game, quantity: number): Sale {
  const agreed = quoteOf(g.sim.state, CROSSROADS_ROADHOUSE);
  const agree = agreement(CROSSROADS_ROADHOUSE, quantity, agreed);
  applied(g, agree);
  return { agree, agreed, command: sale(CROSSROADS_ROADHOUSE, quantity, lastDealId(g.sim.state)) };
}

/**
 * The original sale as it would be sent now (decision 11; with founder rules off a repeated
 * sale re-agrees at the buyer's current quote): agrees a new deal at the current quote (it
 * must apply), and returns the original dispatch pointed at that deal.
 */
function requoted(g: Game, command: DispatchDeliveryCommand): DispatchDeliveryCommand {
  if (command.purpose.kind !== "SALE") return command;
  const line = command.cargo[0]!;
  applied(g, agreement(command.purpose.buyerId, line.quantity, quoteOf(g.sim.state, command.purpose.buyerId, line.quality), line.quality));
  return { ...command, purpose: { ...command.purpose, dealId: lastDealId(g.sim.state) } };
}

function deliver(contractId: ContractId, quantity: number): GameCommand {
  const cargo: CargoLine = { productId: MOONSHINE, quality: "basic", quantity };
  return {
    type: "DISPATCH_DELIVERY",
    vehicleId: MODEL_TT_TRUCK,
    cargo: [cargo],
    purpose: { kind: "CONTRACT_INSTALLMENT", contractId },
    routeId: null,
    driver: { kind: "FOUNDER" },
  };
}

/** Advances until the truck is home (no trip). */
function truckHome(g: Game): void {
  for (let i = 0; i < 4; i++) {
    const trip = g.sim.state.vehicles.find((v) => v.id === MODEL_TT_TRUCK)!.trip;
    if (trip === null) return;
    to(g, Math.max(trip.arrivesAt, g.sim.state.tick + 1));
  }
  throw new Error("The truck didn't come home");
}

/** The one delivery that isn't in `knownIds`. */
function deliveryAfter(state: GameState, knownIds: ReadonlySet<string>) {
  const fresh = state.deliveries.filter((d) => !knownIds.has(d.id));
  if (fresh.length !== 1) throw new Error(`Expected one new delivery, found ${fresh.length}`);
  return fresh[0]!;
}

const deliveryIds = (state: GameState) => new Set<string>(state.deliveries.map((d) => d.id));

function logEntry(state: GameState, id: CommandId): CommandEnvelope {
  const e = state.commandLog.find((x) => x.id === id);
  if (!e) throw new Error(`${id} isn't in the command log`);
  return e;
}

/** A game where Kessler's midnight offer (tick DAY) was accepted on the next tick, after booking `stock` basic cases. */
function acceptedKessler(stock: number) {
  const g = start();
  edit(g, (s) => withStock(s, "basic", stock));
  to(g, DAY);
  const offer = g.sim.state.contractOffers.find((o) => o.buyerId === KESSLERS_BACK_ROOM);
  if (!offer) throw new Error(`No open Kessler offer at tick ${g.sim.state.tick}`);
  const acceptId = applied(g, { type: "ACCEPT_CONTRACT", contractOfferId: offer.id });
  const contract = g.sim.state.contracts.find((c) => c.offerId === offer.id);
  if (!contract) throw new Error("Accepting didn't create a contract");
  return { g, acceptId, contractId: contract.id };
}

// ===========================================================================
// Applying a copy through the command's own handler
// ===========================================================================

describe("REPEAT_OPERATION: applies a copy through the source command's handler", () => {
  it("PURCHASE_MATERIALS: a second purchase keyed and caused by the repeat, the same quantity and price", () => {
    const g = start();
    const command = buy(firstInput.materialId, 10);
    const sourceId = applied(g, command);
    const sourceTx = oneTx(g.sim.state, keys.purchase(sourceId));
    const cashBefore = cashOf(g.sim.state);

    const result = run(g, repeat(sourceId));
    if (result.status !== "applied") throw new Error(`Expected applied, got ${JSON.stringify(result)}`);
    const repeatId = result.commandId;
    expect(repeatId).not.toBe(sourceId);

    const tx = oneTx(g.sim.state, keys.purchase(repeatId));
    expect(tx.kind).toBe("MATERIAL_PURCHASE");
    expect(tx.entries).toEqual(sourceTx.entries); // same day, same supplier price, same quantity
    expectCausedBy(g, tx, repeatId);
    expect(result.eventIds).toEqual(tx.eventIds);
    const [bought] = eventsOfType(eventsOf(g, tx), "MATERIALS_PURCHASED");
    expect(bought).toMatchObject({ supplierId: MILLERS_FEED, materialId: firstInput.materialId, quantity: 10, facilityId: DISTILLERY_MAIN });
    const paid = sourceTx.entries.find((e) => e.account === "CASH" && e.side === "CREDIT")!.amount;
    expect(cashOf(g.sim.state)).toBe(cashBefore - paid);
    expect(keyed(g.sim.state, keys.purchase(sourceId))).toHaveLength(1);

    // The repeat itself is what the command log holds.
    expect(g.sim.state.commandLog.at(-1)).toMatchObject({ id: repeatId, command: { type: "REPEAT_OPERATION", sourceCommandId: sourceId } });
  });

  it("START_PRODUCTION: a new job with the same facility, recipe, and quantity, its PRODUCTION_START keyed by the job, caused by the repeat, and prepaying the conversion cost", () => {
    const g = start();
    buyInputs(g, 2);
    const sourceId = applied(g, produce(1));
    const first = g.sim.state.productionJobs[0]!;
    to(g, first.completesAt);
    expect(g.sim.state.productionJobs).toEqual([]);

    const cashBefore = cashOf(g.sim.state);
    const result = run(g, repeat(sourceId));
    if (result.status !== "applied") throw new Error(`Expected applied, got ${JSON.stringify(result)}`);
    const repeatId = result.commandId;
    expect(g.sim.state.productionJobs).toHaveLength(1);
    const job = g.sim.state.productionJobs[0]!;
    expect(job.id).not.toBe(first.id);
    expect(job).toMatchObject({ facilityId: DISTILLERY_MAIN, recipeId: BASIC_MOONSHINE_RECIPE, quantity: 1 });
    expect(job.conversionPrepaid).toBe(first.conversionPrepaid);
    expect(job.conversionPrepaid).toBeGreaterThan(0);

    expect(keyed(g.sim.state, idempotencyKey("RESERVATION", job.id))).toEqual([]);
    const tx = oneTx(g.sim.state, keys.productionStart(job.id));
    expect(tx.kind).toBe("PRODUCTION_START");
    const prepaid = job.conversionPrepaid ?? 0;
    expect(tx.entries).toEqual(
      expect.arrayContaining([
        { account: "PRODUCTION_IN_PROGRESS", side: "DEBIT", amount: prepaid },
        { account: "CASH", side: "CREDIT", amount: prepaid },
      ]),
    );
    expect(tx.entries).toHaveLength(2);
    expect(cashOf(g.sim.state)).toBe(cashBefore - prepaid);
    expectCausedBy(g, tx, repeatId);
    expect(result.eventIds).toEqual(tx.eventIds);
    const [started] = eventsOfType(eventsOf(g, tx), "PRODUCTION_STARTED");
    expect(started).toBeDefined();
  });

  it("a SALE dispatch: a new delivery to the same buyer, its DISPATCH keyed by the delivery and caused by the repeat", () => {
    const g = start();
    edit(g, (s) => withStock(s, "basic", 2));
    const { command, agreed } = roadhouseSale(g, 1);
    const sourceId = applied(g, command);
    const firstDelivery = g.sim.state.deliveries.at(-1)!;
    truckHome(g);
    expect(quoteOf(g.sim.state, CROSSROADS_ROADHOUSE)).toBe(agreed); // same day: the quote hasn't moved

    const known = deliveryIds(g.sim.state);
    const result = run(g, repeat(sourceId));
    if (result.status !== "applied") throw new Error(`Expected applied, got ${JSON.stringify(result)}`);
    const repeatId = result.commandId;
    const delivery = deliveryAfter(g.sim.state, known);
    // A deal is single-use, so the repeat dispatches against the deal it re-agreed (issue #192, founder rules off).
    const purpose = { ...command.purpose, dealId: dealOf(g.sim.state, delivery.id).id };
    expect(delivery.id).not.toBe(firstDelivery.id);
    expect(delivery).toMatchObject({ vehicleId: MODEL_TT_TRUCK, routeId: firstDelivery.routeId, purpose, status: "OUTBOUND" });
    expect(delivery.cargo.map(({ productId, quality, quantity }) => ({ productId, quality, quantity }))).toEqual(command.cargo);

    const tx = oneTx(g.sim.state, keys.dispatch(delivery.id));
    expect(tx.kind).toBe("DISPATCH");
    expectCausedBy(g, tx, repeatId);
    expect(result.eventIds).toEqual(tx.eventIds);
    const [dispatched] = eventsOfType(eventsOf(g, tx), "DELIVERY_DISPATCHED");
    expect(dispatched).toMatchObject({ deliveryId: delivery.id, vehicleId: MODEL_TT_TRUCK, purpose });
  });

  it("a CONTRACT_INSTALLMENT dispatch: a new delivery for the same contract, keyed by the delivery and caused by the repeat", () => {
    const { g, contractId } = acceptedKessler(16);
    const sourceId = applied(g, deliver(contractId, 8));
    const firstDelivery = g.sim.state.deliveries.at(-1)!;
    truckHome(g);

    const known = deliveryIds(g.sim.state);
    const result = run(g, repeat(sourceId));
    if (result.status !== "applied") throw new Error(`Expected applied, got ${JSON.stringify(result)}`);
    const repeatId = result.commandId;
    const delivery = deliveryAfter(g.sim.state, known);
    expect(delivery.id).not.toBe(firstDelivery.id);
    expect(delivery).toMatchObject({ vehicleId: MODEL_TT_TRUCK, purpose: { kind: "CONTRACT_INSTALLMENT", contractId }, status: "OUTBOUND" });
    expect(delivery.cargo.map((c) => c.quantity)).toEqual([8]);

    const tx = oneTx(g.sim.state, keys.dispatch(delivery.id));
    expect(tx.kind).toBe("DISPATCH");
    expectCausedBy(g, tx, repeatId);
    expect(result.eventIds).toEqual(tx.eventIds);
    expect(eventsOfType(eventsOf(g, tx), "DELIVERY_DISPATCHED")).toHaveLength(1);
  });
});

// ===========================================================================
// A repeated SALE uses the buyer's current quote
// ===========================================================================

describe("REPEAT_OPERATION: a repeated SALE is re-quoted", () => {
  it("succeeds at the new quote after midnight, where re-sending the original gets QUOTE_CHANGED", () => {
    const g = start();
    edit(g, (s) => withStock(s, "basic", 2));
    // The quote is checked at AGREE_DEAL (ADR 0022 decision 6), so "re-sending the original" re-sends the agreement.
    const { agree, agreed, command } = roadhouseSale(g, 1);
    const sourceId = applied(g, command);
    truckHome(g);

    // Cross midnights until the roadhouse's quote moves (quotes are fixed at midnight).
    let days = 0;
    while (quoteOf(g.sim.state, CROSSROADS_ROADHOUSE) === agreed) {
      if (++days > 10) throw new Error("The roadhouse quote didn't change within 10 midnights");
      to(g, (Math.floor(g.sim.state.tick / DAY) + 1) * DAY);
    }
    const current = quoteOf(g.sim.state, CROSSROADS_ROADHOUSE);
    expect(current).not.toBe(agreed);

    const stale = expectRejected(g, agree, "QUOTE_CHANGED");
    expect(stale).toEqual({ code: "QUOTE_CHANGED", buyerId: CROSSROADS_ROADHOUSE, agreed, current });

    const known = deliveryIds(g.sim.state);
    const result = run(g, repeat(sourceId));
    if (result.status !== "applied") throw new Error(`Expected applied, got ${JSON.stringify(result)}`);
    const delivery = deliveryAfter(g.sim.state, known);
    // The agreed price lives on the deal now (ADR 0022 decision 6).
    const deal = dealOf(g.sim.state, delivery.id);
    expect(deal.unitPrice).toBe(current);
    expect(delivery.purpose).toEqual({ kind: "SALE", buyerId: CROSSROADS_ROADHOUSE, dealId: deal.id });
    const buyer = g.sim.state.buyers.find((b) => b.id === CROSSROADS_ROADHOUSE)!;
    expect(buyer.commitments).toContainEqual(expect.objectContaining({ dealId: deal.id, quantity: 1, amount: current }));
    const tx = oneTx(g.sim.state, keys.dispatch(delivery.id));
    expectCausedBy(g, tx, result.commandId);
    const [dispatched] = eventsOfType(eventsOf(g, tx), "DELIVERY_DISPATCHED");
    expect(dispatched!.purpose).toEqual({ kind: "SALE", buyerId: CROSSROADS_ROADHOUSE, dealId: deal.id });

    // The source envelope in the log is unchanged (its price stays on its own AGREE_DEAL).
    expect(logEntry(g.sim.state, sourceId).command).toEqual(command);
  });
});

// ===========================================================================
// Inner rejections come through unchanged (rule 6)
// ===========================================================================

describe("REPEAT_OPERATION: the copied command's rejection comes through unchanged", () => {
  it("INSUFFICIENT_FUNDS from a repeated purchase, the same reason the original would get now", () => {
    const g = start();
    const command = buy(firstInput.materialId, 10);
    const sourceId = applied(g, command);
    edit(g, (s) => withCash(s, 0));
    const direct = expectRejected(g, command, "INSUFFICIENT_FUNDS");
    const reason = expectRejected(g, repeat(sourceId), "INSUFFICIENT_FUNDS");
    expect(reason).toEqual(direct);
  });

  it("INSUFFICIENT_MATERIALS from a repeated production run once the inputs are used up", () => {
    const g = start();
    buyInputs(g, 1);
    const command = produce(1);
    const sourceId = applied(g, command);
    to(g, g.sim.state.productionJobs[0]!.completesAt);
    const direct = expectRejected(g, command, "INSUFFICIENT_MATERIALS");
    const reason = expectRejected(g, repeat(sourceId), "INSUFFICIENT_MATERIALS");
    expect(reason).toEqual(direct);
  });

  it("ROUTE_CLOSED from a repeated sale when its route has closed", () => {
    const g = start();
    edit(g, (s) => withStock(s, "basic", 2));
    const sourceId = applied(g, roadhouseSale(g, 1).command);
    const command = logEntry(g.sim.state, sourceId).command as DispatchDeliveryCommand;
    truckHome(g);
    const at = g.sim.state.tick + 1;
    edit(g, (s) => scheduleWorldEvent(s, { kind: "ROUTE_CLOSURE", tick: tick(at), routeId: STATE_HIGHWAY, reason: "RIVAL", durationTicks: 600 }));
    to(g, at);
    expect(g.sim.state.routes.find((r) => r.id === STATE_HIGHWAY)!.closure).not.toBeNull();
    const direct = expectRejected(g, requoted(g, command), "ROUTE_CLOSED");
    const reason = expectRejected(g, repeat(sourceId), "ROUTE_CLOSED");
    expect(reason).toEqual(direct);
  });

  it("INSUFFICIENT_STOCK from a repeated sale once the stock is gone", () => {
    const g = start();
    edit(g, (s) => withStock(s, "basic", 1));
    const sourceId = applied(g, roadhouseSale(g, 1).command);
    const command = logEntry(g.sim.state, sourceId).command as DispatchDeliveryCommand;
    truckHome(g);
    const direct = expectRejected(g, requoted(g, command), "INSUFFICIENT_STOCK");
    const reason = expectRejected(g, repeat(sourceId), "INSUFFICIENT_STOCK");
    expect(reason).toEqual(direct);
  });
});

// ===========================================================================
// NOT_REPEATABLE
// ===========================================================================

describe("REPEAT_OPERATION: NOT_REPEATABLE { sourceCommandId }", () => {
  it("an unknown command ID", () => {
    const g = start();
    applied(g, buy(firstInput.materialId, 5));
    const unknown = asId("Command", "cmd-9999");
    expect(expectRejected(g, repeat(unknown), "NOT_REPEATABLE")).toEqual(notRepeatable(unknown));
  });

  it("a source that's still queued", () => {
    const g = start();
    const sourceId = queued(g, buy(firstInput.materialId, 5), g.sim.state.tick + 100);
    expect(expectRejected(g, repeat(sourceId), "NOT_REPEATABLE")).toEqual(notRepeatable(sourceId));
  });

  it("a source rejected at dispatch, so never in the log", () => {
    const g = start();
    const rejected = g.sim.dispatch({ command: buy(firstInput.materialId, 5, asId("Facility", "nowhere")) });
    expect(rejected.status).toBe("rejected");
    expect(g.sim.state.commandLog.some((e) => e.id === rejected.commandId)).toBe(false);
    expect(expectRejected(g, repeat(rejected.commandId), "NOT_REPEATABLE")).toEqual(notRepeatable(rejected.commandId));
  });

  it("a source rejected when its tick came: in the log, but never applied", () => {
    const g = start();
    // PURCHASE_MATERIALS only checks the quantity at dispatch, so an unknown facility is queued and fails when it applies.
    const at = g.sim.state.tick + 10;
    const sourceId = queued(g, buy(firstInput.materialId, 5, asId("Facility", "nowhere")), at);
    to(g, at);
    expect(logEntry(g.sim.state, sourceId)).toBeDefined();
    expect(eventsOfType(g.events, "COMMAND_REJECTED").map((e) => e.commandId)).toContain(sourceId);
    expect(expectRejected(g, repeat(sourceId), "NOT_REPEATABLE")).toEqual(notRepeatable(sourceId));
  });

  it("applied commands of a non-repeatable type: ACCEPT_CONTRACT, PURCHASE_EQUIPMENT, SET_WORKFORCE, RELEASE_RESERVATION", () => {
    const { g, acceptId, contractId } = acceptedKessler(16);

    const reservation = g.sim.state.reservations.find((r) => r.holder.kind === "CONTRACT" && r.holder.contractId === contractId);
    if (!reservation) throw new Error("Accepting reserved nothing");
    const releaseId = applied(g, { type: "RELEASE_RESERVATION", facilityId: reservation.facilityId, reservationId: reservation.id });

    const facility = g.sim.state.facilities.find((f) => f.id === DISTILLERY_MAIN)!;
    const workforceId = applied(g, { type: "SET_WORKFORCE", facilityId: DISTILLERY_MAIN, workerCount: facility.workerCount + 1 });

    // The first unowned item in data order. If it's gated (ADR 0020 decision 3), grant its unlock first.
    const item = GAME_DATA.equipment.find((e) => !facility.equipment.some((owned) => owned.equipmentId === e.id));
    if (!item) throw new Error("No unowned equipment");
    const unlockId = item.requiredUnlockId;
    if (unlockId !== null && !g.sim.state.family.unlocked.includes(unlockId)) {
      edit(g, (s) => ({ ...s, family: { ...s.family, unlocked: [...s.family.unlocked, unlockId].sort(compareIds) } }));
    }
    edit(g, (s) => withCash(s, cashOf(s) + item.price));
    const equipmentId = applied(g, { type: "PURCHASE_EQUIPMENT", facilityId: DISTILLERY_MAIN, equipmentId: item.id });

    for (const sourceId of [acceptId, equipmentId, workforceId, releaseId]) {
      expect(expectRejected(g, repeat(sourceId), "NOT_REPEATABLE")).toEqual(notRepeatable(sourceId));
    }
  });
});

// ===========================================================================
// Chains
// ===========================================================================

describe("REPEAT_OPERATION: chains", () => {
  it("a repeat of a repeat resolves to the underlying command", () => {
    const g = start();
    const sourceId = applied(g, buy(firstInput.materialId, 5));
    const r1 = applied(g, repeat(sourceId));
    const r2 = applied(g, repeat(r1));
    const r3 = applied(g, repeat(r2));
    for (const id of [r1, r2, r3]) {
      const tx = oneTx(g.sim.state, keys.purchase(id));
      expectCausedBy(g, tx, id);
      const [bought] = eventsOfType(eventsOf(g, tx), "MATERIALS_PURCHASED");
      expect(bought).toMatchObject({ materialId: firstInput.materialId, quantity: 5, facilityId: DISTILLERY_MAIN });
    }
    expect(logEntry(g.sim.state, r3).command).toEqual({ type: "REPEAT_OPERATION", sourceCommandId: r2 });
  });

  it("fails when a link was rejected when its tick came, though the underlying command still repeats", () => {
    const g = start();
    const sourceId = applied(g, buy(firstInput.materialId, 5));
    edit(g, (s) => withCash(s, 0));
    const at = g.sim.state.tick + 10;
    const r1 = queued(g, repeat(sourceId), at);
    to(g, at);
    const rejected = eventsOfType(g.events, "COMMAND_REJECTED").find((e) => e.commandId === r1);
    expect(rejected?.reason.code).toBe("INSUFFICIENT_FUNDS");
    edit(g, (s) => withCash(s, 100_000));

    expect(expectRejected(g, repeat(r1), "NOT_REPEATABLE")).toEqual(notRepeatable(r1));
    const direct = applied(g, repeat(sourceId));
    expectCausedBy(g, oneTx(g.sim.state, keys.purchase(direct)), direct);
  });

  it("fails when a link is a repeat of a non-repeatable command", () => {
    const g = start();
    const facility = g.sim.state.facilities.find((f) => f.id === DISTILLERY_MAIN)!;
    const workforceId = applied(g, { type: "SET_WORKFORCE", facilityId: DISTILLERY_MAIN, workerCount: facility.workerCount + 1 });
    const at = g.sim.state.tick + 10;
    const r1 = queued(g, repeat(workforceId), at);
    to(g, at);
    const rejected = eventsOfType(g.events, "COMMAND_REJECTED").find((e) => e.commandId === r1);
    expect(rejected?.reason).toEqual(notRepeatable(workforceId));
    expect(expectRejected(g, repeat(r1), "NOT_REPEATABLE")).toEqual(notRepeatable(r1));
  });
});

// ===========================================================================
// Queued repeats (ADR 0004)
// ===========================================================================

describe("REPEAT_OPERATION: queued repeats are validated only when they apply", () => {
  it("is queued while its source is still queued, and applies once the source has applied", () => {
    const g = start();
    const t = g.sim.state.tick;
    const sourceId = queued(g, buy(firstInput.materialId, 5), t + 10);
    const repeatId = queued(g, repeat(sourceId), t + 20);
    to(g, t + 20);
    expect(eventsOfType(g.events, "COMMAND_REJECTED")).toEqual([]);
    expectCausedBy(g, oneTx(g.sim.state, keys.purchase(sourceId)), sourceId);
    expectCausedBy(g, oneTx(g.sim.state, keys.purchase(repeatId)), repeatId);
    expect(g.sim.state.commandLog.map((e) => e.id)).toEqual([sourceId, repeatId]);
  });

  it("queues a repeat of an unknown source, then logs it and reports COMMAND_REJECTED with NOT_REPEATABLE", () => {
    const g = start();
    const unknown = asId("Command", "cmd-9999");
    const at = g.sim.state.tick + 10;
    const repeatId = queued(g, repeat(unknown), at);
    const transactions = g.sim.state.ledger.transactions.length;
    to(g, at);
    const rejected = eventsOfType(g.events, "COMMAND_REJECTED").filter((e) => e.commandId === repeatId);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ commandType: "REPEAT_OPERATION", reason: notRepeatable(unknown), causedBy: repeatId, tick: at });
    expect(logEntry(g.sim.state, repeatId).command).toEqual(repeat(unknown));
    expect(g.sim.state.ledger.transactions).toHaveLength(transactions);
  });

  it("logs and reports the copied command's own rejection when it fails as it applies", () => {
    const g = start();
    const sourceId = applied(g, buy(firstInput.materialId, 5));
    edit(g, (s) => withCash(s, 0));
    const at = g.sim.state.tick + 10;
    const repeatId = queued(g, repeat(sourceId), at);
    to(g, at);
    const rejected = eventsOfType(g.events, "COMMAND_REJECTED").filter((e) => e.commandId === repeatId);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.commandType).toBe("REPEAT_OPERATION");
    expect(rejected[0]!.reason.code).toBe("INSUFFICIENT_FUNDS");
    expect(logEntry(g.sim.state, repeatId)).toBeDefined();
    expect(keyed(g.sim.state, keys.purchase(repeatId))).toEqual([]);
  });
});

// ===========================================================================
// Replay
// ===========================================================================

/**
 * Replays a run's command log on a fresh game (ADR 0004 replay procedure): the
 * envelopes due at or before the end tick, then advance to it, then the rest.
 */
function replayLog(original: KernelSimulation): KernelSimulation {
  const end = original.state.tick;
  const replayed = newGame();
  const log = original.state.commandLog;
  for (const e of log) if (e.scheduledTick <= end) replayed.replay(e);
  replayed.advance(end - replayed.state.tick);
  for (const e of log) if (e.scheduledTick > end) replayed.replay(e);
  return replayed;
}

describe("REPEAT_OPERATION: replay", () => {
  it("replaying the command log, repeats included, reproduces the state hash", () => {
    const g = start();
    const cornId = applied(g, buy(firstInput.materialId, firstInput.quantity));
    const r1 = applied(g, repeat(cornId)); // applied now
    const others = recipe.inputsPerCase.slice(1).map((input) => applied(g, buy(input.materialId, input.quantity)));
    for (const id of others) queued(g, repeat(id), g.sim.state.tick + 5); // applied when queued
    queued(g, repeat(asId("Command", "cmd-9999")), g.sim.state.tick + 7); // rejected when it applies
    to(g, g.sim.state.tick + 10);

    const jobId = applied(g, produce(1));
    const job = g.sim.state.productionJobs[0]!;
    queued(g, repeat(jobId), job.completesAt + 1); // a second run once the first is done
    queued(g, repeat(r1), job.completesAt + 2); // a chain
    to(g, job.completesAt + 3);

    const saleId = applied(g, roadhouseSale(g, 1).command);
    truckHome(g);
    to(g, DAY + 30); // past midnight: a re-quoted repeat
    applied(g, repeat(saleId));
    queued(g, repeat(saleId), g.sim.state.tick + 10); // the truck is out: rejected when it applies
    to(g, DAY + 60);
    applied(g, repeat(r1)); // applied on the run's last tick

    const repeats = g.sim.state.commandLog.filter((e) => e.command.type === "REPEAT_OPERATION");
    expect(repeats.length).toBeGreaterThanOrEqual(7);
    const rejectedRepeats = eventsOfType(g.events, "COMMAND_REJECTED").filter((e) => e.commandType === "REPEAT_OPERATION");
    expect(rejectedRepeats.length).toBeGreaterThanOrEqual(2);
    expect(g.sim.state.queuedCommands).toEqual([]);

    const replayed = replayLog(g.sim);
    expect(replayed.state.commandLog).toEqual(g.sim.state.commandLog);
    expect(replayed.stateHash()).toBe(g.sim.stateHash());

    const resumed = loadGame(JSON.parse(JSON.stringify(g.sim.serialize())));
    expect(resumed.stateHash()).toBe(g.sim.stateHash());
  });
});

// ===========================================================================
// Sprint Zero guard
// ===========================================================================

describe("REPEAT_OPERATION: Sprint Zero", () => {
  it(`keeps the Sprint Zero replay hash at ${SPRINT_ZERO_HASH}`, () => {
    const sim = newGame();
    for (const input of recipe.inputsPerCase) {
      const r = sim.dispatch({ command: buy(input.materialId, input.quantity) });
      expect(r.status).toBe("applied");
    }
    expect(sim.dispatch({ command: produce(1) }).status).toBe("applied");
    sim.advance(sim.state.productionJobs[0]!.completesAt - sim.state.tick);
    expect(sim.dispatch({ command: agreement(CROSSROADS_ROADHOUSE, 1, quoteOf(sim.state, CROSSROADS_ROADHOUSE)) }).status).toBe("applied");
    expect(sim.dispatch({ command: sale(CROSSROADS_ROADHOUSE, 1, lastDealId(sim.state)) }).status).toBe("applied");
    sim.advance(sim.state.vehicles[0]!.trip!.arrivesAt - sim.state.tick);
    const resumed = loadGame(JSON.parse(JSON.stringify(sim.serialize())));
    const finalTick = sim.state.vehicles[0]!.trip!.arrivesAt;
    sim.advance(finalTick - sim.state.tick);
    resumed.advance(finalTick - resumed.state.tick);
    expect(sim.stateHash()).toBe(SPRINT_ZERO_HASH);
    expect(resumed.stateHash()).toBe(SPRINT_ZERO_HASH);
  });
});
