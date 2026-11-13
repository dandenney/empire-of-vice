// Small fake systems for kernel tests. They exercise every registry surface
// (commands, every phase, world events, RNG streams, event emission) without any
// real economics. Not gameplay logic: numbers here are arbitrary test values.

import {
  asId,
  cents,
  tick,
  type FacilityId,
  type GameCommand,
  type GameState,
  type MaterialPoolState,
} from "@eov/contracts";
import { day0Save, ids } from "@eov/contracts/fixtures";
import {
  allocateId,
  createRegistry,
  createSimulation,
  drawInt,
  emitEvent,
  scheduleWorldEvent,
  type CalendarDay,
  type KernelSimulation,
  type SystemRegistry,
} from "../../src/index.ts";

export const START_DATE: CalendarDay = { year: 1920, month: 1, day: 17 };
export const GAME_DATA_VERSION = "0.0.0-test";

export const day0State: GameState = day0Save.state;

export const FACILITIES: readonly FacilityId[] = [ids.distillery, ids.barn];

/** Registers the fake economy. `extra` can add more systems before the registry is sealed. */
export function fakeRegistry(extra?: (registry: SystemRegistry) => void): SystemRegistry {
  const registry = createRegistry();

  registry.onCommand("SET_WORKFORCE", {
    validate: (_state, command) =>
      Number.isSafeInteger(command.workerCount) && command.workerCount >= 0
        ? null
        : { code: "INVALID_QUANTITY", field: "workerCount", value: command.workerCount },
    apply: (state, command, ctx) => {
      if (!Number.isSafeInteger(command.workerCount) || command.workerCount < 0) {
        return { status: "rejected", reason: { code: "INVALID_QUANTITY", field: "workerCount", value: command.workerCount } };
      }
      const facility = state.facilities.find((f) => f.id === command.facilityId);
      if (!facility) {
        return { status: "rejected", reason: { code: "UNKNOWN_ENTITY", kind: "Facility", id: command.facilityId } };
      }
      const changed: GameState = {
        ...state,
        facilities: state.facilities.map((f) => (f.id === facility.id ? { ...f, workerCount: command.workerCount } : f)),
      };
      const emitted = emitEvent(
        changed,
        { type: "WORKFORCE_CHANGED", facilityId: facility.id, from: facility.workerCount, to: command.workerCount },
        { tick: ctx.tick, causedBy: ctx.envelope?.id ?? null },
      );
      return { status: "applied", state: emitted.state };
    },
  });

  registry.onCommand("PURCHASE_MATERIALS", {
    validate: (_state, command) =>
      Number.isSafeInteger(command.quantity) && command.quantity > 0
        ? null
        : { code: "INVALID_QUANTITY", field: "quantity", value: command.quantity },
    apply: (state, command, ctx) => {
      if (!Number.isSafeInteger(command.quantity) || command.quantity <= 0) {
        return { status: "rejected", reason: { code: "INVALID_QUANTITY", field: "quantity", value: command.quantity } };
      }
      const supplier = state.suppliers.find((s) => s.id === command.supplierId);
      const stock = supplier?.stock.find((s) => s.materialId === command.materialId);
      if (!supplier || !stock) {
        return { status: "rejected", reason: { code: "MATERIAL_NOT_SOLD", supplierId: command.supplierId, materialId: command.materialId } };
      }
      if (stock.available < command.quantity) {
        return {
          status: "rejected",
          reason: { code: "SUPPLIER_STOCK_LOW", materialId: command.materialId, requested: command.quantity, available: stock.available },
        };
      }
      const total = cents(stock.unitPrice * command.quantity);
      const pools = state.materialPools.some((p) => p.facilityId === command.facilityId && p.materialId === command.materialId)
        ? state.materialPools.map((p) =>
            p.facilityId === command.facilityId && p.materialId === command.materialId
              ? { ...p, quantity: p.quantity + command.quantity, totalCost: cents(p.totalCost + total) }
              : p,
          )
        : [...state.materialPools, { facilityId: command.facilityId, materialId: command.materialId, quantity: command.quantity, totalCost: total }];
      let s: GameState = {
        ...state,
        suppliers: state.suppliers.map((sup) =>
          sup.id === supplier.id
            ? { ...sup, stock: sup.stock.map((st) => (st === stock ? { ...st, available: st.available - command.quantity } : st)) }
            : sup,
        ),
        materialPools: [...pools].sort(comparePools),
      };
      const txn = allocateId(s, "Transaction");
      s = txn.state;
      s = emitEvent(
        s,
        {
          type: "MATERIALS_PURCHASED",
          supplierId: supplier.id,
          materialId: command.materialId,
          quantity: command.quantity,
          unitPrice: stock.unitPrice,
          total,
          facilityId: command.facilityId,
          transactionId: txn.id,
        },
        { tick: ctx.tick, causedBy: ctx.envelope?.id ?? null },
      ).state;
      return { status: "applied", state: s };
    },
  });

  // Production: draws from the production stream every 97 ticks.
  registry.onPhase("production", "fake-production", (state, ctx) => {
    if (ctx.tick % 97 !== 0) return state;
    const draw = drawInt(state, "production", 10);
    return {
      ...draw.state,
      markets: draw.state.markets.map((m, i) => (i === 0 ? { ...m, demand: m.demand + draw.value } : m)),
    };
  });

  // Resolution: occasionally schedules a route closure through the contracts stream.
  registry.onPhase("resolution", "fake-disruptions", (state, ctx) => {
    if (ctx.tick % 500 !== 0) return state;
    const roll = drawInt(state, "contracts", 4);
    if (roll.value !== 0) return roll.state;
    const delay = drawInt(roll.state, "routes", 300);
    return scheduleWorldEvent(delay.state, {
      tick: tick(ctx.tick + 1 + delay.value),
      kind: "ROUTE_CLOSURE",
      routeId: ids.routeRoadhouse,
      reason: "POLICE",
      durationTicks: 720,
    });
  });

  // Midnight: restock suppliers from the market stream and publish a report.
  registry.onPhase("midnight", "fake-midnight", (state, ctx) => {
    let s = state;
    const suppliers = s.suppliers.map((sup) => ({
      ...sup,
      stock: sup.stock.map((st) => {
        const draw = drawInt(s, "market", 20);
        s = draw.state;
        return { ...st, available: st.available + draw.value };
      }),
    }));
    s = { ...s, suppliers };
    return emitEvent(s, { type: "MARKET_UPDATED", dayIndex: ctx.dayIndex - 1 }, { tick: ctx.tick, causedBy: null }).state;
  });

  registry.onWorldEvent("SHORTAGE_START", (state, event, ctx) => {
    const endsAt = tick(ctx.tick + event.durationTicks);
    let s: GameState = {
      ...state,
      suppliers: state.suppliers.map((sup) =>
        sup.id === event.supplierId
          ? {
              ...sup,
              stock: sup.stock.map((st) =>
                st.materialId === event.materialId ? { ...st, shortage: { supplyRatio: event.supplyRatio, endsAt } } : st,
              ),
            }
          : sup,
      ),
    };
    s = emitEvent(
      s,
      { type: "SHORTAGE_STARTED", supplierId: event.supplierId, materialId: event.materialId, supplyRatioPpm: event.supplyRatio, endsAt },
      { tick: ctx.tick, causedBy: null },
    ).state;
    return scheduleWorldEvent(s, { tick: endsAt, kind: "SHORTAGE_END", supplierId: event.supplierId, materialId: event.materialId });
  });

  registry.onWorldEvent("SHORTAGE_END", (state, event, ctx) => {
    const s: GameState = {
      ...state,
      suppliers: state.suppliers.map((sup) =>
        sup.id === event.supplierId
          ? { ...sup, stock: sup.stock.map((st) => (st.materialId === event.materialId ? { ...st, shortage: null } : st)) }
          : sup,
      ),
    };
    return emitEvent(
      s,
      { type: "SHORTAGE_ENDED", supplierId: event.supplierId, materialId: event.materialId },
      { tick: ctx.tick, causedBy: null },
    ).state;
  });

  registry.onWorldEvent("ROUTE_CLOSURE", (state, event, ctx) => {
    const reopensAt = event.durationTicks === null ? null : tick(ctx.tick + event.durationTicks);
    let s: GameState = {
      ...state,
      routes: state.routes.map((r) => (r.id === event.routeId ? { ...r, closure: { reason: event.reason, reopensAt } } : r)),
    };
    s = emitEvent(s, { type: "ROUTE_CLOSED", routeId: event.routeId, reason: event.reason, reopensAt }, { tick: ctx.tick, causedBy: null }).state;
    return reopensAt === null ? s : scheduleWorldEvent(s, { tick: reopensAt, kind: "ROUTE_REOPENING", routeId: event.routeId });
  });

  registry.onWorldEvent("ROUTE_REOPENING", (state, event, ctx) => {
    const s: GameState = {
      ...state,
      routes: state.routes.map((r) => (r.id === event.routeId ? { ...r, closure: null } : r)),
    };
    return emitEvent(s, { type: "ROUTE_REOPENED", routeId: event.routeId }, { tick: ctx.tick, causedBy: null }).state;
  });

  extra?.(registry);
  return registry;
}

function comparePools(a: MaterialPoolState, b: MaterialPoolState): number {
  return a.facilityId < b.facilityId ? -1 : a.facilityId > b.facilityId ? 1 : a.materialId < b.materialId ? -1 : a.materialId > b.materialId ? 1 : 0;
}

export function fakeSimulation(state: GameState = day0State, extra?: (registry: SystemRegistry) => void): KernelSimulation {
  return createSimulation(state, { registry: fakeRegistry(extra), startDate: START_DATE, gameDataVersion: GAME_DATA_VERSION });
}

export function setWorkforce(facilityId: FacilityId, workerCount: number): GameCommand {
  return { type: "SET_WORKFORCE", facilityId, workerCount };
}

export function buyCorn(quantity: number): GameCommand {
  return { type: "PURCHASE_MATERIALS", supplierId: ids.supplier, materialId: ids.corn, quantity, facilityId: ids.distillery };
}

export const unknownFacility = asId("Facility", "nowhere");
