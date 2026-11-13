// Logistics (T03, ADR 0019): dispatch, route disruption, deal deadlines, the
// truck's return, and route closures.
//
// - DISPATCH_DELIVERY with purpose SALE carries out a held deal (ADR 0022
//   decision 6): the deal must be HELD (else DEAL_UNAVAILABLE) and match the
//   buyer and cargo (else CARGO_DOES_NOT_MATCH_DEAL). The deal becomes
//   DISPATCHED; its commitment (made by AGREE_DEAL) rides with it. Unreserved
//   cargo leaves finished goods at its pool cost, and that cost moves to goods in
//   transit. The deal deadline is M001's arrival plus the route's
//   `dealGraceTicks`, capped at the deal's `expiresAt`.
// - A REPEAT_OPERATION of a sale (founder rules off) re-agrees at the buyer's
//   current quote inside the dispatch's own transaction (`dispatchRequotedSale`),
//   with M001's check order: the buyer's checks after the stock check. With
//   founder rules on, a repeated sale goes on spec (`commands/repeat.ts`).
// - A sale on spec (`dealId: null`, ADR 0022 decision 6) checks nothing against
//   the buyer at dispatch, commits nothing, and has no deal deadline. On arrival
//   the buyer takes what the world allows at that moment (`arriveOnSpec`).
// - Every dispatch records its driver and counts the vehicle's trip
//   (`tripCount`, ADR 0022 decision 8). With founder rules off a FOUNDER driver
//   doesn't put the founder aboard (ADR 0023 decision 9).
// - DISPATCH_DELIVERY with purpose CONTRACT_INSTALLMENT (T02e, ADR 0018
//   decisions 5–6) draws the contract's reservations first (`takeForContract`)
//   and commits nothing on the buyer. Contract deliveries have no deal deadline.
// - Dispatch is never rejected for lack of cash (ADR 0019 decision 2).
// - The vehicles phase resolves trips in vehicle ID order. When an outbound leg
//   on a risky route (`riskPpm` > 0) is due and hasn't been delayed, it draws
//   decision 3's two draws from the trip's own stream (`tripRng`: the game
//   seed, the vehicle and its trip ordinal; ADR 0022 decision 8): clear,
//   delayed, or seized. Nothing is stored, so the master `rng.routes` stream
//   never moves for a trip. Each outcome commits its own keyed transaction.
//   Safe routes draw nothing.
// - A sale arriving after its deal deadline falls through (decision 4). A
//   seizure or a fall-through turns the truck home in the same transaction, and
//   the deal ends FELL_THROUGH: its commitment is released and it leaves
//   `heldDeals` (ADR 0022 decision 6).
// - An outbound arrival is otherwise paid cash on delivery: revenue and cost of
//   goods sold are recognized now (FIN-001), the deal ends SETTLED, and the
//   truck drives home. A sale on spec is paid for what the buyer takes; the
//   rest rides home on the FAILED path, as a transfer's overflow does.
// - The VEHICLE_RETURN transaction pays or accrues the trip's transport cost
//   and unloads a failed delivery's cargo into the home pool, unreserved.
// - ROUTE_CLOSURE / ROUTE_REOPENING world events close and reopen routes
//   (decision 5).
//
// - DISPATCH_DELIVERY with purpose TRANSFER (T03b, #76) moves unreserved stock
//   from the vehicle's home to another owned facility at book value. It rolls no
//   route risk and touches no buyer. On arrival the destination takes what its
//   storage has room for (TRANSFER_COMPLETED), and the rest goes home unreserved.
//
// Limits (M001): transfers leave only from the vehicle's home, and a trip carries
// one cargo line (decision 6).
//
// With founder rules on (ADR 0023 decision 5, SK1a):
// - A new dispatch needs a driver: the founder, PRESENT at the place the truck is
//   parked (else NO_DRIVER; a hired Driver is ADR 0025's), and the truck parked
//   there with no trip (else VEHICLE_NOT_AT, naming the founder's place, never
//   the truck's).
// - The dispatch origin is the owned facility at the founder's place, recorded
//   in `fromFacilityId`. The route and the stock are resolved from it, and the
//   truck returns there: returned cargo unloads into it, VEHICLE_RETURNED names
//   its location, and the truck is parked there again.
// - The founder loads the truck first (LOAD_TRUCK, decision 4): the trip departs
//   when loading ends (`departedAt`), and its arrival and deal deadline count
//   from then. The founder phase sets `parkedAt: null` at the departure.
// With founder rules off the origin is the vehicle's home, as in M001, and
// `parkedAt` never changes.

import {
  addMoney,
  addTicks,
  compareById,
  divideMoney,
  idempotencyKey,
  multiplyMoney,
  subtractMoney,
  ZERO_MONEY,
  type BuyerId,
  type CargoLine,
  type ContractId,
  type CargoLineState,
  type DealId,
  type DeliveryPurpose,
  type DeliveryState,
  type DispatchDeliveryCommand,
  type FacilityId,
  type GameState,
  type HeldDealState,
  type LocationId,
  type Money,
  type RejectionReason,
  type RngState,
  type RouteId,
  type RouteState,
  type Tick,
  type TransactionCoordinator,
  type TransactionDraft,
  type VehicleState,
} from "@eov/contracts";
import type { GameData, RouteDefinition } from "@eov/game-data";
import { contractForCargo, contractLoadRejection, creditCases, withCredit } from "../contracts/rules.ts";
import { cashBalance } from "../economy/ledger/ledger.ts";
import { cargoLossEntries, dispatchEntries, payOrAccrueEntries, returnFromTransitEntries, saleEntries } from "../economy/ledger/postings.ts";
import {
  agreeDeal,
  currentQuote,
  dispatchDeal,
  endDeal,
  findCommitment,
  heldDeal,
  quoteDeal,
  releaseDeal,
  settleDeal,
  type Deal,
} from "../economy/market/market.ts";
import { scheduleWorldEvent } from "../events/world-events.ts";
import { addProduct, allocateRemovalCost, availableProduct, takeForContract, takeProduct } from "../inventory/pools.ts";
import { storageAvailable } from "../production/capacity.ts";
import { activityTicks } from "../founder/time.ts";
import { allocateId, formatId } from "../kernel/ids.ts";
import type { CommandContext, CommandOutcome, SystemRegistry, TickContext } from "../kernel/registry.ts";
import { M001_RULES, type GameRules } from "../kernel/rules.ts";
import { nextInt, tripRng } from "../rng/xoshiro128.ts";
import { playerViewOf, type IssuerView } from "../view/issuer-view.ts";
import type { OrderValidator } from "../view/order.ts";
import { busyRejection } from "../view/presence.ts";
import type { ViewWorld, WorldSlice } from "../view/world.ts";

/** The draw bound for route disruption: parts per million (ADR 0019 decision 3). */
const PPM = 1_000_000;

/** The route a trip takes: the requested one if it connects the two places, else the first listed (the default). */
export function resolveRoute(data: GameData, from: LocationId, to: LocationId, requested: RouteId | null): RouteDefinition | null {
  return data.routes.find((r) => r.fromLocationId === from && r.toLocationId === to && (requested === null || r.id === requested)) ?? null;
}

function routeDefinition(data: GameData, routeId: RouteId): RouteDefinition {
  const route = data.routes.find((r) => r.id === routeId);
  if (!route) throw new RangeError(`Unknown route ${routeId}`);
  return route;
}

/**
 * A sale's dispatch: the HELD deal it carries out (ADR 0022 decision 6); on spec,
 * with no deal; or, for a repeated sale with founder rules off, the quote it
 * re-agrees at in the dispatch's own transaction.
 */
interface DispatchPlan {
  readonly route: RouteDefinition;
  readonly sale:
    | { readonly kind: "HELD"; readonly deal: HeldDealState }
    | { readonly kind: "SPEC" }
    | { readonly kind: "REQUOTE"; readonly quote: Deal };
  readonly line: CargoLine;
  readonly homeId: FacilityId;
}

/** How a sale dispatch finds its deal: the one it names (none, on spec), or a new one at today's quote (a repeat, founder rules off). */
type SaleTerms = "NAMED_DEAL" | "REQUOTE";

/** A contract installment's dispatch (ADR 0018 decision 5): no deal, cargo drawn for the contract. */
interface ContractDispatchPlan {
  readonly route: RouteDefinition;
  readonly contractId: ContractId;
  readonly line: CargoLine;
  readonly homeId: FacilityId;
}

/** A transfer's dispatch (T03b, #76): unreserved stock from home, bound for another owned facility. */
interface TransferDispatchPlan {
  readonly route: RouteDefinition;
  readonly line: CargoLine;
  readonly homeId: FacilityId;
  readonly destinationFacilityId: FacilityId;
}

function withVehicle(state: GameState, vehicleId: VehicleState["id"], trip: VehicleState["trip"]): GameState {
  return { ...state, vehicles: state.vehicles.map((v) => (v.id === vehicleId ? { ...v, trip } : v)) };
}

/** A dispatch sets the truck's outbound trip and counts it (`tripCount`, ADR 0022 decision 8). */
function departing(state: GameState, vehicleId: VehicleState["id"], trip: NonNullable<VehicleState["trip"]>): GameState {
  return { ...state, vehicles: state.vehicles.map((v) => (v.id === vehicleId ? { ...v, tripCount: v.tripCount + 1, trip } : v)) };
}

/** The deal a sale delivery carries out, or null for a sale on spec. */
function dealIdOf(delivery: DeliveryState): DealId | null {
  if (delivery.purpose.kind !== "SALE") throw new RangeError(`Delivery ${delivery.id} isn't a sale`);
  return delivery.purpose.dealId;
}

function withParkedAt(state: GameState, vehicleId: VehicleState["id"], parkedAt: LocationId): GameState {
  return { ...state, vehicles: state.vehicles.map((v) => (v.id === vehicleId ? { ...v, parkedAt } : v)) };
}

function withDelivery(state: GameState, deliveryId: DeliveryState["id"], status: DeliveryState["status"]): GameState {
  return { ...state, deliveries: state.deliveries.map((d) => (d.id === deliveryId ? { ...d, status } : d)) };
}

function withCargo(state: GameState, deliveryId: DeliveryState["id"], cargo: DeliveryState["cargo"]): GameState {
  return { ...state, deliveries: state.deliveries.map((d) => (d.id === deliveryId ? { ...d, cargo } : d)) };
}

function withRoute(state: GameState, routeId: RouteId, closure: RouteState["closure"]): GameState {
  return { ...state, routes: state.routes.map((r) => (r.id === routeId ? { ...r, closure } : r)) };
}

function cargoLine(line: CargoLineState): CargoLine {
  return { productId: line.productId, quality: line.quality, quantity: line.quantity };
}

function cargoCost(cargo: readonly CargoLineState[]) {
  return cargo.reduce((sum, line) => addMoney(sum, line.cost), ZERO_MONEY);
}

/** An outbound SALE arrives: cash on delivery at the deal's price, revenue and COGS recognized, the deal SETTLED, truck heads home. */
function arriveForSale(
  state: GameState,
  vehicle: VehicleState,
  delivery: DeliveryState,
  data: GameData,
  coordinator: TransactionCoordinator,
  ctx: TickContext,
): GameState {
  if (delivery.purpose.kind !== "SALE") throw new RangeError(`Delivery ${delivery.id} isn't a sale`);
  const { buyerId } = delivery.purpose;
  const dealId = dealIdOf(delivery);
  if (dealId === null) return arriveOnSpec(state, vehicle, delivery, data, coordinator, ctx);
  const route = data.routes.find((r) => r.id === delivery.routeId);
  if (!route) throw new RangeError(`Delivery ${delivery.id} uses unknown route ${delivery.routeId}`);
  const tx = coordinator.begin(state, {
    kind: "SALE",
    idempotencyKey: idempotencyKey("SALE", delivery.id),
    tick: ctx.tick,
    causedBy: null,
  });
  if (tx.status === "duplicate") return state;

  const commitment = findCommitment(tx.state, buyerId, dealId);
  if (!commitment) throw new RangeError(`Delivery ${delivery.id} has no deal with ${buyerId}`);
  const revenue = commitment.amount;
  const cogs = cargoCost(delivery.cargo);
  const cases = delivery.cargo.reduce((n, line) => n + line.quantity, 0);

  tx.update((s) => endDeal(settleDeal(s, buyerId, dealId), dealId));
  tx.update((s) => withDelivery(s, delivery.id, "DELIVERED"));
  tx.update((s) =>
    withVehicle(s, vehicle.id, {
      deliveryId: delivery.id,
      routeId: delivery.routeId,
      leg: "RETURN",
      departedAt: ctx.tick,
      arrivesAt: addTicks(ctx.tick, route.durationTicks),
      delayed: false,
    }),
  );
  tx.post(saleEntries({ revenue, costOfGoodsSold: cogs }));
  tx.emit({
    type: "SALE_COMPLETED",
    deliveryId: delivery.id,
    buyerId,
    cargo: delivery.cargo.map(cargoLine),
    unitPrice: divideMoney(revenue, cases),
    revenue,
    costOfGoodsSold: cogs,
    contractId: null,
    transactionId: tx.transactionId,
  });
  const result = tx.commit();
  if (result.status !== "committed") throw new RangeError(`Sale for ${delivery.id} was rejected: ${result.reason.code}`);
  return result.state;
}

/**
 * What a buyer takes of a sale on spec, judged on the world at arrival (ADR 0022
 * decision 6): nothing if the buyer doesn't want the product at that quality or
 * the family's reputation is below the buyer's minimum; otherwise
 * min(cargo, demand remaining, floor(budget / quote)) at that day's quote, the
 * ECO-001 liquidity formula. `quote` is null when the buyer wants nothing the
 * cargo meets.
 */
function specTake(state: GameState, data: GameData, buyerId: BuyerId, line: CargoLine): { readonly deal: Deal | null; readonly quote: Money | null } {
  const quote = currentQuote(state, buyerId, line);
  if (quote === null) return { deal: null, quote };
  const whole = quoteDeal(state, data, buyerId, quote, line);
  if (!("code" in whole)) return { deal: whole, quote };
  if (whole.code !== "BUYER_WILL_TAKE_LESS" || whole.acceptable <= 0) return { deal: null, quote };
  const part = quoteDeal(state, data, buyerId, quote, { ...line, quantity: whole.acceptable });
  return { deal: "code" in part ? null : part, quote };
}

/** A sale on spec spends the buyer's demand (on the matched want) and budget at once: no commitment is held. */
function spendOnSpec(state: GameState, deal: Deal, line: CargoLine): GameState {
  return {
    ...state,
    buyers: state.buyers.map((b) =>
      b.id !== deal.buyerId
        ? b
        : {
            ...b,
            budgetRemaining: subtractMoney(b.budgetRemaining, deal.amount),
            wants: b.wants.map((w) =>
              w.productId === line.productId && w.minimumQuality === deal.wantQuality ? { ...w, demandRemaining: w.demandRemaining - deal.quantity } : w,
            ),
          },
    ),
  };
}

/**
 * An outbound sale on spec arrives (ADR 0022 decision 6), following the
 * transfer precedent (`arriveForTransfer`). The buyer's take is computed from the
 * world now (`specTake`), at any hour.
 * - Something taken: one SALE transaction keyed by the delivery. Cash on
 *   delivery for the accepted cases at the day's quote, their cost of goods sold
 *   split from the line with `allocateRemovalCost`, SALE_COMPLETED for them, then
 *   SPEC_SALE_SETTLED. Everything sold: DELIVERED. A remainder: the delivery is
 *   FAILED and its cargo is what's left, at the cost it still carries, which
 *   VEHICLE_RETURN unloads at home unreserved.
 * - Nothing taken: a no-entry DISPATCH transaction keyed
 *   `DISPATCH:<deliveryId>:SPEC_SETTLED` (as `fallThrough` uses
 *   `DISPATCH:<id>:FELL_THROUGH`), SPEC_SALE_SETTLED with `accepted: 0`, then
 *   DEAL_FELL_THROUGH { reason: "NOT_WANTED" }; the delivery FAILED with all its
 *   cargo aboard. No reputation change in M002.
 * The truck heads home either way.
 */
function arriveOnSpec(
  state: GameState,
  vehicle: VehicleState,
  delivery: DeliveryState,
  data: GameData,
  coordinator: TransactionCoordinator,
  ctx: TickContext,
): GameState {
  if (delivery.purpose.kind !== "SALE" || delivery.purpose.dealId !== null) throw new RangeError(`Delivery ${delivery.id} isn't a sale on spec`);
  const { buyerId } = delivery.purpose;
  const route = routeDefinition(data, delivery.routeId);
  const line = delivery.cargo[0];
  if (delivery.cargo.length !== 1 || !line) throw new RangeError(`Sale on spec ${delivery.id} must carry one cargo line`);
  const { deal, quote } = specTake(state, data, buyerId, cargoLine(line));
  const offered = line.quantity;

  if (deal === null) {
    const tx = coordinator.begin(state, {
      kind: "DISPATCH",
      idempotencyKey: idempotencyKey("DISPATCH", delivery.id, "SPEC_SETTLED"),
      tick: ctx.tick,
      causedBy: null,
    });
    if (tx.status === "duplicate") return state;
    tx.update((s) => withDelivery(s, delivery.id, "FAILED"));
    tx.update((s) => withVehicle(s, vehicle.id, homewardTrip(delivery, route, ctx)));
    tx.emit({ type: "SPEC_SALE_SETTLED", deliveryId: delivery.id, buyerId, offered, accepted: 0, unitPrice: quote ?? ZERO_MONEY });
    tx.emit({ type: "DEAL_FELL_THROUGH", deliveryId: delivery.id, buyerId, reason: "NOT_WANTED" });
    return commitOrThrow(tx, `Sale on spec ${delivery.id}, nothing taken`);
  }

  const tx = coordinator.begin(state, {
    kind: "SALE",
    idempotencyKey: idempotencyKey("SALE", delivery.id),
    tick: ctx.tick,
    causedBy: null,
  });
  if (tx.status === "duplicate") return state;
  const accepted = deal.quantity;
  const cogs = allocateRemovalCost(line.cost, line.quantity, accepted);
  const left = line.quantity - accepted;
  tx.update((s) => spendOnSpec(s, deal, cargoLine(line)));
  if (left === 0) {
    tx.update((s) => withDelivery(s, delivery.id, "DELIVERED"));
  } else {
    const aboard: CargoLineState = { ...line, quantity: left, cost: subtractMoney(line.cost, cogs) };
    tx.update((s) => withCargo(withDelivery(s, delivery.id, "FAILED"), delivery.id, [aboard]));
  }
  tx.update((s) => withVehicle(s, vehicle.id, homewardTrip(delivery, route, ctx)));
  tx.post(saleEntries({ revenue: deal.amount, costOfGoodsSold: cogs }));
  tx.emit({
    type: "SALE_COMPLETED",
    deliveryId: delivery.id,
    buyerId,
    cargo: [{ productId: line.productId, quality: line.quality, quantity: accepted }],
    unitPrice: deal.unitPrice,
    revenue: deal.amount,
    costOfGoodsSold: cogs,
    contractId: null,
    transactionId: tx.transactionId,
  });
  tx.emit({ type: "SPEC_SALE_SETTLED", deliveryId: delivery.id, buyerId, offered, accepted, unitPrice: deal.unitPrice });
  return commitOrThrow(tx, `Sale on spec ${delivery.id}`);
}

/**
 * An outbound CONTRACT_INSTALLMENT arrives (ADR 0018 decision 6): cash on
 * delivery at the contract price, the cases credited to unsettled installments
 * whose deadline is still ahead (or now), in index order. Extra cases are paid
 * for but credit nothing. The truck heads home, as after a sale.
 */
function arriveForContract(
  state: GameState,
  vehicle: VehicleState,
  delivery: DeliveryState,
  data: GameData,
  coordinator: TransactionCoordinator,
  ctx: TickContext,
): GameState {
  if (delivery.purpose.kind !== "CONTRACT_INSTALLMENT") throw new RangeError(`Delivery ${delivery.id} isn't a contract installment`);
  const { contractId } = delivery.purpose;
  const route = data.routes.find((r) => r.id === delivery.routeId);
  if (!route) throw new RangeError(`Delivery ${delivery.id} uses unknown route ${delivery.routeId}`);
  const tx = coordinator.begin(state, {
    kind: "SALE",
    idempotencyKey: idempotencyKey("SALE", delivery.id),
    tick: ctx.tick,
    causedBy: null,
  });
  if (tx.status === "duplicate") return state;

  const contract = tx.state.contracts.find((c) => c.id === contractId);
  if (!contract) throw new RangeError(`Delivery ${delivery.id} is for unknown contract ${contractId}`);
  const cases = delivery.cargo.reduce((n, line) => n + line.quantity, 0);
  const revenue = multiplyMoney(contract.unitPrice, cases);
  const cogs = cargoCost(delivery.cargo);
  const credit = creditCases(contract.installments, cases, ctx.tick);

  tx.update((s) => ({ ...s, contracts: s.contracts.map((c) => (c.id === contractId ? withCredit(c, credit) : c)) }));
  tx.update((s) => withDelivery(s, delivery.id, "DELIVERED"));
  tx.update((s) =>
    withVehicle(s, vehicle.id, {
      deliveryId: delivery.id,
      routeId: delivery.routeId,
      leg: "RETURN",
      departedAt: ctx.tick,
      arrivesAt: addTicks(ctx.tick, route.durationTicks),
      delayed: false,
    }),
  );
  tx.post(saleEntries({ revenue, costOfGoodsSold: cogs }));
  tx.emit({
    type: "SALE_COMPLETED",
    deliveryId: delivery.id,
    buyerId: contract.buyerId,
    cargo: delivery.cargo.map(cargoLine),
    unitPrice: contract.unitPrice,
    revenue,
    costOfGoodsSold: cogs,
    contractId,
    transactionId: tx.transactionId,
  });
  const result = tx.commit();
  if (result.status !== "committed") throw new RangeError(`Contract delivery ${delivery.id} was rejected: ${result.reason.code}`);
  return result.state;
}

/**
 * An outbound TRANSFER arrives (T03b, #76), in one TRANSFER transaction keyed by
 * the delivery. The destination takes as many cases as its storage has room for
 * (`storageAvailable`: capacity less cases held and running jobs' output), into
 * its pool unreserved at their book value (Dr FINISHED_GOODS / Cr GOODS_IN_TRANSIT,
 * so net worth doesn't change, FIN-001), and TRANSFER_COMPLETED reports them.
 * The truck heads home either way:
 * - everything unloaded: the delivery is DELIVERED and keeps its cargo as the record;
 * - anything left aboard: the delivery is FAILED and its cargo is what's left,
 *   at the cost it still carries, which VEHICLE_RETURN unloads into the home pool
 *   unreserved (ADR 0013 decision 6). Nothing unloaded emits no TRANSFER_COMPLETED.
 */
function arriveForTransfer(
  state: GameState,
  vehicle: VehicleState,
  delivery: DeliveryState,
  data: GameData,
  coordinator: TransactionCoordinator,
  ctx: TickContext,
): GameState {
  if (delivery.purpose.kind !== "TRANSFER") throw new RangeError(`Delivery ${delivery.id} isn't a transfer`);
  const { destinationFacilityId } = delivery.purpose;
  const route = routeDefinition(data, delivery.routeId);
  const line = delivery.cargo[0];
  if (delivery.cargo.length !== 1 || !line) throw new RangeError(`Transfer ${delivery.id} must carry one cargo line`);
  const tx = coordinator.begin(state, {
    kind: "TRANSFER",
    idempotencyKey: idempotencyKey("TRANSFER", delivery.id),
    tick: ctx.tick,
    causedBy: null,
  });
  if (tx.status === "duplicate") return state;

  const unloaded = Math.min(line.quantity, storageAvailable(tx.state, data, destinationFacilityId));
  const unloadedCost = unloaded > 0 ? allocateRemovalCost(line.cost, line.quantity, unloaded) : ZERO_MONEY;
  const left = line.quantity - unloaded;
  if (unloaded > 0) {
    tx.update((s) => addProduct(s, destinationFacilityId, line.productId, line.quality, unloaded, unloadedCost));
    tx.post(returnFromTransitEntries(unloadedCost));
    tx.emit({
      type: "TRANSFER_COMPLETED",
      deliveryId: delivery.id,
      destinationFacilityId,
      cargo: [{ productId: line.productId, quality: line.quality, quantity: unloaded }],
      bookValue: unloadedCost,
    });
  }
  if (left === 0) {
    tx.update((s) => withDelivery(s, delivery.id, "DELIVERED"));
  } else {
    const aboard: CargoLineState = { ...line, quantity: left, cost: subtractMoney(line.cost, unloadedCost) };
    tx.update((s) => withCargo(withDelivery(s, delivery.id, "FAILED"), delivery.id, [aboard]));
  }
  tx.update((s) => withVehicle(s, vehicle.id, homewardTrip(delivery, route, ctx)));
  return commitOrThrow(tx, `Transfer ${delivery.id}`);
}

/**
 * The truck is home (ADR 0019 decisions 2 and 4), in one VEHICLE_RETURN
 * transaction keyed by the delivery so a return applies once:
 * - the trip's transport cost is paid from cash, and any shortfall accrues to
 *   WAGES_PAYABLE (the driver is paid with the nightly payroll);
 * - a FAILED delivery's cargo (a sale that fell through, or what a transfer
 *   couldn't unload) unloads into the home
 *   pool unreserved, at its cost, even over storage capacity, and the delivery's
 *   cargo is then emptied. A seized delivery's cargo is already empty, and a
 *   delivered one brings nothing home.
 */
function returnHome(
  state: GameState,
  vehicle: VehicleState,
  data: GameData,
  coordinator: TransactionCoordinator,
  ctx: TickContext,
  rules: GameRules,
): GameState {
  const trip = vehicle.trip!;
  // The trip ends where it started (ADR 0023 decision 5): the delivery's origin.
  // With founder rules off every delivery leaves from the vehicle's home, so
  // that's the home facility, as in M001.
  const fromFacilityId = state.deliveries.find((d) => d.id === trip.deliveryId)?.fromFacilityId;
  const home = data.facilities.find((f) => f.id === fromFacilityId);
  if (!home) throw new RangeError(`Vehicle ${vehicle.id} is returning to unknown facility ${String(fromFacilityId)}`);
  const route = routeDefinition(data, trip.routeId);
  const tx = coordinator.begin(state, {
    kind: "VEHICLE_RETURN",
    idempotencyKey: idempotencyKey("VEHICLE_RETURN", trip.deliveryId),
    tick: ctx.tick,
    causedBy: null,
  });
  if (tx.status === "duplicate") return state;

  const delivery = tx.state.deliveries.find((d) => d.id === trip.deliveryId);
  if (!delivery) throw new RangeError(`Vehicle ${vehicle.id} is returning from unknown delivery ${trip.deliveryId}`);
  const returned = delivery.status === "FAILED" ? delivery.cargo : [];

  tx.update((s) => withVehicle(s, vehicle.id, null));
  if (rules.founderRules) tx.update((s) => withParkedAt(s, vehicle.id, home.locationId));
  if (returned.length > 0) {
    tx.update((s) =>
      returned.reduce((acc, line) => addProduct(acc, home.id, line.productId, line.quality, line.quantity, line.cost), s),
    );
    tx.update((s) => withCargo(s, delivery.id, []));
  }
  tx.post([
    ...payOrAccrueEntries({
      amount: route.transportCost,
      expense: "TRANSPORT_EXPENSE",
      payable: "WAGES_PAYABLE",
      cashAvailable: cashBalance(tx.state),
    }),
    ...returnFromTransitEntries(cargoCost(returned)),
  ]);
  tx.emit({
    type: "VEHICLE_RETURNED",
    vehicleId: vehicle.id,
    deliveryId: trip.deliveryId,
    locationId: home.locationId,
    returnedCargo: returned.map(cargoLine),
  });
  const result = tx.commit();
  if (result.status !== "committed") throw new RangeError(`Return of ${vehicle.id} from ${trip.deliveryId} was rejected: ${result.reason.code}`);
  return result.state;
}

/** The return leg a truck takes when it turns home at `ctx.tick` (ADR 0019 decision 3). */
function homewardTrip(delivery: DeliveryState, route: RouteDefinition, ctx: TickContext): VehicleState["trip"] {
  return {
    deliveryId: delivery.id,
    routeId: route.id,
    leg: "RETURN",
    departedAt: ctx.tick,
    arrivesAt: addTicks(ctx.tick, route.durationTicks),
    delayed: false,
  };
}

type Disruption = "CLEAR" | "DELAY" | "SEIZE";

/**
 * Decision 3's draws on a risky route: `a < riskPpm` disrupts the trip, then
 * `b < seizureSharePpm` seizes the cargo, otherwise the trip is delayed. `rng`
 * is the trip's own stream (`tripRng`, ADR 0022 decision 8), fresh for each
 * trip, so the advanced stream is never kept.
 */
function drawDisruption(rng: RngState, route: RouteDefinition): Disruption {
  const a = nextInt(rng, PPM);
  if (a.value >= route.riskPpm) return "CLEAR";
  const b = nextInt(a.rng, PPM);
  return b.value < route.seizureSharePpm ? "SEIZE" : "DELAY";
}

function commitOrThrow(tx: TransactionDraft, what: string): GameState {
  const result = tx.commit();
  if (result.status !== "committed") throw new RangeError(`${what} was rejected: ${JSON.stringify(result.reason)}`);
  return result.state;
}

/**
 * A risky trip got through: a no-entry, no-event DISPATCH transaction records
 * it (decision 3). It changes no state: the draw came from the trip's own
 * stream, which isn't stored (ADR 0022 decision 8).
 */
function commitClear(state: GameState, delivery: DeliveryState, coordinator: TransactionCoordinator, ctx: TickContext): GameState {
  const tx = coordinator.begin(state, {
    kind: "DISPATCH",
    idempotencyKey: idempotencyKey("DISPATCH", delivery.id, "CLEAR"),
    tick: ctx.tick,
    causedBy: null,
  });
  if (tx.status === "duplicate") return state;
  return commitOrThrow(tx, `Clear run for ${delivery.id}`);
}

/** A risky trip is delayed: it arrives `delayTicks` later and won't draw again (decision 3). */
function delayTrip(
  state: GameState,
  vehicle: VehicleState,
  delivery: DeliveryState,
  route: RouteDefinition,
  coordinator: TransactionCoordinator,
  ctx: TickContext,
): GameState {
  const trip = vehicle.trip!;
  const tx = coordinator.begin(state, {
    kind: "DISPATCH",
    idempotencyKey: idempotencyKey("DISPATCH", delivery.id, "DELAY"),
    tick: ctx.tick,
    causedBy: null,
  });
  if (tx.status === "duplicate") return state;
  const arrivesAt = addTicks(trip.arrivesAt, route.delayTicks);
  tx.update((s) => withVehicle(s, vehicle.id, { ...trip, arrivesAt, delayed: true }));
  tx.emit({ type: "DELIVERY_DELAYED", deliveryId: delivery.id, routeId: route.id, previousArrivesAt: trip.arrivesAt, arrivesAt });
  return commitOrThrow(tx, `Delay of ${delivery.id}`);
}

/**
 * A risky trip's cargo is seized (decision 3): written off under CARGO_LOSS, a
 * sale's deal released, the delivery FAILED with its cargo emptied, and the truck
 * turned home empty, all in one transaction. A sale on spec has no deal to
 * release, so it emits no DEAL_FELL_THROUGH: CARGO_LOST reports it.
 */
function seizeCargo(
  state: GameState,
  vehicle: VehicleState,
  delivery: DeliveryState,
  route: RouteDefinition,
  data: GameData,
  coordinator: TransactionCoordinator,
  ctx: TickContext,
): GameState {
  const tx = coordinator.begin(state, {
    kind: "CARGO_LOSS",
    idempotencyKey: idempotencyKey("CARGO_LOSS", delivery.id),
    tick: ctx.tick,
    causedBy: null,
  });
  if (tx.status === "duplicate") return state;
  const bookValue = cargoCost(delivery.cargo);
  tx.post(cargoLossEntries(bookValue));
  tx.emit({
    type: "CARGO_LOST",
    deliveryId: delivery.id,
    vehicleId: vehicle.id,
    cargo: delivery.cargo.map(cargoLine),
    bookValue,
    transactionId: tx.transactionId,
  });
  const dealId = delivery.purpose.kind === "SALE" ? dealIdOf(delivery) : null;
  if (delivery.purpose.kind === "SALE" && dealId !== null) {
    // A seizure is one of the ways a dispatched deal falls through (ADR 0022 decision 6).
    const { buyerId } = delivery.purpose;
    tx.update((s) => endDeal(releaseDeal(s, data, buyerId, dealId), dealId));
    tx.emit({ type: "DEAL_FELL_THROUGH", deliveryId: delivery.id, buyerId, reason: "CARGO_LOST" });
  }
  tx.update((s) => withCargo(withDelivery(s, delivery.id, "FAILED"), delivery.id, []));
  tx.update((s) => withVehicle(s, vehicle.id, homewardTrip(delivery, route, ctx)));
  return commitOrThrow(tx, `Seizure of ${delivery.id}`);
}

/**
 * A sale arrived after its deal deadline (decision 4): the deal is released,
 * the delivery FAILED, and the truck turns home with its cargo still aboard.
 * No reputation change for a failed spot deal.
 */
function fallThrough(
  state: GameState,
  vehicle: VehicleState,
  delivery: DeliveryState,
  route: RouteDefinition,
  data: GameData,
  coordinator: TransactionCoordinator,
  ctx: TickContext,
): GameState {
  if (delivery.purpose.kind !== "SALE") throw new RangeError(`Delivery ${delivery.id} has no deal to fall through`);
  const { buyerId } = delivery.purpose;
  const tx = coordinator.begin(state, {
    kind: "DISPATCH",
    idempotencyKey: idempotencyKey("DISPATCH", delivery.id, "FELL_THROUGH"),
    tick: ctx.tick,
    causedBy: null,
  });
  if (tx.status === "duplicate") return state;
  // Only a deal-backed sale has a deadline (ADR 0022 decision 6), so it has a deal.
  const dealId = dealIdOf(delivery);
  if (dealId === null) throw new RangeError(`Sale on spec ${delivery.id} has no deal deadline to miss`);
  tx.update((s) => endDeal(releaseDeal(s, data, buyerId, dealId), dealId));
  tx.update((s) => withDelivery(s, delivery.id, "FAILED"));
  tx.update((s) => withVehicle(s, vehicle.id, homewardTrip(delivery, route, ctx)));
  tx.emit({ type: "DEAL_FELL_THROUGH", deliveryId: delivery.id, buyerId, reason: "TOO_LATE" });
  return commitOrThrow(tx, `Fall-through of ${delivery.id}`);
}

/**
 * An outbound leg is due. On a risky route that hasn't been delayed yet, draw
 * the disruption first (decision 3); a delay or seizure ends this tick's work for
 * the trip. Then a sale past its deal deadline falls through (decision 4), and
 * anything else arrives: with founder rules on, an installment for a contract
 * that has closed since falls through (`contractClosed`).
 */
function resolveOutbound(
  state: GameState,
  vehicle: VehicleState,
  data: GameData,
  coordinator: TransactionCoordinator,
  ctx: TickContext,
  rules: GameRules,
): GameState {
  const trip = vehicle.trip!;
  const delivery = state.deliveries.find((d) => d.id === trip.deliveryId);
  if (!delivery) throw new RangeError(`Vehicle ${vehicle.id} is carrying unknown delivery ${trip.deliveryId}`);
  const route = routeDefinition(data, trip.routeId);
  // Transfers never roll route risk (T03b, #76): they arrive on time.
  if (delivery.purpose.kind === "TRANSFER") return arriveForTransfer(state, vehicle, delivery, data, coordinator, ctx);
  let s = state;
  if (!trip.delayed && route.riskPpm > 0) {
    // The trip's own stream: the game seed, the truck and this trip's ordinal (ADR 0022 decision 8).
    const outcome = drawDisruption(tripRng(s.seed, vehicle.id, vehicle.tripCount), route);
    if (outcome === "DELAY") return delayTrip(s, vehicle, delivery, route, coordinator, ctx);
    if (outcome === "SEIZE") return seizeCargo(s, vehicle, delivery, route, data, coordinator, ctx);
    s = commitClear(s, delivery, coordinator, ctx);
    // `vehicle` and `delivery` below are pre-CLEAR snapshots; safe because CLEAR changes no state.
  }
  if (delivery.purpose.kind === "SALE" && delivery.dealDeadline !== null && ctx.tick > delivery.dealDeadline) {
    return fallThrough(s, vehicle, delivery, route, data, coordinator, ctx);
  }
  if (delivery.purpose.kind === "CONTRACT_INSTALLMENT") {
    const contractId = delivery.purpose.contractId;
    // With founder rules on an installment is dispatched on known progress, so the
    // contract may have closed unseen since (ADR 0022 decision 6). With them off,
    // dispatch read the world, and M001's arrival stands.
    if (rules.founderRules && s.contracts.find((c) => c.id === contractId)?.status !== "ACTIVE") {
      return contractClosed(s, vehicle, delivery, route, coordinator, ctx);
    }
    return arriveForContract(s, vehicle, delivery, data, coordinator, ctx);
  }
  return arriveForSale(s, vehicle, delivery, data, coordinator, ctx);
}

/**
 * An installment arrives at a contract that has completed in the meantime (ADR
 * 0022 decision 6): nothing is sold. As a fall-through, in a no-entry
 * `DISPATCH:<id>:FELL_THROUGH` transaction: the delivery FAILED with its cargo
 * still aboard, the truck turned home, and DEAL_FELL_THROUGH { reason:
 * "CONTRACT_CLOSED" }. VEHICLE_RETURN unloads the cargo unreserved at home.
 */
function contractClosed(
  state: GameState,
  vehicle: VehicleState,
  delivery: DeliveryState,
  route: RouteDefinition,
  coordinator: TransactionCoordinator,
  ctx: TickContext,
): GameState {
  if (delivery.purpose.kind !== "CONTRACT_INSTALLMENT") throw new RangeError(`Delivery ${delivery.id} isn't a contract installment`);
  const contractId = delivery.purpose.contractId;
  const contract = state.contracts.find((c) => c.id === contractId);
  if (!contract) throw new RangeError(`Delivery ${delivery.id} is for unknown contract ${contractId}`);
  const tx = coordinator.begin(state, {
    kind: "DISPATCH",
    idempotencyKey: idempotencyKey("DISPATCH", delivery.id, "FELL_THROUGH"),
    tick: ctx.tick,
    causedBy: null,
  });
  if (tx.status === "duplicate") return state;
  tx.update((s) => withDelivery(s, delivery.id, "FAILED"));
  tx.update((s) => withVehicle(s, vehicle.id, homewardTrip(delivery, route, ctx)));
  tx.emit({ type: "DEAL_FELL_THROUGH", deliveryId: delivery.id, buyerId: contract.buyerId, reason: "CONTRACT_CLOSED" });
  return commitOrThrow(tx, `Arrival of ${delivery.id} at closed contract ${contractId}`);
}

/**
 * A contract installment's checks after the vehicle and cargo shape (ADR 0018
 * decision 5): the contract and cargo, the route to the buyer as for a sale,
 * then the quantity cap before the stock check. No transport funds check
 * (ADR 0019 decision 1). On the view, the contract's progress is the known one
 * and the in-transit cases are the known trips (ADR 0022 decision 6).
 */
function planContractDispatch(
  world: ViewWorld,
  command: DispatchDeliveryCommand,
  data: GameData,
  contractId: ContractId,
  homeId: FacilityId,
  homeLocationId: LocationId,
): ContractDispatchPlan | RejectionReason {
  const first = command.cargo[0]!;
  const line: CargoLine = { productId: first.productId, quality: first.quality, quantity: first.quantity };
  const contract = contractForCargo(world, contractId, line);
  if ("code" in contract) return contract;
  const buyer = data.buyers.find((b) => b.id === contract.buyerId);
  if (!buyer) return { code: "UNKNOWN_ENTITY", kind: "Buyer", id: contract.buyerId };
  if (command.routeId !== null && !data.routes.some((r) => r.id === command.routeId)) {
    return { code: "UNKNOWN_ENTITY", kind: "Route", id: command.routeId };
  }
  const route = resolveRoute(data, homeLocationId, buyer.locationId, command.routeId);
  if (!route) return { code: "NO_ROUTE", vehicleId: command.vehicleId };
  const closure = world.routes.find((r) => r.id === route.id)?.closure ?? null;
  if (closure) return { code: "ROUTE_CLOSED", routeId: route.id, reopensAt: closure.reopensAt };
  const load = contractLoadRejection(world, contract, homeId, line);
  if (load) return load;
  return { route, contractId, line, homeId };
}

/**
 * A transfer's checks after the vehicle and cargo shape (T03b, #76): the
 * destination must be a facility this game owns (else UNKNOWN_ENTITY), other
 * than the vehicle's home, with a route from home that this game has state for
 * (else NO_ROUTE), open, and enough unreserved stock at home. The destination's
 * storage is checked on arrival, not here.
 */
function planTransferDispatch(
  world: ViewWorld,
  command: DispatchDeliveryCommand,
  data: GameData,
  destinationId: FacilityId,
  homeId: FacilityId,
  homeLocationId: LocationId,
): TransferDispatchPlan | RejectionReason {
  const destination = data.facilities.find((f) => f.id === destinationId);
  if (!destination || !world.facilities.some((f) => f.id === destinationId)) {
    return { code: "UNKNOWN_ENTITY", kind: "Facility", id: destinationId };
  }
  if (destinationId === homeId) return { code: "NO_ROUTE", vehicleId: command.vehicleId };
  if (command.routeId !== null && !data.routes.some((r) => r.id === command.routeId)) {
    return { code: "UNKNOWN_ENTITY", kind: "Route", id: command.routeId };
  }
  const route = resolveRoute(data, homeLocationId, destination.locationId, command.routeId);
  const routeState = route ? world.routes.find((r) => r.id === route.id) : undefined;
  if (!route || !routeState) return { code: "NO_ROUTE", vehicleId: command.vehicleId };
  if (routeState.closure) return { code: "ROUTE_CLOSED", routeId: route.id, reopensAt: routeState.closure.reopensAt };
  const first = command.cargo[0]!;
  const line: CargoLine = { productId: first.productId, quality: first.quality, quantity: first.quantity };
  const available = availableProduct(world, homeId, line.productId, line.quality);
  if (available < line.quantity) {
    return { code: "INSUFFICIENT_STOCK", productId: line.productId, quality: line.quality, requested: line.quantity, available };
  }
  return { route, line, homeId, destinationFacilityId: destinationId };
}

/**
 * A sale's deal checks (ADR 0022 decision 6), right after the buyer resolves:
 * the named deal must be HELD (gate 1, resolving the ID through the founder's
 * agreements: DEAL_UNAVAILABLE), for this buyer and exactly this cargo
 * (CARGO_DOES_NOT_MATCH_DEAL). A sale on spec, and a repeated sale (REQUOTE),
 * name no deal: null, and nothing of the buyer is read.
 */
function saleDealCheck(
  world: WorldSlice,
  purpose: Extract<DeliveryPurpose, { kind: "SALE" }>,
  line: CargoLine,
  terms: SaleTerms,
): HeldDealState | null | RejectionReason {
  const deal = saleDealIdentity(world, purpose, terms);
  if (deal === null || "code" in deal) return deal;
  const matches =
    deal.buyerId === purpose.buyerId && deal.productId === line.productId && deal.quality === line.quality && deal.quantity === line.quantity;
  return matches ? deal : { code: "CARGO_DOES_NOT_MATCH_DEAL", dealId: deal.id };
}

/** The deal a sale names, resolved through the founder's HELD deals (gate 1), or null on spec or for a repeat's re-agreement. */
function saleDealIdentity(world: WorldSlice, purpose: Extract<DeliveryPurpose, { kind: "SALE" }>, terms: SaleTerms): HeldDealState | null | RejectionReason {
  if (terms === "REQUOTE" || purpose.dealId === null) return null;
  return heldDeal(world, purpose.dealId) ?? { code: "DEAL_UNAVAILABLE", dealId: purpose.dealId };
}

/**
 * Gate 1 for a dispatch with founder rules on (ADR 0022 decision 1; #200
 * follow-up 2): every ID the purpose names, resolved through the view, before
 * any presence check. A sale's buyer (geography) and its deal (the founder's
 * HELD deals: DEAL_UNAVAILABLE is the deal's "not found"); an installment's
 * contract (the founder's agreements: CONTRACT_NOT_ACTIVE is its "not found");
 * a transfer's destination (an owned facility); and a named route (game-data).
 */
function dispatchIdentity(world: ViewWorld, command: DispatchDeliveryCommand, data: GameData, terms: SaleTerms): RejectionReason | null {
  const { purpose } = command;
  if (purpose.kind === "SALE") {
    if (!data.buyers.some((b) => b.id === purpose.buyerId)) return { code: "UNKNOWN_ENTITY", kind: "Buyer", id: purpose.buyerId };
    const deal = saleDealIdentity(world, purpose, terms);
    if (deal !== null && "code" in deal) return deal;
  } else if (purpose.kind === "CONTRACT_INSTALLMENT") {
    if (!world.contracts.some((c) => c.id === purpose.contractId)) return { code: "CONTRACT_NOT_ACTIVE", contractId: purpose.contractId };
  } else if (!data.facilities.some((f) => f.id === purpose.destinationFacilityId) || !world.facilities.some((f) => f.id === purpose.destinationFacilityId)) {
    return { code: "UNKNOWN_ENTITY", kind: "Facility", id: purpose.destinationFacilityId };
  }
  if (command.routeId !== null && !data.routes.some((r) => r.id === command.routeId)) return { code: "UNKNOWN_ENTITY", kind: "Route", id: command.routeId };
  return null;
}

/** Where a dispatch leaves from and returns to. */
interface Origin {
  readonly id: FacilityId;
  readonly locationId: LocationId;
}

/**
 * Gate 2 for a dispatch with founder rules on (ADR 0022 decision 3, ADR 0023
 * decision 5): the dispatch origin is the owned facility at the place the
 * founder drives from. Checks, in order:
 * - NO_DRIVER: the dispatch names no driver, names an employee (no Driver can be
 *   hired until ADR 0025), or the founder isn't PRESENT anywhere (the truck's
 *   place is never read from the world, so there's no NOT_PRESENT target);
 * - VEHICLE_NOT_AT: the truck isn't parked in the live view of the founder's
 *   place with no trip (on a trip, being loaded, or parked elsewhere).
 *   `locationId` is the founder's place, never the truck's;
 * - FOUNDER_BUSY: loading is a timed activity (LOAD_TRUCK);
 * - INSUFFICIENT_STOCK with none available: there's no facility of yours here,
 *   so there's nothing to load.
 */
function founderOrigin(view: IssuerView, data: GameData, command: DispatchDeliveryCommand): Origin | RejectionReason {
  const { vehicleId, driver } = command;
  const world = view.world;
  const w = world.founder.whereabouts;
  if (driver?.kind !== "FOUNDER" || w.kind !== "PRESENT") return { code: "NO_DRIVER", vehicleId };
  const here = w.locationId;
  const vehicle = world.vehicles.find((v) => v.id === vehicleId);
  if (!vehicle || vehicle.trip !== null || vehicle.parkedAt !== here) return { code: "VEHICLE_NOT_AT", vehicleId, locationId: here };
  const busy = busyRejection(view);
  if (busy) return busy;
  const facility = data.facilities.find((f) => f.locationId === here && world.facilities.some((owned) => owned.id === f.id));
  if (!facility) {
    const line = command.cargo[0]!;
    return { code: "INSUFFICIENT_STOCK", productId: line.productId, quality: line.quality, requested: line.quantity, available: 0 };
  }
  return { id: facility.id, locationId: facility.locationId };
}

/**
 * A dispatch's whole check against the issuer's view, and what to stage.
 *
 * Founder rules off, M001's order: the vehicle, the cargo's shape, the truck's
 * capacity, then by purpose. A sale: the buyer, its deal, the route, the stock;
 * a repeated sale's re-agreement at today's quote comes last, where ADR 0005's
 * quote check was.
 *
 * Founder rules on, ADR 0022 decision 1's gates: the vehicle and the cargo's
 * shape, then the purpose's IDs (gate 1, `dispatchIdentity`); then the driver,
 * the truck and busy (gate 2, `founderOrigin`); then the rest as above, against
 * the view: route conditions as known, an installment on known progress.
 */
function planDispatch(
  view: IssuerView,
  command: DispatchDeliveryCommand,
  data: GameData,
  terms: SaleTerms,
): DispatchPlan | ContractDispatchPlan | TransferDispatchPlan | RejectionReason {
  const world = view.world;
  const { vehicleId, cargo, purpose } = command;
  const vehicle = world.vehicles.find((v) => v.id === vehicleId);
  const def = data.vehicles.find((v) => v.id === vehicleId);
  const vehicleHome = data.facilities.find((f) => f.id === def?.homeFacilityId);
  if (!vehicle || !def || !vehicleHome) return { code: "UNKNOWN_ENTITY", kind: "Vehicle", id: vehicleId };
  if (!view.founderRules && vehicle.trip !== null) return { code: "VEHICLE_UNAVAILABLE", vehicleId };
  const first = cargo[0];
  if (cargo.length !== 1 || !first) return { code: "INVALID_QUANTITY", field: "cargo", value: cargo.length };
  if (!Number.isSafeInteger(first.quantity) || first.quantity <= 0) {
    return { code: "INVALID_QUANTITY", field: "cargo[0].quantity", value: first.quantity };
  }
  let home: Origin = vehicleHome;
  if (view.founderRules) {
    const unknown = dispatchIdentity(world, command, data, terms);
    if (unknown) return unknown;
    const origin = founderOrigin(view, data, command);
    if ("code" in origin) return origin;
    home = origin;
  }
  if (first.quantity > def.capacityCases) {
    return { code: "VEHICLE_CAPACITY_EXCEEDED", vehicleId, requested: first.quantity, capacity: def.capacityCases };
  }
  if (purpose.kind === "CONTRACT_INSTALLMENT") return planContractDispatch(world, command, data, purpose.contractId, home.id, home.locationId);
  if (purpose.kind === "TRANSFER") return planTransferDispatch(world, command, data, purpose.destinationFacilityId, home.id, home.locationId);
  const line: CargoLine = { productId: first.productId, quality: first.quality, quantity: first.quantity };
  const buyer = data.buyers.find((b) => b.id === purpose.buyerId);
  if (!buyer) return { code: "UNKNOWN_ENTITY", kind: "Buyer", id: purpose.buyerId };
  const deal = saleDealCheck(world, purpose, line, terms);
  if (deal !== null && "code" in deal) return deal;
  if (command.routeId !== null && !data.routes.some((r) => r.id === command.routeId)) {
    return { code: "UNKNOWN_ENTITY", kind: "Route", id: command.routeId };
  }
  const route = resolveRoute(data, home.locationId, buyer.locationId, command.routeId);
  if (!route) return { code: "NO_ROUTE", vehicleId };
  // A closure the founder can't see isn't refused: it's found on the road (ROUTE_FOUND_CLOSED).
  const closure = world.routes.find((r) => r.id === route.id)?.closure ?? null;
  if (closure) return { code: "ROUTE_CLOSED", routeId: route.id, reopensAt: closure.reopensAt };
  const available = availableProduct(world, home.id, line.productId, line.quality);
  if (available < line.quantity) {
    return { code: "INSUFFICIENT_STOCK", productId: line.productId, quality: line.quality, requested: line.quantity, available };
  }
  if (deal !== null) return { route, sale: { kind: "HELD", deal }, line, homeId: home.id };
  // On spec: nothing is checked against the buyer at dispatch (ADR 0022 decision 6).
  if (terms === "NAMED_DEAL") return { route, sale: { kind: "SPEC" }, line, homeId: home.id };
  // A repeat re-agrees at today's quote, so QUOTE_CHANGED can't arise; the buyer's other checks can.
  const quote = quoteDeal(world, data, purpose.buyerId, currentQuote(world, purpose.buyerId, line) ?? ZERO_MONEY, line);
  if ("code" in quote) return quote;
  return { route, sale: { kind: "REQUOTE", quote }, line, homeId: home.id };
}

/** DISPATCH_DELIVERY's order validator (ADR 0022 decisions 1, 3 and 6): `planDispatch` on the view. */
export function dispatchDeliveryValidator(data: GameData): OrderValidator<"DISPATCH_DELIVERY"> {
  return (view, command) => {
    const plan = planDispatch(view, command, data, "NAMED_DEAL");
    return "code" in plan ? plan : null;
  };
}

/**
 * A repeated SALE dispatch's check with founder rules off (ADR 0020 decision 11
 * as amended by ADR 0022 decision 6): `planDispatch` re-agreeing at the buyer's
 * current quote, as the view shows it. With founder rules on a repeated sale
 * goes on spec and takes DISPATCH_DELIVERY's own validator (`repeat-order.ts`).
 */
export function requotedSaleRejection(view: IssuerView, command: DispatchDeliveryCommand, data: GameData): RejectionReason | null {
  const plan = planDispatch(view, command, data, "REQUOTE");
  return "code" in plan ? plan : null;
}

/**
 * DISPATCH_DELIVERY's apply, in one DISPATCH transaction keyed by the new
 * delivery. `terms`: "NAMED_DEAL" for the command as sent; "REQUOTE" for a
 * repeated sale with founder rules off, whose new deal (DEAL_AGREED) is agreed in
 * this same transaction. The plan is judged on the issuer's view; staging takes
 * the stock from the world at the origin, which the founder sees.
 */
function applyDispatch(
  state: GameState,
  command: DispatchDeliveryCommand,
  ctx: CommandContext,
  data: GameData,
  coordinator: TransactionCoordinator,
  terms: SaleTerms,
  rules: GameRules,
): CommandOutcome {
  const { vehicleId, driver } = command;
  const plan = planDispatch(playerViewOf(state, data, rules, ctx.tick), command, data, terms);
  if ("code" in plan) return { status: "rejected", reason: plan };
  const deliveryId = formatId("Delivery", state.counters.nextId.Delivery);
  const tx = coordinator.begin(state, {
    kind: "DISPATCH",
    idempotencyKey: idempotencyKey("DISPATCH", deliveryId),
    tick: ctx.tick,
    causedBy: ctx.envelope?.id ?? null,
  });
  if (tx.status === "duplicate") return { status: "applied", state };

  const { route, line, homeId } = plan;
  // With founder rules on the founder loads the truck first (LOAD_TRUCK), and it
  // leaves when loading ends (ADR 0023 decisions 4 and 5).
  const loading = rules.founderRules && driver?.kind === "FOUNDER" ? activityTicks(state.founder, "LOAD_TRUCK", ctx.tick) : 0;
  const departedAt = addTicks(ctx.tick, loading);
  const arrivesAt = addTicks(departedAt, route.durationTicks);
  // A contract installment draws the contract's reservations first (ADR 0018 decision 5);
  // a sale or a transfer takes unreserved stock only (ADR 0013).
  const taken =
    "contractId" in plan
      ? takeForContract(tx.state, homeId, plan.contractId, line.productId, line.quality, line.quantity)
      : { ...takeProduct(tx.state, homeId, line.productId, line.quality, line.quantity), consumed: [] };
  tx.update(() => taken.state);
  let purpose: DeliveryPurpose = command.purpose;
  // Contract installments and transfers have no deal deadline (ADR 0019 decision 4).
  let dealDeadline: DeliveryState["dealDeadline"] = null;
  // A sale on spec has no deal and no deal deadline (ADR 0022 decision 6).
  if ("sale" in plan && plan.sale.kind !== "SPEC") {
    let deal: HeldDealState;
    if (plan.sale.kind === "HELD") {
      deal = plan.sale.deal;
    } else {
      const agreed = agreeDeal(tx.state, data, { buyerId: plan.sale.quote.buyerId, line, agreedUnitPrice: plan.sale.quote.unitPrice }, ctx.tick);
      if ("code" in agreed) throw new RangeError(`Re-agreeing a repeated sale at today's quote was rejected: ${agreed.code}`);
      tx.update(() => agreed.state);
      tx.emit(agreed.event);
      deal = agreed.deal;
      purpose = { kind: "SALE", buyerId: deal.buyerId, dealId: deal.id };
    }
    const dealId = deal.id;
    tx.update((x) => dispatchDeal(x, dealId, deliveryId));
    // M001's deadline, capped by the deal's hold (ADR 0022 decision 6).
    const grace = addTicks(arrivesAt, route.dealGraceTicks);
    dealDeadline = grace < deal.expiresAt ? grace : deal.expiresAt;
  }
  const delivery: DeliveryState = {
    id: deliveryId,
    vehicleId,
    fromFacilityId: homeId,
    routeId: route.id,
    cargo: [{ ...line, cost: taken.cost }],
    purpose,
    status: "OUTBOUND",
    dealDeadline,
    driver,
  };
  tx.update((x) => {
    const minted = allocateId(x, "Delivery").state;
    return { ...minted, deliveries: [...minted.deliveries, delivery].sort(compareById) };
  });
  tx.update((x) => departing(x, vehicleId, { deliveryId, routeId: route.id, leg: "OUTBOUND", departedAt, arrivesAt, delayed: false }));
  tx.post(dispatchEntries(taken.cost));
  tx.emit({ type: "DELIVERY_DISPATCHED", deliveryId, vehicleId, routeId: route.id, cargo: [line], purpose, arrivesAt });
  for (const reservationId of taken.consumed) tx.emit({ type: "RESERVATION_RELEASED", reservationId, reason: "CONSUMED" });

  const result = tx.commit();
  return result.status === "committed" ? { status: "applied", state: result.state } : { status: "rejected", reason: result.reason };
}

/**
 * A repeated SALE with founder rules off (ADR 0020 decision 11 as amended by ADR
 * 0022 decision 6; issue #192): the source's cargo, buyer, route and driver,
 * re-agreed at the buyer's current quote in the dispatch's own transaction. The
 * source's deal is never reused: a deal is single-use.
 */
export function dispatchRequotedSale(
  state: GameState,
  command: DispatchDeliveryCommand,
  ctx: CommandContext,
  data: GameData,
  coordinator: TransactionCoordinator,
  rules: GameRules = M001_RULES,
): CommandOutcome {
  return applyDispatch(state, command, ctx, data, coordinator, "REQUOTE", rules);
}

/**
 * A road that closed while the truck was being loaded (ADR 0022 decision 6, ADR
 * 0023 decisions 2a and 4): found at departure, when loading ends. The truck
 * doesn't leave, and the founder, still PRESENT at the origin, sees it all, so
 * nothing leaks. In one transaction keyed `VEHICLE_RETURN:<deliveryId>` (the
 * delivery never sets out, so it never returns): the cargo is unloaded back into
 * the origin facility unreserved at its cost (`returnFromTransitEntries`;
 * reserved contract cargo comes back unreserved, ADR 0013 decision 6), the
 * delivery ends FAILED with nothing aboard, the truck has no trip and stays
 * parked, a sale's deal returns to HELD with its commitment, and
 * ROUTE_FOUND_CLOSED is emitted. No transport cost: the truck didn't move.
 */
export function turnBackAtDeparture(state: GameState, deliveryId: DeliveryState["id"], coordinator: TransactionCoordinator, at: Tick): GameState {
  const delivery = state.deliveries.find((d) => d.id === deliveryId);
  if (!delivery) throw new RangeError(`turnBackAtDeparture: unknown delivery ${deliveryId}`);
  const tx = coordinator.begin(state, {
    kind: "VEHICLE_RETURN",
    idempotencyKey: idempotencyKey("VEHICLE_RETURN", deliveryId),
    tick: at,
    causedBy: null,
  });
  if (tx.status === "duplicate") return state;
  const cargo = delivery.cargo;
  tx.update((s) => cargo.reduce((acc, line) => addProduct(acc, delivery.fromFacilityId, line.productId, line.quality, line.quantity, line.cost), s));
  tx.update((s) => withCargo(withDelivery(s, deliveryId, "FAILED"), deliveryId, []));
  tx.update((s) => withVehicle(s, delivery.vehicleId, null));
  if (delivery.purpose.kind === "SALE" && delivery.purpose.dealId !== null) {
    const dealId = delivery.purpose.dealId;
    tx.update((s) => ({ ...s, heldDeals: s.heldDeals.map((d) => (d.id === dealId ? { ...d, status: "HELD" as const, deliveryId: null } : d)) }));
  }
  tx.post(returnFromTransitEntries(cargoCost(cargo)));
  tx.emit({ type: "ROUTE_FOUND_CLOSED", deliveryId, routeId: delivery.routeId });
  return commitOrThrow(tx, `Turning ${deliveryId} back at departure`);
}

export function registerLogistics(
  registry: SystemRegistry,
  data: GameData,
  coordinator: TransactionCoordinator,
  rules: GameRules = M001_RULES,
): void {
  registry.onCommand("DISPATCH_DELIVERY", {
    apply: (state, command, ctx) => applyDispatch(state, command, ctx, data, coordinator, "NAMED_DEAL", rules),
  });

  registry.onPhase("vehicles", "vehicle-arrivals", (state, ctx) => {
    let s = state;
    for (const vehicle of state.vehicles) {
      const trip = vehicle.trip;
      if (!trip || trip.arrivesAt > ctx.tick) continue;
      s = trip.leg === "RETURN" ? returnHome(s, vehicle, data, coordinator, ctx, rules) : resolveOutbound(s, vehicle, data, coordinator, ctx, rules);
    }
    return s;
  });

  // Route closures (ADR 0019 decision 5): no-entry DAILY_SETTLEMENT transactions
  // keyed by route and tick, so a same-tick duplicate closure is ignored.
  registry.onWorldEvent("ROUTE_CLOSURE", (state, event, ctx) => {
    const { routeId, reason } = event;
    const tx = coordinator.begin(state, {
      kind: "DAILY_SETTLEMENT",
      idempotencyKey: idempotencyKey("DAILY_SETTLEMENT", "ROUTE_CLOSURE", routeId, ctx.tick),
      tick: ctx.tick,
      causedBy: null,
    });
    if (tx.status === "duplicate") return state;
    if (!tx.state.routes.some((r) => r.id === routeId)) throw new RangeError(`ROUTE_CLOSURE for unknown route ${routeId}`);
    const reopensAt = event.durationTicks === null ? null : addTicks(ctx.tick, event.durationTicks);
    // A closure on a route that is already closed replaces the current one.
    tx.update((s) => withRoute(s, routeId, { reason, reopensAt }));
    if (reopensAt !== null) tx.update((s) => scheduleWorldEvent(s, { kind: "ROUTE_REOPENING", tick: reopensAt, routeId }));
    tx.emit({ type: "ROUTE_CLOSED", routeId, reason, reopensAt });
    return commitOrThrow(tx, `ROUTE_CLOSURE of ${routeId}`);
  });

  registry.onWorldEvent("ROUTE_REOPENING", (state, event, ctx) => {
    const { routeId } = event;
    const closure = state.routes.find((r) => r.id === routeId)?.closure ?? null;
    // Clears an open-ended closure or the one this reopening was scheduled for.
    // A stale reopening from a replaced closure is a no-op with no transaction.
    if (closure === null || (closure.reopensAt !== null && closure.reopensAt !== ctx.tick)) return state;
    const tx = coordinator.begin(state, {
      kind: "DAILY_SETTLEMENT",
      idempotencyKey: idempotencyKey("DAILY_SETTLEMENT", "ROUTE_REOPENING", routeId, ctx.tick),
      tick: ctx.tick,
      causedBy: null,
    });
    if (tx.status === "duplicate") return state;
    tx.update((s) => withRoute(s, routeId, null));
    tx.emit({ type: "ROUTE_REOPENED", routeId });
    return commitOrThrow(tx, `ROUTE_REOPENING of ${routeId}`);
  });
}
