// S0 stub: extended by T03 (logistics and route disruption).
//
// - DISPATCH_DELIVERY with purpose SALE strikes the deal at dispatch (ADR 0005):
//   the buyer's demand and budget are committed, the cargo leaves finished goods
//   at its pool cost, and that cost moves to goods in transit. Net worth doesn't
//   change.
// - The vehicles phase resolves arrivals. An outbound SALE arrival is paid cash
//   on delivery: revenue and cost of goods sold are recognized now (FIN-001).
//   The truck then drives home on the same route. Its return moves no money: a
//   VEHICLE_RETURN transaction with no entries, emitting VEHICLE_RETURNED (ADR 0010).
//
// Stub limits (T03, T02d, T02e): SALE only (TRANSFER finds no route between owned
// facilities in the stub data; CONTRACT_INSTALLMENT has no contracts yet), one
// cargo line per trip, no transport cost, no delays, losses, or deal deadlines.

import {
  addMoney,
  addTicks,
  compareById,
  divideMoney,
  idempotencyKey,
  ZERO_MONEY,
  type CargoLine,
  type CargoLineState,
  type DeliveryState,
  type DispatchDeliveryCommand,
  type FacilityId,
  type GameState,
  type LedgerEntry,
  type LocationId,
  type RejectionReason,
  type RouteId,
  type TransactionCoordinator,
  type VehicleState,
} from "@eov/contracts";
import type { GameData, RouteDefinition } from "@eov/game-data";
import { commitDeal, findCommitment, quoteDeal, settleDeal, type Deal } from "../economy/market/market.ts";
import { allocateRemovalCost, availableProduct, findProductPool, removeProduct } from "../inventory/pools.ts";
import { allocateId, formatId } from "../kernel/ids.ts";
import type { SystemRegistry, TickContext } from "../kernel/registry.ts";

/** The route a trip takes: the requested one if it connects the two places, else the first listed (the default). */
export function resolveRoute(data: GameData, from: LocationId, to: LocationId, requested: RouteId | null): RouteDefinition | null {
  return data.routes.find((r) => r.fromLocationId === from && r.toLocationId === to && (requested === null || r.id === requested)) ?? null;
}

interface DispatchPlan {
  readonly route: RouteDefinition;
  readonly deal: Deal;
  readonly line: CargoLine;
  readonly homeId: FacilityId;
}

function withVehicle(state: GameState, vehicleId: VehicleState["id"], trip: VehicleState["trip"]): GameState {
  return { ...state, vehicles: state.vehicles.map((v) => (v.id === vehicleId ? { ...v, trip } : v)) };
}

function withDelivery(state: GameState, deliveryId: DeliveryState["id"], status: DeliveryState["status"]): GameState {
  return { ...state, deliveries: state.deliveries.map((d) => (d.id === deliveryId ? { ...d, status } : d)) };
}

function cargoCost(cargo: readonly CargoLineState[]) {
  return cargo.reduce((sum, line) => addMoney(sum, line.cost), ZERO_MONEY);
}

/** An outbound SALE arrives: cash on delivery, revenue and COGS recognized, truck heads home. */
function arriveForSale(
  state: GameState,
  vehicle: VehicleState,
  delivery: DeliveryState,
  data: GameData,
  coordinator: TransactionCoordinator,
  ctx: TickContext,
): GameState {
  if (delivery.purpose.kind !== "SALE") throw new RangeError(`S0 stub: ${delivery.purpose.kind} deliveries aren't implemented (T03/T02e)`);
  const { buyerId } = delivery.purpose;
  const route = data.routes.find((r) => r.id === delivery.routeId);
  if (!route) throw new RangeError(`Delivery ${delivery.id} uses unknown route ${delivery.routeId}`);
  const tx = coordinator.begin(state, {
    kind: "SALE",
    idempotencyKey: idempotencyKey("SALE", delivery.id),
    tick: ctx.tick,
    causedBy: null,
  });
  if (tx.status === "duplicate") return state;

  const commitment = findCommitment(tx.state, buyerId, delivery.id);
  if (!commitment) throw new RangeError(`Delivery ${delivery.id} has no deal with ${buyerId}`);
  const revenue = commitment.amount;
  const cogs = cargoCost(delivery.cargo);
  const cases = delivery.cargo.reduce((n, line) => n + line.quantity, 0);

  tx.update((s) => settleDeal(s, buyerId, delivery.id));
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
  const entries: LedgerEntry[] = [];
  if (revenue > 0) {
    entries.push({ account: "CASH", side: "DEBIT", amount: revenue }, { account: "SALES_REVENUE", side: "CREDIT", amount: revenue });
  }
  if (cogs > 0) {
    entries.push({ account: "COST_OF_GOODS_SOLD", side: "DEBIT", amount: cogs }, { account: "GOODS_IN_TRANSIT", side: "CREDIT", amount: cogs });
  }
  tx.post(entries);
  tx.emit({
    type: "SALE_COMPLETED",
    deliveryId: delivery.id,
    buyerId,
    cargo: delivery.cargo.map((l) => ({ productId: l.productId, quality: l.quality, quantity: l.quantity })),
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
 * The truck is home. No money moves, so this commits a VEHICLE_RETURN transaction
 * with no entries (ADR 0010), keyed by the delivery so a return applies once.
 */
function returnHome(
  state: GameState,
  vehicle: VehicleState,
  data: GameData,
  coordinator: TransactionCoordinator,
  ctx: TickContext,
): GameState {
  const trip = vehicle.trip!;
  const def = data.vehicles.find((v) => v.id === vehicle.id);
  const home = data.facilities.find((f) => f.id === def?.homeFacilityId);
  if (!home) throw new RangeError(`Vehicle ${vehicle.id} has no home facility`);
  const tx = coordinator.begin(state, {
    kind: "VEHICLE_RETURN",
    idempotencyKey: idempotencyKey("VEHICLE_RETURN", trip.deliveryId),
    tick: ctx.tick,
    causedBy: null,
  });
  if (tx.status === "duplicate") return state;

  tx.update((s) => withVehicle(s, vehicle.id, null));
  tx.emit({ type: "VEHICLE_RETURNED", vehicleId: vehicle.id, deliveryId: trip.deliveryId, locationId: home.locationId, returnedCargo: [] });
  const result = tx.commit();
  if (result.status !== "committed") throw new RangeError(`Return of ${vehicle.id} from ${trip.deliveryId} was rejected: ${result.reason.code}`);
  return result.state;
}

/** Validates a dispatch against current state (business rules). Returns what to stage, or why not. */
function planDispatch(state: GameState, command: DispatchDeliveryCommand, data: GameData): DispatchPlan | RejectionReason {
  const { vehicleId, cargo, purpose } = command;
  const vehicle = state.vehicles.find((v) => v.id === vehicleId);
  const def = data.vehicles.find((v) => v.id === vehicleId);
  const home = data.facilities.find((f) => f.id === def?.homeFacilityId);
  if (!vehicle || !def || !home) return { code: "UNKNOWN_ENTITY", kind: "Vehicle", id: vehicleId };
  if (vehicle.trip !== null) return { code: "VEHICLE_UNAVAILABLE", vehicleId };
  const first = cargo[0];
  if (cargo.length !== 1 || !first) return { code: "INVALID_QUANTITY", field: "cargo", value: cargo.length };
  if (!Number.isSafeInteger(first.quantity) || first.quantity <= 0) {
    return { code: "INVALID_QUANTITY", field: "cargo[0].quantity", value: first.quantity };
  }
  if (first.quantity > def.capacityCases) {
    return { code: "VEHICLE_CAPACITY_EXCEEDED", vehicleId, requested: first.quantity, capacity: def.capacityCases };
  }
  // S0 stub: no contracts exist yet (T02e), and the stub map has no route between owned facilities (T03).
  if (purpose.kind === "CONTRACT_INSTALLMENT") return { code: "CONTRACT_NOT_ACTIVE", contractId: purpose.contractId };
  if (purpose.kind === "TRANSFER") {
    if (!data.facilities.some((f) => f.id === purpose.destinationFacilityId)) {
      return { code: "UNKNOWN_ENTITY", kind: "Facility", id: purpose.destinationFacilityId };
    }
    return { code: "NO_ROUTE", vehicleId };
  }
  const buyer = data.buyers.find((b) => b.id === purpose.buyerId);
  if (!buyer) return { code: "UNKNOWN_ENTITY", kind: "Buyer", id: purpose.buyerId };
  if (command.routeId !== null && !data.routes.some((r) => r.id === command.routeId)) {
    return { code: "UNKNOWN_ENTITY", kind: "Route", id: command.routeId };
  }
  const route = resolveRoute(data, home.locationId, buyer.locationId, command.routeId);
  if (!route) return { code: "NO_ROUTE", vehicleId };
  const closure = state.routes.find((r) => r.id === route.id)?.closure ?? null;
  if (closure) return { code: "ROUTE_CLOSED", routeId: route.id, reopensAt: closure.reopensAt };
  const line: CargoLine = { productId: first.productId, quality: first.quality, quantity: first.quantity };
  const available = availableProduct(state, home.id, line.productId, line.quality);
  if (available < line.quantity) {
    return { code: "INSUFFICIENT_STOCK", productId: line.productId, quality: line.quality, requested: line.quantity, available };
  }
  const deal = quoteDeal(state, purpose.buyerId, purpose.agreedUnitPrice, line);
  if ("code" in deal) return deal;
  return { route, deal, line, homeId: home.id };
}

export function registerLogistics(registry: SystemRegistry, data: GameData, coordinator: TransactionCoordinator): void {
  registry.onCommand("DISPATCH_DELIVERY", {
    apply: (state, command, ctx) => {
      const { vehicleId, purpose } = command;
      const deliveryId = formatId("Delivery", state.counters.nextId.Delivery);
      const tx = coordinator.begin(state, {
        kind: "DISPATCH",
        idempotencyKey: idempotencyKey("DISPATCH", deliveryId),
        tick: ctx.tick,
        causedBy: ctx.envelope.id,
      });
      if (tx.status === "duplicate") return { status: "applied", state };

      const plan = planDispatch(tx.state, command, data);
      if ("code" in plan) {
        tx.reject(plan);
      } else {
        const { route, deal, line, homeId } = plan;
        const pool = findProductPool(tx.state, homeId, line.productId, line.quality)!;
        const cost = allocateRemovalCost(pool.totalCost, pool.quantity, line.quantity);
        const arrivesAt = addTicks(ctx.tick, route.durationTicks);
        const delivery: DeliveryState = {
          id: deliveryId,
          vehicleId,
          fromFacilityId: homeId,
          routeId: route.id,
          cargo: [{ ...line, cost }],
          purpose,
          status: "OUTBOUND",
          dealDeadline: null,
        };
        tx.update((s) => {
          const minted = allocateId(s, "Delivery").state;
          const unloaded = removeProduct(minted, homeId, line.productId, line.quality, line.quantity, cost);
          return { ...unloaded, deliveries: [...unloaded.deliveries, delivery].sort(compareById) };
        });
        tx.update((s) =>
          withVehicle(s, vehicleId, { deliveryId, routeId: route.id, leg: "OUTBOUND", departedAt: ctx.tick, arrivesAt, delayed: false }),
        );
        tx.update((s) => commitDeal(s, deal, deliveryId, line));
        if (cost > 0) {
          tx.post([
            { account: "GOODS_IN_TRANSIT", side: "DEBIT", amount: cost },
            { account: "FINISHED_GOODS", side: "CREDIT", amount: cost },
          ]);
        }
        tx.emit({ type: "DELIVERY_DISPATCHED", deliveryId, vehicleId, routeId: route.id, cargo: [line], purpose, arrivesAt });
      }

      const result = tx.commit();
      return result.status === "committed" ? { status: "applied", state: result.state } : { status: "rejected", reason: result.reason };
    },
  });

  registry.onPhase("vehicles", "vehicle-arrivals", (state, ctx) => {
    let s = state;
    for (const vehicle of state.vehicles) {
      const trip = vehicle.trip;
      if (!trip || trip.arrivesAt > ctx.tick) continue;
      if (trip.leg === "RETURN") {
        s = returnHome(s, vehicle, data, coordinator, ctx);
        continue;
      }
      const delivery = s.deliveries.find((d) => d.id === trip.deliveryId);
      if (!delivery) throw new RangeError(`Vehicle ${vehicle.id} is carrying unknown delivery ${trip.deliveryId}`);
      s = arriveForSale(s, vehicle, delivery, data, coordinator, ctx);
    }
    return s;
  });
}
